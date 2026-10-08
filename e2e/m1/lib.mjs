// Shared helpers for the M1 validation scripts.
// Node >= 20, no dependencies — run with: node --env-file=e2e/m1/local.env <script>
import { execFileSync } from "node:child_process";

export function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env var ${name} (see e2e/m1/local.env.example)`);
  }
  return v;
}

export async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail =
      typeof data === "string" ? data : JSON.stringify(data ?? res.statusText);
    throw new Error(`${opts.method ?? "GET"} ${url} → ${res.status}: ${detail}`);
  }
  return data;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a command on the homeserver. Throws when SSH is not configured. */
export function ssh(command) {
  const host = env("SSH_HOST");
  return execFileSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, command],
    { encoding: "utf8" },
  );
}

/** Droparr API (deployed instance). */
export function droparr(path, opts = {}) {
  return fetchJson(`${env("DROPARR_BASE_URL")}${path}`, opts);
}

/**
 * API keys for the *arr instances. Read from the server's config.xml files
 * over SSH at runtime (never committed, never written to disk), or provided
 * via KEY_<ROLE> env overrides.
 */
let keysCache;
export function arrKeys() {
  if (keysCache) return keysCache;
  keysCache = {};

  const roles = {
    sonarr_tv: env("SONARR_TV_CONTAINER", "sonarr2"),
    sonarr_anime: env("SONARR_ANIME_CONTAINER", "sonarr"),
    radarr_movies: env("RADARR_MOVIES_CONTAINER", "radarr2"),
  };

  if (process.env.SSH_HOST) {
    const root = env("REMOTE_CONFIG_ROOT", "/home/pat/homeserver-data");
    const script = Object.entries(roles)
      .map(
        ([role, container]) =>
          `printf '%s\\t' ${role}; sed -n 's:.*<ApiKey>\\(.*\\)</ApiKey>.*:\\1:p' '${root}/${container}/config/config.xml'`,
      )
      .join("; ");
    for (const line of ssh(script).trim().split("\n")) {
      const [role, key] = line.split("\t");
      if (role && key) keysCache[role] = key.trim();
    }
  }

  for (const role of Object.keys(roles)) {
    const override = process.env[`KEY_${role.toUpperCase()}`];
    if (override) keysCache[role] = override;
  }
  return keysCache;
}

/** *arr API call using the public/LAN URL and the fetched API key. */
export function arr(role, path, opts = {}) {
  const url = env(`${role.toUpperCase()}_URL`);
  const key = arrKeys()[role];
  if (!key) {
    throw new Error(
      `No API key for ${role} — set SSH_HOST or KEY_${role.toUpperCase()}`,
    );
  }
  return fetchJson(`${url}${path}`, {
    ...opts,
    headers: { "X-Api-Key": key, ...(opts.headers ?? {}) },
  });
}
