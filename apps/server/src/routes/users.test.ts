import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import {
  requiresApproval,
  type AuthStatus,
  type User,
} from "@droparr/shared";
import { buildApp, type BuiltApp } from "../app.js";
import type { SessionRevokedEvent } from "../auth/events.js";

const JELLYFIN_URL = "http://jellyfin.local:8096";

const PUBLIC_INFO = { ServerName: "Jellyfin", Version: "10.10.3", Id: "srv-1" };

interface Cred {
  password: string;
  id: string;
  admin: boolean;
}

const DEFAULT_CREDS: Record<string, Cred> = {
  admin: { password: "hunter2", id: "jf-admin", admin: true },
  sister: { password: "swordfish", id: "jf-sister", admin: false },
  guest: { password: "guestpw", id: "jf-guest", admin: true },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** In-memory Jellyfin stub; re-stub to change the admin flag between logins. */
function stubJellyfin(creds: Record<string, Cred>): void {
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
  dir = await mkdtemp(join(tmpdir(), "droparr-users-"));
  built = await buildApp({
    dataDir: dir,
    configPath: join(dir, "config.json"),
    serveWeb: false,
    logger: false,
  });
  return built;
}

async function completeSetup(): Promise<void> {
  let res = await built!.app.inject({
    method: "POST",
    url: "/api/setup/jellyfin",
    payload: { baseUrl: JELLYFIN_URL },
  });
  expect(res.statusCode).toBe(200);
  const cookie = await login("admin", "hunter2");
  res = await built!.app.inject({
    method: "POST",
    url: "/api/setup/complete",
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
}

/** Log in with the stub credentials and return the session cookie. */
async function login(username: string, password: string): Promise<string> {
  const res = await loginRaw(username, password);
  expect(res.statusCode).toBe(200);
  return sessionCookie(res);
}

async function loginRaw(
  username: string,
  password: string,
): Promise<LightMyRequestResponse> {
  return built!.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
  });
}

function patch(
  cookie: string,
  id: string,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return built!.app.inject({
    method: "PATCH",
    url: `/api/users/${id}`,
    headers: { cookie },
    payload: body,
  });
}

function authStatus(cookie: string): Promise<LightMyRequestResponse> {
  return built!.app.inject({
    method: "GET",
    url: "/api/auth/status",
    headers: { cookie },
  });
}

function userByName(name: string): User {
  const user = built!.db.listUsers().find((u) => u.name === name);
  if (!user) throw new Error(`user ${name} not found`);
  return user;
}

afterEach(async () => {
  await built?.app.close();
  built = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
  vi.unstubAllGlobals();
});

describe("approval policy", () => {
  it("auto-approves admins, and submitters only when trusted", () => {
    expect(requiresApproval({ role: "admin", trusted: false })).toBe(false);
    expect(requiresApproval({ role: "admin", trusted: true })).toBe(false);
    expect(requiresApproval({ role: "submitter", trusted: true })).toBe(false);
    expect(requiresApproval({ role: "submitter", trusted: false })).toBe(true);
  });
});

describe("user management API", () => {
  it("lists users for admins and hides management from submitters", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();
    const admin = await login("admin", "hunter2");
    await login("sister", "swordfish");

    const list = await built!.app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: admin },
    });
    expect(list.statusCode).toBe(200);
    const users = list.json<User[]>();
    expect(users.map((u) => u.name).sort()).toEqual(["admin", "sister"]);
    expect(
      users.every((u) => u.role && typeof u.trusted === "boolean"),
    ).toBe(true);

    const sister = await login("sister", "swordfish");
    const denied = await built!.app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: sister },
    });
    expect(denied.statusCode).toBe(403);
    expect((await patch(sister, "whoever", { trusted: true })).statusCode).toBe(
      403,
    );
  });

  it("refuses submitters on config and management endpoints", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();
    const sister = await login("sister", "swordfish");

    const endpoints: { method: string; url: string }[] = [
      { method: "GET", url: "/api/settings" },
      { method: "PUT", url: "/api/settings" },
      { method: "GET", url: "/api/settings/disk" },
      { method: "GET", url: "/api/settings/export" },
      { method: "GET", url: "/api/instances" },
      { method: "POST", url: "/api/instances/test" },
      { method: "GET", url: "/api/categories" },
      { method: "GET", url: "/api/fs/list" },
      { method: "POST", url: "/api/analyze" },
      { method: "POST", url: "/api/import" },
      { method: "GET", url: "/api/history" },
      { method: "GET", url: "/api/users" },
      { method: "PATCH", url: "/api/users/some-user" },
    ];
    for (const endpoint of endpoints) {
      const res = await built!.app.inject({
        method: endpoint.method as "GET",
        url: endpoint.url,
        headers: { cookie: sister },
      });
      expect(res.statusCode, `${endpoint.method} ${endpoint.url}`).toBe(403);
    }
  });

  it("applies promote/demote immediately to live sessions", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();
    const admin = await login("admin", "hunter2");
    const sister = await login("sister", "swordfish");
    const sisterId = userByName("sister").id;

    const before = await built!.app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: sister },
    });
    expect(before.statusCode).toBe(403);

    const promoted = await patch(admin, sisterId, { role: "admin" });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json<User>().role).toBe("admin");

    const during = await built!.app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: sister },
    });
    expect(during.statusCode).toBe(200);

    const demoted = await patch(admin, sisterId, { role: "submitter" });
    expect(demoted.statusCode).toBe(200);
    expect(demoted.json<User>().role).toBe("submitter");

    const after = await built!.app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: sister },
    });
    expect(after.statusCode).toBe(403);
  });

  it("toggles trust and flips the approval decision", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();
    const admin = await login("admin", "hunter2");
    const sister = await login("sister", "swordfish");
    const sisterId = userByName("sister").id;

    const before = (await authStatus(sister)).json<AuthStatus>().user!;
    expect(before.trusted).toBe(false);
    expect(requiresApproval(before)).toBe(true);

    const trusted = await patch(admin, sisterId, { trusted: true });
    expect(trusted.statusCode).toBe(200);
    expect(trusted.json<User>().trusted).toBe(true);

    const after = (await authStatus(sister)).json<AuthStatus>().user!;
    expect(after.trusted).toBe(true);
    expect(requiresApproval(after)).toBe(false);

    const relocked = await patch(admin, sisterId, { trusted: false });
    expect(relocked.json<User>().trusted).toBe(false);
    expect(
      requiresApproval((await authStatus(sister)).json<AuthStatus>().user!),
    ).toBe(true);

    // Admins auto-approve their own drops regardless of the trust flag.
    expect(
      requiresApproval((await authStatus(admin)).json<AuthStatus>().user!),
    ).toBe(false);
  });

  it("blocks a user: sessions die, sockets are revoked, login is refused", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();
    const admin = await login("admin", "hunter2");
    const first = await login("sister", "swordfish");
    const second = await login("sister", "swordfish");
    const sister = userByName("sister");

    const revoked: SessionRevokedEvent[] = [];
    built!.authEvents.on("session-revoked", (event: SessionRevokedEvent) => {
      revoked.push(event);
    });

    const blocked = await patch(admin, sister.id, { blocked: true });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json<User>().blocked).toBe(true);

    expect(revoked).toHaveLength(2);
    expect(revoked.every((e) => e.userId === sister.id)).toBe(true);

    for (const cookie of [first, second]) {
      const status = await authStatus(cookie);
      expect(status.statusCode).toBe(200);
      expect(status.json<AuthStatus>().authenticated).toBe(false);
      const guarded = await built!.app.inject({
        method: "GET",
        url: "/api/auth/sessions",
        headers: { cookie },
      });
      expect(guarded.statusCode).toBe(401);
    }

    const refused = await loginRaw("sister", "swordfish");
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: string }>().error).toContain("disabled");

    const unblocked = await patch(admin, sister.id, { blocked: false });
    expect(unblocked.json<User>().blocked).toBe(false);
    await login("sister", "swordfish");
  });

  it("refuses self-block and self-demote", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();
    const admin = await login("admin", "hunter2");
    const adminUser = userByName("admin");

    const selfBlock = await patch(admin, adminUser.id, { blocked: true });
    expect(selfBlock.statusCode).toBe(400);
    const selfDemote = await patch(admin, adminUser.id, {
      role: "submitter",
    });
    expect(selfDemote.statusCode).toBe(400);
    expect(userByName("admin").role).toBe("admin");
  });

  it("protects the last active admin and rejects unknown users", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();
    const cookie = await login("admin", "hunter2");
    const admin = userByName("admin");

    const missing = await patch(cookie, "no-such-user", { trusted: true });
    expect(missing.statusCode).toBe(404);

    expect(built!.db.updateUser(admin.id, { role: "submitter" })).toEqual({
      ok: false,
      error: "last-admin",
    });
    expect(built!.db.updateUser(admin.id, { blocked: true })).toEqual({
      ok: false,
      error: "last-admin",
    });
    expect(built!.db.countActiveAdmins()).toBe(1);

    // A second admin frees the first one up.
    built!.db.upsertUser({
      jellyfinUserId: "jf-second",
      name: "second",
      role: "admin",
    });
    expect(built!.db.countActiveAdmins()).toBe(2);
    expect(built!.db.updateUser(admin.id, { role: "submitter" })).toMatchObject({
      ok: true,
    });
  });
});

describe("role sync with Jellyfin", () => {
  it("re-syncs the role while there is no local override", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();

    await login("guest", "guestpw");
    expect(userByName("guest").role).toBe("admin");

    stubJellyfin({
      ...DEFAULT_CREDS,
      guest: { ...DEFAULT_CREDS.guest!, admin: false },
    });
    await login("guest", "guestpw");
    expect(userByName("guest").role).toBe("submitter");
  });

  it("keeps a locally set role across later logins", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();
    const admin = await login("admin", "hunter2");

    await login("guest", "guestpw");
    const guestId = userByName("guest").id;

    // Demote a Jellyfin admin locally: the override survives their next login.
    expect(
      (await patch(admin, guestId, { role: "submitter" })).statusCode,
    ).toBe(200);
    await login("guest", "guestpw"); // Jellyfin still says admin
    expect(userByName("guest").role).toBe("submitter");

    // Promote a Jellyfin non-admin locally: the override survives too.
    await login("sister", "swordfish");
    const sisterId = userByName("sister").id;
    expect((await patch(admin, sisterId, { role: "admin" })).statusCode).toBe(
      200,
    );
    await login("sister", "swordfish"); // Jellyfin still says non-admin
    expect(userByName("sister").role).toBe("admin");
  });

  it("never demotes the last active admin through a login sync", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();

    stubJellyfin({
      ...DEFAULT_CREDS,
      admin: { ...DEFAULT_CREDS.admin!, admin: false },
    });
    await login("admin", "hunter2");
    expect(userByName("admin").role).toBe("admin");
  });
});
