import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extname, type Upload, type UploadEvent } from "@droparr/shared";
import { Db } from "../db.js";
import { QuarantineCleanup, removeDrop, sweepQuarantine } from "./cleanup.js";
import { UploadEventBus } from "./events.js";
import { UploadLocks } from "./locks.js";
import type { UploadSettings } from "./settings.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-09T12:00:00.000Z");

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

interface Harness {
  tmp: string;
  quarantineDir: string;
  db: Db;
  locks: UploadLocks;
  received: UploadEvent[];
  settings: UploadSettings;
  deps: Parameters<typeof sweepQuarantine>[0];
}

async function buildHarness(
  opts: { retentionDays?: number } = {},
): Promise<Harness> {
  const tmp = await mkdtemp(join(tmpdir(), "droparr-cleanup-"));
  const quarantineDir = join(tmp, "quarantine");
  const db = new Db(join(tmp, "droparr.db"));
  const events = new UploadEventBus();
  const received: UploadEvent[] = [];
  events.on("event", (e: UploadEvent) => received.push(e));
  const locks = new UploadLocks();
  const settings: UploadSettings = {
    quarantineDir,
    maxFileSizeBytes: 0,
    maxSubmissionSizeBytes: 0,
    minFreeSpaceBytes: 0,
    retentionDays: opts.retentionDays ?? 7,
  };
  cleanups.push(() => rm(tmp, { recursive: true, force: true }));
  return {
    tmp,
    quarantineDir,
    db,
    locks,
    received,
    settings,
    deps: {
      db,
      events,
      locks,
      getSettings: () => settings,
      now: () => NOW,
    },
  };
}

/** Seed a DB row + a real file in the quarantine dir. */
async function seedUpload(
  h: Harness,
  input: {
    id: string;
    dropId: string;
    relPath: string;
    size: number;
    state: Upload["state"];
    ageMs: number;
    offset?: number;
  },
): Promise<string> {
  const target = join(h.quarantineDir, input.dropId, ...input.relPath.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, Buffer.alloc(input.offset ?? 0, 7));
  const at = new Date(NOW.getTime() - input.ageMs).toISOString();
  h.db.createUpload({
    id: input.id,
    dropId: input.dropId,
    filename: basename(input.relPath),
    relPath: input.relPath,
    ext: extname(input.relPath),
    size: input.size,
    offset: input.offset ?? (input.state === "complete" ? input.size : 0),
    state: input.state,
    createdAt: at,
    updatedAt: at,
    completedAt: input.state === "complete" ? at : undefined,
  });
  return target;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("sweepQuarantine", () => {
  it("removes abandoned in-progress uploads at or past the retention boundary", async () => {
    const h = await buildHarness();
    const stale = await seedUpload(h, {
      id: "stale",
      dropId: "staledrop",
      relPath: "a.mkv",
      size: 1000,
      state: "uploading",
      ageMs: 7 * DAY_MS, // exactly at the cutoff — eligible
      offset: 400,
    });
    const fresh = await seedUpload(h, {
      id: "fresh",
      dropId: "freshdrop",
      relPath: "b.mkv",
      size: 1000,
      state: "uploading",
      ageMs: DAY_MS,
      offset: 200,
    });

    const result = await sweepQuarantine(h.deps);

    expect(result.staleUploads).toBe(1);
    expect(result.freedBytes).toBe(400);
    expect(result.errors).toEqual([]);
    expect(h.db.getUpload("stale")).toBeUndefined();
    expect(await exists(stale)).toBe(false);
    expect(h.db.getUpload("fresh")).toBeDefined();
    expect(await exists(fresh)).toBe(true);
    expect(
      h.received.some((e) => e.action === "deleted" && e.uploadId === "stale"),
    ).toBe(true);
  });

  it("skips uploads that are being written to right now", async () => {
    const h = await buildHarness();
    const target = await seedUpload(h, {
      id: "locked",
      dropId: "lockdrop",
      relPath: "a.mkv",
      size: 1000,
      state: "uploading",
      ageMs: 8 * DAY_MS,
    });
    h.locks.acquire("locked");

    const result = await sweepQuarantine(h.deps);
    expect(result.staleUploads).toBe(0);
    expect(result.skippedLocked).toBe(1);
    expect(h.db.getUpload("locked")).toBeDefined();
    expect(await exists(target)).toBe(true);
  });

  it("tolerates rows whose file already disappeared", async () => {
    const h = await buildHarness();
    const target = await seedUpload(h, {
      id: "ghost",
      dropId: "ghostdrop",
      relPath: "a.mkv",
      size: 100,
      state: "uploading",
      ageMs: 8 * DAY_MS,
    });
    await rm(target, { force: true });

    const result = await sweepQuarantine(h.deps);
    expect(result.staleUploads).toBe(1);
    expect(result.errors).toEqual([]);
    expect(h.db.getUpload("ghost")).toBeUndefined();
  });

  it("removes finished drops past the window and keeps recent or unfinished ones", async () => {
    const h = await buildHarness();
    const oldA = await seedUpload(h, {
      id: "a1",
      dropId: "olddrop",
      relPath: "Movie/a.mkv",
      size: 500,
      state: "complete",
      ageMs: 8 * DAY_MS,
    });
    await seedUpload(h, {
      id: "a2",
      dropId: "olddrop",
      relPath: "Movie/b.srt",
      size: 50,
      state: "complete",
      ageMs: 8 * DAY_MS,
    });
    const recent = await seedUpload(h, {
      id: "b1",
      dropId: "recentdrop",
      relPath: "b.mkv",
      size: 500,
      state: "complete",
      ageMs: DAY_MS,
    });
    // Mixed drop: one old complete file + one fresh in-progress file. The
    // drop is not finished, so nothing in it may be removed.
    const mixedOld = await seedUpload(h, {
      id: "c1",
      dropId: "mixeddrop",
      relPath: "c.mkv",
      size: 500,
      state: "complete",
      ageMs: 8 * DAY_MS,
    });
    const mixedFresh = await seedUpload(h, {
      id: "c2",
      dropId: "mixeddrop",
      relPath: "d.mkv",
      size: 500,
      state: "uploading",
      ageMs: 0,
    });

    const result = await sweepQuarantine(h.deps);

    expect(result.sweptDrops).toBe(1);
    expect(result.freedBytes).toBe(550);
    expect(result.staleUploads).toBe(0);
    expect(await exists(join(h.quarantineDir, "olddrop"))).toBe(false);
    expect(h.db.getUpload("a1")).toBeUndefined();
    expect(h.db.getUpload("a2")).toBeUndefined();
    expect(await exists(oldA)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(mixedOld)).toBe(true);
    expect(await exists(mixedFresh)).toBe(true);
    expect(
      h.received
        .filter((e) => e.action === "deleted")
        .map((e) => e.uploadId)
        .sort(),
    ).toEqual(["a1", "a2"]);
  });

  it("never sweeps drops protected by a live submission", async () => {
    const h = await buildHarness();
    const kept = await seedUpload(h, {
      id: "p1",
      dropId: "pendingdrop",
      relPath: "a.mkv",
      size: 500,
      state: "complete",
      ageMs: 8 * DAY_MS,
    });
    h.deps.isDropProtected = (dropId) => dropId === "pendingdrop";

    const result = await sweepQuarantine(h.deps);
    expect(result.sweptDrops).toBe(0);
    expect(h.db.getUpload("p1")).toBeDefined();
    expect(await exists(kept)).toBe(true);
  });

  it("removes orphan directories with no DB rows, keeps recent ones", async () => {
    const h = await buildHarness();
    const oldDir = join(h.quarantineDir, "orphan-old");
    await mkdir(oldDir, { recursive: true });
    await writeFile(join(oldDir, "leftover.mkv"), Buffer.alloc(10));
    const old = new Date(NOW.getTime() - 8 * DAY_MS);
    await utimes(oldDir, old, old);

    const freshDir = join(h.quarantineDir, "orphan-new");
    await mkdir(freshDir, { recursive: true });
    await writeFile(join(freshDir, "leftover.mkv"), Buffer.alloc(10));

    const result = await sweepQuarantine(h.deps);
    expect(result.orphanDirs).toBe(1);
    expect(await exists(oldDir)).toBe(false);
    expect(await exists(freshDir)).toBe(true);
  });

  it("does nothing when retention is disabled (0)", async () => {
    const h = await buildHarness({ retentionDays: 0 });
    const target = await seedUpload(h, {
      id: "keep",
      dropId: "keepdrop",
      relPath: "a.mkv",
      size: 500,
      state: "uploading",
      ageMs: 365 * DAY_MS,
    });

    const result = await sweepQuarantine(h.deps);
    expect(result.staleUploads).toBe(0);
    expect(result.sweptDrops).toBe(0);
    expect(result.retentionDays).toBe(0);
    expect(h.db.getUpload("keep")).toBeDefined();
    expect(await exists(target)).toBe(true);
  });
});

describe("removeDrop", () => {
  it("removes every row and the directory of a drop", async () => {
    const h = await buildHarness();
    await seedUpload(h, {
      id: "d1",
      dropId: "victim",
      relPath: "a.mkv",
      size: 10,
      state: "complete",
      ageMs: 0,
    });
    await seedUpload(h, {
      id: "d2",
      dropId: "victim",
      relPath: "b.srt",
      size: 10,
      state: "uploading",
      ageMs: 0,
    });

    const removed = await removeDrop(h.deps, "victim");
    expect(removed).toBe(2);
    expect(h.db.listUploads({ dropId: "victim" })).toHaveLength(0);
    expect(await exists(join(h.quarantineDir, "victim"))).toBe(false);
  });
});

describe("QuarantineCleanup", () => {
  it("shares concurrent runs and records the last result", async () => {
    const h = await buildHarness();
    const cleanup = new QuarantineCleanup(h.deps);

    expect(cleanup.status().started).toBe(false);
    const [first, second] = await Promise.all([
      cleanup.runNow(),
      cleanup.runNow(),
    ]);
    expect(first).toBe(second);
    expect(
      cleanup.status().lastResult?.at,
    ).toBe(first.at);
    expect(cleanup.status().running).toBe(false);

    // Timers only start explicitly; tests don't leak handles.
    cleanup.start();
    expect(cleanup.status().started).toBe(true);
    cleanup.stop();
    expect(cleanup.status().started).toBe(false);
  });
});
