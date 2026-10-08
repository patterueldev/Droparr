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
              <span className="text-sm font-medium">
                {e.title}
                {e.year ? <span className="text-zinc-500"> ({e.year})</span> : null}
              </span>
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                {e.kind}
              </span>
              <span className="ml-auto text-xs text-zinc-500">
                {new Date(e.timestamps.started).toLocaleString()}
              </span>
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              {e.files.length} file(s) · {formatBytes(totalBytes)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
