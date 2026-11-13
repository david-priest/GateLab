// chartComparisons.tsx — the rank tests a Plotting chart draws between the groups of a panel: the
// overall test written above the plot, and with pairwise comparisons on, every pair of groups as a
// bracket with its Holm-adjusted p (as R's pairwise.wilcox.test). Where the chart joins each unit
// across groups, a pair is tested by the Wilcoxon signed-rank test on the units in both groups.
// The tests are the engine's (layoutChart, rankTests); this module chooses them, stacks the
// brackets and draws them, and says in words what is tested.

import { formatP, kruskalWallis, wilcoxonRankSum } from "../../engine/layoutChart";
import { SAMPLE_ID_FIELD } from "../../engine/metadata";
import { holmAdjust, pairwiseWilcoxon, wilcoxonSignedRank } from "../../engine/rankTests";
import { PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "../../engine/proportionsSettings";
import type { ChartPanelLayout } from "./chartLayout";

/** The settings the comparisons follow; `paired` is whether the chart joins each unit across groups. */
export interface ComparisonOptions {
  comparisons: ProportionsSettings["comparisons"];
  comparisonsShow: ProportionsSettings["comparisonsShow"];
  paired: boolean;
}

/** A test written above a panel's plot. */
export interface PanelOverallTest {
  name: "Wilcoxon rank-sum" | "Kruskal–Wallis" | "Wilcoxon signed-rank";
  statistic: number;
  p: number;
  label: string;
  /** For the signed-rank test, the units in both groups. */
  pairs?: number;
}

/** A comparison of two groups of a panel, by their slots along x. */
export interface PanelComparison {
  /** The slots compared, a < b. */
  a: number;
  b: number;
  groupA: string;
  groupB: string;
  test: "Wilcoxon rank-sum" | "Wilcoxon signed-rank";
  /** U of group a against group b for the rank-sum test, V of the differences a − b for the signed-rank test; null when not tested. */
  statistic: number | null;
  p: number | null;
  /** Holm-adjusted over the panel's pairs tested; with two groups, p itself. */
  pAdjusted: number | null;
  /** The values of each group compared; for the signed-rank test, both are the units in both groups. */
  nA: number;
  nB: number;
  /** For the signed-rank test, the units in both groups; null for the rank-sum test. */
  pairs: number | null;
}

export interface PanelTests {
  overall: PanelOverallTest | null;
  pairs: PanelComparison[];
}

/** A slot along a panel's x axis: its group and each replicate unit's value there. */
export interface ComparisonSlot {
  label: string;
  values: readonly { unit: string; value: number }[];
}

/** Whether a chart's test is paired: a proportion boxplot that joins each unit across its groups, units not being files. */
export function comparisonPaired(settings: Pick<ProportionsSettings, "valueKind" | "plotType" | "paired" | "unitSel">): boolean {
  return settings.valueKind === "proportion" && settings.plotType === "box" && settings.paired && settings.unitSel !== PROPORTIONS_SAMPLE_FACTOR && settings.unitSel !== PROPORTIONS_NO_FACTOR;
}

/** The units in both groups, in the first group's order, with their two values. */
function matched(a: ComparisonSlot, b: ComparisonSlot): { x: number[]; y: number[] } {
  const other = new Map<string, number>();
  for (const entry of b.values) if (!other.has(entry.unit)) other.set(entry.unit, entry.value);
  const seen = new Set<string>();
  const x: number[] = [];
  const y: number[] = [];
  for (const entry of a.values) {
    if (seen.has(entry.unit) || !other.has(entry.unit)) continue;
    seen.add(entry.unit);
    x.push(entry.value);
    y.push(other.get(entry.unit)!);
  }
  return { x, y };
}

/**
 * A panel's tests. Overall: the rank-sum test for two groups and Kruskal–Wallis for more, as
 * testGroups, or paired, the signed-rank test for two groups. Pairwise: with two groups one
 * bracket and no line; with more, the Kruskal–Wallis line and a bracket for every pair, or paired,
 * a signed-rank test for every pair, Holm-adjusted, and no line (there is no paired overall test
 * here). A slot without values takes no part.
 */
export function panelTests(slots: readonly ComparisonSlot[], options: ComparisonOptions): PanelTests {
  const filled = slots.map((slot, index) => ({ slot, index })).filter((entry) => entry.slot.values.length > 0);
  const values = filled.map((entry) => entry.slot.values.map((v) => v.value));
  const k = filled.length;
  const signedRank = (i: number, j: number) => {
    const { x, y } = matched(filled[i].slot, filled[j].slot);
    return { pairs: x.length, test: wilcoxonSignedRank(x, y) };
  };
  if (options.comparisons !== "pairwise") {
    if (k === 2 && options.paired) {
      const { pairs, test } = signedRank(0, 1);
      return { overall: test ? { name: test.name, statistic: test.statistic, p: test.p, label: test.label, pairs } : null, pairs: [] };
    }
    const overall = k === 2 ? wilcoxonRankSum(values[0], values[1]) : k > 2 ? kruskalWallis(values) : null;
    return { overall, pairs: [] };
  }
  const pairs: PanelComparison[] = [];
  if (options.paired) {
    for (let i = 0; i < k; i++)
      for (let j = i + 1; j < k; j++) {
        const { pairs: n, test } = signedRank(i, j);
        pairs.push({ a: filled[i].index, b: filled[j].index, groupA: filled[i].slot.label, groupB: filled[j].slot.label, test: "Wilcoxon signed-rank", statistic: test?.statistic ?? null, p: test?.p ?? null, pAdjusted: null, nA: n, nB: n, pairs: n });
      }
    const adjusted = holmAdjust(pairs.map((pair) => pair.p));
    pairs.forEach((pair, i) => (pair.pAdjusted = adjusted[i]));
    return { overall: null, pairs };
  }
  for (const pair of pairwiseWilcoxon(values)) {
    pairs.push({ a: filled[pair.a].index, b: filled[pair.b].index, groupA: filled[pair.a].slot.label, groupB: filled[pair.b].slot.label, test: "Wilcoxon rank-sum", statistic: pair.statistic, p: pair.p, pAdjusted: pair.pAdjusted, nA: values[pair.a].length, nB: values[pair.b].length, pairs: null });
  }
  return { overall: k > 2 ? kruskalWallis(values) : null, pairs };
}

/** The brackets a panel draws: each pair tested, or with "significant", those with an adjusted p below 0.05. */
export function shownComparisons(pairs: readonly PanelComparison[], show: ComparisonOptions["comparisonsShow"]): PanelComparison[] {
  return pairs.filter((pair) => pair.pAdjusted !== null && (show === "all" || pair.pAdjusted < 0.05));
}

/**
 * Each bracket's row above the plot, 0 the lowest: the shortest spans first, each bracket above
 * every bracket within its span and in the lowest row where it overlaps none (sharing a group
 * counts), so no two brackets in a row overlap.
 */
export function bracketLevels(pairs: readonly Pick<PanelComparison, "a" | "b">[]): number[] {
  const order = pairs.map((pair, index) => ({ pair, index })).sort((x, y) => x.pair.b - x.pair.a - (y.pair.b - y.pair.a) || x.pair.a - y.pair.a);
  const levels = new Array<number>(pairs.length).fill(0);
  const placed: { a: number; b: number; level: number }[] = [];
  for (const { pair, index } of order) {
    // Above every bracket within its span, then the lowest row where it overlaps none.
    let level = 0;
    for (const other of placed) if (pair.a <= other.a && other.b <= pair.b) level = Math.max(level, other.level + 1);
    while (placed.some((other) => other.level === level && other.a <= pair.b && pair.a <= other.b)) level++;
    levels[index] = level;
    placed.push({ a: pair.a, b: pair.b, level });
  }
  return levels;
}

/** The rows a panel's brackets take. */
export function bracketRows(pairs: readonly Pick<PanelComparison, "a" | "b">[]): number {
  return pairs.length ? Math.max(...bracketLevels(pairs)) + 1 : 0;
}

/**
 * The room a chart's panels need above their plots: a line for the overall test where the chart
 * draws one (pairwise, only where a panel writes one), and the rows of brackets of the most
 * stacked panel.
 */
export function comparisonSpace(tests: Iterable<PanelTests>, options: Pick<ComparisonOptions, "comparisons" | "comparisonsShow">): { testLine: boolean; brackets: number } {
  let any = false;
  let brackets = 0;
  for (const panel of tests) {
    if (panel.overall) any = true;
    brackets = Math.max(brackets, bracketRows(shownComparisons(panel.pairs, options.comparisonsShow)));
  }
  return { testLine: options.comparisons === "overall" || any, brackets };
}

/** The height of a row of brackets: the label at the tick font over the line and its end ticks. */
export function bracketRowHeight(tickFont: number): number {
  return tickFont + 6;
}

/** The layout with `rows` rows of brackets above the plot: the top margin and the panel grown by them. */
export function withBracketRows<L extends ChartPanelLayout>(layout: L, tickFont: number, rows: number): L {
  if (rows <= 0) return layout;
  const extra = rows * bracketRowHeight(tickFont);
  return { ...layout, height: layout.height + extra, margin: { ...layout.margin, top: layout.margin.top + extra } };
}

/** A bracket's tooltip: the test, the groups, the statistic, p and adjusted p, and n. */
export function comparisonTooltip(pair: PanelComparison, on: string): string {
  const n = pair.pairs !== null ? `${pair.pairs} ${pair.pairs === 1 ? "pair" : "pairs"}` : `n = ${pair.nA} and ${pair.nB}`;
  const statistic = pair.statistic === null ? "" : `, ${pair.test === "Wilcoxon signed-rank" ? "V" : "U"} = ${pair.statistic}`;
  const p = pair.p === null ? "" : `, ${formatP(pair.p)}, Holm-adjusted ${formatP(pair.pAdjusted ?? pair.p)}`;
  return `${pair.test}, ${pair.groupA} against ${pair.groupB}${statistic}${p}, ${n}, on ${on}`;
}

export interface ChartBracketsProps {
  pairs: readonly PanelComparison[];
  /** A slot's centre along x. */
  x: (slot: number) => number;
  /** The plot's top edge; the brackets stand on it. */
  plotTop: number;
  fontSize: number;
  /** What the test is on, for the tooltips: "one value per replicate unit". */
  on: string;
}

/**
 * A panel's brackets, stacked above the plot: a line from one group's centre to the other's with
 * short end ticks, at the axis line's width, and the adjusted p above it. Drawn outside the clip
 * a typed limit puts on the marks.
 */
export function ChartBrackets({ pairs, x, plotTop, fontSize, on }: ChartBracketsProps) {
  if (!pairs.length) return null;
  const levels = bracketLevels(pairs);
  const row = bracketRowHeight(fontSize);
  return (
    <g className="gl-prop-brackets">
      {pairs.map((pair, i) => {
        const lineY = plotTop - 4 - levels[i] * row;
        const x1 = x(pair.a) + 2;
        const x2 = x(pair.b) - 2;
        return (
          <g key={`${pair.a}-${pair.b}`} className="gl-prop-bracket">
            <title>{comparisonTooltip(pair, on)}</title>
            <path d={`M${x1},${lineY + 3}V${lineY}H${x2}V${lineY + 3}`} fill="none" stroke="#334155" strokeWidth={1} />
            <text x={(x1 + x2) / 2} y={lineY - 2} textAnchor="middle" fontSize={fontSize} fill="#334155">
              {formatP(pair.pAdjusted ?? pair.p ?? NaN)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** What a replicate unit is called, singular and plural, as layoutSources' unitNoun names it. */
function unitWords(unitSel: string): { one: string; many: string } {
  if (unitSel === PROPORTIONS_SAMPLE_FACTOR || unitSel === PROPORTIONS_NO_FACTOR) return { one: "file", many: "files" };
  if (unitSel === SAMPLE_ID_FIELD) return { one: "sample", many: "samples" };
  if (/^[A-Za-z][A-Za-z ]*$/.test(unitSel)) {
    const one = unitSel.trim().toLowerCase();
    return { one, many: one.endsWith("s") ? one : `${one}s` };
  }
  return { one: `unit of ${unitSel}`, many: `units of ${unitSel}` };
}

const STATISTIC_WORDS: Record<ProportionsSettings["statistic"], string> = { median: "medians", mean: "means", geomean: "geometric means" };
const PROPORTION_WORDS: Record<ProportionsSettings["proportionValue"], string> = { parent: "shares of the parent", total: "shares of the total", count: "event counts" };

/**
 * What a chart's rank test tests, and on what, as one sentence without its full stop: "Wilcoxon
 * rank-sum test on the files' medians, Holm-adjusted over 3 pairs". `groupCount` is the number of
 * groups the chart compares. Empty when the chart draws no test.
 */
export function comparisonDescription(
  settings: Pick<ProportionsSettings, "valueKind" | "plotType" | "test" | "xAxis" | "comparisons" | "paired" | "unitSel" | "statistic" | "proportionValue" | "replicateMarks"> & Partial<Pick<ProportionsSettings, "populationsTogether">>,
  groupCount: number,
): string {
  // With the populations together in one panel, no test is drawn: it compares groups within a population's panel.
  const tested = settings.valueKind === "proportion"
    ? settings.plotType !== "stacked"
    : settings.xAxis === "groups" && !settings.populationsTogether && (settings.valueKind === "statistic" || settings.replicateMarks !== "none");
  if (!settings.test || !tested) return "";
  const unit = unitWords(settings.unitSel);
  const what = settings.valueKind === "proportion"
    ? PROPORTION_WORDS[settings.proportionValue]
    : settings.valueKind === "statistic"
      ? STATISTIC_WORDS[settings.statistic]
      : STATISTIC_WORDS[settings.replicateMarks === "mean" ? "mean" : "median"];
  const on = `on the ${unit.many}' ${what}`;
  if (groupCount < 2) return "No test: there are fewer than two groups";
  const paired = comparisonPaired(settings);
  const pairCount = (groupCount * (groupCount - 1)) / 2;
  const pairing = `, each ${unit.one} paired with itself across the groups`;
  if (settings.comparisons !== "pairwise" || groupCount === 2) {
    if (groupCount === 2) return `${paired ? "Wilcoxon signed-rank" : "Wilcoxon rank-sum"} test ${on}${paired ? pairing : ""}`;
    return `Kruskal–Wallis test ${on}${paired ? "; it does not take the pairing into account" : ""}`;
  }
  if (paired) return `Wilcoxon signed-rank test of each pair of groups ${on}${pairing}, Holm-adjusted over ${pairCount} pairs; no overall test is made for paired groups`;
  return `Kruskal–Wallis test across the groups, and Wilcoxon rank-sum test of each pair, ${on}, Holm-adjusted over ${pairCount} pairs`;
}
