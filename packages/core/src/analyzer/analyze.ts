import type { FileRef, FolderAnalysis, SeriesType } from "@droparr/shared";
import {
  cleanTitle,
  extractYear,
  extname,
  isMediaFile,
  isVideoFile,
  isSubtitleFile,
  parse1x01,
  parseAbsolute,
  parseSeasonFolder,
  parseSxxExx,
} from "./parse.js";

export interface AnalyzeInput {
  /** Relative paths of all files in the drop (folder name included as prefix is fine). */
  files: string[];
  /** Size in bytes per file path, when known. */
  sizes?: Record<string, number>;
  /**
   * Name of the dropped folder itself. Used as the title source when files
   * sit flat at the drop root (e.g. "Breaking Bad S01 1080p/S01E01.mkv"
   * passed as "S01E01.mkv" with dropName "Breaking Bad S01 1080p").
   */
  dropName?: string;
}

/**
 * Analyze a dropped folder/file list and decide kind (series|movie),
 * a best-guess title, year, season/episode info and confidence.
 */
export function analyzeFolder(input: AnalyzeInput): FolderAnalysis {
  const reasoning: string[] = [];
  const media = input.files.filter((f) => {
    const name = basename(f);
    return isMediaFile(name);
  });
  const videos = media.filter((f) => isVideoFile(basename(f)));

  const fileRefs: FileRef[] = media.map((f) => ({
    name: basename(f),
    path: f,
    size: input.sizes?.[f] ?? 0,
    ext: extname(basename(f)),
  }));

  if (videos.length === 0) {
    return {
      kind: "movie",
      title: "",
      files: fileRefs,
      confidence: "low",
      reasoning: ["No video files found"],
    };
  }

  // --- Gather episode signals across all video files ---
  let sxxexxFiles = 0;
  let absoluteFiles = 0;
  let seasonFolder: number | undefined;
  const seasons = new Set<number>();
  const episodeNumbers = new Set<number>();

  for (const v of videos) {
    const name = basename(v);
    const dir = dirname(v);

    const sxx = parseSxxExx(name) ?? parse1x01(name);
    if (sxx) {
      sxxexxFiles++;
      seasons.add(sxx.season);
      for (const e of sxx.episodes) episodeNumbers.add(e);
    } else {
      const abs = parseAbsolute(name);
      if (abs !== undefined) {
        absoluteFiles++;
        episodeNumbers.add(abs);
      }
    }

    const sf = parseSeasonFolder(maybeDirName(dir));
    if (sf !== undefined && seasonFolder === undefined) seasonFolder = sf;
  }

  if (seasonFolder !== undefined) seasons.add(seasonFolder);

  // --- Series vs movie decision ---
  const hasEpisodePattern = sxxexxFiles > 0 || absoluteFiles > 0;
  const isSeries = hasEpisodePattern && videos.length >= 1;

  // Title: prefer the common top folder; when files are flat at the drop
  // root, the dropped folder's own name is the best source.
  const rootName = dropRootName(input.files);
  const isFlat = !input.files.some((f) => f.includes("/"));
  const titleSource =
    isFlat && input.dropName ? input.dropName : rootName;
  const title =
    cleanTitle(titleSource) || titleSource.replace(/\.[^.]+$/, "").trim();
  const year = extractYear(titleSource);

  if (isSeries) {
    let seriesType: SeriesType = "standard";
    if (absoluteFiles > 0 && sxxexxFiles === 0) {
      seriesType = "anime";
      reasoning.push(
        `Detected absolute numbering in ${absoluteFiles} file(s) → anime-style series`,
      );
    } else if (absoluteFiles > 0 && sxxexxFiles > 0) {
      seriesType = "anime";
      reasoning.push(
        "Mixed SxxExx and absolute numbering → anime-style series",
      );
    } else {
      reasoning.push(
        `Detected SxxExx numbering in ${sxxexxFiles} file(s) → standard series`,
      );
    }

    // Confidence: single absolute-numbered file is weak evidence.
    let confidence: FolderAnalysis["confidence"] = "high";
    if (absoluteFiles > 0 && absoluteFiles < 2 && sxxexxFiles === 0) {
      confidence = "low";
      reasoning.push("Only one absolute-numbered file — weak series signal");
    } else if (videos.length === 1 && sxxexxFiles === 0) {
      confidence = "medium";
    }

    return {
      kind: "series",
      title,
      year,
      seriesType,
      season: seasons.size === 1 ? [...seasons][0] : undefined,
      episodeNumbers: [...episodeNumbers].sort((a, b) => a - b),
      files: fileRefs,
      confidence,
      reasoning,
    };
  }

  // Movie: no episode patterns. Year presence raises confidence.
  let confidence: FolderAnalysis["confidence"] = "medium";
  if (year !== undefined && videos.length === 1) {
    confidence = "high";
    reasoning.push(`Year ${year} found and single video file → likely movie`);
  } else if (videos.length === 1) {
    confidence = "medium";
    reasoning.push("Single video file, no episode numbering → movie");
  } else {
    confidence = "low";
    reasoning.push(
      `${videos.length} video files without episode numbering — ambiguous, could be a multi-movie folder`,
    );
  }

  return {
    kind: "movie",
    title,
    year,
    files: fileRefs,
    confidence,
    reasoning,
  };
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

function dirname(p: string): string {
  const parts = p.split("/");
  parts.pop();
  return parts.join("/");
}

function maybeDirName(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * The drop root: the common top-level folder of all files, if any.
 * e.g. ["Show/Season 1/S01E01.mkv", "Show/Season 1/S01E02.mkv"] → "Show"
 */
export function dropRootName(files: string[]): string {
  if (files.length === 0) return "";
  const firstParts = files[0].split("/").filter(Boolean);
  if (firstParts.length <= 1) {
    // Files are at the drop root — use the file name itself.
    return firstParts[0] ?? "";
  }

  const top = firstParts[0];
  const allShareTop = files.every((f) => {
    const parts = f.split("/").filter(Boolean);
    return parts[0] === top;
  });
  if (allShareTop) return top;

  // No common top folder — fall back to the first file's name.
  const first = files[0].split("/").filter(Boolean);
  return first[first.length - 1] ?? "";
}
