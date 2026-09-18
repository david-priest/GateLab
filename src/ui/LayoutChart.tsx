// LayoutChart.tsx — the Layout tab's summary chart: one statistic of one population, per file,
// grouped by a metadata column, as bars with points, points alone, or boxes, with a rank test
// between the groups. Pure SVG inside a `.mini-plot-cell`, so the sheet export clones it as a
// vector cell like any plot.

import { useMemo } from "react";
import { figureHierarchies, resolveFigurePopulation } from "../engine/figure";
import { exactMedian } from "../engine/heatmap";
import type { LayoutChartRecipe, LayoutPlotStyle } from "../engine/layout";
import { axisTicks, groupPoints, testGroups, type ChartGroup, type ChartPoint, type ChartTest } from "../engine/layoutChart";
import type { StoredHierarchy } from "../engine/hierarchies";
import type { Sample } from "../engine/sample";
import type { CoreState, GatingDerived } from "../store";

/** What a chart reads from a file: the file, its gating, and its tree. */
export interface ChartSource {
  id: string;
  name: string;
  sample: Sample;
  derived: GatingDerived;
  tree: StoredHierarchy;
}

export interface ChartData {
  points: ChartPoint[];
  groups: ChartGroup[];
  test: ChartTest | null;
  /** The population's name on the file it was chosen on. */
  population: string;
  /** What the value is, for the axis. */
  axis: string;
  /** Files the population could not be found on. */
  missing: string[];
}

export const CHART_STATISTIC_LABELS: Record<LayoutChartRecipe["statistic"], string> = {
  percent_of_parent: "% of parent",
  percent_of_total: "% of total",
  count: "Events",
  median: "Median",
};

/**
 * The chart's values: the statistic of the population on each file drawn, the population followed
 * through provenance into each file's tree as the plots do, grouped by the metadata column or,
 * with none, one group per file.
 */
export function chartData(
  recipe: LayoutChartRecipe,
  sources: readonly ChartSource[],
  metadataById: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
  checkedSampleIds: readonly string[],
  activeState: CoreState,
): ChartData {
  const template = sources.find((s) => s.id === recipe.sampleId) ?? null;
  const populationName = template?.tree.populations[recipe.populationId]?.name ?? "the population";
  const drawn = recipe.files === "all" ? sources : sources.filter((s) => checkedSampleIds.includes(s.id));
  const points: ChartPoint[] = [];
  const missing: string[] = [];
  for (const source of drawn) {
    let populationId = recipe.populationId;
    if (template && template.tree.id !== source.tree.id) {
      const resolved = resolveFigurePopulation(
        { hierarchyId: template.tree.id, populationId: recipe.populationId, label: "" },
        source.tree,
        figureHierarchies(activeState),
      );
      if (!resolved.id) {
        missing.push(source.name);
        continue;
      }
      populationId = resolved.id;
    }
    let value: number | null | undefined;
    if (recipe.statistic === "median") {
      const index = recipe.channel ? source.sample.index(recipe.channel) : undefined;
      const mask = source.derived.masks[populationId];
      if (index === undefined || !mask) value = null;
      else {
        const column = source.sample.displayColumn(index);
        const values: number[] = [];
        for (let i = 0; i < column.length; i++) if (mask[i] && Number.isFinite(column[i])) values.push(column[i]);
        value = values.length ? exactMedian(values) : null;
      }
    } else {
      value = source.derived.stats[recipe.statistic === "count" ? "event_count" : recipe.statistic][populationId];
    }
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const group = recipe.groupBy ? (metadataById[source.id]?.[recipe.groupBy] ?? "") : source.name;
    points.push({ sampleId: source.id, name: source.name, group, value });
  }
  const groups = groupPoints(points);
  const axis = recipe.statistic === "median" ? `Median ${recipe.channel ?? ""}`.trim() : CHART_STATISTIC_LABELS[recipe.statistic];
  return { points, groups, test: recipe.test && recipe.groupBy ? testGroups(groups) : null, population: populationName, axis, missing };
}

const format = (v: number): string => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(Number(v.toPrecision(3))));

/** A stable jitter in −1..1 from an index, so points do not move between renders. */
const jitter = (i: number): number => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 2 - 1;

export function LayoutChart({
  data,
  recipe,
  style,
  width,
  height,
  title,
}: Readonly<{
  data: ChartData;
  recipe: LayoutChartRecipe;
  style: LayoutPlotStyle;
  width: number;
  height: number;
  title: string;
}>) {
  const fontTick = style.fontTick;
  const fontAxis = style.fontAxis;
  const fontTitle = style.fontTitle;
  const groups = data.groups;
  const scale = useMemo(() => axisTicks(data.points.map((p) => p.value)), [data.points]);
  const left = 8 + fontAxis + 6 + Math.max(...scale.ticks.map((t) => format(t).length), 1) * fontTick * 0.6 + 8;
  const top = 8 + (title ? fontTitle + 6 : 0) + (data.test ? fontTick + 10 : 0);
  const longestLabel = Math.max(0, ...groups.map((g) => g.label.length));
  const rotate = groups.length > 0 && longestLabel * fontTick * 0.6 > (width - left - 8) / groups.length;
  const bottom = 8 + (rotate ? longestLabel * fontTick * 0.45 + 10 : fontTick + 8);
  const plotW = Math.max(20, width - left - 8);
  const plotH = Math.max(20, height - top - bottom);
  const y = (v: number) => top + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;
  const slot = groups.length ? plotW / groups.length : plotW;
  const x = (i: number) => left + (i + 0.5) * slot;
  const barW = Math.min(48, slot * 0.6);
  const ink = style.pubStyle ? "#000000" : "#334155";
  const fill = style.pubStyle ? "#d4d4d8" : "#93c5fd";
  const point = style.pubStyle ? "#000000" : "#1d4ed8";
  const zero = y(Math.max(scale.min, 0));

  return (
    <div className="mini-plot-cell gl-layout-chart" style={{ width, height, position: "relative" }} role="img" aria-label={`${title}: ${data.axis} across ${data.points.length} files`}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block", fontFamily: "Arial, Helvetica, sans-serif" }}>
        <rect width={width} height={height} fill="#ffffff" />
        {title && (
          <text x={width / 2} y={8 + fontTitle} textAnchor="middle" fontSize={fontTitle} fontWeight={600} fill={ink}>{title}</text>
        )}
        {!data.points.length && (
          <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={fontTick} fill="#64748b">
            {data.missing.length ? `${data.population} is not on ${data.missing.length} of the files` : "No files to draw"}
          </text>
        )}
        <g className="gl-layout-chart-axis" fontSize={fontTick} fill={ink}>
          <line x1={left} x2={left} y1={top} y2={top + plotH} stroke={ink} />
          {scale.ticks.map((t) => (
            <g key={t}>
              <line x1={left - 4} x2={left} y1={y(t)} y2={y(t)} stroke={ink} />
              <text x={left - 6} y={y(t)} textAnchor="end" dominantBaseline="central">{format(t)}</text>
            </g>
          ))}
          <text transform={`translate(${8 + fontAxis} ${top + plotH / 2}) rotate(-90)`} textAnchor="middle" fontSize={fontAxis}>{data.axis}</text>
          <line x1={left} x2={left + plotW} y1={zero} y2={zero} stroke={ink} />
        </g>
        <g className="gl-layout-chart-groups">
          {groups.map((g, i) => {
            const cx = x(i);
            const gpoints = recipe.showPoints || recipe.chartType === "dots" ? g.points : [];
            return (
              <g key={g.label || String(i)}>
                {recipe.chartType === "bars" && Number.isFinite(g.mean) && (
                  <>
                    <rect x={cx - barW / 2} y={Math.min(y(g.mean), zero)} width={barW} height={Math.abs(zero - y(g.mean))} fill={fill} stroke={ink} strokeWidth={0.8} />
                    {g.n > 1 && g.sd > 0 && (
                      <g stroke={ink} strokeWidth={1}>
                        <line x1={cx} x2={cx} y1={y(g.mean - g.sd)} y2={y(g.mean + g.sd)} />
                        <line x1={cx - barW / 4} x2={cx + barW / 4} y1={y(g.mean + g.sd)} y2={y(g.mean + g.sd)} />
                        <line x1={cx - barW / 4} x2={cx + barW / 4} y1={y(g.mean - g.sd)} y2={y(g.mean - g.sd)} />
                      </g>
                    )}
                  </>
                )}
                {recipe.chartType === "box" && g.n > 0 && (
                  <g stroke={ink} strokeWidth={1} fill={fill}>
                    <line x1={cx} x2={cx} y1={y(g.min)} y2={y(g.q1)} />
                    <line x1={cx} x2={cx} y1={y(g.q3)} y2={y(g.max)} />
                    <rect x={cx - barW / 2} y={y(g.q3)} width={barW} height={Math.max(0.5, y(g.q1) - y(g.q3))} />
                    <line x1={cx - barW / 2} x2={cx + barW / 2} y1={y(g.median)} y2={y(g.median)} strokeWidth={2} />
                  </g>
                )}
                {recipe.chartType === "dots" && g.n > 1 && (
                  <line x1={cx - barW / 2} x2={cx + barW / 2} y1={y(g.mean)} y2={y(g.mean)} stroke={ink} strokeWidth={2} />
                )}
                {gpoints.map((p, j) => (
                  <circle key={p.sampleId} cx={cx + jitter(j + i * 31) * barW * 0.3} cy={y(p.value)} r={Math.max(2, fontTick * 0.28)} fill={point} stroke="#ffffff" strokeWidth={0.8}>
                    <title>{`${p.name}: ${format(p.value)}`}</title>
                  </circle>
                ))}
                <text
                  x={cx}
                  y={top + plotH + 6}
                  textAnchor={rotate ? "end" : "middle"}
                  dominantBaseline="hanging"
                  fontSize={fontTick}
                  fill={ink}
                  transform={rotate ? `rotate(-45 ${cx} ${top + plotH + 6})` : undefined}
                >
                  {g.label}
                </text>
              </g>
            );
          })}
        </g>
        {data.test && groups.length >= 2 && (
          <g className="gl-layout-chart-test" fontSize={fontTick} fill={ink}>
            <line x1={x(0)} x2={x(groups.length - 1)} y1={top - 4} y2={top - 4} stroke={ink} />
            <text x={(x(0) + x(groups.length - 1)) / 2} y={top - 7} textAnchor="middle">{data.test.label}</text>
          </g>
        )}
      </svg>
    </div>
  );
}
