import { EventEmitter } from "node:events";
import type { SubmissionState } from "@droparr/shared";

/**
 * Submission state transitions, broadcast over the shared `/api/ws` channel
 * as `type: "submission"` frames. Admins see every frame; submitters only
 * their own (the WS handler scopes by `submitterId`). The queue and the
 * submitter view use these to refetch without polling.
 */
export interface SubmissionEvent {
  type: "submission";
  submissionId: string;
  submitterId: string;
  state: SubmissionState;
  at: string;
}

export class SubmissionEventBus extends EventEmitter {
  emitSubmission(event: Omit<SubmissionEvent, "type" | "at">): void {
    const full: SubmissionEvent = {
      type: "submission",
      at: new Date().toISOString(),
      ...event,
    };
    this.emit("event", full);
  }
}
