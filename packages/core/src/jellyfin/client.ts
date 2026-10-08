import {
  JellyfinAuthError,
  JellyfinError,
  type JellyfinAuthResult,
  type JellyfinPublicSystemInfo,
} from "./types.js";

const CLIENT_NAME = "Droparr";
const DEVICE_NAME = "Web";
const DEVICE_ID = "droparr-web";
const CLIENT_VERSION = "0.1.0";

export interface JellyfinClientOptions {
  baseUrl: string;
  /** Request timeout in ms. Default 10s. */
  timeoutMs?: number;
}

/**
 * Minimal Jellyfin HTTP client for authentication.
 *
 * Security notes:
 * - `authenticateByName` revokes the Jellyfin access token it receives
 *   (best effort) before returning — Droparr never stores or forwards it.
 * - Passwords are sent to Jellyfin but never appear in errors or return
 *   values.
 */
export class JellyfinClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: JellyfinClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** Jellyfin requires client info on every request, even pre-auth ones. */
  private authorizationHeader(token?: string): string {
    const parts = [
      `Client="${CLIENT_NAME}"`,
      `Device="${DEVICE_NAME}"`,
      `DeviceId="${DEVICE_ID}"`,
      `Version="${CLIENT_VERSION}"`,
    ];
    if (token) parts.push(`Token="${token}"`);
    return `MediaBrowser ${parts.join(", ")}`;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; token?: string } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.authorizationHeader(opts.token),
          Accept: "application/json",
          ...(opts.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (!res.ok) {
        // 401/403 means the credentials carried by this endpoint were
        // rejected — callers map this to a login failure, not an outage.
        if (res.status === 401 || res.status === 403) {
          throw new JellyfinAuthError(
            `Jellyfin rejected the credentials (${res.status})`,
            res.status,
          );
        }
        throw new JellyfinError(
          `Jellyfin API ${method} ${path} failed with ${res.status}`,
          res.status,
        );
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof JellyfinError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new JellyfinError(
          `Jellyfin API ${method} ${path} timed out (${this.baseUrl})`,
        );
      }
      // Surface the cause (ECONNREFUSED, ENOTFOUND, …) so setup problems are
      // actionable.
      const cause = (err as { cause?: Error }).cause;
      const detail = cause?.message
        ? `${err instanceof Error ? err.message : String(err)} (${cause.message})`
        : err instanceof Error
          ? err.message
          : String(err);
      throw new JellyfinError(`Jellyfin API ${method} ${path} failed: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Authenticate a user against Jellyfin. The Jellyfin access token is
   * revoked immediately (best effort) and never exposed to callers.
   */
  async authenticateByName(
    username: string,
    password: string,
  ): Promise<JellyfinAuthResult> {
    const result = await this.request<{
      User?: {
        Id?: string;
        Name?: string;
        Policy?: { IsAdministrator?: boolean };
      };
      AccessToken?: string;
      ServerId?: string;
    }>("POST", "/Users/AuthenticateByName", {
      body: { Username: username, Pw: password },
    });

    if (!result.User?.Id) {
      throw new JellyfinError(
        "Jellyfin returned an unexpected authentication response",
      );
    }

    if (result.AccessToken) {
      await this.revokeToken(result.AccessToken);
    }

    return {
      user: {
        id: result.User.Id,
        name: result.User.Name ?? username,
        isAdministrator: result.User.Policy?.IsAdministrator === true,
      },
      serverId: result.ServerId,
    };
  }

  /** Best-effort revocation of a token — failures are ignored. */
  private async revokeToken(token: string): Promise<void> {
    try {
      await this.request("POST", "/Sessions/Logout", { token });
    } catch {
      // A stray Jellyfin session is harmless; never fail a login over it.
    }
  }

  /** Public server info (no auth) — used to test a Jellyfin connection. */
  async publicSystemInfo(): Promise<JellyfinPublicSystemInfo> {
    const info = await this.request<{
      ServerName?: string;
      Version?: string;
      Id?: string;
    }>("GET", "/System/Info/Public");
    return { serverName: info.ServerName, version: info.Version, id: info.Id };
  }
}
