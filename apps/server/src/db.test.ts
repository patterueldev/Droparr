import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Submission, Upload } from "@droparr/shared";
import { Db } from "./db.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function makeDb(): Promise<Db> {
  const dir = await mkdtemp(join(tmpdir(), "droparr-db-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return new Db(join(dir, "droparr.db"));
}

describe("Db history migration", () => {
  it("adds titleSlug/rejectedJson to a pre-existing history table without losing rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "droparr-db-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "droparr.db");

    // Simulate a database created before the columns existed.
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE history (
        id TEXT PRIMARY KEY,
        instanceId TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        year INTEGER,
        matchedId INTEGER,
        filesJson TEXT NOT NULL,
        result TEXT NOT NULL,
        startedAt TEXT NOT NULL,
        completedAt TEXT
      );
    `);
    legacy
      .prepare(
        `INSERT INTO history (id, instanceId, kind, title, filesJson, result, startedAt)
         VALUES ('old', 'sonarr-1', 'series', 'Old Show', '[]', 'success', '2026-10-01T00:00:00.000Z')`,
      )
      .run();
    legacy.close();

    // Opening with the current Db runs the additive migration.
    const db = new Db(path);
    const old = db.getHistory("old");
    expect(old?.title).toBe("Old Show");
    expect(old?.titleSlug).toBeUndefined();
    expect(old?.rejectedFiles).toBeUndefined();

    db.addHistory({
      id: "new",
      instanceId: "sonarr-1",
      kind: "series",
      title: "Breaking Bad",
      titleSlug: "breaking-bad",
      files: [],
      rejectedFiles: [{ path: "/media/staging/e02.mkv", reasons: ["Sample"] }],
      result: "partial",
      timestamps: { started: "2026-10-08T00:00:00.000Z" },
    });
    const fresh = db.getHistory("new");
    expect(fresh?.titleSlug).toBe("breaking-bad");
    expect(fresh?.rejectedFiles).toEqual([
      { path: "/media/staging/e02.mkv", reasons: ["Sample"] },
    ]);
  });

  it("round-trips the submission link on history entries", async () => {
    const db = await makeDb();
    db.addHistory({
      id: "sub-history",
      submissionId: "sub-1",
      instanceId: "radarr-1",
      kind: "movie",
      title: "Dune",
      files: [],
      result: "success",
      timestamps: { started: "2026-10-09T00:00:00.000Z" },
    });
    expect(db.getHistory("sub-history")?.submissionId).toBe("sub-1");
  });
});

function makeSubmission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: "sub-1",
    submitterId: "user-a",
    state: "pending",
    dropId: "drop-1",
    dropName: "Movie (2020)",
    sourcePath: "/quarantine/drop-1",
    items: [
      {
        subPath: "",
        sourcePath: "/quarantine/drop-1",
        analysis: {
          kind: "movie",
          title: "Movie",
          year: 2020,
          files: [],
          confidence: "high",
          reasoning: [],
          subPath: "",
        },
        title: "Movie",
        year: 2020,
        categoryId: "movies",
        match: { tmdbId: 1, title: "Movie", year: 2020 },
        include: true,
      },
    ],
    importMode: "copy",
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeUpload(overrides: Partial<Upload> = {}): Upload {
  return {
    id: "upload-1",
    dropId: "drop-1",
    userId: "user-a",
    filename: "movie.mkv",
    relPath: "movie.mkv",
    ext: ".mkv",
    size: 10,
    offset: 10,
    state: "complete",
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("Db submissions", () => {
  it("round-trips a submission including items and jobs", async () => {
    const db = await makeDb();
    db.createSubmission(makeSubmission({ jobIds: ["job-1"], note: "why" }));

    const got = db.getSubmission("sub-1");
    expect(got).toMatchObject({
      submitterId: "user-a",
      state: "pending",
      dropId: "drop-1",
      dropName: "Movie (2020)",
      importMode: "copy",
      jobIds: ["job-1"],
      note: "why",
    });
    expect(got?.items[0]?.match?.tmdbId).toBe(1);
    expect(db.getSubmission("missing")).toBeUndefined();
  });

  it("lists by state and submitter, newest first", async () => {
    const db = await makeDb();
    db.createSubmission(
      makeSubmission({ id: "sub-1", createdAt: "2026-10-01T00:00:00.000Z" }),
    );
    db.createSubmission(
      makeSubmission({
        id: "sub-2",
        submitterId: "user-b",
        createdAt: "2026-10-03T00:00:00.000Z",
      }),
    );
    db.createSubmission(
      makeSubmission({
        id: "sub-3",
        state: "done",
        submitterId: "user-b",
        createdAt: "2026-10-02T00:00:00.000Z",
      }),
    );

    expect(db.listSubmissions().map((s) => s.id)).toEqual([
      "sub-2",
      "sub-3",
      "sub-1",
    ]);
    expect(
      db.listSubmissions({ state: "pending" }).map((s) => s.id),
    ).toEqual(["sub-2", "sub-1"]);
    expect(
      db.listSubmissions({ submitterId: "user-b" }).map((s) => s.id),
    ).toEqual(["sub-2", "sub-3"]);
  });

  it("applies updates and finds active submissions per drop", async () => {
    const db = await makeDb();
    db.createSubmission(makeSubmission());

    expect(db.findActiveSubmissionByDrop("drop-1")?.id).toBe("sub-1");
    expect(db.isDropProtected("drop-1")).toBe(true);

    const updated = db.updateSubmission("sub-1", {
      state: "importing",
      importMode: "move",
      jobIds: ["job-1"],
    });
    expect(updated).toMatchObject({
      state: "importing",
      importMode: "move",
      jobIds: ["job-1"],
    });

    db.updateSubmission("sub-1", {
      state: "done",
      completedAt: "2026-10-09T01:00:00.000Z",
    });
    expect(db.isDropProtected("drop-1")).toBe(false);
    expect(db.getSubmission("sub-1")?.completedAt).toBe(
      "2026-10-09T01:00:00.000Z",
    );

    db.createSubmission(
      makeSubmission({ id: "sub-2", dropId: "drop-2", state: "rejected" }),
    );
    expect(db.findActiveSubmissionByDrop("drop-2")).toBeUndefined();
  });

  it("grants drop access only when every live upload belongs to the user", async () => {
    const db = await makeDb();
    db.createUpload(makeUpload({ id: "u1", dropId: "owned" }));
    db.createUpload(makeUpload({ id: "u2", dropId: "owned" }));
    db.createUpload(makeUpload({ id: "u3", dropId: "shared" }));
    db.createUpload(makeUpload({ id: "u4", dropId: "shared", userId: "user-b" }));
    db.createUpload(makeUpload({ id: "u5", dropId: "legacy", userId: undefined }));
    db.createUpload(
      makeUpload({ id: "u6", dropId: "cancelled", state: "cancelled" }),
    );

    expect(db.dropOwnedBy("owned", "user-a")).toBe(true);
    expect(db.dropOwnedBy("owned", "user-b")).toBe(false);
    expect(db.dropOwnedBy("shared", "user-a")).toBe(false);
    expect(db.dropOwnedBy("legacy", "user-a")).toBe(false);
    expect(db.dropOwnedBy("cancelled", "user-a")).toBe(false);
    expect(db.dropOwnedBy("missing", "user-a")).toBe(false);
  });
});
