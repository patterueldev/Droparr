import { useEffect, useState } from "react";
import type { SetupStatus, User } from "@droparr/shared";
import { ApiError, api } from "../api";

type Step = "url" | "login" | "confirm" | "done";

interface ServerInfo {
  serverName?: string;
  version?: string;
}

/**
 * First-run wizard (#6): Jellyfin URL → admin login → confirm → done.
 *
 * The server locks these routes (and this view) permanently once setup
 * completes; `onConfigured` re-checks `/api/auth/status` and routes away.
 */
export default function SetupView({ onConfigured }: { onConfigured: () => void }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [admin, setAdmin] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoadError(null);
    try {
      const res = await api.setupStatus();
      setStatus(res);
      if (res.authenticated && res.user?.role === "admin") {
        setAdmin(res.user);
        setStep("confirm");
      } else {
        setStep(res.jellyfinConfigured ? "login" : "url");
      }
    } catch (err) {
      // 403 → the wizard was completed in another tab (or already) — hand off
      // to the app, which will show the sign-in screen.
      if (err instanceof ApiError && err.status === 403) {
        onConfigured();
        return;
      }
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (loadError) {
    return (
      <Shell>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5 space-y-3 text-center">
          <p className="text-sm text-red-400">{loadError}</p>
          <button
            onClick={() => void load()}
            className="rounded-md border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
          >
            Retry
          </button>
        </div>
      </Shell>
    );
  }

  if (!status || !step) {
    return (
      <Shell>
        <p className="text-center text-sm text-zinc-500">Loading setup…</p>
      </Shell>
    );
  }

  if (step === "done") {
    return (
      <Shell>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5 space-y-4 text-center">
          <div className="text-3xl">✓</div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-emerald-400">
              Setup complete
            </p>
            <p className="text-sm text-zinc-400">
              {admin?.name ?? "Your Jellyfin admin"} is the Droparr
              administrator. The wizard is now locked.
            </p>
          </div>
          <button
            onClick={onConfigured}
            className="w-full rounded-md bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium"
          >
            Open Droparr
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-center justify-center gap-2 text-[11px] uppercase tracking-wide text-zinc-500">
        <StepDot n={1} label="Jellyfin" current={step} />
        <span className="text-zinc-700">→</span>
        <StepDot n={2} label="Admin" current={step} />
        <span className="text-zinc-700">→</span>
        <StepDot n={3} label="Confirm" current={step} />
      </div>

      {step === "url" && (
        <UrlStep
          initialUrl={status.jellyfinBaseUrl ?? ""}
          onSaved={(info) => {
            setServer(info);
            setStatus({ ...status, jellyfinConfigured: true });
            setStep("login");
          }}
        />
      )}

      {step === "login" && (
        <LoginStep
          server={server}
          onAdmin={(user) => {
            setAdmin(user);
            setError(null);
            setStep("confirm");
          }}
        />
      )}

      {step === "confirm" && admin && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
          <div className="space-y-1">
            <p className="text-sm text-zinc-200">
              Signed in as{" "}
              <span className="font-medium">{admin.name}</span>
            </p>
            <p className="text-sm text-zinc-400">
              This Jellyfin administrator will become the Droparr admin, and the
              setup wizard locks permanently. Droparr never stores your Jellyfin
              password.
            </p>
          </div>

          {error && (
            <p className="text-xs text-red-400" role="alert">
              {error}
            </p>
          )}

          <ConfirmButtons
            onFinish={async () => {
              setError(null);
              try {
                const res = await api.setupComplete();
                setAdmin(res.user);
                setStep("done");
              } catch (err) {
                if (err instanceof ApiError && err.status === 403) {
                  onConfigured();
                  return;
                }
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
            onBack={async () => {
              try {
                await api.logout();
              } catch {
                // Fall through to the login step regardless.
              }
              setAdmin(null);
              setStep("login");
            }}
          />
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-1">
          <div className="text-2xl font-semibold tracking-tight">
            Drop<span className="text-emerald-400">arr</span>
          </div>
          <p className="text-sm text-zinc-400">
            First run — connect Jellyfin and claim the admin account
          </p>
        </div>
        {children}
        <p className="text-center text-xs text-zinc-500">
          Droparr talks to Jellyfin server-to-server. Your users only ever talk
          to Droparr.
        </p>
      </div>
    </div>
  );
}

function StepDot({
  n,
  label,
  current,
}: {
  n: number;
  label: string;
  current: Step;
}) {
  const order: Step[] = ["url", "login", "confirm", "done"];
  const active = order.indexOf(current) >= n - 1;
  return (
    <span
      className={`flex items-center gap-1.5 ${active ? "text-emerald-400" : ""}`}
    >
      <span
        className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
          active ? "bg-emerald-950 text-emerald-400" : "bg-zinc-800"
        }`}
      >
        {n}
      </span>
      {label}
    </span>
  );
}

function UrlStep({
  initialUrl,
  onSaved,
}: {
  initialUrl: string;
  onSaved: (info: ServerInfo) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(initialUrl);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const canSubmit = baseUrl.trim().startsWith("http");

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.setupJellyfinTest(baseUrl.trim());
      setTestResult({
        ok: true,
        text: `${res.serverName ?? "Jellyfin"} ${res.version ?? ""}`.trim(),
      });
    } catch (err) {
      setTestResult({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setTestResult(null);
    try {
      const res = await api.setupJellyfin(baseUrl.trim());
      onSaved({ serverName: res.serverName, version: res.version });
    } catch (err) {
      setTestResult({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
      <label className="block space-y-1.5">
        <span className="text-xs text-zinc-400">Jellyfin URL</span>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://192.168.1.10:8096"
          className="input font-mono"
          autoFocus
        />
      </label>

      {testResult && (
        <p
          className={`text-xs ${
            testResult.ok ? "text-emerald-400" : "text-red-400"
          }`}
        >
          {testResult.ok ? "✓" : "✗"} {testResult.text}
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={test}
          disabled={!canSubmit || testing || saving}
          className="rounded-md border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
        <button
          onClick={save}
          disabled={!canSubmit || saving || testing}
          className="ml-auto rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2 text-sm font-medium"
        >
          {saving ? "Saving…" : "Continue"}
        </button>
      </div>
    </div>
  );
}

function LoginStep({
  server,
  onAdmin,
}: {
  server: ServerInfo | null;
  onAdmin: (user: User) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login({ username, password });
      if (res.user.role !== "admin") {
        setError(
          "This account is not a Jellyfin administrator. Sign in with an admin account to continue.",
        );
        return;
      }
      onAdmin(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5 space-y-4"
    >
      <p className="text-xs text-zinc-400">
        Sign in with a Jellyfin administrator
        {server?.serverName ? (
          <>
            {" "}
            on{" "}
            <span className="text-zinc-300">
              {server.serverName}
              {server.version ? ` ${server.version}` : ""}
            </span>
          </>
        ) : null}
        .
      </p>
      <label className="block space-y-1.5">
        <span className="text-xs text-zinc-400">Username</span>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          className="input"
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-xs text-zinc-400">Password</span>
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          autoComplete="current-password"
          className="input"
        />
      </label>

      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !username || !password}
        className="w-full rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2 text-sm font-medium"
      >
        {busy ? "Signing in…" : "Continue"}
      </button>
    </form>
  );
}

function ConfirmButtons({
  onFinish,
  onBack,
}: {
  onFinish: () => Promise<void>;
  onBack: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"finish" | "back" | null>(null);

  return (
    <div className="flex gap-2">
      <button
        onClick={() => {
          setBusy("back");
          void onBack().finally(() => setBusy(null));
        }}
        disabled={busy !== null}
        className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
      >
        {busy === "back" ? "Signing out…" : "Use a different account"}
      </button>
      <button
        onClick={() => {
          setBusy("finish");
          void onFinish().finally(() => setBusy(null));
        }}
        disabled={busy !== null}
        className="ml-auto rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2 text-sm font-medium"
      >
        {busy === "finish" ? "Finishing…" : "Finish setup"}
      </button>
    </div>
  );
}
