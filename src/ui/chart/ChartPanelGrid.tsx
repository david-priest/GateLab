// ChartPanelGrid.tsx — a Plotting chart's panels as the cells of its CSS grid, as they are
// arranged; a grid by rows and columns gets a heading above each column and beside each row, each
// an `svg.gl-prop-heading` that the export composer draws where it sits.

import type { ReactNode } from "react";
import { compactChartLabel } from "./chartFormat";
import { headingSizes, type PanelArrangement } from "../panelArrangement";

export interface ChartPanelGridOptions {
  /** The headings' text size, as a panel's title. */
  font: number;
  /** Each panel's size: a column heading is as wide as its panels, a row heading as tall. */
  panelWidth: number;
  panelHeight: number;
}

function Heading({ text, width, height, font, side }: { text: string; width: number; height: number; font: number; side: "column" | "row" }) {
  const chars = side === "row" ? Math.max(4, Math.floor((width - 8) / (font * 0.58))) : Math.max(4, Math.floor(width / (font * 0.58)));
  return (
    <svg className="gl-prop-heading" data-heading={side} width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <text
        x={side === "column" ? width / 2 : 0}
        y={side === "column" ? height - 6 : 14}
        textAnchor={side === "column" ? "middle" : "start"}
        fontSize={font}
        fontWeight={600}
        fill="#334155"
      >
        <title>{text}</title>
        {compactChartLabel(text, chars)}
      </text>
    </svg>
  );
}

/** The grid's column template and its cells: the panels, empty cells, and the headings of a grid by rows and columns. */
export function chartGridCells<T>(
  placed: PanelArrangement<T>,
  renderPanel: (panel: T) => ReactNode,
  options: ChartPanelGridOptions,
): { template: string; cells: ReactNode[] } {
  const panelCell = (panel: T | null, i: number) => (panel ? renderPanel(panel) : <div key={`empty-${i}`} className="gl-prop-panel-empty" aria-hidden="true" />);
  const headings = placed.headings;
  if (!headings) return { template: `repeat(${placed.columns}, max-content)`, cells: placed.cells.map(panelCell) };
  const size = headingSizes(placed, options.font);
  const cells: ReactNode[] = [<div key="corner" className="gl-prop-panel-empty" aria-hidden="true" />];
  headings.columns.forEach((text, c) =>
    cells.push(<Heading key={`column-${c}`} text={text} width={options.panelWidth} height={size.top} font={options.font} side="column" />),
  );
  headings.rows.forEach((text, r) => {
    cells.push(<Heading key={`row-${r}`} text={text} width={size.left} height={options.panelHeight} font={options.font} side="row" />);
    for (let c = 0; c < placed.columns; c++) cells.push(panelCell(placed.cells[r * placed.columns + c] ?? null, r * placed.columns + c));
  });
  return { template: `max-content repeat(${placed.columns}, max-content)`, cells };
}
