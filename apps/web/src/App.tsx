import { useState } from "react";
import ImportView from "./views/ImportView";
import HistoryView from "./views/HistoryView";
import SettingsView from "./views/SettingsView";

type Tab = "import" | "history" | "settings";

export default function App() {
  const [tab, setTab] = useState<Tab>("import");

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
            {(
              [
                ["import", "Import"],
                ["history", "History"],
                ["settings", "Settings"],
              ] as [Tab, string][]
            ).map(([id, label]) => (
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
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        {tab === "import" && <ImportView onOpenSettings={() => setTab("settings")} />}
        {tab === "history" && <HistoryView />}
        {tab === "settings" && <SettingsView />}
      </main>
    </div>
  );
}
