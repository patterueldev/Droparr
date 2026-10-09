import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverWebhook } from "./webhook.js";

/** A fetch mock with a fixed response (204 responses must have no body). */
function stubResponse(status = 200, body = "") {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(body || null, { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deliverWebhook — ntfy", () => {
  it("posts the body to the topic URL with title, priority and tag headers", async () => {
    const fetchMock = stubResponse();

    const result = await deliverWebhook(
      "ntfy",
      "https://ntfy.sh/droparr-test",
      {
        title: "Import finished",
        body: 'Ada: your submission "Show" is done.',
        priority: "high",
        tags: ["white_check_mark"],
        color: 0x22c55e,
      },
    );

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://ntfy.sh/droparr-test");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('Ada: your submission "Show" is done.');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Title).toBe("Import finished");
    expect(headers.Priority).toBe("4");
    expect(headers.Tags).toBe("white_check_mark");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("drops a non-ASCII title instead of failing the request", async () => {
    const fetchMock = stubResponse();

    const result = await deliverWebhook("ntfy", "https://ntfy.sh/t", {
      title: "Página nueva ✓",
      body: "body stays",
    });

    expect(result).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers.Title).toBeUndefined();
    expect(init?.body).toBe("body stays");
  });
});

describe("deliverWebhook — discord", () => {
  it("posts an embed with the title and body", async () => {
    const fetchMock = stubResponse(204);

    const result = await deliverWebhook(
      "discord",
      "https://discord.com/api/webhooks/1/tok",
      {
        title: "New submission awaiting approval",
        body: 'Sam submitted "Drop" — 2 item(s) waiting for approval in Droparr.',
        color: 0x3b82f6,
        priority: "high", // ignored by Discord
        tags: ["inbox_tray"], // ignored by Discord
      },
    );

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://discord.com/api/webhooks/1/tok");
    expect(init?.method).toBe("POST");
    const payload = JSON.parse(String(init?.body)) as {
      username: string;
      embeds: { title: string; description: string; color: number }[];
    };
    expect(payload.username).toBe("Droparr");
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0]).toMatchObject({
      title: "New submission awaiting approval",
      description:
        'Sam submitted "Drop" — 2 item(s) waiting for approval in Droparr.',
      color: 0x3b82f6,
    });
  });
});

describe("deliverWebhook — failures", () => {
  it("returns the status and response detail on a non-2xx answer", async () => {
    stubResponse(401, "invalid token");

    const result = await deliverWebhook("discord", "https://discord.com/x", {
      title: "Test",
      body: "hi",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toContain("401");
      expect(result.error).toContain("invalid token");
    }
  });

  it("returns the network error instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );

    const result = await deliverWebhook("ntfy", "https://ntfy.sh/t", {
      title: "Test",
      body: "hi",
    });

    expect(result).toEqual({ ok: false, error: "connect ECONNREFUSED" });
  });
});
