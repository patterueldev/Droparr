import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Submission } from "@droparr/shared";
import { api, connectSubmissionEvents } from "../api";
import {
  BatchProgressStep,
  ProgressStep,
  StateBadge,
  SubmissionTimeline,
  type BatchJobState,
} from "./review";
import { useJobProgress } from "./useJobProgress";

/**
 * Submitter status page: my submissions, newest first, with live state.
 * `type: "submission"` frames invalidate the list; the detail view also
 * replays and streams the import jobs (both owner-scoped server-side).
 */
export default function StatusView({
  onOpenSubmit,
}: {
  onOpenSubmit: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const {
    data: submissions,
    isPending,
    isError,
    refetch,
  } = useQuery({
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

  if (selectedId) {
    return (
      <SubmissionStatus id={selectedId} onBack={() => setSelectedId(null)} />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-medium">My drops</h2>
        <p className="text-sm text-zinc-400">
          Everything you have submitted, with live status.
        </p>
      </div>

      {isPending ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : isError ? (
        <div className="rounded-xl border border-red-900 bg-red-950/40 p-8 text-center space-y-3">
          <p className="text-sm text-red-300">
            Couldn't load your submissions.
          </p>
          <button
            onClick={() => void refetch()}
            className="rounded-md border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
          >
            Retry
          </button>
        </div>
      ) : submissions.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center space-y-3">
          <p className="text-sm text-zinc-400">
            Nothing here yet — drop a folder and it shows up here with live
            status.
          </p>
          <button
            onClick={onOpenSubmit}
            className="rounded-md bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium"
          >
            Drop files →
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 divide-y divide-zinc-800/70">
          {submissions.map((submission) => (
            <SubmissionRow
              key={submission.id}
              submission={submission}
              onOpen={() => setSelectedId(submission.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SubmissionRow({
  submission,
  onOpen,
}: {
  submission: Submission;
  onOpen: () => void;
}) {
  const items = submission.items.filter((item) => item.include);
  const summary =
    items.length > 1
      ? `${items.length} items`
      : (items[0]?.title ?? submission.dropName);
  return (
    <button
      onClick={onOpen}
      className="w-full px-4 py-3 text-left hover:bg-zinc-800/40 transition-colors space-y-1"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm truncate">{submission.dropName}</span>
        <StateBadge state={submission.state} />
      </div>
      <p className="text-xs text-zinc-500">
        {summary} · {new Date(submission.createdAt).toLocaleString()}
      </p>
      {submission.state === "rejected" && (
        <p className="text-xs text-red-400">
          {submission.note
            ? `Rejected: ${submission.note}`
            : "Rejected by an admin."}
        </p>
      )}
    </button>
  );
}

function SubmissionStatus({ id, onBack }: { id: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const {
    data: submission,
    isError,
  } = useQuery({
    queryKey: ["submission", id],
    queryFn: () => api.submission(id),
  });

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

  // Live import progress for an approved/importing (or finished) submission.
  const jobIds = submission?.jobIds ?? [];
  const jobStates = useJobProgress(jobIds);

  if (isError) {
    return (
      <div className="space-y-4">
        <BackButton onBack={onBack} />
        <p className="text-sm text-zinc-500">
          This submission could not be found.
        </p>
      </div>
    );
  }

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
  const includedItems = submission.items.filter((item) => item.include);
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
  const hasJobResults = jobList.some((job) => job.final !== null);
  const showProgress = running || (terminal && hasJobResults);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <BackButton onBack={onBack} label="← My drops" />
        <StateBadge state={submission.state} />
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-1">
        <h2 className="text-lg font-medium">{submission.dropName}</h2>
        <p className="text-xs text-zinc-500">
          Submitted {new Date(submission.createdAt).toLocaleString()}
          {includedItems.length > 1 && ` · ${includedItems.length} items`}
        </p>
        {includedItems.length > 0 && (
          <ul className="text-xs text-zinc-500 pt-1 space-y-0.5">
            {includedItems.map((item) => (
              <li key={item.subPath || "root"} className="truncate">
                {item.title}
                {item.year ? ` (${item.year})` : ""}
              </li>
            ))}
          </ul>
        )}
        {submission.state === "rejected" && (
          <p className="text-sm text-red-400 pt-1">
            {submission.note
              ? `Rejected: ${submission.note}`
              : "Rejected by an admin."}
          </p>
        )}
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h3 className="font-medium mb-4">Status</h3>
        <SubmissionTimeline state={submission.state} />
        {submission.state === "pending" && (
          <p className="text-xs text-zinc-500 mt-2">
            Waiting for an admin to review this drop. They can adjust the match
            before approving it.
          </p>
        )}
        {submission.state === "done" && !showProgress && (
          <p className="text-xs text-emerald-400 mt-2">Import complete.</p>
        )}
        {submission.state === "failed" && !showProgress && (
          <p className="text-xs text-red-400 mt-2">
            The import failed — ask an admin to check the server logs.
          </p>
        )}
      </div>

      {showProgress &&
        (jobList.length > 0 ? (
          jobList.length === 1 ? (
            <ProgressStep
              events={jobList[0]!.events}
              finalEvent={jobList[0]!.final}
            />
          ) : (
            <BatchProgressStep jobs={jobList} />
          )
        ) : (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 flex items-center gap-3">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-400" />
            <p className="text-sm text-zinc-300">Importing…</p>
          </div>
        ))}
    </div>
  );
}

function BackButton({
  onBack,
  label = "← Back",
}: {
  onBack: () => void;
  label?: string;
}) {
  return (
    <button
      onClick={onBack}
      className="text-sm text-zinc-400 hover:text-zinc-200"
    >
      {label}
    </button>
  );
}
