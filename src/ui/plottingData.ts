// plottingData.ts — the table a Plotting chart is drawn from, as header and rows (shown under the
// chart) and as CSV, so its numbers can be checked or replotted elsewhere: a proportion chart's counts per file, a per-cell chart's
// summaries of each violin or box, and a statistic chart's value per replicate unit. Numbers are
// in measured (linear) units, taken as the Statistics tab takes them on "Raw". A per-cell chart's
// median and quartiles are computed on the linear values; its whiskers are found on the display
// values the chart draws and given as the measured values of the cells they end at.

import { cellBoxStats, type CellValuesModel } from "../engine/cellValuesModel";
import type { ProportionsModel } from "../engine/proportionsModel";
import type { ProportionsSettings } from "../engine/proportionsSettings";
import { significantNumber } from "./compensationUiFormat";
import { csvText } from "./StatsTab";
import { statisticChartFrame, statisticPoints } from "./StatisticChart";
import type { CellReplicates, PlottingLevels } from "./CellValuesChart";
import { PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR } from "../engine/proportionsSettings";
import { columnValueOrder } from "../engine/levelOrder";
import type { ComparisonOptions, PanelComparison, PanelOverallTest, PanelTests } from "./chart/chartComparisons";
import { proportionPanelTests } from "./ProportionsChart";
import { cellPanels, cellReplicateFrame } from "./CellValuesChart";

/** Headers for the chart's factors: the metadata column's name, "File" or "Sample ID". */
export interface PlottingFactorTitles {
  group?: string;
  unit?: string;
  facet?: string;
}

/** A chart's table: its column headers and its rows, the one source of its CSV and of the table shown under it. */
export interface PlottingDataTable {
  header: string[];
  rows: (string | number)[][];
  /** Built-in file columns whose displayed headings use the host's vocabulary; metadata names stay as supplied. */
  fileColumns?: number[];
  /** With pairwise or paired tests, a second block: each panel's tests, one row per test. */
  comparisons?: PlottingDataTable;
}

/** A chart's table as CSV text; a second block follows after an empty line. */
export function plottingDataTableCsv(table: PlottingDataTable): string {
  const main = csvText([table.header, ...table.rows]);
  return table.comparisons ? `${main}\r\n${csvText([table.comparisons.header, ...table.comparisons.rows])}` : main;
}

/**
 * A chart of several channels' tables as one: each channel's rows led by its label in a Channel
 * column, and its tests block likewise. Each table is made with an empty channel name, so its
 * value columns are named without one ("Median", "Q1").
 */
export function channelsDataTable(tables: readonly { channel: string; table: PlottingDataTable }[]): PlottingDataTable {
  const named = (header: readonly string[]) => ["Channel", ...header.map((title) => title.replace(/\s+/g, " ").trim())];
  const tested = tables.filter(({ table }) => table.comparisons);
  return {
    header: named(tables[0]?.table.header ?? []),
    ...(tables[0]?.table.fileColumns ? { fileColumns: tables[0].table.fileColumns.map((column) => column + 1) } : {}),
    rows: tables.flatMap(({ channel, table }) => table.rows.map((row) => [channel, ...row])),
    ...(tested.length
      ? { comparisons: { header: named(tested[0].table.comparisons!.header), rows: tested.flatMap(({ channel, table }) => table.comparisons!.rows.map((row) => [channel, ...row])) } }
      : {}),
  };
}

/**
 * The tests block: a row per panel's overall test (its groups left empty) and per pair of groups,
 * with the test, its statistic, each group's n (for a paired test, the units in both groups), p,
 * and for a pair its Holm-adjusted p.
 */
export function comparisonsDataTable(
  panels: readonly { population: string; facet: string | null; tests: PanelTests | undefined }[],
  hasFacet: boolean,
  facetTitle?: string,
): PlottingDataTable {
  const header = ["Population", ...(hasFacet ? [facetTitle ?? "Facet"] : []), "Group 1", "Group 2", "Test", "Statistic", "n 1", "n 2", "p", "Adjusted p"];
  const lead = (panel: (typeof panels)[number]) => [panel.population, ...(hasFacet ? [panel.facet ?? ""] : [])];
  const overall = (test: PanelOverallTest) => [test.name, number(test.statistic), test.pairs ?? "", test.pairs ?? "", number(test.p), ""];
  const pair = (entry: PanelComparison) => [entry.groupA, entry.groupB, entry.test, entry.statistic === null ? "" : number(entry.statistic), entry.nA, entry.nB, entry.p === null ? "" : number(entry.p), entry.pAdjusted === null ? "" : number(entry.pAdjusted)];
  const rows = panels.flatMap((panel) => [
    ...(panel.tests?.overall ? [[...lead(panel), "", "", ...overall(panel.tests.overall)]] : []),
    ...(panel.tests?.pairs ?? []).map((entry) => [...lead(panel), ...pair(entry)]),
  ]);
  return { header, rows };
}

const number = (value: number) => (Number.isFinite(value) ? significantNumber(value, 6) : "");

/** Each value's place in the chart's order of the values given, for sorting rows as the chart draws them. */
function rankIn(values: Iterable<string>, levels?: readonly string[]): (value: string) => number {
  const rank = new Map(columnValueOrder(values, levels).map((value, i) => [value, i]));
  return (value) => rank.get(value) ?? rank.size;
}

/**
 * A proportion chart's counts: one row per file and category, with the file's total over the
 * chart's categories (the composition's denominator). "Count" and "Percent (stacked bar)" give
 * each event to the deepest selected population holding it, as a stacked bar draws it; "Whole
 * count" and "Whole percent (boxplot)" take each population with every event it holds, over the
 * same total, as the boxplot draws it. The two differ where a selected population holds events a
 * deeper selected one claims. A chart of each population's share of the total adds the file's
 * root population ("Total events") and the whole count over it.
 */
export function proportionsDataTable(
  model: ProportionsModel,
  titles: PlottingFactorTitles,
  fileName: (id: string) => string,
  unitIsFile: boolean,
  /** The chart's order of its groups and facets: rows follow it, a group's files in the file list's order. */
  order: PlottingLevels = {},
  value: ProportionsSettings["proportionValue"] = "parent",
  /** A boxplot's, bars' or points' tests, with pairwise comparisons or a paired test: a second block. */
  tests?: ComparisonOptions,
): PlottingDataTable {
  const ofTotal = value === "total";
  const header = [
    "File",
    titles.unit && !unitIsFile ? titles.unit : "Unit",
    titles.group ?? "Group",
    ...(model.hasFacet ? [titles.facet ?? "Facet"] : []),
    "Population",
    "Count",
    "Total",
    "Percent (stacked bar)",
    "Whole count",
    "Whole percent (boxplot)",
    ...(ofTotal ? ["Total events", "Whole percent of total"] : []),
  ];
  const facetRank = rankIn(model.perSample.map((row) => row.facet ?? ""), order.facets);
  const groupRank = rankIn(model.perSample.map((row) => row.group), order.groups);
  const perSample = [...model.perSample].sort((a, b) => facetRank(a.facet ?? "") - facetRank(b.facet ?? "") || groupRank(a.group) - groupRank(b.group));
  const rows = perSample.flatMap((row) => {
    const total = row.catCounts.reduce((a, b) => a + b, 0);
    const file = unitIsFile ? fileName(row.unit) : "";
    return model.catLevels.map((population, cat) => {
      // A population the file does not draw has no whole count there, and no share of it.
      const drawn = !row.missing?.includes(cat);
      return [
      file,
      unitIsFile ? fileName(row.unit) : row.unit,
      row.group,
      ...(model.hasFacet ? [row.facet ?? ""] : []),
      population,
      row.catCounts[cat] ?? 0,
      total,
      total > 0 ? number(((row.catCounts[cat] ?? 0) / total) * 100) : "",
      drawn ? row.popCounts?.[cat] ?? "" : "",
      // As perUnitProps takes a share: the whole count, or the count where categories are a partition.
      drawn && total > 0 ? number(((row.popCounts?.[cat] ?? row.catCounts[cat] ?? 0) / total) * 100) : "",
      ...(ofTotal
        ? [row.totalCount ?? "", drawn && row.totalCount ? number(((row.popCounts?.[cat] ?? row.catCounts[cat] ?? 0) / row.totalCount) * 100) : ""]
        : []),
      ];
    });
  });
  // A unit that is not a file pools files; the proportion rows are per file, so the File column
  // is filled only where each file is its own unit.
  const table: PlottingDataTable = {
    header: unitIsFile ? header.filter((_, i) => i !== 1) : header.filter((_, i) => i !== 0),
    rows: rows.map((r) => (unitIsFile ? r.filter((_, i) => i !== 1) : r.filter((_, i) => i !== 0))),
    fileColumns: unitIsFile ? [0] : [],
  };
  if (!tests || (tests.comparisons !== "pairwise" && !tests.paired)) return table;
  const facets = model.hasFacet ? columnValueOrder(model.perSample.map((row) => row.facet ?? ""), order.facets) : [null];
  const groups = columnValueOrder(model.perSample.map((row) => row.group), order.groups);
  const byKey = proportionPanelTests(model, facets, groups, value, tests);
  const panels = facets.flatMap((facet, fi) => model.catLevels.map((population, ci) => ({ population, facet, tests: byKey.get(`p${fi}-${ci}`) })));
  return { ...table, comparisons: comparisonsDataTable(panels, model.hasFacet, titles.facet) };
}

/** A proportion chart's counts as CSV text: {@link proportionsDataTable}. */
export function proportionsDataCsv(...args: Parameters<typeof proportionsDataTable>): string {
  return plottingDataTableCsv(proportionsDataTable(...args));
}

/** The positions of a box's whisker ends in ascending values: the first at or above `lo`, the last at or below `hi`. */
function whiskerIndices(sorted: ArrayLike<number>, lo: number, hi: number): [number, number] {
  let a = 0;
  while (a < sorted.length - 1 && sorted[a] < lo) a++;
  let b = sorted.length - 1;
  while (b > 0 && sorted[b] > hi) b--;
  return [a, b];
}

/**
 * A per-cell chart's violins or boxes: one row per population, group and facet, with its files,
 * its cells, their median and quartiles (type 7) computed on the linear values, and the Tukey
 * whiskers as drawn. The chart finds the whiskers on the display values; a whisker end is a cell,
 * and the transform keeps the cells' order, so the whisker is given as the linear value of the
 * cell at the same rank. Where the drawn violin holds another number of cells than the linear one
 * (a cell with no display value), the whiskers are left empty.
 * With replicate marks, each violin's row is followed by a row per replicate unit, with the unit's
 * files and cells and its median or mean (taken as the statistic chart takes it) in two columns
 * added at the end; the columns before them are as without the marks.
 */
export function cellsDataTable(
  rawModel: CellValuesModel,
  drawnModel: CellValuesModel,
  titles: PlottingFactorTitles,
  channel: string,
  /** The chart's order: rows by facet, then by panel and slot as the chart draws them. */
  order: PlottingLevels & { xAxis?: ProportionsSettings["xAxis"] } = {},
  /** The chart's replicate marks, when drawn. */
  replicates?: Pick<CellReplicates, "unitModel" | "statistic" | "unitSel" | "unitLevels"> & Partial<Pick<CellReplicates, "test" | "comparisons">>,
): PlottingDataTable {
  const header = [
    titles.group ?? "Group",
    ...(rawModel.hasFacet ? [titles.facet ?? "Facet"] : []),
    "Population",
    "Files",
    "Cells",
    `Median ${channel}`,
    `Q1 ${channel}`,
    `Q3 ${channel}`,
    `Lower whisker ${channel}`,
    `Upper whisker ${channel}`,
    ...(replicates ? [titles.unit ?? "Unit", `Unit ${replicates.statistic} ${channel}`] : []),
  ];
  const fileColumns = [2 + Number(rawModel.hasFacet)];
  const points = replicates
    ? statisticPoints(replicates.unitModel, replicates.statistic, replicates.unitSel === PROPORTIONS_SAMPLE_FACTOR || replicates.unitSel === PROPORTIONS_NO_FACTOR, replicates.unitLevels)
    : [];
  const key = (violin: CellValuesModel["violins"][number]) => [violin.cat, violin.group, violin.facet ?? "", violin.unit ?? ""].join("\0");
  const drawnByKey = new Map(drawnModel.violins.map((violin) => [key(violin), violin]));
  const facetRank = rankIn(rawModel.violins.map((violin) => violin.facet ?? ""), order.facets);
  const groupRank = rankIn(rawModel.violins.map((violin) => violin.group), order.groups);
  const violins = [...rawModel.violins].sort((a, b) =>
    facetRank(a.facet ?? "") - facetRank(b.facet ?? "") ||
    (order.xAxis === "groups" ? a.cat - b.cat || groupRank(a.group) - groupRank(b.group) : groupRank(a.group) - groupRank(b.group) || a.cat - b.cat),
  );
  const rows = violins.flatMap((violin) => {
    const box = violin.values.length ? cellBoxStats(violin.values) : null;
    const drawn = drawnByKey.get(key(violin));
    let whiskers: [string, string] = ["", ""];
    if (box && drawn && drawn.values.length === violin.values.length) {
      const drawnBox = cellBoxStats(drawn.values);
      const [lo, hi] = whiskerIndices(drawn.values, drawnBox.lo, drawnBox.hi);
      whiskers = [number(violin.values[lo]), number(violin.values[hi])];
    }
    const row = [
      violin.group,
      ...(rawModel.hasFacet ? [violin.facet ?? ""] : []),
      rawModel.catLevels[violin.cat],
      violin.files.join("; "),
      violin.values.length,
      box ? number(box.median) : "",
      box ? number(box.q1) : "",
      box ? number(box.q3) : "",
      ...whiskers,
    ];
    if (!replicates) return [row];
    const units = points.filter((p) => p.cat === violin.cat && p.group === violin.group && (!rawModel.hasFacet || (p.facet ?? "") === (violin.facet ?? "")));
    return [
      [...row, "", ""],
      ...units.map((p) => [
        violin.group,
        ...(rawModel.hasFacet ? [violin.facet ?? ""] : []),
        rawModel.catLevels[violin.cat],
        p.files.join("; "),
        p.cells,
        "", "", "", "", "",
        p.unit,
        number(p.value),
      ]),
    ];
  });
  // Pairwise, the replicate marks' tests follow as a second block.
  if (!replicates?.test || replicates.comparisons?.comparisons !== "pairwise" || order.xAxis !== "groups") return { header, rows, fileColumns };
  const { panels, groups } = cellPanels(drawnModel, "groups", undefined, undefined, order);
  const frame = cellReplicateFrame(drawnModel, panels, groups, "groups", { ...replicates, test: true, comparisons: { ...replicates.comparisons, comparisonsShow: "all" } }, order.facets);
  return {
    header,
    rows,
    fileColumns,
    comparisons: comparisonsDataTable(panels.map((panel) => ({ population: panel.population ?? "", facet: panel.facet, tests: { overall: frame.tests.get(panel.key) ?? null, pairs: frame.comparisons.get(panel.key) ?? [] } })), drawnModel.hasFacet, titles.facet),
  };
}

/** A per-cell chart's violins or boxes as CSV text: {@link cellsDataTable}. */
export function cellsDataCsv(...args: Parameters<typeof cellsDataTable>): string {
  return plottingDataTableCsv(cellsDataTable(...args));
}

const STATISTIC_HEADERS: Record<ProportionsSettings["statistic"], string> = { median: "Median", mean: "Mean", geomean: "Geometric mean" };

/**
 * A statistic chart's points: one row per replicate unit, population, group and facet, with the
 * unit's files, the cells the statistic is taken of and the statistic; for the geometric mean,
 * which takes the positive cells only, also the cells left out as not positive; with the rank test
 * on, its name and p for the panel.
 */
export function statisticDataTable(
  unitModel: CellValuesModel,
  settings: Pick<ProportionsSettings, "statistic" | "errorBar" | "test" | "xAxis" | "unitSel" | "panelWidth" | "height" | "fontTick" | "fontAxis" | "plotType"> & Partial<Pick<ProportionsSettings, "comparisons" | "comparisonsShow">>,
  titles: PlottingFactorTitles,
  channel: string,
  /** The chart's order of its groups, facets and units, which the rows follow. */
  order: PlottingLevels = {},
): PlottingDataTable {
  const plotType = settings.plotType === "bar" ? "bar" : settings.plotType === "dots" ? "dots" : "box";
  const { panels } = statisticChartFrame(unitModel, { ...settings, plotType }, undefined, undefined, order);
  const withTest = settings.test && settings.xAxis === "groups";
  const geomean = settings.statistic === "geomean";
  const header = [
    titles.unit ?? "Unit",
    titles.group ?? "Group",
    ...(unitModel.hasFacet ? [titles.facet ?? "Facet"] : []),
    "Population",
    "Files",
    "Cells",
    ...(geomean ? ["Cells not positive"] : []),
    `${STATISTIC_HEADERS[settings.statistic]} ${channel}`,
    ...(withTest ? ["Test", "p"] : []),
  ];
  const fileColumns = [3 + Number(unitModel.hasFacet)];
  const rows = panels.flatMap((panel) =>
    panel.slots.flatMap((slot) =>
      slot.points.map((point) => [
        point.unit,
        point.group,
        ...(unitModel.hasFacet ? [point.facet ?? ""] : []),
        unitModel.catLevels[point.cat],
        point.files.join("; "),
        point.cells,
        ...(geomean ? [point.notPositive ?? 0] : []),
        number(point.value),
        ...(withTest ? [panel.test?.name ?? "", panel.test ? number(panel.test.p) : ""] : []),
      ]),
    ),
  );
  if (!withTest || settings.comparisons !== "pairwise") return { header, rows, fileColumns };
  return {
    header,
    rows,
    fileColumns,
    comparisons: comparisonsDataTable(panels.map((panel) => ({ population: panel.population ?? "", facet: panel.facet, tests: { overall: panel.test, pairs: panel.comparisons } })), unitModel.hasFacet, titles.facet),
  };
}

/** A statistic chart's points as CSV text: {@link statisticDataTable}. */
export function statisticDataCsv(...args: Parameters<typeof statisticDataTable>): string {
  return plottingDataTableCsv(statisticDataTable(...args));
}
