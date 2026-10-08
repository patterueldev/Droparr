import type { FastifyInstance } from "fastify";
import type { HistoryEntry, Instance } from "@droparr/shared";
import type { ConfigStore } from "../config/store.js";
import type { Db } from "../db.js";

export interface HistoryDeps {
  db: Db;
  config: ConfigStore;
}

/**
 * Resolve response-only fields: the instance's current display name and an
 * absolute deep link into its UI (`/series/{titleSlug}` on Sonarr,
 * `/movie/{id}` on Radarr). Entries whose instance was deleted — or that lack
 * the coordinates the *arr UI needs — keep both fields undefined.
 */
export function enrichHistoryEntry(
  entry: HistoryEntry,
  instance: Instance | undefined,
): HistoryEntry {
  if (!instance) return entry;
  const base = instance.baseUrl.replace(/\/+$/, "");
  let link: string | undefined;
  if (entry.kind === "series" && entry.titleSlug) {
    link = `${base}/series/${encodeURIComponent(entry.titleSlug)}`;
  } else if (entry.kind === "movie" && entry.matchedId !== undefined) {
    link = `${base}/movie/${entry.matchedId}`;
  }
  return { ...entry, instanceName: instance.name, link };
}

export function historyRoutes(
  app: FastifyInstance,
  { db, config }: HistoryDeps,
): void {
  const enrich = (entry: HistoryEntry) =>
    enrichHistoryEntry(entry, config.getInstance(entry.instanceId));

  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    "/api/history",
    async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const offset = Number(req.query.offset ?? 0) || 0;
      return db.listHistory(limit, offset).map(enrich);
    },
  );

  app.get<{ Params: { id: string } }>("/api/history/:id", async (req, reply) => {
    const entry = db.getHistory(req.params.id);
    if (!entry) return reply.code(404).send({ error: "History entry not found" });
    return enrich(entry);
  });
}
