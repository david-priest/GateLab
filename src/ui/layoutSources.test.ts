// layoutSources.test.ts — what each Layout block says of its data, read from the models it draws
// from, against the gate list's counts of a quadrant gate drawn on synthetic files D1 to D4
// (control: D1, D2; treated: D3, D4). Nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, recomputeGating, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { figureHierarchies, type FigureSample } from "../engine/figure";
import { BASE_PROPORTIONS_SETTINGS, type ProportionsSettings } from "../engine/proportionsSettings";
import type { LayoutItem, LayoutRecipe } from "../engine/layout";
import type { DescribeBoundPlot } from "../engine/layoutBatch";
import { plotTitleContext } from "../engine/layoutTitle";
import type { ChartSource } from "./LayoutChart";
import { legendForItems, readingOrder } from "./layoutLegend";
import { describeLayoutBlock, exactP, fillSourcePlaceholders, hasSourcePlaceholder, shortList, sizesText, sourceRows, testSentence, type BlockSourceContext } from "./layoutSources";

// Each event is [FITC-A (CD4), PE-A (CD8), FSC-A]; the quadrant's centre is at 1000, 1000.
type Event = [number, number, number];
const LOW = 100;
const HIGH = 5000;
function fcs(events: Event[]): FcsFile {
  const channels = [
    { index: 0, name: "FITC-A", marker: "CD4", bits: 32, range: 262144 },
    { index: 1, name: "PE-A", marker: "CD8", bits: 32, range: 262144 },
    { index: 2, name: "FSC-A", marker: null, bits: 32, range: 262144 },
  ];
  return {
    version: "FCS3.1", nEvents: events.length, instrument: "flow", keywords: {}, spillover: null, channels,
    columns: channels.map((_, c) => Float32Array.from(events.map((event) => event[c]))),
  };
}
// CD4 SP (high CD4, low CD8) forward scatter: D1 10, 20; D2 30; D3 50, 60, 70; D4 80.
const EVENTS: Record<string, Event[]> = {
  D1: [[HIGH, LOW, 10], [HIGH, LOW, 20], [LOW, HIGH, 5], [LOW, LOW, 7]],
  D2: [[HIGH, LOW, 30], [LOW, HIGH, 6]],
  D3: [[HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, HIGH, 9]],
  D4: [[HIGH, LOW, 80], [LOW, HIGH, 4], [LOW, HIGH, 3]],
};
const TREATMENT: Record<string, string> = { D1: "control", D2: "control", D3: "treated", D4: "treated" };

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "CD4", yChannel: "CD8",
    center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["CD8 SP", "DP", "CD4 SP", "DN"],
  });
  const core = state as CoreState;
  const gate = Object.values(core.gates).find((g) => g.gate_type === "quadrant")!;
  const [cd8, , cd4] = [1, 2, 3, 4].map((q) =>
    Object.values(core.populations).find((p) => p.gate_refs.some((r) => r.gate_id === gate.gate_id && r.quadrant === q))!.population_id,
  );
  const tree = figureHierarchies(core)[core.active_hierarchy_id];
  const files: FigureSample[] = Object.entries(EVENTS).map(([id, events]) => ({
    id, name: id, fileName: `${id}.fcs`, sample: new Sample(fcs(events)), hierarchyId: DEFAULT_HIERARCHY_ID, metadata: { Treatment: TREATMENT[id] },
  }));
  const samples: ChartSource[] = files.map((file) => ({ id: file.id, name: file.fileName!, sample: file.sample, derived: recomputeGating(file.sample, core), tree }));
  const metadataById = Object.fromEntries(files.map((file) => [file.id, file.metadata]));
  // As the Layout tab's describePlot reads a plot of one file: its population's name and count,
  // and an overlay's counts in the order of its populations.
  const describePlot: DescribeBoundPlot = (recipe) => {
    const view = samples.find((entry) => entry.id === recipe.sampleId)!;
    const population = view.tree.populations[recipe.populationId];
    const context = plotTitleContext("xChannel" in recipe ? recipe : {}, { name: view.id, fileName: view.name }, population ? { id: recipe.populationId, name: population.name } : null, view.derived.stats.event_count[recipe.populationId] ?? undefined);
    const overlay = recipe.kind !== "strategy" && recipe.populationIds && recipe.populationIds.length > 1 ? recipe.populationIds : null;
    return overlay ? { ...context, counts: overlay.map((id) => view.derived.stats.event_count[id] ?? 0) } : context;
  };
  const ctx: BlockSourceContext = { files, samples, state: core, metadataById, checkedSampleIds: files.map((f) => f.id), divisionProfiles: {}, dataRevision: 0, describePlot };
  const counted = (id: string, population: string) => recompute(files.find((f) => f.id === id)!.sample, core).populations[population].event_count ?? 0;
  const settings: ProportionsSettings = {
    ...BASE_PROPORTIONS_SETTINGS,
    files: files.map((f) => f.id),
    hierarchy: core.active_hierarchy_id,
    parent: core.root_population_id!,
    selectedPops: [cd4],
    groupSel: "Treatment",
    channel: "FSC-A",
  };
  return { state: core, cd4, cd8, ctx, counted, settings };
}

const item = (recipe: LayoutRecipe, extra: Partial<LayoutItem> = {}): LayoutItem => ({ id: "i", x: 0, y: 0, width: 200, height: 200, z: 0, recipe, ...extra });

describe("A Layout block's source", () => {
  it("of a plot gives its file, population, channels and the population's count", () => {
    const fx = fixture();
    const source = describeLayoutBlock(item({ kind: "biplot", sampleId: "D3", populationId: fx.cd4, xChannel: "FITC-A", yChannel: "PE-A", displayMode: "pseudocolor" }), fx.ctx)!;
    expect(fx.counted("D3", fx.cd4)).toBe(3);
    expect(source).toMatchObject({ kind: "plot", files: ["D3.fcs"], populations: ["CD4 SP"], counts: [3], follows: false });
    expect(source.channels).toHaveLength(2);
    expect(sizesText(source)).toBe("n = 3 events");
  });

  it("of a pooled plot names every pooled file", () => {
    const fx = fixture();
    const source = describeLayoutBlock(item({ kind: "histogram", sampleId: "D1", populationId: fx.cd4, xChannel: "FSC-A", yChannel: null, displayMode: "pseudocolor", pool: { sampleIds: ["D1", "D2"] }, iterated: true }), fx.ctx)!;
    expect(source).toMatchObject({ kind: "pool", files: ["D1.fcs", "D2.fcs"], follows: true });
    expect(source.shows).toContain("2 files pooled");
  });

  it("of a strategy gives the target population's count on its file", () => {
    const fx = fixture();
    const source = describeLayoutBlock(item({ kind: "strategy", sampleId: "D1", populationId: fx.cd8, fullPath: true, displayMode: "pseudocolor" }), fx.ctx)!;
    expect(source).toMatchObject({ kind: "strategy", files: ["D1.fcs"], populations: ["CD8 SP"], counts: [fx.counted("D1", fx.cd8)] });
    expect(source.counts).toEqual([1]);
  });

  it("of a statistic chart gives n replicate units per group and the rank test's p", () => {
    const fx = fixture();
    const settings: ProportionsSettings = { ...fx.settings, valueKind: "statistic", plotType: "box", xAxis: "groups", test: true };
    const source = describeLayoutBlock(item({ kind: "proportions", settings }), fx.ctx)!;
    expect(source.kind).toBe("statistic");
    expect(source.groupTitle).toBe("Treatment");
    expect(source.groups).toEqual([{ label: "control", population: "CD4 SP", n: 2 }, { label: "treated", population: "CD4 SP", n: 2 }]);
    // Medians 15, 30 against 60, 80: no overlap, so the exact two-sided p is 2/6.
    expect(source.tests).toHaveLength(1);
    expect(source.tests![0].p).toBeCloseTo(1 / 3, 10);
    expect(source.shows).toBe("Median FSC-A of CD4 SP cells per file");
    expect(testSentence(source)).toBe("Wilcoxon rank-sum test, p = 0.33.");
    expect(sizesText(source)).toBe("control, n = 2 files; treated, n = 2 files");
    expect(source.centre).toContain("1.5 times the interquartile range");
  });

  it("of a statistic chart with pairwise comparisons says what is tested and gives the bracket's p", () => {
    const fx = fixture();
    const settings: ProportionsSettings = { ...fx.settings, valueKind: "statistic", plotType: "box", xAxis: "groups", test: true, comparisons: "pairwise" };
    const source = describeLayoutBlock(item({ kind: "proportions", settings }), fx.ctx)!;
    // Two groups: the bracket replaces the line.
    expect(source.tests).toEqual([]);
    expect(source.comparisons).toHaveLength(1);
    expect(source.comparisons![0]).toMatchObject({ groupA: "control", groupB: "treated", name: "Wilcoxon rank-sum" });
    expect(source.comparisons![0].pAdjusted).toBeCloseTo(1 / 3, 10);
    expect(testSentence(source)).toBe("Wilcoxon rank-sum test on the files' medians. Pairs, Holm-adjusted: CD4 SP, control against treated, p = 0.33.");
  });

  it("of a proportion boxplot with the test gives each panel's test", () => {
    const fx = fixture();
    const source = describeLayoutBlock(item({ kind: "proportions", settings: { ...fx.settings, valueKind: "proportion", plotType: "box", selectedPops: [fx.cd4], test: true } }), fx.ctx)!;
    expect(source.testAsked).toBe(true);
    // A panel for CD4 SP and one for the ungated rest.
    expect(source.tests!.map((test) => [test.panel, test.name])).toEqual([["CD4 SP", "Wilcoxon rank-sum"], ["ungated", "Wilcoxon rank-sum"]]);
    expect(source.testDescription).toBeUndefined();
  });

  it("of a bar or point statistic chart names the mean and its error bar", () => {
    const fx = fixture();
    const bars = describeLayoutBlock(item({ kind: "proportions", settings: { ...fx.settings, valueKind: "statistic", plotType: "bar", errorBar: "sem", xAxis: "groups" } }), fx.ctx)!;
    expect(bars.centre).toBe("Bars show the mean of the files and error bars the standard error of the mean.");
    expect(bars.tests).toEqual([]);
    expect(bars.testAsked).toBe(false);
    const dots = describeLayoutBlock(item({ kind: "proportions", settings: { ...fx.settings, valueKind: "statistic", plotType: "dots", xAxis: "groups" } }), fx.ctx)!;
    expect(dots.centre).toContain("Points show each file");
  });

  it("of a per-cell chart gives the cells per group, as the gate counts them", () => {
    const fx = fixture();
    const source = describeLayoutBlock(item({ kind: "proportions", settings: { ...fx.settings, valueKind: "cells", plotType: "violin", xAxis: "groups" } }), fx.ctx)!;
    const control = fx.counted("D1", fx.cd4) + fx.counted("D2", fx.cd4);
    const treated = fx.counted("D3", fx.cd4) + fx.counted("D4", fx.cd4);
    expect([control, treated]).toEqual([3, 4]);
    expect(source).toMatchObject({ kind: "cells", unit: "cells", groups: [{ label: "control", n: control }, { label: "treated", n: treated }] });
  });

  it("of a proportion boxplot gives replicate units per group; a pooled stacked bar its events", () => {
    const fx = fixture();
    const box = describeLayoutBlock(item({ kind: "proportions", settings: { ...fx.settings, valueKind: "proportion", plotType: "box", selectedPops: [fx.cd4, fx.cd8] } }), fx.ctx)!;
    expect(box).toMatchObject({ kind: "proportion", unit: "files", groups: [{ label: "control", n: 2 }, { label: "treated", n: 2 }] });
    expect(box.populations).toEqual(expect.arrayContaining(["CD4 SP", "CD8 SP"]));
    const stacked = describeLayoutBlock(item({ kind: "proportions", settings: { ...fx.settings, valueKind: "proportion", plotType: "stacked", averagePerUnit: false, includeUngated: true } }), fx.ctx)!;
    const events = (ids: string[]) => ids.reduce((total, id) => total + EVENTS[id].length, 0);
    expect(stacked.unit).toBe("events");
    expect(stacked.groups).toEqual([{ label: "control", n: events(["D1", "D2"]) }, { label: "treated", n: events(["D3", "D4"]) }]);
  });

  it("of one panel gives that panel's population only", () => {
    const fx = fixture();
    const settings: ProportionsSettings = { ...fx.settings, valueKind: "statistic", plotType: "box", xAxis: "groups", selectedPops: [fx.cd4, fx.cd8], test: true };
    const source = describeLayoutBlock(item({ kind: "proportions", settings, panel: { population: "CD8 SP", populationId: fx.cd8 } }), fx.ctx)!;
    expect(source.panel).toBe("CD8 SP");
    expect(source.populations).toEqual(["CD8 SP"]);
    // CD8 SP: D1 1, D2 1, D3 none, D4 2 events: one treated file, so no test can be made.
    expect(source.groups).toEqual([{ label: "control", population: "CD8 SP", n: 2 }, { label: "treated", population: "CD8 SP", n: 1 }]);
    expect(source.tests).toEqual([]);
    expect(testSentence(source)).toMatch(/^No test was made/);
  });

  it("of one panel of a proportion boxplot with facets gives that panel's population and facet's files", () => {
    const fx = fixture();
    const settings: ProportionsSettings = { ...fx.settings, valueKind: "proportion", plotType: "box", selectedPops: [fx.cd4, fx.cd8], includeUngated: false, facetSel: "Treatment" };
    const source = describeLayoutBlock(item({ kind: "proportions", settings, panel: { facet: "treated", population: "CD8 SP", populationId: fx.cd8 } }), fx.ctx)!;
    expect(source.populations).toEqual(["CD8 SP"]);
    expect(source.groups).toEqual([{ label: "treated", n: 2 }]);
  });

  it("of a page of a chart with pages gives the page's panels and says which page", () => {
    const fx = fixture();
    // A statistic chart with the populations along x and a page per group: the treated page.
    const statistic: ProportionsSettings = { ...fx.settings, valueKind: "statistic", plotType: "box", xAxis: "populations", selectedPops: [fx.cd4, fx.cd8], pageBy: "groups" };
    const page = describeLayoutBlock(item({ kind: "proportions", settings: statistic, panel: { page: "treated" } }), fx.ctx)!;
    expect(page.page).toBe("Treatment: treated");
    expect(page.panel).toBeUndefined();
    // CD4 SP in D3 and D4, CD8 SP in D4 only (D3 has none).
    expect([fx.counted("D3", fx.cd8), fx.counted("D4", fx.cd8)]).toEqual([0, 2]);
    expect(page.groups).toEqual([{ label: "treated", population: "CD8 SP", n: 1 }, { label: "treated", population: "CD4 SP", n: 2 }]);
    expect(sourceRows(page)).toContainEqual({ term: "Page", value: "Treatment: treated" });
    expect(legendForItems([item({ kind: "proportions", settings: statistic, panel: { page: "treated" } })], (entry) => describeLayoutBlock(entry, fx.ctx))).toContain("(page Treatment: treated)");
    // A per-cell chart with a page per population: the CD4 SP page's cells, as the gate counts them.
    const cells: ProportionsSettings = { ...fx.settings, valueKind: "cells", plotType: "violin", xAxis: "groups", selectedPops: [fx.cd4, fx.cd8], pageBy: "populations" };
    const cd4 = describeLayoutBlock(item({ kind: "proportions", settings: cells, panel: { page: "CD4 SP" } }), fx.ctx)!;
    expect(cd4.page).toBe("CD4 SP");
    expect(cd4.populations).toEqual(["CD4 SP"]);
    expect(cd4.groups).toEqual([
      { label: "control", population: "CD4 SP", n: fx.counted("D1", fx.cd4) + fx.counted("D2", fx.cd4) },
      { label: "treated", population: "CD4 SP", n: fx.counted("D3", fx.cd4) + fx.counted("D4", fx.cd4) },
    ]);
    // A proportion boxplot with a page per facet: the control page's files only.
    const box: ProportionsSettings = { ...fx.settings, valueKind: "proportion", plotType: "box", selectedPops: [fx.cd4, fx.cd8], includeUngated: false, facetSel: "Treatment", pageBy: "facet" };
    const control = describeLayoutBlock(item({ kind: "proportions", settings: box, panel: { page: "control" } }), fx.ctx)!;
    expect(control.page).toBe("Treatment: control");
    expect(control.populations).toEqual(expect.arrayContaining(["CD4 SP", "CD8 SP"]));
    expect(control.groups).toEqual([{ label: "control", n: 2 }]);
  });

  it("of a chart of several channels names every channel, and a block of one channel describes that channel", () => {
    const fx = fixture();
    const settings: ProportionsSettings = { ...fx.settings, valueKind: "statistic", plotType: "box", xAxis: "populations", channel: "FSC-A", channels: ["FSC-A", "CD4"] };
    const whole = describeLayoutBlock(item({ kind: "proportions", settings }), fx.ctx)!;
    expect(whole.channels).toHaveLength(2);
    expect(whole.channels[0]).toBe("FSC-A");
    expect(whole.value).toMatch(/^Median FSC-A and CD4/);
    const one = describeLayoutBlock(item({ kind: "proportions", settings, panel: { channel: "CD4", group: "treated" } }), fx.ctx)!;
    expect(one.channels).toHaveLength(1);
    expect(one.channels[0]).toMatch(/^CD4/);
    // The treated files' CD4 SP units, D3 and D4, each one point.
    expect(one.groups).toEqual([{ label: "treated", population: "CD4 SP", n: 2 }]);
    const page = describeLayoutBlock(item({ kind: "proportions", settings: { ...settings, pageBy: "channels" }, panel: { page: "CD4" } }), fx.ctx)!;
    expect(page.page).toMatch(/^CD4/);
    expect(page.channels).toEqual(one.channels);
  });

  it("of the old chart block gives its files per group and test", () => {
    const fx = fixture();
    const source = describeLayoutBlock(item({ kind: "chart", sampleId: "D1", populationId: fx.cd4, statistic: "count", files: "all", groupBy: "Treatment", chartType: "box", showPoints: true, test: true }), fx.ctx)!;
    expect(source.groups).toEqual([{ label: "control", n: 2 }, { label: "treated", n: 2 }]);
    expect(source.files).toEqual(["D1.fcs", "D2.fcs", "D3.fcs", "D4.fcs"]);
    // Counts 2, 1 against 3, 1: tied, so the normal approximation.
    expect(source.tests).toHaveLength(1);
    expect(source.tests![0].name).toBe("Wilcoxon rank-sum");
  });

  it("of a figure gives its files, populations and channels", () => {
    const fx = fixture();
    const source = describeLayoutBlock(item({
      kind: "figure", page: 0,
      illustration: { figure: { version: 1, name: "F", sampleIds: ["D1", "D2"], populations: [{ hierarchyId: DEFAULT_HIERARCHY_ID, populationId: fx.cd4, label: "CD4 SP" }], plots: [{ id: "p", name: "p", x: "FITC-A", y: "PE-A", type: "biplot" }], rows: [], columns: [], pages: [], composition: "separate", scalePolicy: "gating", transforms: {}, showGates: true, panelSize: 200 } } as never,
    }), fx.ctx)!;
    expect(source).toMatchObject({ kind: "figure", files: ["D1.fcs", "D2.fcs"], populations: ["CD4 SP"] });
    expect(source.channels).toHaveLength(2);
  });
});

describe("Source placeholders and rows", () => {
  it("fill the source placeholders and leave an unknown one as typed", () => {
    const fx = fixture();
    const source = describeLayoutBlock(item({ kind: "proportions", settings: { ...fx.settings, valueKind: "statistic", plotType: "box", xAxis: "groups", test: true } }), fx.ctx)!;
    const text = "{statistic} · {files} · {sizes} · {unit} · {channel} · {test} {p} {other} {n}";
    expect(hasSourcePlaceholder(text)).toBe(true);
    expect(fillSourcePlaceholders(text, source)).toBe(
      "Median FSC-A · 4 files · control, n = 2 files; treated, n = 2 files · files · FSC-A · Wilcoxon rank-sum test p = 0.33 {other} {n}",
    );
    expect(fillSourcePlaceholders(text, null)).toBe(text);
  });

  it("cut a long file list to three names with the rest in the full value", () => {
    expect(shortList(["a", "b", "c"])).toEqual({ value: "a, b, c" });
    expect(shortList(["a", "b", "c", "d", "e"])).toEqual({ value: "a, b, c + 2 more", full: "a, b, c, d, e" });
    const fx = fixture();
    const rows = sourceRows(describeLayoutBlock(item({ kind: "proportions", settings: { ...fx.settings, valueKind: "statistic", plotType: "box", xAxis: "groups", test: true } }), fx.ctx)!);
    expect(rows.find((row) => row.term === "Files")).toEqual({ term: "Files", count: 4, value: "D1.fcs, D2.fcs, D3.fcs + 1 more", full: "D1.fcs, D2.fcs, D3.fcs, D4.fcs" });
  });

  it("give p to two significant figures, and a power of ten below 0.001", () => {
    expect(exactP(0.1)).toBe("p = 0.10");
    expect(exactP(0.0571)).toBe("p = 0.057");
    expect(exactP(0.00032)).toBe("p = 3.2 × 10^-4");
  });
});

describe("A written legend", () => {
  it("describes a flow plot, an overlaid plot and a chart of each value mode, in reading order, with the counts drawn", () => {
    const fx = fixture();
    const at = (id: string, x: number, y: number, recipe: LayoutRecipe): LayoutItem => ({ id, x, y, width: 200, height: 200, z: 0, recipe });
    const items = [
      // Read second: the same row as the plot, to its right.
      at("overlay", 260, 30, { kind: "histogram", sampleId: "D1", populationId: fx.cd4, populationIds: [fx.cd4, fx.cd8], xChannel: "FSC-A", yChannel: null, displayMode: "pseudocolor" }),
      at("plot", 20, 20, { kind: "biplot", sampleId: "D3", populationId: fx.cd4, xChannel: "FITC-A", yChannel: "PE-A", displayMode: "pseudocolor" }),
      at("statistic", 20, 260, { kind: "proportions", settings: { ...fx.settings, valueKind: "statistic", plotType: "box", xAxis: "groups", test: true } }),
      at("cells", 260, 260, { kind: "proportions", settings: { ...fx.settings, valueKind: "cells", plotType: "box", xAxis: "groups" } }),
      at("proportion", 500, 260, { kind: "proportions", settings: { ...fx.settings, valueKind: "proportion", plotType: "box", selectedPops: [fx.cd4, fx.cd8] } }),
      at("text", 20, 500, { kind: "text", text: "A heading", fontSize: 12 }),
    ];
    expect(readingOrder(items).map((item) => item.id)).toEqual(["plot", "overlay", "statistic", "cells", "proportion", "text"]);
    const legend = legendForItems(items, (item) => describeLayoutBlock(item, fx.ctx));
    const lines = legend.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^Panel 1\. .* against .* of CD4 SP cells in D3\.fcs \(n = 3 events\)\.$/);
    expect(fx.counted("D1", fx.cd4)).toBe(2);
    expect(fx.counted("D1", fx.cd8)).toBe(1);
    expect(lines[1]).toBe("Panel 2. Histogram of FSC-A of CD4 SP and CD8 SP overlaid in D1.fcs (CD4 SP, n = 2 events; CD8 SP, n = 1 event).");
    expect(lines[2]).toBe(
      "Panel 3. Median FSC-A of CD4 SP cells per file, grouped by Treatment (control, n = 2 files; treated, n = 2 files). " +
      "Boxes show the median and quartiles of the files; whiskers extend to the most extreme file within 1.5 times the interquartile range. " +
      "Wilcoxon rank-sum test, p = 0.33.",
    );
    expect(lines[3]).toBe(
      "Panel 4. FSC-A in each cell of CD4 SP, the cells of each group's files pooled, grouped by Treatment (control, n = 3 cells; treated, n = 4 cells). " +
      "Boxes show the median and quartiles of the cells; whiskers extend to the most extreme cell within 1.5 times the interquartile range.",
    );
    // The boxplot draws the events outside the selected populations as a category of their own.
    expect(lines[4]).toBe(
      "Panel 5. % of all events for CD8 SP, CD4 SP and ungated per file, grouped by Treatment (control, n = 2 files; treated, n = 2 files). " +
      "Boxes show the median and quartiles of the files; whiskers extend to the most extreme file within 1.5 times the interquartile range.",
    );
  });

  it("names lettered blocks by their panel letters, in the letters' order, and numbers the rest after them", () => {
    const fx = fixture();
    const at = (id: string, x: number, y: number, recipe: LayoutRecipe): LayoutItem => ({ id, x, y, width: 200, height: 200, z: 0, recipe });
    const items = [
      at("plot", 20, 20, { kind: "biplot", sampleId: "D3", populationId: fx.cd4, xChannel: "FITC-A", yChannel: "PE-A", displayMode: "pseudocolor" }),
      at("overlay", 260, 30, { kind: "histogram", sampleId: "D1", populationId: fx.cd4, populationIds: [fx.cd4, fx.cd8], xChannel: "FSC-A", yChannel: null, displayMode: "pseudocolor" }),
      at("statistic", 20, 260, { kind: "proportions", settings: { ...fx.settings, valueKind: "statistic", plotType: "box", xAxis: "groups", test: true } }),
    ];
    // The letters run down the left column first (a tall item can join rows), and the overlay has none.
    const letters: Record<string, string> = { plot: "A", statistic: "B" };
    const legend = legendForItems(items, (item) => describeLayoutBlock(item, fx.ctx), (item) => letters[item.id]);
    const lines = legend.split("\n");
    expect(lines.map((line) => line.split(" ")[0])).toEqual(["A.", "B.", "Panel"]);
    expect(lines[0]).toMatch(/^A\. .* of CD4 SP cells in D3\.fcs/);
    expect(lines[1]).toMatch(/^B\. Median FSC-A of CD4 SP cells per file/);
    expect(lines[2]).toMatch(/^Panel 1\. Histogram of FSC-A/);
    // Without letters, the legend is numbered as before.
    expect(legendForItems(items, (item) => describeLayoutBlock(item, fx.ctx)).split("\n").map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual(["Panel 1.", "Panel 2.", "Panel 3."]);
  });

  it("is empty for a page that draws no data", () => {
    const fx = fixture();
    expect(legendForItems([item({ kind: "text", text: "Only words", fontSize: 12 })], (entry) => describeLayoutBlock(entry, fx.ctx))).toBe("");
  });
});
