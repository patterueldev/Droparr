/**
 * Jellyseerr-style Jellyfin address handling for the setup wizard and
 * Settings → Jellyfin (#36). The UI edits host, port and HTTPS; the config
 * always stores one full URL (`http://saturday.local:8096`), so these helpers
 * split stored values for display and compose edits back into a URL.
 */

export interface JellyfinHostFields {
  host: string;
  port: string;
  https: boolean;
}

/** Port prefilled for a fresh address (Jellyfin's default HTTP port). */
export const DEFAULT_JELLYFIN_PORT = "8096";

/**
 * Split a stored Jellyfin URL into host/port/HTTPS fields. Returns null when
 * the URL cannot be represented by those fields — a subpath, query, hash,
 * credentials, a non-http(s) scheme or an unparseable value — so the caller
 * can fall back to an advanced full-URL input.
 *
 * A URL without an explicit port keeps an empty `port` ("use the scheme's
 * default") so splitting and composing round-trips exactly.
 */
export function splitJellyfinUrl(raw: string): JellyfinHostFields | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  if (url.search || url.hash) return null;
  return {
    host: url.hostname,
    port: url.port,
    https: url.protocol === "https:",
  };
}

/**
 * Compose the full URL the server stores, e.g. `http://saturday.local:8096`.
 * Returns "" while the host is empty; an empty port means the scheme's
 * default. Bare IPv6 hosts are bracketed.
 */
export function composeJellyfinUrl(fields: JellyfinHostFields): string {
  const host = fields.host.trim();
  if (!host) return "";
  const scheme = fields.https ? "https" : "http";
  const port = fields.port.trim();
  const bracketed =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${scheme}://${bracketed}${port ? `:${port}` : ""}`;
}

/** true for "" (scheme default) or a whole-number port in 1–65535. */
export function isValidJellyfinPort(port: string): boolean {
  const value = port.trim();
  if (!value) return true;
  if (!/^\d+$/.test(value)) return false;
  const n = Number(value);
  return n >= 1 && n <= 65535;
}

/** Whether the split fields make a usable address (gates Test/Save buttons). */
export function isValidJellyfinHostFields(fields: JellyfinHostFields): boolean {
  if (!isValidJellyfinPort(fields.port)) return false;
  const host = fields.host.trim();
  if (!host || /[/\s]/.test(host)) return false;
  try {
    const url = new URL(composeJellyfinUrl(fields));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Whether a full URL (advanced mode) is usable. */
export function isValidJellyfinUrl(raw: string): boolean {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Trailing-slash-insensitive form used for dirty checks and prop sync. */
export function normalizeJellyfinUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}
