import { useEffect, useState } from "react";
import { api, connectJobEvents, type JobEvent } from "../api";

export interface JobProgress {
  events: JobEvent[];
  final: JobEvent | null;
}

/**
 * Live progress for a set of jobs, keyed by job id: replays each job's events
 * via `GET /api/jobs/:id` (owner-scoped server-side) so a reconnect or a
 * freshly opened detail view catches up, then appends `type: "job"` frames
 * from the shared WebSocket. Finished jobs are pruned from the registry after
 * a while — a 404 replay is expected and the submission state tells the story.
 */
export function useJobProgress(jobIds: string[]): Map<string, JobProgress> {
  const key = jobIds.join(",");
  const [states, setStates] = useState<Map<string, JobProgress>>(new Map());

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) return;
    let cancelled = false;
    for (const jobId of ids) {
      void api
        .job(jobId)
        .then((state) => {
          if (cancelled) return;
          setStates((prev) =>
            new Map(prev).set(jobId, {
              events: state.events,
              final:
                state.events.find(
                  (e) => e.phase === "done" || e.phase === "error",
                ) ?? null,
            }),
          );
        })
        .catch(() => {
          // Pruned or unavailable; live frames may still arrive.
        });
    }
    const disconnect = connectJobEvents((e) => {
      if (!ids.includes(e.jobId)) return;
      setStates((prev) => {
        const current = prev.get(e.jobId) ?? { events: [], final: null };
        return new Map(prev).set(e.jobId, {
          events: [...current.events, e],
          final:
            e.phase === "done" || e.phase === "error" ? e : current.final,
        });
      });
    });
    return () => {
      cancelled = true;
      disconnect();
    };
  }, [key]);

  return states;
}
