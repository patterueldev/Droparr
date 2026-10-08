import type {
  Category,
  DroparrConfig,
  FolderAnalysis,
  HistoryEntry,
  Instance,
  UploadEvent,
  UploadListResponse,
} from "@droparr/shared";

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
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { error?: unknown };
      if (data.error) {
        detail = Array.isArray(data.error)
          ? data.error.join("; ")
          : typeof data.error === "string"
            ? data.error
            : JSON.stringify(data.error);
      }
    } catch {
      // keep the status text
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // Config
  settings: () => request<DroparrConfig>("/api/settings"),
  updateSettings: (body: Partial<DroparrConfig>) =>
    request<DroparrConfig>("/api/settings", { method: "PUT", body }),
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
    request<{
      sourcePath: string;
      dropName: string;
      analysis: FolderAnalysis;
      totalBytes: number;
      skipped: string[];
    }>("/api/analyze", { method: "POST", body: { path } }),

  // Import
  startImport: (body: {
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
  }) => request<{ jobId: string }>("/api/import", { method: "POST", body }),
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

export interface JobEvent {
  type: "job";
  jobId: string;
  phase:
    | "queued"
    | "staging"
    | "adding"
    | "preflight"
    | "import"
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

/** Server event stream: import jobs and upload progress share one socket. */
export type ServerEvent = JobEvent | UploadEvent;

export function connectEvents(onEvent: (e: ServerEvent) => void): () => void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/ws`);
  ws.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data as string) as ServerEvent;
      if (event?.type === "job" || event?.type === "upload") onEvent(event);
    } catch {
      // ignore malformed frames
    }
  };
  return () => ws.close();
}

export function connectJobEvents(onEvent: (e: JobEvent) => void): () => void {
  return connectEvents((e) => {
    if (e.type === "job") onEvent(e);
  });
}

export function connectUploadEvents(
  onEvent: (e: UploadEvent) => void,
): () => void {
  return connectEvents((e) => {
    if (e.type === "upload") onEvent(e);
  });
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
