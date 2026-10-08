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

export interface DroparrConfig {
  instances: Instance[];
  categories: Category[];
  stagingDir: string;
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

export interface Submission {
  id: string;
  submitterId: string;
  state: SubmissionState;
  files: FileRef[];
  analysis: FolderAnalysis;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEntry {
  id: string;
  instanceId: string;
  kind: InstanceKind;
  title: string;
  year?: number;
  matchedId?: number;
  files: FileRef[];
  result: "success" | "partial" | "failed";
  timestamps: {
    started: string;
    completed?: string;
  };
}
