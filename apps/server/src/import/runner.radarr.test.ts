import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../config/store.js";
import { Db } from "../db.js";
import { JobRegistry, type JobEvent } from "../jobs.js";
import { runImport } from "./runner.js";

/**
 * End-to-end test of the import runner against a mock Radarr:
 * stage files → add movie (searches disabled) → manualimport preflight
 * → ManualImport command → poll → history. Also covers import-only mode
 * when the title is already in the library.
 */
describe("runImport (mock Radarr)", () => {
  let server: Server;
  let baseUrl: string;
  let workDir: string;
  let sourcePath: string;
  let stagingDir: string;

  // Requests the mock recorded, for assertions.
  const calls: { method: string; url: string; body?: unknown }[] = [];
  /** What GET /movie returns (the mock library). */
  let libraryMovies: { id: number; tmdbId: number; title: string }[] = [];

  beforeAll(async () => {
    process.env.DROPARR_POLL_INTERVAL_MS = "10";

    workDir = await mkdtemp(join(tmpdir(), "droparr-radarr-test-"));
    sourcePath = join(workDir, "incoming", "The Matrix (1999)");
    stagingDir = join(workDir, "staging");
    await mkdir(sourcePath, { recursive: true });
    await mkdir(stagingDir, { recursive: true });
    await writeFile(
      join(sourcePath, "The.Matrix.1999.1080p.BluRay.x264-GRP.mkv"),
      Buffer.alloc(64, 1),
    );

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = req.url ?? "";
        const body = chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString())
          : undefined;
        calls.push({ method: req.method ?? "", url, body });
        res.setHeader("Content-Type", "application/json");

        // Radarr API surface used by the runner
        if (url === "/api/v3/movie" && req.method === "GET") {
          return res.end(JSON.stringify(libraryMovies));
        }
        if (url === "/api/v3/movie" && req.method === "POST") {
          return res.end(
            JSON.stringify({ id: 11, title: body.title, tmdbId: body.tmdbId }),
          );
        }
        if (url.startsWith("/api/v3/manualimport")) {
          const folder = new URL(url, "http://x").searchParams.get("folder");
          const movieId = libraryMovies[0]?.id ?? 11;
          return res.end(
            JSON.stringify([
              {
                path: `${folder}/The.Matrix.1999.1080p.BluRay.x264-GRP.mkv`,
                folderName: "The Matrix (1999)",
                movie: { id: movieId, title: "The Matrix" },
                quality: { quality: { id: 7, name: "Bluray-1080p" } },
                languages: [{ id: 1, name: "English" }],
                releaseGroup: "GRP",
                rejections: [],
              },
            ]),
          );
        }
        if (url === "/api/v3/command" && req.method === "POST") {
          return res.end(
            JSON.stringify({ id: 77, name: "ManualImport", status: "queued" }),
          );
        }
        if (url === "/api/v3/command/77") {
          const polls = calls.filter((c) => c.url === "/api/v3/command/77").length;
          return res.end(
            JSON.stringify({
              id: 77,
              name: "ManualImport",
              status: polls >= 2 ? "completed" : "started",
            }),
          );
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not mocked" }));
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    delete process.env.DROPARR_POLL_INTERVAL_MS;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workDir, { recursive: true, force: true });
  });

  async function loadConfig(): Promise<ConfigStore> {
    const configPath = join(workDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        instances: [
          {
            id: "radarr-1",
            name: "Movies Radarr",
            kind: "movie",
            baseUrl,
            apiKey: "test-key",
            pathMappings: [{ app: stagingDir, remote: "/media/staging" }],
          },
        ],
        categories: [
          {
            id: "movies",
            name: "Movies",
            kind: "movie",
            instanceId: "radarr-1",
            rootFolder: "/media/movies",
            qualityProfileId: 4,
            tags: [],
            seriesType: "standard",
          },
        ],
        stagingDir,
      }),
    );
    return ConfigStore.load(configPath);
  }

  it("stages, adds the movie with searches disabled, imports and records history", async () => {
    libraryMovies = [];
    const config = await loadConfig();
    const db = new Db(join(workDir, "droparr-add.db"));
    const jobs = new JobRegistry();
    const events: JobEvent[] = [];
    jobs.on("event", (e: JobEvent) => events.push(e));

    jobs.create("job-radarr-1");
    await runImport(
      { config, db, jobs },
      "job-radarr-1",
      {
        sourcePath,
        categoryId: "movies",
        match: { tmdbId: 603, title: "The Matrix", year: 1999 },
        importMode: "copy",
      },
    );

    const phases = events.map((e) => e.phase);
    expect(phases).toContain("staging");
    expect(phases).toContain("adding");
    expect(phases).toContain("preflight");
    expect(phases).toContain("import");
    expect(phases[phases.length - 1]).toBe("done");

    // Movie added with the category's root folder/profile and no searches.
    const addCall = calls.find(
      (c) => c.url === "/api/v3/movie" && c.method === "POST",
    );
    expect(addCall?.body).toMatchObject({
      tmdbId: 603,
      title: "The Matrix",
      year: 1999,
      qualityProfileId: 4,
      rootFolderPath: "/media/movies",
      monitored: true,
      minimumAvailability: "released",
      addOptions: { monitor: "movieOnly", searchForMovie: false },
    });

    // Manual import command carried the movie mapping.
    const cmdCall = calls.find(
      (c) => c.url === "/api/v3/command" && c.method === "POST",
    );
    const cmdBody = cmdCall?.body as {
      name: string;
      importMode: string;
      files: { path: string; movieId: number }[];
    };
    expect(cmdBody.name).toBe("ManualImport");
    expect(cmdBody.importMode).toBe("copy");
    expect(cmdBody.files).toHaveLength(1);
    expect(cmdBody.files[0].movieId).toBe(11);

    // Staged (copy mode keeps files) and history recorded.
    const staged = await readFile(
      join(
        stagingDir,
        "The Matrix (1999)",
        "The.Matrix.1999.1080p.BluRay.x264-GRP.mkv",
      ),
    );
    expect(staged.length).toBe(64);
    const history = db.listHistory();
    expect(history).toHaveLength(1);
    expect(history[0].result).toBe("success");
    expect(history[0].matchedId).toBe(11);
  });

  it("imports only when the movie is already in the library (no duplicate add)", async () => {
    libraryMovies = [{ id: 5, tmdbId: 603, title: "The Matrix" }];
    const config = await loadConfig();
    const db = new Db(join(workDir, "droparr-existing.db"));
    const jobs = new JobRegistry();
    const events: JobEvent[] = [];
    jobs.on("event", (e: JobEvent) => events.push(e));

    const postsBefore = calls.filter(
      (c) => c.url === "/api/v3/movie" && c.method === "POST",
    ).length;

    jobs.create("job-radarr-2");
    await runImport(
      { config, db, jobs },
      "job-radarr-2",
      {
        sourcePath,
        categoryId: "movies",
        match: { tmdbId: 603, title: "The Matrix", year: 1999 },
        importMode: "copy",
      },
    );

    expect(events[events.length - 1].phase).toBe("done");
    expect(
      events.some((e) => e.message.includes("already in the library")),
    ).toBe(true);
    // No new POST /movie — the existing title was reused.
    const postsAfter = calls.filter(
      (c) => c.url === "/api/v3/movie" && c.method === "POST",
    ).length;
    expect(postsAfter).toBe(postsBefore);

    const history = db.listHistory();
    expect(history).toHaveLength(1);
    expect(history[0].result).toBe("success");
    expect(history[0].matchedId).toBe(5);
  });
});
