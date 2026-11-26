// ChartPanel.tsx — one panel of a Plotting chart: its `svg.gl-prop-panel` frame, which the export
// composer and the Layout block find it by, its title, and the line above the plot where a test
// between the panel's groups is written.

import type { ReactNode } from "react";
import { CHART_TITLE_CHARS, compactChartLabel } from "./chartFormat";
import { TITLE_CHAR_EM, textWidth } from "./chartLayout";

export interface ChartPanelProps {
  width: number;
  height: number;
  /** The panel's title, shortened in the middle to the panel's width and whole in its tooltip; empty for none. */
  title: string;
  titleFont: number;
  /** A test's result, centred above the plot, with what it is in its tooltip. */
  test?: { label: string; tooltip: string; plotLeft: number; plotWidth: number; plotTop: number; fontSize: number } | null;
  children: ReactNode;
}

/**
 * A panel title's longest shown length: at most CHART_TITLE_CHARS, and no wider than the panel at
 * the title's font (counted as the panel layouts count a title, TITLE_CHAR_EM of the font a character), so a
 * narrow panel shortens its title rather than cutting it at both edges. Never below 12 characters,
 * which compactChartLabel needs to keep some of the start and the last 8.
 */
export function panelTitleChars(width: number, titleFont: number): number {
  return Math.min(CHART_TITLE_CHARS, Math.max(12, Math.floor((width - 8) / textWidth(1, titleFont, TITLE_CHAR_EM))));
}

/**
 * The title as a panel of `width` shows it. In a panel narrower than a chart's longest title, one
 * too long for it that names a column and its value, "condition: control", says the value alone,
 * which is what tells the panels apart; what is still too long is shortened in the middle.
 */
export function panelTitleShown(title: string, width: number, titleFont: number): string {
  const chars = panelTitleChars(width, titleFont);
  const at = title.indexOf(": ");
  const narrow = chars < CHART_TITLE_CHARS && title.length > chars;
  const value = narrow && at >= 0 && !title.includes(" · ") ? title.slice(at + 2) : title;
  return compactChartLabel(value || title, chars);
}

export function ChartPanel({ width, height, title, titleFont, test, children }: ChartPanelProps) {
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="gl-prop-panel">
      {title && (
        <text x={width / 2} y={14} textAnchor="middle" fontSize={titleFont} fontWeight={600} fill="#334155">
          <title>{title}</title>
          {panelTitleShown(title, width, titleFont)}
        </text>
      )}
      {test && (
        <text className="gl-prop-test" x={test.plotLeft + test.plotWidth / 2} y={test.plotTop - 6} textAnchor="middle" fontSize={test.fontSize} fill="#334155">
          <title>{test.tooltip}</title>
          {test.label}
        </text>
      )}
      {children}
    </svg>
  );
}
