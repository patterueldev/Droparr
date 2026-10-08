import { useState } from "react";
import { api } from "../api";

/**
 * First-run bootstrap: Droparr needs a Jellyfin server URL before anyone can
 * log in. Issue M2.2 replaces this with the full, locked setup wizard.
 */
export default function SetupView({ onConfigured }: { onConfigured: () => void }) {
  const [baseUrl, setBaseUrl] = useState("");
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
      const res = await api.jellyfinTest(baseUrl.trim());
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
      await api.jellyfinSetup(baseUrl.trim());
      onConfigured();
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
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-1">
          <div className="text-2xl font-semibold tracking-tight">
            Drop<span className="text-emerald-400">arr</span>
          </div>
          <p className="text-sm text-zinc-400">
            First run — connect your Jellyfin server
          </p>
        </div>

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
              disabled={!canSubmit || testing}
              className="rounded-md border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
            >
              {testing ? "Testing…" : "Test connection"}
            </button>
            <button
              onClick={save}
              disabled={!canSubmit || saving}
              className="ml-auto rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2 text-sm font-medium"
            >
              {saving ? "Saving…" : "Save & continue"}
            </button>
          </div>
        </div>

        <p className="text-center text-xs text-zinc-500">
          Droparr talks to Jellyfin server-to-server. Your users only ever talk
          to Droparr.
        </p>
      </div>
    </div>
  );
}
