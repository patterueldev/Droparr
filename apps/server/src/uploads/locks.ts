/**
 * In-process write locks: one PATCH at a time per upload.
 *
 * A concurrent PATCH gets 423 Locked and tus-js-client retries with backoff.
 */
export class UploadLocks {
  private readonly held = new Set<string>();

  /** Returns false when the upload is already being written to. */
  acquire(id: string): boolean {
    if (this.held.has(id)) return false;
    this.held.add(id);
    return true;
  }

  release(id: string): void {
    this.held.delete(id);
  }

  isHeld(id: string): boolean {
    return this.held.has(id);
  }
}
