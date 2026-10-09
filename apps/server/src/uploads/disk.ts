import { statfs } from "node:fs/promises";

/** Free/total bytes of the filesystem behind a path. */
export interface DiskSpace {
  /** Bytes available to this (unprivileged) process — bavail × bsize. */
  freeBytes: number;
  /** Total filesystem size in bytes. */
  totalBytes: number;
}

/**
 * Probe the volume that holds `path` (statfs works on Linux and macOS).
 * Throws when the path does not exist or cannot be stat'ed — callers decide
 * whether that is fatal or a warning.
 */
export async function diskSpace(path: string): Promise<DiskSpace> {
  const st = await statfs(path);
  return {
    freeBytes: st.bavail * st.bsize,
    totalBytes: st.blocks * st.bsize,
  };
}

/** Injection point so tests can simulate a filling volume. */
export type FreeBytesProbe = (path: string) => Promise<number>;

export const statfsFreeBytes: FreeBytesProbe = async (path) =>
  (await diskSpace(path)).freeBytes;

/**
 * Write failures that mean "the volume is out of space" (ENOSPC) or the
 * user/project quota was exhausted (EDQUOT). Both abort the upload cleanly.
 */
export function isDiskFullError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return code === "ENOSPC" || code === "EDQUOT";
}

/** Human-readable byte size for error messages ("6.0 GiB", "512 MB", …). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
