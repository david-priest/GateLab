import { useMemo, useState } from "react";
import { ChevronIcon } from "./icons";
import type { Gate, PopulationMap } from "../engine/models";
import { useI18n } from "./i18n";
import { useGateInk, useGateSwatch } from "../plots/gateInk";
import { SEG, TreeConnectors } from "./TreeConnectors";

export interface StrategyPickerRow {
  popId: string;
  depth: number;
  isLastPath: boolean[];
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
 * The Strategy tab's population picker: the tree as the Gating tab draws it (connectors, the
 * gate's colour, the event count), in columns that break only between top-level branches, so
 * a branch is read whole; a search field; and the Gating tab's ticks, every population, none,
 * or the leaves, as on the Illustration tab. Compact, it is one indented column for a side pane,
 * long names shortened with the whole name as the row's tooltip.
 */
export function StrategyPopulationPicker({
  rows,
  populations,
  gates,
  counts,
  selected,
  onChange,
  checkedIds,
  compact = false,
}: {
  /** The populations in tree order, without the root. */
  rows: readonly StrategyPickerRow[];
  populations: PopulationMap;
  gates: Record<string, Gate>;
  counts: Record<string, number | null | undefined>;
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  /** The populations ticked on the Gating tab, offered as a selection. */
  checkedIds?: readonly string[];
  /** One column, for a side pane, rather than columns across the page. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const gateSwatch = useGateSwatch();
  const { coloured } = useGateInk();
  const [search, setSearch] = useState("");
  // Folded away, the picker is its heading, the count and the actions: room for the strategy.
  const [expanded, setExpanded] = useState(true);
  const chosen = useMemo(() => new Set(selected), [selected]);
  const hasChildren = useMemo(() => {
    const parents = new Set<string>();
    for (const pop of Object.values(populations)) if (pop.parent_id) parents.add(pop.parent_id);
    return parents;
  }, [populations]);
  const query = search.trim().toLowerCase();
  const shown = query ? rows.filter((row) => (populations[row.popId]?.name ?? "").toLowerCase().includes(query)) : rows;
  const minDepth = rows.length ? Math.min(...rows.map((row) => row.depth)) : 1;
  const columns = query || compact ? [[...shown]] : packColumns(shown, ROWS_PER_COLUMN);
  const toggle = (popId: string) => onChange(chosen.has(popId) ? selected.filter((id) => id !== popId) : [...selected, popId]);
  const swatchOf = (popId: string): string | null => {
    const ref = populations[popId]?.gate_refs?.[0];
    const gate = ref ? gates[ref.gate_id] : undefined;
    return gate ? gateSwatch(gate.color) : null;
  };

  return (
    <div className={`gl-strategy-pops${compact ? " is-compact" : ""}`} role="group" aria-label={t("Strategy populations")}>
      <div className={`gl-strategy-pops-head${expanded ? "" : " is-collapsed"}`}>
        <button
          type="button"
          className="gl-picker-collapse-toggle"
          aria-expanded={expanded}
          aria-label={t(expanded ? "Hide {label}" : "Show {label}", { label: t("Populations") })}
          title={t(expanded ? "Hide {label}" : "Show {label}", { label: t("Populations") })}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="gl-picker-chevron" aria-hidden="true"><ChevronIcon open={expanded} size={12} /></span>
          <span className="gl-stats-opt-label">{t("Populations")}</span>
        </button>
        <span className="gl-picker-summary">{t("{selected} of {total} selected", { selected: selected.length, total: rows.length })}</span>
        <input
          type="search"
          className="gl-strategy-pops-search"
          aria-label={t("Find population")}
          placeholder={t("Find population…")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="gl-strategy-pops-actions">
          {checkedIds && (
            <button
              type="button"
              className="gl-mini-btn"
              disabled={!checkedIds.length}
              title={t("The populations highlighted on the Gating tab")}
              onClick={() => onChange(rows.map((row) => row.popId).filter((id) => checkedIds.includes(id)))}
            >
              {t("Use checked")}
            </button>
          )}
          <button type="button" className="gl-mini-btn" onClick={() => onChange(rows.map((row) => row.popId))}>{t("All")}</button>
          <button type="button" className="gl-mini-btn" onClick={() => onChange([])}>{t("None")}</button>
          <button
            type="button"
            className="gl-mini-btn"
            title={t("The populations with nothing beneath them")}
            onClick={() => onChange(rows.map((row) => row.popId).filter((id) => !hasChildren.has(id)))}
          >
            {t("Leaves")}
          </button>
        </span>
      </div>
      {expanded && (
      <div className="gl-strategy-pops-body">
        {columns.map((column, index) => {
          // Each column's tree starts at its first row, flush left, so a column that opens inside
          // a branch reads from that branch's head rather than from lines with nothing above them;
          // a shallower row further down (the next branch) sits flush as well.
          const top = column.length ? column[0].depth : minDepth;
          return (
          <div className="gl-strategy-pops-column" key={column[0]?.popId ?? index}>
            {column.map((row) => {
              const pop = populations[row.popId];
              if (!pop) return null;
              const swatch = swatchOf(row.popId);
              const count = counts[row.popId];
              const depth = query ? 0 : Math.max(0, row.depth - top);
              return (
                <label
                  key={row.popId}
                  className={`gl-strategy-pop-row${chosen.has(row.popId) ? " is-selected" : ""}`}
                  title={pop.name}
                  style={query && row.depth > minDepth ? { paddingLeft: 6 + SEG * (row.depth - minDepth) } : undefined}
                >
                  {!query && <TreeConnectors depth={depth} isLastPath={row.isLastPath.slice(top)} />}
                  <input type="checkbox" checked={chosen.has(row.popId)} onChange={() => toggle(row.popId)} />
                  {/* No dots at all with black gates; with colour, a row without a gate keeps the dot's space. */}
                  {coloured && <span className="gl-strategy-pop-swatch" style={swatch ? { backgroundColor: swatch } : { visibility: "hidden" }} aria-hidden="true" />}
                  <span className="gl-strategy-pop-name">{pop.name}</span>
                  {typeof count === "number" && <span className="gl-strategy-pop-count">{count.toLocaleString()}</span>}
                </label>
              );
            })}
          </div>
          );
        })}
        {!shown.length && <div className="gl-strategy-pops-empty">{t("No population matches")}</div>}
      </div>
      )}
    </div>
  );
}
