import type { FastifyInstance } from "fastify";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { analyzeDrop } from "@droparr/core";
import { walkMediaFiles } from "../fs/walk.js";

/**
 * Server-side path browsing + drop analysis.
 *
 * Security: paths are resolved to absolute; browsing is restricted to
 * DROPARR_BROWSE_ROOTS (colon-separated) when set, plus any extra roots
 * (the upload quarantine dir). Else any absolute path
 * (M1 is admin-only, LAN/dev — M2 adds auth + this stays admin-only).
 */
export function fsRoutes(
  app: FastifyInstance,
  options: { extraRoots?: string[] | (() => string[]) } = {},
): void {
  const envRoots = (process.env.DROPARR_BROWSE_ROOTS ?? "")
    .split(":")
    .filter(Boolean)
    .map((r) => resolve(r));

  function allowedRoots(): string[] {
    // Extra roots may be dynamic (the upload quarantine dir can change via
    // Settings), so they are resolved per request.
    const extra =
      typeof options.extraRoots === "function"
        ? options.extraRoots()
        : (options.extraRoots ?? []);
    return [...envRoots, ...extra].filter(Boolean).map((r) => resolve(r));
  }

  function isAllowed(p: string): boolean {
    const roots = allowedRoots();
    if (roots.length === 0) return true;
    return roots.some((root) => encloses(root, p));
  }

  /** Absolute `parent` is `child` itself, or a directory above it. */
  function encloses(parent: string, child: string): boolean {
    const a = resolve(parent);
    const b = resolve(child);
    return b === a || b.startsWith(a === "/" ? "/" : a + "/");
  }

  /**
   * May we read `dir`? Yes when it sits inside a browse root, or on the path
   * down to one (so typing `/da` can still surface `/data`). Suggestions are
   * filtered by the roots either way, so names outside them never leak.
   */
  function canBrowse(dir: string): boolean {
    const roots = allowedRoots();
    if (roots.length === 0) return true;
    return roots.some((root) => encloses(dir, root) || encloses(root, dir));
  }

  /** Suggestable: inside a browse root, or a step on the way down to one. */
  function isVisible(p: string): boolean {
    const roots = allowedRoots();
    if (roots.length === 0) return true;
    return roots.some((root) => encloses(root, p) || encloses(p, root));
  }

  /** Absolute subdirectories of `dir`: dot-dirs hidden, sorted by name. */
  async function listSubdirs(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => join(dir, e.name))
      .sort((a, b) => a.localeCompare(b));
  }

  async function isDirectory(p: string): Promise<boolean> {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
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
      const dirs = (await listSubdirs(path)).map((p) => ({
        name: basename(p),
        path: p,
      }));
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

  /**
   * Type-ahead directory suggestions for the path pickers (Settings → staging
   * directory, import wizard): `{ dir, matches }` with absolute paths.
   *
   * A partial that already names a directory (or ends in "/") lists that
   * directory's children; anything else prefix-matches the entries under its
   * parent — typing `/da` suggests `/data`, continuing suggests
   * `/data/staging`. Missing or unreadable directories suggest nothing
   * (never an error), and browse roots are enforced server-side: only paths
   * inside a root, or steps on the way down to one, are ever returned.
   */
  app.get<{ Querystring: { path?: string } }>(
    "/api/fs/suggest",
    async (req, reply) => {
      const raw = req.query.path?.trim() ?? "";
      if (!raw || !isAbsolute(raw)) {
        return reply.code(400).send({ error: "Path must be absolute" });
      }

      // Split the partial into "directory to read" + "prefix to match".
      // `resolve` strips a trailing slash, so remember it first.
      const resolved = resolve(raw);
      const listsChildren =
        raw.endsWith("/") || resolved === "/" || (await isDirectory(resolved));
      const dir = listsChildren ? resolved : dirname(resolved);
      const prefix = listsChildren ? "" : basename(resolved).toLowerCase();

      const matches = canBrowse(dir)
        ? (await listSubdirs(dir).catch(() => []))
            .filter((p) => isVisible(p))
            .filter((p) => basename(p).toLowerCase().startsWith(prefix))
        : [];
      return { dir, matches };
    },
  );

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
      const drop = analyzeDrop({
        files: walked.files.map((f) => f.path),
        sizes: Object.fromEntries(walked.files.map((f) => [f.path, f.size])),
        dropName: basename(path),
      });
      return {
        sourcePath: path,
        dropName: basename(path),
        analysis: drop.analysis,
        // Reviewable items: one per movie when the drop fanned out; each
        // carries the absolute path to import from.
        items: drop.items.map((item) => ({
          ...item,
          sourcePath: item.subPath ? join(path, item.subPath) : path,
        })),
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
