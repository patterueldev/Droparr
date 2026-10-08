import { describe, expect, it } from "vitest";
import type { Upload } from "@droparr/shared";
import { reconcileFile } from "./reconcile.js";

function upload(patch: Partial<Upload>): Upload {
  return {
    id: "u1",
    dropId: "drop1",
    filename: "movie.mkv",
    relPath: "movie.mkv",
    ext: ".mkv",
    size: 100,
    offset: 0,
    state: "uploading",
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
    ...patch,
  };
}

describe("reconcileFile", () => {
  it("plans a plain upload when the drop has no such file", () => {
    expect(
      reconcileFile({ relPath: "movie.mkv", size: 100, existingByPath: new Map() }),
    ).toEqual({});
  });

  it("marks a server-complete file done instead of re-uploading it", () => {
    const existing = new Map([
      ["movie.mkv", upload({ id: "abc", state: "complete", offset: 100 })],
    ]);
    expect(
      reconcileFile({ relPath: "movie.mkv", size: 100, existingByPath: existing }),
    ).toEqual({ alreadyCompleteSize: 100 });
  });

  it("resumes an in-progress upload via its server URL", () => {
    const existing = new Map([
      ["movie.mkv", upload({ id: "abc", offset: 40 })],
    ]);
    expect(
      reconcileFile({ relPath: "movie.mkv", size: 100, existingByPath: existing }),
    ).toEqual({ resumeUrl: "/api/uploads/abc" });
  });

  it("rejects a same-named file whose size differs", () => {
    const existing = new Map([
      ["movie.mkv", upload({ size: 100 })],
    ]);
    expect(
      reconcileFile({ relPath: "movie.mkv", size: 200, existingByPath: existing }),
    ).toEqual({
      error: "A different file with this name is already in this drop",
    });
  });

  it("keeps drop association: the resume URL points at the same drop's upload", () => {
    const existing = new Map([
      ["season/s01e01.mkv", upload({ id: "xyz", dropId: "drop1", relPath: "season/s01e01.mkv", size: 50 })],
    ]);
    const decision = reconcileFile({
      relPath: "season/s01e01.mkv",
      size: 50,
      existingByPath: existing,
    });
    expect(decision.resumeUrl).toBe("/api/uploads/xyz");
  });
});
