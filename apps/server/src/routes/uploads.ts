import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Readable } from "node:stream";
import { nanoid } from "nanoid";
import {
  UPLOAD_CHUNK_SIZE_BYTES,
  allowedUploadExtensionsLabel,
  extname,
  isAllowedUploadFileName,
  type Upload,
  type UploadState,
} from "@droparr/shared";
import type { Db } from "../db.js";
import type { UploadEventBus } from "../uploads/events.js";
import type { UploadLocks } from "../uploads/locks.js";
import { parseUploadMetadata } from "../uploads/metadata.js";
import {
  resolveDropDir,
  resolveUploadTarget,
  sanitizeDropId,
  sanitizeRelPath,
} from "../uploads/paths.js";
import type { UploadSettings } from "../uploads/settings.js";

const TUS_VERSION = "1.0.0";
const TUS_EXTENSIONS = "creation,termination";
const CREATION_BODY_LIMIT = 64 * 1024;

export interface UploadRouteDeps {
  db: Db;
  events: UploadEventBus;
  locks: UploadLocks;
  getSettings: () => UploadSettings;
  /** Max accepted PATCH body; tests lower it. Defaults to the 32 MiB chunk. */
  maxChunkSizeBytes?: number;
}

class UploadHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function headerValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requireTus(req: FastifyRequest, reply: FastifyReply): boolean {
  if (headerValue(req.headers["tus-resumable"]) !== TUS_VERSION) {
    reply.code(412).send({ error: `Tus-Resumable: ${TUS_VERSION} is required` });
    return false;
  }
  return true;
}

function setTusHeaders(
  reply: FastifyReply,
  extra: Record<string, string> = {},
): void {
  reply.header("Tus-Resumable", TUS_VERSION);
  for (const [key, value] of Object.entries(extra)) {
    reply.header(key, value);
  }
}

/**
 * TUS-style resumable uploads (creation + termination, no concatenation or
 * checksums — see docs/ARCHITECTURE.md).
 *
 * Files are written straight into the quarantine dir at `<quarantine>/<dropId>/<relPath>`.
 * The SQLite offset is the source of truth for resuming; bytes are fsynced
 * before the offset is committed so a crash never commits missing data.
 */
export function uploadRoutes(app: FastifyInstance, deps: UploadRouteDeps): void {
  const maxChunk = deps.maxChunkSizeBytes ?? UPLOAD_CHUNK_SIZE_BYTES;

  // Stream PATCH bodies to disk; buffer the tiny (usually empty) creation POST.
  app.addContentTypeParser(
    "application/offset+octet-stream",
    (req, payload, done) => {
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        let total = 0;
        payload.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > CREATION_BODY_LIMIT) {
            payload.destroy();
            done(new Error("Creation request body is too large"));
            return;
          }
          chunks.push(chunk);
        });
        payload.on("end", () => done(null, Buffer.concat(chunks)));
        payload.on("error", (err) => done(err));
        return;
      }
      done(null, payload);
    },
  );

  /** Capability discovery. */
  app.options("/api/uploads", async (_req, reply) => {
    const settings = deps.getSettings();
    setTusHeaders(reply, {
      "Tus-Version": TUS_VERSION,
      "Tus-Extension": TUS_EXTENSIONS,
      ...(settings.maxFileSizeBytes > 0
        ? { "Tus-Max-Size": String(settings.maxFileSizeBytes) }
        : {}),
    });
    return reply.code(204).send();
  });

  /** Creation: POST metadata, get a Location to PATCH chunks to. */
  app.post(
    "/api/uploads",
    { bodyLimit: maxChunk + CREATION_BODY_LIMIT },
    async (req, reply) => {
      if (!requireTus(req, reply)) return;
      const settings = deps.getSettings();

      const lengthHeader = headerValue(req.headers["upload-length"]);
      const size =
        lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : NaN;
      if (!Number.isSafeInteger(size) || size <= 0) {
        return reply
          .code(400)
          .send({ error: "Upload-Length header (a positive integer) is required" });
      }

      const metadata = parseUploadMetadata(req.headers["upload-metadata"]);
      const filename = (metadata.filename ?? "").trim();
      if (!filename) {
        return reply
          .code(400)
          .send({ error: "Upload-Metadata must include a filename" });
      }
      const relPath = sanitizeRelPath(metadata.relpath?.trim() || filename);
      if (!relPath) {
        return reply
          .code(400)
          .send({ error: "Unsafe or empty relative file path" });
      }
      if (!isAllowedUploadFileName(relPath)) {
        return reply.code(400).send({
          error: `File type not allowed. Allowed extensions: ${allowedUploadExtensionsLabel()}`,
        });
      }

      if (settings.maxFileSizeBytes > 0 && size > settings.maxFileSizeBytes) {
        setTusHeaders(reply, {
          "Tus-Max-Size": String(settings.maxFileSizeBytes),
        });
        return reply.code(413).send({
          error: `File exceeds the per-file limit (${settings.maxFileSizeBytes} bytes)`,
        });
      }

      const dropId = sanitizeDropId(metadata.dropid) ?? nanoid(12);
      if (
        settings.maxSubmissionSizeBytes > 0 &&
        deps.db.dropUploadedBytes(dropId) + size >
          settings.maxSubmissionSizeBytes
      ) {
        return reply.code(413).send({
          error: `Submission exceeds the per-drop limit (${settings.maxSubmissionSizeBytes} bytes)`,
        });
      }
      if (deps.db.findUploadByRelPath(dropId, relPath)) {
        return reply
          .code(409)
          .send({ error: `"${relPath}" is already part of this drop` });
      }

      const id = nanoid(16);
      const target = resolveUploadTarget(settings.quarantineDir, dropId, relPath);
      await mkdir(dirname(target), { recursive: true });
      try {
        const handle = await open(target, "wx");
        await handle.close();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          return reply
            .code(409)
            .send({ error: `"${relPath}" already exists in this drop` });
        }
        throw err;
      }

      const now = new Date().toISOString();
      const upload: Upload = {
        id,
        dropId,
        filename: basename(relPath),
        relPath,
        ext: extname(relPath),
        size,
        offset: 0,
        state: "uploading",
        createdAt: now,
        updatedAt: now,
      };
      deps.db.createUpload(upload);
      deps.events.emitUpload({
        action: "created",
        uploadId: id,
        dropId,
        filename: upload.filename,
        relPath,
        offset: 0,
        size,
      });

      setTusHeaders(reply, { Location: `/api/uploads/${id}` });
      return reply.code(201).send({ upload });
    },
  );

  /** Offset probe (HEAD is auto-registered from this GET by Fastify). */
  app.get<{ Params: { id: string } }>(
    "/api/uploads/:id",
    async (req, reply) => {
      const upload = deps.db.getUpload(req.params.id);
      if (!upload || upload.state === "cancelled") {
        return reply.code(404).send({ error: "Upload not found" });
      }
      setTusHeaders(reply, {
        "Upload-Offset": String(upload.offset),
        "Upload-Length": String(upload.size),
        "Cache-Control": "no-store",
      });
      return { upload };
    },
  );

  /** Append a chunk at the current offset. */
  app.patch<{ Params: { id: string } }>(
    "/api/uploads/:id",
    { bodyLimit: maxChunk + CREATION_BODY_LIMIT },
    async (req, reply) => {
      if (!requireTus(req, reply)) return;
      const contentType = headerValue(req.headers["content-type"])
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== "application/offset+octet-stream") {
        return reply.code(415).send({
          error: "Content-Type must be application/offset+octet-stream",
        });
      }

      const offsetHeader = headerValue(req.headers["upload-offset"]);
      const offset =
        offsetHeader && /^\d+$/.test(offsetHeader) ? Number(offsetHeader) : NaN;
      if (!Number.isSafeInteger(offset) || offset < 0) {
        return reply
          .code(400)
          .send({ error: "Upload-Offset header (a non-negative integer) is required" });
      }

      const upload = deps.db.getUpload(req.params.id);
      if (!upload || upload.state === "cancelled") {
        return reply.code(404).send({ error: "Upload not found" });
      }
      if (upload.state === "complete" || offset !== upload.offset) {
        setTusHeaders(reply, { "Upload-Offset": String(upload.offset) });
        return reply.code(409).send({
          error: `Offset mismatch: the server is at ${upload.offset}`,
        });
      }

      const lengthHeader = headerValue(req.headers["content-length"]);
      if (lengthHeader !== undefined) {
        const length = /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : NaN;
        if (!Number.isSafeInteger(length)) {
          return reply.code(400).send({ error: "Invalid Content-Length" });
        }
        if (length > maxChunk || upload.offset + length > upload.size) {
          setTusHeaders(reply, { "Upload-Offset": String(upload.offset) });
          return reply.code(413).send({
            error:
              length > maxChunk
                ? `Chunk exceeds the ${maxChunk}-byte limit`
                : "Chunk exceeds the declared upload size",
          });
        }
      }

      if (!deps.locks.acquire(upload.id)) {
        setTusHeaders(reply, { "Upload-Offset": String(upload.offset) });
        return reply.code(423).send({ error: "Upload is already being written to" });
      }
      // Released before the response goes out: the client may fire the next
      // chunk the instant it sees 204.
      let lockReleased = false;
      const releaseLock = () => {
        if (lockReleased) return;
        lockReleased = true;
        deps.locks.release(upload.id);
      };
      try {
        const body = req.body as Readable | undefined;
        if (!body || typeof body[Symbol.asyncIterator] !== "function") {
          return reply.code(400).send({ error: "Missing request body" });
        }

        const target = resolveUploadTarget(
          deps.getSettings().quarantineDir,
          upload.dropId,
          upload.relPath,
        );
        let handle;
        try {
          handle = await open(target, "r+");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            req.log.warn({ uploadId: upload.id }, "upload file missing on disk");
            return reply.code(410).send({ error: "Upload file no longer exists" });
          }
          throw err;
        }

        let position = upload.offset;
        let received = 0;
        try {
          for await (const chunk of body) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += buf.length;
            if (received > maxChunk) {
              throw new UploadHttpError(
                413,
                `Chunk exceeds the ${maxChunk}-byte limit`,
              );
            }
            if (position + buf.length > upload.size) {
              throw new UploadHttpError(
                413,
                "Chunk exceeds the declared upload size",
              );
            }
            let written = 0;
            while (written < buf.length) {
              const { bytesWritten } = await handle.write(
                buf,
                written,
                buf.length - written,
                position + written,
              );
              if (bytesWritten <= 0) {
                throw new UploadHttpError(500, "Failed to write chunk");
              }
              written += bytesWritten;
            }
            position += buf.length;
          }

          // Durability before the offset is committed: a crash may lose the
          // tail (client retries the same offset), never the offset itself.
          await handle.sync();
          const state: UploadState =
            position >= upload.size ? "complete" : "uploading";
          deps.db.advanceUpload(upload.id, position, state);
          deps.events.emitUpload({
            action: state === "complete" ? "completed" : "progress",
            uploadId: upload.id,
            dropId: upload.dropId,
            filename: upload.filename,
            relPath: upload.relPath,
            offset: position,
            size: upload.size,
          });
          releaseLock();
          setTusHeaders(reply, { "Upload-Offset": String(position) });
          return reply.code(204).send();
        } catch (err) {
          // Roll back uncommitted tail bytes: file size must equal the offset.
          await handle.truncate(upload.offset).catch(() => {});
          if (err instanceof UploadHttpError) {
            setTusHeaders(reply, { "Upload-Offset": String(upload.offset) });
            return reply.code(err.status).send({ error: err.message });
          }
          req.log.warn({ err, uploadId: upload.id }, "upload chunk write failed");
          if (!reply.raw.headersSent && !req.raw.destroyed) {
            return reply.code(500).send({ error: "Upload failed" });
          }
          return reply;
        } finally {
          await handle.close().catch(() => {});
        }
      } finally {
        releaseLock();
      }
    },
  );

  /** Termination: cancel an upload and remove its partial file. */
  app.delete<{ Params: { id: string } }>(
    "/api/uploads/:id",
    async (req, reply) => {
      if (!requireTus(req, reply)) return;
      const upload = deps.db.getUpload(req.params.id);
      if (!upload || upload.state === "cancelled") {
        return reply.code(404).send({ error: "Upload not found" });
      }
      if (!deps.locks.acquire(upload.id)) {
        setTusHeaders(reply, { "Upload-Offset": String(upload.offset) });
        return reply.code(423).send({ error: "Upload is already being written to" });
      }
      let lockReleased = false;
      const releaseLock = () => {
        if (lockReleased) return;
        lockReleased = true;
        deps.locks.release(upload.id);
      };
      try {
        deps.db.deleteUpload(upload.id);
        await rm(
          resolveUploadTarget(
            deps.getSettings().quarantineDir,
            upload.dropId,
            upload.relPath,
          ),
          { force: true },
        );
        deps.events.emitUpload({
          action: "deleted",
          uploadId: upload.id,
          dropId: upload.dropId,
          filename: upload.filename,
          relPath: upload.relPath,
          offset: upload.offset,
          size: upload.size,
        });
        releaseLock();
        setTusHeaders(reply);
        return reply.code(204).send();
      } finally {
        releaseLock();
      }
    },
  );

  /** Droparr extension: list uploads of a drop + its analyze path once done. */
  app.get<{ Querystring: { dropId?: string; state?: string } }>(
    "/api/uploads",
    async (req) => {
      const dropId = sanitizeDropId(req.query.dropId);
      const state = (
        ["uploading", "complete", "cancelled"] as const
      ).includes(req.query.state as UploadState)
        ? (req.query.state as UploadState)
        : undefined;
      const uploads = deps.db.listUploads({ dropId, state });

      let completePath: string | undefined;
      if (dropId) {
        const active = uploads.filter((u) => u.state !== "cancelled");
        if (active.length > 0 && active.every((u) => u.state === "complete")) {
          completePath = resolveDropDir(
            deps.getSettings().quarantineDir,
            dropId,
          );
        }
      }
      return { uploads, completePath };
    },
  );
}
