import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { User } from "@droparr/shared";
import { api, connectSessionRevoked } from "./api";
import { tabsForRole, type Tab } from "./roles";
import ImportView from "./views/ImportView";
import QueueView from "./views/QueueView";
import SubmitView from "./views/SubmitView";
import HistoryView from "./views/HistoryView";
import SettingsView from "./views/SettingsView";
import UsersView from "./views/UsersView";
import AccountView from "./views/AccountView";
import LoginView from "./views/LoginView";
import SetupView from "./views/SetupView";

export default function App() {
  const queryClient = useQueryClient();
  const {
    data: auth,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["auth"],
    queryFn: api.authStatus,
    staleTime: 0,
    retry: false,
  });

  // Any 401 from the API means the session is gone, and a 409
  // `setup_required` means the server still expects first-run setup — re-check.
  useEffect(() => {
    const refreshAuth = () => {
      void queryClient.invalidateQueries({ queryKey: ["auth"] });
    };
    window.addEventListener("droparr:unauthorized", refreshAuth);
    window.addEventListener("droparr:setup-required", refreshAuth);
    return () => {
      window.removeEventListener("droparr:unauthorized", refreshAuth);
      window.removeEventListener("droparr:setup-required", refreshAuth);
    };
  }, [queryClient]);

  if (isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-zinc-500">
        Loading Droparr…
      </div>
    );
  }

  if (isError || !auth) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center space-y-3">
          <p className="text-sm text-red-400">
            Cannot reach the Droparr server.
          </p>
          <button
            onClick={() => void refetch()}
            className="rounded-md border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (auth.setupRequired) {
    return <SetupView onConfigured={() => void refetch()} />;
  }

  if (!auth.authenticated || !auth.user) {
    return <LoginView onSignedIn={() => void refetch()} />;
  }

  return <Shell user={auth.user} />;
}

function Shell({ user }: { user: User }) {
  const tabs = useMemo(() => tabsForRole(user.role), [user.role]);
  const [tab, setTab] = useState<Tab>(tabs[0].id);
  const queryClient = useQueryClient();

  // A role change (e.g. demoted from the Users page) can drop the current
  // tab — fall back to the first one the role can still see.
  useEffect(() => {
    if (!tabs.some((t) => t.id === tab)) setTab(tabs[0].id);
  }, [tabs, tab]);

  // The server closes this socket and says so when the session is revoked.
  // Frames are scoped per user server-side, so every role can connect.
  useEffect(
    () =>
      connectSessionRevoked(() => {
        void queryClient.invalidateQueries({ queryKey: ["auth"] });
      }),
    [queryClient],
  );

  const signOut = async () => {
    try {
      await api.logout();
    } catch {
      // Local state is cleared below regardless.
    }
    queryClient.clear();
    void queryClient.invalidateQueries({ queryKey: ["auth"] });
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-800 bg-zinc-900/60 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-5xl px-4 flex items-center gap-6 h-14">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold tracking-tight">
              Drop<span className="text-emerald-400">arr</span>
            </span>
            <span className="text-xs text-zinc-500 hidden sm:inline">
              drop a folder, it's in your *arr
            </span>
          </div>
          <nav className="flex gap-1 ml-auto">
            {tabs.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                  tab === id
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-2 border-l border-zinc-800 pl-4">
            <span className="text-sm text-zinc-300 max-w-[10rem] truncate">
              {user.name}
            </span>
            {user.role === "submitter" && user.trusted && (
              <span className="rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-400">
                trusted
              </span>
            )}
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                user.role === "admin"
                  ? "bg-emerald-950 text-emerald-400"
                  : "bg-zinc-800 text-zinc-400"
              }`}
            >
              {user.role}
            </span>
            <button
              onClick={() => void signOut()}
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        {tab === "import" && <ImportView onOpenSettings={() => setTab("settings")} />}
        {tab === "queue" && <QueueView />}
        {tab === "history" && <HistoryView />}
        {tab === "users" && <UsersView currentUser={user} />}
        {tab === "settings" && <SettingsView />}
        {tab === "submit" && <SubmitView />}
        {tab === "account" && <AccountView user={user} />}
      </main>
    </div>
  );
}
