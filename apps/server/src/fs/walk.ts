import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { FileRef } from "@droparr/shared";
import { isJunkFile, isMediaFile, extname } from "@droparr/core";

export interface WalkResult {
  /** Media files with paths relative to the root. */
  files: FileRef[];
  /** Total bytes across all media files. */
  totalBytes: number;
  /** Files skipped as junk/non-media (for the UI). */
  skipped: string[];
}

const MAX_DEPTH = 6;

/**
 * Recursively enumerate media files under a root directory.
 * Returns paths relative to `root`; skips junk, hidden dirs and
 * anything deeper than MAX_DEPTH.
 */
export async function walkMediaFiles(root: string): Promise<WalkResult> {
  const files: FileRef[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isMediaFile(entry.name) || isJunkFile(entry.name)) {
        skipped.push(rel);
        continue;
      }
      const st = await stat(abs);
      const size = st.size;
      files.push({
        name: entry.name,
        path: rel,
        size,
        ext: extname(entry.name),
      });
      totalBytes += size;
    }
  }

  await walk(root, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, totalBytes, skipped };
}
