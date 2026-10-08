import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../config/store.js";
import { Db } from "../db.js";
import { QuarantineCleanup } from "../uploads/cleanup.js";
import { UploadEventBus } from "../uploads/events.js";
import { UploadLocks } from "../uploads/locks.js";
import { resolveUploadSettings } from "../uploads/settings.js";
import { settingsRoutes } from "./settings.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function buildHarness(): Promise<{
  tmp: string;
  config: ConfigStore;
  app: FastifyInstance;
}> {
  const tmp = await mkdtemp(join(tmpdir(), "droparr-settings-"));
  const config = await ConfigStore.load(join(tmp, "config.json"));
  const db = new Db(join(tmp, "droparr.db"));
  const cleanup = new QuarantineCleanup({
    db,
    events: new UploadEventBus(),
    locks: new UploadLocks(),
    getSettings: () => resolveUploadSettings(config.get(), tmp),
  });
  const app = Fastify();
  settingsRoutes(app, config, tmp, { cleanup });
  cleanups.push(async () => {
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  });
  return { tmp, config, app };
}

describe("settings routes — uploads policy", () => {
  it("resolves guard and retention defaults, then round-trips overrides", async () => {
    const h = await buildHarness();

    const initial = await h.app.inject({ url: "/api/settings" });
    expect(initial.json().uploads).toMatchObject({
      quarantineDir: join(h.tmp, "quarantine"),
      minFreeSpaceBytes: 10 * 1024 ** 3,
      retentionDays: 7,
    });

    const put = await h.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        uploads: { minFreeSpaceBytes: 1024, retentionDays: 3, maxFileSizeBytes: 0 },
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().uploads).toMatchObject({
      minFreeSpaceBytes: 1024,
      retentionDays: 3,
      maxFileSizeBytes: 0,
    });

    const reloaded = await h.app.inject({ url: "/api/settings" });
    expect(reloaded.json().uploads.retentionDays).toBe(3);
  });

  it("rejects negative guard settings", async () => {
    const h = await buildHarness();
    const res = await h.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { uploads: { retentionDays: -1 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("reports disk status for the quarantine volume", async () => {
    const h = await buildHarness();
    const put = await h.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { uploads: { minFreeSpaceBytes: 0 } },
    });
    expect(put.statusCode).toBe(200);

    const res = await h.app.inject({ url: "/api/settings/disk" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      quarantineDir: string;
      freeBytes: number;
      totalBytes: number;
      belowThreshold: boolean;
    };
    expect(body.quarantineDir).toBe(join(h.tmp, "quarantine"));
    expect(body.freeBytes).toBeGreaterThan(0);
    expect(body.totalBytes).toBeGreaterThanOrEqual(body.freeBytes);
    expect(body.belowThreshold).toBe(false);
  });

  it("exposes cleanup status and runs a sweep on demand", async () => {
    const h = await buildHarness();

    const status = await h.app.inject({ url: "/api/settings/cleanup" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      retentionDays: 7,
      started: false,
      running: false,
    });

    const run = await h.app.inject({
      method: "POST",
      url: "/api/settings/cleanup/run",
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({
      retentionDays: 7,
      staleUploads: 0,
      sweptDrops: 0,
    });
    expect(run.json().at).toBeTruthy();
  });
});
