import type { Upload } from "@droparr/shared";

export interface ReconcileDecision {
  /** The server holds a different file at this path — reject the add. */
  error?: string;
  /** The server already has this file complete — no re-upload needed. */
  alreadyCompleteSize?: number;
  /** An in-progress server upload to resume via HEAD. */
  resumeUrl?: string;
}

/**
 * Decide what to do with a file the user is (re-)adding to a drop, based on
 * the server's current uploads for that drop.
 *
 * Keeping this decision pure makes the browser-restart resume behaviour
 * (same drop dir, no re-upload of completed files) testable without a DOM.
 */
export function reconcileFile(input: {
  relPath: string;
  size: number;
  existingByPath: Map<string, Upload>;
}): ReconcileDecision {
  const existing = input.existingByPath.get(input.relPath);
  if (!existing) return {};
  if (existing.size !== input.size) {
    return {
      error: "A different file with this name is already in this drop",
    };
  }
  if (existing.state === "complete") {
    return { alreadyCompleteSize: existing.size };
  }
  return { resumeUrl: `/api/uploads/${existing.id}` };
}
