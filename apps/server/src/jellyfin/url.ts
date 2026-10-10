import type { DroparrConfig } from "@droparr/shared";

/**
 * The Jellyfin base URL the server actually talks to.
 *
 * `DROPARR_JELLYFIN_URL` wins over config.json. It is the escape hatch for
 * deployments where the configured URL is unreachable from the container
 * (classic case: a `*.local` Bonjour name that resolves in a browser but not
 * inside Docker) — and the recovery path when nobody can log in to change it
 * through Settings.
 */
export function effectiveJellyfinBaseUrl(
  config: DroparrConfig,
): string | undefined {
  const env = process.env.DROPARR_JELLYFIN_URL?.trim();
  if (env) return env;
  return config.jellyfin?.baseUrl;
}
