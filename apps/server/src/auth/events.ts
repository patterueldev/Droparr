import { EventEmitter } from "node:events";

export interface SessionRevokedEvent {
  sessionId: string;
  userId: string;
}

/**
 * Tiny event bus used to notify live WebSocket connections that the session
 * they belong to was revoked (or logged out).
 */
export class AuthEvents extends EventEmitter {
  emitSessionRevoked(event: SessionRevokedEvent): void {
    this.emit("session-revoked", event);
  }
}
