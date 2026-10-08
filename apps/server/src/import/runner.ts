import { cp, mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { nanoid } from "nanoid";
import {
  PathMapper,
  PathMappingError,
  planStaging,
  SonarrClient,
  RadarrClient,
  analyzeFolder,
  ArrError,
} from "@droparr/core";
import type {
  Category,
  FolderAnalysis,
  HistoryEntry,
  Instance,
} from "@droparr/shared";
import type { ConfigStore } from "../config/store.js";
import type { Db } from "../db.js";
import type { JobRegistry } from "../jobs.js";
import { walkMediaFiles } from "../fs/walk.js";

export interface ImportRequest {
  /** Absolute path on the Droparr host to the dropped folder. */
  sourcePath: string;
  categoryId: string;
  /** The chosen match from the review UI. */
  match: {
    tvdbId?: number;
    tmdbId?: number;
    title: string;
    year?: number;
    /** Lookup result passthrough (images, titleSlug, overview…). */
    extra?: Record<string, unknown>;
  };
  /** Series only: seasons to monitor (defaults to all seasons found). */
  seasons?: number[];
  importMode: "move" | "copy";
}

export interface ImportDeps {
  config: ConfigStore;
  db: Db;
  jobs: JobRegistry;
}

/**
 * Execute the full import pipeline for one submission:
 * stage → ensure title → preflight → manual import → poll → history.
 * Emits JobEvents throughout; never throws (errors are emitted).
 */
export async function runImport(
  deps: ImportDeps,
  jobId: string,
  req: ImportRequest,
): Promise<void> {
  const { config, db, jobs } = deps;
  const emit = (
    phase: Parameters<JobRegistry["emitEvent"]>[0]["phase"],
    message: string,
    extra: Partial<Parameters<JobRegistry["emitEvent"]>[0]> = {},
  ) => {
    jobs.emitEvent({
      jobId,
      phase,
      message,
      at: new Date().toISOString(),
      ...extra,
    });
  };

  const startedAt = new Date().toISOString();
  let historyId = nanoid(12);
  let instance: Instance | undefined;
  let analysis: FolderAnalysis | undefined;
  let files: Awaited<ReturnType<typeof walkMediaFiles>> | undefined;

  try {
    // --- Resolve category + instance -----------------------------------
    const category = config.getCategory(req.categoryId);
    if (!category) throw new Error(`Category ${req.categoryId} not found`);
    instance = config.getInstance(category.instanceId);
    if (!instance) throw new Error(`Instance ${category.instanceId} not found`);

    const stagingBase = config.get().stagingDir;
    if (!stagingBase) {
      throw new Error("Staging directory is not configured (Settings)");
    }

    // --- Analyze the drop (server-side, authoritative) ------------------
    const st = await stat(req.sourcePath).catch(() => undefined);
    if (!st?.isDirectory()) {
      throw new Error(`Source path is not a directory: ${req.sourcePath}`);
    }
    files = await walkMediaFiles(req.sourcePath);
    if (files.files.length === 0) {
      throw new Error("No media files found in the drop");
    }
    analysis = analyzeFolder({
      files: files.files.map((f) => f.path),
      sizes: Object.fromEntries(files.files.map((f) => [f.path, f.size])),
      dropName: basename(req.sourcePath),
    });

    // --- Stage ----------------------------------------------------------
    const mapper = new PathMapper(instance.pathMappings);
    const dropName =
      basename(req.sourcePath) || req.match.title || "drop";
    const plan = planStaging(
      req.sourcePath,
      dropName,
      files.files.map((f) => ({ ...f, name: f.path })),
      stagingBase,
      mapper,
    );

    emit(
      "staging",
      `Copying ${plan.files.length} file(s) to staging (${formatBytes(plan.totalBytes)})`,
      { progress: 0, copiedBytes: 0, totalBytes: plan.totalBytes, filesCopied: 0, totalFiles: plan.files.length },
    );

    await mkdir(plan.stagingDir, { recursive: true });
    let copiedBytes = 0;
    let filesCopied = 0;
    for (const file of plan.files) {
      const dest = file.app;
      await mkdir(dirname(dest), { recursive: true });
      await cp(join(req.sourcePath, file.name), dest, { force: true });
      copiedBytes += file.size;
      filesCopied++;
      emit("staging", `Copied ${file.name}`, {
        progress: plan.totalBytes ? copiedBytes / plan.totalBytes : 1,
        copiedBytes,
        totalBytes: plan.totalBytes,
        filesCopied,
        totalFiles: plan.files.length,
      });
    }

    // --- Ensure the title exists in the library -------------------------
    emit("adding", `Ensuring "${req.match.title}" exists in ${instance.name}`);
    const client =
      instance.kind === "series"
        ? new SonarrClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey })
        : new RadarrClient({ baseUrl: instance.baseUrl, apiKey: instance.apiKey });

    let matchedId: number;
    if (instance.kind === "series") {
      const sonarr = client as SonarrClient;
      if (!req.match.tvdbId) throw new Error("Series match is missing tvdbId");
      const existing = (await sonarr.listSeries()).find(
        (s) => s.tvdbId === req.match.tvdbId,
      );
      if (existing) {
        matchedId = existing.id;
        emit("adding", `"${existing.title}" is already in the library — import-only mode`);
      } else {
        const seasons = buildSeasonSelection(
          analysis,
          req.seasons,
          req.match.extra,
        );
        const added = await sonarr.addSeries({
          tvdbId: req.match.tvdbId,
          title: req.match.title,
          year: req.match.year,
          qualityProfileId: category.qualityProfileId,
          rootFolderPath: category.rootFolder,
          monitored: true,
          seriesType: category.seriesType,
          seasons,
          extra: req.match.extra,
        });
        matchedId = added.id;
        emit("adding", `Added series "${added.title}" to ${instance.name}`);
      }
    } else {
      const radarr = client as RadarrClient;
      if (!req.match.tmdbId) throw new Error("Movie match is missing tmdbId");
      const existing = (await radarr.listMovies()).find(
        (m) => m.tmdbId === req.match.tmdbId,
      );
      if (existing) {
        matchedId = existing.id;
        emit("adding", `"${existing.title}" is already in the library — import-only mode`);
      } else {
        const added = await radarr.addMovie({
          tmdbId: req.match.tmdbId,
          title: req.match.title,
          year: req.match.year,
          qualityProfileId: category.qualityProfileId,
          rootFolderPath: category.rootFolder,
          monitored: true,
          extra: req.match.extra,
        });
        matchedId = added.id;
        emit("adding", `Added movie "${added.title}" to ${instance.name}`);
      }
    }

    // --- Preflight ------------------------------------------------------
    emit("preflight", "Asking the *arr to parse the staged files");
    const preflight =
      instance.kind === "series"
        ? await (client as SonarrClient).manualImportPreflight(plan.instanceDir)
        : await (client as RadarrClient).manualImportPreflight(plan.instanceDir);

    const stagedRemotePaths = new Set(plan.files.map((f) => f.remote));
    const ours = preflight.filter((item) => item.path && stagedRemotePaths.has(item.path));
    const rejected = ours.filter((i) => (i.rejections?.length ?? 0) > 0);
    const importable = ours.filter((i) => !(i.rejections?.length ?? 0));

    if (importable.length === 0) {
      throw new Error(
        rejected.length > 0
          ? `All files were rejected by ${instance.name}: ${rejected
              .flatMap((r) => r.rejections?.map((x) => x.reason) ?? [])
              .join("; ")}`
          : "The *arr returned no importable files for the staged folder",
      );
    }

    // --- Manual import command ------------------------------------------
    emit("import", `Importing ${importable.length} file(s) via native manual import`, {
      progress: 0,
    });

    let command: { id: number; status: string };
    if (instance.kind === "series") {
      const payload = importable.map((item) => ({
        path: item.path,
        folderName: item.folderName,
        seriesId: item.series?.id ?? matchedId,
        episodeIds: item.episodes?.map((e) => e.id) ?? [],
        quality: item.quality,
        languages: item.languages,
        releaseGroup: item.releaseGroup,
        indexerFlags: item.indexerFlags,
      }));
      command = await (client as SonarrClient).manualImport(payload, req.importMode);
    } else {
      const payload = importable.map((item) => ({
        path: item.path,
        folderName: item.folderName,
        movieId: item.movie?.id ?? matchedId,
        quality: item.quality,
        languages: item.languages,
        releaseGroup: item.releaseGroup,
        indexerFlags: item.indexerFlags,
      }));
      command = await (client as RadarrClient).manualImport(payload, req.importMode);
    }

    // --- Poll the command ------------------------------------------------
    const final = await pollCommand(client, command.id, (c) => {
      emit("import", `Import ${c.status}`, {
        command: { id: c.id, name: c.name, status: c.status, message: c.message },
      });
    });

    const success = final.status === "completed";

    // --- History ----------------------------------------------------------
    historyId = nanoid(12);
    const entry: HistoryEntry = {
      id: historyId,
      instanceId: instance.id,
      kind: instance.kind,
      title: req.match.title,
      year: req.match.year,
      matchedId,
      files: files.files,
      result: success
        ? rejected.length > 0
          ? "partial"
          : "success"
        : "failed",
      timestamps: {
        started: startedAt,
        completed: new Date().toISOString(),
      },
    };
    db.addHistory(entry);

    if (!success) {
      throw new Error(final.message ?? `Import command ${final.status}`);
    }

    // --- Staging cleanup ------------------------------------------------
    // With importMode "move" the *arr has moved everything it accepted out
    // of the staging drop; remove what is left (rejected files, empty dirs)
    // so staging doesn't accumulate. The source drop is untouched — staging
    // is always a copy. Cleanup problems never fail an otherwise good import.
    if (req.importMode === "move") {
      if (!isStrictlyInside(stagingBase, plan.stagingDir)) {
        emit(
          "cleanup",
          `Skipped staging cleanup — "${plan.stagingDir}" is outside the staging root`,
        );
      } else {
        try {
          await rm(plan.stagingDir, { recursive: true, force: true });
          emit(
            "cleanup",
            rejected.length > 0
              ? `Cleaned staging folder (removed ${rejected.length} rejected file(s))`
              : "Cleaned staging folder",
          );
        } catch (err) {
          emit(
            "cleanup",
            `Staging cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    emit("done", "Import complete", {
      result: {
        importedFiles: importable.length,
        rejectedFiles: rejected.map((r) => ({
          path: r.path,
          reasons: r.rejections?.map((x) => x.reason) ?? [],
        })),
        historyId,
      },
    });
  } catch (err) {
    // Record a failed history entry if we got far enough to know the target.
    if (instance) {
      try {
        db.addHistory({
          id: historyId,
          instanceId: instance.id,
          kind: instance.kind,
          title: req.match.title,
          year: req.match.year,
          files: files?.files ?? [],
          result: "failed",
          timestamps: { started: startedAt, completed: new Date().toISOString() },
        });
      } catch {
        // History is best-effort on failure.
      }
    }
    emit("error", err instanceof Error ? err.message : String(err), {
      error:
        err instanceof PathMappingError || err instanceof ArrError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
    });
  }
}

/**
 * Build the seasons array for the add payload. Uses the seasons from the
 * lookup result when present, else the seasons detected in the analysis.
 */
function buildSeasonSelection(
  analysis: FolderAnalysis,
  requested: number[] | undefined,
  extra: Record<string, unknown> | undefined,
): { seasonNumber: number; monitored: boolean }[] {
  const lookupSeasons = Array.isArray(extra?.seasons)
    ? (extra.seasons as { seasonNumber: number }[])
        .map((s) => s.seasonNumber)
        .filter((n) => typeof n === "number")
    : [];

  const detected =
    analysis.season !== undefined
      ? [analysis.season]
      : analysis.episodeNumbers?.length
        ? [1]
        : [];

  const allSeasons = lookupSeasons.length > 0 ? lookupSeasons : detected;
  const monitorSet =
    requested && requested.length > 0
      ? new Set(requested)
      : new Set(allSeasons.length > 0 ? allSeasons : [1]);

  return allSeasons
    .sort((a, b) => a - b)
    .map((seasonNumber) => ({
      seasonNumber,
      monitored: monitorSet.has(seasonNumber),
    }));
}

/** True when `child` is strictly inside `parent` (both resolved). */
function isStrictlyInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function pollCommand(
  client: SonarrClient | RadarrClient,
  commandId: number,
  onTick: (c: { id: number; name: string; status: string; message?: string }) => void,
): Promise<{ status: string; message?: string }> {
  const deadline = Date.now() + 10 * 60 * 1000; // 10 min
  let interval = Number(process.env.DROPARR_POLL_INTERVAL_MS ?? 1500);
  for (;;) {
    if (Date.now() > deadline) {
      return { status: "failed", message: "Timed out waiting for the *arr command" };
    }
    const c = await client.getCommand(commandId);
    onTick(c);
    if (c.status === "completed" || c.status === "failed" || c.status === "aborted") {
      return { status: c.status, message: c.message };
    }
    await sleep(interval);
    interval = Math.min(interval * 1.5, 5000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
