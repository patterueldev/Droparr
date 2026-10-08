import { EventEmitter } from "node:events";
import type { UploadEvent } from "@droparr/shared";

/**
 * Upload progress events, broadcast over the same `/api/ws` channel as job
 * events. Clients discriminate on `type` ("upload" vs "job").
 */
export class UploadEventBus extends EventEmitter {
  emitUpload(event: Omit<UploadEvent, "type" | "at">): void {
    const full: UploadEvent = {
      type: "upload",
      at: new Date().toISOString(),
      ...event,
    };
    this.emit("event", full);
  }
}
