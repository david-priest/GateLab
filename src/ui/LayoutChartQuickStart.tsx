// LayoutChartQuickStart.tsx — the Layout tab's "+ Chart": a small popover that makes a Plotting
// chart block from one population, one statistic and a grouping column, or takes the Plotting
// tab's current chart. Closes on Add, on Escape or on a click elsewhere, as the colour popover does.

import { useEffect, useRef, useState } from "react";
import type { LayoutChartStatistic } from "../engine/layout";
import { useI18n } from "./i18n";

export type QuickStartStatistic = Exclude<LayoutChartStatistic, "median">;

export interface QuickStartChoice {
  populationId: string;
  statistic: QuickStartStatistic;
  /** A metadata column; empty for each file its own group. */
  groupBy: string;
}

export function LayoutChartQuickStart({
  x,
  y,
  populations,
  defaultPopulation,
  metadataColumns,
  onAdd,
  onTakePlotting,
  onClose,
}: Readonly<{
  x: number;
  y: number;
  /** The populations of the file the chart is made on, in tree order. */
  populations: readonly { popId: string; depth: number; name: string }[];
  defaultPopulation: string;
  metadataColumns: readonly string[];
  onAdd: (choice: QuickStartChoice) => void;
  /** Takes the Plotting tab's current chart instead; absent when there is no Plotting tab. */
  onTakePlotting?: () => void;
  onClose: () => void;
}>) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const [populationId, setPopulationId] = useState(defaultPopulation || populations[0]?.popId || "");
  const [statistic, setStatistic] = useState<QuickStartStatistic>("percent_of_parent");
  const [groupBy, setGroupBy] = useState(metadataColumns[0] ?? "");
  useEffect(() => {
    const onDown = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) onClose(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLSelectElement>("select")?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const left = Math.max(4, Math.min(x, window.innerWidth - 260));
  const top = Math.max(4, Math.min(y, window.innerHeight - 200));
  return (
    <div
      ref={root}
      className="gl-menu-popover gl-layout-chart-start"
      role="dialog"
      aria-label={t("New chart")}
      style={{ position: "fixed", left, top, display: "grid", gap: 6, padding: 8, zIndex: 50 }}
    >
      <label className="gl-field-inline">
        {t("Population")}
        <select aria-label={t("Population")} value={populationId} onChange={(event) => setPopulationId(event.target.value)}>
          {populations.map(({ popId, depth, name }) => (
            <option key={popId} value={popId}>
              {" ".repeat(depth * 2)}
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="gl-field-inline">
        {t("Statistic")}
        <select aria-label={t("Statistic")} value={statistic} onChange={(event) => setStatistic(event.target.value as QuickStartStatistic)}>
          <option value="percent_of_parent">{t("% of parent")}</option>
          <option value="percent_of_total">{t("% of total")}</option>
          <option value="count">{t("Count")}</option>
        </select>
      </label>
      <label className="gl-field-inline">
        {t("Group by")}
        <select aria-label={t("Group by")} value={groupBy} onChange={(event) => setGroupBy(event.target.value)}>
          <option value="">{t("Each file")}</option>
          {metadataColumns.map((column) => (
            <option key={column} value={column}>{column}</option>
          ))}
        </select>
      </label>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" className="gl-mini-btn" disabled={!populationId} onClick={() => onAdd({ populationId, statistic, groupBy })}>
          {t("Add")}
        </button>
        {onTakePlotting && (
          <button type="button" className="gl-mini-btn" title={t("Add the Plotting tab's current chart as one block, drawn here as it is there")} onClick={onTakePlotting}>
            {t("Take the Plotting tab's chart")}
          </button>
        )}
      </div>
    </div>
  );
}
