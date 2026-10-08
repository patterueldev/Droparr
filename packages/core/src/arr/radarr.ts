import { ArrClient, type ArrClientOptions } from "./client.js";
import type {
  ArrCommand,
  ManualImportItem,
  QualityProfile,
  RadarrLookupResult,
  RadarrMovie,
  RootFolder,
  Tag,
} from "./types.js";

export interface AddMovieOptions {
  tmdbId: number;
  title: string;
  year?: number;
  qualityProfileId?: number;
  rootFolderPath: string;
  monitored: boolean;
  minimumAvailability?: "announced" | "inCinemas" | "released";
  tags?: number[];
  /** Full lookup result passthrough (images, overview, folderName, …). */
  extra?: Record<string, unknown>;
}

export interface ManualImportMovieFileInput {
  path: string;
  folderName?: string;
  movieId: number;
  quality?: unknown;
  languages?: unknown;
  releaseGroup?: string;
  indexerFlags?: number;
}

export class RadarrClient extends ArrClient {
  constructor(opts: ArrClientOptions) {
    super(opts);
  }

  async lookup(term: string): Promise<RadarrLookupResult[]> {
    return this.request("GET", "/movie/lookup", { query: { term } });
  }

  async listMovies(): Promise<RadarrMovie[]> {
    return this.request("GET", "/movie");
  }

  async getMovie(id: number): Promise<RadarrMovie> {
    return this.request("GET", `/movie/${id}`);
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

  /** Add a movie. Search disabled — importing existing files only. */
  async addMovie(opts: AddMovieOptions): Promise<RadarrMovie> {
    const body: Record<string, unknown> = {
      ...opts.extra,
      tmdbId: opts.tmdbId,
      title: opts.title,
      year: opts.year,
      qualityProfileId: opts.qualityProfileId ?? 1,
      rootFolderPath: opts.rootFolderPath,
      monitored: opts.monitored,
      minimumAvailability: opts.minimumAvailability ?? "released",
      tags: opts.tags ?? [],
      addOptions: {
        monitor: "movieOnly",
        searchForMovie: false,
      },
    };
    return this.request("POST", "/movie", { body });
  }

  async manualImportPreflight(
    folder: string,
    filterExistingFiles = false,
  ): Promise<ManualImportItem[]> {
    return this.request("GET", "/manualimport", {
      query: { folder, filterExistingFiles },
    });
  }

  async manualImport(
    files: ManualImportMovieFileInput[],
    importMode: "move" | "copy",
  ): Promise<ArrCommand> {
    return this.request("POST", "/command", {
      body: { name: "ManualImport", files, importMode },
    });
  }

  async rescanMovie(movieId: number): Promise<ArrCommand> {
    return this.request("POST", "/command", {
      body: { name: "RescanMovie", movieId },
    });
  }
}
