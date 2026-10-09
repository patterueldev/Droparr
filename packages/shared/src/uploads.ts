/** Shared upload (TUS-style) types and constants. */

/** 32 MiB PATCH chunks — Cloudflare Tunnel caps proxied request bodies at 100 MB. */
export const UPLOAD_CHUNK_SIZE_BYTES = 32 * 1024 * 1024;

/** Default caps; 0 means unlimited. Overridable in Settings (M3.2 surface). */
export const DEFAULT_MAX_UPLOAD_FILE_SIZE_BYTES = 64 * 1024 ** 3; // 64 GiB
export const DEFAULT_MAX_SUBMISSION_SIZE_BYTES = 256 * 1024 ** 3; // 256 GiB

/**
 * Free-space headroom kept on the quarantine volume: new uploads are refused
 * (and running ones aborted + removed) below this. 0 disables the guard.
 */
export const DEFAULT_MIN_FREE_SPACE_BYTES = 10 * 1024 ** 3; // 10 GiB

/**
 * Days a quarantined drop is kept after it finishes (or after its last
 * write) before the cleanup sweep removes it. 0 keeps files forever.
 */
export const DEFAULT_RETENTION_DAYS = 7;

export type UploadState = "uploading" | "complete" | "cancelled";

/** One in-progress or finished file upload, stored in SQLite. */
export interface Upload {
  id: string;
  /** Groups the files of one browser drop (client-generated). */
  dropId: string;
  /** Droparr user that created the upload; absent on legacy rows. */
  userId?: string;
  /** Sanitized display name (basename). */
  filename: string;
  /** Sanitized path relative to the drop directory. */
  relPath: string;
  /** Lowercase extension including the dot. */
  ext: string;
  size: number;
  /** Bytes durably written to disk so far. */
  offset: number;
  state: UploadState;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** `GET /api/uploads?dropId=…` — files of a drop plus the path to analyze. */
export interface UploadListResponse {
  uploads: Upload[];
  /** Set when every non-cancelled upload of the drop is complete. */
  completePath?: string;
}

/** Broadcast over the existing `/api/ws` channel. */
export interface UploadEvent {
  type: "upload";
  action: "created" | "progress" | "completed" | "deleted";
  uploadId: string;
  dropId: string;
  /** Owner of the upload; the WS handler scopes frames by this. */
  userId?: string;
  filename: string;
  relPath: string;
  offset: number;
  size: number;
  at: string;
}
