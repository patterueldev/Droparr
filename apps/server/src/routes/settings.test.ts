import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.unstubAllGlobals();
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

describe("settings routes — notifications", () => {
  it("round-trips the webhook config and stays off until set", async () => {
    const h = await buildHarness();

    const initial = await h.app.inject({ url: "/api/settings" });
    expect(initial.json().notifications).toBeUndefined();

    const on = await h.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        notifications: {
          enabled: true,
          url: "https://ntfy.sh/droparr",
          format: "ntfy",
        },
      },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().notifications).toEqual({
      enabled: true,
      url: "https://ntfy.sh/droparr",
      format: "ntfy",
    });

    // Disabling keeps the URL so it can be flipped back on without retyping.
    const off = await h.app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        notifications: {
          enabled: false,
          url: "https://ntfy.sh/droparr",
          format: "ntfy",
        },
      },
    });
    expect(off.json().notifications.enabled).toBe(false);

    const reloaded = await h.app.inject({ url: "/api/settings" });
    expect(reloaded.json().notifications).toEqual({
      enabled: false,
      url: "https://ntfy.sh/droparr",
      format: "ntfy",
    });
  });

  it("rejects malformed webhook configs", async () => {
    const h = await buildHarness();
    for (const notifications of [
      { enabled: true, url: "not-a-url", format: "ntfy" },
      { enabled: true, url: "https://ntfy.sh/t", format: "telegram" },
      { enabled: true, url: "ftp://ntfy.sh/t", format: "ntfy" },
    ]) {
      const res = await h.app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { notifications },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("sends a test notification through the transport", async () => {
    const h = await buildHarness();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await h.app.inject({
      method: "POST",
      url: "/api/settings/notifications/test",
      payload: { url: "https://ntfy.sh/droparr", format: "ntfy" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, format: "ntfy" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://ntfy.sh/droparr");
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Title).toBe("Droparr test notification");
  });

  it("answers 502 with the transport error when the webhook fails", async () => {
    const h = await buildHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          new Response("bad token", { status: 401 }),
      ),
    );

    const res = await h.app.inject({
      method: "POST",
      url: "/api/settings/notifications/test",
      payload: { url: "https://discord.com/api/webhooks/1/x", format: "discord" },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("401");
    expect(body.error).toContain("bad token");
  });

  it("rejects invalid test drafts before hitting the network", async () => {
    const h = await buildHarness();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await h.app.inject({
      method: "POST",
      url: "/api/settings/notifications/test",
      payload: { url: "nope", format: "ntfy" },
    });

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
