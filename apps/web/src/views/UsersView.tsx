import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { requiresApproval, type User } from "@droparr/shared";
import { api } from "../api";

interface UserPatch {
  role?: User["role"];
  trusted?: boolean;
  blocked?: boolean;
}

function formatWhen(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

/**
 * Admin user management (#7): promote/demote, the per-user trust toggle and
 * blocking. Blocking signs the account out everywhere; the server rejects
 * self-demotion, self-blocking and removing the last active admin.
 */
export default function UsersView({ currentUser }: { currentUser: User }) {
  const queryClient = useQueryClient();
  const {
    data: users = [],
    isLoading,
    isError,
  } = useQuery({ queryKey: ["users"], queryFn: api.users });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UserPatch }) =>
      api.updateUser(id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      // Our own role/trust may have changed (or the session was revoked).
      void queryClient.invalidateQueries({ queryKey: ["auth"] });
    },
  });

  const activeAdmins = users.filter((u) => u.role === "admin" && !u.blocked);
  const lastAdmin = activeAdmins.length <= 1;
  const busy = update.isPending;

  const setRole = (user: User, role: User["role"]) => {
    if (
      role === "submitter" &&
      !confirm(`Demote ${user.name} to submitter? They lose access to config and imports.`)
    ) {
      return;
    }
    update.mutate({ id: user.id, patch: { role } });
  };

  const toggleTrust = (user: User) => {
    update.mutate({ id: user.id, patch: { trusted: !user.trusted } });
  };

  const toggleBlocked = (user: User) => {
    if (
      !user.blocked &&
      !confirm(
        `Block ${user.name}? All of their sessions are signed out immediately and they cannot sign in again until unblocked.`,
      )
    ) {
      return;
    }
    update.mutate({ id: user.id, patch: { blocked: !user.blocked } });
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50">
      <div className="border-b border-zinc-800 p-5 space-y-1">
        <h2 className="font-medium">Users</h2>
        <p className="text-sm text-zinc-400">
          Jellyfin administrators become Droparr admins automatically; anyone
          else signs in as a submitter. Promoting or demoting here sticks, even
          if their Jellyfin role changes later. Trusted submitters skip the
          approval queue, blocked accounts are signed out everywhere.
        </p>
      </div>

      {isError && (
        <p className="px-5 py-4 text-sm text-red-400">
          Could not load users.
        </p>
      )}
      {update.isError && (
        <p className="px-5 py-4 text-sm text-red-400">
          {update.error instanceof Error
            ? update.error.message
            : "Could not update the user."}
        </p>
      )}

      <div className="divide-y divide-zinc-800/70">
        {users.map((user) => {
          const self = user.id === currentUser.id;
          const isLastActiveAdmin =
            user.role === "admin" && !user.blocked && lastAdmin;
          return (
            <div
              key={user.id}
              className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {user.name}
                  </span>
                  {self && (
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                      you
                    </span>
                  )}
                  {user.blocked && (
                    <span className="rounded bg-red-950 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-red-400">
                      blocked
                    </span>
                  )}
                  {user.role === "admin" && (
                    <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-400">
                      admin
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {user.role === "admin"
                    ? "Full configuration and instant imports"
                    : requiresApproval(user)
                      ? "Submissions need admin approval"
                      : "Trusted — submissions import without approval"}
                  {" · "}last login {formatWhen(user.lastLoginAt)}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  disabled={busy || self || isLastActiveAdmin}
                  title={
                    self
                      ? "You cannot demote yourself"
                      : isLastActiveAdmin
                        ? "The last administrator cannot be demoted"
                        : undefined
                  }
                  onClick={() =>
                    setRole(user, user.role === "admin" ? "submitter" : "admin")
                  }
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  {user.role === "admin" ? "Demote" : "Promote"}
                </button>

                <button
                  disabled={busy}
                  title="Trusted submitters skip the approval queue"
                  onClick={() => toggleTrust(user)}
                  className={`rounded-md border px-3 py-1.5 text-xs ${
                    user.trusted
                      ? "border-emerald-700 bg-emerald-950/50 text-emerald-300"
                      : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
                  } disabled:opacity-40`}
                >
                  {user.trusted ? "Trusted" : "Trust"}
                </button>

                <button
                  disabled={busy || self || isLastActiveAdmin}
                  title={
                    self
                      ? "You cannot block yourself"
                      : isLastActiveAdmin
                        ? "The last administrator cannot be blocked"
                        : undefined
                  }
                  onClick={() => toggleBlocked(user)}
                  className={`rounded-md border px-3 py-1.5 text-xs disabled:opacity-40 ${
                    user.blocked
                      ? "border-red-800 bg-red-950/50 text-red-300 hover:bg-red-900/40"
                      : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                  }`}
                >
                  {user.blocked ? "Unblock" : "Block"}
                </button>
              </div>
            </div>
          );
        })}
        {isLoading && (
          <p className="px-5 py-6 text-sm text-zinc-500">Loading users…</p>
        )}
        {!isLoading && users.length === 0 && (
          <p className="px-5 py-6 text-sm text-zinc-500">No users yet.</p>
        )}
      </div>
    </section>
  );
}
