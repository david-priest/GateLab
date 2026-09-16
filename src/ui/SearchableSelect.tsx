// SearchableSelect.tsx — a select you can type into.
//
// Deliberately the same interaction as the channel picker that opens when an axis label on the
// plot is clicked (cytof_plot.js `_showChannelPicker`): a search field over a listbox, filtered
// by case-insensitive substring, Escape to close, ArrowDown into the list, Enter to take the
// first match. That picker lives in the renderer and belongs to GateLabR, so this is a React
// equivalent rather than a call into it — but a user should not be able to tell which one they
// are using, and the keyboard behaviour is copied for exactly that reason.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "./i18n";

export interface SearchableOption {
  value: string;
  label: string;
  /** Optional heading this option sits under. Options carrying none come first, ungrouped. */
  group?: string;
}

interface Props {
  value: string;
  options: SearchableOption[];
  onChange: (value: string) => void;
  /** Accessible name for the control, e.g. "Colour by". */
  label: string;
  className?: string;
  title?: string;
}

/** Rows shown at once before the list scrolls. The axis picker's number. */
const VISIBLE_ROWS = 12;

/**
 * How well an option answers the query: lower is better. Only used to pick what Enter takes;
 * the list itself is never reordered, so the panel always looks the same.
 */
function matchRank(option: SearchableOption, query: string): number {
  const label = option.label.toLowerCase();
  const q = query.toLowerCase();
  if (label === q) return 0;
  if (label.startsWith(q)) return 1;
  if (label.includes(q)) return 2;
  return 3;
}

function matches(option: SearchableOption, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  // The group name is searched too: "channel" reaches every channel, which is what a user who
  // types a category rather than a name is asking for.
  return option.label.toLowerCase().includes(q) || (option.group ?? "").toLowerCase().includes(q);
}

export function SearchableSelect({ value, options, onChange, label, className = "", title }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLSelectElement>(null);
  const listId = useId();

  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(
    () => options.filter((option) => matches(option, query)),
    [options, query],
  );

  // With a query, the BEST match is the one Enter takes; with none, the current value is shown
  // selected so the list opens on where you already are.
  //
  // Best, not first. The list stays in the panel's own order — the axis picker's order, and the
  // order a user scanning it expects — but typing "CD8" and getting CD83 because it sorts earlier
  // is a papercut the axis picker has and this need not copy. An exact name beats a prefix, a
  // prefix beats a substring, and only then does list order decide.
  const highlighted = query
    ? [...filtered].sort((a, b) => matchRank(a, query) - matchRank(b, query))[0]?.value
    : filtered.some((option) => option.value === value) ? value : filtered[0]?.value;

  // A choice closes the panel; a click on a row that fires both change and click must not
  // choose twice, and nothing chooses once the panel is closing.
  const closingRef = useRef(false);
  const close = (restoreFocus: boolean) => {
    closingRef.current = true;
    setOpen(false);
    setQuery("");
    if (restoreFocus) triggerRef.current?.focus();
  };

  const choose = (next: string) => {
    if (closingRef.current || !next) return;
    onChange(next);
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    closingRef.current = false;
    inputRef.current?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const grouped = useMemo(() => {
    const ungrouped = filtered.filter((option) => !option.group);
    const groups: { name: string; options: SearchableOption[] }[] = [];
    for (const option of filtered) {
      if (!option.group) continue;
      const existing = groups.find((g) => g.name === option.group);
      if (existing) existing.options.push(option);
      else groups.push({ name: option.group, options: [option] });
    }
    return { ungrouped, groups };
  }, [filtered]);

  return (
    <div ref={rootRef} className={`gl-searchable-select${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="gl-searchable-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={title}
        onClick={() => setOpen((current) => !current)}
      >
        {selected?.label ?? value}
      </button>
      {open && (
        <div className="gl-searchable-select-panel">
          <input
            ref={inputRef}
            type="text"
            autoComplete="off"
            placeholder={t("Type to search…")}
            aria-label={t("Search {label}", { label })}
            aria-controls={listId}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") close(true);
              else if (event.key === "ArrowDown") {
                event.preventDefault();
                listRef.current?.focus();
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (highlighted !== undefined) choose(highlighted);
              }
            }}
          />
          {filtered.length === 0 ? (
            <p className="gl-searchable-select-empty">{t("No matches")}</p>
          ) : (
            <select
              ref={listRef}
              id={listId}
              size={Math.min(filtered.length + grouped.groups.length, VISIBLE_ROWS)}
              value={highlighted}
              aria-label={label}
              onChange={(event) => choose(event.currentTarget.value)}
              // A click on the row that is already selected -- the best match after typing,
              // which is the common case -- fires no change on a sized select, so the click
              // itself chooses. The mousedown before it has already made the row the value.
              onClick={(event) => choose(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") close(true);
                // A sized select fires no change for Enter on the already-selected row, which is
                // the common case after typing: the first match is selected before Enter is hit.
                else if (event.key === "Enter" && event.currentTarget.value) {
                  event.preventDefault();
                  choose(event.currentTarget.value);
                }
              }}
            >
              {grouped.ungrouped.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
              {grouped.groups.map((group) => (
                <optgroup key={group.name} label={group.name}>
                  {group.options.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
}
