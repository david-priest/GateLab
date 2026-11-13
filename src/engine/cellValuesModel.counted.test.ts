// The Plotting tab's per-cell chart against the gate list, on a quadrant and rectangles drawn
// around known events. Synthetic files F1 to F3, conditions control and treated; nothing here is
// a real experiment.

import { describe, expect, it } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation } from "./models";
import { ChannelScales } from "./channelScales";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { BASE_PROPORTIONS_SETTINGS, normalizeProportionsSettings, type ProportionsSettings } from "./proportionsSettings";
import type { ProportionsSampleRef } from "./proportionsModel";
import { computePopulationStats, type StatType } from "./stats";
import {
  buildCellValuesModel,
  cellBoxStats,
  cellStatistic,
  cellValueAxis,
  linearTicks,
  measuredMedian,
  silvermanBandwidth,
  sortedQuantile,
  violinOutline,
} from "./cellValuesModel";

// Each event is [FITC-A, PE-A, FSC-A]. The quadrant's centre is at FITC 1000, PE 1000, so
// 100 is low and 5000 high on either axis. FSC is the value each violin draws.
type Event = [number, number, number];
const LOW = 100;
const HIGH = 5000;

function file(id: string, events: Event[], withFsc = true): ProportionsSampleRef {
  const channels = [
    { index: 0, name: "FITC-A", marker: "CD4", bits: 32, range: 262144 },
    { index: 1, name: "PE-A", marker: "CD8", bits: 32, range: 262144 },
    ...(withFsc ? [{ index: 2, name: "FSC-A", marker: null, bits: 32, range: 262144 }] : []),
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

// F1 (control): CD8 SP FSC 10, 20, 30; DP 40; CD4 SP 50, 60, 70, 80; DN none.
// F2 (treated): CD8 SP 15; DP none; CD4 SP 55, 65; DN 90, 100.
// F3 (treated): CD8 SP 25, 35; CD4 SP 75.
const F1 = file("F1", [
  [LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30],
  [HIGH, HIGH, 40],
  [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80],
]);
const F2 = file("F2", [
  [LOW, HIGH, 15],
  [HIGH, LOW, 55], [HIGH, LOW, 65],
  [LOW, LOW, 90], [LOW, LOW, 100],
]);
const F3 = file("F3", [[LOW, HIGH, 25], [LOW, HIGH, 35], [HIGH, LOW, 75]]);
const FILES = [F1, F2, F3];
const METADATA = { F1: { condition: "control" }, F2: { condition: "treated" }, F3: { condition: "treated" } };

/** A tree with one quadrant under the root, made as the Gating tab makes it. */
function quadrantTree() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 8 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "CD4", yChannel: "CD8",
    center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["CD8 SP", "DP", "CD4 SP", "DN"],
  });
  const gate = Object.values(state.gates).find((g) => g.gate_type === "quadrant")!;
  const quadrants = [1, 2, 3, 4].map((q) =>
    Object.values(state.populations).find((p) => p.gate_refs.some((r) => r.gate_id === gate.gate_id && r.quadrant === q))!.population_id,
  );
  return { state: state as CoreState, quadrants };
}

function settings(over: Partial<ProportionsSettings>): ProportionsSettings {
  return normalizeProportionsSettings({ ...BASE_PROPORTIONS_SETTINGS, valueKind: "cells", plotType: "violin", channel: "FSC-A", ...over });
}

/** The gate list's count of a population in a file. */
function counted(state: CoreState, entry: ProportionsSampleRef, popId: string): number {
  return recompute(entry.sample, state).populations[popId].event_count ?? 0;
}

describe("Per-cell values against the gate list", () => {
  it("draws each quadrant's cells in each file, as many as the gate list counts", () => {
    const fx = quadrantTree();
    const s = settings({ files: FILES.map((f) => f.id), hierarchy: fx.state.active_hierarchy_id, parent: fx.state.root_population_id!, selectedPops: fx.quadrants });
    const model = buildCellValuesModel(s, FILES, fx.state, METADATA);
    expect(model.catLevels).toEqual(["CD8 SP", "DP", "CD4 SP", "DN"]);
    expect(model.excluded).toEqual([]);
    expect(model.noChannel).toEqual([]);
    for (const entry of FILES) {
      fx.quadrants.forEach((popId, cat) => {
        const violin = model.violins.find((v) => v.cat === cat && v.group === entry.name)!;
        expect(violin.values.length).toBe(counted(fx.state, entry, popId));
      });
    }
    // The counts the fixture's comment gives, so a change to it cannot pass unnoticed.
    expect(FILES.map((entry) => fx.quadrants.map((popId) => counted(fx.state, entry, popId)))).toEqual([
      [3, 1, 4, 0],
      [1, 0, 2, 2],
      [2, 0, 1, 0],
    ]);
    // The cells themselves, ascending, on FSC's display scale (linear by default).
    const f1Cd4 = model.violins.find((v) => v.cat === 2 && v.group === "F1.fcs")!;
    expect([...f1Cd4.values]).toEqual([50, 60, 70, 80]);
    expect(measuredMedian(f1Cd4.values, (v) => F1.sample.displayToRaw("FSC-A", v))).toBe(65);
    expect(model.extent).toEqual([10, 100]);
    expect(model.channelLabel).toBe("FSC-A");
  });

  it("pools a group's files, and keeps facets apart", () => {
    const fx = quadrantTree();
    const s = settings({ files: FILES.map((f) => f.id), hierarchy: fx.state.active_hierarchy_id, parent: fx.state.root_population_id!, selectedPops: fx.quadrants, groupSel: "condition" });
    const model = buildCellValuesModel(s, FILES, fx.state, METADATA);
    const treatedCd8 = model.violins.find((v) => v.cat === 0 && v.group === "treated")!;
    expect([...treatedCd8.values]).toEqual([15, 25, 35]);
    expect(treatedCd8.files).toEqual(["F2.fcs", "F3.fcs"]);
    expect(treatedCd8.values.length).toBe(counted(fx.state, F2, fx.quadrants[0]) + counted(fx.state, F3, fx.quadrants[0]));
    const faceted = buildCellValuesModel({ ...s, facetSel: "__sample__" }, FILES, fx.state, METADATA);
    expect(faceted.hasFacet).toBe(true);
    expect(faceted.violins.filter((v) => v.cat === 0 && v.group === "treated").map((v) => [v.facet, v.values.length])).toEqual([
      ["F2.fcs", 1],
      ["F3.fcs", 2],
    ]);
  });

  it("counts a population's cells within the parent, and only those", () => {
    // A rectangle on FSC from 45 holds F1's CD4 SP cells and DP's 40 is outside it; a child of
    // CD4 SP takes the rectangle, so its cells are CD4 SP's from FSC 45.
    const fx = quadrantTree();
    const gate = { ...newGate("Large", "rectangle", "FSC-A", "CD8", [[45, 0], [1000, 262144]]), space: "raw" as const };
    const cd4 = fx.quadrants[2];
    const large = newPopulation("Large", [newGateRef(gate.gate_id)], cd4);
    const state: CoreState = {
      ...fx.state,
      gates: { ...fx.state.gates, [gate.gate_id]: gate },
      gate_order: [...fx.state.gate_order, gate.gate_id],
      populations: { ...fx.state.populations, [cd4]: { ...fx.state.populations[cd4], children: [large.population_id] }, [large.population_id]: large },
    };
    const s = settings({ files: ["F1", "F2"], hierarchy: state.active_hierarchy_id, parent: cd4, selectedPops: [large.population_id] });
    const model = buildCellValuesModel(s, FILES, state, METADATA);
    expect(model.catLevels).toEqual(["Large"]);
    expect(model.violins.map((v) => [v.group, [...v.values]])).toEqual([
      ["F1.fcs", [50, 60, 70, 80]],
      ["F2.fcs", [55, 65]],
    ]);
    expect(model.violins.map((v) => v.values.length)).toEqual([counted(state, F1, large.population_id), counted(state, F2, large.population_id)]);
  });

  it("names a file without the channel and draws the rest", () => {
    const fx = quadrantTree();
    const bare = file("F4", [[LOW, HIGH, 0]], false);
    const s = settings({ files: ["F1", "F4"], hierarchy: fx.state.active_hierarchy_id, parent: fx.state.root_population_id!, selectedPops: fx.quadrants });
    const model = buildCellValuesModel(s, [F1, bare], fx.state, METADATA);
    expect(model.noChannel).toEqual(["F4.fcs"]);
    expect(model.violins.every((v) => v.group === "F1.fcs")).toBe(true);
  });

  it("draws nothing without a channel or a population", () => {
    const fx = quadrantTree();
    const base = { files: ["F1"], hierarchy: fx.state.active_hierarchy_id, parent: fx.state.root_population_id! };
    expect(buildCellValuesModel(settings({ ...base, selectedPops: fx.quadrants, channel: "" }), FILES, fx.state, METADATA).violins).toEqual([]);
    expect(buildCellValuesModel(settings({ ...base, selectedPops: [] }), FILES, fx.state, METADATA).violins).toEqual([]);
  });
});

describe("Per-cell summaries", () => {
  it("gives R's type-7 quartiles and Tukey's whiskers", () => {
    const sorted = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]);
    expect(sortedQuantile(sorted, 0.25)).toBeCloseTo(3.25, 10);
    expect(sortedQuantile(sorted, 0.5)).toBeCloseTo(5.5, 10);
    expect(sortedQuantile(sorted, 0.75)).toBeCloseTo(7.75, 10);
    const box = cellBoxStats(sorted);
    // Fences 3.25 - 6.75 and 7.75 + 6.75: 100 lies beyond the upper one.
    expect(box.lo).toBe(1);
    expect(box.hi).toBe(9);
    expect(box.max).toBe(100);
  });

  it("takes an even count's median as the mean of the middle two measured values", () => {
    const sorted = Float32Array.from([1, 2, 3, 4]);
    expect(measuredMedian(sorted, (v) => v * v)).toBe((4 + 9) / 2);
    expect(measuredMedian(Float32Array.from([1, 2, 3]), (v) => v * v)).toBe(4);
  });

  it("outlines a violin from the lowest cell to the highest, widest at the mode", () => {
    const values = Float32Array.from([...Array.from({ length: 200 }, () => 5), 1, 2, 8, 9]).sort();
    const { at, width } = violinOutline(values, 33);
    expect(at[0]).toBe(1);
    expect(at[at.length - 1]).toBe(9);
    expect(Math.max(...width)).toBe(1);
    const peak = at[width.indexOf(1)];
    expect(Math.abs(peak - 5)).toBeLessThan(0.3);
  });

  it("resolves a violin's body when one cell lies far from the rest, and still reaches it", () => {
    // F5: 1,000 CD4 SP cells with FSC 0 to 1 (900 spread evenly, 100 between 0.47 and 0.53) and one
    // at FSC 1,000,000. On a linear axis the body is a millionth of the range.
    const body = [...Array.from({ length: 900 }, (_, i) => (i + 0.5) / 900), ...Array.from({ length: 100 }, (_, i) => 0.47 + (i + 0.5) / 1667)];
    const F5 = file("F5", [...body.map((fsc): Event => [HIGH, LOW, fsc]), [HIGH, LOW, 1e6]]);
    const fx = quadrantTree();
    const s = settings({ files: ["F5"], hierarchy: fx.state.active_hierarchy_id, parent: fx.state.root_population_id!, selectedPops: [fx.quadrants[2]] });
    const model = buildCellValuesModel(s, [F5], fx.state, {});
    const violin = model.violins[0];
    expect(violin.values.length).toBe(counted(fx.state, F5, fx.quadrants[2]));
    expect(violin.values.length).toBe(1001);
    const { at, width } = violinOutline(violin.values);
    const box = cellBoxStats(violin.values);
    expect(at[0]).toBe(violin.values[0]);
    expect(at[at.length - 1]).toBe(1e6);
    expect(at.length).toBeLessThanOrEqual(150);
    // Positions ascend, at least 40 lie within the quartiles, and the widest is among them, at the
    // dense middle.
    expect(at.every((x, i) => i === 0 || x > at[i - 1])).toBe(true);
    const inside = at.filter((x) => x >= box.q1 && x <= box.q3);
    expect(inside.length).toBeGreaterThanOrEqual(40);
    const peak = at[width.indexOf(1)];
    expect(peak).toBeGreaterThanOrEqual(box.q1);
    expect(peak).toBeLessThanOrEqual(box.q3);
    expect(Math.abs(peak - 0.5)).toBeLessThan(0.05);
  });

  it("outlines a sample without outlying cells as before", () => {
    // The outline as it was computed before the body was resolved apart: 96 even positions over
    // the range, the cells binned in 512, each position summed over bins within four bandwidths.
    const previous = (sorted: Float32Array, points = 96) => {
      const n = sorted.length;
      const lo = sorted[0];
      const hi = sorted[n - 1];
      const bins = 512;
      const step = (hi - lo) / bins;
      const counts = new Float64Array(bins);
      for (let i = 0; i < n; i++) counts[Math.min(bins - 1, Math.floor((sorted[i] - lo) / step))]++;
      const bw = silvermanBandwidth(sorted);
      const reach = Math.ceil((4 * bw) / step);
      const at: number[] = [];
      const width: number[] = [];
      for (let p = 0; p < points; p++) {
        const x = lo + ((hi - lo) * p) / (points - 1);
        const centre = Math.floor((x - lo) / step);
        let density = 0;
        for (let b = Math.max(0, centre - reach); b <= Math.min(bins - 1, centre + reach); b++) {
          const z = (lo + (b + 0.5) * step - x) / bw;
          density += counts[b] * Math.exp(-0.5 * z * z);
        }
        at.push(x);
        width.push(density);
      }
      const peak = Math.max(...width);
      return { at, width: width.map((d) => d / peak) };
    };
    // A two-humped sample with no cell beyond Tukey's fences.
    const values = Float32Array.from(Array.from({ length: 2000 }, (_, i) => {
      const u = (i + 0.5) / 2000;
      return u < 0.6 ? 20 + 10 * Math.sin((u / 0.6) * Math.PI - Math.PI / 2) : 60 + 8 * Math.sin(((u - 0.6) / 0.4) * Math.PI - Math.PI / 2);
    })).sort();
    const box = cellBoxStats(values);
    expect(box.lo).toBe(box.min);
    expect(box.hi).toBe(box.max);
    const now = violinOutline(values);
    const before = previous(values);
    expect(now.at).toEqual(before.at);
    for (let i = 0; i < now.width.length; i++) expect(Math.abs(now.width[i] - before.width[i])).toBeLessThan(1e-3);
  });

  it("frames the axis on the Gating tab's range when asked, else on the cells", () => {
    const model = { extent: [10, 110] as [number, number], axisSource: { sample: F1.sample, index: 2 } };
    expect(cellValueAxis(model, "gating", [0, 262144])!.range).toEqual([0, 262144]);
    expect(cellValueAxis(model, "fit", [0, 262144])!.range).toEqual([6, 114]);
    expect(cellValueAxis(model, "gating", undefined)!.range).toEqual([6, 114]);
    expect(linearTicks(0, 100)).toEqual([0, 20, 40, 60, 80, 100]);
  });
});

describe("Per-unit statistics against the Statistics tab", () => {
  it("gives each file's median, mean and geometric mean of a quadrant as the Statistics tab does", () => {
    const fx = quadrantTree();
    const s = settings({ valueKind: "statistic", plotType: "box", files: FILES.map((f) => f.id), hierarchy: fx.state.active_hierarchy_id, parent: fx.state.root_population_id!, selectedPops: fx.quadrants, groupSel: "condition" });
    const model = buildCellValuesModel(s, FILES, fx.state, METADATA, { poolBy: "unit", values: "raw" });
    for (const entry of FILES) {
      const derived = recompute(entry.sample, fx.state);
      const eventCount = Object.fromEntries(Object.entries(derived.populations).map(([id, pop]) => [id, pop.event_count]));
      const stats = computePopulationStats(entry.sample, fx.state.populations, fx.state.root_population_id!, derived.masks, eventCount, ["FSC-A"], ["count", "median", "mean", "geomean"] as StatType[], "raw");
      fx.quadrants.forEach((popId, cat) => {
        const row = stats.rows.find((r) => r.popId === popId)!;
        const unit = model.violins.find((v) => v.cat === cat && v.unit === entry.id)!;
        expect(unit.values.length).toBe(row.cells.count);
        for (const [statistic, column] of [["median", "FSC-A::Median"], ["mean", "FSC-A::Mean"], ["geomean", "FSC-A::GeoMean"]] as const) {
          const expected = row.cells[column];
          const value = cellStatistic(unit.values, statistic);
          if (expected === null) expect(value).toBeNaN();
          else expect(value).toBeCloseTo(expected, 9);
        }
      });
    }
  });

  it("pools a replicate unit's files within a group, and keeps its files in other groups apart", () => {
    const fx = quadrantTree();
    // F2 and F3 are one donor, treated; F1 the same donor, control.
    const metadata = { F1: { condition: "control", donor: "D1" }, F2: { condition: "treated", donor: "D1" }, F3: { condition: "treated", donor: "D1" } };
    const s = settings({ valueKind: "statistic", plotType: "box", files: FILES.map((f) => f.id), hierarchy: fx.state.active_hierarchy_id, parent: fx.state.root_population_id!, selectedPops: fx.quadrants, groupSel: "condition", unitSel: "donor" });
    const model = buildCellValuesModel(s, FILES, fx.state, metadata, { poolBy: "unit", values: "raw" });
    const cd8 = model.violins.filter((v) => v.cat === 0).map((v) => [v.group, v.unit, [...v.values]]);
    expect(cd8).toEqual([
      ["control", "D1", [10, 20, 30]],
      ["treated", "D1", [15, 25, 35]],
    ]);
    expect(cellStatistic(Float32Array.from([15, 25, 35]), "median")).toBe(25);
  });

  it("takes a geometric mean of the positive values only, and NaN with none", () => {
    expect(cellStatistic(Float32Array.from([-5, 0, 2, 8]), "geomean")).toBeCloseTo(4, 12);
    expect(cellStatistic(Float32Array.from([-5, 0]), "geomean")).toBeNaN();
    expect(cellStatistic(Float32Array.from([]), "median")).toBeNaN();
  });
});

describe("Per-cell values pooled from files on different display scales", () => {
  // Two flow files in one workspace, F5 on its original layer and F6 compensated. The workspace's
  // auto logicle W and T are estimated per assay layer (ChannelScales), so the same channel can be
  // displayed under a different transform in each file; FITC-A's negative tails differ to make the
  // two estimates differ. A rectangle on FSC-A holds the cells with FSC up to 3000: 222 of each file's 512.
  function scaledFile(id: string, negativeTail: number, compensated: boolean): ProportionsSampleRef {
    const n = 512;
    const names = ["FITC-A", "PE-A", "FSC-A"];
    const fcs: FcsFile = {
      version: "FCS3.1",
      nEvents: n,
      instrument: "flow",
      keywords: {},
      spillover: compensated ? { channels: ["FITC-A", "PE-A"], matrix: [[1, 0.1], [0.05, 1]] } : null,
      channels: names.map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
      columns: names.map((_, c) =>
        Float32Array.from({ length: n }, (_, i) =>
          c === 2 ? 1000 + ((i * 31) % 5000) : i < n / 4 ? -negativeTail * (1 + (i % 7)) : 500 * (1 + ((i + c) % 90)))),
    };
    return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
  }

  it("draws every file's cells on the axis file's scale, as many as the gate list counts", () => {
    const f5 = scaledFile("F5", 50, false);
    const f6 = scaledFile("F6", 4000, true);
    const scales = new ChannelScales();
    f5.sample.attachChannelScales(scales);
    f6.sample.attachChannelScales(scales);
    f6.sample.setCompensation(true);
    expect(f6.sample.activeLayer).toBe("compensated");
    // The premise: one channel, two display transforms in one workspace.
    expect(f5.sample.transformSpec("FITC-A")).not.toEqual(f6.sample.transformSpec("FITC-A"));

    const state = initialCoreState();
    const root = newRootPopulation();
    const gate = { ...newGate("Small", "rectangle", "FSC-A", "PE-A", [[0, -1e6], [3000, 1e6]]), space: "raw" as const };
    const small = newPopulation("Small", [newGateRef(gate.gate_id)], root.population_id);
    root.children = [small.population_id];
    Object.assign(state, {
      gates: { [gate.gate_id]: gate },
      gate_order: [gate.gate_id],
      populations: { [root.population_id]: root, [small.population_id]: small },
      root_population_id: root.population_id,
      active_population_id: root.population_id,
    });
    const core = state as CoreState;
    const s = settings({ channel: "FITC-A", files: ["F5", "F6"], hierarchy: core.active_hierarchy_id, parent: root.population_id, selectedPops: [small.population_id], groupSel: "condition" });
    const model = buildCellValuesModel(s, [f5, f6], core, { F5: { condition: "control" }, F6: { condition: "control" } });
    const violin = model.violins[0];
    expect(model.violins).toHaveLength(1);
    expect(violin.files).toEqual(["F5.fcs", "F6.fcs"]);
    const n5 = counted(core, f5, small.population_id);
    const n6 = counted(core, f6, small.population_id);
    expect([n5, n6]).toEqual([222, 222]);
    expect(violin.values.length).toBe(n5 + n6);

    // The axis reads every value back through the first file's transform, so every file's
    // measured values are put on that transform: F6's compensated values included.
    expect(model.axisSource!.sample).toBe(f5.sample);
    const measured = (entry: ProportionsSampleRef) => {
      const mask = recompute(entry.sample, core).masks[small.population_id]!;
      const column = entry.sample.rawColumnData(entry.sample.index("FITC-A")!);
      return Array.from(column).filter((_, e) => mask[e]);
    };
    const expected = Float32Array.from([...measured(f5), ...measured(f6)].map((v) => f5.sample.rawToDisplay("FITC-A", v))).sort();
    expect(violin.values.length).toBe(expected.length);
    violin.values.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 4));
    const toMeasured = (v: number) => f5.sample.displayToRaw("FITC-A", v);
    const all = [...measured(f5), ...measured(f6)].sort((a, b) => a - b);
    expect(measuredMedian(violin.values, toMeasured)).toBeCloseTo((all[n5 + n6 - 1 >> 1] + all[(n5 + n6) >> 1]) / 2, 1);
  });
});
