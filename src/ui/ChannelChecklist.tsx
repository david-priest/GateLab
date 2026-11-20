// ChannelChecklist.tsx — a list of channels to tick, with a search field over it.
//
// Used where several channels are chosen at once: the Plotting tab's "More channels" and the
// Illustration tab's summary heatmap. A CyTOF panel lists sixty or more channels, so the search
// filters the rows by case-insensitive substring, as SearchableSelect does; ticked channels stay
// ticked while hidden. "Tick shown" and "Untick shown" act on the rows the search leaves.

import { useId, useState } from "react";
import { useI18n } from "./i18n";

export interface ChannelChecklistOption {
  key: string;
  label: string;
}

interface Props {
  options: readonly ChannelChecklistOption[];
  /** The ticked channels' keys. */
  checked: readonly string[];
  /** Tick or untick channels; several at once from the bulk buttons, in the options' order. */
  onToggle: (keys: string[], on: boolean) => void;
  /** Accessible name of the list, e.g. "More channels". */
  label: string;
  className?: string;
}

export function channelMatches(option: ChannelChecklistOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || option.label.toLowerCase().includes(q) || option.key.toLowerCase().includes(q);
}

export function ChannelChecklist({ options, checked, onToggle, label, className = "" }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const searchId = useId();
  const ticked = new Set(checked);
  const shown = options.filter((option) => channelMatches(option, query));
  return (
    <fieldset aria-label={label} className={`gl-channel-checklist ${className}`.trim()}>
      <div className="gl-channel-checklist-bar">
        <input
          id={searchId}
          type="search"
          aria-label={t("Search channels")}
          placeholder={t("Search channels…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
        <button
          type="button"
          disabled={!shown.some((option) => !ticked.has(option.key))}
          onClick={() => onToggle(shown.filter((option) => !ticked.has(option.key)).map((option) => option.key), true)}
        >
          {query.trim() ? t("Tick shown") : t("Tick all")}
        </button>
        <button
          type="button"
          disabled={!shown.some((option) => ticked.has(option.key))}
          onClick={() => onToggle(shown.filter((option) => ticked.has(option.key)).map((option) => option.key), false)}
        >
          {query.trim() ? t("Untick shown") : t("Untick all")}
        </button>
      </div>
      <div className="gl-channel-checklist-rows">
        {shown.map((option) => (
          <label key={option.key} className="gl-check">
            <input type="checkbox" checked={ticked.has(option.key)} onChange={(e) => onToggle([option.key], e.target.checked)} />
            {option.label}
          </label>
        ))}
        {!shown.length && <small className="gl-channel-checklist-empty">{t("No channel matches")}</small>}
      </div>
    </fieldset>
  );
}
