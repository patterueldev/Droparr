import { useState } from "react";
import { api } from "../api";

export default function LoginView({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login({ username, password });
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <div className="text-2xl font-semibold tracking-tight">
            Drop<span className="text-emerald-400">arr</span>
          </div>
          <p className="text-sm text-zinc-400">
            Sign in with your Jellyfin account
          </p>
        </div>

        <form
          onSubmit={submit}
          className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5 space-y-4"
        >
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
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="text-center text-xs text-zinc-500">
          Droparr never stores your Jellyfin password.
        </p>
      </div>
    </div>
  );
}
