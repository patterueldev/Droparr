import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FolderAnalysis, Instance } from "@droparr/shared";
import { api, connectJobEvents, formatBytes, type JobEvent } from "../api";

type Step = "pick" | "review" | "running" | "done";

interface AnalysisResult {
  sourcePath: string;
  dropName: string;
  analysis: FolderAnalysis;
  totalBytes: number;
  skipped: string[];
}

export default function ImportView({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const [step, setStep] = useState<Step>("pick");
  const [drop, setDrop] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Import config chosen in review
  const [categoryId, setCategoryId] = useState("");
  const [title, setTitle] = useState("");
  const [year, setYear] = useState<number | undefined>();
  const [match, setMatch] = useState<Record<string, unknown> | null>(null);
  const [seasons, setSeasons] = useState<number[]>([]);
  const [importMode, setImportMode] = useState<"copy" | "move">("copy");

  // Running state
  const [jobId, setJobId] = useState<string | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [finalEvent, setFinalEvent] = useState<JobEvent | null>(null);
  const queryClient = useQueryClient();

  const { data: instances = [] } = useQuery({
    queryKey: ["instances"],
    queryFn: api.instances,
  });
  const { data: categories = [] } = useQuery({
    queryKey: ["categories"],
    queryFn: api.categories,
  });
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: api.settings,
  });

  // Subscribe to job events while running.
  useEffect(() => {
    if (step !== "running" || !jobId) return;
    const disconnect = connectJobEvents((e) => {
      if (e.jobId !== jobId) return;
      setEvents((prev) => [...prev, e]);
      if (e.phase === "done" || e.phase === "error") {
        setFinalEvent(e);
        setStep("done");
        void queryClient.invalidateQueries({ queryKey: ["history"] });
      }
    });
    return disconnect;
  }, [step, jobId, queryClient]);

  const handleAnalyze = useCallback(async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.analyze(path);
      setDrop(result);
      setTitle(result.analysis.title);
      setYear(result.analysis.year);
      setMatch(null);
      setCategoryId("");
      // Pre-select seasons detected in the drop.
      setSeasons(
        result.analysis.season !== undefined
          ? [result.analysis.season]
          : result.analysis.episodeNumbers?.length
            ? [1]
            : [],
      );
      setStep("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleImport = useCallback(async () => {
    if (!drop || !match || !categoryId) return;
    setBusy(true);
    setError(null);
    try {
      const isSeries = drop.analysis.kind === "series";
      const { jobId } = await api.startImport({
        sourcePath: drop.sourcePath,
        categoryId,
        match: {
          tvdbId: isSeries ? (match.tvdbId as number) : undefined,
          tmdbId: !isSeries ? (match.tmdbId as number) : undefined,
          title: (match.title as string) ?? title,
          year: (match.year as number) ?? year,
          extra: match,
        },
        seasons: isSeries && seasons.length > 0 ? seasons : undefined,
        importMode,
      });
      setEvents([]);
      setFinalEvent(null);
      setJobId(jobId);
      setStep("running");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [drop, match, categoryId, title, year, seasons, importMode]);

  const reset = () => {
    setStep("pick");
    setDrop(null);
    setMatch(null);
    setEvents([]);
    setFinalEvent(null);
    setJobId(null);
    setError(null);
  };

  if (instances.length === 0) {
    return (
      <EmptyState
        title="No instances configured"
        body="Add your Sonarr/Radarr instances first, then create categories for routing drops."
        action="Open settings"
        onAction={onOpenSettings}
      />
    );
  }
  if (categories.length === 0) {
    return (
      <EmptyState
        title="No categories configured"
        body="Categories route drops to an instance with a root folder, quality profile and series type."
        action="Open settings"
        onAction={onOpenSettings}
      />
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {step === "pick" && (
        <PickStep
          busy={busy}
          stagingDir={settings?.stagingDir ?? ""}
          onAnalyze={handleAnalyze}
          onOpenSettings={onOpenSettings}
        />
      )}

      {step === "review" && drop && (
        <ReviewStep
          drop={drop}
          title={title}
          year={year}
          match={match}
          categoryId={categoryId}
          seasons={seasons}
          importMode={importMode}
          instances={instances}
          categories={categories}
          busy={busy}
          onTitleChange={setTitle}
          onYearChange={setYear}
          onMatchChange={(m) => {
            setMatch(m);
            if (m) {
              setTitle((m.title as string) ?? title);
              setYear(m.year as number | undefined);
              const s = m.seasons as { seasonNumber: number }[] | undefined;
              if (s) setSeasons(s.map((x) => x.seasonNumber));
            }
          }}
          onCategoryChange={setCategoryId}
          onSeasonsChange={setSeasons}
          onImportModeChange={setImportMode}
          onBack={reset}
          onImport={handleImport}
        />
      )}

      {(step === "running" || step === "done") && (
        <ProgressStep
          events={events}
          finalEvent={finalEvent}
          onReset={reset}
        />
      )}
    </div>
  );
}

function EmptyState({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center space-y-3">
      <h2 className="text-lg font-medium">{title}</h2>
      <p className="text-sm text-zinc-400 max-w-md mx-auto">{body}</p>
      <button
        onClick={onAction}
        className="mt-2 rounded-md bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium"
      >
        {action}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Pick

function PickStep({
  busy,
  stagingDir,
  onAnalyze,
  onOpenSettings,
}: {
  busy: boolean;
  stagingDir: string;
  onAnalyze: (path: string) => void;
  onOpenSettings: () => void;
}) {
  const [path, setPath] = useState("");
  const { data: listing } = useQuery({
    queryKey: ["fs", path],
    queryFn: () => api.listDirs(path || undefined),
  });

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 space-y-4">
      <div>
        <h2 className="text-lg font-medium">Add a drop</h2>
        <p className="text-sm text-zinc-400 mt-1">
          Point at a folder on this server — a movie folder, a season, or a
          whole series.
        </p>
      </div>

      {!stagingDir && (
        <div className="rounded-lg border border-amber-900 bg-amber-950/40 px-4 py-3 text-sm text-amber-300 flex items-center justify-between gap-4">
          <span>
            Staging directory is not set — imports need one that all *arrs can
            read.
          </span>
          <button
            onClick={onOpenSettings}
            className="shrink-0 rounded-md border border-amber-700 px-3 py-1.5 text-xs hover:bg-amber-900/40"
          >
            Set it
          </button>
        </div>
      )}

      <div className="flex gap-2">
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/media/incoming/Some Drop"
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-mono focus:border-emerald-600 focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && path.trim()) onAnalyze(path.trim());
          }}
        />
        <button
          disabled={busy || !path.trim()}
          onClick={() => onAnalyze(path.trim())}
          className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2 text-sm font-medium"
        >
          {busy ? "Analyzing…" : "Analyze"}
        </button>
      </div>

      {listing && (
        <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800/70 max-h-72 overflow-auto">
          <div className="px-3 py-2 text-xs text-zinc-500 flex items-center justify-between">
            <span className="font-mono truncate">{listing.path}</span>
            {listing.parent && (
              <button
                className="text-zinc-400 hover:text-zinc-200"
                onClick={() => setPath(listing.parent!)}
              >
                ↑ up
              </button>
            )}
          </div>
          {listing.dirs.map((d) => (
            <div
              key={d.path}
              className="px-3 py-2 flex items-center justify-between gap-3 hover:bg-zinc-800/40"
            >
              <button
                className="text-sm text-left truncate flex-1"
                onClick={() => setPath(d.path)}
                title="Browse into"
              >
                📁 {d.name}
              </button>
              <button
                className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-emerald-600 hover:text-emerald-400"
                onClick={() => onAnalyze(d.path)}
              >
                Analyze this
              </button>
            </div>
          ))}
          {listing.dirs.length === 0 && (
            <div className="px-3 py-4 text-sm text-zinc-500">
              No subfolders here.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Review

function ReviewStep({
  drop,
  title,
  year,
  match,
  categoryId,
  seasons,
  importMode,
  instances,
  categories,
  busy,
  onTitleChange,
  onYearChange,
  onMatchChange,
  onCategoryChange,
  onSeasonsChange,
  onImportModeChange,
  onBack,
  onImport,
}: {
  drop: AnalysisResult;
  title: string;
  year?: number;
  match: Record<string, unknown> | null;
  categoryId: string;
  seasons: number[];
  importMode: "copy" | "move";
  instances: Instance[];
  categories: { id: string; name: string; kind: string; instanceId: string }[];
  busy: boolean;
  onTitleChange: (t: string) => void;
  onYearChange: (y?: number) => void;
  onMatchChange: (m: Record<string, unknown> | null) => void;
  onCategoryChange: (id: string) => void;
  onSeasonsChange: (s: number[]) => void;
  onImportModeChange: (m: "copy" | "move") => void;
  onBack: () => void;
  onImport: () => void;
}) {
  const analysis = drop.analysis;
  const kind = analysis.kind;
  const eligibleCategories = categories.filter((c) => c.kind === kind);
  const category = eligibleCategories.find((c) => c.id === categoryId);

  // Default to the first eligible category.
  useEffect(() => {
    if (!categoryId && eligibleCategories.length > 0) {
      onCategoryChange(eligibleCategories[0].id);
    }
  }, [categoryId, eligibleCategories, onCategoryChange]);

  const instance = instances.find((i) => i.id === category?.instanceId);

  const matchSeasons = useMemo(() => {
    const s = match?.seasons as { seasonNumber: number }[] | undefined;
    return s?.map((x) => x.seasonNumber).sort((a, b) => a - b) ?? [];
  }, [match]);

  return (
    <div className="space-y-4">
      <AnalysisCard
        drop={drop}
        title={title}
        year={year}
        onTitleChange={onTitleChange}
        onYearChange={onYearChange}
        onBack={onBack}
      />

      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-4">
          <h3 className="font-medium">Match</h3>
          {instance ? (
            <MatchSearch
              instanceId={instance.id}
              initialTerm={`${title}${year ? ` ${year}` : ""}`}
              kind={kind}
              selected={match}
              onSelect={onMatchChange}
            />
          ) : (
            <p className="text-sm text-zinc-500">
              Pick a category to search its instance.
            </p>
          )}
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-4">
          <h3 className="font-medium">Routing</h3>
          <label className="block space-y-1.5">
            <span className="text-xs text-zinc-400">Category</span>
            <select
              value={categoryId}
              onChange={(e) => onCategoryChange(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
            >
              {eligibleCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          {kind === "series" && matchSeasons.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-xs text-zinc-400">Seasons to monitor</span>
              <div className="flex flex-wrap gap-2">
                {matchSeasons.map((s) => (
                  <button
                    key={s}
                    onClick={() =>
                      onSeasonsChange(
                        seasons.includes(s)
                          ? seasons.filter((x) => x !== s)
                          : [...seasons, s].sort((a, b) => a - b),
                      )
                    }
                    className={`rounded-md border px-3 py-1.5 text-sm ${
                      seasons.includes(s)
                        ? "border-emerald-600 bg-emerald-950/50 text-emerald-300"
                        : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                    }`}
                  >
                    S{s === 0 ? "pecials" : s}
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className="block space-y-1.5">
            <span className="text-xs text-zinc-400">File handling</span>
            <select
              value={importMode}
              onChange={(e) => onImportModeChange(e.target.value as "copy" | "move")}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
            >
              <option value="copy">Copy (keep original files)</option>
              <option value="move">Move (remove originals after import)</option>
            </select>
          </label>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <button
          onClick={onBack}
          className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          ← Back
        </button>
        <button
          disabled={busy || !match || !categoryId}
          onClick={onImport}
          className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-5 py-2 text-sm font-medium"
        >
          {busy ? "Starting…" : "Import"}
        </button>
      </div>
    </div>
  );
}

function AnalysisCard({
  drop,
  title,
  year,
  onTitleChange,
  onYearChange,
  onBack,
}: {
  drop: AnalysisResult;
  title: string;
  year?: number;
  onTitleChange: (t: string) => void;
  onYearChange: (y?: number) => void;
  onBack: () => void;
}) {
  const a = drop.analysis;
  const confidenceColor =
    a.confidence === "high"
      ? "text-emerald-400"
      : a.confidence === "medium"
        ? "text-amber-400"
        : "text-red-400";

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
          <p className="text-xs text-zinc-500 font-mono mt-2">{drop.sourcePath}</p>
        </div>
        <button
          onClick={onBack}
          className="shrink-0 text-xs text-zinc-400 hover:text-zinc-200"
        >
          change drop
        </button>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block space-y-1.5">
          <span className="text-xs text-zinc-400">Detected title</span>
          <input
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs text-zinc-400">Year</span>
          <input
            type="number"
            value={year ?? ""}
            onChange={(e) =>
              onYearChange(e.target.value ? Number(e.target.value) : undefined)
            }
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
          />
        </label>
      </div>

      <div className="text-xs text-zinc-500 space-y-1">
        <div>
          {a.files.length} file(s) · {formatBytes(drop.totalBytes)}
          {a.season !== undefined && <> · season {a.season}</>}
          {a.episodeNumbers && a.episodeNumbers.length > 0 && (
            <> · episodes {a.episodeNumbers.join(", ")}</>
          )}
        </div>
        {a.reasoning.length > 0 && (
          <div className="text-zinc-600">{a.reasoning.join(" · ")}</div>
        )}
        {drop.skipped.length > 0 && (
          <div className="text-zinc-600">
            skipped {drop.skipped.length} non-media file(s)
          </div>
        )}
      </div>
    </div>
  );
}

function MatchSearch({
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

// ---------------------------------------------------------------- Progress

function ProgressStep({
  events,
  finalEvent,
  onReset,
}: {
  events: JobEvent[];
  finalEvent: JobEvent | null;
  onReset: () => void;
}) {
  const last = events[events.length - 1];
  const staging = events.filter((e) => e.phase === "staging");
  const stagingProgress = staging.length > 0 ? staging[staging.length - 1].progress : undefined;

  const phaseLabel: Record<string, string> = {
    staging: "Staging files",
    adding: "Adding to library",
    preflight: "Preflight",
    import: "Importing",
    done: "Done",
    error: "Failed",
  };

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
              : phaseLabel[last?.phase ?? "queued"] ?? "Working…"}
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

      {(finalEvent || events.length > 0) && (
        <button
          onClick={onReset}
          className="rounded-md bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium"
        >
          Add another drop
        </button>
      )}
    </div>
  );
}
