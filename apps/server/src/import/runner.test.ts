import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../config/store.js";
import { Db } from "../db.js";
import { JobRegistry, type JobEvent } from "../jobs.js";
import { runImport } from "./runner.js";

/**
 * End-to-end test of the import runner against a mock Sonarr:
 * stage files → add series (season-precise) → manualimport preflight
 * → ManualImport command → poll → history.
 */
describe("runImport (mock Sonarr)", () => {
  let server: Server;
  let baseUrl: string;
  let workDir: string;
  let sourcePath: string;
  let stagingDir: string;

  // Requests the mock recorded, for assertions.
  const calls: { method: string; url: string; body?: unknown }[] = [];

  beforeAll(async () => {
    process.env.DROPARR_POLL_INTERVAL_MS = "10";

    workDir = await mkdtemp(join(tmpdir(), "droparr-test-"));
    sourcePath = join(workDir, "incoming", "Breaking Bad S01 1080p");
    stagingDir = join(workDir, "staging");
    await mkdir(sourcePath, { recursive: true });
    await mkdir(stagingDir, { recursive: true });
    for (const n of ["01", "02"]) {
      await writeFile(
        join(sourcePath, `S01E${n}.1080p.WEB-DL.mkv`),
        Buffer.alloc(64, 1),
      );
    }

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

        // Sonarr API surface used by the runner
        if (url === "/api/v3/series" && req.method === "GET") {
          return res.end(JSON.stringify([]));
        }
        if (url === "/api/v3/series" && req.method === "POST") {
          return res.end(
            JSON.stringify({ id: 7, title: body.title, tvdbId: body.tvdbId }),
          );
        }
        if (url.startsWith("/api/v3/episode")) {
          // The runner waits for episode rows after adding a series; the
          // first poll returns empty to exercise that path.
          const polls = calls.filter((c) =>
            c.url.startsWith("/api/v3/episode"),
          ).length;
          return res.end(
            JSON.stringify(
              polls >= 2
                ? [
                    { id: 101, seasonNumber: 1, episodeNumber: 1 },
                    { id: 102, seasonNumber: 1, episodeNumber: 2 },
                  ]
                : [],
            ),
          );
        }
        if (url.startsWith("/api/v3/manualimport")) {
          const folder = new URL(url, "http://x").searchParams.get("folder");
          const items = [
            {
              path: `${folder}/S01E01.1080p.WEB-DL.mkv`,
              folderName: "Breaking Bad S01 1080p",
              series: { id: 7, title: "Breaking Bad" },
              seasonNumber: 1,
              episodes: [{ id: 101, episodeNumber: 1, seasonNumber: 1 }],
              quality: { quality: { id: 5, name: "WEBDL-1080p" } },
              languages: [{ id: 1, name: "English" }],
              releaseGroup: "GRP",
              rejections: [],
            },
            {
              path: `${folder}/S01E02.1080p.WEB-DL.mkv`,
              folderName: "Breaking Bad S01 1080p",
              series: { id: 7, title: "Breaking Bad" },
              seasonNumber: 1,
              episodes: [{ id: 102, episodeNumber: 2, seasonNumber: 1 }],
              quality: { quality: { id: 5, name: "WEBDL-1080p" } },
              languages: [{ id: 1, name: "English" }],
              rejections: [{ reason: "Sample", type: "permanent" }],
            },
          ];
          if (folder?.includes("AllRejected")) {
            return res.end(
              JSON.stringify(
                items.map((i) => ({
                  ...i,
                  rejections: [{ reason: "Sample", type: "permanent" }],
                })),
              ),
            );
          }
          return res.end(JSON.stringify(items));
        }
        if (url === "/api/v3/command" && req.method === "POST") {
          return res.end(
            JSON.stringify({ id: 42, name: "ManualImport", status: "queued" }),
          );
        }
        if (url === "/api/v3/command/42") {
          const polls = calls.filter((c) => c.url === "/api/v3/command/42").length;
          return res.end(
            JSON.stringify({
              id: 42,
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

  it("stages, adds the series with season selection, imports and records history", async () => {
    const configPath = join(workDir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        instances: [
          {
            id: "sonarr-1",
            name: "TV Sonarr",
            kind: "series",
            baseUrl,
            apiKey: "test-key",
            pathMappings: [{ app: stagingDir, remote: "/media/staging" }],
          },
        ],
        categories: [
          {
            id: "tv",
            name: "TV",
            kind: "series",
            instanceId: "sonarr-1",
            rootFolder: "/media/tv",
            qualityProfileId: 3,
            tags: [],
            seriesType: "standard",
          },
        ],
        stagingDir,
      }),
    );
    const config = await ConfigStore.load(configPath);
    const db = new Db(join(workDir, "droparr.db"));
    const jobs = new JobRegistry();
    const events: JobEvent[] = [];
    jobs.on("event", (e: JobEvent) => events.push(e));

    jobs.create("job-1");
    await runImport(
      { config, db, jobs },
      "job-1",
      {
        sourcePath,
        categoryId: "tv",
        match: {
          tvdbId: 81189,
          title: "Breaking Bad",
          year: 2008,
          extra: {
            seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
          },
        },
        seasons: [1],
        importMode: "copy",
      },
    );

    const phases = events.map((e) => e.phase);
    expect(phases).toContain("staging");
    expect(phases).toContain("adding");
    expect(phases).toContain("preflight");
    expect(phases).toContain("import");
    expect(phases[phases.length - 1]).toBe("done");

    // The runner waited for the *arr to index episodes before preflighting
    // (the first poll returns empty in the mock).
    const episodePolls = calls.filter((c) =>
      c.url.startsWith("/api/v3/episode"),
    ).length;
    expect(episodePolls).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.message.includes("index episodes"))).toBe(true);

    const done = events[events.length - 1];
    expect(done.result?.importedFiles).toBe(1); // E02 was rejected
    expect(done.result?.rejectedFiles).toHaveLength(1);

    // Series was added with explicit seasons and monitor: skip.
    const addCall = calls.find(
      (c) => c.url === "/api/v3/series" && c.method === "POST",
    );
    const addBody = addCall?.body as Record<string, unknown>;
    expect(addBody.addOptions).toMatchObject({
      monitor: "skip",
      searchForMissingEpisodes: false,
    });
    expect(addBody.seasons).toEqual([
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: false },
    ]);
    expect(addBody.qualityProfileId).toBe(3);

    // Manual import command carried the episode mapping.
    const cmdCall = calls.find(
      (c) => c.url === "/api/v3/command" && c.method === "POST",
    );
    const cmdBody = cmdCall?.body as {
      name: string;
      importMode: string;
      files: { path: string; seriesId: number; episodeIds: number[] }[];
    };
    expect(cmdBody.name).toBe("ManualImport");
    expect(cmdBody.importMode).toBe("copy");
    expect(cmdBody.files).toHaveLength(1);
    expect(cmdBody.files[0].seriesId).toBe(7);
    expect(cmdBody.files[0].episodeIds).toEqual([101]);

    // Files were copied to staging, originals kept.
    const staged = await readFile(
      join(stagingDir, "Breaking Bad S01 1080p", "S01E01.1080p.WEB-DL.mkv"),
    );
    expect(staged.length).toBe(64);

    // History recorded as partial (one file rejected).
    const history = db.listHistory();
    expect(history).toHaveLength(1);
    expect(history[0].result).toBe("partial");
    expect(history[0].title).toBe("Breaking Bad");
    expect(history[0].matchedId).toBe(7);
  });

  it("fails cleanly when the category does not exist", async () => {
    const config = await ConfigStore.load(join(workDir, "config.json"));
    const db = new Db(join(workDir, "droparr2.db"));
    const jobs = new JobRegistry();
    const events: JobEvent[] = [];
    jobs.on("event", (e: JobEvent) => events.push(e));

    jobs.create("job-2");
    await runImport(
      { config, db, jobs },
      "job-2",
      {
        sourcePath,
        categoryId: "nope",
        match: { tvdbId: 1, title: "X" },
        importMode: "copy",
      },
    );

    expect(events[events.length - 1].phase).toBe("error");
    expect(events[events.length - 1].error).toContain("not found");
  });

  it("removes the staging drop folder after a move import (partial included)", async () => {
    const config = await ConfigStore.load(join(workDir, "config.json"));
    const db = new Db(join(workDir, "droparr-move.db"));
    const jobs = new JobRegistry();
    const events: JobEvent[] = [];
    jobs.on("event", (e: JobEvent) => events.push(e));

    const moveSource = join(workDir, "incoming", "Move Mode Show");
    await mkdir(moveSource, { recursive: true });
    for (const n of ["01", "02"]) {
      await writeFile(
        join(moveSource, `S01E${n}.1080p.WEB-DL.mkv`),
        Buffer.alloc(64, 1),
      );
    }

    jobs.create("job-move");
    await runImport(
      { config, db, jobs },
      "job-move",
      {
        sourcePath: moveSource,
        categoryId: "tv",
        match: {
          tvdbId: 81189,
          title: "Move Mode Show",
          extra: { seasons: [{ seasonNumber: 1 }] },
        },
        seasons: [1],
        importMode: "move",
      },
    );

    expect(events[events.length - 1].phase).toBe("done");
    const cleanup = events.find((e) => e.phase === "cleanup");
    expect(cleanup?.message).toContain("Cleaned staging folder");
    expect(cleanup?.message).toContain("1 rejected file");
    await expect(
      stat(join(stagingDir, "Move Mode Show")),
    ).rejects.toThrow();
    // The source drop is untouched — staging is always a copy.
    expect((await stat(join(moveSource, "S01E01.1080p.WEB-DL.mkv"))).size).toBe(
      64,
    );
  });

  it("keeps the staging folder when every file was rejected", async () => {
    const config = await ConfigStore.load(join(workDir, "config.json"));
    const db = new Db(join(workDir, "droparr-rejected.db"));
    const jobs = new JobRegistry();
    const events: JobEvent[] = [];
    jobs.on("event", (e: JobEvent) => events.push(e));

    const rejectedSource = join(workDir, "incoming", "AllRejected Show");
    await mkdir(rejectedSource, { recursive: true });
    await writeFile(
      join(rejectedSource, "S01E01.1080p.WEB-DL.mkv"),
      Buffer.alloc(64, 1),
    );

    jobs.create("job-rejected");
    await runImport(
      { config, db, jobs },
      "job-rejected",
      {
        sourcePath: rejectedSource,
        categoryId: "tv",
        match: { tvdbId: 81189, title: "AllRejected Show" },
        importMode: "move",
      },
    );

    expect(events[events.length - 1].phase).toBe("error");
    expect(events[events.length - 1].error).toContain("All files were rejected");
    // Staging is kept for inspection, and no cleanup event was emitted.
    expect(
      (await stat(join(stagingDir, "AllRejected Show"))).isDirectory(),
    ).toBe(true);
    expect(events.some((e) => e.phase === "cleanup")).toBe(false);
  });
});
