// PopulationChecklist.tsx — the one picker for choosing several populations: the tree as the
// Gating tab draws it (connectors, each population's colour, an optional count or note), a search
// field, and the actions the tab offers. Strategy's multiple mode, Illustration's population list
// and overlay checklists, Plotting's population list and the Layout inspector's overlay checklist
// all draw it; each keeps its own selection and says what a tick does.

import { useMemo, useState, type ReactNode } from "react";
import { ChevronIcon } from "./icons";
import { useI18n } from "./i18n";
import { SEG, TreeConnectors } from "./TreeConnectors";

export interface PopulationChecklistRow {
  /** The row's identity in the selection. */
  key: string;
  name: string;
  depth: number;
  isLastPath: boolean[];
  /** The population's colour (populationColorOf); a row without one keeps the swatch's space. */
  color?: string;
  count?: number | null;
  /** A note after the name, such as the tree's name or how many files have the population. */
  meta?: ReactNode;
  /** What the search field matches; the name unless given. */
  searchText?: string;
}

/**
 * The connector flags (TreeConnectors' isLastPath) of rows given in tree order by their depths
 * alone, as for a list that leaves some of a tree's populations out: a row is the last of its
 * siblings when no later row at its depth comes before a shallower one; an ancestor not listed
 * draws no line.
 */
export function lastPaths(depths: readonly number[]): boolean[][] {
  const flags: boolean[] = [];
  return depths.map((depth, i) => {
    let last = true;
    for (let j = i + 1; j < depths.length && depths[j] >= depth; j++) {
      if (depths[j] === depth) { last = false; break; }
    }
    flags.length = Math.max(0, Math.min(flags.length, depth - 1));
    while (flags.length < depth - 1) flags.push(true);
    if (depth > 0) flags[depth - 1] = last;
    return flags.slice(0, depth);
  });
}

/** Rows a column holds before the next starts. */
export const ROWS_PER_COLUMN = 12;

/**
 * The rows in columns of at most `limit`, each break taken at the shallowest point in the last
 * third of the column (where a branch ends and the next begins), so a branch is split only when
 * it is longer than a column.
 */
export function packColumns<T extends { depth: number }>(rows: readonly T[], limit: number): T[][] {
  const out: T[][] = [];
  let start = 0;
  while (start < rows.length) {
    let end = Math.min(rows.length, start + limit);
    if (end < rows.length) {
      let best = end, shallowest = Infinity;
      for (let i = end; i >= start + Math.floor((2 * limit) / 3); i--) {
        if (rows[i].depth < shallowest) { shallowest = rows[i].depth; best = i; }
      }
      end = best;
    }
    out.push(rows.slice(start, end));
    start = end;
  }
  return out;
}

/**
 * Compact, it is one indented column for a side pane, long names shortened with the whole name as
 * the row's tooltip; otherwise columns across the page that break only between top-level branches.
 */
export function PopulationChecklist({
  rows,
  selected,
  onToggle,
  actions,
  pick,
  label,
  title,
  summary,
  searchLabel,
  compact = false,
  collapsible = true,
  heading: showHeading = true,
  className,
}: Readonly<{
  /** The populations in tree order. */
  rows: readonly PopulationChecklistRow[];
  selected: readonly string[];
  onToggle: (key: string) => void;
  /** The tab's buttons beside the search field (All, None, Leaves…). */
  actions?: ReactNode;
  /**
   * Choosing one population rather than ticking several, as Plotting's parent is changed: each
   * row is a button that picks its population, the current one pressed.
   */
  pick?: { current: string; onPick: (key: string) => void; title: (name: string) => string };
  /** The group's accessible name. */
  label?: string;
  /** The heading; "Populations" unless given. */
  title?: string;
  /** The count beside the heading; "n of m selected" unless given. */
  summary?: ReactNode;
  searchLabel?: string;
  compact?: boolean;
  /** Whether the heading folds the tree away. */
  collapsible?: boolean;
  /** Whether the picker draws its heading and count; off where the tab heads the list itself. */
  heading?: boolean;
  className?: string;
}>) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  // Folded away, the picker is its heading, the count and the actions: room for what it draws.
  const [expanded, setExpanded] = useState(true);
  const chosen = useMemo(() => new Set(selected), [selected]);
  const heading = title ?? t("Populations");
  const query = search.trim().toLowerCase();
  const shown = query ? rows.filter((row) => (row.searchText ?? row.name).toLowerCase().includes(query)) : rows;
  const minDepth = rows.length ? Math.min(...rows.map((row) => row.depth)) : 1;
  const columns = query || compact ? [[...shown]] : packColumns(shown, ROWS_PER_COLUMN);

  return (
    <div className={`gl-strategy-pops gl-pop-checklist${compact ? " is-compact" : ""}${className ? ` ${className}` : ""}`} role="group" aria-label={label ?? heading}>
      <div className={`gl-strategy-pops-head${expanded ? "" : " is-collapsed"}`}>
        {!showHeading ? null : collapsible ? (
          <button
            type="button"
            className="gl-picker-collapse-toggle"
            aria-expanded={expanded}
            aria-label={t(expanded ? "Hide {label}" : "Show {label}", { label: heading })}
            title={t(expanded ? "Hide {label}" : "Show {label}", { label: heading })}
            onClick={() => setExpanded((current) => !current)}
          >
            <span className="gl-picker-chevron" aria-hidden="true"><ChevronIcon open={expanded} size={12} /></span>
            <span className="gl-stats-opt-label">{heading}</span>
          </button>
        ) : (
          <span className="gl-stats-opt-label">{heading}</span>
        )}
        {showHeading && <span className="gl-picker-summary">{summary ?? t("{selected} of {total} selected", { selected: rows.filter((row) => chosen.has(row.key)).length, total: rows.length })}</span>}
        <input
          type="search"
          className="gl-strategy-pops-search"
          aria-label={searchLabel ?? t("Find population")}
          placeholder={t("Find population…")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {actions && <span className="gl-strategy-pops-actions">{actions}</span>}
      </div>
      {expanded && (
      <div className="gl-strategy-pops-body">
        {columns.map((column, index) => {
          // Each column's tree starts at its first row, flush left, so a column that opens inside
          // a branch reads from that branch's head rather than from lines with nothing above them;
          // a shallower row further down (the next branch) sits flush as well.
          const top = column.length ? column[0].depth : minDepth;
          return (
          <div className="gl-strategy-pops-column" key={column[0]?.key ?? index}>
            {column.map((row) => {
              const depth = query ? 0 : Math.max(0, row.depth - top);
              const style = query && row.depth > minDepth ? { paddingLeft: 6 + SEG * (row.depth - minDepth) } : undefined;
              const connectors = !query && <TreeConnectors depth={depth} isLastPath={row.isLastPath.slice(top)} />;
              const body = (<>
                <span className="gl-strategy-pop-swatch" style={row.color ? { background: row.color } : { visibility: "hidden" }} aria-hidden="true" />
                <span className="gl-strategy-pop-name">{row.name}</span>
                {row.meta}
                {typeof row.count === "number" && <span className="gl-strategy-pop-count">{row.count.toLocaleString()}</span>}
              </>);
              if (pick) {
                return (
                  <button
                    type="button"
                    key={row.key}
                    data-pop-key={row.key}
                    className={`gl-strategy-pop-row gl-pop-checklist-pick${row.key === pick.current ? " is-selected" : ""}`}
                    title={pick.title(row.name)}
                    aria-pressed={row.key === pick.current}
                    style={style}
                    onClick={() => pick.onPick(row.key)}
                  >
                    {connectors}
                    {body}
                  </button>
                );
              }
              return (
                <label
                  key={row.key}
                  data-pop-key={row.key}
                  className={`gl-strategy-pop-row${chosen.has(row.key) ? " is-selected" : ""}`}
                  title={row.name}
                  style={style}
                >
                  {connectors}
                  <input type="checkbox" checked={chosen.has(row.key)} onChange={() => onToggle(row.key)} />
                  {body}
                </label>
              );
            })}
          </div>
          );
        })}
        {!shown.length && rows.length > 0 && <div className="gl-strategy-pops-empty">{t("No population matches")}</div>}
      </div>
      )}
    </div>
  );
}
