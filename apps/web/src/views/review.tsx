import { useCallback, useEffect, useRef, useState } from "react";
import type { FolderAnalysis, SubmissionState } from "@droparr/shared";
import { api, formatBytes, type JobEvent } from "../api";
import { timelineFor, type TimelineStepStatus } from "./timeline";

/** Colored state chip for submissions (and job-backed views). */
export function StateBadge({ state }: { state: SubmissionState }) {
  const styles: Record<SubmissionState, string> = {
    uploading: "bg-zinc-800 text-zinc-400",
    analyzing: "bg-zinc-800 text-zinc-400",
    pending: "bg-amber-950 text-amber-400",
    approved: "bg-sky-950 text-sky-400",
    importing: "bg-sky-950 text-sky-400",
    done: "bg-emerald-950 text-emerald-400",
    failed: "bg-red-950 text-red-400",
    rejected: "bg-red-950 text-red-400",
  };
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${styles[state]}`}
    >
      {state}
    </span>
  );
}

/** Vertical lifecycle stepper for one submission (submitter status page). */
export function SubmissionTimeline({ state }: { state: SubmissionState }) {
  const steps = timelineFor(state);
  return (
    <ol>
      {steps.map((step, i) => (
        <li key={step.id} className="flex gap-3">
          <div className="flex flex-col items-center">
            <StepDot status={step.status} />
            {i < steps.length - 1 && (
              <span className="w-px flex-1 bg-zinc-800" />
            )}
          </div>
          <span
            className={`pb-3 pt-0.5 text-sm ${
              step.status === "current"
                ? "text-zinc-100"
                : step.status === "failed"
                  ? "text-red-400"
                  : step.status === "done"
                    ? "text-zinc-400"
                    : "text-zinc-600"
            }`}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepDot({ status }: { status: TimelineStepStatus }) {
  if (status === "done") {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-[10px] text-emerald-100">
        ✓
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-800 text-[10px] text-red-100">
        ✕
      </span>
    );
  }
  if (status === "current") {
    return (
      <span className="mt-0.5 h-4 w-4 shrink-0 animate-pulse rounded-full border-2 border-emerald-500" />
    );
  }
  return (
    <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-zinc-700" />
  );
}

/** One pipeline of a batch import, tracked by jobId. */
export interface BatchJobState {
  jobId: string;
  title: string;
  subPath: string;
  events: JobEvent[];
  final: JobEvent | null;
}

export const PHASE_LABEL: Record<string, string> = {
  staging: "Staging files",
  adding: "Adding to library",
  preflight: "Preflight",
  import: "Importing",
  cleanup: "Cleaning up",
  done: "Done",
  error: "Failed",
};

/**
 * The analysis card shared by the admin import wizard and the approval
 * queue. Title/year are editable when change handlers are passed.
 */
export function AnalysisCard({
  analysis,
  sourcePath,
  title,
  year,
  onTitleChange,
  onYearChange,
  onBack,
  skipped,
  totalBytes,
}: {
  analysis: FolderAnalysis;
  sourcePath: string;
  title: string;
  year?: number;
  onTitleChange?: (t: string) => void;
  onYearChange?: (y?: number) => void;
  onBack?: () => void;
  /** Count of non-media files the walker skipped. */
  skipped?: number;
  /** Overrides the sum of the listed file sizes. */
  totalBytes?: number;
}) {
  const a = analysis;
  const confidenceColor =
    a.confidence === "high"
      ? "text-emerald-400"
      : a.confidence === "medium"
        ? "text-amber-400"
        : "text-red-400";
  const bytes =
    totalBytes ?? a.files.reduce((sum, file) => sum + file.size, 0);
  const editable = !!onTitleChange && !!onYearChange;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 uppercase tracking-wide">
              {a.kind}
            </span>
            {a.seriesType && (
              <span className="rounded bg-zinc-800 px-1.5 py-0.5">
                {a.seriesType}
              </span>
            )}
            <span className={confidenceColor}>{a.confidence} confidence</span>
          </div>
          <p className="text-xs text-zinc-500 font-mono mt-2">{sourcePath}</p>
        </div>
        {onBack && (
          <button
            onClick={onBack}
            className="shrink-0 text-xs text-zinc-400 hover:text-zinc-200"
          >
            change drop
          </button>
        )}
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block space-y-1.5">
          <span className="text-xs text-zinc-400">Detected title</span>
          <input
            value={title}
            readOnly={!editable}
            onChange={(e) => onTitleChange?.(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none read-only:text-zinc-400"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs text-zinc-400">Year</span>
          <input
            type="number"
            value={year ?? ""}
            readOnly={!editable}
            onChange={(e) =>
              onYearChange?.(e.target.value ? Number(e.target.value) : undefined)
            }
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none read-only:text-zinc-400"
          />
        </label>
      </div>

      <div className="text-xs text-zinc-500 space-y-1">
        <div>
          {a.files.length} file(s) · {formatBytes(bytes)}
          {a.season !== undefined && <> · season {a.season}</>}
          {a.episodeNumbers && a.episodeNumbers.length > 0 && (
            <> · episodes {a.episodeNumbers.join(", ")}</>
          )}
        </div>
        {a.reasoning.length > 0 && (
          <div className="text-zinc-600">{a.reasoning.join(" · ")}</div>
        )}
        {skipped !== undefined && skipped > 0 && (
          <div className="text-zinc-600">
            skipped {skipped} non-media file(s)
          </div>
        )}
      </div>
    </div>
  );
}

/** Match search through one *arr instance's own lookup API. */
export function MatchSearch({
  instanceId,
  initialTerm,
  kind,
  selected,
  onSelect,
}: {
  instanceId: string;
  initialTerm: string;
  kind: "series" | "movie";
  selected: Record<string, unknown> | null;
  onSelect: (m: Record<string, unknown> | null) => void;
}) {
  const [term, setTerm] = useState(initialTerm);
  const [results, setResults] = useState<Record<string, unknown>[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searched = useRef(false);

  const search = useCallback(
    async (t: string) => {
      setSearching(true);
      setError(null);
      try {
        setResults(await api.lookup(instanceId, t));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSearching(false);
      }
    },
    [instanceId],
  );

  // Auto-search once with the initial term.
  useEffect(() => {
    if (!searched.current && initialTerm.trim()) {
      searched.current = true;
      void search(initialTerm);
    }
  }, [initialTerm, search]);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && term.trim() && search(term)}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
        />
        <button
          disabled={searching || !term.trim()}
          onClick={() => search(term)}
          className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          {searching ? "…" : "Search"}
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {selected && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm">
          <span className="text-emerald-300">
            ✓ {selected.title as string}
            {selected.year ? ` (${selected.year as number})` : ""}
          </span>
        </div>
      )}

      <div className="space-y-1 max-h-64 overflow-auto">
        {results.map((r, i) => {
          const key =
            kind === "series" ? (r.tvdbId as number) : (r.tmdbId as number);
          const isSelected =
            selected &&
            key !== undefined &&
            selected[kind === "series" ? "tvdbId" : "tmdbId"] === key;
          const poster = (
            r.images as { coverType: string; remoteUrl?: string }[] | undefined
          )?.find((img) => img.coverType === "poster")?.remoteUrl;
          return (
            <button
              key={`${key ?? i}`}
              onClick={() => onSelect(r)}
              className={`w-full flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                isSelected
                  ? "border-emerald-700 bg-emerald-950/30"
                  : "border-zinc-800 hover:border-zinc-600 hover:bg-zinc-800/40"
              }`}
            >
              {poster ? (
                <img
                  src={poster}
                  alt=""
                  className="h-12 w-8 rounded object-cover bg-zinc-800"
                />
              ) : (
                <div className="h-12 w-8 rounded bg-zinc-800" />
              )}
              <div className="min-w-0">
                <div className="text-sm truncate">
                  {r.title as string}
                  {r.year ? (
                    <span className="text-zinc-500">
                      {" "}
                      ({r.year as number})
                    </span>
                  ) : null}
                </div>
                <div className="text-xs text-zinc-500 truncate">
                  {kind === "series" ? "TVDB" : "TMDB"} {String(key ?? "—")}
                </div>
              </div>
            </button>
          );
        })}
        {!searching && results.length === 0 && term && (
          <p className="text-xs text-zinc-600 px-1">No results.</p>
        )}
      </div>
    </div>
  );
}

/** Live progress for a single pipeline. */
export function ProgressStep({
  events,
  finalEvent,
  onReset,
  resetLabel = "Add another drop",
}: {
  events: JobEvent[];
  finalEvent: JobEvent | null;
  /** Omit for a read-only progress view (submitter status page). */
  onReset?: () => void;
  resetLabel?: string;
}) {
  const last = events[events.length - 1];
  const staging = events.filter((e) => e.phase === "staging");
  const stagingProgress =
    staging.length > 0 ? staging[staging.length - 1].progress : undefined;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 space-y-5">
      <div className="flex items-center gap-3">
        {finalEvent?.phase === "done" ? (
          <span className="text-2xl">✅</span>
        ) : finalEvent?.phase === "error" ? (
          <span className="text-2xl">❌</span>
        ) : (
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-400" />
        )}
        <div>
          <h2 className="text-lg font-medium">
            {finalEvent
              ? finalEvent.phase === "done"
                ? "Import complete"
                : "Import failed"
              : PHASE_LABEL[last?.phase ?? "queued"] ?? "Working…"}
          </h2>
          <p className="text-sm text-zinc-400">{last?.message}</p>
        </div>
      </div>

      {!finalEvent && stagingProgress !== undefined && (
        <div className="space-y-1">
          <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${Math.round(stagingProgress * 100)}%` }}
            />
          </div>
          <p className="text-xs text-zinc-500">
            {last?.filesCopied ?? 0}/{last?.totalFiles ?? 0} files ·{" "}
            {formatBytes(last?.copiedBytes ?? 0)} /{" "}
            {formatBytes(last?.totalBytes ?? 0)}
          </p>
        </div>
      )}

      {finalEvent?.phase === "done" && finalEvent.result && (
        <div className="text-sm text-zinc-300 space-y-1">
          <p>
            {finalEvent.result.importedFiles} file(s) imported natively by the
            *arr.
          </p>
          {finalEvent.result.rejectedFiles.length > 0 && (
            <div className="text-amber-400">
              {finalEvent.result.rejectedFiles.length} file(s) rejected:
              <ul className="list-disc pl-5 text-xs mt-1">
                {finalEvent.result.rejectedFiles.map((r, i) => (
                  <li key={i}>
                    {r.path} — {r.reasons.join("; ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {finalEvent?.phase === "error" && (
        <p className="text-sm text-red-400">{finalEvent.error}</p>
      )}

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 max-h-64 overflow-auto space-y-1">
        {events.map((e, i) => (
          <div key={i} className="text-xs flex gap-3">
            <span className="text-zinc-600 font-mono shrink-0">
              {new Date(e.at).toLocaleTimeString()}
            </span>
            <span
              className={
                e.phase === "error"
                  ? "text-red-400"
                  : e.phase === "done"
                    ? "text-emerald-400"
                    : "text-zinc-400"
              }
            >
              [{e.phase}] {e.message}
            </span>
          </div>
        ))}
      </div>

      {onReset && (finalEvent || events.length > 0) && (
        <button
          onClick={onReset}
          className="rounded-md bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium"
        >
          {resetLabel}
        </button>
      )}
    </div>
  );
}

/** Live progress for a batch (one pipeline per fanned-out item). */
export function BatchProgressStep({
  jobs,
  onReset,
  resetLabel = "Add another drop",
}: {
  jobs: BatchJobState[];
  /** Omit for a read-only progress view (submitter status page). */
  onReset?: () => void;
  resetLabel?: string;
}) {
  const finished = jobs.filter((j) => j.final).length;
  const succeeded = jobs.filter((j) => j.final?.phase === "done").length;
  const allDone = finished === jobs.length;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 space-y-5">
      <div className="flex items-center gap-3">
        {!allDone ? (
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-400" />
        ) : succeeded === jobs.length ? (
          <span className="text-2xl">✅</span>
        ) : (
          <span className="text-2xl">⚠️</span>
        )}
        <div>
          <h2 className="text-lg font-medium">
            {!allDone
              ? `Importing ${finished}/${jobs.length}…`
              : succeeded === jobs.length
                ? "All imports complete"
                : `Imported ${succeeded} of ${jobs.length}`}
          </h2>
          <p className="text-sm text-zinc-400">
            Each movie ran its own pipeline and history entry.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {jobs.map((job) => {
          const last = job.events[job.events.length - 1];
          const stagingProgress =
            !job.final && last?.phase === "staging" ? last.progress : undefined;
          return (
            <div
              key={job.jobId}
              className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm truncate">
                  {job.title}
                  {job.subPath && (
                    <span className="text-xs text-zinc-500 font-mono">
                      {" "}
                      · {job.subPath}
                    </span>
                  )}
                </span>
                <span
                  className={`shrink-0 text-xs ${
                    job.final?.phase === "done"
                      ? "text-emerald-400"
                      : job.final?.phase === "error"
                        ? "text-red-400"
                        : "text-zinc-500"
                  }`}
                >
                  {job.final
                    ? job.final.phase === "done"
                      ? "done"
                      : "failed"
                    : PHASE_LABEL[last?.phase ?? "queued"] ?? "queued"}
                </span>
              </div>
              <p className="text-xs text-zinc-500 truncate">
                {job.final?.phase === "error" ? job.final.error : last?.message}
              </p>
              {stagingProgress !== undefined && (
                <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${Math.round(stagingProgress * 100)}%` }}
                  />
                </div>
              )}
              {job.final?.phase === "done" && job.final.result && (
                <p className="text-xs text-zinc-400">
                  {job.final.result.importedFiles} file(s) imported
                  {job.final.result.rejectedFiles.length > 0 && (
                    <span className="text-amber-400">
                      {" "}
                      · {job.final.result.rejectedFiles.length} rejected
                    </span>
                  )}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {onReset && allDone && (
        <button
          onClick={onReset}
          className="rounded-md bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium"
        >
          {resetLabel}
        </button>
      )}
    </div>
  );
}
