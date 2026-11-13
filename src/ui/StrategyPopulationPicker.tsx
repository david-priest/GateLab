import { useMemo } from "react";
import type { Gate, PopulationMap } from "../engine/models";
import { populationColorOf } from "../engine/palettes";
import { useI18n } from "./i18n";
import { PopulationChecklist } from "./PopulationChecklist";

export { packColumns, ROWS_PER_COLUMN } from "./PopulationChecklist";

export interface StrategyPickerRow {
  popId: string;
  depth: number;
  isLastPath: boolean[];
}

/**
 * The Strategy tab's population picker, the shared PopulationChecklist: the tree as the Gating
 * tab draws it (connectors, the population's colour, the event count), in columns that break only between top-level branches, so
 * a branch is read whole; a search field; and the Gating tab's ticks, every population, none,
 * or the leaves, as on the Illustration tab. Compact, it is one indented column for a side pane,
 * long names shortened with the whole name as the row's tooltip.
 */
export function StrategyPopulationPicker({
  rows,
  populations,
  counts,
  selected,
  onChange,
  checkedIds,
  compact = false,
}: {
  /** The populations in tree order, without the root. */
  rows: readonly StrategyPickerRow[];
  populations: PopulationMap;
  /** No longer read: each row shows its population's colour, as every tab colours it. */
  gates?: Record<string, Gate>;
  counts: Record<string, number | null | undefined>;
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  /** The populations ticked on the Gating tab, offered as a selection. */
  checkedIds?: readonly string[];
  /** One column, for a side pane, rather than columns across the page. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const hasChildren = useMemo(() => {
    const parents = new Set<string>();
    for (const pop of Object.values(populations)) if (pop.parent_id) parents.add(pop.parent_id);
    return parents;
  }, [populations]);
  const toggle = (popId: string) => onChange(selected.includes(popId) ? selected.filter((id) => id !== popId) : [...selected, popId]);
  const checklistRows = rows
    .filter((row) => populations[row.popId])
    .map((row) => ({
      key: row.popId,
      name: populations[row.popId].name,
      depth: row.depth,
      isLastPath: row.isLastPath,
      color: populationColorOf(populations[row.popId]),
      count: counts[row.popId],
    }));

  return (
    <PopulationChecklist
      rows={checklistRows}
      selected={selected}
      onToggle={toggle}
      compact={compact}
      label={t("Strategy populations")}
      summary={t("{selected} of {total} selected", { selected: selected.length, total: rows.length })}
      actions={<>
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
      </>}
    />
  );
}
