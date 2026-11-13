// @vitest-environment jsdom
// A per-cell chart's replicate marks (SuperPlot), against a gate drawn and counted: each unit's
// median or mean is the statistic chart's value for the unit, placed through the axis's transform;
// the rank test is run on the units' values, never on the cells; the n, the tooltips and the
// chart's table name the units. Synthetic files F1 to F5, donors D1 and D2, groups control and
// treated; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { BASE_PROPORTIONS_SETTINGS, type ProportionsSettings } from "../engine/proportionsSettings";
import type { ProportionsSampleRef } from "../engine/proportionsModel";
import { buildCellValuesModel, cellValueAxis } from "../engine/cellValuesModel";
import { summarise, testGroups } from "../engine/layoutChart";
import { CellValuesChart, type CellReplicates } from "./CellValuesChart";
import { statisticChartFrame } from "./StatisticChart";
import { formatMeasured } from "./chart/chartFormat";
import { cellsDataTable } from "./plottingData";
import { clearPersistedTabState, readProportionsSettings, restorePlottingState } from "./tabState";
import { LayoutProportionsSurface, plottingBlockSizer } from "./LayoutProportions";
import { createLayoutSheet } from "../engine/layout";

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

// Each event is [FITC-A (CD4), PE-A (CD8), FSC-A]; the quadrant's centre is at 1000, 1000.
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
    version: "FCS3.1", nEvents: events.length, instrument: "flow", keywords: {}, spillover: null, channels,
    columns: channels.map((_, c) => Float32Array.from(events.map((event) => event[c]))),
  };
  return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
}
const cd4 = (fsc: number): Event => [HIGH, LOW, fsc];
const cd8 = (fsc: number): Event => [LOW, HIGH, fsc];
// CD4 SP forward scatter by donor and group: D1 control 50, 60, 70, 100 (median 65, mean 70);
// D2 control 200, 220; D1 treated 300, 320, 340; D2 treated 400, 410. The groups' cells do not
// overlap, so a test on the cells would give a far smaller p than one on two units a group.
const FILES = [
  file("F1", [cd4(50), cd4(60), cd4(70), cd8(30)]),
  file("F2", [cd4(100), cd8(35)]),
  file("F3", [cd4(200), cd4(220), cd8(40)]),
  file("F4", [cd4(300), cd4(320), cd4(340), cd8(45)]),
  file("F5", [cd4(400), cd4(410), cd8(50)]),
];
const METADATA = {
  F1: { condition: "control", donor: "D1" },
  F2: { condition: "control", donor: "D1" },
  F3: { condition: "control", donor: "D2" },
  F4: { condition: "treated", donor: "D1" },
  F5: { condition: "treated", donor: "D2" },
};

function fixture(statistic: "median" | "mean" = "median") {
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
    valueKind: "cells", plotType: "violin", channel: "FSC-A", files: FILES.map((f) => f.id),
    hierarchy: core.active_hierarchy_id, parent: core.root_population_id!, selectedPops: [quadrants[0], quadrants[2]],
    groupSel: "condition", unitSel: "donor", xAxis: "groups", test: true, replicateMarks: statistic,
  };
  const model = buildCellValuesModel(settings, FILES, core, METADATA);
  const unitModel = buildCellValuesModel(settings, FILES, core, METADATA, { poolBy: "unit", values: "raw" });
  // The chart's cells on linear values, as the tab's table takes them.
  const rawModel = buildCellValuesModel(settings, FILES, core, METADATA, { values: "raw" });
  const axis = cellValueAxis(model, "fit", undefined)!;
  const replicates: CellReplicates = { unitModel, statistic, unitSel: "donor", test: true };
  return { state: core, quadrants, settings, model, unitModel, rawModel, axis, replicates };
}

const HEIGHT = 180;
const FONT = 9;
function draw(fx: ReturnType<typeof fixture>, replicates: CellReplicates | undefined) {
  act(() =>
    root.render(
      <CellValuesChart
        model={fx.model}
        plotType="violin"
        xAxis="groups"
        violinBox={false}
        showN
        axis={fx.axis}
        catColors={["#111", "#222"]}
        palette="paired"
        fonts={{ tick: FONT, axis: 10, legend: 11 }}
        appearance={{ height: HEIGHT, showGrid: true, showLegend: true }}
        groupTitle="condition"
        replicates={replicates}
      />,
    ),
  );
  const panel = [...host.querySelectorAll("svg.gl-prop-panel")].find((svg) => svg.querySelector("text title")?.textContent === "CD4 SP")!;
  return { panel, html: host.innerHTML };
}

describe("Per-cell chart: replicate marks", () => {
  it("draws each unit's median where the statistic chart's value lies on the axis, with the unit, files, cells and value in its tooltip", () => {
    const fx = fixture();
    const { panel } = draw(fx, fx.replicates);
    const frame = statisticChartFrame(fx.unitModel, { statistic: "median", errorBar: "sd", test: true, xAxis: "groups", unitSel: "donor", plotType: "box", panelWidth: 0, height: HEIGHT, fontTick: FONT, fontAxis: 10 });
    const expected = frame.points.filter((p) => p.cat === 1);
    expect(expected.map((p) => [p.group, p.unit, p.value, p.cells])).toEqual([
      ["control", "D1", 65, 4],
      ["treated", "D1", 320, 3],
      ["control", "D2", 210, 2],
      ["treated", "D2", 405, 2],
    ]);
    const circles = [...panel.querySelectorAll("circle.gl-prop-replicate")];
    expect(circles).toHaveLength(4);
    // The plot's top: the panel's margin and the line the test is written on.
    const top = 22 + FONT + 6;
    const [lo, hi] = fx.axis.range;
    const sample = fx.model.axisSource!.sample;
    const drawn = circles.map((c) => ({ cy: Number(c.getAttribute("cy")), title: c.querySelector("title")!.textContent }));
    for (const p of expected) {
      const at = drawn.find((d) => d.title!.startsWith(`${p.unit}: median ${formatMeasured(p.value)} `) && d.title!.includes(p.files.join(", ")))!;
      expect(at).toBeDefined();
      const display = sample.rawToDisplay("FSC-A", p.value);
      expect(at.cy).toBeCloseTo(top + HEIGHT * (1 - (display - lo) / (hi - lo)), 6);
    }
    expect(drawn.map((d) => d.title)).toContain("D1: median 65 of 4 cells from F1.fcs, F2.fcs");
  });

  it("takes the mean when asked", () => {
    const fx = fixture("mean");
    const { panel } = draw(fx, fx.replicates);
    const titles = [...panel.querySelectorAll("circle.gl-prop-replicate title")].map((t) => t.textContent);
    expect(titles).toContain("D1: mean 70 of 4 cells from F1.fcs, F2.fcs");
  });

  it("runs the rank test on the units' values, as the statistic chart does, never on the cells", () => {
    const fx = fixture();
    const { panel } = draw(fx, fx.replicates);
    const label = panel.querySelector(".gl-prop-test")!;
    const onUnits = testGroups([
      summarise("control", [65, 210].map((value) => ({ sampleId: "", name: "", group: "control", value }))),
      summarise("treated", [320, 405].map((value) => ({ sampleId: "", name: "", group: "treated", value }))),
    ])!;
    const cells = fx.model.violins.filter((v) => v.cat === 1);
    const onCells = testGroups(cells.map((v) => summarise(v.group, Array.from(v.values, (value) => ({ sampleId: "", name: "", group: v.group, value })))))!;
    expect(onUnits.label).not.toBe(onCells.label);
    expect(label.lastChild!.textContent).toBe(onUnits.label);
    expect(label.querySelector("title")!.textContent).toContain("per replicate unit");
    const frame = statisticChartFrame(fx.unitModel, { statistic: "median", errorBar: "sd", test: true, xAxis: "groups", unitSel: "donor", plotType: "box", panelWidth: 0, height: HEIGHT, fontTick: FONT, fontAxis: 10 });
    expect(frame.panels.find((p) => p.population === "CD4 SP")!.test!.label).toBe(onUnits.label);
  });

  it("writes the units beside the files in the n; none of it without the marks", () => {
    const fx = fixture();
    const on = draw(fx, fx.replicates);
    expect([...on.panel.querySelectorAll(".gl-prop-n")].map((t) => t.textContent)).toEqual(["n = 6", "(3 files, 2 donor)", "n = 5", "(2 files, 2 donor)"]);
    const off = draw(fx, undefined);
    expect(off.panel.querySelectorAll("circle.gl-prop-replicate")).toHaveLength(0);
    expect(off.panel.querySelector(".gl-prop-test")).toBeNull();
    expect([...off.panel.querySelectorAll(".gl-prop-n")].map((t) => t.textContent)).toEqual(["n = 6", "(3 files)", "n = 5", "(2 files)"]);
  });

  it("adds a row per unit to the chart's table, the columns before the units' as without them", () => {
    const fx = fixture();
    const titles = { group: "condition", unit: "donor" };
    const plain = cellsDataTable(fx.rawModel, fx.model, titles, "FSC-A", { xAxis: "groups" });
    const marked = cellsDataTable(fx.rawModel, fx.model, titles, "FSC-A", { xAxis: "groups" }, fx.replicates);
    expect(marked.header).toEqual([...plain.header, "donor", "Unit median FSC-A"]);
    const cd4Rows = marked.rows.filter((row) => row[1] === "CD4 SP");
    expect(cd4Rows.map((row) => [row[0], row[2], row[3], row[9], row[10]])).toEqual([
      ["control", "F1.fcs; F2.fcs; F3.fcs", 6, "", ""],
      ["control", "F1.fcs; F2.fcs", 4, "D1", "65"],
      ["control", "F3.fcs", 2, "D2", "210"],
      ["treated", "F4.fcs; F5.fcs", 5, "", ""],
      ["treated", "F4.fcs", 3, "D1", "320"],
      ["treated", "F5.fcs", 2, "D2", "405"],
    ]);
    // The pooled rows hold what they hold without the marks.
    expect(marked.rows.filter((row) => row[9] === "").map((row) => row.slice(0, 9))).toEqual(plain.rows);
  });

  it("draws the marks and the test on a Layout block, the whole chart or one panel, and sizes the block for the test's line", () => {
    const fx = fixture();
    const samples = FILES.map((f) => ({ ...f, fileName: f.name }));
    const surface = (settings: ProportionsSettings, panel: unknown, id: string) => (
      <LayoutProportionsSurface
        recipe={{ kind: "proportions", settings, panel: panel as never }}
        samples={samples as never}
        state={fx.state}
        metadataById={METADATA}
        divisionProfiles={{}}
        width={800}
        height={600}
        containerId={id}
      />
    );
    act(() => root.render(<>{surface(fx.settings, undefined, "whole")}{surface(fx.settings, { population: "CD4 SP", populationId: fx.quadrants[2] }, "one")}</>));
    expect(host.querySelectorAll("#whole circle.gl-prop-replicate")).toHaveLength(8);
    expect(host.querySelectorAll("#one svg.gl-prop-panel")).toHaveLength(1);
    expect([...host.querySelectorAll("#one circle.gl-prop-replicate title")].map((t) => t.textContent)).toContain("D1: median 65 of 4 cells from F1.fcs, F2.fcs");
    expect(host.querySelector("#one .gl-prop-test")!.lastChild!.textContent).toBe("Wilcoxon p = 0.33");

    const size = (settings: ProportionsSettings) => plottingBlockSizer(settings, FILES, fx.state, METADATA, {})!(createLayoutSheet());
    const plain = size({ ...fx.settings, replicateMarks: "none" });
    const marked = size(fx.settings);
    expect(marked.height).toBe(plain.height + FONT + 6);
  });

  it("is restored with the tab's saved state, and anything else is refused", () => {
    clearPersistedTabState();
    restorePlottingState({ "prop.replicateMarks": "mean" });
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS).replicateMarks).toBe("mean");
    clearPersistedTabState();
    restorePlottingState({ "prop.replicateMarks": "geomean" });
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS).replicateMarks).toBe("none");
    clearPersistedTabState();
  });
});

