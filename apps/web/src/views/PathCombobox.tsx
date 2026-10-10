import { useEffect, useId, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../api";

/** Wait out fast typing before asking the server for suggestions. */
const DEBOUNCE_MS = 150;

/**
 * Path input with folder suggestions from the **server's** filesystem — the
 * same view Droparr gets, which is what the *arrs translate through their
 * path mappings. Typing debounces into `GET /api/fs/suggest`; ↑/↓ move, Enter
 * picks the highlighted suggestion (or runs `onEnter` when none is), Esc
 * closes, and a click picks directly. Unreadable or missing folders just
 * yield no suggestions, never an error.
 */
export function PathCombobox({
  value,
  onChange,
  placeholder,
  className,
  onEnter,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Layout classes for the wrapper (e.g. `flex-1`). */
  className?: string;
  /** Enter with nothing highlighted — e.g. the import wizard's Analyze. */
  onEnter?: () => void;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const debounced = useDebounced(value, DEBOUNCE_MS);
  const listId = useId();

  const { data } = useQuery({
    queryKey: ["fs-suggest", debounced],
    queryFn: () => api.suggestDirs(debounced),
    // Suggestions only matter while the field is being edited.
    enabled: focused && debounced.startsWith("/"),
    retry: false,
    staleTime: 5_000,
    placeholderData: keepPreviousData,
  });
  const matches = data?.matches ?? [];
  const open = focused && !dismissed && matches.length > 0;

  const select = (match: string) => {
    onChange(match);
    setDismissed(false);
    setHighlight(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (matches.length === 0) return;
      e.preventDefault();
      setDismissed(false);
      setHighlight((h) =>
        e.key === "ArrowDown"
          ? (h + 1) % matches.length
          : h <= 0
            ? matches.length - 1
            : h - 1,
      );
    } else if (e.key === "Enter") {
      const match = open ? matches[highlight] : undefined;
      if (match) {
        e.preventDefault();
        select(match);
      } else {
        onEnter?.();
      }
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setDismissed(true);
      setHighlight(-1);
    }
  };

  return (
    <div className={`relative ${className ?? ""}`}>
      <input
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && highlight >= 0 ? `${listId}-${highlight}` : undefined
        }
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setDismissed(false);
          setHighlight(-1);
          onChange(e.target.value);
        }}
        onFocus={() => {
          setFocused(true);
          setDismissed(false);
        }}
        onBlur={() => {
          setFocused(false);
          setDismissed(false);
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-mono focus:border-emerald-600 focus:outline-none disabled:opacity-40"
      />

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl shadow-black/40"
        >
          {matches.map((m, i) => (
            <li
              key={m}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === highlight}
              // Keep the input focused so the click lands after mousedown.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(m)}
              onMouseEnter={() => setHighlight(i)}
              title={m}
              className={`cursor-pointer truncate px-3 py-1.5 font-mono text-sm ${
                i === highlight
                  ? "bg-emerald-950/60 text-emerald-200"
                  : "text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              {m}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
