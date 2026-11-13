// ChartAxis.tsx — a Plotting chart panel's axes: the value axis at the left (its line, ticks, tick
// labels, optional gridlines and rotated title, with the bottom line of the plot) and the category
// axis below (each slot's label, shortened in the middle and turned when the labels are long).

import type { ReactNode } from "react";
import { compactChartLabel } from "./chartFormat";

export interface ChartValueAxisProps {
  /** Major ticks: where each is on the value scale and what it reads. */
  ticks: readonly { at: number; label: string }[];
  /** Minor ticks, drawn half as long and unlabelled. */
  minor?: readonly number[];
  /** The value scale: a value to its y in the panel. */
  y: (value: number) => number;
  left: number;
  top: number;
  plotWidth: number;
  plotHeight: number;
  showGrid: boolean;
  tickFont: number;
  axisFont: number;
  /** The axis title, drawn turned along the axis. */
  title: ReactNode;
}

export function ChartValueAxis({ ticks, minor = [], y, left, top, plotWidth, plotHeight, showGrid, tickFont, axisFont, title }: ChartValueAxisProps) {
  const plotBottom = top + plotHeight;
  return (
    <>
      {ticks.map((tick, i) => (
        <g key={`t${i}`}>
          {showGrid && <line x1={left} x2={left + plotWidth} y1={y(tick.at)} y2={y(tick.at)} stroke="#eee" />}
          <line x1={left - 4} x2={left} y1={y(tick.at)} y2={y(tick.at)} stroke="#94a3b8" />
          <text x={left - 6} y={y(tick.at) + 3} textAnchor="end" fontSize={tickFont} fill="#666">
            {tick.label}
          </text>
        </g>
      ))}
      {minor.map((at, i) => (
        <line key={`m${i}`} x1={left - 2} x2={left} y1={y(at)} y2={y(at)} stroke="#94a3b8" />
      ))}
      <line x1={left} x2={left} y1={top} y2={plotBottom} stroke="#94a3b8" />
      <line x1={left} x2={left + plotWidth} y1={plotBottom} y2={plotBottom} stroke="#94a3b8" />
      <text x={14} y={top + plotHeight / 2} textAnchor="middle" fontSize={axisFont} fill="#475569" transform={`rotate(-90 14 ${top + plotHeight / 2})`}>
        {title}
      </text>
    </>
  );
}

export interface ChartHorizontalValueAxisProps {
  ticks: readonly { at: number; label: string }[];
  minor?: readonly number[];
  /** The value scale: a value to its x in the panel. */
  x: (value: number) => number;
  left: number;
  top: number;
  plotWidth: number;
  plotHeight: number;
  showGrid: boolean;
  tickFont: number;
  axisFont: number;
  /** The axis title, centred below the tick labels. */
  title: ReactNode;
}

/**
 * The value axis along the bottom of the plot, as a ridgeline draws it: ticks and their labels
 * below the plot's bottom line, optional gridlines up through the plot, and the title under them.
 * A label that would run into the one before it is left out, as the Illustration's axes leave it.
 */
export function ChartHorizontalValueAxis({ ticks, minor = [], x, left, top, plotWidth, plotHeight, showGrid, tickFont, axisFont, title }: ChartHorizontalValueAxisProps) {
  const plotBottom = top + plotHeight;
  let right = -Infinity;
  const shown = ticks.map((tick) => {
    const at = x(tick.at);
    const half = tick.label.length * tickFont * 0.32 + 3;
    if (!tick.label || at - half < right) return "";
    right = at + half;
    return tick.label;
  });
  return (
    <>
      {ticks.map((tick, i) => (
        <g key={`t${i}`}>
          {showGrid && <line x1={x(tick.at)} x2={x(tick.at)} y1={top} y2={plotBottom} stroke="#eee" />}
          <line x1={x(tick.at)} x2={x(tick.at)} y1={plotBottom} y2={plotBottom + 4} stroke="#94a3b8" />
          {shown[i] && (
            <text x={x(tick.at)} y={plotBottom + 6 + tickFont} textAnchor="middle" fontSize={tickFont} fill="#666">
              {shown[i]}
            </text>
          )}
        </g>
      ))}
      {minor.map((at, i) => (
        <line key={`m${i}`} x1={x(at)} x2={x(at)} y1={plotBottom} y2={plotBottom + 2} stroke="#94a3b8" />
      ))}
      <line x1={left} x2={left + plotWidth} y1={plotBottom} y2={plotBottom} stroke="#94a3b8" />
      <text x={left + plotWidth / 2} y={plotBottom + 14 + tickFont + axisFont} textAnchor="middle" fontSize={axisFont} fill="#475569">
        {title}
      </text>
    </>
  );
}

export interface ChartCategoryAxisProps {
  /** Each slot's centre and label. */
  ticks: readonly { x: number; label: string }[];
  plotBottom: number;
  /** Turn the labels, as the panel's layout says when they are too long for their slots. */
  rotate: boolean;
  tickFont: number;
}

export function ChartCategoryAxis({ ticks, plotBottom, rotate, tickFont }: ChartCategoryAxisProps) {
  return (
    <>
      {ticks.map((tick, i) => (
        <text
          key={`x${i}`}
          x={tick.x}
          y={plotBottom + 18}
          textAnchor={rotate ? "end" : "middle"}
          fontSize={tickFont}
          fill="#334155"
          transform={rotate ? `rotate(-35 ${tick.x} ${plotBottom + 18})` : undefined}
        >
          <title>{tick.label}</title>
          {compactChartLabel(tick.label)}
        </text>
      ))}
    </>
  );
}
