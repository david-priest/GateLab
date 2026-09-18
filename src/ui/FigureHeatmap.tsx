// FigureHeatmap.tsx — the summary heatmap drawn as one matrix, in the manner of
// seekit::plotExprHeatmap1: dendrograms on the left and top when rows and columns are clustered,
// row names beside the cells, channel names at 45° beneath them, event counts as bars on the
// right, a vertical colour legend titled with the statistic and its scaling, and white cell
// borders. Pure SVG with no effects, so it renders to static markup for the export as it does on
// screen, and the export's cell walk picks it up as any other `.mini-plot-cell`.

import { useId } from "react";
import {
  HEATMAP_PALETTES,
  dendrogramSegments,
  paletteColour,
  type HeatmapMatrix,
  type HeatmapMatrixPalette,
} from "../engine/figureHeatmap";
import type { IllustrationConfig } from "../engine/workspace";

const PAD = 8;
const DENDRO_ROWS = 64;
const DENDRO_COLUMNS = 52;
const BARS_WIDTH = 96;
const LEGEND_GAP = 26;
const LEGEND_BAR = 14;
const LEGEND_TEXT = 46;

/** Roughly the width of a run of text in a sans face: 0.58 em per character. */
const textWidth = (text: string, fontSize: number): number => text.length * fontSize * 0.58;

const formatValue = (v: number): string => {
  if (!Number.isFinite(v)) return "";
  const abs = Math.abs(v);
  if (abs >= 1000) return Math.round(v).toLocaleString();
  return String(Number(v.toPrecision(3)));
};

export function FigureHeatmap({
  matrix,
  config,
  cellSize,
}: {
  matrix: HeatmapMatrix;
  config: IllustrationConfig;
  cellSize: number;
}) {
  const gradientId = useId().replace(/:/g, "");
  const fontLabel = config.fontAxis || 12;
  const fontSmall = config.fontTick || 10;
  const fontTitle = config.fontTitle || 12;
  const palette = HEATMAP_PALETTES[(config.heatmapPalette as HeatmapMatrixPalette) in HEATMAP_PALETTES ? (config.heatmapPalette as HeatmapMatrixPalette) : "rdylbu"];
  const showValues = config.heatmapShowValues !== false && cellSize >= 22;
  const bars = (config.heatmapBars ?? "counts") !== "none";

  const rows = matrix.rowOrder.map((i) => matrix.rows[i]);
  const columns = matrix.columnOrder.map((i) => matrix.columns[i]);
  const rowDendro = matrix.rowTree?.root?.children ? dendrogramSegments(matrix.rowTree.root) : null;
  const columnDendro = matrix.columnTree?.root?.children ? dendrogramSegments(matrix.columnTree.root) : null;
  const rowLabelsRight = !!rowDendro;

  const rowLabelWidth = Math.ceil(Math.max(0, ...rows.map((row) => textWidth(row.label, fontLabel)))) + 10;
  const columnLabelHeight = Math.ceil(Math.max(0, ...columns.map((column) => textWidth(column.label, fontLabel))) * 0.72) + 12;
  const matrixWidth = columns.length * cellSize;
  const matrixHeight = rows.length * cellSize;
  const legendHeight = Math.max(80, Math.min(160, matrixHeight));
  const legendTitleHeight = fontSmall * 2 + 10;

  const left = PAD + (rowDendro ? DENDRO_ROWS : rowLabelWidth);
  const top = PAD + Math.max(columnDendro ? DENDRO_COLUMNS : 0, legendTitleHeight);
  const afterMatrix = left + matrixWidth + (rowLabelsRight ? rowLabelWidth : 0);
  const barsLeft = afterMatrix + (bars ? 10 : 0);
  const legendLeft = (bars ? barsLeft + BARS_WIDTH : afterMatrix) + LEGEND_GAP;
  const width = Math.ceil(legendLeft + LEGEND_BAR + LEGEND_TEXT + PAD);
  const height = Math.ceil(top + Math.max(matrixHeight, legendHeight) + columnLabelHeight + PAD);

  const span = matrix.legend.max - matrix.legend.min || 1;
  const colourOf = (v: number | null) => (v === null ? null : paletteColour(palette, (v - matrix.legend.min) / span));
  const maxCount = Math.max(1, ...rows.map((row) => row.count));
  const ticks = Array.from({ length: 5 }, (_, i) => matrix.legend.min + (span * i) / 4);
  const legendTop = top;

  return (
    <div
      className="mini-plot-cell gl-figure-heatmap"
      style={{ width, height, position: "relative" }}
      role="img"
      aria-label={`Summary heatmap of ${rows.length} populations by ${columns.length} channels`}
      data-render-family="illustration"
      data-plot-key="heatmap"
    >
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block", fontFamily: "Arial, Helvetica, sans-serif" }}>
        <rect width={width} height={height} fill="#ffffff" />
        <defs>
          <linearGradient id={gradientId} x1="0%" x2="0%" y1="100%" y2="0%">
            {palette.map((stop, i) => (
              <stop key={i} offset={`${(i / (palette.length - 1)) * 100}%`} stopColor={stop} />
            ))}
          </linearGradient>
        </defs>
        {rowDendro && (
          <g className="gl-heatmap-dendrogram-rows" stroke="#334155" strokeWidth={1} fill="none">
            {rowDendro.segments.map((s, i) => {
              const scale = rowDendro.maxHeight > 0 ? (DENDRO_ROWS - 8) / rowDendro.maxHeight : 0;
              const x1 = left - 4 - s.fromHeight * scale;
              const x2 = left - 4 - s.toHeight * scale;
              const y1 = top + (s.from + 0.5) * cellSize;
              const y2 = top + (s.to + 0.5) * cellSize;
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
            })}
          </g>
        )}
        {columnDendro && (
          <g className="gl-heatmap-dendrogram-columns" stroke="#334155" strokeWidth={1} fill="none">
            {columnDendro.segments.map((s, i) => {
              const scale = columnDendro.maxHeight > 0 ? (DENDRO_COLUMNS - 8) / columnDendro.maxHeight : 0;
              const y1 = top - 4 - s.fromHeight * scale;
              const y2 = top - 4 - s.toHeight * scale;
              const x1 = left + (s.from + 0.5) * cellSize;
              const x2 = left + (s.to + 0.5) * cellSize;
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
            })}
          </g>
        )}
        <g className="gl-heatmap-cells">
          {rows.map((row, r) =>
            columns.map((column, c) => {
              const ri = matrix.rowOrder[r];
              const ci = matrix.columnOrder[c];
              const raw = matrix.raw[ri][ci];
              const scaled = matrix.scaled[ri][ci];
              const colour = colourOf(scaled);
              const x = left + c * cellSize;
              const y = top + r * cellSize;
              const lines = [row.label, column.label, `${matrix.stat}: ${raw === null ? "no events" : formatValue(raw)}`];
              if (matrix.scale !== "none" && scaled !== null) lines.push(`scaled: ${formatValue(scaled)}`);
              lines.push(`events: ${row.count.toLocaleString()}`);
              return (
                <g key={`${row.key}|${column.plotId}`}>
                  <rect x={x} y={y} width={cellSize} height={cellSize} fill={colour ? colour.colour : "#e5e7eb"} stroke="#ffffff" strokeWidth={1} />
                  <title>{lines.join("\n")}</title>
                  {showValues && raw !== null && (
                    <text
                      x={x + cellSize / 2}
                      y={y + cellSize / 2}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={Math.min(fontSmall, Math.max(6, cellSize * 0.3))}
                      fill={colour?.light ? "#ffffff" : "#1f2937"}
                      style={{ fontVariantNumeric: "tabular-nums", pointerEvents: "none" }}
                    >
                      {formatValue(raw)}
                    </text>
                  )}
                </g>
              );
            }),
          )}
        </g>
        <g className="gl-heatmap-row-labels" fontSize={fontLabel} fill="#1f2937">
          {rows.map((row, r) => (
            <text
              key={row.key}
              x={rowLabelsRight ? left + matrixWidth + 6 : left - 6}
              y={top + (r + 0.5) * cellSize}
              textAnchor={rowLabelsRight ? "start" : "end"}
              dominantBaseline="central"
            >
              {row.label}
            </text>
          ))}
        </g>
        <g className="gl-heatmap-column-labels" fontSize={fontLabel} fill="#1f2937">
          {columns.map((column, c) => {
            const x = left + (c + 0.5) * cellSize;
            const y = top + matrixHeight + 6;
            return (
              <text key={column.plotId} x={x} y={y} textAnchor="end" dominantBaseline="hanging" transform={`rotate(-45 ${x} ${y})`}>
                {column.label}
              </text>
            );
          })}
        </g>
        {bars && (
          <g className="gl-heatmap-bars" fontSize={fontSmall} fill="#475569">
            {rows.map((row, r) => {
              const barWidth = (row.count / maxCount) * (BARS_WIDTH - 44);
              const y = top + r * cellSize + cellSize * 0.2;
              return (
                <g key={row.key}>
                  <rect x={barsLeft} y={y} width={Math.max(0, barWidth)} height={cellSize * 0.6} fill="#94a3b8" />
                  <text x={barsLeft + Math.max(0, barWidth) + 4} y={top + (r + 0.5) * cellSize} dominantBaseline="central">
                    {row.count.toLocaleString()}
                  </text>
                </g>
              );
            })}
            <text x={barsLeft} y={top + matrixHeight + 6} dominantBaseline="hanging">events</text>
          </g>
        )}
        <g className="gl-heatmap-legend">
          <text x={legendLeft} y={legendTop - legendTitleHeight + fontSmall} fontSize={fontSmall} fontWeight={600} fill="#334155">
            {matrix.legend.title.map((line, i) => (
              <tspan key={i} x={legendLeft} dy={i ? fontSmall + 2 : 0}>{line}</tspan>
            ))}
          </text>
          <rect x={legendLeft} y={legendTop} width={LEGEND_BAR} height={legendHeight} fill={`url(#${gradientId})`} stroke="#64748b" strokeWidth={0.6} />
          {ticks.map((tick, i) => {
            const y = legendTop + legendHeight - (i / 4) * legendHeight;
            return (
              <g key={i} fontSize={fontSmall} fill="#475569">
                <line x1={legendLeft + LEGEND_BAR} x2={legendLeft + LEGEND_BAR + 4} y1={y} y2={y} stroke="#64748b" />
                <text x={legendLeft + LEGEND_BAR + 6} y={y} dominantBaseline="central">{formatValue(tick)}</text>
              </g>
            );
          })}
        </g>
        <text x={PAD} y={PAD + fontTitle} fontSize={fontTitle} fill="#94a3b8" style={{ display: "none" }} />
      </svg>
    </div>
  );
}
