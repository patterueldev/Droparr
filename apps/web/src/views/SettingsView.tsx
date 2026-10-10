import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Category,
  Instance,
  NotificationFormat,
  NotificationSettings,
  StagingCheckIssue,
  UploadSettings,
} from "@droparr/shared";
import { api, formatBytes, type SweepResult } from "../api";
import { PathCombobox } from "./PathCombobox";

const GIB = 1024 ** 3;

export default function SettingsView() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: api.settings,
  });
  const { data: instances = [] } = useQuery({
    queryKey: ["instances"],
    queryFn: api.instances,
  });
  const { data: categories = [] } = useQuery({
    queryKey: ["categories"],
    queryFn: api.categories,
  });
  const { data: stagingCheck } = useQuery({
    queryKey: ["staging-check"],
    queryFn: api.settingsStagingCheck,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["instances"] });
    void queryClient.invalidateQueries({ queryKey: ["categories"] });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
    void queryClient.invalidateQueries({ queryKey: ["staging-check"] });
    void queryClient.invalidateQueries({ queryKey: ["disk-status"] });
    void queryClient.invalidateQueries({ queryKey: ["cleanup-status"] });
  };

  return (
    <div className="space-y-8">
      <StagingSection
        stagingDir={settings?.stagingDir ?? ""}
        issues={stagingCheck?.issues ?? []}
        onSaved={refresh}
      />
      <UploadsSection uploads={settings?.uploads} onSaved={refresh} />
      <JellyfinSection jellyfin={settings?.jellyfin} onSaved={refresh} />
      <NotificationsSection
        notifications={settings?.notifications}
        onSaved={refresh}
      />
      <InstancesSection instances={instances} onChanged={refresh} />
      <CategoriesSection
        categories={categories}
        instances={instances}
        onChanged={refresh}
      />
      <SessionsSection />
      <BackupSection onChanged={refresh} />
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-medium">{title}</h2>
        {subtitle && <p className="text-sm text-zinc-400">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function StagingSection({
  stagingDir,
  issues,
  onSaved,
}: {
  stagingDir: string;
  issues: StagingCheckIssue[];
  onSaved: () => void;
}) {
  const [value, setValue] = useState(stagingDir);
  const [status, setStatus] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Keep in sync when loaded / saved elsewhere.
  useEffect(() => {
    if (!dirty && stagingDir) setValue(stagingDir);
  }, [dirty, stagingDir]);

  const save = async () => {
    try {
      await api.updateSettings({ stagingDir: value.trim() });
      setStatus("Saved");
      setDirty(false);
      onSaved();
      setTimeout(() => setStatus(null), 2000);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Section
      title="Staging directory"
      subtitle="Shared volume path (as Droparr sees it) where drops are staged before the *arr imports them."
    >
      <div className="flex gap-2">
        <PathCombobox
          value={value}
          onChange={(v) => {
            setValue(v);
            setDirty(true);
          }}
          placeholder="/data/staging"
          className="flex-1"
          aria-label="Staging directory"
        />
        <button
          onClick={save}
          disabled={!dirty && value === stagingDir}
          className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2 text-sm font-medium"
        >
          Save
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        The path as Droparr sees it — the *arrs see the same shared volume at
        their own path (per-instance mappings translate it).
      </p>
      {status && <p className="text-xs text-zinc-400">{status}</p>}

      {issues.length > 0 && (
        <div className="rounded-lg border border-amber-900 bg-amber-950/40 px-4 py-3 space-y-2">
          {issues.map((issue, i) => (
            <div key={`${issue.code}-${issue.instanceId ?? i}`} className="space-y-0.5">
              <p className="text-sm text-amber-300">{issue.message}</p>
              {issue.suggestion && (
                <p className="text-xs text-amber-400/80">{issue.suggestion}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function toGiBString(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes === 0) return "0";
  return String(Number((bytes / GIB).toFixed(2)));
}

function parseGiB(value: string): number | null {
  const n = Number(value.trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * GIB);
}

/** One-line description of a sweep result for the Settings UI. */
function sweepSummary(r: SweepResult): string {
  if (r.retentionDays <= 0) {
    return "Cleanup is disabled (retention 0) — nothing was removed.";
  }
  const parts: string[] = [];
  if (r.staleUploads > 0) parts.push(`${r.staleUploads} partial upload(s)`);
  if (r.sweptDrops > 0) parts.push(`${r.sweptDrops} finished drop(s)`);
  if (r.orphanDirs > 0) parts.push(`${r.orphanDirs} orphan folder(s)`);
  if (parts.length === 0) return "Nothing to clean up.";
  const freed = r.freedBytes > 0 ? ` — ${formatBytes(r.freedBytes)} freed` : "";
  return `Removed ${parts.join(", ")}${freed}.`;
}

function UploadsSection({
  uploads,
  onSaved,
}: {
  uploads?: UploadSettings;
  onSaved: () => void;
}) {
  const [quarantineDir, setQuarantineDir] = useState(
    uploads?.quarantineDir ?? "",
  );
  const [maxFileGiB, setMaxFileGiB] = useState(
    toGiBString(uploads?.maxFileSizeBytes),
  );
  const [maxSubmissionGiB, setMaxSubmissionGiB] = useState(
    toGiBString(uploads?.maxSubmissionSizeBytes),
  );
  const [minFreeGiB, setMinFreeGiB] = useState(
    toGiBString(uploads?.minFreeSpaceBytes),
  );
  const [retentionDays, setRetentionDays] = useState(
    uploads?.retentionDays === undefined ? "" : String(uploads.retentionDays),
  );
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [runBusy, setRunBusy] = useState(false);
  const [runStatus, setRunStatus] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const { data: disk, refetch: refetchDisk } = useQuery({
    queryKey: ["disk-status"],
    queryFn: api.diskStatus,
  });
  const { data: cleanup, refetch: refetchCleanup } = useQuery({
    queryKey: ["cleanup-status"],
    queryFn: api.cleanupStatus,
  });

  // Keep in sync when loaded / saved elsewhere.
  useEffect(() => {
    if (dirty || !uploads) return;
    setQuarantineDir(uploads.quarantineDir ?? "");
    setMaxFileGiB(toGiBString(uploads.maxFileSizeBytes));
    setMaxSubmissionGiB(toGiBString(uploads.maxSubmissionSizeBytes));
    setMinFreeGiB(toGiBString(uploads.minFreeSpaceBytes));
    setRetentionDays(
      uploads.retentionDays === undefined ? "" : String(uploads.retentionDays),
    );
  }, [dirty, uploads]);

  const save = async () => {
    const maxFile = parseGiB(maxFileGiB);
    const maxSubmission = parseGiB(maxSubmissionGiB);
    const minFree = parseGiB(minFreeGiB);
    const retention = Number(retentionDays.trim());
    if (
      maxFile === null ||
      maxSubmission === null ||
      minFree === null ||
      retentionDays.trim() === "" ||
      !Number.isInteger(retention) ||
      retention < 0
    ) {
      setStatus({
        ok: false,
        text: "Sizes must be non-negative numbers (GiB); retention a whole number of days (0 = keep forever).",
      });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const uploadsPatch: NonNullable<
        Parameters<typeof api.updateSettings>[0]["uploads"]
      > = {
        maxFileSizeBytes: maxFile,
        maxSubmissionSizeBytes: maxSubmission,
        minFreeSpaceBytes: minFree,
        retentionDays: retention,
      };
      // Only persist the quarantine dir when it was actually edited — the
      // field is pre-filled with the resolved default, and freezing that
      // machine-specific path into the config would break settings import
      // on another host.
      if (quarantineDir.trim() !== (uploads?.quarantineDir ?? "")) {
        uploadsPatch.quarantineDir = quarantineDir.trim();
      }
      await api.updateSettings({ uploads: uploadsPatch });
      setStatus({ ok: true, text: "Saved" });
      setDirty(false);
      onSaved();
      setTimeout(() => setStatus(null), 2000);
    } catch (err) {
      setStatus({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const runCleanup = async () => {
    setRunBusy(true);
    setRunStatus(null);
    try {
      const result = await api.runCleanup();
      setRunStatus({ ok: true, text: sweepSummary(result) });
      void refetchCleanup();
      void refetchDisk();
    } catch (err) {
      setRunStatus({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunBusy(false);
    }
  };

  const edit =
    (setter: (value: string) => void) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setter(e.target.value);
      setDirty(true);
    };

  const last = cleanup?.lastResult;

  return (
    <Section
      title="Uploads & disk"
      subtitle="Where browser uploads land first, how much disk they may consume, and when abandoned or finished drops are cleaned up automatically."
    >
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Quarantine directory">
          <input
            value={quarantineDir}
            onChange={edit(setQuarantineDir)}
            placeholder="/data/quarantine"
            className="input font-mono"
          />
        </Field>
        <Field label="Retention (days, 0 = keep forever)">
          <input
            value={retentionDays}
            onChange={edit(setRetentionDays)}
            placeholder="7"
            inputMode="numeric"
            className="input"
          />
        </Field>
        <Field label="Max file size (GiB, 0 = unlimited)">
          <input
            value={maxFileGiB}
            onChange={edit(setMaxFileGiB)}
            placeholder="64"
            inputMode="decimal"
            className="input"
          />
        </Field>
        <Field label="Max submission size (GiB, 0 = unlimited)">
          <input
            value={maxSubmissionGiB}
            onChange={edit(setMaxSubmissionGiB)}
            placeholder="256"
            inputMode="decimal"
            className="input"
          />
        </Field>
        <Field label="Minimum free space (GiB, 0 = guard off)">
          <input
            value={minFreeGiB}
            onChange={edit(setMinFreeGiB)}
            placeholder="10"
            inputMode="decimal"
            className="input"
          />
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={busy || !dirty}
          className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2 text-sm font-medium"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {status && (
          <p
            className={`text-xs ${status.ok ? "text-emerald-400" : "text-red-400"}`}
          >
            {status.text}
          </p>
        )}
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 space-y-1">
        <div className="flex items-center gap-3">
          <span className="text-sm text-zinc-400">Quarantine volume:</span>
          {disk ? (
            <span className="text-sm text-zinc-200">
              {formatBytes(disk.freeBytes)} free of{" "}
              {formatBytes(disk.totalBytes)}
            </span>
          ) : (
            <span className="text-sm text-zinc-500">…</span>
          )}
          <button
            onClick={() => void refetchDisk()}
            className="ml-auto rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Refresh
          </button>
        </div>
        {disk && (
          <p className="text-xs text-zinc-500 font-mono truncate">
            {disk.quarantineDir}
          </p>
        )}
        {disk?.belowThreshold && (
          <p className="text-xs text-amber-400">
            ⚠ Below the {formatBytes(disk.minFreeSpaceBytes)} headroom — new
            uploads are refused and running uploads are aborted until space is
            freed.
          </p>
        )}
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 space-y-2">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              Cleanup sweep{cleanup?.started ? " · runs hourly" : ""}
            </p>
            <p className="text-xs text-zinc-500">
              {last
                ? `Last run ${formatWhen(last.at)}: ${sweepSummary(last)}${
                    last.errors.length > 0
                      ? ` ${last.errors.length} error(s) — check the server log.`
                      : ""
                  }`
                : "No sweep has run yet on this server."}
            </p>
          </div>
          <button
            onClick={runCleanup}
            disabled={runBusy}
            className="shrink-0 rounded-md border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
          >
            {runBusy ? "Running…" : "Run cleanup now"}
          </button>
        </div>
        {runStatus && (
          <p
            className={`text-xs ${runStatus.ok ? "text-emerald-400" : "text-red-400"}`}
          >
            {runStatus.text}
          </p>
        )}
      </div>
    </Section>
  );
}

function JellyfinSection({
  jellyfin,
  onSaved,
}: {
  jellyfin?: { baseUrl: string; apiKey?: string };
  onSaved: () => void;
}) {
  const [value, setValue] = useState(jellyfin?.baseUrl ?? "");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  // Keep in sync when loaded.
  if (!dirty && jellyfin?.baseUrl && value !== jellyfin.baseUrl) {
    setValue(jellyfin.baseUrl);
  }

  const test = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await api.jellyfinTestSaved(value.trim());
      setStatus({
        ok: true,
        text: `Connected — ${res.serverName ?? "Jellyfin"} ${res.version ?? ""}`.trim(),
      });
    } catch (err) {
      setStatus({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await api.updateSettings({ jellyfin: { baseUrl: value.trim() } });
      setStatus({ ok: true, text: "Saved" });
      setDirty(false);
      onSaved();
    } catch (err) {
      setStatus({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Jellyfin"
      subtitle="Server used for login. Users sign in with their Jellyfin accounts; admins become Droparr admins."
    >
      <div className="flex flex-wrap gap-2">
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setDirty(true);
          }}
          placeholder="http://192.168.1.10:8096"
          className="input font-mono flex-1 min-w-[16rem]"
        />
        <button
          onClick={test}
          disabled={busy || !value.trim()}
          className="rounded-md border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
        >
          {busy ? "Checking…" : "Test"}
        </button>
        <button
          onClick={save}
          disabled={busy || !value.trim() || (!dirty && value === jellyfin?.baseUrl)}
          className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2 text-sm font-medium"
        >
          Save
        </button>
      </div>

      <p className="text-[11px] leading-relaxed text-zinc-500">
        Must be reachable from the Droparr container — use the Docker service
        name (e.g. <code>http://jellyfin:8096</code>) or the server's LAN IP,
        not a Bonjour <code>*.local</code> name. The{" "}
        <code>DROPARR_JELLYFIN_URL</code> env var overrides this value.
      </p>

      {status && (
        <p
          className={`text-xs ${status.ok ? "text-emerald-400" : "text-red-400"}`}
        >
          {status.ok ? "✓" : "✗"} {status.text}
        </p>
      )}
    </Section>
  );
}

function NotificationsSection({
  notifications,
  onSaved,
}: {
  notifications?: NotificationSettings;
  onSaved: () => void;
}) {
  const [enabled, setEnabled] = useState(notifications?.enabled ?? false);
  const [format, setFormat] = useState<NotificationFormat>(
    notifications?.format ?? "ntfy",
  );
  const [url, setUrl] = useState(notifications?.url ?? "");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [testBusy, setTestBusy] = useState(false);
  const [testStatus, setTestStatus] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  // Keep in sync when loaded / saved elsewhere.
  useEffect(() => {
    if (dirty || !notifications) return;
    setEnabled(notifications.enabled);
    setFormat(notifications.format);
    setUrl(notifications.url);
  }, [dirty, notifications]);

  const change = (fn: () => void) => {
    fn();
    setDirty(true);
    setStatus(null);
  };

  const test = async () => {
    setTestBusy(true);
    setTestStatus(null);
    try {
      await api.notificationsTest({ url: url.trim(), format });
      setTestStatus({ ok: true, text: "Test notification sent." });
    } catch (err) {
      setTestStatus({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await api.updateSettings({
        notifications: { enabled, url: url.trim(), format },
      });
      setStatus({ ok: true, text: "Saved" });
      setDirty(false);
      onSaved();
      setTimeout(() => setStatus(null), 2000);
    } catch (err) {
      setStatus({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const needsUrl = enabled && !url.trim();

  return (
    <Section
      title="Notifications"
      subtitle="Optional webhook that tells admins about new submissions and submitters when their import finishes or is rejected. Off by default; delivery failures are only logged and never affect an import."
    >
      <label className="flex w-fit items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => change(() => setEnabled(e.target.checked))}
          className="h-4 w-4 accent-emerald-600"
        />
        Send notifications
      </label>

      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Format">
          <select
            value={format}
            onChange={(e) =>
              change(() => setFormat(e.target.value as NotificationFormat))
            }
            className="input"
          >
            <option value="ntfy">ntfy</option>
            <option value="discord">Discord webhook</option>
          </select>
        </Field>
        <Field
          label={format === "ntfy" ? "ntfy topic URL" : "Discord webhook URL"}
        >
          <input
            value={url}
            onChange={(e) => change(() => setUrl(e.target.value))}
            placeholder={
              format === "ntfy"
                ? "https://ntfy.sh/my-droparr"
                : "https://discord.com/api/webhooks/…"
            }
            className="input font-mono"
          />
        </Field>
      </div>

      <p className="text-xs text-zinc-500">
        {format === "ntfy"
          ? "Messages are POSTed to this topic; ntfy.sh and self-hosted servers both work."
          : "Create one in Discord under Channel settings → Integrations → Webhooks."}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={test}
          disabled={testBusy || !url.trim()}
          className="rounded-md border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
        >
          {testBusy ? "Testing…" : "Test"}
        </button>
        <button
          onClick={save}
          disabled={busy || !dirty || needsUrl}
          className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2 text-sm font-medium"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {status && (
          <p
            className={`text-xs ${status.ok ? "text-emerald-400" : "text-red-400"}`}
          >
            {status.ok ? "✓" : "✗"} {status.text}
          </p>
        )}
        {testStatus && (
          <p
            className={`text-xs ${testStatus.ok ? "text-emerald-400" : "text-red-400"}`}
          >
            {testStatus.ok ? "✓" : "✗"} {testStatus.text}
          </p>
        )}
      </div>
      {needsUrl && (
        <p className="text-xs text-amber-400">
          Set a webhook URL before enabling notifications.
        </p>
      )}
    </Section>
  );
}

const EMPTY_INSTANCE: Omit<Instance, "id"> = {
  name: "",
  kind: "series",
  baseUrl: "",
  apiKey: "",
  pathMappings: [],
};

function InstancesSection({
  instances,
  onChanged,
}: {
  instances: Instance[];
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<typeof EMPTY_INSTANCE | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; text: string }>
  >({});
  const autoTested = useRef<Set<string>>(new Set());

  const startEdit = (i: Instance) => {
    setEditingId(i.id);
    setDraft({
      name: i.name,
      kind: i.kind,
      baseUrl: i.baseUrl,
      apiKey: i.apiKey,
      pathMappings: i.pathMappings,
    });
  };

  const save = async () => {
    if (!draft) return;
    try {
      if (editingId) {
        await api.updateInstance(editingId, draft);
        // Connection values may have changed — re-test.
        autoTested.current.delete(editingId);
      } else {
        await api.createInstance(draft);
      }
      setDraft(null);
      setEditingId(null);
      onChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const test = useCallback(
    async (id: string) => {
      setTestResults((r) => ({ ...r, [id]: { ok: false, text: "Checking…" } }));
      try {
        const res = await api.testInstance(id);
        setTestResults((r) => ({
          ...r,
          [id]: { ok: true, text: `${res.appName} ${res.version ?? ""}` },
        }));
      } catch (err) {
        setTestResults((r) => ({
          ...r,
          [id]: {
            ok: false,
            text: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    },
    [],
  );

  // Auto-check each saved instance once when Settings loads.
  useEffect(() => {
    for (const i of instances) {
      if (!autoTested.current.has(i.id)) {
        autoTested.current.add(i.id);
        void test(i.id);
      }
    }
  }, [instances, test]);

  return (
    <Section
      title="Instances"
      subtitle="Your Sonarr/Radarr instances. Path mappings translate Droparr paths to each instance's view of the same volume."
    >
      <div className="space-y-2">
        {instances.map((i) => {
          const t = testResults[i.id];
          return (
            <div
              key={i.id}
              className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 flex items-center gap-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {/* Connection status dot */}
                  <span
                    title={t?.text ?? "Not checked yet"}
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                      !t
                        ? "bg-zinc-600"
                        : t.text === "Checking…"
                          ? "bg-amber-400 animate-pulse"
                          : t.ok
                            ? "bg-emerald-500"
                            : "bg-red-500"
                    }`}
                  />
                  <span className="text-sm font-medium">{i.name}</span>
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                    {i.kind}
                  </span>
                </div>
                <div className="text-xs text-zinc-500 font-mono truncate">
                  {i.baseUrl}
                  {i.pathMappings.length > 0 && (
                    <>
                      {" "}
                      ·{" "}
                      {i.pathMappings
                        .map((m) => `${m.app} → ${m.remote}`)
                        .join(", ")}
                    </>
                  )}
                </div>
                {t && t.text !== "Checking…" && (
                  <div
                    className={`text-xs mt-1 ${
                      t.ok ? "text-emerald-400" : "text-red-400"
                    }`}
                  >
                    {t.ok ? "✓" : "✗"} {t.text}
                  </div>
                )}
              </div>
              <button
                onClick={() => test(i.id)}
                className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Test
              </button>
              <button
                onClick={() => startEdit(i)}
                className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Edit
              </button>
              <button
                onClick={async () => {
                  if (confirm(`Delete instance "${i.name}"? Categories using it will be removed.`)) {
                    await api.deleteInstance(i.id);
                    onChanged();
                  }
                }}
                className="rounded border border-red-900 px-3 py-1.5 text-xs text-red-400 hover:bg-red-950/40"
              >
                Delete
              </button>
            </div>
          );
        })}
      </div>

      {draft ? (
        <InstanceForm
          draft={draft}
          editing={!!editingId}
          onChange={setDraft}
          onSave={save}
          onCancel={() => {
            setDraft(null);
            setEditingId(null);
          }}
        />
      ) : (
        <button
          onClick={() => {
            setEditingId(null);
            setDraft({ ...EMPTY_INSTANCE, pathMappings: [] });
          }}
          className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          + Add instance
        </button>
      )}
    </Section>
  );
}

function InstanceForm({
  draft,
  editing,
  onChange,
  onSave,
  onCancel,
}: {
  draft: typeof EMPTY_INSTANCE;
  editing: boolean;
  onChange: (d: typeof EMPTY_INSTANCE) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<typeof EMPTY_INSTANCE>) =>
    onChange({ ...draft, ...patch });

  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const canTest = !!draft.baseUrl && !!draft.apiKey;

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testDraftInstance({
        kind: draft.kind,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
      });
      setTestResult({
        ok: true,
        text: `Connected — ${res.appName} ${res.version ?? ""}`.trim(),
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

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/70 p-4 space-y-3">
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Name">
          <input
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="TV Sonarr"
            className="input"
          />
        </Field>
        <Field label="Kind">
          <select
            value={draft.kind}
            onChange={(e) => set({ kind: e.target.value as "series" | "movie" })}
            className="input"
          >
            <option value="series">Sonarr (series)</option>
            <option value="movie">Radarr (movies)</option>
          </select>
        </Field>
        <Field label="Base URL">
          <input
            value={draft.baseUrl}
            onChange={(e) => set({ baseUrl: e.target.value })}
            placeholder="http://192.168.1.10:8989"
            className="input font-mono"
          />
        </Field>
        <Field label="API key">
          <input
            value={draft.apiKey}
            onChange={(e) => set({ apiKey: e.target.value })}
            className="input font-mono"
            type="password"
          />
        </Field>
      </div>

      <div className="space-y-2">
        <span className="text-xs text-zinc-400">
          Path mappings (Droparr path → instance path)
        </span>
        {draft.pathMappings.map((m, idx) => (
          <div key={idx} className="flex gap-2">
            <input
              value={m.app}
              onChange={(e) => {
                const mappings = [...draft.pathMappings];
                mappings[idx] = { ...mappings[idx], app: e.target.value };
                set({ pathMappings: mappings });
              }}
              placeholder="/data/staging"
              className="input font-mono flex-1"
            />
            <span className="self-center text-zinc-500">→</span>
            <input
              value={m.remote}
              onChange={(e) => {
                const mappings = [...draft.pathMappings];
                mappings[idx] = { ...mappings[idx], remote: e.target.value };
                set({ pathMappings: mappings });
              }}
              placeholder="/media/staging"
              className="input font-mono flex-1"
            />
            <button
              onClick={() =>
                set({
                  pathMappings: draft.pathMappings.filter((_, i) => i !== idx),
                })
              }
              className="rounded border border-zinc-700 px-2 text-xs text-zinc-400 hover:bg-zinc-800"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            set({
              pathMappings: [...draft.pathMappings, { app: "", remote: "" }],
            })
          }
          className="text-xs text-emerald-400 hover:text-emerald-300"
        >
          + Add mapping
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={testConnection}
          disabled={!canTest || testing}
          className="rounded-md border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
        >
          {testing ? "Testing…" : "Test"}
        </button>
        {testResult && (
          <span
            className={`text-xs ${
              testResult.ok ? "text-emerald-400" : "text-red-400"
            }`}
          >
            {testResult.ok ? "✓" : "✗"} {testResult.text}
          </span>
        )}
        <div className="flex gap-2 ml-auto">
          <button
            onClick={onCancel}
            className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={!draft.name || !draft.baseUrl || !draft.apiKey}
            className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2 text-sm font-medium"
          >
            {editing ? "Save changes" : "Add instance"}
          </button>
        </div>
      </div>
    </div>
  );
}

const EMPTY_CATEGORY: Omit<Category, "id"> = {
  name: "",
  kind: "series",
  instanceId: "",
  rootFolder: "",
  qualityProfileId: undefined,
  tags: [],
  seriesType: "standard",
};

function CategoriesSection({
  categories,
  instances,
  onChanged,
}: {
  categories: Category[];
  instances: Instance[];
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<typeof EMPTY_CATEGORY | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data: dropdowns } = useQuery({
    queryKey: ["dropdowns", draft?.instanceId],
    queryFn: () => api.dropdowns(draft!.instanceId),
    enabled: !!draft?.instanceId,
  });

  const save = async () => {
    if (!draft) return;
    try {
      const body = {
        ...draft,
        qualityProfileId: draft.qualityProfileId ?? dropdowns?.qualityProfiles[0]?.id,
      };
      if (editingId) {
        await api.updateCategory(editingId, body);
      } else {
        await api.createCategory(body);
      }
      setDraft(null);
      setEditingId(null);
      onChanged();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Section
      title="Categories"
      subtitle="Routing presets: which instance, root folder, quality profile and series type a drop goes to."
    >
      <div className="space-y-2">
        {categories.map((c) => {
          const inst = instances.find((i) => i.id === c.instanceId);
          return (
            <div
              key={c.id}
              className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 flex items-center gap-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{c.name}</span>
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                    {c.kind}
                  </span>
                  {c.kind === "series" && (
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                      {c.seriesType}
                    </span>
                  )}
                </div>
                <div className="text-xs text-zinc-500 font-mono truncate">
                  {inst?.name ?? "missing instance"} · {c.rootFolder}
                </div>
              </div>
              <button
                onClick={() => {
                  setEditingId(c.id);
                  setDraft({
                    name: c.name,
                    kind: c.kind,
                    instanceId: c.instanceId,
                    rootFolder: c.rootFolder,
                    qualityProfileId: c.qualityProfileId,
                    tags: c.tags,
                    seriesType: c.seriesType,
                  });
                }}
                className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Edit
              </button>
              <button
                onClick={async () => {
                  if (confirm(`Delete category "${c.name}"?`)) {
                    await api.deleteCategory(c.id);
                    onChanged();
                  }
                }}
                className="rounded border border-red-900 px-3 py-1.5 text-xs text-red-400 hover:bg-red-950/40"
              >
                Delete
              </button>
            </div>
          );
        })}
      </div>

      {draft ? (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900/70 p-4 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Name">
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Anime"
                className="input"
              />
            </Field>
            <Field label="Instance">
              <select
                value={draft.instanceId}
                onChange={(e) => {
                  const inst = instances.find((i) => i.id === e.target.value);
                  setDraft({
                    ...draft,
                    instanceId: e.target.value,
                    kind: inst?.kind ?? draft.kind,
                    rootFolder: "",
                    qualityProfileId: undefined,
                  });
                }}
                className="input"
              >
                <option value="">Select…</option>
                {instances.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.kind})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Root folder">
              <select
                value={draft.rootFolder}
                onChange={(e) => setDraft({ ...draft, rootFolder: e.target.value })}
                className="input font-mono"
                disabled={!dropdowns}
              >
                <option value="">
                  {dropdowns ? "Select…" : "Pick an instance first"}
                </option>
                {dropdowns?.rootFolders.map((r) => (
                  <option key={r.id} value={r.path}>
                    {r.path}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quality profile">
              <select
                value={draft.qualityProfileId ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    qualityProfileId: e.target.value
                      ? Number(e.target.value)
                      : undefined,
                  })
                }
                className="input"
                disabled={!dropdowns}
              >
                <option value="">
                  {dropdowns ? "Default" : "Pick an instance first"}
                </option>
                {dropdowns?.qualityProfiles.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.name}
                  </option>
                ))}
              </select>
            </Field>
            {draft.kind === "series" && (
              <Field label="Series type">
                <select
                  value={draft.seriesType}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      seriesType: e.target.value as typeof draft.seriesType,
                    })
                  }
                  className="input"
                >
                  <option value="standard">Standard</option>
                  <option value="anime">Anime</option>
                  <option value="daily">Daily</option>
                </select>
              </Field>
            )}
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => {
                setDraft(null);
                setEditingId(null);
              }}
              className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!draft.name || !draft.instanceId || !draft.rootFolder}
              className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2 text-sm font-medium"
            >
              {editingId ? "Save changes" : "Add category"}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => {
            setEditingId(null);
            setDraft({ ...EMPTY_CATEGORY, tags: [] });
          }}
          className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          + Add category
        </button>
      )}
    </Section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs text-zinc-400">{label}</span>
      {children}
    </label>
  );
}

function BackupSection({ onChanged }: { onChanged: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const exportSettings = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const payload = await api.exportSettings();
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `droparr-settings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus({ ok: true, text: "Settings exported." });
    } catch (err) {
      setStatus({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const importSettings = async (file: File) => {
    setStatus(null);
    let payload: unknown;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      setStatus({ ok: false, text: "That file is not valid JSON." });
      return;
    }
    if (
      !confirm(
        "Importing replaces ALL current settings — instances, categories and the staging directory. Continue?",
      )
    ) {
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setBusy(true);
    try {
      const res = await api.importSettings(payload);
      const summary = `Imported ${res.summary.instances} instance(s) and ${res.summary.categories} category(ies).`;
      setStatus({
        ok: true,
        text:
          res.warnings.length > 0
            ? `${summary} ${res.warnings.join(" ")}`
            : summary,
      });
      onChanged();
    } catch (err) {
      setStatus({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <Section
      title="Backup & migration"
      subtitle="Export this configuration and import it on another Droparr — for example when moving from a test machine to your production server. The file contains API keys and webhook URLs, so keep it private."
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={exportSettings}
          disabled={busy}
          className="rounded-md border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
        >
          ⬇ Export settings
        </button>
        <button
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className="rounded-md border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
        >
          ⬆ Import settings…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importSettings(file);
          }}
        />
      </div>
      {status && (
        <p
          className={`text-xs ${status.ok ? "text-emerald-400" : "text-red-400"}`}
        >
          {status.text}
        </p>
      )}
    </Section>
  );
}

function SessionsSection() {
  const queryClient = useQueryClient();
  const { data: sessions = [], isLoading } = useQuery({
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
    <Section
      title="Sessions"
      subtitle="Browsers currently signed in with your account. Revoking a session signs that browser out immediately."
    >
      <div className="space-y-2">
        {sessions.map((s) => (
          <div
            key={s.id}
            className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3 flex items-center gap-4"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm truncate">
                  {s.userAgent ?? "Unknown browser"}
                </span>
                {s.current && (
                  <span className="shrink-0 rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-400">
                    This browser
                  </span>
                )}
              </div>
              <div className="text-xs text-zinc-500">
                Started {formatWhen(s.createdAt)} · Last seen{" "}
                {formatWhen(s.lastSeenAt)}
                {s.ip ? ` · ${s.ip}` : ""}
              </div>
            </div>
            <button
              onClick={() => void revoke(s.id, !!s.current)}
              className="shrink-0 rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              {s.current ? "Sign out" : "Revoke"}
            </button>
          </div>
        ))}
        {!isLoading && sessions.length === 0 && (
          <p className="text-sm text-zinc-500">No active sessions.</p>
        )}
      </div>
    </Section>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return date.toLocaleDateString();
}
