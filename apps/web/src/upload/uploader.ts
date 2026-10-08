import * as tus from "tus-js-client";
import { UPLOAD_CHUNK_SIZE_BYTES } from "@droparr/shared";

export interface CreateUploadOptions {
  file: File;
  relPath: string;
  dropId: string;
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
 * Resume: tus-js-client fingerprints the file (name/size/mtime) and stores
 * the upload URL in localStorage, so re-adding the same files after a browser
 * restart continues at the server-side offset.
 */
export function createUpload(options: CreateUploadOptions): tus.Upload {
  const upload = new tus.Upload(options.file, {
    endpoint: new URL("/api/uploads", window.location.origin).toString(),
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
    onError: (error) => options.onError(error.message),
    onUploadUrlAvailable: () => {
      if (upload.url) options.onUploadUrl?.(upload.url);
    },
    onShouldRetry: (error) => {
      const status = error.originalResponse
        ? error.originalResponse.getStatus()
        : 0;
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
