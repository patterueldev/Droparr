import { EventEmitter } from "node:events";

export type JobPhase =
  | "queued"
  | "staging"
  | "adding"
  | "preflight"
  | "import"
  | "cleanup"
  | "done"
  | "error";

export interface JobEvent {
  jobId: string;
  phase: JobPhase;
  message: string;
  at: string;
  /** 0..1 when known (staging copy progress). */
  progress?: number;
  copiedBytes?: number;
  totalBytes?: number;
  filesCopied?: number;
  totalFiles?: number;
  /** *arr command info while importing. */
  command?: { id: number; name: string; status: string; message?: string };
  /** Set on error. */
  error?: string;
  /** Set on done. */
  result?: {
    importedFiles: number;
    rejectedFiles: { path: string; reasons: string[] }[];
    historyId: string;
  };
}

export interface JobState {
  id: string;
  events: JobEvent[];
  finished: boolean;
}

/**
 * In-memory job registry. Every event is appended to the job and broadcast
 * to WebSocket subscribers (the UI filters by jobId). Finished jobs are
 * kept so a reconnecting client can replay them.
 */
export class JobRegistry extends EventEmitter {
  private readonly jobs = new Map<string, JobState>();
  private readonly maxFinished = 50;

  create(id: string): void {
    this.jobs.set(id, { id, events: [], finished: false });
  }

  emitEvent(event: JobEvent): void {
    const job = this.jobs.get(event.jobId);
    if (job) {
      job.events.push(event);
      if (event.phase === "done" || event.phase === "error") {
        job.finished = true;
        this.prune();
      }
    }
    this.emit("event", event);
  }

  get(id: string): JobState | undefined {
    return this.jobs.get(id);
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter((j) => j.finished);
    if (finished.length <= this.maxFinished) return;
    for (const job of finished.slice(0, finished.length - this.maxFinished)) {
      this.jobs.delete(job.id);
    }
  }
}
