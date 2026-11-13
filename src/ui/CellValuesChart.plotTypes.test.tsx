// @vitest-environment jsdom
// A per-cell chart's split violin and ridgelines, drawn from a gate drawn and counted: a half
// violin's outline is the violin's left or right half, a split needs exactly two groups along x,
// the ridgeline rows stay within the plot along a horizontal value axis, and replicate marks, the
// n and typed limits are drawn on the half or row they belong to. Synthetic files F1 to F5, donors
// D1 and D2, groups control and treated; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { BASE_PROPORTIONS_SETTINGS, type ProportionsSettings } from "../engine/proportionsSettings";
import type { ProportionsSampleRef } from "../engine/proportionsModel";
import { buildCellValuesModel, cellValueAxis, violinOutline } from "../engine/cellValuesModel";
import { paletteColors } from "../engine/palettes";
import {
  CellValuesChart,
  cellChartAxis,
  cellChartLayout,
  halfViolinPath,
  ridgelineRows,
  splitsViolins,
  type CellPlotType,
  type CellReplicates,
} from "./CellValuesChart";
import type { ChartAxisFrame } from "./chart/valueAxis";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

type Event = [number, number, number];
const LOW = 100;
const HIGH = 5000;
function file(id: string, events: Event[]): ProportionsSampleRef {
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
  return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
}
const cd4 = (fsc: number): Event => [HIGH, LOW, fsc];
const cd8 = (fsc: number): Event => [LOW, HIGH, fsc];
// CD4 SP forward scatter: D1 control 50, 60, 70, 100; D2 control 200, 220; D1 treated 300, 320,
// 340; D2 treated 400, 410. CD8 SP: one cell in each file.
const FILES = [
  file("F1", [cd4(50), cd4(60), cd4(70), cd8(30)]),
  file("F2", [cd4(100), cd8(35)]),
  file("F3", [cd4(200), cd4(220), cd8(40)]),
  file("F4", [cd4(300), cd4(320), cd4(340), cd8(45)]),
  file("F5", [cd4(400), cd4(410), cd8(50)]),
];
const METADATA: Record<string, Record<string, string>> = {
  F1: { condition: "control", donor: "D1" },
  F2: { condition: "control", donor: "D1" },
  F3: { condition: "control", donor: "D2" },
  F4: { condition: "treated", donor: "D1" },
  F5: { condition: "treated", donor: "D2" },
};

function fixture(metadata = METADATA) {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "CD4", yChannel: "CD8",
    center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["CD8 SP", "DP", "CD4 SP", "DN"],
  });
  const core = state as CoreState;
  const gate = Object.values(core.gates).find((g) => g.gate_type === "quadrant")!;
  const quadrants = [1, 2, 3, 4].map((q) =>
    Object.values(core.populations).find((p) => p.gate_refs.some((r) => r.gate_id === gate.gate_id && r.quadrant === q))!.population_id,
  );
  const settings: ProportionsSettings = {
    ...BASE_PROPORTIONS_SETTINGS,
    valueKind: "cells", plotType: "splitViolin", channel: "FSC-A", files: FILES.map((f) => f.id),
    hierarchy: core.active_hierarchy_id, parent: core.root_population_id!, selectedPops: [quadrants[0], quadrants[2]],
    groupSel: "condition", unitSel: "donor", xAxis: "groups",
  };
  const model = buildCellValuesModel(settings, FILES, core, metadata);
  const unitModel = buildCellValuesModel(settings, FILES, core, metadata, { poolBy: "unit", values: "raw" });
  const axis = cellValueAxis(model, "fit", undefined)!;
  const replicates: CellReplicates = { unitModel, statistic: "median", unitSel: "donor", test: false };
  return { model, unitModel, axis, replicates };
}

const HEIGHT = 180;
const FONTS = { tick: 9, axis: 10, legend: 11 };
function draw(
  fx: ReturnType<typeof fixture>,
  plotType: CellPlotType,
  extra: { xAxis?: "populations" | "groups"; violinBox?: boolean; showN?: boolean; replicates?: CellReplicates; axis?: ChartAxisFrame } = {},
) {
  act(() =>
    root.render(
      <CellValuesChart
        model={fx.model}
        plotType={plotType}
        xAxis={extra.xAxis ?? "groups"}
        violinBox={extra.violinBox ?? false}
        showN={extra.showN}
        axis={extra.axis ?? fx.axis}
        catColors={["#111111", "#222222"]}
        palette="paired"
        fonts={FONTS}
        appearance={{ height: HEIGHT, showGrid: true, showLegend: true }}
        groupTitle="condition"
        replicates={extra.replicates}
      />,
    ),
  );
  const panels = [...host.querySelectorAll("svg.gl-prop-panel")];
  const panel = (title: string) => panels.find((svg) => svg.querySelector("text title")?.textContent === title)!;
  return { panels, panel };
}

/** A path's points, in order. */
const points = (d: string) => d.split(/[MLZ]/).filter(Boolean).map((pair) => pair.split(",").map(Number) as [number, number]);

describe("Per-cell chart: split violin", () => {
  it("is drawn only with exactly two groups along x", () => {
    expect(splitsViolins(2, "groups")).toBe(true);
    expect(splitsViolins(3, "groups")).toBe(false);
    expect(splitsViolins(1, "groups")).toBe(false);
    expect(splitsViolins(2, "populations")).toBe(false);
  });

  it("builds a half from the outline: the left half mirrors the right about the centre line, which closes it", () => {
    const outline = [{ x: 0, y: 100 }, { x: 10, y: 80 }, { x: 4, y: 60 }];
    const right = points(halfViolinPath(outline, 50, 1));
    const left = points(halfViolinPath(outline, 50, -1));
    expect(right).toEqual([[50, 100], [60, 80], [54, 60], [50, 60], [50, 100]]);
    expect(left).toEqual([[50, 100], [40, 80], [46, 60], [50, 60], [50, 100]]);
    expect(halfViolinPath(outline.slice(0, 1), 50, 1)).toBe("");
  });

  it("draws each population's two groups as the halves of one violin, in the groups' colours, on a shared centre line, each half the violin's outline", () => {
    const fx = fixture();
    const { panels, panel } = draw(fx, "splitViolin");
    expect(panels).toHaveLength(2);
    const halves = [...panel("CD4 SP").querySelectorAll("path.gl-prop-mark")];
    expect(halves).toHaveLength(2);
    const [control, treated] = halves.map((path) => points(path.getAttribute("d")!));
    // Each half closes along the same centre line.
    const centre = control[control.length - 1][0];
    expect(treated[treated.length - 1][0]).toBeCloseTo(centre, 6);
    const controlOuter = control.slice(0, -2);
    const treatedOuter = treated.slice(0, -2);
    expect(controlOuter.every(([x]) => x <= centre + 1e-9)).toBe(true);
    expect(treatedOuter.every(([x]) => x >= centre - 1e-9)).toBe(true);
    // The outline is the violin's: its widths, relative to the widest, are the density's.
    const violin = fx.model.violins.find((v) => v.cat === 1 && v.group === "control")!;
    const widths = violinOutline(violin.values).width;
    const offsets = controlOuter.map(([x]) => centre - x);
    const widest = Math.max(...offsets);
    // (The path is written to a hundredth of a pixel.)
    expect(offsets.map((o) => o / widest)).toEqual(widths.map((w) => expect.closeTo(w / Math.max(...widths), 3)));
    // The groups' colours, as the legend has them.
    const colours = paletteColors("paired", 2);
    expect(halves.map((path) => path.getAttribute("fill"))).toEqual(colours);
    expect(halves[0].querySelector("title")!.textContent).toBe("CD4 SP · control: 6 cells from 3 files, median 85");
  });

  it("marks each half's median across it, and its quartiles as shorter lines with the box on", () => {
    const fx = fixture();
    let { panel } = draw(fx, "splitViolin");
    const medians = [...panel("CD4 SP").querySelectorAll("line.gl-prop-split-median")];
    expect(medians).toHaveLength(2);
    const centre = Number(medians[0].getAttribute("x1"));
    expect(Number(medians[0].getAttribute("x2"))).toBeLessThan(centre);
    expect(Number(medians[1].getAttribute("x2"))).toBeGreaterThan(centre);
    const without = panel("CD4 SP").querySelectorAll("line").length;
    ({ panel } = draw(fx, "splitViolin", { violinBox: true }));
    const lines = [...panel("CD4 SP").querySelectorAll(".gl-prop-mark-group line")];
    expect(panel("CD4 SP").querySelectorAll("line").length).toBe(without + 4);
    const length = (line: Element) => Math.abs(Number(line.getAttribute("x2")) - Number(line.getAttribute("x1")));
    const median = lines.find((line) => line.classList.contains("gl-prop-split-median"))!;
    const quartiles = lines.filter((line) => !line.classList.contains("gl-prop-split-median")).slice(0, 2);
    for (const quartile of quartiles) expect(length(quartile)).toBeLessThan(length(median));
  });

  it("draws whole violins with the populations along x, or with other than two groups", () => {
    const fx = fixture();
    const { panels } = draw(fx, "splitViolin", { xAxis: "populations" });
    // A panel per group, a whole violin per population: each outline on both sides of its centre.
    expect(panels).toHaveLength(2);
    expect(host.querySelectorAll("line.gl-prop-split-median")).toHaveLength(0);
    const three = fixture({ ...METADATA, F5: { condition: "other", donor: "D2" } });
    const { panel } = draw(three, "splitViolin");
    expect(panel("CD4 SP").querySelectorAll("path.gl-prop-mark")).toHaveLength(3);
    expect(host.querySelectorAll("line.gl-prop-split-median")).toHaveLength(0);
  });

  it("puts each unit's replicate mark over its own half", () => {
    const fx = fixture();
    const { panel } = draw(fx, "splitViolin", { replicates: fx.replicates });
    const centre = Number(panel("CD4 SP").querySelector("line.gl-prop-split-median")!.getAttribute("x1"));
    const circles = [...panel("CD4 SP").querySelectorAll("circle.gl-prop-replicate")];
    expect(circles).toHaveLength(4);
    for (const circle of circles) {
      const cx = Number(circle.getAttribute("cx"));
      const files = circle.querySelector("title")!.textContent!;
      if (files.includes("F4.fcs") || files.includes("F5.fcs")) expect(cx).toBeGreaterThan(centre);
      else expect(cx).toBeLessThan(centre);
    }
  });
});

describe("Per-cell chart: ridgelines", () => {
  it("keeps every row within the plot, the first row's ridge reaching its top and the last baseline at its bottom", () => {
    for (let rows = 1; rows <= 12; rows++) {
      const { ridgeHeight, baselines } = ridgelineRows(rows, 30, 200);
      expect(baselines).toHaveLength(rows);
      expect(baselines[0] - ridgeHeight).toBeCloseTo(30, 9);
      expect(baselines[rows - 1]).toBeCloseTo(230, 9);
      for (let r = 1; r < rows; r++) expect(baselines[r]).toBeGreaterThan(baselines[r - 1]);
      // Rows overlap as the Illustration's do: each a third of a ridge's height apart.
      if (rows > 1) expect(baselines[1] - baselines[0]).toBeCloseTo(ridgeHeight * 0.3, 9);
    }
  });

  it("draws a row per group, top to bottom in the chart's order, within the plot, along a horizontal value axis", () => {
    const fx = fixture();
    const { panel } = draw(fx, "ridgeline");
    const svg = panel("CD4 SP");
    const layout = cellChartLayout("ridgeline", ["control", "treated"], [], FONTS, HEIGHT, 6, 0, [], false);
    const { top, left } = layout.margin;
    const right = layout.width - layout.margin.right;
    const bottom = top + HEIGHT;
    const ridges = [...svg.querySelectorAll("path.gl-prop-mark")];
    expect(ridges).toHaveLength(2);
    expect(ridges.map((path) => path.querySelector("title")!.textContent!.split(":")[0])).toEqual(["CD4 SP · control", "CD4 SP · treated"]);
    const [control, treated] = ridges.map((path) => points(path.getAttribute("d")!));
    for (const ridge of [control, treated])
      for (const [x, y] of ridge) {
        expect(x).toBeGreaterThanOrEqual(left - 1e-6);
        expect(x).toBeLessThanOrEqual(right + 1e-6);
        expect(y).toBeGreaterThanOrEqual(top - 1e-6);
        expect(y).toBeLessThanOrEqual(bottom + 1e-6);
      }
    // The first row sits above the second; the treated cells lie further along the axis.
    const { baselines } = ridgelineRows(2, top, HEIGHT);
    expect(control[0][1]).toBeCloseTo(baselines[0], 2);
    expect(treated[0][1]).toBeCloseTo(baselines[1], 2);
    expect(Math.min(...treated.map(([x]) => x))).toBeGreaterThan(Math.max(...control.map(([x]) => x)));
    // The value axis's labels under the plot, left to right, and the channel's name under them.
    const labels = [...svg.querySelectorAll("text")].filter((text) => fx.axis.major.some((tick) => tick.label === text.textContent));
    expect(labels.length).toBeGreaterThan(1);
    expect(labels.every((text) => Number(text.getAttribute("y")) > bottom)).toBe(true);
    const xs = labels.map((text) => Number(text.getAttribute("x")));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    const title = [...svg.querySelectorAll("text")].find((text) => text.textContent === fx.model.channelLabel)!;
    expect(Number(title.getAttribute("y"))).toBeGreaterThan(Number(labels[0].getAttribute("y")));
    expect(title.getAttribute("transform")).toBeNull();
    // Each row's label in the left margin, at its baseline.
    const rowLabels = [...svg.querySelectorAll("text")].filter((text) => text.getAttribute("text-anchor") === "end");
    expect(rowLabels.map((text) => text.querySelector("title")?.textContent)).toEqual(["control", "treated"]);
    expect(rowLabels.every((text) => Number(text.getAttribute("x")) < left)).toBe(true);
  });

  it("writes each row's n beside it, puts each unit's mark on its row, and cuts the ridges at typed limits", () => {
    const fx = fixture();
    const plain = Number(draw(fx, "ridgeline").panel("CD4 SP").getAttribute("width"));
    const { panel } = draw(fx, "ridgeline", { showN: true, replicates: fx.replicates });
    const svg = panel("CD4 SP");
    expect(Number(svg.getAttribute("width"))).toBeGreaterThan(plain);
    const n = [...svg.querySelectorAll("text.gl-prop-n")].map((text) => text.textContent);
    expect(n).toEqual(["n = 6 (3 files, 2 donor)", "n = 5 (2 files, 2 donor)"]);
    const ridges = [...svg.querySelectorAll("path.gl-prop-mark")].map((path) => points(path.getAttribute("d")!));
    const circles = [...svg.querySelectorAll("circle.gl-prop-replicate")];
    expect(circles).toHaveLength(4);
    for (const circle of circles) {
      const row = /F4\.fcs|F5\.fcs/.test(circle.querySelector("title")!.textContent!) ? 1 : 0;
      expect(Number(circle.getAttribute("cy"))).toBeCloseTo(ridges[row][0][1], 2);
    }
    // Typed limits: the marks are clipped at the plot's edges.
    const limited = cellChartAxis(fx.model, "fit", undefined, { min: 100, max: 350 })!;
    draw(fx, "ridgeline", { axis: limited });
    expect(host.querySelectorAll("clipPath")).toHaveLength(2);
    expect(host.querySelector("g.gl-prop-plot-clip path.gl-prop-mark")).not.toBeNull();
  });
});
