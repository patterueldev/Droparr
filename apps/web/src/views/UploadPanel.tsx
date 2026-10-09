import { useCallback, useEffect, useRef, useState } from "react";
import * as tus from "tus-js-client";
import {
  allowedUploadExtensionsLabel,
  isAllowedUploadFileName,
  type Upload,
  type UploadSettings,
} from "@droparr/shared";
import { api, connectUploadEvents, formatBytes } from "../api";
import { filesFromDataTransfer, filesFromInputList } from "../upload/collect";
import { reconcileFile } from "../upload/reconcile";
import { createUpload } from "../upload/uploader";

const MAX_PARALLEL_FILES = 2;
const LAST_DROP_KEY = "droparr.lastUpload";

type FileStatus =
  | "queued"
  | "uploading"
  | "done"
  | "error"
  | "invalid"
  | "cancelled";

interface FileEntry {
  key: string;
  file: File;
  relPath: string;
  size: number;
  status: FileStatus;
  error?: string;
  sent: number;
  resuming?: boolean;
  /** Existing server upload to resume (HEAD) instead of creating a new one. */
  resumeUrl?: string;
}

interface LastDrop {
  dropId: string;
  files: { relPath: string; size: number }[];
  at: string;
}

function newDropId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function readLastDrop(): LastDrop | null {
  try {
    const raw = localStorage.getItem(LAST_DROP_KEY);
    return raw ? (JSON.parse(raw) as LastDrop) : null;
  } catch {
    return null;
  }
}

export default function UploadPanel({
  uploadSettings,
  onAnalyze,
}: {
  uploadSettings?: Pick<
    UploadSettings,
    "maxFileSizeBytes" | "maxSubmissionSizeBytes"
  >;
  onAnalyze: (path: string, dropId: string) => void;
}) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  // Resume the drop from the stored record so files re-added after a browser
  // restart reconcile against (and land in) the same quarantine dir.
  const [dropId, setDropId] = useState(
    () => readLastDrop()?.dropId ?? newDropId(),
  );
  const [dragOver, setDragOver] = useState(false);
  const [completePath, setCompletePath] = useState<string | undefined>();
  const [serverProgress, setServerProgress] = useState<{
    offset: number;
    total: number;
  } | null>(null);
  const [lastDrop, setLastDrop] = useState<LastDrop | null>(readLastDrop);

  const startedRef = useRef(new Set<string>());
  const uploadsRef = useRef(new Map<string, tus.Upload>());
  const entriesRef = useRef<FileEntry[]>([]);
  const serverOffsetsRef = useRef(new Map<string, { offset: number; size: number }>());
  /** Upload ids that belong to the current drop (from the reconcile fetch). */
  const serverIdsRef = useRef(new Set<string>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dirInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const validate = useCallback(
    (candidate: { relPath: string; size: number }, existing: FileEntry[]): string | undefined => {
      if (!isAllowedUploadFileName(candidate.relPath)) {
        return `Not an allowed media file (${allowedUploadExtensionsLabel()})`;
      }
      const maxFile = uploadSettings?.maxFileSizeBytes ?? 0;
      if (maxFile > 0 && candidate.size > maxFile) {
        return `Exceeds the per-file limit (${formatBytes(maxFile)})`;
      }
      if (existing.some((e) => e.relPath === candidate.relPath)) {
        return "Duplicate file in this drop";
      }
      const maxSubmission = uploadSettings?.maxSubmissionSizeBytes ?? 0;
      const total =
        existing.reduce((sum, e) => sum + (e.status === "invalid" ? 0 : e.size), 0) +
        candidate.size;
      if (maxSubmission > 0 && total > maxSubmission) {
        return `Exceeds the per-drop limit (${formatBytes(maxSubmission)})`;
      }
      return undefined;
    },
    [uploadSettings],
  );

  const persistLastDrop = useCallback(
    (list: FileEntry[]) => {
      const pending = list.filter(
        (e) => e.status === "queued" || e.status === "uploading",
      );
      if (pending.length === 0) return;
      const record: LastDrop = {
        dropId,
        files: list.map((e) => ({ relPath: e.relPath, size: e.size })),
        at: new Date().toISOString(),
      };
      localStorage.setItem(LAST_DROP_KEY, JSON.stringify(record));
      setLastDrop(record);
    },
    [dropId],
  );

  const addFiles = useCallback(
    async (dropped: { file: File; relPath: string }[]) => {
      if (dropped.length === 0) return;

      // Reconcile with the server first: already-complete files are marked
      // done (no re-upload) and in-progress files resume at the stored offset
      // in this same drop dir. This also keeps the drop association intact
      // after a browser restart.
      let existingByPath = new Map<string, Upload>();
      try {
        const res = await api.uploads(dropId);
        existingByPath = new Map(
          res.uploads
            .filter((u) => u.state !== "cancelled")
            .map((u) => [u.relPath, u]),
        );
      } catch {
        // Reconcile is best-effort; plain uploads still work.
      }
      serverIdsRef.current = new Set(
        [...existingByPath.values()].map((u) => u.id),
      );

      const next = [...entriesRef.current];
      for (const item of dropped) {
        const error = validate(
          { relPath: item.relPath, size: item.file.size },
          next,
        );
        let entry: FileEntry = {
          key: `${item.relPath}:${item.file.size}:${item.file.lastModified}`,
          file: item.file,
          relPath: item.relPath,
          size: item.file.size,
          status: error ? "invalid" : "queued",
          error,
          sent: 0,
        };
        const decision = error
          ? {}
          : reconcileFile({
              relPath: item.relPath,
              size: item.file.size,
              existingByPath,
            });
        if (decision.error) {
          entry = { ...entry, status: "invalid", error: decision.error };
        } else if (decision.alreadyCompleteSize !== undefined) {
          entry = {
            ...entry,
            status: "done",
            sent: decision.alreadyCompleteSize,
          };
        } else if (decision.resumeUrl) {
          entry = { ...entry, resuming: true, resumeUrl: decision.resumeUrl };
        }
        next.push(entry);
      }

      entriesRef.current = next;
      setEntries(next);
      persistLastDrop(next);
    },
    [dropId, persistLastDrop, validate],
  );

  const startEntry = useCallback(
    (entry: FileEntry) => {
      if (startedRef.current.has(entry.key)) return;
      startedRef.current.add(entry.key);
      setEntries((prev) =>
        prev.map((e) =>
          e.key === entry.key ? { ...e, status: "uploading", error: undefined } : e,
        ),
      );

      const upload = createUpload({
        file: entry.file,
        relPath: entry.relPath,
        dropId,
        uploadUrl: entry.resumeUrl,
        onProgress: (sent) => {
          setEntries((prev) =>
            prev.map((e) => (e.key === entry.key ? { ...e, sent } : e)),
          );
        },
        onSuccess: () => {
          setEntries((prev) =>
            prev.map((e) =>
              e.key === entry.key
                ? { ...e, status: "done", sent: entry.size }
                : e,
            ),
          );
        },
        onError: (message) => {
          setEntries((prev) =>
            prev.map((e) =>
              e.key === entry.key ? { ...e, status: "error", error: message } : e,
            ),
          );
        },
      });
      uploadsRef.current.set(entry.key, upload);

      void (async () => {
        try {
          if (!entry.resumeUrl) {
            // Fingerprint resume is a fallback only, and only when the stored
            // URL belongs to this drop — otherwise files could resume into an
            // older drop dir and this drop would never complete.
            const previous = await upload.findPreviousUploads();
            const previousId = previous[0]?.uploadUrl?.split("/").pop();
            if (
              previous.length > 0 &&
              previousId &&
              serverIdsRef.current.has(previousId)
            ) {
              upload.resumeFromPreviousUpload(previous[0]);
              setEntries((prev) =>
                prev.map((e) =>
                  e.key === entry.key ? { ...e, resuming: true } : e,
                ),
              );
            }
          }
          upload.start();
        } catch (err) {
          setEntries((prev) =>
            prev.map((e) =>
              e.key === entry.key
                ? {
                    ...e,
                    status: "error",
                    error: err instanceof Error ? err.message : String(err),
                  }
                : e,
            ),
          );
        }
      })();
    },
    [dropId],
  );

  // Upload scheduler: at most MAX_PARALLEL_FILES in flight. Entries whose
  // upload object was dropped (StrictMode remount, tab switch) restart here
  // and resume from the server offset via the stored fingerprint.
  useEffect(() => {
    const uploading = entries.filter(
      (e) => e.status === "uploading" && uploadsRef.current.has(e.key),
    ).length;
    if (uploading >= MAX_PARALLEL_FILES) return;
    const next = entries.find(
      (e) =>
        (e.status === "queued" || e.status === "uploading") &&
        !uploadsRef.current.has(e.key) &&
        !startedRef.current.has(e.key),
    );
    if (next) startEntry(next);
  }, [entries, startEntry]);

  // Pause in-flight uploads when the panel goes away (tab switch, review
  // step). Partial server state stays resumable; nothing silently completes
  // without the UI knowing.
  useEffect(() => {
    const activeUploads = uploadsRef.current;
    const started = startedRef.current;
    return () => {
      for (const upload of activeUploads.values()) void upload.abort(false);
      activeUploads.clear();
      started.clear();
    };
  }, []);

  // All files done → resolve the drop path so the existing review flow can run.
  useEffect(() => {
    const active = entries.filter((e) => e.status !== "invalid");
    if (active.length === 0 || !active.every((e) => e.status === "done")) return;
    localStorage.removeItem(LAST_DROP_KEY);
    setLastDrop(null);
    let cancelled = false;
    void api
      .uploads(dropId)
      .then((res) => {
        if (!cancelled) setCompletePath(res.completePath);
      })
      .catch(() => {
        // The per-file results are still shown; analyze can retry later.
      });
    return () => {
      cancelled = true;
    };
  }, [entries, dropId]);

  // Server-side progress over the shared WebSocket (offset events per upload).
  useEffect(() => {
    const disconnect = connectUploadEvents((event) => {
      if (event.dropId !== dropId) return;
      serverOffsetsRef.current.set(event.uploadId, {
        offset: event.offset,
        size: event.size,
      });
      let offset = 0;
      let total = 0;
      for (const value of serverOffsetsRef.current.values()) {
        offset += value.offset;
        total += value.size;
      }
      setServerProgress({ offset, total });
    });
    return disconnect;
  }, [dropId]);

  const cancelEntry = (entry: FileEntry) => {
    void uploadsRef.current.get(entry.key)?.abort(true);
    uploadsRef.current.delete(entry.key);
    setEntries((prev) =>
      prev.map((e) =>
        e.key === entry.key ? { ...e, status: "cancelled" } : e,
      ),
    );
  };

  const retryEntry = (entry: FileEntry) => {
    const upload = uploadsRef.current.get(entry.key);
    if (!upload) return;
    setEntries((prev) =>
      prev.map((e) =>
        e.key === entry.key ? { ...e, status: "uploading", error: undefined } : e,
      ),
    );
    upload.start();
  };

  const resetDrop = () => {
    // Terminate unfinished uploads server-side; never delete completed files
    // (the drop is still analyzable until the user chooses otherwise).
    for (const entry of entries) {
      if (entry.status === "done") continue;
      const upload = uploadsRef.current.get(entry.key);
      if (upload) void upload.abort(true);
    }
    uploadsRef.current.clear();
    startedRef.current.clear();
    serverOffsetsRef.current.clear();
    localStorage.removeItem(LAST_DROP_KEY);
    setEntries([]);
    setDropId(newDropId());
    setCompletePath(undefined);
    setServerProgress(null);
    setLastDrop(null);
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    void filesFromDataTransfer(event.dataTransfer).then(addFiles);
  };

  const active = entries.filter((e) => e.status !== "invalid");
  const uploadingCount = entries.filter((e) => e.status === "uploading").length;
  const allDone = active.length > 0 && active.every((e) => e.status === "done");

  return (
    <div className="space-y-4">
      {lastDrop && entries.length === 0 && (
        <div className="rounded-lg border border-sky-900 bg-sky-950/40 px-4 py-3 text-sm text-sky-300">
          A previous upload of {lastDrop.files.length} file(s) from{" "}
          {new Date(lastDrop.at).toLocaleString()} didn't finish. Re-add the
          same files to resume where the server left off.
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          dragOver
            ? "border-emerald-600 bg-emerald-950/20"
            : "border-zinc-700 bg-zinc-900/40"
        }`}
      >
        <p className="text-sm text-zinc-300">
          Drag & drop video files or a folder here
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          {allowedUploadExtensionsLabel()} · 32 MB chunks, resumes after
          interruptions
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Choose files
          </button>
          <button
            onClick={() => dirInputRef.current?.click()}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Choose folder
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(filesFromInputList(e.target.files));
            e.target.value = "";
          }}
        />
        <input
          ref={(el) => {
            dirInputRef.current = el;
            if (el) {
              el.setAttribute("webkitdirectory", "");
              el.setAttribute("directory", "");
            }
          }}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(filesFromInputList(e.target.files));
            e.target.value = "";
          }}
        />
      </div>

      {serverProgress && uploadingCount > 0 && (
        <p className="text-xs text-zinc-500">
          Server received {formatBytes(serverProgress.offset)} of{" "}
          {formatBytes(serverProgress.total)} (WebSocket)
        </p>
      )}

      {entries.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 divide-y divide-zinc-800/70">
          {entries.map((entry) => {
            const percent =
              entry.size > 0 ? Math.round((entry.sent / entry.size) * 100) : 0;
            return (
              <div key={entry.key} className="px-4 py-3 space-y-2">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{entry.relPath}</p>
                    <p className="text-xs text-zinc-500">
                      {formatBytes(entry.size)}
                      {entry.status === "uploading" && (
                        <>
                          {" "}
                          · {formatBytes(entry.sent)}
                          {entry.resuming && entry.sent > 0
                            ? ` (resumed from ${formatBytes(entry.sent)})`
                            : entry.resuming
                              ? " (resuming…)"
                              : ""}
                        </>
                      )}
                    </p>
                  </div>
                  <StatusBadge status={entry.status} />
                  {entry.status === "uploading" && (
                    <button
                      onClick={() => cancelEntry(entry)}
                      className="text-xs text-zinc-400 hover:text-red-400"
                    >
                      cancel
                    </button>
                  )}
                  {entry.status === "error" && (
                    <button
                      onClick={() => retryEntry(entry)}
                      className="text-xs text-zinc-400 hover:text-emerald-400"
                    >
                      retry
                    </button>
                  )}
                </div>
                {(entry.status === "uploading" || entry.status === "done") && (
                  <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className={`h-full transition-all ${
                        entry.status === "done" ? "bg-emerald-600" : "bg-emerald-500"
                      }`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                )}
                {entry.error && (
                  <p className="text-xs text-red-400">{entry.error}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <button
          onClick={resetDrop}
          disabled={entries.length === 0}
          className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          Reset
        </button>
        {allDone && completePath ? (
          <button
            onClick={() => onAnalyze(completePath, dropId)}
            className="rounded-md bg-emerald-600 hover:bg-emerald-500 px-5 py-2 text-sm font-medium"
          >
            Analyze drop →
          </button>
        ) : (
          <span className="text-xs text-zinc-500">
            {allDone
              ? "Waiting for the server to confirm the drop…"
              : uploadingCount > 0
                ? `Uploading ${uploadingCount} file(s)…`
                : ""}
          </span>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: FileStatus }) {
  const label: Record<FileStatus, string> = {
    queued: "queued",
    uploading: "uploading",
    done: "done",
    error: "failed",
    invalid: "rejected",
    cancelled: "cancelled",
  };
  const color: Record<FileStatus, string> = {
    queued: "text-zinc-400",
    uploading: "text-emerald-400",
    done: "text-emerald-400",
    error: "text-red-400",
    invalid: "text-red-400",
    cancelled: "text-zinc-500",
  };
  return (
    <span className={`shrink-0 text-xs ${color[status]}`}>{label[status]}</span>
  );
}
