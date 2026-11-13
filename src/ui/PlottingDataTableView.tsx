// PlottingDataTableView.tsx — the table a Plotting chart is drawn from, shown under the chart in a
// fold that is closed by default and remembered for the session. The rows are the CSV export's
// rows (plottingData.ts), built only while the fold is open. It sits outside the chart's export
// container, so no exported figure and no Layout block draws it.

import { useMemo, useState } from "react";
import { FoldSummary } from "./FoldSummary";
import { useI18n } from "./i18n";
import { usePersistedTabState } from "./tabState";
import type { PlottingDataTable } from "./plottingData";

/** Rows drawn at most; the rest are in the CSV. */
export const PLOTTING_TABLE_MAX_ROWS = 2000;

const NUMERIC = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Whether each column holds numbers only (empty fields aside), so it is right-aligned. */
export function numericColumns(table: PlottingDataTable): boolean[] {
  return table.header.map((_, column) => {
    let any = false;
    for (const row of table.rows) {
      const value = row[column];
      if (value === "" || value === undefined) continue;
      if (typeof value !== "number" && !NUMERIC.test(value)) return false;
      any = true;
    }
    return any;
  });
}

/** The table as tab-separated text with a header line, for pasting into a spreadsheet. */
export function plottingDataTableTsv(table: PlottingDataTable): string {
  const field = (value: string | number) => String(value).replace(/[\t\r\n]+/g, " ");
  const text = [table.header, ...table.rows].map((record) => record.map(field).join("\t")).join("\n") + "\n";
  return table.comparisons ? `${text}\n${plottingDataTableTsv(table.comparisons)}` : text;
}

export interface PlottingDataTableViewProps {
  /** Builds the chart's table; called only while the fold is open. Keep it stable between renders. */
  build: () => PlottingDataTable;
  /** Downloads the same table as CSV (the Export section's "Data (CSV)"). */
  onDownloadCsv: () => void;
}

export function PlottingDataTableView({ build, onDownloadCsv }: PlottingDataTableViewProps) {
  const { t } = useI18n();
  const [open, setOpen] = usePersistedTabState("plotting.dataTableOpen", false);
  return (
    <details
      className="gl-plotting-data"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <FoldSummary>{t("Data behind this chart")}</FoldSummary>
      {open && <PlottingDataTableBody build={build} onDownloadCsv={onDownloadCsv} />}
    </details>
  );
}

function PlottingDataTableBody({ build, onDownloadCsv }: PlottingDataTableViewProps) {
  const { t } = useI18n();
  const table = useMemo(build, [build]);
  const numeric = useMemo(() => numericColumns(table), [table]);
  const [copied, setCopied] = useState(false);
  const shown = table.rows.length > PLOTTING_TABLE_MAX_ROWS ? table.rows.slice(0, PLOTTING_TABLE_MAX_ROWS) : table.rows;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plottingDataTableTsv(table));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="gl-plotting-data-body">
      <div className="gl-plotting-actions">
        <button
          type="button"
          className="gl-mini-btn"
          title={t("The table as tab-separated text, for pasting into a spreadsheet")}
          onClick={() => void copy()}
        >
          {t("Copy")}
        </button>
        <button type="button" className="gl-mini-btn" onClick={onDownloadCsv}>
          {t("Data (CSV)")}
        </button>
        {copied && <span role="status">{t("Copied")}</span>}
      </div>
      {table.rows.length > PLOTTING_TABLE_MAX_ROWS && (
        <p className="gl-hint" role="status">
          {t("The first {shown} of {count} rows are shown; the CSV has all of them.", { shown: String(PLOTTING_TABLE_MAX_ROWS), count: String(table.rows.length) })}
        </p>
      )}
      <div className="gl-plotting-data-scroll">
        <table className="gl-plotting-data-table">
          <thead>
            <tr>
              {table.header.map((title, column) => (
                <th key={column} scope="col" className={numeric[column] ? "is-number" : undefined}>{table.fileColumns?.includes(column) ? t(title) : title}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i}>
                {row.map((value, column) => (
                  <td key={column} className={numeric[column] ? "is-number" : undefined}>{value}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.comparisons && <ComparisonsTable table={table.comparisons} />}
    </div>
  );
}

/** The tests block under the chart's table: each panel's tests, as the CSV's second block. */
function ComparisonsTable({ table }: { table: PlottingDataTable }) {
  const { t } = useI18n();
  const numeric = useMemo(() => numericColumns(table), [table]);
  return (
    <div className="gl-plotting-data-scroll">
      <table className="gl-plotting-data-table" aria-label={t("Tests between groups")}>
        <thead>
          <tr>
            {table.header.map((title, column) => (
              <th key={column} scope="col" className={numeric[column] ? "is-number" : undefined}>{table.fileColumns?.includes(column) ? t(title) : title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i}>
              {row.map((value, column) => (
                <td key={column} className={numeric[column] ? "is-number" : undefined}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
