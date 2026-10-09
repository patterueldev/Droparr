import { describe, expect, it } from "vitest";
import type { SubmissionState } from "@droparr/shared";
import { timelineFor } from "./timeline";

/** `id:status` pairs, in order — the full chain is always rendered. */
function steps(state: SubmissionState): string[] {
  return timelineFor(state).map((step) => `${step.id}:${step.status}`);
}

describe("timelineFor", () => {
  it("always renders the full lifecycle in order", () => {
    expect(timelineFor("pending").map((step) => step.id)).toEqual([
      "uploading",
      "analyzing",
      "pending",
      "approved",
      "importing",
      "done",
    ]);
  });

  it("walks the happy path from upload to done", () => {
    expect(steps("uploading")[0]).toBe("uploading:current");
    expect(steps("analyzing")).toEqual([
      "uploading:done",
      "analyzing:current",
      "pending:todo",
      "approved:todo",
      "importing:todo",
      "done:todo",
    ]);
    expect(steps("pending")).toEqual([
      "uploading:done",
      "analyzing:done",
      "pending:current",
      "approved:todo",
      "importing:todo",
      "done:todo",
    ]);
    expect(steps("approved")).toEqual([
      "uploading:done",
      "analyzing:done",
      "pending:done",
      "approved:current",
      "importing:todo",
      "done:todo",
    ]);
    expect(steps("importing")).toEqual([
      "uploading:done",
      "analyzing:done",
      "pending:done",
      "approved:done",
      "importing:current",
      "done:todo",
    ]);
    expect(steps("done").every((step) => step.endsWith(":done"))).toBe(true);
  });

  it("pins a rejection to the approval step", () => {
    const rendered = timelineFor("rejected");
    expect(rendered[2]).toMatchObject({
      id: "pending",
      label: "Rejected",
      status: "failed",
    });
    expect(steps("rejected").slice(3)).toEqual([
      "approved:todo",
      "importing:todo",
      "done:todo",
    ]);
  });

  it("pins an import failure to the import step", () => {
    const rendered = timelineFor("failed");
    expect(rendered[4]).toMatchObject({
      id: "importing",
      label: "Import failed",
      status: "failed",
    });
    expect(steps("failed")[0]).toBe("uploading:done");
    expect(steps("failed")[5]).toBe("done:todo");
  });
});
