import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Db } from "./db.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

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
});
