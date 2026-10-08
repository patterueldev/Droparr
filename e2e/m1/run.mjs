// M1 end-to-end validation against real *arr instances.
//
// Usage:
//   node --env-file=e2e/m1/local.env e2e/m1/run.mjs            # run all scenarios
//   node --env-file=e2e/m1/local.env e2e/m1/run.mjs --cleanup  # remove test titles/files
//
// Scenarios (issue #14):
//   movie      Movie drop → Radarr (non-anime) → imported, renamed, history success
//   tv         TV season pack → Sonarr → episodes mapped, monitored seasons respected
//   anime      Anime drop (absolute numbering) → anime Sonarr → routed correctly
//   duplicate  Title already in library → import-only mode (no duplicate add)
//   rejections Rejections surface instead of failing silently
//   copy       Copy mode keeps staged files (move mode cleans staging up)
//
// Test titles are verified absent from the real libraries; imports go into
// isolated /media-03/DROPARR-TEST root folders (see setup.mjs).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arr, droparr, env, sleep, ssh } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const artifactsDir = join(
  here,
  ".work",
  "artifacts",
  new Date().toISOString().replace(/[:.]/g, "-"),
);

const DROPS = env("DROPS_APP", "/incoming");
const NAME = {
  tv: env("SONARR_TV_NAME", "TV Sonarr"),
  anime: env("SONARR_ANIME_NAME", "Anime Sonarr"),
  movies: env("RADARR_MOVIES_NAME", "Movies Radarr"),
};
const CAT = {
  tv: env("TV_CATEGORY_NAME", "TV"),
  anime: env("ANIME_CATEGORY_NAME", "Anime"),
  movies: env("MOVIES_CATEGORY_NAME", "Movies"),
};

// Test titles — all verified absent from the real libraries (checked 2026-10-08).
const TITLES = {
  movie: { term: "Dune 2021", tmdbId: 438631, title: "Dune", year: 2021 },
  tv: { term: "Severance", tvdbId: 371980, title: "Severance", year: 2022 },
  anime: {
    term: "Edgerunners",
    tvdbId: 384541,
    title: "Cyberpunk: Edgerunners",
    year: 2022,
  },
  rejections: { term: "Andor", tvdbId: 393189, title: "Andor", year: 2022 },
  copy: { term: "Parasite 2019", tmdbId: 496243, title: "Parasite", year: 2019 },
};

const DROP_DIRS = [
  "Dune (2021)",
  "Severance S01 1080p",
  "Edgerunners",
  "Andor S01 1080p",
  "Parasite (2019)",
];

function check(cond, message) {
  if (!cond) throw new Error(message);
}

/** Retry transient failures (the *arr metadata backends can be flaky/slow). */
async function withRetry(fn, label, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        console.log(
          `    … ${label} failed (attempt ${i}/${attempts}): ${err?.message ?? err}`,
        );
        await sleep(3000 * i);
      }
    }
  }
  throw lastErr;
}

async function context() {
  const settings = await droparr("/api/settings");
  check(
    settings.stagingDir === env("STAGING_APP", "/data/staging"),
    `stagingDir is "${settings.stagingDir}" — run setup.mjs first`,
  );
  const instances = await droparr("/api/instances");
  const categories = await droparr("/api/categories");
  const byName = (list, name, what) => {
    const item = list.find((x) => x.name === name);
    if (!item) throw new Error(`${what} "${name}" not found — run setup.mjs first`);
    return item;
  };
  return {
    inst: (name) => byName(instances, name, "Instance"),
    cat: (name) => byName(categories, name, "Category"),
  };
}

function lookup(instanceId, term) {
  return withRetry(
    () =>
      droparr(
        `/api/instances/${instanceId}/lookup?term=${encodeURIComponent(term)}`,
      ),
    `lookup "${term}"`,
  );
}

/** Find the exact lookup result for a spec, by id + title. */
function pickMatch(results, spec, idField) {
  const match = results.find(
    (r) =>
      r[idField] === spec[idField] &&
      String(r.title).toLowerCase() === spec.title.toLowerCase(),
  );
  check(
    match,
    `Lookup "${spec.term}" did not return ${spec.title} (${idField} ${spec[idField]}) — got: ${results
      .slice(0, 3)
      .map((r) => `${r.title} (${r.year}, ${idField} ${r[idField]})`)
      .join(", ")}`,
  );
  return match;
}

async function waitForJob(jobId, timeoutMs = 20 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await droparr(`/api/jobs/${jobId}`);
    if (job.finished) return job;
    if (Date.now() > deadline) throw new Error(`Job ${jobId} timed out`);
    await sleep(1500);
  }
}

async function startImport(body) {
  const { jobId } = await droparr("/api/import", { method: "POST", body });
  return waitForJob(jobId);
}

const lastEvent = (job) => job.events[job.events.length - 1];

async function historyEntry(historyId) {
  const entries = await droparr("/api/history");
  return entries.find((e) => e.id === historyId);
}

/** Does <staging host dir>/<relative> exist? undefined when SSH is not configured. */
async function stagingExists(relative) {
  const host = env("STAGING_HOST_DIR", "");
  if (!host) return undefined;
  const out = ssh(`test -e '${host}/${relative}' && echo yes || echo no`);
  return out.trim() === "yes";
}

async function sweepStaging(relative) {
  const host = env("STAGING_HOST_DIR", "");
  if (!host) return false;
  ssh(`rm -rf '${host}/${relative}'`);
  return true;
}

function stagingNote(exists) {
  return exists === undefined ? "not checked (no SSH_HOST)" : !exists;
}

/** Remove leftovers from previous runs so every scenario starts clean. */
async function cleanSlate() {
  const host = env("STAGING_HOST_DIR", "");
  if (!host) return;
  for (const dir of DROP_DIRS) {
    ssh(`rm -rf '${host}/${dir}'`);
  }
}

// ---------------------------------------------------------------- scenarios

async function scenarioMovie(ctx, state) {
  const instance = ctx.inst(NAME.movies);
  const category = ctx.cat(CAT.movies);
  const spec = TITLES.movie;
  const match = pickMatch(
    await lookup(instance.id, spec.term),
    spec,
    "tmdbId",
  );

  const job = await startImport({
    sourcePath: `${DROPS}/Dune (2021)`,
    categoryId: category.id,
    match: {
      tmdbId: match.tmdbId,
      title: match.title,
      year: match.year,
      extra: match,
    },
    importMode: "move",
  });
  state.added.radarr.push(match.tmdbId);

  const final = lastEvent(job);
  check(
    final.phase === "done",
    `Job ended "${final.phase}": ${final.error ?? final.message}`,
  );
  const added = job.events.find(
    (e) => e.phase === "adding" && e.message.startsWith("Added movie"),
  );
  check(added, "The movie was not added — title may already exist in the library");
  check(
    final.result.importedFiles === 1,
    `importedFiles=${final.result.importedFiles}, expected 1`,
  );
  check(
    final.result.rejectedFiles.length === 0,
    `unexpected rejections: ${JSON.stringify(final.result.rejectedFiles)}`,
  );

  const movie = (await arr("radarr_movies", "/api/v3/movie")).find(
    (m) => m.tmdbId === match.tmdbId,
  );
  check(movie, "Movie not found in the Radarr library");
  check(
    String(movie.path ?? "").startsWith(`${env("RADARR_MOVIES_ROOT")}/`),
    `Movie path not under the test root: ${movie.path}`,
  );
  check(movie.hasFile === true, "Movie has no file after import");
  const filePath = movie.movieFile?.path ?? "";
  check(
    filePath.startsWith(`${env("RADARR_MOVIES_ROOT")}/`),
    `File not under the test root: ${filePath}`,
  );
  check(filePath.includes("Dune (2021)"), `File was not renamed: ${filePath}`);

  const history = await historyEntry(final.result.historyId);
  check(history?.result === "success", `History result: ${history?.result}`);

  const staging = await stagingExists("Dune (2021)");
  if (staging !== undefined) {
    check(staging === false, "Staging drop folder was not cleaned up");
  }

  return {
    instance: instance.name,
    match: { tmdbId: match.tmdbId, title: match.title, year: match.year },
    importedFile: filePath,
    history: history.result,
    stagingCleaned: stagingNote(staging),
    jobEvents: job.events,
  };
}

async function scenarioTv(ctx, state) {
  const instance = ctx.inst(NAME.tv);
  const category = ctx.cat(CAT.tv);
  const spec = TITLES.tv;
  const match = pickMatch(await lookup(instance.id, spec.term), spec, "tvdbId");

  const job = await startImport({
    sourcePath: `${DROPS}/Severance S01 1080p`,
    categoryId: category.id,
    match: {
      tvdbId: match.tvdbId,
      title: match.title,
      year: match.year,
      extra: match,
    },
    seasons: [1],
    importMode: "move",
  });
  state.added.sonarr.push(match.tvdbId);

  const final = lastEvent(job);
  check(
    final.phase === "done",
    `Job ended "${final.phase}": ${final.error ?? final.message}`,
  );
  const added = job.events.find(
    (e) => e.phase === "adding" && e.message.startsWith("Added series"),
  );
  check(added, "The series was not added — title may already exist in the library");
  check(
    final.result.importedFiles === 3,
    `importedFiles=${final.result.importedFiles}, expected 3`,
  );

  const series = (await arr("sonarr_tv", "/api/v3/series")).find(
    (s) => s.tvdbId === match.tvdbId,
  );
  check(series, "Series not found in the TV Sonarr library");
  check(
    series.rootFolderPath === env("SONARR_TV_ROOT"),
    `rootFolderPath=${series.rootFolderPath}`,
  );
  const season1 = series.seasons.find((s) => s.seasonNumber === 1);
  check(season1?.monitored === true, "Season 1 is not monitored");
  const others = series.seasons.filter((s) => s.seasonNumber !== 1);
  check(others.length > 0, "expected the series to have multiple seasons");
  const wronglyMonitored = others
    .filter((s) => s.monitored)
    .map((s) => s.seasonNumber);
  check(
    wronglyMonitored.length === 0,
    `Seasons monitored that should not be: ${wronglyMonitored.join(", ")}`,
  );

  const files = await arr("sonarr_tv", `/api/v3/episodefile?seriesId=${series.id}`);
  check(files.length === 3, `episode files: ${files.length}, expected 3`);

  const history = await historyEntry(final.result.historyId);
  check(history?.result === "success", `History result: ${history?.result}`);

  const staging = await stagingExists("Severance S01 1080p");
  if (staging !== undefined) {
    check(staging === false, "Staging drop folder was not cleaned up");
  }

  return {
    instance: instance.name,
    match: { tvdbId: match.tvdbId, title: match.title },
    monitoredSeasons: series.seasons.map((s) => ({
      season: s.seasonNumber,
      monitored: s.monitored,
    })),
    episodeFiles: files.length,
    history: history.result,
    stagingCleaned: stagingNote(staging),
    jobEvents: job.events,
  };
}

async function scenarioAnime(ctx, state) {
  const instance = ctx.inst(NAME.anime);
  const category = ctx.cat(CAT.anime);
  const spec = TITLES.anime;
  const match = pickMatch(await lookup(instance.id, spec.term), spec, "tvdbId");

  const job = await startImport({
    sourcePath: `${DROPS}/Edgerunners`,
    categoryId: category.id,
    match: {
      tvdbId: match.tvdbId,
      title: match.title,
      year: match.year,
      extra: match,
    },
    seasons: [1],
    importMode: "move",
  });
  state.added.sonarr.push(match.tvdbId);

  const final = lastEvent(job);
  check(
    final.phase === "done",
    `Job ended "${final.phase}": ${final.error ?? final.message}`,
  );
  const added = job.events.find(
    (e) =>
      e.phase === "adding" &&
      e.message.startsWith("Added series") &&
      e.message.includes(instance.name),
  );
  check(added, `The series was not added to ${instance.name}`);
  check(
    final.result.importedFiles >= 3,
    `importedFiles=${final.result.importedFiles}, expected >= 3`,
  );

  const series = (await arr("sonarr_anime", "/api/v3/series")).find(
    (s) => s.tvdbId === match.tvdbId,
  );
  check(series, "Series not found on the anime instance");
  check(
    series.rootFolderPath === env("SONARR_ANIME_ROOT"),
    `rootFolderPath=${series.rootFolderPath}`,
  );
  check(
    series.qualityProfileId === Number(env("SONARR_ANIME_PROFILE")),
    `qualityProfileId=${series.qualityProfileId}, expected ${env("SONARR_ANIME_PROFILE")}`,
  );
  check(series.seriesType === "anime", `seriesType=${series.seriesType}`);

  const onTv = (await arr("sonarr_tv", "/api/v3/series")).some(
    (s) => s.tvdbId === match.tvdbId,
  );
  check(!onTv, "Series was also added to the TV instance");

  const files = await arr("sonarr_anime", `/api/v3/episodefile?seriesId=${series.id}`);
  check(files.length >= 3, `episode files: ${files.length}, expected >= 3`);

  const history = await historyEntry(final.result.historyId);
  check(history?.result === "success", `History result: ${history?.result}`);

  const staging = await stagingExists("Edgerunners");
  if (staging !== undefined) {
    check(staging === false, "Staging drop folder was not cleaned up");
  }

  return {
    instance: instance.name,
    category: category.name,
    match: { tvdbId: match.tvdbId, title: match.title, year: match.year },
    seriesType: series.seriesType,
    rootFolderPath: series.rootFolderPath,
    qualityProfileId: series.qualityProfileId,
    episodeFiles: files.length,
    history: history.result,
    stagingCleaned: stagingNote(staging),
    jobEvents: job.events,
  };
}

async function scenarioDuplicate(ctx, state) {
  const instance = ctx.inst(NAME.movies);
  const category = ctx.cat(CAT.movies);
  const spec = TITLES.movie;
  const match = pickMatch(await lookup(instance.id, spec.term), spec, "tmdbId");

  const job = await startImport({
    sourcePath: `${DROPS}/Dune (2021)`,
    categoryId: category.id,
    match: {
      tmdbId: match.tmdbId,
      title: match.title,
      year: match.year,
      extra: match,
    },
    importMode: "move",
  });

  const adding = job.events.find(
    (e) => e.phase === "adding" && e.message.includes("already in the library"),
  );
  check(adding, "No import-only message — the title may have been added again");

  const movies = await arr("radarr_movies", "/api/v3/movie");
  const count = movies.filter((m) => m.tmdbId === match.tmdbId).length;
  check(count === 1, `Movie count for tmdbId ${match.tmdbId} is ${count}, expected 1`);

  // The *arr normally rejects the file (existing file is not an upgrade).
  // That is the error path, so staging is kept for inspection by design —
  // sweep it so the next run starts clean.
  const final = lastEvent(job);
  let stagingSwept = false;
  if (final.phase === "error") {
    stagingSwept = await sweepStaging("Dune (2021)");
  }

  return {
    importOnlyMessage: adding.message,
    movieCount: count,
    finalPhase: final.phase,
    finalMessage: final.message,
    rejection: final.phase === "error" ? final.error : final.result?.rejectedFiles,
    stagingSwept,
    jobEvents: job.events,
  };
}

async function scenarioRejection(ctx, state) {
  const instance = ctx.inst(NAME.tv);
  const category = ctx.cat(CAT.tv);
  const spec = TITLES.rejections;
  const match = pickMatch(await lookup(instance.id, spec.term), spec, "tvdbId");

  const job = await startImport({
    sourcePath: `${DROPS}/Andor S01 1080p`,
    categoryId: category.id,
    match: {
      tvdbId: match.tvdbId,
      title: match.title,
      year: match.year,
      extra: match,
    },
    seasons: [1],
    importMode: "move",
  });
  state.added.sonarr.push(match.tvdbId);

  const final = lastEvent(job);
  check(
    final.phase === "done",
    `Job ended "${final.phase}": ${final.error ?? final.message}`,
  );
  check(final.result.importedFiles >= 1, "No files were imported");
  check(
    final.result.rejectedFiles.length >= 1,
    "No rejections reported — did the *arr accept the invalid file?",
  );
  check(
    final.result.rejectedFiles.every((r) => r.reasons.length > 0),
    "A rejected file was reported without a reason",
  );
  check(
    final.result.rejectedFiles.some((r) => /S01E99/i.test(r.path)),
    `The invalid episode (S01E99) was not the rejected file: ${JSON.stringify(
      final.result.rejectedFiles,
    )}`,
  );

  const history = await historyEntry(final.result.historyId);
  check(history?.result === "partial", `History result: ${history?.result}`);

  const staging = await stagingExists("Andor S01 1080p");
  if (staging !== undefined) {
    check(staging === false, "Staging drop folder was not cleaned up");
  }

  return {
    instance: instance.name,
    match: { tvdbId: match.tvdbId, title: match.title },
    importedFiles: final.result.importedFiles,
    rejectedFiles: final.result.rejectedFiles,
    history: history.result,
    stagingCleaned: stagingNote(staging),
    jobEvents: job.events,
  };
}

async function scenarioCopy(ctx, state) {
  const instance = ctx.inst(NAME.movies);
  const category = ctx.cat(CAT.movies);
  const spec = TITLES.copy;
  const match = pickMatch(await lookup(instance.id, spec.term), spec, "tmdbId");

  const job = await startImport({
    sourcePath: `${DROPS}/Parasite (2019)`,
    categoryId: category.id,
    match: {
      tmdbId: match.tmdbId,
      title: match.title,
      year: match.year,
      extra: match,
    },
    importMode: "copy",
  });
  state.added.radarr.push(match.tmdbId);

  const final = lastEvent(job);
  check(
    final.phase === "done",
    `Job ended "${final.phase}": ${final.error ?? final.message}`,
  );
  check(
    final.result.importedFiles === 1,
    `importedFiles=${final.result.importedFiles}, expected 1`,
  );

  const movie = (await arr("radarr_movies", "/api/v3/movie")).find(
    (m) => m.tmdbId === match.tmdbId,
  );
  check(movie?.hasFile === true, "Movie has no file after copy import");

  // Copy mode intentionally keeps the staged files.
  const staging = await stagingExists("Parasite (2019)");
  if (staging !== undefined) {
    check(staging === true, "Copy mode removed the staged files");
    await sweepStaging("Parasite (2019)");
  }

  const history = await historyEntry(final.result.historyId);
  check(history?.result === "success", `History result: ${history?.result}`);

  return {
    instance: instance.name,
    match: { tmdbId: match.tmdbId, title: match.title },
    importedFile: movie.movieFile?.path,
    history: history.result,
    stagingKept: stagingNote(staging),
    jobEvents: job.events,
  };
}

const scenarios = [
  ["movie", "Movie drop → Radarr: imported, renamed, history success", scenarioMovie],
  ["tv", "TV season pack → Sonarr: episodes mapped, monitored seasons respected", scenarioTv],
  ["anime", "Anime (absolute numbering) → anime Sonarr: routed correctly", scenarioAnime],
  ["duplicate", "Title already in library → import-only mode (no duplicate add)", scenarioDuplicate],
  ["rejections", "Rejections surface in the job result instead of failing silently", scenarioRejection],
  ["copy", "Copy mode keeps staged files (move mode cleans up)", scenarioCopy],
];

// ---------------------------------------------------------------- cleanup

async function cleanup() {
  const statePath = join(here, ".work", "last-run.json");
  check(existsSync(statePath), "No .work/last-run.json — run the scenarios first");
  const state = JSON.parse(readFileSync(statePath, "utf8"));

  for (const tmdbId of [...new Set(state.added?.radarr ?? [])]) {
    const movie = (await arr("radarr_movies", "/api/v3/movie")).find(
      (m) => m.tmdbId === tmdbId,
    );
    if (!movie) {
      console.log(`— movie ${tmdbId} already gone`);
      continue;
    }
    // Never touch titles outside the isolated test root.
    if (!String(movie.path ?? "").startsWith(`${env("RADARR_MOVIES_ROOT")}/`)) {
      console.log(`— skipped "${movie.title}" (not in the test root)`);
      continue;
    }
    await arr("radarr_movies", `/api/v3/movie/${movie.id}?deleteFiles=true`, {
      method: "DELETE",
    });
    console.log(`✓ removed movie "${movie.title}" (${tmdbId}) with files`);
  }

  for (const tvdbId of [...new Set(state.added?.sonarr ?? [])]) {
    const tv = (await arr("sonarr_tv", "/api/v3/series")).find(
      (s) => s.tvdbId === tvdbId,
    );
    const anime = tv
      ? undefined
      : (await arr("sonarr_anime", "/api/v3/series")).find(
          (s) => s.tvdbId === tvdbId,
        );
    const found = tv ?? anime;
    const role = tv ? "sonarr_tv" : "sonarr_anime";
    const root = tv ? env("SONARR_TV_ROOT") : env("SONARR_ANIME_ROOT");
    if (!found) {
      console.log(`— series ${tvdbId} already gone`);
      continue;
    }
    if (!String(found.path ?? "").startsWith(`${root}/`)) {
      console.log(`— skipped "${found.title}" (not in the test root)`);
      continue;
    }
    await arr(role, `/api/v3/series/${found.id}?deleteFiles=true`, {
      method: "DELETE",
    });
    console.log(`✓ removed series "${found.title}" (${tvdbId}) with files`);
  }

  const host = env("STAGING_HOST_DIR", "");
  if (host) {
    ssh(`find '${host}' -mindepth 1 -maxdepth 1 -exec rm -rf {} +`);
    console.log("✓ staging swept");
  }
  console.log("Note: test root folders are left in place (harmless, empty).");
}

// ---------------------------------------------------------------- main

async function main() {
  const ctx = await context();
  mkdirSync(artifactsDir, { recursive: true });
  const state = {
    startedAt: new Date().toISOString(),
    droparrBaseUrl: env("DROPARR_BASE_URL"),
    added: { radarr: [], sonarr: [] },
  };
  const summary = [];

  await cleanSlate();

  for (const [id, title, fn] of scenarios) {
    const startedAt = new Date().toISOString();
    process.stdout.write(`— ${title} … `);
    try {
      const evidence = await fn(ctx, state);
      summary.push({ id, title, status: "passed" });
      console.log("✓ passed");
      writeFileSync(
        join(artifactsDir, `${id}.json`),
        JSON.stringify(
          { id, title, status: "passed", startedAt, finishedAt: new Date().toISOString(), evidence },
          null,
          2,
        ),
      );
    } catch (err) {
      const message = err?.message ?? String(err);
      summary.push({ id, title, status: "failed", error: message });
      console.log(`✗ failed: ${message}`);
      writeFileSync(
        join(artifactsDir, `${id}.json`),
        JSON.stringify(
          { id, title, status: "failed", startedAt, finishedAt: new Date().toISOString(), error: message },
          null,
          2,
        ),
      );
    }
  }

  state.finishedAt = new Date().toISOString();
  state.summary = summary;
  writeFileSync(join(here, ".work", "last-run.json"), JSON.stringify(state, null, 2));
  writeFileSync(join(artifactsDir, "summary.json"), JSON.stringify(summary, null, 2));

  const passed = summary.filter((s) => s.status === "passed").length;
  console.log(`\n${passed}/${summary.length} scenarios passed`);
  console.log(`Artifacts: ${artifactsDir}`);
  if (passed !== summary.length) process.exitCode = 1;
}

const run = args.includes("--cleanup") ? cleanup : main;
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
