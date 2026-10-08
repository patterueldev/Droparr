import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import type { AuthSession, AuthStatus, User } from "@droparr/shared";
import { buildApp, type BuiltApp } from "../app.js";

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
) {
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
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
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setCookieHeader(res: LightMyRequestResponse): string | undefined {
  const raw = res.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return values.find((v) => v.startsWith("droparr_session="));
}

function sessionCookie(res: LightMyRequestResponse): string {
  const setCookie = setCookieHeader(res);
  if (!setCookie) throw new Error("no session cookie in response");
  return setCookie.split(";")[0]!;
}

let built: BuiltApp | undefined;
let dir: string | undefined;

async function makeApp(): Promise<BuiltApp> {
  dir = await mkdtemp(join(tmpdir(), "droparr-auth-"));
  built = await buildApp({
    dataDir: dir,
    configPath: join(dir, "config.json"),
    serveWeb: false,
    logger: false,
  });
  return built;
}

async function makeAppWithCapturedLogs(lines: string[]): Promise<BuiltApp> {
  dir = await mkdtemp(join(tmpdir(), "droparr-auth-"));
  built = await buildApp({
    dataDir: dir,
    configPath: join(dir, "config.json"),
    serveWeb: false,
    logger: {
      level: "info",
      stream: {
        write: (line: string) => {
          lines.push(String(line));
        },
      },
    },
  });
  return built;
}

/** Run the first-run wizard (#6) so login/roles run against a live install. */
async function completeSetup(): Promise<void> {
  let res = await built!.app.inject({
    method: "POST",
    url: "/api/setup/jellyfin",
    payload: { baseUrl: JELLYFIN_URL },
  });
  expect(res.statusCode).toBe(200);
  res = await login("admin", "hunter2");
  expect(res.statusCode).toBe(200);
  const cookie = sessionCookie(res);
  res = await built!.app.inject({
    method: "POST",
    url: "/api/setup/complete",
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  // Drop the wizard's session so tests start with a clean session list.
  res = await built!.app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { cookie },
  });
  expect(res.statusCode).toBe(204);
}

function login(
  username: string,
  password: string,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return built!.app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password },
    headers,
  });
}

afterEach(async () => {
  await built?.app.close();
  built = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
  vi.unstubAllGlobals();
});

describe("auth bootstrap", () => {
  it("reports setupRequired until the first-run wizard completes", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);

    let res = await built!.app.inject({ method: "GET", url: "/api/auth/status" });
    expect(res.json<AuthStatus>()).toMatchObject({
      setupRequired: true,
      authenticated: false,
    });

    await completeSetup();

    res = await built!.app.inject({ method: "GET", url: "/api/auth/status" });
    expect(res.json<AuthStatus>()).toMatchObject({ setupRequired: false });
  });

  it("refuses login while Jellyfin is not configured", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    const res = await login("admin", "hunter2");
    expect(res.statusCode).toBe(503);
  });
});

describe("login", () => {
  it("sets an HttpOnly, SameSite=Lax session cookie on valid credentials", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();

    const res = await login("admin", "hunter2");
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: User }>().user).toMatchObject({
      name: "admin",
      role: "admin",
    });

    const setCookie = setCookieHeader(res)!;
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Secure"); // plain http (LAN) today

    const cookie = sessionCookie(res);
    const settings = await built!.app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie },
    });
    expect(settings.statusCode).toBe(200);

    const status = await built!.app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { cookie },
    });
    expect(status.json<AuthStatus>()).toMatchObject({
      setupRequired: false,
      authenticated: true,
      user: { name: "admin", role: "admin" },
    });
  });

  it("marks the cookie Secure over HTTPS (Cloudflare Tunnel path)", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();

    const res = await login("admin", "hunter2", {
      "x-forwarded-proto": "https",
    });
    expect(res.statusCode).toBe(200);
    expect(setCookieHeader(res)!).toContain("Secure");
  });

  it("rejects wrong credentials and unknown users with the same generic 401", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();

    const wrong = await login("admin", "nope");
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json<{ error: string }>().error).toBe(
      "Invalid username or password.",
    );
    expect(setCookieHeader(wrong)).toBeUndefined();

    const unknown = await login("ghost", "whatever");
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json<{ error: string }>().error).toBe(
      "Invalid username or password.",
    );
  });

  it("locks a username after repeated failures without ever reaching Jellyfin", async () => {
    await makeApp();
    const fetchMock = stubJellyfin(DEFAULT_CREDS);
    await completeSetup();

    for (let i = 0; i < 5; i++) {
      const res = await login("admin", "wrong-password");
      expect(res.statusCode).toBe(401);
    }

    const authCalls = () =>
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/Users/AuthenticateByName"),
      ).length;
    const callsBefore = authCalls();

    // Even the correct password is refused while locked out.
    const locked = await login("admin", "hunter2");
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    expect(locked.json<{ error: string }>().error).toContain(
      "Too many failed attempts",
    );
    expect(authCalls()).toBe(callsBefore);
  });

  it("rate-limits login attempts per IP", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();

    let last: LightMyRequestResponse | undefined;
    for (let i = 0; i < 21; i++) {
      last = await login(`user-${i}`, "wrong");
    }
    expect(last!.statusCode).toBe(429);
    expect(last!.json<{ error: string }>().error).toContain(
      "Too many login attempts",
    );
  });

  it("stores only a hash of the session token", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();

    const res = await login("admin", "hunter2");
    const token = sessionCookie(res).split("=")[1]!;
    const hash = createHash("sha256").update(token).digest("hex");

    expect(built!.db.getSessionByTokenHash(hash)).toBeDefined();
    expect(built!.db.getSessionByTokenHash(token)).toBeUndefined();
  });

  it("never logs passwords", async () => {
    const lines: string[] = [];
    await makeAppWithCapturedLogs(lines);
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();

    await login("admin", "hunter2");
    await login("admin", "definitely-not-in-any-log");

    const log = lines.join("\n");
    expect(log).not.toContain("hunter2");
    expect(log).not.toContain("definitely-not-in-any-log");
  });
});

describe("sessions and roles", () => {
  it("lists sessions and revokes another session immediately", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();

    const first = await login("admin", "hunter2");
    const cookieA = sessionCookie(first);
    const second = await login("admin", "hunter2");
    const cookieB = sessionCookie(second);

    const list = await built!.app.inject({
      method: "GET",
      url: "/api/auth/sessions",
      headers: { cookie: cookieA },
    });
    const sessions = list.json<AuthSession[]>();
    expect(sessions).toHaveLength(2);
    const current = sessions.find((s) => s.current);
    const other = sessions.find((s) => !s.current);
    expect(current).toBeDefined();
    expect(other).toBeDefined();

    const del = await built!.app.inject({
      method: "DELETE",
      url: `/api/auth/sessions/${other!.id}`,
      headers: { cookie: cookieA },
    });
    expect(del.statusCode).toBe(204);

    const revoked = await built!.app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: cookieB },
    });
    expect(revoked.statusCode).toBe(401);

    const stillValid = await built!.app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: cookieA },
    });
    expect(stillValid.statusCode).toBe(200);
  });

  it("clears the cookie when revoking the current session", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();

    const res = await login("admin", "hunter2");
    const cookie = sessionCookie(res);

    const list = await built!.app.inject({
      method: "GET",
      url: "/api/auth/sessions",
      headers: { cookie },
    });
    const current = list.json<AuthSession[]>().find((s) => s.current)!;

    const del = await built!.app.inject({
      method: "DELETE",
      url: `/api/auth/sessions/${current.id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);
    expect(setCookieHeader(del)).toBeDefined();

    const after = await built!.app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it("logs out server-side", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();

    const res = await login("admin", "hunter2");
    const cookie = sessionCookie(res);

    const out = await built!.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });
    expect(out.statusCode).toBe(204);
    expect(setCookieHeader(out)).toBeDefined();

    const after = await built!.app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it("gives submitters access to auth routes but not admin routes", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();

    const res = await login("sister", "swordfish");
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: User }>().user).toMatchObject({
      name: "sister",
      role: "submitter",
    });
    const cookie = sessionCookie(res);

    const sessions = await built!.app.inject({
      method: "GET",
      url: "/api/auth/sessions",
      headers: { cookie },
    });
    expect(sessions.statusCode).toBe(200);

    const settings = await built!.app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie },
    });
    expect(settings.statusCode).toBe(403);
  });

  it("requires a session for protected routes", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();

    const res = await built!.app.inject({
      method: "GET",
      url: "/api/settings",
    });
    expect(res.statusCode).toBe(401);
  });

  it("does not let one user revoke another user's session", async () => {
    await makeApp();
    stubJellyfin(DEFAULT_CREDS);
    await completeSetup();

    const adminRes = await login("admin", "hunter2");
    const adminCookie = sessionCookie(adminRes);
    const sisterRes = await login("sister", "swordfish");
    const sisterCookie = sessionCookie(sisterRes);

    const sisterList = await built!.app.inject({
      method: "GET",
      url: "/api/auth/sessions",
      headers: { cookie: sisterCookie },
    });
    const sisterSession = sisterList.json<AuthSession[]>()[0]!;

    const del = await built!.app.inject({
      method: "DELETE",
      url: `/api/auth/sessions/${sisterSession.id}`,
      headers: { cookie: adminCookie },
    });
    expect(del.statusCode).toBe(404);

    const stillValid = await built!.app.inject({
      method: "GET",
      url: "/api/auth/sessions",
      headers: { cookie: sisterCookie },
    });
    expect(stillValid.statusCode).toBe(200);
  });
});
