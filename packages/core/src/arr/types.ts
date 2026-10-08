/**
 * Minimal resource types for the Sonarr/Radarr v3 APIs (only what we use).
 * Field names match the API's camelCase JSON.
 */

export interface SystemStatus {
  appName: string;
  version: string;
  buildTime?: string;
  isProduction?: boolean;
}

export interface RootFolder {
  id: number;
  path: string;
  accessible: boolean;
  freeSpace?: number;
  unmappedFolders?: { name: string; path: string }[];
}

export interface QualityProfile {
  id: number;
  name: string;
}

export interface Tag {
  id: number;
  label: string;
}

/** Sonarr series lookup result. */
export interface SonarrLookupResult {
  title: string;
  year?: number;
  tvdbId?: number;
  titleSlug?: string;
  overview?: string;
  images?: { coverType: string; remoteUrl?: string }[];
  seasons?: { seasonNumber: number; monitored: boolean }[];
}

/** A series as it exists in the Sonarr library. */
export interface SonarrSeries {
  id: number;
  title: string;
  year?: number;
  tvdbId?: number;
  titleSlug: string;
  path?: string;
  seasons?: SonarrSeason[];
  monitored?: boolean;
  seriesType?: string;
}

export interface SonarrSeason {
  seasonNumber: number;
  monitored: boolean;
  statistics?: {
    episodeFileCount: number;
    episodeCount: number;
    totalEpisodeCount: number;
  };
}

/** An episode as it exists in the Sonarr library. */
export interface SonarrEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  monitored?: boolean;
}

/** Radarr movie lookup result. */
export interface RadarrLookupResult {
  title: string;
  year?: number;
  tmdbId?: number;
  overview?: string;
  images?: { coverType: string; remoteUrl?: string }[];
  folderName?: string;
}

/** A movie as it exists in the Radarr library. */
export interface RadarrMovie {
  id: number;
  title: string;
  year?: number;
  tmdbId?: number;
  titleSlug?: string;
  path?: string;
  folderName?: string;
  monitored?: boolean;
  hasFile?: boolean;
}

/** Manual import preflight item (Sonarr or Radarr). */
export interface ManualImportItem {
  id?: number;
  path: string;
  relativePath?: string;
  folderName?: string;
  name?: string;
  size?: number;
  /** Present on rejected candidates. */
  rejections?: { reason: string; type?: string }[];
  quality?: unknown;
  languages?: unknown;
  releaseGroup?: string;
  indexerFlags?: number;
  /** Sonarr */
  series?: { id: number; title?: string };
  seasonNumber?: number;
  episodes?: { id: number; episodeNumber: number; seasonNumber: number }[];
  episodeFileId?: number;
  /** Radarr */
  movie?: { id: number; title?: string };
}

export interface ArrCommand {
  id: number;
  name: string;
  status: "queued" | "started" | "completed" | "failed" | "aborted";
  result?: string;
  message?: string;
  body?: Record<string, unknown>;
}

export class ArrError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ArrError";
  }
}
