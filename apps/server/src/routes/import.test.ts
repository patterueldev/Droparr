import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../config/store.js";
import { Db } from "../db.js";
import { JobRegistry } from "../jobs.js";
import { runImport } from "../import/runner.js";
import { importRoutes } from "./import.js";

// The route's pipelines are fire-and-forget; the runner itself is covered by
// its own end-to-end tests against a mock *arr.
vi.mock("../import/runner.js", () => ({
  runImport: vi.fn(async () => {}),
}));

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

beforeEach(() => {
  vi.mocked(runImport).mockClear();
});

async function buildHarness(): Promise<{ app: FastifyInstance }> {
  const tmp = await mkdtemp(join(tmpdir(), "droparr-import-"));
  const config = await ConfigStore.load(join(tmp, "config.json"));
  await config.addInstance({
    id: "radarr-1",
    name: "Movies Radarr",
    kind: "movie",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "k",
    pathMappings: [],
  });
  await config.addCategory({
    id: "movies",
    name: "Movies",
    kind: "movie",
    instanceId: "radarr-1",
    rootFolder: "/movies",
    tags: [],
    seriesType: "standard",
  });

  const db = new Db(join(tmp, "droparr.db"));
  const jobs = new JobRegistry();
  const app = Fastify();
  importRoutes(app, { config, db, jobs });
  cleanups.push(async () => {
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  });
  return { app };
}

describe("POST /api/import/batch", () => {
  it("starts one pipeline per item and reports the job ids in order", async () => {
    const { app } = await buildHarness();

    const res = await app.inject({
      method: "POST",
      url: "/api/import/batch",
      payload: {
        items: [
          {
            sourcePath: "/drops/Movies/A (2001)",
            categoryId: "movies",
            match: { tmdbId: 1, title: "A", year: 2001 },
          },
          {
            sourcePath: "/drops/Movies/B (2004)",
            categoryId: "movies",
            match: { tmdbId: 2, title: "B", year: 2004 },
          },
        ],
      },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as { jobs: { jobId: string }[] };
    expect(body.jobs).toHaveLength(2);

    const mocked = vi.mocked(runImport);
    await vi.waitFor(() => expect(mocked).toHaveBeenCalledTimes(2));
    expect(mocked.mock.calls[0][2]).toMatchObject({
      sourcePath: "/drops/Movies/A (2001)",
    });
    expect(mocked.mock.calls[1][2]).toMatchObject({
      sourcePath: "/drops/Movies/B (2004)",
    });
    // The pipelines report under exactly the job ids the response handed out.
    expect(mocked.mock.calls.map((c) => c[1])).toEqual(
      body.jobs.map((j) => j.jobId),
    );
  });

  it("rejects the whole batch before starting anything when an item is invalid", async () => {
    const { app } = await buildHarness();

    const res = await app.inject({
      method: "POST",
      url: "/api/import/batch",
      payload: {
        items: [
          {
            sourcePath: "/drops/A",
            categoryId: "movies",
            match: { tmdbId: 1, title: "A" },
          },
          {
            sourcePath: "/drops/B",
            categoryId: "missing",
            match: { tmdbId: 2, title: "B" },
          },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain(
      "items[1]: Category not found",
    );
    expect(vi.mocked(runImport)).not.toHaveBeenCalled();
  });

  it("rejects an empty batch", async () => {
    const { app } = await buildHarness();
    const res = await app.inject({
      method: "POST",
      url: "/api/import/batch",
      payload: { items: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(vi.mocked(runImport)).not.toHaveBeenCalled();
  });
});

describe("POST /api/import", () => {
  it("keeps the single-item import behavior", async () => {
    const { app } = await buildHarness();

    const ok = await app.inject({
      method: "POST",
      url: "/api/import",
      payload: {
        sourcePath: "/drops/A",
        categoryId: "movies",
        match: { tmdbId: 1, title: "A" },
      },
    });
    expect(ok.statusCode).toBe(202);
    expect((ok.json() as { jobId: string }).jobId).toBeTruthy();

    const missing = await app.inject({
      method: "POST",
      url: "/api/import",
      payload: {
        sourcePath: "/drops/A",
        categoryId: "movies",
        match: { title: "A" },
      },
    });
    expect(missing.statusCode).toBe(400);
    expect((missing.json() as { error: string }).error).toBe(
      "Movie imports require match.tmdbId",
    );
  });
});
