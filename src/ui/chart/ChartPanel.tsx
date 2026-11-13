// ChartPanel.tsx — one panel of a Plotting chart: its `svg.gl-prop-panel` frame, which the export
// composer and the Layout block find it by, its title, and the line above the plot where a test
// between the panel's groups is written.

import type { ReactNode } from "react";
import { CHART_TITLE_CHARS, compactChartLabel } from "./chartFormat";

export interface ChartPanelProps {
  width: number;
  height: number;
  /** The panel's title, shortened in the middle and whole in its tooltip; empty for none. */
  title: string;
  titleFont: number;
  /** A test's result, centred above the plot, with what it is in its tooltip. */
  test?: { label: string; tooltip: string; plotLeft: number; plotWidth: number; plotTop: number; fontSize: number } | null;
  children: ReactNode;
}

export function ChartPanel({ width, height, title, titleFont, test, children }: ChartPanelProps) {
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="gl-prop-panel">
      {title && (
        <text x={width / 2} y={14} textAnchor="middle" fontSize={titleFont} fontWeight={600} fill="#334155">
          <title>{title}</title>
          {compactChartLabel(title, CHART_TITLE_CHARS)}
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
