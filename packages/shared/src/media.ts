/**
 * Canonical media extension lists.
 *
 * Both the analyzer (packages/core) and the upload allowlist derive from
 * these lists, so anything the uploader accepts is also understood by the
 * import pipeline (walkMediaFiles / analyzeFolder).
 */

export const VIDEO_EXTENSIONS: readonly string[] = [
  ".mkv",
  ".mp4",
  ".avi",
  ".mov",
  ".wmv",
  ".flv",
  ".m4v",
  ".mpg",
  ".mpeg",
  ".ts",
  ".m2ts",
  ".webm",
];

export const SUBTITLE_EXTENSIONS: readonly string[] = [
  ".srt",
  ".ass",
  ".ssa",
  ".sub",
  ".idx",
  ".vtt",
];

const VIDEO_EXTENSION_SET = new Set(VIDEO_EXTENSIONS);
const SUBTITLE_EXTENSION_SET = new Set(SUBTITLE_EXTENSIONS);

/** Lowercase extension (including the dot) or "" when there is none. */
export function extname(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

export function isVideoFileName(name: string): boolean {
  return VIDEO_EXTENSION_SET.has(extname(name));
}

export function isSubtitleFileName(name: string): boolean {
  return SUBTITLE_EXTENSION_SET.has(extname(name));
}

/**
 * Upload allowlist check for a file name or relative path.
 *
 * Accepts video + subtitle extensions; rejects macOS AppleDouble (`._*`)
 * sidecars, which share a media extension but are junk.
 */
export function isAllowedUploadFileName(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? "";
  if (!base || base.startsWith("._") || base === ".DS_Store") return false;
  return isVideoFileName(base) || isSubtitleFileName(base);
}

/** Human-readable list for error messages ("mkv, mp4, …"). */
export function allowedUploadExtensionsLabel(): string {
  return [...VIDEO_EXTENSIONS, ...SUBTITLE_EXTENSIONS]
    .map((e) => e.slice(1))
    .join(", ");
}
