import type { FastifyInstance } from "fastify";
import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { analyzeFolder } from "@droparr/core";
import { walkMediaFiles } from "../fs/walk.js";

/**
 * Server-side path browsing + drop analysis.
 *
 * Security: paths are resolved to absolute; browsing is restricted to
 * DROPARR_BROWSE_ROOTS (colon-separated) when set, else any absolute path
 * (M1 is admin-only, LAN/dev — M2 adds auth + this stays admin-only).
 */
export function fsRoutes(app: FastifyInstance): void {
  const roots = (process.env.DROPARR_BROWSE_ROOTS ?? "")
    .split(":")
    .filter(Boolean)
    .map((r) => resolve(r));

  function isAllowed(p: string): boolean {
    if (roots.length === 0) return true;
    const resolved = resolve(p);
    return roots.some(
      (root) => resolved === root || resolved.startsWith(root + "/"),
    );
  }

  app.get<{ Querystring: { path?: string } }>("/api/fs/list", async (req, reply) => {
    const raw = req.query.path?.trim() || homedir();
    if (!isAbsolute(raw)) {
      return reply.code(400).send({ error: "Path must be absolute" });
    }
    const path = resolve(raw);
    if (!isAllowed(path)) {
      return reply.code(403).send({ error: "Path is outside the allowed browse roots" });
    }
    try {
      const st = await stat(path);
      if (!st.isDirectory()) {
        return reply.code(400).send({ error: "Not a directory" });
      }
      const entries = await readdir(path, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({ name: e.name, path: join(path, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        path,
        parent: path === "/" ? null : resolve(path, ".."),
        dirs,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return reply.code(404).send({ error: "Path not found" });
      if (code === "EACCES") return reply.code(403).send({ error: "Permission denied" });
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Analyze a dropped folder: enumerate media files + heuristic match. */
  app.post<{ Body: { path?: string } }>("/api/analyze", async (req, reply) => {
    const raw = req.body?.path?.trim();
    if (!raw || !isAbsolute(raw)) {
      return reply.code(400).send({ error: "Absolute path is required" });
    }
    const path = resolve(raw);
    if (!isAllowed(path)) {
      return reply.code(403).send({ error: "Path is outside the allowed browse roots" });
    }
    try {
      const st = await stat(path);
      if (!st.isDirectory()) {
        return reply.code(400).send({ error: "Not a directory" });
      }
      const walked = await walkMediaFiles(path);
      if (walked.files.length === 0) {
        return reply.code(422).send({ error: "No media files found in this folder" });
      }
      const analysis = analyzeFolder({
        files: walked.files.map((f) => f.path),
        sizes: Object.fromEntries(walked.files.map((f) => [f.path, f.size])),
        dropName: basename(path),
      });
      return {
        sourcePath: path,
        dropName: basename(path),
        analysis,
        totalBytes: walked.totalBytes,
        skipped: walked.skipped,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return reply.code(404).send({ error: "Path not found" });
      if (code === "EACCES") return reply.code(403).send({ error: "Permission denied" });
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
