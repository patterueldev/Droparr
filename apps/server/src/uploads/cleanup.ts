import { readdir, rm, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Upload } from "@droparr/shared";
import type { Db } from "../db.js";
import type { UploadEventBus } from "./events.js";
import type { UploadLocks } from "./locks.js";
import { resolveDropDir, resolveUploadTarget } from "./paths.js";
import type { UploadSettings } from "./settings.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How often the scheduler sweeps the quarantine dir. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Delay before the first sweep after boot — startup stays fast. */
export const SWEEP_BOOT_DELAY_MS = 60 * 1000;

export interface SweepResult {
  /** When the sweep finished. */
  at: string;
  /** Retention applied; 0 means cleanup is disabled (nothing deleted). */
  retentionDays: number;
  /** ISO cutoff — uploads finished/updated at or before this were eligible. */
  cutoff: string;
  /** Abandoned in-progress uploads removed. */
  staleUploads: number;
  /** Finished drops removed whole. */
  sweptDrops: number;
  /** Drop directories with no DB rows left behind (e.g. crash artifacts). */
  orphanDirs: number;
  /** Bytes freed across rows whose files were removed. */
  freedBytes: number;
  /** Uploads skipped because a write was in flight. */
  skippedLocked: number;
  /** Per-item failures; one bad item never aborts the sweep. */
  errors: string[];
}

export interface SweepDeps {
  db: Db;
  events: UploadEventBus;
  locks: UploadLocks;
  getSettings: () => UploadSettings;
  /** Drops referenced by live submissions (M3.3+) are never swept. */
  isDropProtected?: (dropId: string) => boolean;
  /** Injectable clock for tests. */
  now?: () => Date;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

function isStrictlyInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c !== p && c.startsWith(p + sep);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Remove one upload: DB row first (mirrors the TUS DELETE route), then the
 * partial/finished file. Emits a `deleted` event for every connected client.
 */
export async function removeUpload(
  deps: Pick<SweepDeps, "db" | "events" | "getSettings">,
  upload: Upload,
): Promise<void> {
  const settings = deps.getSettings();
  deps.db.deleteUpload(upload.id);
  await rm(
    resolveUploadTarget(settings.quarantineDir, upload.dropId, upload.relPath),
    { force: true },
  );
  deps.events.emitUpload({
    action: "deleted",
    uploadId: upload.id,
    dropId: upload.dropId,
    userId: upload.userId,
    filename: upload.filename,
    relPath: upload.relPath,
    offset: upload.offset,
    size: upload.size,
  });
}

/**
 * Remove every upload of a drop plus its quarantine directory. Used by the
 * sweep and by the M3.3 reject flow. The drop path is asserted to be
 * strictly inside the quarantine dir before anything is deleted.
 */
export async function removeDrop(
  deps: Pick<SweepDeps, "db" | "events" | "getSettings">,
  dropId: string,
): Promise<number> {
  const settings = deps.getSettings();
  const dir = resolveDropDir(settings.quarantineDir, dropId);
  if (!isStrictlyInside(settings.quarantineDir, dir)) {
    throw new Error(`Drop directory escapes the quarantine dir: ${dir}`);
  }
  const uploads = deps.db.listUploads({ dropId });
  for (const upload of uploads) {
    deps.db.deleteUpload(upload.id);
    deps.events.emitUpload({
      action: "deleted",
      uploadId: upload.id,
      dropId: upload.dropId,
      userId: upload.userId,
      filename: upload.filename,
      relPath: upload.relPath,
      offset: upload.offset,
      size: upload.size,
    });
  }
  await rm(dir, { recursive: true, force: true });
  return uploads.length;
}

/**
 * One cleanup pass over the quarantine dir:
 *
 * 1. in-progress uploads whose last write is older than the retention window
 *    (abandoned browser sessions) are removed file-by-file;
 * 2. drops whose uploads all completed before the window are removed whole,
 *    unless a live submission protects them (`isDropProtected`);
 * 3. directories with no DB rows at all (crash between file create and row
 *    insert) older than the window are removed.
 *
 * `retentionDays: 0` disables automatic cleanup entirely.
 */
export async function sweepQuarantine(deps: SweepDeps): Promise<SweepResult> {
  const now = deps.now?.() ?? new Date();
  const settings = deps.getSettings();
  const result: SweepResult = {
    at: now.toISOString(),
    retentionDays: settings.retentionDays,
    cutoff: now.toISOString(),
    staleUploads: 0,
    sweptDrops: 0,
    orphanDirs: 0,
    freedBytes: 0,
    skippedLocked: 0,
    errors: [],
  };
  if (settings.retentionDays <= 0) return result;

  const cutoffMs = now.getTime() - settings.retentionDays * DAY_MS;
  result.cutoff = new Date(cutoffMs).toISOString();
  const uploads = deps.db.listUploads();

  // 1. Abandoned in-progress uploads.
  for (const upload of uploads) {
    if (upload.state !== "uploading") continue;
    if (Date.parse(upload.updatedAt) > cutoffMs) continue;
    if (deps.locks.isHeld(upload.id)) {
      result.skippedLocked++;
      continue;
    }
    try {
      await removeUpload(deps, upload);
      result.staleUploads++;
      result.freedBytes += upload.offset;
    } catch (err) {
      deps.log?.warn(
        { err, uploadId: upload.id },
        "cleanup failed for abandoned upload",
      );
      result.errors.push(`upload ${upload.id}: ${errorMessage(err)}`);
    }
  }

  // 2. Drops whose files all completed before the retention window.
  const byDrop = new Map<string, Upload[]>();
  for (const upload of uploads) {
    if (upload.state === "cancelled") continue;
    const group = byDrop.get(upload.dropId);
    if (group) group.push(upload);
    else byDrop.set(upload.dropId, [upload]);
  }
  for (const [dropId, group] of byDrop) {
    if (!group.every((u) => u.state === "complete")) continue;
    const finishedAt = Math.max(
      ...group.map((u) => Date.parse(u.completedAt ?? u.updatedAt)),
    );
    if (finishedAt > cutoffMs) continue;
    if (deps.isDropProtected?.(dropId)) continue;
    if (group.some((u) => deps.locks.isHeld(u.id))) {
      result.skippedLocked++;
      continue;
    }
    try {
      await removeDrop(deps, dropId);
      result.sweptDrops++;
      result.freedBytes += group.reduce((sum, u) => sum + u.size, 0);
    } catch (err) {
      deps.log?.warn({ err, dropId }, "cleanup failed for finished drop");
      result.errors.push(`drop ${dropId}: ${errorMessage(err)}`);
    }
  }

  // 3. Directories with no DB rows left (crash artifacts, manual meddling).
  try {
    const remainingDrops = new Set(deps.db.listUploads().map((u) => u.dropId));
    const entries = await readdir(settings.quarantineDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || remainingDrops.has(entry.name)) continue;
      const dir = resolveDropDir(settings.quarantineDir, entry.name);
      if (!isStrictlyInside(settings.quarantineDir, dir)) continue;
      try {
        const st = await stat(dir);
        if (st.mtimeMs > cutoffMs) continue;
        await rm(dir, { recursive: true, force: true });
        result.orphanDirs++;
      } catch (err) {
        deps.log?.warn({ err, dir }, "cleanup failed for orphan dir");
        result.errors.push(`orphan dir ${entry.name}: ${errorMessage(err)}`);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      result.errors.push(`scan quarantine dir: ${errorMessage(err)}`);
    }
  }

  return result;
}

export interface CleanupStatus {
  started: boolean;
  running: boolean;
  intervalMs: number;
  lastResult?: SweepResult;
}

/**
 * Schedules the sweep: once shortly after boot, then hourly. The timer is
 * unref'ed so it never keeps a process (or tests) alive.
 */
export class QuarantineCleanup {
  private bootTimer?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;
  private inFlight?: Promise<SweepResult>;
  private lastResult?: SweepResult;

  constructor(private readonly deps: SweepDeps) {}

  start(): void {
    if (this.interval) return;
    this.bootTimer = setTimeout(() => void this.runNow(), SWEEP_BOOT_DELAY_MS);
    this.bootTimer.unref();
    this.interval = setInterval(() => void this.runNow(), SWEEP_INTERVAL_MS);
    this.interval.unref();
  }

  stop(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.interval) clearInterval(this.interval);
    this.bootTimer = undefined;
    this.interval = undefined;
  }

  status(): CleanupStatus {
    return {
      started: this.interval !== undefined,
      running: this.inFlight !== undefined,
      intervalMs: SWEEP_INTERVAL_MS,
      lastResult: this.lastResult,
    };
  }

  /** Run a sweep now; overlapping callers share the in-flight pass. */
  runNow(): Promise<SweepResult> {
    if (this.inFlight) return this.inFlight;
    const run = sweepQuarantine(this.deps)
      .catch(
        (err): SweepResult => ({
          at: new Date().toISOString(),
          retentionDays: this.deps.getSettings().retentionDays,
          cutoff: "",
          staleUploads: 0,
          sweptDrops: 0,
          orphanDirs: 0,
          freedBytes: 0,
          skippedLocked: 0,
          errors: [errorMessage(err)],
        }),
      )
      .then((result) => {
        this.lastResult = result;
        this.inFlight = undefined;
        return result;
      });
    this.inFlight = run;
    return run;
  }
}
