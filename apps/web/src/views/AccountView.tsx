import { useQuery, useQueryClient } from "@tanstack/react-query";
import { requiresApproval, type User } from "@droparr/shared";
import { api } from "../api";

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * Submitter home: account state (including whether their drops will need
 * approval) plus their own sessions. The drop flow and submission status land
 * in M3; this view keeps the account usable until then.
 */
export default function AccountView({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions"],
    queryFn: api.sessions,
  });

  const revoke = async (id: string, current: boolean) => {
    const question = current
      ? "Sign out of this browser?"
      : "Revoke this session? That browser will be signed out immediately.";
    if (!confirm(question)) return;
    await api.revokeSession(id);
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    if (current) {
      void queryClient.invalidateQueries({ queryKey: ["auth"] });
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="flex items-center gap-2">
          <h2 className="font-medium">Your account</h2>
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
            submitter
          </span>
          {user.trusted && (
            <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-400">
              trusted
            </span>
          )}
        </div>
        <p className="text-sm text-zinc-300">
          Signed in as <span className="font-medium">{user.name}</span>.
        </p>
        <p className="text-sm text-zinc-400">
          {requiresApproval(user)
            ? "Your submissions are reviewed by an admin before anything is imported."
            : "You're trusted — your submissions import without waiting for approval."}
        </p>
        <p className="text-xs text-zinc-500">
          Dropping files from submitter accounts arrives in an upcoming update.
          Your account and sessions are active now.
        </p>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50">
        <div className="border-b border-zinc-800 p-5">
          <h2 className="font-medium">Sessions</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Browsers currently signed in with your account. Revoking a session
            signs that browser out immediately.
          </p>
        </div>
        <div className="space-y-2 p-5">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="flex items-center gap-4 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm">
                    {session.userAgent ?? "Unknown browser"}
                  </span>
                  {session.current && (
                    <span className="shrink-0 rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-400">
                      this browser
                    </span>
                  )}
                </div>
                <div className="text-xs text-zinc-500">
                  Started {formatWhen(session.createdAt)} · Last seen{" "}
                  {formatWhen(session.lastSeenAt)}
                  {session.ip ? ` · ${session.ip}` : ""}
                </div>
              </div>
              <button
                onClick={() => void revoke(session.id, !!session.current)}
                className="shrink-0 rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                {session.current ? "Sign out" : "Revoke"}
              </button>
            </div>
          ))}
          {sessions.length === 0 && (
            <p className="text-sm text-zinc-500">No active sessions.</p>
          )}
        </div>
      </section>
    </div>
  );
}
