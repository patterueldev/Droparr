import type {
  AuthSession,
  AuthStatus,
  Category,
  DroparrConfig,
  FolderAnalysis,
  FolderAnalysisItem,
  HistoryEntry,
  Instance,
  SetupStatus,
  StagingCheckIssue,
  UploadEvent,
  UploadListResponse,
  User,
} from "@droparr/shared";

/** HTTP failure with the status (and error `code` when the server sends one). */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  // Only advertise a JSON content-type when there is a body — Fastify
  // rejects empty bodies that claim to be JSON (FST_ERR_CTP_EMPTY_JSON_BODY).
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== "/api/auth/login") {
    // The session is gone (expired or revoked) — let the auth gate react.
    window.dispatchEvent(new Event("droparr:unauthorized"));
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    let code: string | undefined;
    try {
      const data = (await res.json()) as { error?: unknown; code?: unknown };
      if (data.error) {
        detail = Array.isArray(data.error)
          ? data.error.join("; ")
          : typeof data.error === "string"
            ? data.error
            : JSON.stringify(data.error);
      }
      if (typeof data.code === "string") code = data.code;
    } catch {
      // keep the status text
    }
    if (code === "setup_required") {
      // The server is still waiting for first-run setup — re-check auth.
      window.dispatchEvent(new Event("droparr:setup-required"));
    }
    throw new ApiError(res.status, detail, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // Auth
  authStatus: () => request<AuthStatus>("/api/auth/status"),
  login: (body: { username: string; password: string }) =>
    request<{ user: User }>("/api/auth/login", { method: "POST", body }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  sessions: () => request<AuthSession[]>("/api/auth/sessions"),
  revokeSession: (id: string) =>
    request<void>(`/api/auth/sessions/${id}`, { method: "DELETE" }),

  // Users (admin user management)
  users: () => request<User[]>("/api/users"),
  updateUser: (
    id: string,
    patch: { role?: User["role"]; trusted?: boolean; blocked?: boolean },
  ) => request<User>(`/api/users/${id}`, { method: "PATCH", body: patch }),

  // First-run setup wizard (open until setup completes, then locked)
  setupStatus: () => request<SetupStatus>("/api/setup/status"),
  setupJellyfinTest: (baseUrl: string) =>
    request<{ ok: boolean; serverName?: string; version?: string }>(
      "/api/setup/jellyfin/test",
      { method: "POST", body: { baseUrl } },
    ),
  setupJellyfin: (baseUrl: string) =>
    request<{ ok: boolean; serverName?: string; version?: string }>(
      "/api/setup/jellyfin",
      { method: "POST", body: { baseUrl } },
    ),
  setupComplete: () =>
    request<{ ok: boolean; user: User }>("/api/setup/complete", {
      method: "POST",
    }),
  /** Connection test for the Settings → Jellyfin section (admin). */
  jellyfinTestSaved: (baseUrl: string) =>
    request<{ ok: boolean; serverName?: string; version?: string }>(
      "/api/settings/jellyfin/test",
      { method: "POST", body: { baseUrl } },
    ),

  // Config
  settings: () => request<DroparrConfig>("/api/settings"),
  updateSettings: (body: Partial<DroparrConfig>) =>
    request<DroparrConfig>("/api/settings", { method: "PUT", body }),
  /** Advisory staging-visibility audit for the Settings page. */
  settingsStagingCheck: () =>
    request<StagingCheckResponse>("/api/settings/staging-check"),
  /** Free/total bytes on the quarantine volume (Settings → Uploads). */
  diskStatus: () => request<DiskStatus>("/api/settings/disk"),
  /** Quarantine sweep status + last result (Settings → Uploads). */
  cleanupStatus: () => request<CleanupStatus>("/api/settings/cleanup"),
  /** Run one quarantine sweep now. */
  runCleanup: () =>
    request<SweepResult>("/api/settings/cleanup/run", { method: "POST" }),
  exportSettings: () =>
    request<{
      app: "droparr";
      formatVersion: number;
      exportedAt?: string;
      config: DroparrConfig;
    }>("/api/settings/export"),
  importSettings: (payload: unknown) =>
    request<{
      ok: boolean;
      warnings: string[];
      summary: { instances: number; categories: number };
    }>("/api/settings/import", { method: "POST", body: payload }),

  // Instances
  instances: () => request<Instance[]>("/api/instances"),
  createInstance: (body: Omit<Instance, "id">) =>
    request<Instance>("/api/instances", { method: "POST", body }),
  updateInstance: (id: string, body: Partial<Omit<Instance, "id">>) =>
    request<Instance>(`/api/instances/${id}`, { method: "PUT", body }),
  deleteInstance: (id: string) =>
    request<void>(`/api/instances/${id}`, { method: "DELETE" }),
  testInstance: (id: string) =>
    request<{ ok: boolean; appName?: string; version?: string; error?: string }>(
      `/api/instances/${id}/test`,
      { method: "POST" },
    ),
  /** Test unsaved values (the Test button in the add/edit form). */
  testDraftInstance: (body: { kind: "series" | "movie"; baseUrl: string; apiKey: string }) =>
    request<{ ok: boolean; appName?: string; version?: string; error?: string }>(
      "/api/instances/test",
      { method: "POST", body },
    ),
  dropdowns: (id: string) =>
    request<{
      rootFolders: { id: number; path: string; accessible: boolean }[];
      qualityProfiles: { id: number; name: string }[];
      tags: { id: number; label: string }[];
    }>(`/api/instances/${id}/dropdowns`),
  lookup: (id: string, term: string) =>
    request<Record<string, unknown>[]>(
      `/api/instances/${id}/lookup?term=${encodeURIComponent(term)}`,
    ),

  // Categories
  categories: () => request<Category[]>("/api/categories"),
  createCategory: (body: Omit<Category, "id">) =>
    request<Category>("/api/categories", { method: "POST", body }),
  updateCategory: (id: string, body: Partial<Omit<Category, "id">>) =>
    request<Category>(`/api/categories/${id}`, { method: "PUT", body }),
  deleteCategory: (id: string) =>
    request<void>(`/api/categories/${id}`, { method: "DELETE" }),

  // Filesystem + analysis
  listDirs: (path?: string) =>
    request<{
      path: string;
      parent: string | null;
      dirs: { name: string; path: string }[];
    }>(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  analyze: (path: string) =>
    request<AnalyzeResponse>("/api/analyze", { method: "POST", body: { path } }),

  // Import
  /** Advisory check: can the category's instance see the drop once staged? */
  importCheck: (categoryId: string, sourcePath: string) =>
    request<StagingCheckResponse>(
      `/api/import/check?categoryId=${encodeURIComponent(categoryId)}&sourcePath=${encodeURIComponent(sourcePath)}`,
    ),
  startImport: (body: ImportRequestBody) =>
    request<{ jobId: string }>("/api/import", { method: "POST", body }),
  /** Fan-out import: one pipeline (job) per item, run sequentially server-side. */
  startImportBatch: (body: { items: ImportRequestBody[] }) =>
    request<{ jobs: { jobId: string }[] }>("/api/import/batch", {
      method: "POST",
      body,
    }),
  job: (id: string) =>
    request<{ id: string; events: JobEvent[]; finished: boolean }>(
      `/api/jobs/${id}`,
    ),

  // Uploads
  uploads: (dropId: string) =>
    request<UploadListResponse>(
      `/api/uploads?dropId=${encodeURIComponent(dropId)}`,
    ),

  // History
  history: () => request<HistoryEntry[]>("/api/history"),
};

export interface StagingCheckResponse {
  /** Configured staging dir (Settings) or planned drop dir (wizard). */
  stagingDir: string;
  /** Planned drop dir as the target instance sees it (wizard only). */
  instanceDir?: string;
  issues: StagingCheckIssue[];
}

/** Quarantine volume state for Settings → Uploads. */
export interface DiskStatus {
  quarantineDir: string;
  freeBytes: number;
  totalBytes: number;
  minFreeSpaceBytes: number;
  belowThreshold: boolean;
}

/** One cleanup pass over the quarantine dir (mirrors the server result). */
export interface SweepResult {
  at: string;
  retentionDays: number;
  cutoff: string;
  staleUploads: number;
  sweptDrops: number;
  orphanDirs: number;
  freedBytes: number;
  skippedLocked: number;
  errors: string[];
}

export interface CleanupStatus {
  retentionDays: number;
  started: boolean;
  running: boolean;
  intervalMs: number;
  lastResult?: SweepResult;
}

export interface AnalyzeResponse {
  sourcePath: string;
  dropName: string;
  /** Whole-drop analysis (the single-item heuristics). */
  analysis: FolderAnalysis;
  /**
   * Reviewable items: one per movie when the drop fanned out, else a single
   * item. Each carries the absolute path to import from.
   */
  items: (FolderAnalysisItem & { sourcePath: string })[];
  totalBytes: number;
  skipped: string[];
}

export interface ImportRequestBody {
  sourcePath: string;
  categoryId: string;
  match: {
    tvdbId?: number;
    tmdbId?: number;
    title: string;
    year?: number;
    extra?: Record<string, unknown>;
  };
  seasons?: number[];
  importMode: "move" | "copy";
  /**
   * Optional subset of the drop's media files (relative to sourcePath) to
   * stage and import. Fanned-out items pass this for files that sit loose at
   * a shared drop root; whole-drop imports omit it.
   */
  files?: string[];
}

export interface JobEvent {
  type: "job";
  jobId: string;
  phase:
    | "queued"
    | "staging"
    | "adding"
    | "preflight"
    | "import"
    | "cleanup"
    | "done"
    | "error";
  message: string;
  at: string;
  progress?: number;
  copiedBytes?: number;
  totalBytes?: number;
  filesCopied?: number;
  totalFiles?: number;
  command?: { id: number; name: string; status: string; message?: string };
  error?: string;
  result?: {
    importedFiles: number;
    rejectedFiles: { path: string; reasons: string[] }[];
    historyId: string;
  };
}

type JobListener = (e: JobEvent) => void;
type UploadListener = (e: UploadEvent) => void;
type RevokedListener = () => void;

// One shared WebSocket for all consumers (live job progress, upload progress
// and session revocation notices). Frames are routed by `type`; job frames
// without a `type` are legacy job events.
const jobListeners = new Set<JobListener>();
const uploadListeners = new Set<UploadListener>();
const revokedListeners = new Set<RevokedListener>();
let socket: WebSocket | null = null;

function ensureSocket(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  if (
    jobListeners.size === 0 &&
    uploadListeners.size === 0 &&
    revokedListeners.size === 0
  ) {
    return;
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/ws`);
  socket = ws;
  ws.onmessage = (msg) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.data as string);
    } catch {
      return; // ignore malformed frames
    }
    const type =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { type?: string }).type
        : undefined;
    if (type === "session-revoked") {
      for (const listener of [...revokedListeners]) listener();
      return;
    }
    if (type === "upload") {
      for (const listener of [...uploadListeners]) {
        listener(parsed as UploadEvent);
      }
      return;
    }
    for (const listener of [...jobListeners]) listener(parsed as JobEvent);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
  };
}

/** Subscribe to live job progress. Returns an unsubscribe function. */
export function connectJobEvents(onEvent: JobListener): () => void {
  jobListeners.add(onEvent);
  ensureSocket();
  return () => {
    jobListeners.delete(onEvent);
  };
}

/** Subscribe to live upload progress. Returns an unsubscribe function. */
export function connectUploadEvents(onEvent: UploadListener): () => void {
  uploadListeners.add(onEvent);
  ensureSocket();
  return () => {
    uploadListeners.delete(onEvent);
  };
}

/** Notified when the server revokes the session behind this browser. */
export function connectSessionRevoked(onRevoked: RevokedListener): () => void {
  revokedListeners.add(onRevoked);
  ensureSocket();
  return () => {
    revokedListeners.delete(onRevoked);
  };
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
