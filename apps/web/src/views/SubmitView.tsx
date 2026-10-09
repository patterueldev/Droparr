import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  MatchSelection,
  Submission,
} from "@droparr/shared";
import {
  api,
  connectSubmissionEvents,
  type SubmissionAnalyzeResponse,
  type SubmissionItemPatch,
} from "../api";
import UploadPanel from "./UploadPanel";
import { AnalysisCard, StateBadge } from "./review";

type Phase = "upload" | "review" | "sent";

/** Locally editable state of one reviewable item. */
interface ReviewItem {
  subPath: string;
  title: string;
  year?: number;
  match: MatchSelection | null;
  seasons?: number[];
}

export default function SubmitView() {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>("upload");
  const [dropId, setDropId] = useState("");
  const [result, setResult] = useState<SubmissionAnalyzeResponse | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submission | null>(null);

  // "Search again" state for the suggested match (single-item drops).
  const [term, setTerm] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Record<string, unknown>[] | null>(
    null,
  );

  const { data: uploadConfig } = useQuery({
    queryKey: ["upload-config"],
    queryFn: api.uploadConfig,
  });
  const { data: mySubmissions = [] } = useQuery({
    queryKey: ["submissions"],
    queryFn: () => api.submissions(),
  });

  // Live state: any of my submissions changing refreshes the list.
  useEffect(
    () =>
      connectSubmissionEvents(() => {
        void queryClient.invalidateQueries({ queryKey: ["submissions"] });
      }),
    [queryClient],
  );

  const handleAnalyze = useCallback(async (_path: string, drop: string) => {
    setBusy(true);
    setError(null);
    try {
      const analyzed = await api.submissionAnalyze(drop);
      setDropId(drop);
      setResult(analyzed);
      setItems(
        analyzed.items.map((item) => ({
          subPath: item.subPath,
          title: item.title,
          year: item.year,
          match: item.suggestedMatch ?? null,
          seasons:
            item.kind === "series"
              ? item.season !== undefined
                ? [item.season]
                : item.episodeNumbers && item.episodeNumbers.length > 0
                  ? [1]
                  : []
              : undefined,
        })),
      );
      setTerm("");
      setResults(null);
      setPhase("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const updateItem = useCallback(
    (index: number, patch: Partial<ReviewItem>) => {
      setItems((prev) =>
        prev.map((item, i) => (i === index ? { ...item, ...patch } : item)),
      );
    },
    [],
  );

  const search = useCallback(async () => {
    const value = term.trim();
    if (!value || !dropId) return;
    setSearching(true);
    setError(null);
    try {
      const res = await api.submissionAnalyze(dropId, value);
      setResults(res.results ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [term, dropId]);

  const pickResult = useCallback(
    (raw: Record<string, unknown>) => {
      const kind = result?.analysis.kind ?? "movie";
      const title = typeof raw.title === "string" ? raw.title : "";
      const year = typeof raw.year === "number" ? raw.year : undefined;
      const match: MatchSelection = {
        tvdbId: kind === "series" ? (raw.tvdbId as number | undefined) : undefined,
        tmdbId: kind === "movie" ? (raw.tmdbId as number | undefined) : undefined,
        title,
        year,
        extra: raw,
      };
      updateItem(0, { match, title, year });
      setResults(null);
    },
    [result, updateItem],
  );

  const submit = useCallback(async () => {
    if (!result || !dropId) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        dropId,
        importMode: "copy" as const,
        items: items.map(
          (item): SubmissionItemPatch => ({
            subPath: item.subPath,
            title: item.title,
            year: item.year ?? null,
            match: item.match,
            seasons: item.seasons,
          }),
        ),
      };
      const submission = await api.createSubmission(body);
      setSubmitted(submission);
      setPhase("sent");
      void queryClient.invalidateQueries({ queryKey: ["submissions"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [result, dropId, items, queryClient]);

  const reset = () => {
    setPhase("upload");
    setResult(null);
    setItems([]);
    setResults(null);
    setTerm("");
    setSubmitted(null);
    setError(null);
  };

  const single = result?.items.length === 1;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/50 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {phase === "upload" && (
        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
            <h2 className="text-lg font-medium">Drop files for the library</h2>
            <p className="text-sm text-zinc-400 mt-1">
              Upload a movie folder, a season, or a whole series. Your drop is
              reviewed before anything is imported.
            </p>
          </div>
          <UploadPanel
            uploadSettings={uploadConfig}
            onAnalyze={(path, drop) => void handleAnalyze(path, drop)}
          />
        </div>
      )}

      {phase === "review" && result && (
        <div className="space-y-4">
          {single ? (
            <>
              <AnalysisCard
                analysis={result.analysis}
                sourcePath={result.sourcePath}
                title={items[0]?.title ?? ""}
                year={items[0]?.year}
                onTitleChange={(t) => updateItem(0, { title: t })}
                onYearChange={(y) => updateItem(0, { year: y })}
              />
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-4">
                <h3 className="font-medium">Match</h3>
                <MatchSummary
                  match={items[0]?.match ?? null}
                  kind={result.analysis.kind}
                />
                <div className="flex gap-2">
                  <input
                    value={term}
                    onChange={(e) => setTerm(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void search()}
                    placeholder={`Search ${result.analysis.kind === "series" ? "TV" : "movies"} by title…`}
                    className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                  />
                  <button
                    disabled={searching || !term.trim()}
                    onClick={() => void search()}
                    className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                  >
                    {searching ? "…" : "Search"}
                  </button>
                </div>
                {results && (
                  <LookupResults
                    results={results}
                    kind={result.analysis.kind}
                    onPick={pickResult}
                  />
                )}
                {result.analysis.kind === "series" &&
                  result.analysis.season !== undefined && (
                    <SeasonToggle
                      seasons={[result.analysis.season]}
                      selected={items[0]?.seasons ?? []}
                      onChange={(s) => updateItem(0, { seasons: s })}
                    />
                  )}
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
                <h2 className="font-medium">
                  {result.items.length} movies in this drop
                </h2>
                <p className="text-sm text-zinc-400 mt-1">
                  Each folder is imported on its own. An admin can adjust any
                  match after you submit.
                </p>
              </div>
              {result.items.map((item, index) => (
                <div
                  key={`${item.subPath || "root"}-${index}`}
                  className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-3"
                >
                  <AnalysisCard
                    analysis={item}
                    sourcePath={item.sourcePath}
                    title={items[index]?.title ?? item.title}
                    year={items[index]?.year}
                    onTitleChange={(t) => updateItem(index, { title: t })}
                    onYearChange={(y) => updateItem(index, { year: y })}
                  />
                  <MatchSummary
                    match={items[index]?.match ?? null}
                    kind={item.kind}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between gap-4">
            <button
              onClick={reset}
              className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              ← Start over
            </button>
            <button
              disabled={busy}
              onClick={() => void submit()}
              className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-5 py-2 text-sm font-medium"
            >
              {busy ? "Submitting…" : "Submit for approval"}
            </button>
          </div>
        </div>
      )}

      {phase === "sent" && submitted && (
        <div className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-6 space-y-2">
          <h2 className="text-lg font-medium text-emerald-300">
            {submitted.state === "pending"
              ? "Sent for approval"
              : "Import started"}
          </h2>
          <p className="text-sm text-zinc-300">
            {submitted.state === "pending"
              ? `"${submitted.dropName}" is waiting for an admin to review it. The status below updates live.`
              : `"${submitted.dropName}" is being imported — progress shows below.`}
          </p>
          <button
            onClick={reset}
            className="mt-2 rounded-md bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium"
          >
            Drop something else
          </button>
        </div>
      )}

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wide">
          My submissions
        </h2>
        {mySubmissions.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing submitted yet.</p>
        ) : (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 divide-y divide-zinc-800/70">
            {mySubmissions.map((submission) => (
              <div key={submission.id} className="px-4 py-3 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm truncate">
                    {submission.dropName}
                  </span>
                  <StateBadge state={submission.state} />
                </div>
                <p className="text-xs text-zinc-500">
                  {new Date(submission.createdAt).toLocaleString()}
                  {submission.items.length > 1 &&
                    ` · ${submission.items.length} items`}
                </p>
                {submission.state === "rejected" && submission.note && (
                  <p className="text-xs text-red-400">
                    Rejected: {submission.note}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MatchSummary({
  match,
  kind,
}: {
  match: MatchSelection | null;
  kind: "series" | "movie";
}) {
  if (!match) {
    return (
      <p className="text-sm text-zinc-500">
        No suggested match — an admin will match this from the queue.
      </p>
    );
  }
  const poster = (
    match.extra?.images as
      | { coverType: string; remoteUrl?: string }[]
      | undefined
  )?.find((img) => img.coverType === "poster")?.remoteUrl;
  return (
    <div className="flex items-center gap-3">
      {poster ? (
        <img
          src={poster}
          alt=""
          className="h-16 w-11 rounded object-cover bg-zinc-800"
        />
      ) : (
        <div className="h-16 w-11 rounded bg-zinc-800" />
      )}
      <div>
        <p className="text-sm">
          <span className="text-emerald-300">✓ {match.title}</span>
          {match.year && <span className="text-zinc-500"> ({match.year})</span>}
        </p>
        <p className="text-xs text-zinc-500">
          {kind === "series" ? "TVDB" : "TMDB"}{" "}
          {kind === "series" ? match.tvdbId : match.tmdbId}
        </p>
      </div>
    </div>
  );
}

function LookupResults({
  results,
  kind,
  onPick,
}: {
  results: Record<string, unknown>[];
  kind: "series" | "movie";
  onPick: (raw: Record<string, unknown>) => void;
}) {
  if (results.length === 0) {
    return <p className="text-xs text-zinc-600">No results.</p>;
  }
  return (
    <div className="space-y-1 max-h-64 overflow-auto">
      {results.map((raw, i) => {
        const key =
          kind === "series" ? (raw.tvdbId as number) : (raw.tmdbId as number);
        const poster = (
          raw.images as { coverType: string; remoteUrl?: string }[] | undefined
        )?.find((img) => img.coverType === "poster")?.remoteUrl;
        return (
          <button
            key={`${key ?? i}`}
            onClick={() => onPick(raw)}
            className="w-full flex items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2 text-left hover:border-zinc-600 hover:bg-zinc-800/40"
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
                {raw.title as string}
                {raw.year ? (
                  <span className="text-zinc-500"> ({raw.year as number})</span>
                ) : null}
              </div>
              <div className="text-xs text-zinc-500 truncate">
                {kind === "series" ? "TVDB" : "TMDB"} {String(key ?? "—")}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function SeasonToggle({
  seasons,
  selected,
  onChange,
}: {
  seasons: number[];
  selected: number[];
  onChange: (s: number[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs text-zinc-400">Seasons to monitor</span>
      <div className="flex flex-wrap gap-2">
        {seasons.map((s) => (
          <button
            key={s}
            onClick={() =>
              onChange(
                selected.includes(s)
                  ? selected.filter((x) => x !== s)
                  : [...selected, s].sort((a, b) => a - b),
              )
            }
            className={`rounded-md border px-3 py-1.5 text-sm ${
              selected.includes(s)
                ? "border-emerald-600 bg-emerald-950/50 text-emerald-300"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
            }`}
          >
            S{s === 0 ? "pecials" : s}
          </button>
        ))}
      </div>
    </div>
  );
}
