// One chart, built both ways: an Illustration chart panel as the figure builds it
// (buildFigureChartPanel) and the same panel as the Plotting builders build it from the settings
// figureChartRecipe gives for it (plottingBlockModels, as a Layout block does). Each case says
// where the two draw the same numbers and where they differ. Synthetic files D1, D2 and D3,
// conditions control and treated; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { cloneHierarchyTree, DEFAULT_HIERARCHY_ID, storeHierarchy, type StoredHierarchy } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import {
  figureHierarchies,
  layoutFigure,
  migrateFigure,
  prepareFigureSource,
  type FigureChart,
  type FigurePanel,
  type FigurePopulation,
  type FigureSample,
  type FigureSpec,
} from "../engine/figure";
import { defaultIllustrationConfig } from "../engine/figureDefaults";
import type { CellValuesModel } from "../engine/cellValuesModel";
import type { FilePopulations, ProportionsModel, ProportionsSettings } from "../engine/proportionsModel";
import { buildFigureChartPanel, summaryPlaces, type FigureChartData } from "./figureChartData";
import { figureChartRecipe } from "./figureLayoutRecipes";
import { plottingBlockModels } from "./LayoutProportions";
import { statisticChartFrame, statisticPoints } from "./StatisticChart";
import { cellPanels } from "./CellValuesChart";
import { chartXAxis } from "./chart/chartXAxis";

// Each event is [FITC-A (CD4), PE-A (CD8), FSC-A]. The quadrant's centre is FITC 1000, PE 1000,
// so 100 is low and 5000 high. FSC is the value a violin, a box or a statistic is taken of.
type Event = [number, number, number];
const LOW = 100;
const HIGH = 5000;

function file(id: string, events: Event[], hierarchyId: string, condition: string): FigureSample {
  const channels = [
    { index: 0, name: "FITC-A", marker: "CD4", bits: 32, range: 262144 },
    { index: 1, name: "PE-A", marker: "CD8", bits: 32, range: 262144 },
    { index: 2, name: "FSC-A", marker: null, bits: 32, range: 262144 },
  ];
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: events.length,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels,
    columns: channels.map((_, c) => Float32Array.from(events.map((event) => event[c]))),
  };
  return { id, name: `${id}.fcs`, sample: new Sample(fcs), hierarchyId, metadata: { condition } };
}

// The quadrant's counts, [CD8_positive, double_positive, CD4_positive, double_negative]:
// D1 (control, tree Main):    CD8_positive FSC 10, 20, 30; double_positive 40; CD4_positive 50, 60, 70, 80 -> [3, 1, 4, 0]
// D2 (treated, tree Main):    CD8_positive 15; CD4_positive 55, 65; double_negative 90, 100           -> [1, 0, 2, 2]
// D3 (treated, tree D3_tree): CD8_positive 25, 35; CD4_positive 75                                    -> [2, 0, 1, 0]
// FSC_high (FSC from 62) and FSC_low (the rest) split CD4_positive in Main only: D1 2 and 2
// (70, 80 | 50, 60), D2 1 and 1 (65 | 55). D3's tree is a copy of Main made before the split,
// not kept in step with it, so it has no FSC_high or FSC_low.
const EVENTS: Record<string, Event[]> = {
  D1: [
    [LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30],
    [HIGH, HIGH, 40],
    [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80],
  ],
  D2: [[LOW, HIGH, 15], [HIGH, LOW, 55], [HIGH, LOW, 65], [LOW, LOW, 90], [LOW, LOW, 100]],
  D3: [[LOW, HIGH, 25], [LOW, HIGH, 35], [HIGH, LOW, 75]],
};
const METADATA: Record<string, Record<string, string>> = { D1: { condition: "control" }, D2: { condition: "treated" }, D3: { condition: "treated" } };
const D3_TREE = "D3_tree";
const POPULATIONS = ["CD8_positive", "double_positive", "CD4_positive", "double_negative", "FSC_high", "FSC_low"] as const;
type PopulationName = (typeof POPULATIONS)[number] | "All Events";

/** The workspace: a quadrant drawn in Main, a copy of Main for D3, then FSC_high and FSC_low in Main. */
function workspace() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 8 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "CD4", yChannel: "CD8",
    center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["CD8_positive", "double_positive", "CD4_positive", "double_negative"],
  });
  const template = storeHierarchy(state.hierarchies[0], state);
  const clone = cloneHierarchyTree(template.populations, template.root_population_id!, template.gates, template.gate_order);
  const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
  const copy: StoredHierarchy = {
    id: D3_TREE, name: "D3.fcs · Main", owner_sample_id: "D3", structure_locked: false, source_hierarchy_id: DEFAULT_HIERARCHY_ID,
    source_gate_ids: invert(clone.gateIdMap), source_population_ids: invert(clone.idMap),
    gates: clone.gates, gate_order: clone.gate_order, populations: clone.populations, root_population_id: clone.root_population_id,
    active_population_id: clone.root_population_id, selected_pop_ids: [],
  };
  state = coreReducer(state, { type: "addHierarchyCopies", copies: [copy], activeHierarchyId: DEFAULT_HIERARCHY_ID });
  const cd4 = Object.values(state.populations).find((p) => p.name === "CD4_positive")!.population_id;
  state = coreReducer(state, {
    type: "addGate", gateType: "rectangle", xChannel: "FSC-A", yChannel: "CD8", space: "raw",
    vertices: [[62, 0], [1000, 262144]], name: "FSC_high",
    createPop: { name: "FSC_high", notName: "FSC_low", parentId: cd4 },
  });
  const core = state as CoreState;
  const trees = figureHierarchies(core);
  const samples = [
    file("D1", EVENTS.D1, DEFAULT_HIERARCHY_ID, "control"),
    file("D2", EVENTS.D2, DEFAULT_HIERARCHY_ID, "treated"),
    file("D3", EVENTS.D3, D3_TREE, "treated"),
  ];
  const sources = samples.map((entry) => prepareFigureSource(entry, trees[entry.hierarchyId], core));
  const idOf = (name: PopulationName, tree: StoredHierarchy = trees[DEFAULT_HIERARCHY_ID]) =>
    name === "All Events" ? tree.root_population_id! : Object.values(tree.populations).find((p) => p.name === name)!.population_id;
  const ref = (name: PopulationName): FigurePopulation => ({ hierarchyId: DEFAULT_HIERARCHY_ID, populationId: idOf(name), label: name });
  /** The gate list's count of a population in a file, in the file's own tree. */
  const counted = (fileId: string, name: PopulationName) => {
    const entry = samples.find((s) => s.id === fileId)!;
    const tree = trees[entry.hierarchyId];
    const id = name === "All Events" ? tree.root_population_id! : Object.values(tree.populations).find((p) => p.name === name)?.population_id;
    return id ? recompute(entry.sample, { ...core, ...tree }).populations[id].event_count : undefined;
  };
  return { core, trees, samples, sources, idOf, ref, counted };
}
type Workspace = ReturnType<typeof workspace>;

interface FigureOptions {
  files: string[];
  chart: FigureChart;
  /** The figure's populations; a plot's own `populations` with `plotPopulations`. */
  populations: FigurePopulation[];
  plotPopulations?: FigurePopulation[];
  rows?: FigureSpec["rows"];
  columns?: FigureSpec["columns"];
  composition?: FigureSpec["composition"];
  populationOverrides?: FigureSpec["populationOverrides"];
  samplePopulations?: FigureSpec["samplePopulations"];
}

function figureOf(ws: Workspace, options: FigureOptions): FigureSpec {
  return {
    ...migrateFigure(null, ws.samples, ws.trees, DEFAULT_HIERARCHY_ID, "FSC-A", "FSC-A"),
    sampleIds: options.files,
    populations: options.populations,
    plots: [{ id: "chart", name: "Chart", x: "FSC-A", y: "FSC-A", type: "chart", chart: options.chart, ...(options.plotPopulations ? { populations: options.plotPopulations } : {}) }],
    rows: options.rows ?? ["plots"],
    columns: options.columns ?? ["samples"],
    pages: [],
    composition: options.composition ?? "separate",
    ...(options.populationOverrides ? { populationOverrides: options.populationOverrides } : {}),
    ...(options.samplePopulations ? { samplePopulations: options.samplePopulations } : {}),
  };
}

/** A violin or box: its population, its group (a summary's place, or Plotting's group), its files and cells. */
interface Mark { population: string; group: string; files: string[]; n: number; values: number[] }
/** A statistic point: one file's statistic of one population. */
interface Point { population: string; group: string; file: string; cells: number; value: number }
/** A composition bar: one file's count and percentage of each category, the rest of the parent last. */
interface Bar { file: string; group: string; categories: string[]; counts: number[]; percents: number[] }
interface Drawn { marks: Mark[]; points: Point[]; bars: Bar[]; excluded: string[]; note?: string }

const byKey = <T>(key: (item: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
const markKey = (m: Mark) => JSON.stringify([m.population, m.group, m.files]);
const pointKey = (p: Point) => JSON.stringify([p.population, p.group, p.file]);
const percents = (counts: readonly number[]) => {
  const sum = counts.reduce((a, b) => a + b, 0);
  return counts.map((c) => (sum ? Math.round((1e4 * c) / sum) / 100 : 0));
};

function marksOf(model: CellValuesModel, population: (cat: number) => string, group: (cat: number, own: string) => string): Mark[] {
  return model.violins
    .map((v) => ({ population: population(v.cat), group: group(v.cat, v.group), files: [...v.files], n: v.values.length, values: [...v.values] }))
    .sort(byKey(markKey));
}
function pointsOf(model: CellValuesModel, statistic: NonNullable<FigureChart["statistic"]>, population: (cat: number) => string, group: (cat: number, own: string) => string): Point[] {
  return statisticPoints(model, statistic)
    .map((p) => ({ population: population(p.cat), group: group(p.cat, p.group), file: p.files.join(","), cells: p.cells, value: p.value }))
    .sort(byKey(pointKey));
}
function barsOf(model: ProportionsModel, nameOf: (unit: string) => string): Bar[] {
  return model.perSample
    .map((row) => ({ file: nameOf(row.unit), group: row.group, categories: [...model.catLevels], counts: [...row.catCounts], percents: percents(row.catCounts) }))
    .sort(byKey((b) => b.file));
}

/** What the figure's panel draws. */
function figureDrawn(ws: Workspace, panel: FigurePanel, figure: FigureSpec): Drawn {
  const data = buildFigureChartPanel(panel, figure, ws.sources, ws.trees, { state: ws.core });
  const chart = data.config?.chart as FigureChartData | undefined;
  const drawn: Drawn = { marks: [], points: [], bars: [], excluded: [], ...(data.note ? { note: data.note } : {}) };
  if (!chart) return drawn;
  const nameOf = (unit: string) => ws.samples.find((s) => s.id === unit)?.name ?? unit;
  if (chart.proportions) return { ...drawn, bars: barsOf(chart.proportions, nameOf) };
  const cells = chart.cells!;
  // A summary's marks are grouped by place, each group named by its place's label (summaryPlaces).
  const population = (cat: number) => cells.catLevels[cat];
  const group = (_: number, own: string) => own;
  if (chart.valueKind === "statistic") return { ...drawn, points: pointsOf(cells, figure.plots[0].chart!.statistic ?? "median", population, group) };
  return { ...drawn, marks: marksOf(cells, population, group) };
}

let revision = 0;
/**
 * What a Layout block made from the panel's figureChartRecipe draws, from Plotting's builders;
 * with `filePopulations`, what they draw given each file's populations as the figure resolves them.
 */
function plottingDrawn(ws: Workspace, panel: FigurePanel, figure: FigureSpec, filePopulations?: FilePopulations): Drawn {
  const config = { ...defaultIllustrationConfig(), figure };
  const recipe = figureChartRecipe(panel, figure, config, () => true, ws.trees)!;
  const settings = recipe.settings;
  const models = plottingBlockModels(settings, ws.samples, ws.core, METADATA, {}, `agreement-${++revision}`, filePopulations);
  const nameOf = (unit: string) => ws.samples.find((s) => s.id === unit)?.name ?? unit;
  if (settings.valueKind === "proportion") return { marks: [], points: [], bars: barsOf(models.model, nameOf), excluded: models.model.excluded ?? [] };
  const cells = models.cellModel!;
  const population = (cat: number) => cells.catLevels[cat];
  const group = (_: number, own: string) => own;
  if (settings.valueKind === "statistic") return { marks: [], points: pointsOf(cells, settings.statistic, population, group), bars: [], excluded: cells.excluded };
  return { marks: marksOf(cells, population, group), points: [], bars: [], excluded: cells.excluded };
}

/** A summary's slot along x: its population, its place (group), and its cells, or its points as [files, cells, value]. */
interface Slot { population: string; group: string; values?: number[]; points?: [string, number, number][] }

/** The one panel the shared chart lays out from these settings and cells (cellPanels / statisticChartFrame), as slots. */
function sharedSlots(settings: ProportionsSettings, cells: CellValuesModel, groupLevels?: readonly string[]): Slot[] {
  if (settings.valueKind === "statistic") {
    const { panels } = statisticChartFrame(cells, { ...settings, plotType: settings.plotType === "dots" ? "dots" : settings.plotType === "bar" ? "bar" : "box" }, undefined, undefined, { groups: groupLevels });
    expect(panels).toHaveLength(1);
    return panels[0].slots.map((slot) => ({ population: cells.catLevels[slot.cat!], group: slot.label, points: slot.points.map((p): [string, number, number] => [p.files.join(","), p.cells, p.value]) }));
  }
  const { panels } = cellPanels(cells, chartXAxis(settings), undefined, undefined, { groups: groupLevels });
  expect(panels).toHaveLength(1);
  return panels[0].slots.map((slot) => ({ population: cells.catLevels[slot.cat!], group: slot.label, values: [...(slot.violin?.values ?? [])] }));
}

/** The figure's summary slots, as the shared chart lays out the panel's cells from the settings it is drawn with. */
function figureSlots(ws: Workspace, panel: FigurePanel, figure: FigureSpec): Slot[] {
  const chart = buildFigureChartPanel(panel, figure, ws.sources, ws.trees, { state: ws.core }).config!.chart as FigureChartData;
  expect(chart.groupLevels).toEqual(summaryPlaces(panel)!.map((place) => place.label));
  return sharedSlots(chart.settings, chart.cells!, chart.groupLevels);
}

/** The one panel the shared chart lays out from the recipe's settings, as slots. */
function plottingSlots(ws: Workspace, panel: FigurePanel, figure: FigureSpec): Slot[] {
  const recipe = figureChartRecipe(panel, figure, { ...defaultIllustrationConfig(), figure }, () => true, ws.trees)!;
  const settings = recipe.settings;
  return sharedSlots(settings, plottingBlockModels(settings, ws.samples, ws.core, METADATA, {}, `agreement-${++revision}`).cellModel!);
}

/** Every drawn panel of the figure, built both ways. */
function bothWays(ws: Workspace, options: FigureOptions) {
  const figure = figureOf(ws, options);
  const panels = layoutFigure(figure, ws.samples, ws.trees).flatMap((page) => page.panels).filter((panel) => panel.samples.length);
  return panels.map((panel) => ({ panel, spec: figure, figure: figureDrawn(ws, panel, figure), plotting: plottingDrawn(ws, panel, figure) }));
}

const CELLS: FigureChart = { valueKind: "cells", plotType: "violin" };
const STATISTIC: FigureChart = { valueKind: "statistic", plotType: "box", statistic: "median" };
const PROPORTION: FigureChart = { valueKind: "proportion", plotType: "stacked" };


const ALL = ["D1", "D2", "D3"];
const drawn = (part: Partial<Drawn>): Drawn => ({ marks: [], points: [], bars: [], excluded: [], ...part });
const mark = (population: string, files: string[], values: number[], group = ""): Mark => ({ population, group, files, n: values.length, values });
const point = (population: string, file: string, cells: number, value: number, group = ""): Point => ({ population, group, file, cells, value });
const bar = (file: string, categories: string[], counts: number[], group = file): Bar => ({ file, group, categories, counts, percents: percents(counts) });
/** The same drawing without the names of its groups, for comparing numbers where only the names differ. */
const ungrouped = (d: Drawn): Drawn => ({
  ...d,
  marks: d.marks.map((m) => ({ ...m, group: "" })),
  points: d.points.map((p) => ({ ...p, group: "" })),
  bars: d.bars.map((b) => ({ ...b, group: "" })),
});
/** The figure's one drawn panel, built both ways. */
function onePanel(ws: Workspace, options: FigureOptions) {
  const built = bothWays(ws, options);
  expect(built).toHaveLength(1);
  return built[0];
}

/** The numbers drawn, without the figure's note or Plotting's excluded list. */
const numbers = (d: Drawn) => ({ marks: d.marks, points: d.points, bars: d.bars });
/** Each built panel drawn by Plotting's builders given each file's populations as the figure resolves them. */
const withMap = (ws: Workspace, built: { panel: FigurePanel; spec: FigureSpec }, filePopulations: FilePopulations) =>
  plottingDrawn(ws, built.panel, built.spec, filePopulations);

describe("An Illustration chart panel and the same chart from Plotting's builders", () => {
  it("counts what the fixture's comment says, each file in its own tree", () => {
    const ws = workspace();
    expect(ALL.map((id) => POPULATIONS.map((name) => ws.counted(id, name)))).toEqual([
      [3, 1, 4, 0, 2, 2],
      [1, 0, 2, 2, 1, 1],
      [2, 0, 1, 0, undefined, undefined],
    ]);
    expect(ALL.map((id) => ws.counted(id, "All Events"))).toEqual([8, 5, 3]);
  });

  it("1. one file, one population: the same numbers; a composition's bar is named only by Plotting", () => {
    const ws = workspace();
    const options = (chart: FigureChart): FigureOptions => ({ files: ["D1"], chart, populations: [ws.ref("CD4_positive")] });
    // D1's CD4_positive: 4 events, FSC 50, 60, 70 and 80, median 65.
    const cells = onePanel(ws, options(CELLS));
    expect(cells.figure).toEqual(drawn({ marks: [mark("CD4_positive", ["D1.fcs"], [50, 60, 70, 80])] }));
    expect(cells.figure.marks[0].n).toBe(ws.counted("D1", "CD4_positive"));
    expect(cells.plotting).toEqual(cells.figure);
    const statistic = onePanel(ws, options(STATISTIC));
    expect(statistic.figure).toEqual(drawn({ points: [point("CD4_positive", "D1.fcs", 4, 65)] }));
    expect(statistic.plotting).toEqual(statistic.figure);
    // CD4_positive is 4 of D1's 8 events; the other 4 are ungated.
    const proportion = onePanel(ws, options(PROPORTION));
    expect(ungrouped(proportion.figure)).toEqual(drawn({ bars: [bar("D1.fcs", ["CD4_positive", "ungated"], [4, 4], "")] }));
    expect(proportion.figure.bars[0].percents).toEqual([50, 50]);
    expect(ungrouped(proportion.plotting)).toEqual(ungrouped(proportion.figure));
    // Differs, a name only: the figure names a one-file panel's bar nothing (figureChartData.ts, perSample's group); Plotting names it by its file (groupSel "__sample__").
    expect(proportion.figure.bars.map((b) => b.group)).toEqual([""]);
    expect(proportion.plotting.bars.map((b) => b.group)).toEqual(["D1.fcs"]);
  });

  for (const shelf of ["pooled", "on no shelf"] as const)
    it(`2. several files in one panel, ${shelf}: the same numbers`, () => {
      const ws = workspace();
      const options = (chart: FigureChart): FigureOptions => ({
        files: ALL, chart, populations: [ws.ref("CD4_positive")],
        ...(shelf === "pooled" ? { composition: "pool" as const } : { columns: [] }),
      });
      // CD4_positive: D1 4 (FSC 50-80), D2 2 (55, 65), D3 1 (75) in its own tree; 7 cells pooled.
      const cells = onePanel(ws, options(CELLS));
      expect(cells.panel.samples).toEqual(ALL);
      expect(cells.figure).toEqual(drawn({ marks: [mark("CD4_positive", ["D1.fcs", "D2.fcs", "D3.fcs"], [50, 55, 60, 65, 70, 75, 80])] }));
      expect(cells.figure.marks[0].n).toBe(ALL.reduce((n, id) => n + ws.counted(id, "CD4_positive")!, 0));
      expect(cells.plotting).toEqual(cells.figure);
      const statistic = onePanel(ws, options(STATISTIC));
      expect(statistic.figure).toEqual(drawn({
        points: [point("CD4_positive", "D1.fcs", 4, 65), point("CD4_positive", "D2.fcs", 2, 60), point("CD4_positive", "D3.fcs", 1, 75)],
      }));
      expect(statistic.plotting).toEqual(statistic.figure);
      // A bar per file: CD4_positive and the rest of each file's events (8, 5 and 3).
      const proportion = onePanel(ws, options(PROPORTION));
      expect(proportion.figure).toEqual(drawn({
        bars: [
          bar("D1.fcs", ["CD4_positive", "ungated"], [4, 4]),
          bar("D2.fcs", ["CD4_positive", "ungated"], [2, 3]),
          bar("D3.fcs", ["CD4_positive", "ungated"], [1, 2]),
        ],
      }));
      expect(proportion.plotting).toEqual(proportion.figure);
    });

  it("3. several populations in one panel: the same numbers, an empty population drawn empty by both", () => {
    const ws = workspace();
    const options = (chart: FigureChart): FigureOptions => ({
      files: ["D1"], chart, populations: [ws.ref("CD4_positive")],
      plotPopulations: [ws.ref("CD8_positive"), ws.ref("CD4_positive"), ws.ref("double_negative")],
    });
    // D1: CD8_positive 3 (FSC 10, 20, 30), CD4_positive 4 (50-80), double_negative 0.
    const cells = onePanel(ws, options(CELLS));
    expect(cells.figure).toEqual(drawn({
      marks: [
        mark("CD4_positive", ["D1.fcs"], [50, 60, 70, 80]),
        mark("CD8_positive", ["D1.fcs"], [10, 20, 30]),
        mark("double_negative", ["D1.fcs"], []),
      ],
    }));
    expect(cells.plotting).toEqual(cells.figure);
    // A population without cells has no point on either side.
    const statistic = onePanel(ws, options(STATISTIC));
    expect(statistic.figure).toEqual(drawn({ points: [point("CD4_positive", "D1.fcs", 4, 65), point("CD8_positive", "D1.fcs", 3, 20)] }));
    expect(statistic.plotting).toEqual(statistic.figure);
    // D1's 8 events: 3 + 4 + 0, and double_positive's 1 ungated.
    const proportion = onePanel(ws, options(PROPORTION));
    expect(ungrouped(proportion.figure)).toEqual(drawn({ bars: [bar("D1.fcs", ["CD8_positive", "CD4_positive", "double_negative", "ungated"], [3, 4, 0, 1], "")] }));
    expect(ungrouped(proportion.plotting)).toEqual(ungrouped(proportion.figure));
    // Differs, a name only, as in case 1: the figure's one-file bar is unnamed, Plotting's named by its file.
    expect([proportion.figure.bars[0].group, proportion.plotting.bars[0].group]).toEqual(["", "D1.fcs"]);
  });

  it("4. the tree's root: the same cells and statistic; a composition of the root alone draws its children on both sides", () => {
    const ws = workspace();
    const options = (chart: FigureChart): FigureOptions => ({ files: ALL, chart, populations: [ws.ref("All Events")], columns: [] });
    // Every event of D1 (8), D2 (5) and D3 (3): 16 cells.
    const cells = onePanel(ws, options(CELLS));
    expect(cells.figure).toEqual(drawn({
      marks: [mark("All Events", ["D1.fcs", "D2.fcs", "D3.fcs"], [10, 15, 20, 25, 30, 35, 40, 50, 55, 60, 65, 70, 75, 80, 90, 100])],
    }));
    expect(cells.plotting).toEqual(cells.figure);
    const statistic = onePanel(ws, options(STATISTIC));
    expect(statistic.figure).toEqual(drawn({
      points: [point("All Events", "D1.fcs", 8, 45), point("All Events", "D2.fcs", 5, 65), point("All Events", "D3.fcs", 3, 35)],
    }));
    expect(statistic.plotting).toEqual(statistic.figure);
    const proportion = onePanel(ws, options(PROPORTION));
    // The same numbers (David's rule 1, 2026-11-11): a composition whose only population is the
    // root draws the root's children, the quadrant's counts (proportionsModel.ts,
    // proportionsSelection: the root does not lie beneath the parent, the root, so the selection
    // reads as the parent's children). The figure drew the root whole before.
    const quadrants = ["CD8_positive", "double_positive", "CD4_positive", "double_negative", "ungated"];
    expect(proportion.figure).toEqual(drawn({
      bars: [bar("D1.fcs", quadrants, [3, 1, 4, 0, 0]), bar("D2.fcs", quadrants, [1, 0, 2, 2, 0]), bar("D3.fcs", quadrants, [2, 0, 1, 0, 0])],
    }));
    expect(proportion.plotting).toEqual(proportion.figure);
  });

  it("5. a population with no events in a file, and one missing from a file's tree: both keep the file for the populations it has", () => {
    const ws = workspace();
    const options = (chart: FigureChart): FigureOptions => ({
      files: ALL, chart, populations: [ws.ref("CD4_positive")], columns: [],
      plotPopulations: [ws.ref("double_positive"), ws.ref("FSC_high")],
    });
    // double_positive: D1 1 (FSC 40), D2 0, D3 0. FSC_high: D1 2 (70, 80), D2 1 (65); not in D3's tree.
    const cells = onePanel(ws, options(CELLS));
    expect(cells.panel.samples).toEqual(ALL);
    // The same numbers (David's rule 2, 2026-11-11): D3 is kept for the population its tree holds
    // and adds nothing to the one it lacks. The figure names that one in the panel's note;
    // Plotting lists it in the model's `partial` (not compared here).
    const marks = [mark("FSC_high", ["D1.fcs", "D2.fcs"], [65, 70, 80]), mark("double_positive", ["D1.fcs", "D2.fcs", "D3.fcs"], [40])];
    expect(cells.figure).toEqual(drawn({ marks, note: "Not drawn in every file: FSC_high" }));
    expect(cells.plotting).toEqual(drawn({ marks }));
    const statistic = onePanel(ws, options(STATISTIC));
    const points = [point("FSC_high", "D1.fcs", 2, 75), point("FSC_high", "D2.fcs", 1, 65), point("double_positive", "D1.fcs", 1, 40)];
    expect(statistic.figure).toEqual(drawn({ points, note: "Not drawn in every file: FSC_high" }));
    expect(statistic.plotting).toEqual(drawn({ points }));
    const proportion = onePanel(ws, options(PROPORTION));
    const categories = ["double_positive", "FSC_high", "ungated"];
    // The same numbers: D3's bar has FSC_high at 0 and all 3 of its events in the rest, its
    // CD4_positive event among them, as it is in no drawn population of D3's tree; the bar still sums to D3's events.
    const bars = [bar("D1.fcs", categories, [1, 2, 5]), bar("D2.fcs", categories, [0, 1, 4]), bar("D3.fcs", categories, [0, 0, 3])];
    expect(proportion.figure).toEqual(drawn({ bars, note: "Not drawn in every file: FSC_high" }));
    expect(proportion.plotting).toEqual(drawn({ bars }));
  });

  it("6. files on two trees, the population in both: the same numbers", () => {
    const ws = workspace();
    const options = (chart: FigureChart): FigureOptions => ({ files: ["D1", "D3"], chart, populations: [ws.ref("CD8_positive")], columns: [] });
    expect(ws.samples.map((s) => s.hierarchyId)).toEqual([DEFAULT_HIERARCHY_ID, DEFAULT_HIERARCHY_ID, D3_TREE]);
    // CD8_positive: D1 3 (FSC 10, 20, 30) in Main, D3 2 (25, 35) in D3's tree.
    const cells = onePanel(ws, options(CELLS));
    expect(cells.figure).toEqual(drawn({ marks: [mark("CD8_positive", ["D1.fcs", "D3.fcs"], [10, 20, 25, 30, 35])] }));
    expect(cells.plotting).toEqual(cells.figure);
    const statistic = onePanel(ws, options(STATISTIC));
    expect(statistic.figure).toEqual(drawn({ points: [point("CD8_positive", "D1.fcs", 3, 20), point("CD8_positive", "D3.fcs", 2, 30)] }));
    expect(statistic.plotting).toEqual(statistic.figure);
    const proportion = onePanel(ws, options(PROPORTION));
    expect(proportion.figure).toEqual(drawn({
      bars: [bar("D1.fcs", ["CD8_positive", "ungated"], [3, 5]), bar("D3.fcs", ["CD8_positive", "ungated"], [2, 1])],
    }));
    expect(proportion.plotting).toEqual(proportion.figure);
  });

  it("7. a per-file population override: the figure follows it, as Plotting's builders do given the figure's map; a Layout block's recipe does not", () => {
    const ws = workspace();
    // In D2, the figure's CD4_positive is overridden to D2's CD8_positive (1 event, FSC 15).
    const populationOverrides = { D2: { [JSON.stringify([DEFAULT_HIERARCHY_ID, ws.idOf("CD4_positive")])]: ws.idOf("CD8_positive") } };
    const options = (chart: FigureChart): FigureOptions => ({ files: ["D1", "D2"], chart, populations: [ws.ref("CD4_positive")], columns: [], populationOverrides });
    const cells = onePanel(ws, options(CELLS));
    // Differs: the figure draws D2's CD8_positive cell under CD4_positive (figureChartData.ts, populationOverrides).
    expect(cells.figure).toEqual(drawn({ marks: [mark("CD4_positive", ["D1.fcs", "D2.fcs"], [15, 50, 60, 70, 80])] }));
    // Differs: Plotting draws D2's own CD4_positive (55, 65); its settings carry no override (figureLayoutRecipes.ts, figureChartRecipe).
    expect(cells.plotting).toEqual(drawn({ marks: [mark("CD4_positive", ["D1.fcs", "D2.fcs"], [50, 55, 60, 65, 70, 80])] }));
    const statistic = onePanel(ws, options(STATISTIC));
    // Differs: D2's point is the median of its CD8_positive cell in the figure, of its CD4_positive cells in Plotting.
    expect(statistic.figure).toEqual(drawn({ points: [point("CD4_positive", "D1.fcs", 4, 65), point("CD4_positive", "D2.fcs", 1, 15)] }));
    expect(statistic.plotting).toEqual(drawn({ points: [point("CD4_positive", "D1.fcs", 4, 65), point("CD4_positive", "D2.fcs", 2, 60)] }));
    const proportion = onePanel(ws, options(PROPORTION));
    // Differs: D2's bar holds 1 (the override) in the figure, 2 (CD4_positive) in Plotting, of its 5 events.
    expect(proportion.figure).toEqual(drawn({ bars: [bar("D1.fcs", ["CD4_positive", "ungated"], [4, 4]), bar("D2.fcs", ["CD4_positive", "ungated"], [1, 4])] }));
    expect(proportion.plotting).toEqual(drawn({ bars: [bar("D1.fcs", ["CD4_positive", "ungated"], [4, 4]), bar("D2.fcs", ["CD4_positive", "ungated"], [2, 3])] }));
    // The figure is built by Plotting's builders given each file's populations as it resolves
    // them: D2's CD4_positive is D2's CD8_positive. The block's recipe carries no such map, so the
    // figure and the block differ until the hand-off step gives the block the figure's map.
    const map = { D1: { [ws.idOf("CD4_positive")]: ws.idOf("CD4_positive") }, D2: { [ws.idOf("CD4_positive")]: ws.idOf("CD8_positive") } };
    for (const built of [cells, statistic, proportion]) expect(numbers(withMap(ws, built, map))).toEqual(numbers(built.figure));
  });

  it("8. a per-file population selection leaving a population out of one file: the figure follows it, as Plotting's builders do given the figure's map; a Layout block's recipe does not", () => {
    const ws = workspace();
    // D2's selection holds CD4_positive only, so the figure leaves D2's CD8_positive (1 event, FSC 15) out.
    const samplePopulations = { D1: [ws.ref("CD8_positive"), ws.ref("CD4_positive")], D2: [ws.ref("CD4_positive")] };
    const options = (chart: FigureChart): FigureOptions => ({
      files: ["D1", "D2"], chart, populations: [ws.ref("CD4_positive")], columns: [],
      plotPopulations: [ws.ref("CD8_positive"), ws.ref("CD4_positive")], samplePopulations,
    });
    const cd4 = mark("CD4_positive", ["D1.fcs", "D2.fcs"], [50, 55, 60, 65, 70, 80]);
    const cells = onePanel(ws, options(CELLS));
    // Differs: the figure's CD8_positive is D1's alone, with a note (figureChartData.ts, samplePopulations).
    expect(cells.figure).toEqual(drawn({ marks: [cd4, mark("CD8_positive", ["D1.fcs"], [10, 20, 30])], note: "Not drawn in every file: CD8_positive" }));
    // Differs: Plotting's CD8_positive holds D2's cell too; its settings carry no per-file selection.
    expect(cells.plotting).toEqual(drawn({ marks: [cd4, mark("CD8_positive", ["D1.fcs", "D2.fcs"], [10, 15, 20, 30])] }));
    const statistic = onePanel(ws, options(STATISTIC));
    const shared = [point("CD4_positive", "D1.fcs", 4, 65), point("CD4_positive", "D2.fcs", 2, 60), point("CD8_positive", "D1.fcs", 3, 20)];
    // Differs: Plotting draws D2's CD8_positive point; the figure does not.
    expect(statistic.figure).toEqual(drawn({ points: shared, note: "Not drawn in every file: CD8_positive" }));
    expect(statistic.plotting).toEqual(drawn({ points: [...shared, point("CD8_positive", "D2.fcs", 1, 15)] }));
    const proportion = onePanel(ws, options(PROPORTION));
    const categories = ["CD8_positive", "CD4_positive", "ungated"];
    // Differs: the figure's D2 bar has CD8_positive at 0 and its CD8_positive event ungated (3);
    // Plotting's counts it (1) and has 2 ungated. The figure's bar, as in case 5, puts a population
    // left out of a file into the rest.
    expect(proportion.figure).toEqual(drawn({ bars: [bar("D1.fcs", categories, [3, 4, 1]), bar("D2.fcs", categories, [0, 2, 3])], note: "Not drawn in every file: CD8_positive" }));
    expect(proportion.plotting).toEqual(drawn({ bars: [bar("D1.fcs", categories, [3, 4, 1]), bar("D2.fcs", categories, [1, 2, 2])] }));
    // Given the figure's map (D2 draws no CD8_positive), Plotting's builders draw the figure's
    // numbers; the block's recipe has no map, and differs until the hand-off step gives it one.
    const [cd8Id, cd4Id] = [ws.idOf("CD8_positive"), ws.idOf("CD4_positive")];
    const map = { D1: { [cd8Id]: cd8Id, [cd4Id]: cd4Id }, D2: { [cd8Id]: null, [cd4Id]: cd4Id } };
    for (const built of [cells, statistic, proportion]) expect(numbers(withMap(ws, built, map))).toEqual(numbers(built.figure));
  });

  it("9. a metadata column on a shelf: the same numbers in each value's panel; Plotting names the group", () => {
    const ws = workspace();
    const options = (chart: FigureChart): FigureOptions => ({ files: ALL, chart, populations: [ws.ref("CD8_positive")], columns: ["metadata:condition"] });
    // control: D1, CD8_positive 3 (10, 20, 30); treated: D2 1 (15) and D3 2 (25, 35).
    const cells = bothWays(ws, options(CELLS));
    expect(cells.map((b) => b.panel.samples)).toEqual([["D1"], ["D2", "D3"]]);
    expect(cells.map((b) => b.figure)).toEqual([
      drawn({ marks: [mark("CD8_positive", ["D1.fcs"], [10, 20, 30])] }),
      drawn({ marks: [mark("CD8_positive", ["D2.fcs", "D3.fcs"], [15, 25, 35])] }),
    ]);
    for (const b of cells) expect(ungrouped(b.plotting)).toEqual(b.figure);
    // Differs, a name only: Plotting names each violin by the panel's metadata value (groupSel "condition"); the figure leaves that to the panel's heading.
    expect(cells.map((b) => b.plotting.marks.map((m) => m.group))).toEqual([["control"], ["treated"]]);
    const statistic = bothWays(ws, options(STATISTIC));
    expect(statistic.map((b) => b.figure)).toEqual([
      drawn({ points: [point("CD8_positive", "D1.fcs", 3, 20)] }),
      drawn({ points: [point("CD8_positive", "D2.fcs", 1, 15), point("CD8_positive", "D3.fcs", 2, 30)] }),
    ]);
    for (const b of statistic) expect(ungrouped(b.plotting)).toEqual(b.figure);
    expect(statistic.map((b) => b.plotting.points.map((p) => p.group))).toEqual([["control"], ["treated", "treated"]]);
    // A bar per file, named by its file on both sides where the panel has two files.
    const proportion = bothWays(ws, options(PROPORTION));
    expect(proportion.map((b) => ungrouped(b.figure))).toEqual([
      ungrouped(drawn({ bars: [bar("D1.fcs", ["CD8_positive", "ungated"], [3, 5])] })),
      ungrouped(drawn({ bars: [bar("D2.fcs", ["CD8_positive", "ungated"], [1, 4]), bar("D3.fcs", ["CD8_positive", "ungated"], [2, 1])] })),
    ]);
    for (const b of proportion) expect(ungrouped(b.plotting)).toEqual(ungrouped(b.figure));
    expect(proportion[1].plotting).toEqual(proportion[1].figure);
    // Differs, a name only, as in case 1: the control panel's one bar is unnamed in the figure.
    expect([proportion[0].figure.bars[0].group, proportion[0].plotting.bars[0].group]).toEqual(["", "D1.fcs"]);
  });

  for (const several of [false, true])
    it(`10. a summary panel over three files, ${several ? "two populations" : "one population"}: the same numbers`, () => {
      const ws = workspace();
      const options = (chart: FigureChart): FigureOptions => ({
        files: ALL, chart: { ...chart, summary: true }, populations: [ws.ref("CD8_positive")],
        ...(several ? { plotPopulations: [ws.ref("CD8_positive"), ws.ref("CD4_positive")] } : {}),
      });
      // Each file at its own place along x: CD8_positive D1 3, D2 1, D3 2; CD4_positive D1 4, D2 2, D3 1.
      const cells = onePanel(ws, options(CELLS));
      expect(cells.panel.span).toEqual({ rows: 1, columns: 3 });
      const cd8 = [mark("CD8_positive", ["D1.fcs"], [10, 20, 30], "D1.fcs"), mark("CD8_positive", ["D2.fcs"], [15], "D2.fcs"), mark("CD8_positive", ["D3.fcs"], [25, 35], "D3.fcs")];
      const cd4 = [mark("CD4_positive", ["D1.fcs"], [50, 60, 70, 80], "D1.fcs"), mark("CD4_positive", ["D2.fcs"], [55, 65], "D2.fcs"), mark("CD4_positive", ["D3.fcs"], [75], "D3.fcs")];
      expect(cells.figure).toEqual(drawn({ marks: several ? [...cd4, ...cd8] : cd8 }));
      expect(cells.plotting).toEqual(cells.figure);
      const statistic = onePanel(ws, options(STATISTIC));
      const cd8Points = [point("CD8_positive", "D1.fcs", 3, 20, "D1.fcs"), point("CD8_positive", "D2.fcs", 1, 15, "D2.fcs"), point("CD8_positive", "D3.fcs", 2, 30, "D3.fcs")];
      const cd4Points = [point("CD4_positive", "D1.fcs", 4, 65, "D1.fcs"), point("CD4_positive", "D2.fcs", 2, 60, "D2.fcs"), point("CD4_positive", "D3.fcs", 1, 75, "D3.fcs")];
      expect(statistic.figure).toEqual(drawn({ points: several ? [...cd4Points, ...cd8Points] : cd8Points }));
      expect(statistic.plotting).toEqual(statistic.figure);
      // The shared chart lays the recipe's settings out as one panel with the figure's slots: as
      // many, in the same order, each with the same population, group, and cells or points.
      for (const built of [cells, statistic]) {
        const slots = figureSlots(ws, built.panel, built.spec);
        expect(slots).toHaveLength(several ? 6 : 3);
        expect(plottingSlots(ws, built.panel, built.spec)).toEqual(slots);
      }
      const proportion = onePanel(ws, options(PROPORTION));
      const categories = several ? ["CD8_positive", "CD4_positive", "ungated"] : ["CD8_positive", "ungated"];
      expect(proportion.figure).toEqual(drawn({
        bars: several
          ? [bar("D1.fcs", categories, [3, 4, 1]), bar("D2.fcs", categories, [1, 2, 2]), bar("D3.fcs", categories, [2, 1, 0])]
          : [bar("D1.fcs", categories, [3, 5]), bar("D2.fcs", categories, [1, 4]), bar("D3.fcs", categories, [2, 1])],
      }));
      expect(proportion.plotting).toEqual(proportion.figure);
    });

  it("11. a composition: both sides choose the same common parent and the same remainder", () => {
    const ws = workspace();
    const config = defaultIllustrationConfig();
    const parentOf = (b: ReturnType<typeof onePanel>) =>
      figureChartRecipe(b.panel, b.spec, { ...config, figure: b.spec }, () => true, ws.trees)!.settings.parent;
    // CD8_positive and CD4_positive: their common parent is the root, the rest ungated.
    // D1: 3 + 4 of 8, 1 ungated (double_positive); D2: 1 + 2 of 5, 2 ungated (double_negative).
    const atRoot = onePanel(ws, { files: ["D1", "D2"], chart: PROPORTION, populations: [ws.ref("CD8_positive")], columns: [], plotPopulations: [ws.ref("CD8_positive"), ws.ref("CD4_positive")] });
    expect(parentOf(atRoot)).toBe(ws.idOf("All Events"));
    const rootCategories = ["CD8_positive", "CD4_positive", "ungated"];
    expect(atRoot.figure).toEqual(drawn({ bars: [bar("D1.fcs", rootCategories, [3, 4, 1]), bar("D2.fcs", rootCategories, [1, 2, 2])] }));
    expect(atRoot.figure.bars[0].percents).toEqual([37.5, 50, 12.5]);
    expect(atRoot.plotting).toEqual(atRoot.figure);
    // FSC_high and FSC_low: their common parent is CD4_positive, and they split it whole.
    // D1: 2 + 2 of CD4_positive's 4; D2: 1 + 1 of its 2; the rest of CD4_positive is empty.
    const inCd4 = onePanel(ws, { files: ["D1", "D2"], chart: PROPORTION, populations: [ws.ref("CD8_positive")], columns: [], plotPopulations: [ws.ref("FSC_high"), ws.ref("FSC_low")] });
    expect(parentOf(inCd4)).toBe(ws.idOf("CD4_positive"));
    const cd4Categories = ["FSC_high", "FSC_low", "rest of CD4_positive"];
    expect(inCd4.figure).toEqual(drawn({ bars: [bar("D1.fcs", cd4Categories, [2, 2, 0]), bar("D2.fcs", cd4Categories, [1, 1, 0])] }));
    expect(inCd4.figure.bars.map((b) => b.counts[0] + b.counts[1])).toEqual(["D1", "D2"].map((id) => ws.counted(id, "CD4_positive")));
    expect(inCd4.plotting).toEqual(inCd4.figure);
  });

  it("12. populations from two trees: followed into the first's tree by both, one with no counterpart there named in the note", () => {
    const ws = workspace();
    const d3 = (name: PopulationName): FigurePopulation => ({ hierarchyId: D3_TREE, populationId: ws.idOf(name, ws.trees[D3_TREE]), label: name });
    // CD8_positive from Main and CD4_positive from D3's tree: both drawn in every file, each in its own tree.
    const both = onePanel(ws, { files: ALL, chart: CELLS, populations: [ws.ref("CD4_positive")], columns: [], plotPopulations: [ws.ref("CD8_positive"), d3("CD4_positive")] });
    expect(both.figure).toEqual(drawn({
      marks: [mark("CD4_positive", ["D1.fcs", "D2.fcs", "D3.fcs"], [50, 55, 60, 65, 70, 75, 80]), mark("CD8_positive", ["D1.fcs", "D2.fcs", "D3.fcs"], [10, 15, 20, 25, 30, 35])],
    }));
    expect(both.plotting).toEqual(both.figure);
    // D3's tree first: FSC_high, from Main, has no counterpart there, so neither side draws it,
    // and the figure names it. The figure drew it in D1 and D2 before.
    const unmatched = onePanel(ws, { files: ALL, chart: CELLS, populations: [ws.ref("CD4_positive")], columns: [], plotPopulations: [d3("CD8_positive"), ws.ref("FSC_high")] });
    const cd8 = [mark("CD8_positive", ["D1.fcs", "D2.fcs", "D3.fcs"], [10, 15, 20, 25, 30, 35])];
    expect(unmatched.figure).toEqual(drawn({ marks: cd8, note: "Not drawn in every file: FSC_high" }));
    expect(unmatched.plotting).toEqual(drawn({ marks: cd8 }));
  });
});
