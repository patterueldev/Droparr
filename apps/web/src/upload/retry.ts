/**
 * Retry policy for one file upload (tus-js-client `onShouldRetry`).
 *
 * Network failures (status 0) and 5xx are retried with backoff, with one
 * exception and two 4xx carve-outs:
 *
 * - 507 (insufficient storage) is 5xx but fatal: the server already removed
 *   the partial upload, so a retry would only produce a 404 — and the user
 *   would never see the "storage is full" message.
 * - A 409 before an upload URL exists is the creation POST reporting a
 *   duplicate path; retrying can never succeed.
 * - 409 once a URL exists (offset conflict) and 423 (locked by another
 *   write) are retried; other 4xx (type/size/path rejections) are not.
 */
export function shouldRetryUpload(
  status: number,
  hasUploadUrl: boolean,
): boolean {
  if (status === 507) return false;
  if (status === 409 && !hasUploadUrl) return false;
  if (status >= 400 && status < 500 && status !== 409 && status !== 423) {
    return false;
  }
  return true;
}
