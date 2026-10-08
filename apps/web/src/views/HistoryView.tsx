import { useQuery } from "@tanstack/react-query";
import { api, formatBytes } from "../api";

export default function HistoryView() {
  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["history"],
    queryFn: api.history,
  });

  if (isLoading) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
        <p className="text-sm text-zinc-400">
          No imports yet. Drop a folder to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map((e) => {
        const totalBytes = e.files.reduce((sum, f) => sum + f.size, 0);
        const rejected = e.rejectedFiles ?? [];
        const badge =
          e.result === "success"
            ? "bg-emerald-950/60 text-emerald-300 border-emerald-900"
            : e.result === "partial"
              ? "bg-amber-950/60 text-amber-300 border-amber-900"
              : "bg-red-950/60 text-red-300 border-red-900";
        return (
          <div
            key={e.id}
            className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3"
          >
            <div className="flex items-center gap-3">
              <span
                className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide ${badge}`}
              >
                {e.result}
              </span>
              {e.link ? (
                <a
                  href={e.link}
                  target="_blank"
                  rel="noreferrer"
                  title={`Open in ${e.kind === "series" ? "Sonarr" : "Radarr"}`}
                  className="text-sm font-medium hover:text-emerald-300 hover:underline"
                >
                  {e.title}
                  {e.year ? <span className="text-zinc-500"> ({e.year})</span> : null}
                  <span className="ml-1 text-xs text-zinc-500">↗</span>
                </a>
              ) : (
                <span className="text-sm font-medium">
                  {e.title}
                  {e.year ? <span className="text-zinc-500"> ({e.year})</span> : null}
                </span>
              )}
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                {e.kind}
              </span>
              <span
                className="max-w-[12rem] truncate rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] tracking-wide text-zinc-400"
                title={e.instanceName ?? e.instanceId}
              >
                {e.instanceName ?? e.instanceId}
              </span>
              <span className="ml-auto text-xs text-zinc-500">
                {new Date(e.timestamps.started).toLocaleString()}
              </span>
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              {e.files.length} file(s) · {formatBytes(totalBytes)}
            </div>
            {rejected.length > 0 && (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-amber-400">
                  {rejected.length} file(s) rejected
                </summary>
                <ul className="mt-1 list-disc pl-5 space-y-0.5 text-amber-300/90">
                  {rejected.map((r, i) => (
                    <li key={i} className="break-all">
                      <span className="font-mono">{r.path}</span>
                      {" — "}
                      {r.reasons.join("; ")}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
