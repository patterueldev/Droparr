import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import type { AuthStatus, SetupStatus, User } from "@droparr/shared";
import { buildApp, type BuiltApp } from "../app.js";
import { ConfigStore } from "../config/store.js";
import { Db } from "../db.js";

const JELLYFIN_URL = "http://jellyfin.local:8096";

const PUBLIC_INFO = { ServerName: "Jellyfin", Version: "10.10.3", Id: "srv-1" };

const DEFAULT_CREDS: Record<
  string,
  { password: string; id: string; admin: boolean }
> = {
  admin: { password: "hunter2", id: "jf-admin", admin: true },
  sister: { password: "swordfish", id: "jf-sister", admin: false },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** In-memory Jellyfin stub: public info, auth and token revocation. */
function stubJellyfin(
  creds: Record<string, { password: string; id: string; admin: boolean }>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/System/Info/Public")) return json(PUBLIC_INFO);
      if (url.endsWith("/Users/AuthenticateByName")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          Username?: string;
          Pw?: string;
        };
        const cred = body.Username ? creds[body.Username] : undefined;
        if (!cred || cred.password !== body.Pw) return json({}, 401);
        return json({
          User: {
            Id: cred.id,
            Name: body.Username,
            Policy: { IsAdministrator: cred.admin },
          },
          AccessToken: "jellyfin-access-token",
          ServerId: "srv-1",
        });
      }
      if (url.endsWith("/Sessions/Logout")) {
        return new Response(null, { status: 204 });
      }
      return json({}, 404);
    }),
  );
}

function sessionCookie(res: LightMyRequestResponse): string {
  const raw = res.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const setCookie = values.find((v) => v.startsWith("droparr_session="));
  if (!setCookie) throw new Error("no session cookie in response");
  return setCookie.split(";")[0]!;
}

let built: BuiltApp | undefined;
let dir: string | undefined;

async function makeApp(): Promise<BuiltApp> {
  dir = await mkdtemp(join(tmpdir(), "droparr-setup-"));
  built = await buildApp({
    dataDir: dir,
    configPath: join(dir, "config.json"),
    serveWeb: false,
    logger: false,
  });
  return built;
}

function login(
  username: string,
  password: string,
): Promise<LightMyRequestResponse> {
  return built!.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
}

async function configureUrl(): Promise<void> {
  const res = await built!.app.inject({
    method: "POST",
    url: "/api/setup/jellyfin",
    payload: { baseUrl: JELLYFIN_URL },
  });
  expect(res.statusCode).toBe(200);
}

/** Run the whole wizard; returns the claiming admin's session cookie. */
async function completeSetup(): Promise<string> {
  await configureUrl();
  const loggedIn = await login("admin", "hunter2");
  expect(loggedIn.statusCode).toBe(200);
  const cookie = sessionCookie(loggedIn);
  const done = await built!.app.inject({
    method: "POST",
    url: "/api/setup/complete",
    headers: { cookie },
  });
  expect(done.statusCode).toBe(200);
  return cookie;
}

afterEach(async () => {
  await built?.app.close();
  built = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
  vi.unstubAllGlobals();
});

describe("first-run setup wizard", () => {
  it("blocks every API route except health/auth/setup while setup is incomplete", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);

    const status = await built!.app.inject({
      method: "GET",
      url: "/api/auth/status",
    });
    expect(status.json<AuthStatus>()).toMatchObject({
      setupRequired: true,
      authenticated: false,
    });

    const health = await built!.app.inject({
      method: "GET",
      url: "/api/health",
    });
    expect(health.statusCode).toBe(200);

    for (const url of [
      "/api/settings",
      "/api/instances",
      "/api/categories",
      "/api/history",
      "/api/fs/list",
    ]) {
      const res = await built!.app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "setup_required" });
    }

    const setupStatus = await built!.app.inject({
      method: "GET",
      url: "/api/setup/status",
    });
    expect(setupStatus.statusCode).toBe(200);
    expect(setupStatus.json<SetupStatus>()).toMatchObject({
      setupRequired: true,
      jellyfinConfigured: false,
      authenticated: false,
    });
  });

  it("validates the Jellyfin URL and saves it", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);

    let res = await built!.app.inject({
      method: "POST",
      url: "/api/setup/jellyfin/test",
      payload: { baseUrl: "file:///etc/passwd" },
    });
    expect(res.statusCode).toBe(400);

    res = await built!.app.inject({
      method: "POST",
      url: "/api/setup/jellyfin/test",
      payload: { baseUrl: JELLYFIN_URL },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, serverName: "Jellyfin" });

    // Trailing slashes are normalized before saving.
    res = await built!.app.inject({
      method: "POST",
      url: "/api/setup/jellyfin",
      payload: { baseUrl: `${JELLYFIN_URL}/` },
    });
    expect(res.statusCode).toBe(200);
    expect(built!.config.get().jellyfin?.baseUrl).toBe(JELLYFIN_URL);

    const setupStatus = await built!.app.inject({
      method: "GET",
      url: "/api/setup/status",
    });
    expect(setupStatus.json<SetupStatus>()).toMatchObject({
      jellyfinConfigured: true,
      jellyfinBaseUrl: JELLYFIN_URL,
    });
  });

  it("does not let a non-admin Jellyfin user complete the wizard", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await configureUrl();

    const sister = await login("sister", "swordfish");
    expect(sister.statusCode).toBe(200);
    expect(sister.json<{ user: User }>().user.role).toBe("submitter");

    const finish = await built!.app.inject({
      method: "POST",
      url: "/api/setup/complete",
      headers: { cookie: sessionCookie(sister) },
    });
    expect(finish.statusCode).toBe(403);
    expect(finish.json<{ error: string }>().error).toContain(
      "not a Jellyfin administrator",
    );

    expect(built!.db.isSetupComplete()).toBe(false);
    const status = await built!.app.inject({
      method: "GET",
      url: "/api/auth/status",
    });
    expect(status.json<AuthStatus>()).toMatchObject({ setupRequired: true });
  });

  it("requires a session to complete setup", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await configureUrl();

    const res = await built!.app.inject({
      method: "POST",
      url: "/api/setup/complete",
    });
    expect(res.statusCode).toBe(401);
  });

  it("completes setup with a Jellyfin admin, locks the wizard and unlocks the app", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);

    const adminCookie = await completeSetup();

    const state = built!.db.getSetupState();
    expect(state?.completedAt).toBeTruthy();
    expect(state?.adminUserId).toBeDefined();

    // Wizard is locked: every setup route refuses, even with admin creds.
    const lockedStatus = await built!.app.inject({
      method: "GET",
      url: "/api/setup/status",
    });
    expect(lockedStatus.statusCode).toBe(403);
    for (const call of [
      {
        method: "POST" as const,
        url: "/api/setup/jellyfin/test",
        payload: { baseUrl: JELLYFIN_URL },
      },
      {
        method: "POST" as const,
        url: "/api/setup/jellyfin",
        payload: { baseUrl: "http://attacker.local:8096" },
      },
      { method: "POST" as const, url: "/api/setup/complete" },
    ]) {
      const res = await built!.app.inject({
        ...call,
        headers: { cookie: adminCookie },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(built!.config.get().jellyfin?.baseUrl).toBe(JELLYFIN_URL);

    // The app is unlocked for the claiming admin.
    const settings = await built!.app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: adminCookie },
    });
    expect(settings.statusCode).toBe(200);

    const status = await built!.app.inject({
      method: "GET",
      url: "/api/auth/status",
    });
    expect(status.json<AuthStatus>()).toMatchObject({ setupRequired: false });
  });

  it("stays locked when the config file is deleted after setup", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    const adminCookie = await completeSetup();
    await built!.app.close();

    await rm(join(dir!, "config.json"), { force: true });
    built = await buildApp({
      dataDir: dir!,
      configPath: join(dir!, "config.json"),
      serveWeb: false,
      logger: false,
    });

    const status = await built.app.inject({
      method: "GET",
      url: "/api/auth/status",
    });
    expect(status.json<AuthStatus>()).toMatchObject({ setupRequired: false });

    // The admin's session survives (SQLite), so the Jellyfin URL can be
    // restored through Settings — no wizard re-entry.
    const settings = await built.app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: adminCookie },
    });
    expect(settings.statusCode).toBe(200);

    const restore = await built.app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { cookie: adminCookie },
      payload: { jellyfin: { baseUrl: JELLYFIN_URL } },
    });
    expect(restore.statusCode).toBe(200);
    expect(built.config.get().jellyfin?.baseUrl).toBe(JELLYFIN_URL);
  });

  it("backfills the setup lock for installs that predate the wizard", async () => {
    dir = await mkdtemp(join(tmpdir(), "droparr-setup-"));
    const configPath = join(dir, "config.json");

    // Simulate an M2.1 install: an admin exists and Jellyfin is configured,
    // but the setup table has never been written.
    const db = new Db(join(dir, "droparr.db"));
    db.upsertUser({ jellyfinUserId: "jf-admin", name: "admin", role: "admin" });
    const store = await ConfigStore.load(configPath);
    await store.updateSettings({ jellyfin: { baseUrl: JELLYFIN_URL } });

    built = await buildApp({
      dataDir: dir,
      configPath,
      serveWeb: false,
      logger: false,
    });
    expect(built.db.isSetupComplete()).toBe(true);

    const status = await built.app.inject({
      method: "GET",
      url: "/api/auth/status",
    });
    expect(status.json<AuthStatus>()).toMatchObject({ setupRequired: false });

    // The wizard stays locked for the upgraded install.
    const setupStatus = await built.app.inject({
      method: "GET",
      url: "/api/setup/status",
    });
    expect(setupStatus.statusCode).toBe(403);
  });
});
