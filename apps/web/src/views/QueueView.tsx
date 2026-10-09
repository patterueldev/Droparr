import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FolderAnalysisItem,
  MatchSelection,
  SubmissionItem,
} from "@droparr/shared";
import {
  api,
  connectSubmissionEvents,
  type SubmissionItemPatch,
} from "../api";
import {
  AnalysisCard,
  BatchProgressStep,
  MatchSearch,
  ProgressStep,
  StateBadge,
  type BatchJobState,
} from "./review";
import { useJobProgress } from "./useJobProgress";

/** Locally editable state of one queue item. */
interface QueueItem {
  subPath: string;
  sourcePath: string;
  analysis: FolderAnalysisItem;
  title: string;
  year?: number;
  categoryId?: string;
  match: MatchSelection | null;
  seasons: number[];
  include: boolean;
}

function toQueueItem(item: SubmissionItem): QueueItem {
  return {
    subPath: item.subPath,
    sourcePath: item.sourcePath,
    analysis: item.analysis,
    title: item.title,
    year: item.year,
    categoryId: item.categoryId,
    match: item.match ?? null,
    seasons: item.seasons ?? [],
    include: item.include,
  };
}

function itemPatch(item: QueueItem): SubmissionItemPatch {
  return {
    subPath: item.subPath,
    include: item.include,
    title: item.title,
    year: item.year ?? null,
    categoryId: item.categoryId,
    match: item.match,
    seasons: item.seasons,
  };
}

function selectionFromRaw(
  kind: "series" | "movie",
  raw: Record<string, unknown>,
  fallbackTitle: string,
): MatchSelection {
  return {
    tvdbId:
      kind === "series" && typeof raw.tvdbId === "number"
        ? raw.tvdbId
        : undefined,
    tmdbId:
      kind === "movie" && typeof raw.tmdbId === "number"
        ? raw.tmdbId
        : undefined,
    title: typeof raw.title === "string" ? raw.title : fallbackTitle,
    year: typeof raw.year === "number" ? raw.year : undefined,
    extra: raw,
  };
}

export default function QueueView() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const { data: submissions = [], isPending } = useQuery({
    queryKey: ["submissions", showAll ? "all" : "pending"],
    queryFn: () => api.submissions(showAll ? undefined : "pending"),
  });

  // Queue stays live: any submission transition refreshes the list.
  useEffect(
    () =>
      connectSubmissionEvents(() => {
        void queryClient.invalidateQueries({ queryKey: ["submissions"] });
      }),
    [queryClient],
  );

  if (selectedId) {
    return (
      <SubmissionDetail
        id={selectedId}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">Approval queue</h2>
          <p className="text-sm text-zinc-400">
            Submitter drops wait here until you approve or reject them.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
          />
          Show all
        </label>
      </div>

      {isPending ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : submissions.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
          <p className="text-sm text-zinc-400">
            {showAll
              ? "No submissions yet."
              : "No submissions waiting for approval."}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 divide-y divide-zinc-800/70">
          {submissions.map((submission) => (
            <button
              key={submission.id}
              onClick={() => setSelectedId(submission.id)}
              className="w-full px-4 py-3 text-left hover:bg-zinc-800/40 transition-colors"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm truncate">{submission.dropName}</span>
                <StateBadge state={submission.state} />
              </div>
              <p className="text-xs text-zinc-500 mt-1">
                {submission.submitterName ?? "submitter"} ·{" "}
                {submission.items.length > 1
                  ? `${submission.items.length} items`
                  : submission.items[0]?.title ?? "—"}{" "}
                · {new Date(submission.createdAt).toLocaleString()}
              </p>
              {submission.state === "rejected" && submission.note && (
                <p className="text-xs text-red-400 mt-0.5">
                  {submission.note}
                </p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SubmissionDetail({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: submission } = useQuery({
    queryKey: ["submission", id],
    queryFn: () => api.submission(id),
  });
  const { data: instances = [] } = useQuery({
    queryKey: ["instances"],
    queryFn: api.instances,
  });
  const { data: categories = [] } = useQuery({
    queryKey: ["categories"],
    queryFn: api.categories,
  });

  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [importMode, setImportMode] = useState<"move" | "copy">("copy");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize the editor once per submission; later refetches must not
  // clobber edits that have not been sent yet.
  useEffect(() => {
    if (submission && items === null) {
      setItems(submission.items.map(toQueueItem));
      setImportMode(submission.importMode);
    }
  }, [submission, items]);

  useEffect(
    () =>
      connectSubmissionEvents((e) => {
        if (e.submissionId === id) {
          void queryClient.invalidateQueries({ queryKey: ["submission", id] });
        }
        void queryClient.invalidateQueries({ queryKey: ["submissions"] });
      }),
    [id, queryClient],
  );

  // Live job progress for an approved/importing (or finished) submission.
  const jobIds = submission?.jobIds ?? [];
  const jobStates = useJobProgress(jobIds);

  const updateItem = (index: number, patch: Partial<QueueItem>) => {
    setItems(
      (prev) =>
        prev?.map((item, i) =>
          i === index ? { ...item, ...patch } : item,
        ) ?? prev,
    );
  };

  const approve = async () => {
    if (!submission || !items) return;
    setBusy(true);
    setError(null);
    try {
      await api.approveSubmission(submission.id, {
        importMode,
        items: items.map(itemPatch),
      });
      void queryClient.invalidateQueries({ queryKey: ["submission", id] });
      void queryClient.invalidateQueries({ queryKey: ["submissions"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!submission) return;
    setBusy(true);
    setError(null);
    try {
      await api.rejectSubmission(submission.id, note.trim() || undefined);
      void queryClient.invalidateQueries({ queryKey: ["submissions"] });
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!submission) {
    return <p className="text-sm text-zinc-500">Loading submission…</p>;
  }

  const running =
    submission.state === "approved" || submission.state === "importing";
  const terminal =
    submission.state === "done" ||
    submission.state === "failed" ||
    submission.state === "rejected";
  // runApproval creates one job per INCLUDED item, in order — align the
  // progress rows with that same subset.
  const includedItems = (items ?? submission.items).filter((i) => i.include);
  const jobList: BatchJobState[] = jobIds.map((jobId, index) => {
    const state = jobStates.get(jobId);
    return {
      jobId,
      title: includedItems[index]?.title ?? `Item ${index + 1}`,
      subPath: includedItems[index]?.subPath ?? "",
      events: state?.events ?? [],
      final: state?.final ?? null,
    };
  });
  // Keep showing the live widgets once they have real terminal events (the
  // done event carries the per-file results); otherwise fall back to a banner.
  const hasJobResults = jobList.some((j) => j.final !== null);
  const showProgress = running || (terminal && hasJobResults);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <button
          onClick={onBack}
          className="text-sm text-zinc-400 hover:text-zinc-200"
        >
          ← Queue
        </button>
        <StateBadge state={submission.state} />
      </div>

      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-1">
        <h2 className="text-lg font-medium">{submission.dropName}</h2>
        <p className="text-xs text-zinc-500">
          From {submission.submitterName ?? "submitter"} ·{" "}
          {new Date(submission.createdAt).toLocaleString()}
        </p>
        {submission.note && (
          <p className="text-xs text-red-400">Note: {submission.note}</p>
        )}
      </div>

      {showProgress && (
        <>
          {jobList.length > 0 ? (
            jobList.length === 1 ? (
              <ProgressStep
                events={jobList[0]!.events}
                finalEvent={jobList[0]!.final}
                onReset={onBack}
                resetLabel="Back to queue"
              />
            ) : (
              <BatchProgressStep
                jobs={jobList}
                onReset={onBack}
                resetLabel="Back to queue"
              />
            )
          ) : (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 flex items-center gap-3">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-400" />
              <p className="text-sm text-zinc-300">Importing…</p>
            </div>
          )}
        </>
      )}

      {terminal && !showProgress && (
        <div
          className={`rounded-xl border p-5 ${
            submission.state === "done"
              ? "border-emerald-900 bg-emerald-950/30"
              : "border-red-900 bg-red-950/30"
          }`}
        >
          <p className="text-sm">
            {submission.state === "done"
              ? "Import complete — see History for the imported files."
              : submission.state === "failed"
                ? "The import failed — check History for details."
                : "This submission was rejected."}
          </p>
        </div>
      )}

      {submission.state === "pending" && items && (
        <>
          {items.map((item, index) => {
            const eligible = categories.filter(
              (c) => c.kind === item.analysis.kind,
            );
            const category = eligible.find((c) => c.id === item.categoryId);
            const instance = instances.find(
              (i) => i.id === category?.instanceId,
            );
            const matchSeasons = (
              item.match?.extra?.seasons as
                | { seasonNumber: number }[]
                | undefined
            )
              ?.map((s) => s.seasonNumber)
              .sort((a, b) => a - b);
            const seasons = matchSeasons ?? item.seasons;
            return (
              <div
                key={item.subPath || "root"}
                className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={item.include}
                      onChange={(e) =>
                        updateItem(index, { include: e.target.checked })
                      }
                    />
                    Include in import
                  </label>
                  <span className="text-xs text-zinc-500 font-mono">
                    {item.subPath || "drop root"}
                  </span>
                </div>

                <AnalysisCard
                  analysis={item.analysis}
                  sourcePath={item.sourcePath}
                  title={item.title}
                  year={item.year}
                  onTitleChange={(t) => updateItem(index, { title: t })}
                  onYearChange={(y) => updateItem(index, { year: y })}
                />

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-4">
                    <h3 className="font-medium">Match</h3>
                    {instance ? (
                      <MatchSearch
                        key={`${item.subPath}-${instance.id}`}
                        instanceId={instance.id}
                        initialTerm={`${item.title}${item.year ? ` ${item.year}` : ""}`}
                        kind={item.analysis.kind}
                        selected={item.match as unknown as Record<
                          string,
                          unknown
                        > | null}
                        onSelect={(raw) => {
                          if (!raw) {
                            updateItem(index, { match: null });
                            return;
                          }
                          const match = selectionFromRaw(
                            item.analysis.kind,
                            raw,
                            item.title,
                          );
                          updateItem(index, {
                            match,
                            title: match.title,
                            year: match.year,
                          });
                        }}
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
                        value={item.categoryId ?? ""}
                        onChange={(e) =>
                          updateItem(index, {
                            categoryId: e.target.value || undefined,
                          })
                        }
                        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                      >
                        <option value="">— pick one —</option>
                        {eligible.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    {item.analysis.kind === "series" &&
                      seasons &&
                      seasons.length > 0 && (
                        <div className="space-y-1.5">
                          <span className="text-xs text-zinc-400">
                            Seasons to monitor
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {seasons.map((s) => (
                              <button
                                key={s}
                                onClick={() =>
                                  updateItem(index, {
                                    seasons: item.seasons.includes(s)
                                      ? item.seasons.filter((x) => x !== s)
                                      : [...item.seasons, s].sort(
                                          (a, b) => a - b,
                                        ),
                                  })
                                }
                                className={`rounded-md border px-3 py-1.5 text-sm ${
                                  item.seasons.includes(s)
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
                  </div>
                </div>
              </div>
            );
          })}

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-4">
            <label className="block space-y-1.5">
              <span className="text-xs text-zinc-400">File handling</span>
              <select
                value={importMode}
                onChange={(e) =>
                  setImportMode(e.target.value as "copy" | "move")
                }
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
              >
                <option value="copy">Copy (keep original files)</option>
                <option value="move">
                  Move (remove originals after import)
                </option>
              </select>
            </label>

            <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
              <button
                disabled={busy}
                onClick={() => void approve()}
                className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-5 py-2 text-sm font-medium"
              >
                {busy ? "Working…" : "Approve & import"}
              </button>
              <div className="flex flex-1 gap-2 sm:justify-end">
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Reject note (optional)"
                  className="flex-1 sm:max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                />
                <button
                  disabled={busy}
                  onClick={() => void reject()}
                  className="rounded-md border border-red-900 px-4 py-2 text-sm text-red-400 hover:bg-red-950/40 disabled:opacity-40"
                >
                  Reject
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
