import type { PathMapping } from "@droparr/shared";

/**
 * Path mapping translates between paths as Droparr sees them ("app")
 * and paths as a target *arr instance sees them ("remote").
 *
 * Example: Droparr stages into /data/staging/Show, Sonarr sees the same
 * volume mounted at /media/staging/Show:
 *   { app: "/data", remote: "/media" }
 */
export class PathMapper {
  constructor(private readonly mappings: PathMapping[]) {}

  /** Droparr path → instance path. Returns undefined when unmapped. */
  toRemote(appPath: string): string | undefined {
    return this.translate(appPath, "app", "remote");
  }

  /** Instance path → Droparr path. Returns undefined when unmapped. */
  toApp(remotePath: string): string | undefined {
    return this.translate(remotePath, "remote", "app");
  }

  private translate(
    path: string,
    from: "app" | "remote",
    to: "app" | "remote",
  ): string | undefined {
    const normalized = normalize(path);
    // Longest prefix wins so /data/media beats /data.
    const sorted = [...this.mappings].sort(
      (a, b) => normalize(b[from]).length - normalize(a[from]).length,
    );
    for (const m of sorted) {
      const prefix = normalize(m[from]).replace(/\/+$/, "");
      if (normalized === prefix || normalized.startsWith(prefix + "/")) {
        const rest = normalized.slice(prefix.length);
        return normalize(m[to]).replace(/\/+$/, "") + rest;
      }
    }
    return undefined;
  }
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/**
 * Validate a set of mappings for common mistakes:
 * - overlapping app-side prefixes (ambiguous)
 * - empty paths
 */
export function validateMappings(mappings: PathMapping[]): string[] {
  const errors: string[] = [];
  const appPrefixes: string[] = [];

  for (const m of mappings) {
    if (!m.app.trim() || !m.remote.trim()) {
      errors.push("Mapping with empty app or remote path");
      continue;
    }
    if (!m.app.startsWith("/") || !m.remote.startsWith("/")) {
      errors.push(
        `Mapping paths should be absolute: "${m.app}" ↔ "${m.remote}"`,
      );
    }
    const prefix = normalize(m.app).replace(/\/+$/, "");
    for (const existing of appPrefixes) {
      if (
        prefix === existing ||
        prefix.startsWith(existing + "/") ||
        existing.startsWith(prefix + "/")
      ) {
        errors.push(
          `Overlapping app-side paths: "${prefix}" and "${existing}" — a path could match both`,
        );
      }
    }
    appPrefixes.push(prefix);
  }

  return errors;
}
