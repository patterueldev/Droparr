import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadEvent } from "@droparr/shared";
import { buildApp } from "../app.js";
import { Db } from "../db.js";
import { UploadEventBus } from "../uploads/events.js";
import { UploadLocks } from "../uploads/locks.js";
import type { UploadSettings } from "../uploads/settings.js";
import { uploadRoutes } from "./uploads.js";

const TUS_HEADERS = { "tus-resumable": "1.0.0" };

interface HarnessOptions {
  maxFileBytes?: number;
  maxSubmissionBytes?: number;
  maxChunk?: number;
}

interface Harness {
  app: FastifyInstance;
  db: Db;
  locks: UploadLocks;
  received: UploadEvent[];
  quarantineDir: string;
  settings: UploadSettings;
  tmp: string;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function buildHarness(
  opts: HarnessOptions & { baseDir?: string } = {},
): Promise<Harness> {
  const tmp =
    opts.baseDir ?? (await mkdtemp(join(tmpdir(), "droparr-uploads-")));
  const quarantineDir = join(tmp, "quarantine");
  const settings: UploadSettings = {
    quarantineDir,
    maxFileSizeBytes: opts.maxFileBytes ?? 1_000_000,
    maxSubmissionSizeBytes: opts.maxSubmissionBytes ?? 2_000_000,
  };
  const db = new Db(join(tmp, "droparr.db"));
  const events = new UploadEventBus();
  const received: UploadEvent[] = [];
  events.on("event", (e: UploadEvent) => received.push(e));
  const locks = new UploadLocks();
  const app = Fastify();
  uploadRoutes(app, {
    db,
    events,
    locks,
    getSettings: () => settings,
    maxChunkSizeBytes: opts.maxChunk ?? 4096,
  });
  cleanups.push(async () => {
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  });
  return { app, db, locks, received, quarantineDir, settings, tmp };
}

function encodeMetadata(metadata: Record<string, string>): string {
  return Object.entries(metadata)
    .map(([key, value]) => `${key} ${Buffer.from(value, "utf8").toString("base64")}`)
    .join(",");
}

function createUpload(
  app: FastifyInstance,
  file: { filename: string; size: number; relpath?: string; dropId?: string },
  headers: Record<string, string> = {},
  payload?: string,
) {
  const metadata: Record<string, string> = { filename: file.filename };
  if (file.relpath) metadata.relpath = file.relpath;
  if (file.dropId) metadata.dropid = file.dropId;
  return app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: {
      ...TUS_HEADERS,
      "upload-length": String(file.size),
      "upload-metadata": encodeMetadata(metadata),
      ...headers,
    },
    payload,
  });
}

function patchUpload(
  app: FastifyInstance,
  id: string,
  offset: number,
  payload: Buffer | Readable,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "PATCH",
    url: `/api/uploads/${id}`,
    headers: {
      ...TUS_HEADERS,
      "upload-offset": String(offset),
      "content-type": "application/offset+octet-stream",
      ...headers,
    },
    payload,
  });
}

function pattern(size: number): Buffer {
  return Buffer.from(Array.from({ length: size }, (_, i) => i % 251));
}

describe("upload creation", () => {
  it("creates an upload, returns Location and persists the row", async () => {
    const h = await buildHarness();
    const res = await createUpload(h.app, {
      filename: "Movie (2020).mkv",
      size: 3000,
      relpath: "Movie (2020)/Movie (2020).mkv",
      dropId: "drop-1",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { upload: { id: string; relPath: string; state: string } };
    expect(res.headers.location).toBe(`/api/uploads/${body.upload.id}`);
    expect(res.headers["tus-resumable"]).toBe("1.0.0");
    expect(body.upload.relPath).toBe("Movie (2020)/Movie (2020).mkv");
    expect(body.upload.state).toBe("uploading");

    const onDisk = await stat(
      join(h.quarantineDir, "drop-1", "Movie (2020)", "Movie (2020).mkv"),
    );
    expect(onDisk.size).toBe(0);
    expect(h.received.map((e) => e.action)).toEqual(["created"]);
  });

  it("rejects disallowed file types", async () => {
    const h = await buildHarness();
    const res = await createUpload(h.app, { filename: "notes.txt", size: 10 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not allowed/i);
  });

  it("rejects AppleDouble sidecars even with a media extension", async () => {
    const h = await buildHarness();
    const res = await createUpload(h.app, { filename: "._movie.mkv", size: 10 });
    expect(res.statusCode).toBe(400);
  });

  it("rejects traversal and absolute paths", async () => {
    const h = await buildHarness();
    for (const relpath of ["../escape.mkv", "/etc/passwd.mkv", "a/../../b.mkv"]) {
      const res = await createUpload(h.app, {
        filename: "movie.mkv",
        size: 10,
        relpath,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("rejects files over the per-file cap with Tus-Max-Size", async () => {
    const h = await buildHarness({ maxFileBytes: 1000 });
    const res = await createUpload(h.app, { filename: "big.mkv", size: 1001 });
    expect(res.statusCode).toBe(413);
    expect(res.headers["tus-max-size"]).toBe("1000");
  });

  it("rejects drops over the per-drop cap", async () => {
    const h = await buildHarness({ maxSubmissionBytes: 1000 });
    const first = await createUpload(h.app, {
      filename: "a.mkv",
      size: 600,
      dropId: "capdrop",
    });
    expect(first.statusCode).toBe(201);
    const second = await createUpload(h.app, {
      filename: "b.mkv",
      size: 600,
      dropId: "capdrop",
    });
    expect(second.statusCode).toBe(413);
    expect(second.json().error).toMatch(/per-drop/i);
  });

  it("rejects duplicate relative paths in the same drop", async () => {
    const h = await buildHarness();
    const first = await createUpload(h.app, {
      filename: "a.mkv",
      size: 10,
      dropId: "dupdrop",
    });
    expect(first.statusCode).toBe(201);
    const second = await createUpload(h.app, {
      filename: "a.mkv",
      size: 10,
      dropId: "dupdrop",
    });
    expect(second.statusCode).toBe(409);
  });

  it("requires the Tus-Resumable header", async () => {
    const h = await buildHarness();
    const res = await h.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { "upload-length": "10" },
    });
    expect(res.statusCode).toBe(412);
  });

  it("tolerates an empty creation body with the tus content type", async () => {
    const h = await buildHarness();
    const res = await createUpload(
      h.app,
      { filename: "a.mkv", size: 10 },
      { "content-type": "application/offset+octet-stream" },
      "",
    );
    expect(res.statusCode).toBe(201);
  });

  it("rejects an oversized creation body with 413", async () => {
    const h = await buildHarness({ maxChunk: 4096 });
    const res = await createUpload(
      h.app,
      { filename: "a.mkv", size: 10 },
      { "content-type": "application/offset+octet-stream" },
      "x".repeat(66_000),
    );
    expect(res.statusCode).toBe(413);
  });
});

describe("chunked upload", () => {
  it("uploads chunks to completion byte-exact and emits progress events", async () => {
    const h = await buildHarness();
    const content = pattern(2500);
    const created = await createUpload(h.app, {
      filename: "movie.mkv",
      size: content.length,
      dropId: "bytedrop",
    });
    const id = (created.json() as { upload: { id: string } }).upload.id;

    const first = await patchUpload(h.app, id, 0, content.subarray(0, 1000));
    expect(first.statusCode).toBe(204);
    expect(first.headers["upload-offset"]).toBe("1000");

    const second = await patchUpload(h.app, id, 1000, content.subarray(1000, 2000));
    expect(second.statusCode).toBe(204);
    expect(second.headers["upload-offset"]).toBe("2000");

    const third = await patchUpload(h.app, id, 2000, content.subarray(2000));
    expect(third.statusCode).toBe(204);
    expect(third.headers["upload-offset"]).toBe("2500");

    const onDisk = await readFile(join(h.quarantineDir, "bytedrop", "movie.mkv"));
    expect(onDisk.equals(content)).toBe(true);
    expect(h.db.getUpload(id)?.state).toBe("complete");
    expect(h.db.getUpload(id)?.offset).toBe(2500);

    expect(h.received.map((e) => [e.action, e.offset])).toEqual([
      ["created", 0],
      ["progress", 1000],
      ["progress", 2000],
      ["completed", 2500],
    ]);
  });

  it("answers HEAD probes with offset and length", async () => {
    const h = await buildHarness();
    const created = await createUpload(h.app, { filename: "a.mkv", size: 100 });
    const id = (created.json() as { upload: { id: string } }).upload.id;
    await patchUpload(h.app, id, 0, pattern(40));

    const head = await h.app.inject({
      method: "HEAD",
      url: `/api/uploads/${id}`,
      headers: TUS_HEADERS,
    });
    expect(head.statusCode).toBe(200);
    expect(head.headers["upload-offset"]).toBe("40");
    expect(head.headers["upload-length"]).toBe("100");
    expect(head.headers["cache-control"]).toBe("no-store");
  });

  it("409s on an offset mismatch and reports the server offset", async () => {
    const h = await buildHarness();
    const created = await createUpload(h.app, { filename: "a.mkv", size: 100 });
    const id = (created.json() as { upload: { id: string } }).upload.id;
    await patchUpload(h.app, id, 0, pattern(40));

    const res = await patchUpload(h.app, id, 10, pattern(10));
    expect(res.statusCode).toBe(409);
    expect(res.headers["upload-offset"]).toBe("40");
  });

  it("rejects chunks larger than the chunk limit", async () => {
    const h = await buildHarness({ maxChunk: 4096 });
    const created = await createUpload(h.app, { filename: "a.mkv", size: 10_000 });
    const id = (created.json() as { upload: { id: string } }).upload.id;
    const res = await patchUpload(h.app, id, 0, pattern(5000));
    expect(res.statusCode).toBe(413);
    expect(res.headers["upload-offset"]).toBe("0");
  });

  it("rejects chunks that overflow the declared size", async () => {
    const h = await buildHarness();
    const created = await createUpload(h.app, { filename: "a.mkv", size: 100 });
    const id = (created.json() as { upload: { id: string } }).upload.id;
    const res = await patchUpload(h.app, id, 0, pattern(200));
    expect(res.statusCode).toBe(413);
  });

  it("423s a concurrent PATCH while a write is in flight", async () => {
    const h = await buildHarness();
    const created = await createUpload(h.app, { filename: "a.mkv", size: 10 });
    const id = (created.json() as { upload: { id: string } }).upload.id;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowBody = Readable.from(
      (async function* () {
        yield Buffer.from("hello");
        await gate;
        yield Buffer.from("world");
      })(),
    );
    const inFlight = patchUpload(h.app, id, 0, slowBody);

    for (let i = 0; i < 200 && !h.locks.isHeld(id); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(h.locks.isHeld(id)).toBe(true);

    const concurrent = await patchUpload(h.app, id, 0, Buffer.from("hello"));
    expect(concurrent.statusCode).toBe(423);

    release();
    const finished = await inFlight;
    expect(finished.statusCode).toBe(204);
    expect(finished.headers["upload-offset"]).toBe("10");
  });

  it("resumes at the committed offset after a server restart", async () => {
    const first = await buildHarness();
    const content = pattern(1500);
    const created = await createUpload(first.app, {
      filename: "movie.mkv",
      size: content.length,
      dropId: "restartdrop",
    });
    const id = (created.json() as { upload: { id: string } }).upload.id;
    await patchUpload(first.app, id, 0, content.subarray(0, 700));

    // Fresh server + DB connection on the same data dir (simulated restart:
    // offsets come from SQLite, locks/events start empty).
    const second = await buildHarness({ baseDir: first.tmp });
    const head = await second.app.inject({
      method: "HEAD",
      url: `/api/uploads/${id}`,
      headers: TUS_HEADERS,
    });
    expect(head.headers["upload-offset"]).toBe("700");

    const resumed = await patchUpload(second.app, id, 700, content.subarray(700));
    expect(resumed.statusCode).toBe(204);
    expect(resumed.headers["upload-offset"]).toBe("1500");

    const onDisk = await readFile(
      join(second.quarantineDir, "restartdrop", "movie.mkv"),
    );
    expect(onDisk.equals(content)).toBe(true);
  });
});

describe("termination and listing", () => {
  it("deletes an upload and its partial file", async () => {
    const h = await buildHarness();
    const created = await createUpload(h.app, {
      filename: "a.mkv",
      size: 100,
      dropId: "deldrop",
    });
    const id = (created.json() as { upload: { id: string } }).upload.id;
    await patchUpload(h.app, id, 0, pattern(40));

    const del = await h.app.inject({
      method: "DELETE",
      url: `/api/uploads/${id}`,
      headers: TUS_HEADERS,
    });
    expect(del.statusCode).toBe(204);
    expect(h.db.getUpload(id)).toBeUndefined();
    await expect(
      stat(join(h.quarantineDir, "deldrop", "a.mkv")),
    ).rejects.toThrow();

    const again = await h.app.inject({
      method: "DELETE",
      url: `/api/uploads/${id}`,
      headers: TUS_HEADERS,
    });
    expect(again.statusCode).toBe(404);
    expect(h.received.some((e) => e.action === "deleted")).toBe(true);
  });

  it("lists drop uploads and reports completePath once every file is done", async () => {
    const h = await buildHarness();
    const a = await createUpload(h.app, {
      filename: "a.mkv",
      size: 100,
      dropId: "listdrop",
    });
    const b = await createUpload(h.app, {
      filename: "b.srt",
      size: 50,
      dropId: "listdrop",
    });
    const aId = (a.json() as { upload: { id: string } }).upload.id;
    const bId = (b.json() as { upload: { id: string } }).upload.id;

    const before = await h.app.inject({
      url: "/api/uploads?dropId=listdrop",
    });
    expect(before.json().uploads).toHaveLength(2);
    expect(before.json().completePath).toBeUndefined();

    await patchUpload(h.app, aId, 0, pattern(100));
    await patchUpload(h.app, bId, 0, pattern(50));

    const after = await h.app.inject({
      url: "/api/uploads?dropId=listdrop",
    });
    expect(after.json().uploads.every((u: { state: string }) => u.state === "complete")).toBe(true);
    expect(after.json().completePath).toBe(join(h.quarantineDir, "listdrop"));
  });

  it("advertises capabilities on OPTIONS", async () => {
    const h = await buildHarness();
    const res = await h.app.inject({ method: "OPTIONS", url: "/api/uploads" });
    expect(res.statusCode).toBe(204);
    expect(res.headers["tus-version"]).toBe("1.0.0");
    expect(res.headers["tus-extension"]).toContain("creation");
    expect(res.headers["tus-extension"]).toContain("termination");
  });
});

describe("uploads behind the auth guard", () => {
  it("401s without a session and uploads end-to-end once logged in", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/System/Info/Public")) {
          return Response.json({
            ServerName: "Jellyfin",
            Version: "10.10.3",
            Id: "srv-1",
          });
        }
        if (url.endsWith("/Users/AuthenticateByName")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            Username?: string;
            Pw?: string;
          };
          if (body.Username !== "admin" || body.Pw !== "hunter2") {
            return Response.json({}, { status: 401 });
          }
          return Response.json({
            User: {
              Id: "jf-admin",
              Name: "admin",
              Policy: { IsAdministrator: true },
            },
            AccessToken: "tok",
            ServerId: "srv-1",
          });
        }
        return Response.json({}, { status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const tmp = await mkdtemp(join(tmpdir(), "droparr-uploads-auth-"));
    const built = await buildApp({
      dataDir: tmp,
      configPath: join(tmp, "config.json"),
      serveWeb: false,
      logger: false,
    });
    cleanups.push(async () => {
      await built.app.close();
      await rm(tmp, { recursive: true, force: true });
      vi.unstubAllGlobals();
    });

    const boot = await built.app.inject({
      method: "POST",
      url: "/api/setup/jellyfin",
      payload: { baseUrl: "http://jellyfin.local:8096" },
    });
    expect(boot.statusCode).toBe(200);

    const login = await built.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "hunter2" },
    });
    expect(login.statusCode).toBe(200);
    const rawCookie = login.headers["set-cookie"];
    const setCookie = Array.isArray(rawCookie)
      ? String(rawCookie[0])
      : String(rawCookie);
    const cookie = setCookie.split(";")[0]!;

    const complete = await built.app.inject({
      method: "POST",
      url: "/api/setup/complete",
      headers: { cookie },
    });
    expect(complete.statusCode).toBe(200);

    const unauthenticated = await createUpload(built.app, {
      filename: "a.mkv",
      size: 10,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const content = pattern(1500);
    const created = await built.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: {
        ...TUS_HEADERS,
        cookie,
        "upload-length": String(content.length),
        "upload-metadata": encodeMetadata({
          filename: "movie.mkv",
          dropid: "authdrop",
        }),
      },
    });
    expect(created.statusCode).toBe(201);
    const location = created.headers.location as string;

    const patched = await built.app.inject({
      method: "PATCH",
      url: location,
      headers: {
        ...TUS_HEADERS,
        cookie,
        "content-type": "application/offset+octet-stream",
        "upload-offset": "0",
      },
      payload: content,
    });
    expect(patched.statusCode).toBe(204);
    expect(patched.headers["upload-offset"]).toBe(String(content.length));

    const onDisk = await readFile(
      join(tmp, "quarantine", "authdrop", "movie.mkv"),
    );
    expect(onDisk.equals(content)).toBe(true);
  });
});
