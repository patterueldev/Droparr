import { ArrClient, type ArrClientOptions } from "./client.js";
import type {
  ArrCommand,
  ManualImportItem,
  QualityProfile,
  RootFolder,
  SonarrLookupResult,
  SonarrSeries,
  Tag,
} from "./types.js";

export interface AddSeriesOptions {
  tvdbId: number;
  title: string;
  year?: number;
  qualityProfileId?: number;
  rootFolderPath: string;
  monitored: boolean;
  seasonFolder?: boolean;
  seriesType?: "standard" | "anime" | "daily";
  tags?: number[];
  /**
   * Season selection. When provided these flags are authoritative on add —
   * combined with `addOptions.monitor: "skip"` (the Sonarr semantics are
   * "skip episode-level monitoring and use the season information").
   */
  seasons?: { seasonNumber: number; monitored: boolean }[];
  /** Full lookup result passthrough (images, overview, titleSlug, …). */
  extra?: Record<string, unknown>;
}

export interface ManualImportFileInput {
  path: string;
  folderName?: string;
  seriesId: number;
  episodeIds: number[];
  quality?: unknown;
  languages?: unknown;
  releaseGroup?: string;
  indexerFlags?: number;
}

export class SonarrClient extends ArrClient {
  constructor(opts: ArrClientOptions) {
    super(opts);
  }

  async lookup(term: string): Promise<SonarrLookupResult[]> {
    return this.request("GET", "/series/lookup", { query: { term } });
  }

  async listSeries(): Promise<SonarrSeries[]> {
    return this.request("GET", "/series");
  }

  async getSeries(id: number): Promise<SonarrSeries> {
    return this.request("GET", `/series/${id}`);
  }

  async rootFolders(): Promise<RootFolder[]> {
    return this.request("GET", "/rootfolder");
  }

  async qualityProfiles(): Promise<QualityProfile[]> {
    return this.request("GET", "/qualityprofile");
  }

  async tags(): Promise<Tag[]> {
    return this.request("GET", "/tag");
  }

  /**
   * Add a series. Searches are disabled — Droparr imports existing files,
   * we don't want surprise downloads.
   *
   * With explicit `seasons`, `addOptions.monitor` is set to "skip" so Sonarr
   * uses the season flags verbatim instead of applying a pattern.
   */
  async addSeries(opts: AddSeriesOptions): Promise<SonarrSeries> {
    const body: Record<string, unknown> = {
      ...opts.extra,
      tvdbId: opts.tvdbId,
      title: opts.title,
      year: opts.year,
      qualityProfileId: opts.qualityProfileId ?? 1,
      rootFolderPath: opts.rootFolderPath,
      monitored: opts.monitored,
      seasonFolder: opts.seasonFolder ?? true,
      seriesType: opts.seriesType ?? "standard",
      tags: opts.tags ?? [],
      addOptions: {
        monitor: opts.seasons ? "skip" : "none",
        searchForMissingEpisodes: false,
        searchForCutoffUnmetEpisodes: false,
      },
    };
    if (opts.seasons) {
      body.seasons = opts.seasons;
    }
    return this.request("POST", "/series", { body });
  }

  /**
   * Manual import preflight — the *arr parses the staged folder itself
   * and returns matches plus rejections.
   */
  async manualImportPreflight(
    folder: string,
    filterExistingFiles = false,
  ): Promise<ManualImportItem[]> {
    return this.request("GET", "/manualimport", {
      query: { folder, filterExistingFiles },
    });
  }

  /** Kick off a ManualImport command; returns the command to poll. */
  async manualImport(
    files: ManualImportFileInput[],
    importMode: "move" | "copy",
  ): Promise<ArrCommand> {
    return this.request("POST", "/command", {
      body: { name: "ManualImport", files, importMode },
    });
  }

  /** Rescan a series (fallback when direct manual import isn't suitable). */
  async rescanSeries(seriesId: number): Promise<ArrCommand> {
    return this.request("POST", "/command", {
      body: { name: "RescanSeries", seriesId },
    });
  }
}
