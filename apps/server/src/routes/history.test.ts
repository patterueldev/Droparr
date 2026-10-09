import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryEntry } from "@droparr/shared";
import { ConfigStore } from "../config/store.js";
import { Db } from "../db.js";
import { historyRoutes } from "./history.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function buildHarness(instances: unknown[]): Promise<{
  app: FastifyInstance;
  db: Db;
}> {
  const tmp = await mkdtemp(join(tmpdir(), "droparr-history-"));
  const configPath = join(tmp, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({ instances, categories: [], stagingDir: "" }),
  );
  const config = await ConfigStore.load(configPath);
  const db = new Db(join(tmp, "droparr.db"));
  const app = Fastify();
  historyRoutes(app, { db, config });
  cleanups.push(async () => {
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  });
  return { app, db };
}

function entry(partial: Partial<HistoryEntry> & { id: string }): HistoryEntry {
  return {
    instanceId: "sonarr-1",
    kind: "series",
    title: "Breaking Bad",
    files: [],
    result: "success",
    timestamps: { started: "2026-10-08T00:00:00.000Z" },
    ...partial,
  };
}

const SONARR = {
  id: "sonarr-1",
  name: "TV Sonarr",
  kind: "series",
  // Trailing slash exercises URL normalization.
  baseUrl: "http://sonarr.local:8989/",
  apiKey: "test-key",
  pathMappings: [],
};

const RADARR = {
  id: "radarr-1",
  name: "Movie Radarr",
  kind: "movie",
  baseUrl: "http://radarr.local:7878",
  apiKey: "test-key",
  pathMappings: [],
};

describe("historyRoutes enrichment", () => {
  it("links series entries by titleSlug and movies by id, with instance names", async () => {
    const { app, db } = await buildHarness([SONARR, RADARR]);
    db.addHistory(entry({ id: "series-1", titleSlug: "breaking-bad" }));
    db.addHistory(
      entry({
        id: "movie-1",
        instanceId: "radarr-1",
        kind: "movie",
        title: "The Matrix",
        matchedId: 11,
      }),
    );

    const res = await app.inject({ method: "GET", url: "/api/history" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as HistoryEntry[];

    const series = body.find((e) => e.id === "series-1")!;
    expect(series.instanceName).toBe("TV Sonarr");
    expect(series.link).toBe("http://sonarr.local:8989/series/breaking-bad");

    const movie = body.find((e) => e.id === "movie-1")!;
    expect(movie.instanceName).toBe("Movie Radarr");
    expect(movie.link).toBe("http://radarr.local:7878/movie/11");
  });

  it("omits the link when coordinates are missing or the instance is gone", async () => {
    const { app, db } = await buildHarness([SONARR]);
    db.addHistory(entry({ id: "no-slug" }));
    db.addHistory(entry({ id: "deleted", instanceId: "gone" }));

    const res = await app.inject({ method: "GET", url: "/api/history" });
    const body = res.json() as HistoryEntry[];

    const noSlug = body.find((e) => e.id === "no-slug")!;
    expect(noSlug.instanceName).toBe("TV Sonarr");
    expect(noSlug.link).toBeUndefined();

    // The instance was deleted from config: no name, no link, id remains.
    const deleted = body.find((e) => e.id === "deleted")!;
    expect(deleted.instanceName).toBeUndefined();
    expect(deleted.link).toBeUndefined();
  });

  it("enriches the by-id endpoint and 404s for unknown entries", async () => {
    const { app, db } = await buildHarness([SONARR]);
    db.addHistory(entry({ id: "series-1", titleSlug: "breaking-bad" }));

    const res = await app.inject({ method: "GET", url: "/api/history/series-1" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as HistoryEntry).link).toBe(
      "http://sonarr.local:8989/series/breaking-bad",
    );

    const missing = await app.inject({ method: "GET", url: "/api/history/nope" });
    expect(missing.statusCode).toBe(404);
  });
});
