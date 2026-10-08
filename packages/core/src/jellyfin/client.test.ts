import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinClient } from "./client.js";
import { JellyfinAuthError, JellyfinError } from "./types.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JellyfinClient.authenticateByName", () => {
  it("sends the client-info header and credentials, and parses the identity", async () => {
    const mock = stubFetch((url) => {
      if (url.endsWith("/Users/AuthenticateByName")) {
        return jsonResponse({
          User: {
            Id: "jf-1",
            Name: "admin",
            Policy: { IsAdministrator: true },
          },
          AccessToken: "tok-123",
          ServerId: "srv-1",
        });
      }
      if (url.endsWith("/Sessions/Logout")) return new Response(null, { status: 204 });
      return jsonResponse({}, 404);
    });

    const client = new JellyfinClient({ baseUrl: "http://jellyfin.local:8096/" });
    const result = await client.authenticateByName("admin", "hunter2");

    expect(result.user).toEqual({
      id: "jf-1",
      name: "admin",
      isAdministrator: true,
    });
    expect(result.serverId).toBe("srv-1");

    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://jellyfin.local:8096/Users/AuthenticateByName");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toContain('Client="Droparr"');
    expect(headers.Authorization).toContain('DeviceId="droparr-web"');
    expect(JSON.parse(String(init.body))).toEqual({
      Username: "admin",
      Pw: "hunter2",
    });
  });

  it("revokes the Jellyfin access token before returning", async () => {
    const mock = stubFetch((url) => {
      if (url.endsWith("/Users/AuthenticateByName")) {
        return jsonResponse({
          User: { Id: "jf-1", Name: "admin", Policy: { IsAdministrator: false } },
          AccessToken: "tok-123",
        });
      }
      return new Response(null, { status: 204 });
    });

    const client = new JellyfinClient({ baseUrl: "http://jellyfin.local:8096" });
    const result = await client.authenticateByName("admin", "pw");

    expect(result.user.isAdministrator).toBe(false);
    const logoutCall = mock.mock.calls.find(([url]) =>
      String(url).endsWith("/Sessions/Logout"),
    );
    expect(logoutCall).toBeDefined();
    const init = logoutCall?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toContain(
      'Token="tok-123"',
    );
  });

  it("does not fail the login when token revocation fails", async () => {
    stubFetch((url) => {
      if (url.endsWith("/Users/AuthenticateByName")) {
        return jsonResponse({
          User: { Id: "jf-1", Name: "admin", Policy: { IsAdministrator: true } },
          AccessToken: "tok-123",
        });
      }
      throw new Error("boom");
    });

    const client = new JellyfinClient({ baseUrl: "http://jellyfin.local:8096" });
    await expect(client.authenticateByName("admin", "pw")).resolves.toMatchObject({
      user: { id: "jf-1" },
    });
  });

  it("maps 401 responses to JellyfinAuthError", async () => {
    stubFetch(() => jsonResponse({}, 401));

    const client = new JellyfinClient({ baseUrl: "http://jellyfin.local:8096" });
    const err = await client.authenticateByName("admin", "wrong").catch((e) => e);
    expect(err).toBeInstanceOf(JellyfinAuthError);
    expect((err as JellyfinAuthError).status).toBe(401);
  });

  it("maps network failures to JellyfinError (not an auth error)", async () => {
    stubFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: new Error("ECONNREFUSED"),
      });
    });

    const client = new JellyfinClient({ baseUrl: "http://jellyfin.local:8096" });
    const err = await client.authenticateByName("admin", "pw").catch((e) => e);
    expect(err).toBeInstanceOf(JellyfinError);
    expect(err).not.toBeInstanceOf(JellyfinAuthError);
    expect((err as Error).message).toContain("ECONNREFUSED");
  });
});

describe("JellyfinClient.publicSystemInfo", () => {
  it("reads the public system info endpoint", async () => {
    const mock = stubFetch((url) =>
      jsonResponse({ ServerName: "Jellyfin", Version: "10.10.3", Id: "srv-1" }),
    );

    const client = new JellyfinClient({ baseUrl: "http://jellyfin.local:8096" });
    await expect(client.publicSystemInfo()).resolves.toEqual({
      serverName: "Jellyfin",
      version: "10.10.3",
      id: "srv-1",
    });
    expect(String(mock.mock.calls[0]?.[0])).toBe(
      "http://jellyfin.local:8096/System/Info/Public",
    );
  });
});
