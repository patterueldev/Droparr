import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { pickDefaultCategory } from "@droparr/core";
import type { Category, Instance, UploadSettings } from "@droparr/shared";
import {
  api,
  connectJobEvents,
  formatBytes,
  type AnalyzeResponse,
  type JobEvent,
} from "../api";
import UploadPanel from "./UploadPanel";
import {
  AnalysisCard,
  BatchProgressStep,
  MatchSearch,
  ProgressStep,
  type BatchJobState,
} from "./review";

type Step = "pick" | "review" | "running" | "done";

type AnalysisResult = AnalyzeResponse;

/** One reviewable item of a fanned-out multi-movie drop. */
interface FanoutItemState {
  /** Absolute path to import from (the item's folder, or the drop root). */
  sourcePath: string;
  /** Path from the drop root; "" for files sitting at the drop root itself. */
  subPath: string;
  analysis: AnalyzeResponse["items"][number];
  title: string;
  year?: number;
  categoryId: string;
  match: Record<string, unknown> | null;
  include: boolean;
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

  // Multi-movie fan-out review (null unless the drop fanned out).
  const [fanoutItems, setFanoutItems] = useState<FanoutItemState[] | null>(null);

  // Running state
  const [jobId, setJobId] = useState<string | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [finalEvent, setFinalEvent] = useState<JobEvent | null>(null);
  const [batchJobs, setBatchJobs] = useState<BatchJobState[]>([]);
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

  // Track each pipeline of a fan-out batch import by its jobId.
  useEffect(() => {
    if (step !== "running" || batchJobs.length === 0) return;
    const disconnect = connectJobEvents((e) => {
      setBatchJobs((prev) => {
        const idx = prev.findIndex((j) => j.jobId === e.jobId);
        if (idx === -1) return prev;
        const job = prev[idx];
        const next = [...prev];
        next[idx] = {
          ...job,
          events: [...job.events, e],
          final: e.phase === "done" || e.phase === "error" ? e : job.final,
        };
        return next;
      });
    });
    return disconnect;
  }, [step, batchJobs.length]);

  // The batch is done when every pipeline reported a terminal event.
  useEffect(() => {
    if (step !== "running" || batchJobs.length === 0) return;
    if (batchJobs.every((j) => j.final)) {
      setStep("done");
      void queryClient.invalidateQueries({ queryKey: ["history"] });
    }
  }, [step, batchJobs, queryClient]);

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
      // Multiple items → one reviewable card per item.
      setFanoutItems(
        result.items.length > 1
          ? result.items.map((item) => ({
              sourcePath: item.sourcePath,
              subPath: item.subPath,
              analysis: item,
              title: item.title,
              year: item.year,
              categoryId: "",
              match: null,
              include: true,
            }))
          : null,
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

  const updateFanoutItem = useCallback(
    (index: number, patch: Partial<FanoutItemState>) => {
      setFanoutItems(
        (prev) =>
          prev?.map((item, i) =>
            i === index ? { ...item, ...patch } : item,
          ) ?? prev,
      );
    },
    [],
  );

  const handleBatchImport = useCallback(async () => {
    if (!drop || !fanoutItems) return;
    const included = fanoutItems.filter((item) => item.include);
    if (
      included.length === 0 ||
      included.some((item) => !item.match || !item.categoryId)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { jobs } = await api.startImportBatch({
        items: included.map((item) => {
          const match = item.match ?? {};
          return {
            sourcePath: item.sourcePath,
            categoryId: item.categoryId,
            match: {
              tmdbId: match.tmdbId as number | undefined,
              title: (match.title as string) ?? item.title,
              year: (match.year as number) ?? item.year,
              extra: match,
            },
            importMode,
            // Files at the drop root are shared with the sibling folders —
            // import only this item's files.
            files:
              item.subPath === ""
                ? item.analysis.files.map((f) => f.path)
                : undefined,
          };
        }),
      });
      setBatchJobs(
        jobs.map((job, i) => ({
          jobId: job.jobId,
          title:
            (included[i].match?.title as string) ?? included[i].title,
          subPath: included[i].subPath,
          events: [],
          final: null,
        })),
      );
      setEvents([]);
      setFinalEvent(null);
      setJobId(null);
      setStep("running");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [drop, fanoutItems, importMode]);

  const reset = () => {
    setStep("pick");
    setDrop(null);
    setMatch(null);
    setEvents([]);
    setFinalEvent(null);
    setJobId(null);
    setFanoutItems(null);
    setBatchJobs([]);
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
          uploadSettings={settings?.uploads}
          onAnalyze={handleAnalyze}
          onOpenSettings={onOpenSettings}
        />
      )}

      {step === "review" && drop && fanoutItems && (
        <MultiReviewStep
          drop={drop}
          items={fanoutItems}
          categories={categories}
          instances={instances}
          importMode={importMode}
          busy={busy}
          onUpdateItem={updateFanoutItem}
          onImportModeChange={setImportMode}
          onBack={reset}
          onImport={handleBatchImport}
        />
      )}

      {step === "review" && drop && !fanoutItems && (
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
          onOpenSettings={onOpenSettings}
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

      {(step === "running" || step === "done") &&
        (batchJobs.length > 0 ? (
          <BatchProgressStep jobs={batchJobs} onReset={reset} />
        ) : (
          <ProgressStep
            events={events}
            finalEvent={finalEvent}
            onReset={reset}
          />
        ))}
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
  uploadSettings,
  onAnalyze,
  onOpenSettings,
}: {
  busy: boolean;
  stagingDir: string;
  uploadSettings?: UploadSettings;
  onAnalyze: (path: string) => void;
  onOpenSettings: () => void;
}) {
  const [mode, setMode] = useState<"path" | "upload">("path");

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-1 w-fit">
        {(
          [
            ["path", "Server path"],
            ["upload", "Upload from device"],
          ] as [typeof mode, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              mode === id
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {label}
          </button>
        ))}
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

      {mode === "path" ? (
        <PathPicker busy={busy} onAnalyze={onAnalyze} />
      ) : (
        <UploadPanel uploadSettings={uploadSettings} onAnalyze={onAnalyze} />
      )}
    </div>
  );
}

function PathPicker({
  busy,
  onAnalyze,
}: {
  busy: boolean;
  onAnalyze: (path: string) => void;
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
  onOpenSettings,
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
  categories: Category[];
  busy: boolean;
  onOpenSettings: () => void;
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

  // Preselect a category from the analysis (anime drops → anime category);
  // the review always allows an override. Only fires while nothing is selected.
  const preferredCategory = useMemo(
    () => pickDefaultCategory(categories, analysis),
    [categories, analysis],
  );
  useEffect(() => {
    if (!categoryId && preferredCategory) {
      onCategoryChange(preferredCategory.id);
    }
  }, [categoryId, preferredCategory, onCategoryChange]);

  const instance = instances.find((i) => i.id === category?.instanceId);

  // Advisory pre-import check: can the instance see the staged drop? Never blocks.
  const { data: stagingCheck, isError: checkFailed } = useQuery({
    queryKey: ["import-check", categoryId, drop.sourcePath],
    queryFn: () => api.importCheck(categoryId, drop.sourcePath),
    enabled: !!categoryId,
  });

  const matchSeasons = useMemo(() => {
    const s = match?.seasons as { seasonNumber: number }[] | undefined;
    return s?.map((x) => x.seasonNumber).sort((a, b) => a - b) ?? [];
  }, [match]);

  return (
    <div className="space-y-4">
      <AnalysisCard
        analysis={drop.analysis}
        sourcePath={drop.sourcePath}
        title={title}
        year={year}
        onTitleChange={onTitleChange}
        onYearChange={onYearChange}
        onBack={onBack}
        skipped={drop.skipped.length}
        totalBytes={drop.totalBytes}
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

      {stagingCheck && stagingCheck.issues.length > 0 && (
        <div className="rounded-lg border border-amber-900 bg-amber-950/40 px-4 py-3 space-y-2">
          <div className="flex items-start justify-between gap-4">
            <p className="text-sm font-medium text-amber-300">
              Staging visibility check
            </p>
            <button
              onClick={onOpenSettings}
              className="shrink-0 rounded-md border border-amber-700 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-900/40"
            >
              Fix in settings
            </button>
          </div>
          {stagingCheck.issues.map((issue, i) => (
            <div key={`${issue.code}-${issue.instanceId ?? i}`} className="space-y-0.5">
              <p className="text-sm text-amber-300">{issue.message}</p>
              {issue.suggestion && (
                <p className="text-xs text-amber-400/80">{issue.suggestion}</p>
              )}
            </div>
          ))}
        </div>
      )}
      {checkFailed && (
        <p className="text-xs text-zinc-500">
          Could not check staging visibility.
        </p>
      )}

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

// ---------------------------------------------------------------- Fan-out review

function MultiReviewStep({
  drop,
  items,
  categories,
  instances,
  importMode,
  busy,
  onUpdateItem,
  onImportModeChange,
  onBack,
  onImport,
}: {
  drop: AnalysisResult;
  items: FanoutItemState[];
  categories: Category[];
  instances: Instance[];
  importMode: "copy" | "move";
  busy: boolean;
  onUpdateItem: (index: number, patch: Partial<FanoutItemState>) => void;
  onImportModeChange: (m: "copy" | "move") => void;
  onBack: () => void;
  onImport: () => void;
}) {
  const included = items.filter((i) => i.include);
  const ready = included.every((i) => i.categoryId && i.match);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-900/60 bg-amber-950/20 p-5 space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 uppercase tracking-wide">
                multi-movie drop
              </span>
              <span className="text-amber-400">
                {items.length} movies detected
              </span>
            </div>
            <p className="text-xs text-zinc-500 font-mono mt-2">
              {drop.sourcePath}
            </p>
            <p className="text-xs text-zinc-500 mt-1">
              {items.length} items · {formatBytes(drop.totalBytes)}
              {drop.skipped.length > 0 && (
                <> · skipped {drop.skipped.length} non-media file(s)</>
              )}
            </p>
          </div>
          <button
            onClick={onBack}
            className="shrink-0 text-xs text-zinc-400 hover:text-zinc-200"
          >
            change drop
          </button>
        </div>
        {drop.analysis.reasoning.length > 0 && (
          <div className="text-xs text-zinc-600">
            {drop.analysis.reasoning.join(" · ")}
          </div>
        )}
      </div>

      {items.map((item, index) => (
        <FanoutItemCard
          key={`${item.subPath}-${index}`}
          index={index}
          item={item}
          categories={categories}
          instances={instances}
          onUpdate={onUpdateItem}
        />
      ))}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            ← Back
          </button>
          <label className="flex items-center gap-2">
            <span className="text-xs text-zinc-400">File handling</span>
            <select
              value={importMode}
              onChange={(e) =>
                onImportModeChange(e.target.value as "copy" | "move")
              }
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
            >
              <option value="copy">Copy (keep originals)</option>
              <option value="move">Move (remove originals)</option>
            </select>
          </label>
        </div>
        <button
          disabled={busy || included.length === 0 || !ready}
          onClick={onImport}
          className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-5 py-2 text-sm font-medium"
        >
          {busy
            ? "Starting…"
            : `Import ${included.length} movie${included.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}

function FanoutItemCard({
  index,
  item,
  categories,
  instances,
  onUpdate,
}: {
  index: number;
  item: FanoutItemState;
  categories: Category[];
  instances: Instance[];
  onUpdate: (index: number, patch: Partial<FanoutItemState>) => void;
}) {
  const analysis = item.analysis;
  const eligibleCategories = categories.filter((c) => c.kind === analysis.kind);
  const category = eligibleCategories.find((c) => c.id === item.categoryId);
  const instance = instances.find((i) => i.id === category?.instanceId);

  // Preselect like the single-item review; the admin can always override.
  const preferredCategory = useMemo(
    () => pickDefaultCategory(categories, analysis),
    [categories, analysis],
  );
  useEffect(() => {
    if (!item.categoryId && preferredCategory) {
      onUpdate(index, { categoryId: preferredCategory.id });
    }
  }, [item.categoryId, preferredCategory, index, onUpdate]);

  const confidenceColor =
    analysis.confidence === "high"
      ? "text-emerald-400"
      : analysis.confidence === "medium"
        ? "text-amber-400"
        : "text-red-400";

  return (
    <div
      className={`rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-4 ${
        item.include ? "" : "opacity-60"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <label className="flex items-center gap-3 cursor-pointer select-none min-w-0">
          <input
            type="checkbox"
            checked={item.include}
            onChange={(e) => onUpdate(index, { include: e.target.checked })}
            className="h-4 w-4 shrink-0 rounded border-zinc-600 bg-zinc-900 accent-emerald-600"
          />
          <span className="text-xs text-zinc-500 truncate">
            {item.subPath ? (
              <span className="font-mono">{item.subPath}</span>
            ) : (
              "files at the drop root"
            )}
          </span>
        </label>
        <span className={`shrink-0 text-xs ${confidenceColor}`}>
          {analysis.confidence} confidence
        </span>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_5.5rem] gap-3">
            <label className="block space-y-1.5">
              <span className="text-xs text-zinc-400">Detected title</span>
              <input
                value={item.title}
                onChange={(e) => onUpdate(index, { title: e.target.value })}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs text-zinc-400">Year</span>
              <input
                type="number"
                value={item.year ?? ""}
                onChange={(e) =>
                  onUpdate(index, {
                    year: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
              />
            </label>
          </div>
          <div className="text-xs text-zinc-500 space-y-1">
            <div>{analysis.files.length} file(s)</div>
            {analysis.reasoning.length > 0 && (
              <div className="text-zinc-600">
                {analysis.reasoning.join(" · ")}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-xs text-zinc-400">Category</span>
            <select
              value={item.categoryId}
              onChange={(e) => onUpdate(index, { categoryId: e.target.value })}
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
            >
              {eligibleCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {instance ? (
            <MatchSearch
              instanceId={instance.id}
              initialTerm={`${item.title}${item.year ? ` ${item.year}` : ""}`}
              kind={analysis.kind}
              selected={item.match}
              onSelect={(m) =>
                onUpdate(index, {
                  match: m,
                  ...(m
                    ? {
                        title: (m.title as string) ?? item.title,
                        year: m.year as number | undefined,
                      }
                    : {}),
                })
              }
            />
          ) : (
            <p className="text-sm text-zinc-500">
              {eligibleCategories.length === 0
                ? `No ${analysis.kind} categories configured.`
                : "Pick a category to search its instance."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

