/**
 * Minimal Jellyfin API types for authentication (only what we use).
 * Field names match the API's PascalCase JSON.
 */

export interface JellyfinPublicSystemInfo {
  serverName?: string;
  version?: string;
  id?: string;
}

export interface JellyfinUser {
  id: string;
  name: string;
  isAdministrator: boolean;
}

export interface JellyfinAuthResult {
  user: JellyfinUser;
  serverId?: string;
}

export class JellyfinError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JellyfinError";
  }
}

/** Credentials were rejected by Jellyfin (401/403) — not a connectivity problem. */
export class JellyfinAuthError extends JellyfinError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "JellyfinAuthError";
  }
}
