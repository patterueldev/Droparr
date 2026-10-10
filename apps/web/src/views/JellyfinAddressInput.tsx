import { useEffect, useState } from "react";
import {
  composeJellyfinUrl,
  DEFAULT_JELLYFIN_PORT,
  isValidJellyfinHostFields,
  isValidJellyfinPort,
  isValidJellyfinUrl,
  normalizeJellyfinUrl,
  splitJellyfinUrl,
  type JellyfinHostFields,
} from "../jellyfinAddress";

type AddressMode = "simple" | "advanced";

const SPLIT_FALLBACK_NOTE =
  "This address can't be split into host, port and HTTPS — edit it as a full URL.";

interface AddressState {
  mode: AddressMode;
  fields: JellyfinHostFields;
  advancedUrl: string;
}

const EMPTY_FIELDS: JellyfinHostFields = {
  host: "",
  port: DEFAULT_JELLYFIN_PORT,
  https: false,
};

/**
 * Initial editor state for a stored URL: split into host/port/SSL when the
 * URL allows it, otherwise keep it verbatim behind the advanced full-URL
 * input (subpath, query, credentials or unparseable values).
 */
function addressStateFor(raw: string): AddressState {
  const split = splitJellyfinUrl(raw);
  if (split) return { mode: "simple", fields: split, advancedUrl: raw.trim() };
  if (!raw.trim()) {
    return { mode: "simple", fields: EMPTY_FIELDS, advancedUrl: "" };
  }
  return { mode: "advanced", fields: EMPTY_FIELDS, advancedUrl: raw.trim() };
}

/**
 * Jellyseerr-style Jellyfin address input (#36): hostname/IP + port + "Use
 * HTTPS", with a derived preview of the composed URL. Values that can't be
 * represented that way (e.g. a subpath like `http://host/jellyfin`) fall back
 * to an advanced full-URL field, reachable from the simple mode via a toggle.
 *
 * Emits the composed full URL — the value the server stores — whenever it
 * changes. `valid` only gates the caller's buttons; the server validates the
 * URL again.
 */
export function JellyfinAddressInput({
  initialUrl,
  onChange,
  autoFocus = false,
}: {
  initialUrl: string;
  onChange: (url: string, valid: boolean) => void;
  autoFocus?: boolean;
}) {
  const initial = addressStateFor(initialUrl);
  const [mode, setMode] = useState<AddressMode>(initial.mode);
  const [fields, setFields] = useState<JellyfinHostFields>(initial.fields);
  const [advancedUrl, setAdvancedUrl] = useState(initial.advancedUrl);
  const [note, setNote] = useState<string | null>(
    initial.mode === "advanced" ? SPLIT_FALLBACK_NOTE : null,
  );
  const [edited, setEdited] = useState(false);
  const [syncedUrl, setSyncedUrl] = useState(initialUrl);

  // Adopt values loaded (or changed) on the server — settings arrive after
  // the first render, and a save echoes back the just-saved URL. Never
  // clobber an in-progress edit whose value the server hasn't accepted.
  if (initialUrl !== syncedUrl) {
    setSyncedUrl(initialUrl);
    const current =
      mode === "simple" ? composeJellyfinUrl(fields) : advancedUrl.trim();
    if (
      !edited ||
      normalizeJellyfinUrl(initialUrl) === normalizeJellyfinUrl(current)
    ) {
      const next = addressStateFor(initialUrl);
      setMode(next.mode);
      setFields(next.fields);
      setAdvancedUrl(next.advancedUrl);
      setNote(next.mode === "advanced" ? SPLIT_FALLBACK_NOTE : null);
      setEdited(false);
    }
  }

  const composed =
    mode === "simple" ? composeJellyfinUrl(fields) : advancedUrl.trim();
  const valid =
    mode === "simple"
      ? isValidJellyfinHostFields(fields)
      : isValidJellyfinUrl(advancedUrl);
  const portInvalid = mode === "simple" && !isValidJellyfinPort(fields.port);

  // Emit the composed URL whenever it changes (mount, edits, adopted
  // server values). `onChange` is deliberately not a dependency.
  useEffect(() => {
    onChange(composed, valid);
  }, [composed, valid]);

  const patch = (next: Partial<JellyfinHostFields>) => {
    setFields((prev) => ({ ...prev, ...next }));
    setEdited(true);
  };

  const toAdvanced = () => {
    setAdvancedUrl(composeJellyfinUrl(fields));
    setNote(null);
    setMode("advanced");
    setEdited(true);
  };

  const toSimple = () => {
    const split = splitJellyfinUrl(advancedUrl);
    if (!split) {
      setNote(SPLIT_FALLBACK_NOTE);
      return;
    }
    setFields(split);
    setMode("simple");
    setEdited(true);
  };

  return (
    <div className="space-y-3">
      {mode === "simple" ? (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block min-w-[12rem] flex-1 space-y-1.5">
              <span className="text-xs text-zinc-400">Hostname or IP</span>
              <input
                value={fields.host}
                onChange={(e) => patch({ host: e.target.value })}
                placeholder="192.168.1.10"
                className="input font-mono"
                autoFocus={autoFocus}
              />
            </label>
            <label className="block w-24 space-y-1.5">
              <span className="text-xs text-zinc-400">Port</span>
              <input
                value={fields.port}
                onChange={(e) => patch({ port: e.target.value })}
                inputMode="numeric"
                placeholder={DEFAULT_JELLYFIN_PORT}
                className="input font-mono"
              />
            </label>
            <label className="flex w-fit items-center gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={fields.https}
                onChange={(e) => patch({ https: e.target.checked })}
                className="h-4 w-4 accent-emerald-600"
              />
              Use HTTPS
            </label>
          </div>

          {portInvalid ? (
            <p className="text-[11px] text-red-400" role="alert">
              Port must be a whole number between 1 and 65535.
            </p>
          ) : composed ? (
            <p className="text-[11px] text-zinc-500">
              Connects to <code className="text-zinc-400">{composed}</code>
            </p>
          ) : null}
        </>
      ) : (
        <label className="block space-y-1.5">
          <span className="text-xs text-zinc-400">Jellyfin URL</span>
          <input
            value={advancedUrl}
            onChange={(e) => {
              setAdvancedUrl(e.target.value);
              setEdited(true);
            }}
            placeholder="http://192.168.1.10:8096"
            className="input font-mono"
            autoFocus={autoFocus}
          />
        </label>
      )}

      {note && (
        <p className="text-[11px] leading-relaxed text-amber-400/90">{note}</p>
      )}

      <button
        type="button"
        onClick={mode === "simple" ? toAdvanced : toSimple}
        className="text-[11px] text-zinc-400 underline underline-offset-2 hover:text-zinc-200"
      >
        {mode === "simple"
          ? "Use a full URL instead"
          : "Use hostname and port instead"}
      </button>
    </div>
  );
}
