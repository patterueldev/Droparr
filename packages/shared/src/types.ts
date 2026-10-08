export type InstanceKind = "series" | "movie";

export type SeriesType = "standard" | "anime" | "daily";

export type SubmissionState =
  | "uploading"
  | "analyzing"
  | "pending"
  | "approved"
  | "importing"
  | "done"
  | "rejected";

export type UserRole = "admin" | "submitter";

export interface User {
  id: string;
  jellyfinUserId: string;
  name: string;
  role: UserRole;
  trusted: boolean;
  blocked: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

/** A server-side login session as shown to its owner. */
export interface AuthSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent?: string;
  ip?: string;
  /** True for the session making the request. */
  current?: boolean;
}

export interface AuthStatus {
  /**
   * True until the first-run setup wizard has completed (lock marker in
   * SQLite, so deleting the config file does not reopen it).
   */
  setupRequired: boolean;
  authenticated: boolean;
  user?: User;
}

/**
 * Wizard state for `GET /api/setup/status`. Only served while setup is
 * incomplete — the endpoint locks itself once the marker is set.
 */
export interface SetupStatus {
  setupRequired: boolean;
  /** A Jellyfin URL is already saved (wizard step 1 done). */
  jellyfinConfigured: boolean;
  jellyfinBaseUrl?: string;
  authenticated: boolean;
  user?: User;
}

export interface PathMapping {
  app: string;
  remote: string;
}

export interface Instance {
  id: string;
  name: string;
  kind: InstanceKind;
  baseUrl: string;
  apiKey: string;
  pathMappings: PathMapping[];
}

export interface Category {
  id: string;
  name: string;
  kind: InstanceKind;
  instanceId: string;
  rootFolder: string;
  qualityProfileId?: number;
  tags: string[];
  seriesType: SeriesType;
}

export interface UploadSettings {
  /** Where browser uploads land before staging. Defaults to <dataDir>/quarantine. */
  quarantineDir?: string;
  /** Per-file cap in bytes; 0 = unlimited. */
  maxFileSizeBytes?: number;
  /** Per-drop (submission) cap in bytes; 0 = unlimited. */
  maxSubmissionSizeBytes?: number;
}

export interface DroparrConfig {
  instances: Instance[];
  categories: Category[];
  stagingDir: string;
  uploads?: UploadSettings;
  jellyfin?: {
    baseUrl: string;
    apiKey?: string;
  };
  llm?: {
    provider: string;
    apiKey: string;
    model: string;
  };
}

/**
 * Early staging-visibility findings (Settings + import wizard). Advisory only:
 * a listed problem explains why an import would fail, but never blocks it.
 */
export type StagingCheckIssueCode =
  | "staging-dir-empty"
  | "staging-dir-missing"
  | "staging-dir-unmapped";

export interface StagingCheckIssue {
  code: StagingCheckIssueCode;
  message: string;
  suggestion?: string;
  /** Set when the issue concerns one target instance's path mappings. */
  instanceId?: string;
  instanceName?: string;
}

export interface FileRef {
  name: string;
  path: string;
  size: number;
  ext: string;
}

export interface FolderAnalysis {
  kind: "series" | "movie";
  title: string;
  year?: number;
  seriesType?: SeriesType;
  season?: number;
  episodeNumbers?: number[];
  files: FileRef[];
  confidence: "high" | "medium" | "low";
  reasoning: string[];
}

/**
 * One reviewable/importable item of a drop. A plain drop yields a single item
 * (`subPath: ""`); a multi-movie drop fans out into one item per sibling
 * movie folder. File paths stay relative to the drop root.
 */
export interface FolderAnalysisItem extends FolderAnalysis {
  /**
   * Path from the drop root to this item's folder (`"A (2001)"`), or `""`
   * when the item's files sit at the drop root itself.
   */
  subPath: string;
}

export interface Submission {
  id: string;
  submitterId: string;
  state: SubmissionState;
  files: FileRef[];
  analysis: FolderAnalysis;
  createdAt: string;
  updatedAt: string;
}

/** A staged file the *arr rejected during manual-import preflight. */
export interface HistoryRejectedFile {
  path: string;
  reasons: string[];
}

export interface HistoryEntry {
  id: string;
  instanceId: string;
  kind: InstanceKind;
  title: string;
  year?: number;
  matchedId?: number;
  /** Sonarr series slug — deep-link coordinate for `{baseUrl}/series/{titleSlug}`. */
  titleSlug?: string;
  files: FileRef[];
  /** Files rejected during preflight; absent when nothing was rejected. */
  rejectedFiles?: HistoryRejectedFile[];
  result: "success" | "partial" | "failed";
  timestamps: {
    started: string;
    completed?: string;
  };
  /** Response-only: instance name resolved from config when read. */
  instanceName?: string;
  /** Response-only: absolute *arr UI URL for the matched title. */
  link?: string;
}
