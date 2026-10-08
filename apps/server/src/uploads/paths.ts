import { join, resolve, sep } from "node:path";

const MAX_SEGMENT_LENGTH = 255;
const MAX_REL_PATH_LENGTH = 1024;

/**
 * Normalize a client-supplied relative path for storage inside a drop dir.
 *
 * Returns a `/`-separated path with no `.`/empty segments, or `null` when the
 * path is unsafe (absolute, drive-lettered, contains `..`, NUL bytes, macOS
 * AppleDouble junk, or is absurdly long).
 */
export function sanitizeRelPath(relPath: string): string | null {
  if (relPath.includes("\0")) return null;
  const cleaned = relPath.replace(/\\/g, "/");
  if (cleaned.startsWith("/")) return null;
  if (/^[A-Za-z]:/.test(cleaned)) return null;

  const segments: string[] = [];
  for (const raw of cleaned.split("/")) {
    const seg = raw.trim();
    if (!seg || seg === ".") continue;
    if (seg === "..") return null;
    if (seg.length > MAX_SEGMENT_LENGTH) return null;
    if (seg.startsWith("._") || seg === ".DS_Store") return null;
    segments.push(seg);
  }
  if (segments.length === 0) return null;
  const joined = segments.join("/");
  if (joined.length > MAX_REL_PATH_LENGTH) return null;
  return joined;
}

/** Drop ids group the files of one browser drop; keep them filesystem-safe. */
export function sanitizeDropId(dropId: string | undefined): string | undefined {
  if (!dropId) return undefined;
  const trimmed = dropId.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * Absolute path of an upload target. The relative path must already be
 * sanitized; the prefix assertion is a last line of defence.
 */
export function resolveUploadTarget(
  quarantineDir: string,
  dropId: string,
  relPath: string,
): string {
  const dropDir = resolve(quarantineDir, dropId);
  const abs = resolve(dropDir, ...relPath.split("/"));
  if (abs !== dropDir && !abs.startsWith(dropDir + sep)) {
    throw new Error(`Upload path escapes the quarantine dir: ${relPath}`);
  }
  return abs;
}

export function resolveDropDir(quarantineDir: string, dropId: string): string {
  return join(quarantineDir, dropId);
}
