// LevelOrderControl.tsx — a metadata column's order of its values: one line that reads the order,
// opening to the values with an up and a down button each and a link back to the default order
// (each value at its first file, in the file list's order). The Plotting tab and the Metadata tab
// both show it; it sets the workspace column's `levels`, so the order holds in every tab.

import { useI18n } from "./i18n";
import { FoldSummary } from "./FoldSummary";

export interface LevelOrderControlProps {
  /** What the levels are, for the list's name ("Group", "Facet"). */
  label: string;
  /** The levels in the order the chart draws them. */
  levels: readonly string[];
  /** Whether the user has set an order, so there is one to reset. */
  customised: boolean;
  /** A line under the open list. */
  hint?: string;
  onReorder: (levels: string[]) => void;
  onReset: () => void;
}

/**
 * A column's levels after the values shown were put in a new order: those values in that order,
 * then the column's other levels (values the files shown do not carry) in their order before.
 */
export function columnLevelsAfterReorder(order: readonly string[], previous?: readonly string[]): string[] {
  const shown = new Set(order);
  return [...order, ...(previous ?? []).filter((level) => !shown.has(level))];
}

/** The levels with the one at `index` moved by `by` places, kept within the list. */
export function moveLevel(levels: readonly string[], index: number, by: number): string[] {
  const to = Math.max(0, Math.min(levels.length - 1, index + by));
  const out = [...levels];
  const [level] = out.splice(index, 1);
  out.splice(to, 0, level);
  return out;
}

export function LevelOrderControl({ label, levels, customised, hint, onReorder, onReset }: LevelOrderControlProps) {
  const { t } = useI18n();
  if (levels.length < 2) return null;
  const line = levels.join(", ");
  return (
    <details className="gl-prop-order">
      <FoldSummary>
        <span>{t("Order")}</span>
        <span className="gl-prop-order-line" title={line}>{line}</span>
      </FoldSummary>
      <ol className="gl-prop-order-list" aria-label={`${label} ${t("Order").toLowerCase()}`}>
        {levels.map((level, i) => (
          <li key={level}>
            <span className="gl-prop-order-name" title={level}>{level}</span>
            <button
              type="button"
              className="gl-mini-btn"
              aria-label={`${t("Move up")}: ${level}`}
              title={t("Move up")}
              disabled={i === 0}
              onClick={() => onReorder(moveLevel(levels, i, -1))}
            >
              ↑
            </button>
            <button
              type="button"
              className="gl-mini-btn"
              aria-label={`${t("Move down")}: ${level}`}
              title={t("Move down")}
              disabled={i === levels.length - 1}
              onClick={() => onReorder(moveLevel(levels, i, 1))}
            >
              ↓
            </button>
          </li>
        ))}
      </ol>
      {hint && <p className="gl-prop-order-hint">{hint}</p>}
      {customised && (
        <button type="button" className="gl-prop-order-reset" title={t("Back to the order of the files in the file list")} onClick={onReset}>
          {t("Reset order")}
        </button>
      )}
    </details>
  );
}
