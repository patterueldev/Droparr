import type { NotificationFormat } from "@droparr/shared";

/** One outbound notification; each format uses the fields it understands. */
export interface OutboundMessage {
  title: string;
  body: string;
  /** ntfy priority mood (mapped to ntfy's 1–5 scale); Discord ignores it. */
  priority?: "low" | "default" | "high";
  /** ntfy tags (emoji shortcodes such as `inbox_tray`); Discord ignores them. */
  tags?: string[];
  /** Discord embed accent color; ntfy ignores it. */
  color?: number;
}

export type DeliveryResult =
  | { ok: true }
  | { ok: false; status?: number; error: string };

/** Webhook posts never hang the caller for long. */
const REQUEST_TIMEOUT_MS = 10_000;

const NTFY_PRIORITIES = { low: 2, default: 3, high: 4 } as const;

/** HTTP header values are latin-1 — ship the title only when it is plain ASCII. */
function asciiHeader(value: string): string | undefined {
  return /^[\x20-\x7e]+$/.test(value) ? value : undefined;
}

/**
 * Deliver one message to an ntfy topic or Discord webhook. Never throws:
 * every failure (timeout, DNS, non-2xx) comes back as `{ ok: false }` so the
 * caller can log it without affecting whatever it was doing (M3.5).
 */
export async function deliverWebhook(
  format: NotificationFormat,
  url: string,
  message: OutboundMessage,
): Promise<DeliveryResult> {
  try {
    const res =
      format === "ntfy"
        ? await postNtfy(url, message)
        : await postDiscord(url, message);
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).trim();
      return {
        ok: false,
        status: res.status,
        error: `Webhook answered ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * ntfy accepts a plain-text body on the topic URL; the title, priority and
 * tags ride along as headers. When the title contains non-ASCII characters it
 * is dropped (the body alone stays complete).
 */
async function postNtfy(url: string, message: OutboundMessage): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
  };
  const title = asciiHeader(message.title);
  if (title) headers.Title = title.slice(0, 256);
  if (message.priority) {
    headers.Priority = String(NTFY_PRIORITIES[message.priority]);
  }
  if (message.tags?.length) headers.Tags = message.tags.join(",");
  return fetch(url, {
    method: "POST",
    headers,
    body: message.body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** Discord webhooks take JSON; an embed carries the title and body. */
async function postDiscord(url: string, message: OutboundMessage): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Droparr",
      embeds: [
        {
          title: message.title.slice(0, 256),
          description: message.body.slice(0, 4096),
          color: message.color,
          timestamp: new Date().toISOString(),
        },
      ],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}
