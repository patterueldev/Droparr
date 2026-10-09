import type { Submission, SubmissionState } from "@droparr/shared";
import type { ConfigStore } from "../config/store.js";
import type { Db } from "../db.js";
import type { JobRegistry } from "../jobs.js";
import type {
  SubmissionEvent,
  SubmissionEventBus,
} from "../submissions/events.js";
import { deliverWebhook, type OutboundMessage } from "./webhook.js";

export interface NotificationServiceDeps {
  config: ConfigStore;
  db: Db;
  jobs: JobRegistry;
  submissions: SubmissionEventBus;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

const INCLUDED = (submission: Submission): number =>
  submission.items.filter((i) => i.include).length;

/**
 * Optional webhook notifications (M3.5), off unless configured in Settings.
 * Subscribes to the same submission event bus the UI uses and posts one
 * channel message per meaningful transition:
 *
 * - `pending` → admins ("someone submitted …")
 * - `done` / `failed` → the submitter (import outcome + counts/error)
 * - `rejected` → the submitter (with the admin's note)
 *
 * Everything else (`approved`, `importing`, …) is progress, not an event.
 * Delivery is fire-and-forget: posts time out, failures are logged as warnings
 * and nothing here can block or fail the import pipeline.
 */
export class NotificationService {
  constructor(private readonly deps: NotificationServiceDeps) {}

  /** Subscribe to submission transitions (once, at boot). */
  start(): void {
    this.deps.submissions.on("event", this.onEvent);
  }

  stop(): void {
    this.deps.submissions.off("event", this.onEvent);
  }

  private readonly onEvent = (event: SubmissionEvent): void => {
    // Fire-and-forget: the emitter (the import pipeline) must never wait on us.
    void this.handleEvent(event).catch((err) => {
      this.deps.log?.warn(
        { err, submissionId: event.submissionId },
        "notification handler crashed",
      );
    });
  };

  /** Map one transition to a webhook post. Exposed for tests. */
  async handleEvent(event: SubmissionEvent): Promise<void> {
    const settings = this.deps.config.get().notifications;
    if (!settings?.enabled || !settings.url) return;
    const submission = this.deps.db.getSubmission(event.submissionId);
    if (!submission) return;
    const message = this.messageFor(event.state, submission);
    if (!message) return;

    const result = await deliverWebhook(settings.format, settings.url, message);
    if (!result.ok) {
      this.deps.log?.warn(
        {
          status: result.status,
          error: result.error,
          submissionId: event.submissionId,
          state: event.state,
        },
        "notification webhook failed",
      );
    }
  }

  private messageFor(
    state: SubmissionState,
    submission: Submission,
  ): OutboundMessage | undefined {
    switch (state) {
      case "pending":
        return this.pendingMessage(submission);
      case "done":
        return this.settledMessage(submission, true);
      case "failed":
        return this.settledMessage(submission, false);
      case "rejected":
        return this.rejectedMessage(submission);
      default:
        return undefined;
    }
  }

  /** A submission landed in the queue — the shared channel alerts the admins. */
  private pendingMessage(submission: Submission): OutboundMessage {
    return {
      title: "New submission awaiting approval",
      body: `${this.submitterName(submission)} submitted "${submission.dropName}" — ${INCLUDED(submission)} item(s) waiting for approval in Droparr.`,
      priority: "high",
      tags: ["inbox_tray"],
      color: 0x3b82f6,
    };
  }

  /** Import settled: done (possibly with rejections) or failed. */
  private settledMessage(submission: Submission, success: boolean): OutboundMessage {
    const who = this.submitterName(submission);
    const { imported, rejectedFiles, error } = this.jobOutcome(submission);

    if (success) {
      const counts = submission.jobIds?.length
        ? ` — ${imported}/${INCLUDED(submission)} item(s) imported`
        : "";
      const rejected =
        rejectedFiles > 0
          ? `; ${rejectedFiles} file(s) were rejected by the *arr`
          : "";
      return {
        title: "Import finished",
        body: `${who}: your submission "${submission.dropName}" is done${counts}${rejected}.`,
        priority: "default",
        tags: ["white_check_mark"],
        color: 0x22c55e,
      };
    }

    return {
      title: "Import failed",
      body: `${who}: your submission "${submission.dropName}" could not be imported.${
        error ? ` (${error.slice(0, 200)})` : ""
      } Open Droparr for details.`,
      priority: "high",
      tags: ["warning"],
      color: 0xef4444,
    };
  }

  /** Admin rejected the submission; deliver the note when there is one. */
  private rejectedMessage(submission: Submission): OutboundMessage {
    const note = submission.note?.trim();
    return {
      title: "Submission rejected",
      body: `${this.submitterName(submission)}: your submission "${
        submission.dropName
      }" was rejected.${note ? ` Note: ${note.slice(0, 500)}` : ""}`,
      priority: "high",
      tags: ["x"],
      color: 0xef4444,
    };
  }

  /** Counts and the first error across the submission's import jobs. */
  private jobOutcome(submission: Submission): {
    imported: number;
    rejectedFiles: number;
    error?: string;
  } {
    let imported = 0;
    let rejectedFiles = 0;
    let error: string | undefined;
    for (const jobId of submission.jobIds ?? []) {
      const last = this.deps.jobs.get(jobId)?.events.at(-1);
      if (last?.phase === "done") {
        imported++;
        rejectedFiles += last.result?.rejectedFiles.length ?? 0;
      } else if (last?.phase === "error" && !error) {
        error = last.error ?? last.message;
      }
    }
    return { imported, rejectedFiles, error };
  }

  private submitterName(submission: Submission): string {
    return this.deps.db.getUser(submission.submitterId)?.name ?? "Someone";
  }
}
