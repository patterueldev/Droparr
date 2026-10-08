import * as tus from "tus-js-client";
import { UPLOAD_CHUNK_SIZE_BYTES } from "@droparr/shared";

export interface CreateUploadOptions {
  file: File;
  relPath: string;
  dropId: string;
  /** Existing server-side upload URL (resume via HEAD instead of POST). */
  uploadUrl?: string;
  onProgress: (bytesSent: number, bytesTotal: number) => void;
  onSuccess: () => void;
  onError: (message: string) => void;
  /** Fired once the server-side upload URL is known (created or resumed). */
  onUploadUrl?: (url: string) => void;
}

/**
 * One tus.Upload per file, 32 MiB PATCH chunks (Cloudflare Tunnel caps
 * proxied bodies at 100 MB).
 *
 * Resume: the panel reconciles against `GET /api/uploads?dropId=…` and passes
 * the existing `uploadUrl` (HEAD → continue at the server offset). The
 * tus-js-client fingerprint store is a secondary path for same-browser
 * restarts, guarded so it can never resume into a different drop.
 */
export function createUpload(options: CreateUploadOptions): tus.Upload {
  const upload = new tus.Upload(options.file, {
    endpoint: new URL("/api/uploads", window.location.origin).toString(),
    ...(options.uploadUrl ? { uploadUrl: options.uploadUrl } : {}),
    chunkSize: UPLOAD_CHUNK_SIZE_BYTES,
    retryDelays: [0, 3000, 5000, 10000, 20000, 30000],
    removeFingerprintOnSuccess: true,
    metadata: {
      filename: options.file.name,
      filetype: options.file.type || "application/octet-stream",
      relpath: options.relPath,
      dropid: options.dropId,
    },
    onProgress: (bytesSent, bytesTotal) => {
      options.onProgress(bytesSent, bytesTotal ?? options.file.size);
    },
    onSuccess: () => options.onSuccess(),
    onError: (error) => {
      // 507 = the server refused/aborted the upload because the volume is
      // full (it also removed any partial file). tus's own message is
      // opaque, so surface something actionable.
      const response = (
        error as { originalResponse?: { getStatus(): number } }
      ).originalResponse;
      if (response?.getStatus() === 507) {
        options.onError(
          "Server storage is full — the upload was stopped and any partial file removed.",
        );
        return;
      }
      options.onError(error.message);
    },
    onUploadUrlAvailable: () => {
      if (upload.url) options.onUploadUrl?.(upload.url);
    },
    onShouldRetry: (error) => {
      const status = error.originalResponse
        ? error.originalResponse.getStatus()
        : 0;
      // A 409 before an upload URL exists is the creation POST saying the
      // path is already part of the drop — retrying can never succeed.
      if (status === 409 && !upload.url) return false;
      // Don't retry our own rejections (type/size/path); retry offset
      // conflicts, locks, server errors and network failures.
      if (status >= 400 && status < 500 && status !== 409 && status !== 423) {
        return false;
      }
      return true;
    },
  });
  return upload;
}
