// ChartLegend.tsx — a Plotting chart's HTML legend: a row per entry (swatch and label) that
// highlights its marks on hover and keeps them highlighted on a click, the note shown while one is
// kept, and the spacing rules a legend is laid out and framed by.

import { useI18n } from "../i18n";

/** A legend's columns: at most ten rows, up to four columns. */
export function chartLegendColumns(entries: number): number {
  return Math.min(4, Math.max(1, Math.ceil(entries / 10)));
}

/** A legend line's height over its font size on a Layout page, which the page's CSS sets (`.gl-layout-proportions-host .gl-prop-legend`) so that a block's frame can count it. */
export const CHART_LEGEND_LINE = 1.4;
/** The card's gap between the panels and the legend under them. */
export const CHART_LEGEND_GAP = 10;
const SWATCH = 12;

/**
 * A legend's height on a Layout page under its chart, the gap over it counted, as the page draws
 * it: the rule and the padding over the entries (11 px), `rows` rows of entries (a line, or the
 * swatch where that is taller, in 2 px of padding and a 1 px border), 4 px between rows, and the
 * title's line over them when `titled`. A line is counted to the whole pixel above: the canvas,
 * zoomed, draws a row of 21.4 px as 22.
 */
export function chartLegendHeight(rows: number, fontLegend: number, titled = false): number {
  const line = Math.ceil(fontLegend * CHART_LEGEND_LINE);
  return CHART_LEGEND_GAP + 11 + rows * (Math.max(line, SWATCH) + 6) + (rows - 1) * 4 + (titled ? line + 4 : 0);
}

/** A label's width at a font size, counted generously: capitals and digits 0.68 em, a full-width character 1 em, any other 0.56 em. */
function legendTextWidth(text: string, font: number): number {
  let em = 0;
  for (const ch of text) em += ch.codePointAt(0)! > 0x2e7f ? 1 : /[A-Z0-9+%@&#]/.test(ch) ? 0.68 : 0.56;
  return em * font;
}

/**
 * The least width a legend takes on a Layout page: its columns each as wide as the longest entry
 * (3 px of padding and a 1 px border a side, the swatch and its 6 px gap, the label), 12 px
 * between columns, and no narrower than its title, which is written in semibold.
 */
export function chartLegendWidth(labels: readonly string[], columns: number, fontLegend: number, title?: string): number {
  const entry = 8 + SWATCH + 6 + Math.max(0, ...labels.map((label) => legendTextWidth(label, fontLegend)));
  return Math.ceil(Math.max(columns * entry + (columns - 1) * 12, title ? legendTextWidth(title, fontLegend) * 1.08 : 0));
}

export interface ChartLegendEntry {
  /** The category or group the entry stands for, which the marks' highlight reads. */
  index: number;
  label: string;
  color: string;
}

export interface ChartLegendProps {
  entries: readonly ChartLegendEntry[];
  /** What the entries are, written above them. */
  title?: string;
  highlighted: number | null;
  pinned: number | null;
  setHovered: (index: number | null) => void;
  setPinned: (update: (current: number | null) => number | null) => void;
  hidden: boolean;
  ariaLabel: string;
  fontSize: number;
  columns: number;
  /** False on a Layout sheet and in a figure: the entries are a key, not buttons, and highlight nothing. */
  interactive?: boolean;
}

export function ChartLegend({ entries, title, highlighted, pinned, setHovered, setPinned, hidden, ariaLabel, fontSize, columns, interactive = true }: ChartLegendProps) {
  const { t } = useI18n();
  if (!interactive) {
    return (
      <div className="gl-prop-legend" hidden={hidden} aria-label={ariaLabel} style={{ fontSize, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {title && <span className="gl-prop-legend-title">{title}</span>}
        {entries.map(({ index, label, color }) => <ChartLegendKey key={index} label={label} color={color} />)}
      </div>
    );
  }
  return (
    <div
      className="gl-prop-legend"
      onPointerLeave={() => setHovered(null)}
      hidden={hidden}
      aria-label={ariaLabel}
      style={{ fontSize, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {title && <span className="gl-prop-legend-title">{title}</span>}
      {entries.map(({ index, label, color }) => (
        <button
          type="button"
          key={index}
          className={"gl-prop-legend-item" + (highlighted === index ? " highlighted" : "")}
          title={t("{label} — hover to highlight; click to keep it highlighted, click again to clear", { label })}
          aria-pressed={pinned === index}
          onMouseEnter={() => setHovered(index)}
          onMouseLeave={() => setHovered(null)}
          onFocus={() => setHovered(index)}
          onBlur={() => setHovered(null)}
          onClick={() => setPinned((current) => (current === index ? null : index))}
        >
          <span className="gl-prop-swatch" style={{ background: color }} />
          <span className="gl-prop-legend-label">{label}</span>
        </button>
      ))}
    </div>
  );
}

/** A legend entry as a key alone: the swatch and the label, with nothing to press. */
export function ChartLegendKey({ label, color }: { label: string; color: string }) {
  return (
    <span className="gl-prop-legend-item is-static">
      <span className="gl-prop-swatch" style={{ background: color }} />
      <span className="gl-prop-legend-label">{label}</span>
    </span>
  );
}

/** The note shown while a legend entry is kept highlighted, with a button to show every mark again. */
export function ChartHighlightNote({ label, onClear }: { label: string; onClear: () => void }) {
  const { t } = useI18n();
  return (
    <p className="gl-prop-highlight-note" role="status">
      {t("Highlighting {label}; the rest is faded. Click it again, the chart or Show all to clear.", { label })}
      <button type="button" className="gl-mini-btn" onClick={onClear}>{t("Show all")}</button>
    </p>
  );
}
