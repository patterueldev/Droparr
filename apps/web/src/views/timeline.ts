import type { SubmissionState } from "@droparr/shared";

export type TimelineStepId =
  | "uploading"
  | "analyzing"
  | "pending"
  | "approved"
  | "importing"
  | "done";

export type TimelineStepStatus = "done" | "current" | "failed" | "todo";

export interface TimelineStep {
  id: TimelineStepId;
  label: string;
  status: TimelineStepStatus;
}

const ORDER: TimelineStepId[] = [
  "uploading",
  "analyzing",
  "pending",
  "approved",
  "importing",
  "done",
];

const LABELS: Record<TimelineStepId, string> = {
  uploading: "Uploaded",
  analyzing: "Analyzed",
  pending: "Waiting for approval",
  approved: "Approved",
  importing: "Importing",
  done: "Done",
};

/**
 * Lifecycle steps for one submission. `uploading`/`analyzing` are client-side
 * phases of the drop wizard; by the time a submission row exists they are
 * already done. A rejection pins the failure to the approval step, an import
 * error to the import step, and everything after the failure stays `todo`.
 */
export function timelineFor(state: SubmissionState): TimelineStep[] {
  if (state === "done") {
    return ORDER.map(
      (id): TimelineStep => ({ id, label: LABELS[id], status: "done" }),
    );
  }
  if (state === "rejected" || state === "failed") {
    const failedId: TimelineStepId =
      state === "rejected" ? "pending" : "importing";
    const failedLabel = state === "rejected" ? "Rejected" : "Import failed";
    const failedIndex = ORDER.indexOf(failedId);
    return ORDER.map((id, i): TimelineStep => {
      if (i === failedIndex) return { id, label: failedLabel, status: "failed" };
      return {
        id,
        label: LABELS[id],
        status: i < failedIndex ? "done" : "todo",
      };
    });
  }
  const currentIndex = ORDER.indexOf(state);
  return ORDER.map((id, i): TimelineStep => ({
    id,
    label: LABELS[id],
    status: i < currentIndex ? "done" : i === currentIndex ? "current" : "todo",
  }));
}
