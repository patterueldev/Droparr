import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Category, Instance } from "@droparr/shared";
import { api } from "../api";

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

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["instances"] });
    void queryClient.invalidateQueries({ queryKey: ["categories"] });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
  };

  return (
    <div className="space-y-8">
      <StagingSection
        stagingDir={settings?.stagingDir ?? ""}
        onSaved={refresh}
      />
      <InstancesSection instances={instances} onChanged={refresh} />
      <CategoriesSection
        categories={categories}
        instances={instances}
        onChanged={refresh}
      />
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
  onSaved,
}: {
  stagingDir: string;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(stagingDir);
  const [status, setStatus] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Keep in sync when loaded.
  if (!dirty && value !== stagingDir && stagingDir) {
    setValue(stagingDir);
  }

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
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setDirty(true);
          }}
          placeholder="/data/staging"
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-mono focus:border-emerald-600 focus:outline-none"
        />
        <button
          onClick={save}
          disabled={!dirty && value === stagingDir}
          className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2 text-sm font-medium"
        >
          Save
        </button>
      </div>
      {status && <p className="text-xs text-zinc-400">{status}</p>}
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
      subtitle="Export this configuration and import it on another Droparr — for example when moving from a test machine to your production server. The file contains API keys, so keep it private."
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
