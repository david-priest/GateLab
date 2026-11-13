// One gate's summaries through the three paths that show them: the Statistics tab
// (computePopulationStats), the per-cell chart (cellStatistic, cellBoxStats) and the Layout chart
// (summarise). A synthetic file D1; a rectangle drawn on CD4 holds four of its seven events, with
// FSC 10, 20, 40 and 80. Nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { newGate, newGateRef, newPopulation } from "./models";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { BASE_PROPORTIONS_SETTINGS, normalizeProportionsSettings } from "./proportionsSettings";
import type { ProportionsSampleRef } from "./proportionsModel";
import { computePopulationStats, type StatType } from "./stats";
import { buildCellValuesModel, cellBoxStats, cellStatistic } from "./cellValuesModel";
import { summarise } from "./layoutChart";

// Each event is [FITC-A (CD4), FSC-A]. The rectangle takes CD4 from 1000 up.
const EVENTS: [number, number][] = [
  [5000, 10], [5000, 20], [5000, 40], [5000, 80],
  [100, 15], [100, 30], [100, 1000],
];

function d1(): ProportionsSampleRef {
  const channels = [
    { index: 0, name: "FITC-A", marker: "CD4", bits: 32, range: 262144 },
    { index: 1, name: "FSC-A", marker: null, bits: 32, range: 262144 },
  ];
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: EVENTS.length,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels,
    columns: channels.map((_, c) => Float32Array.from(EVENTS.map((event) => event[c]))),
  };
  return { id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
}

/** The root and a rectangle on CD4 × FSC under it. */
function rectangleTree(): { state: CoreState; popId: string } {
  const base = coreReducer(initialCoreState(), { type: "loadSample", nEvents: EVENTS.length }) as CoreState;
  const root = base.root_population_id!;
  const gate = { ...newGate("CD4_positive", "rectangle", "CD4", "FSC-A", [[1000, 0], [262144, 262144]]), space: "raw" as const };
  const pop = newPopulation("CD4_positive", [newGateRef(gate.gate_id)], root);
  const state: CoreState = {
    ...base,
    gates: { ...base.gates, [gate.gate_id]: gate },
    gate_order: [...base.gate_order, gate.gate_id],
    populations: { ...base.populations, [root]: { ...base.populations[root], children: [...base.populations[root].children, pop.population_id] }, [pop.population_id]: pop },
  };
  return { state, popId: pop.population_id };
}

// By hand, for FSC 10, 20, 40, 80.
const MEDIAN = 30; // (20 + 40) / 2, and type 7 at 0.5: 20 + (40 - 20) × 0.5
const MEAN = 37.5;
const GEOMEAN = Math.pow(10 * 20 * 40 * 80, 1 / 4); // 640000^(1/4) = 28.2842712...
const SD = Math.sqrt((27.5 ** 2 + 17.5 ** 2 + 2.5 ** 2 + 42.5 ** 2) / 3); // sqrt(2875 / 3) = 30.957...
const Q1 = 17.5; // h = 0.75: 10 + (20 - 10) × 0.75
const Q3 = 50; // h = 2.25: 40 + (80 - 40) × 0.25

describe("A gate's summaries through the Statistics tab, the per-cell chart and the Layout chart", () => {
  it("counts the gate, and gives the same median, mean, geometric mean, SD and quartiles on each path", () => {
    const entry = d1();
    const { state, popId } = rectangleTree();
    const derived = recompute(entry.sample, state);
    expect(derived.populations[popId].event_count).toBe(4);

    // The Statistics tab.
    const eventCount = Object.fromEntries(Object.entries(derived.populations).map(([id, pop]) => [id, pop.event_count]));
    const table = computePopulationStats(entry.sample, state.populations, state.root_population_id!, derived.masks, eventCount, ["FSC-A"], ["count", "median", "mean", "geomean", "sd"] as StatType[], "raw");
    const row = table.rows.find((r) => r.popId === popId)!;
    expect(row.cells.count).toBe(4);
    expect(row.cells["FSC-A::Median"]).toBe(MEDIAN);
    expect(row.cells["FSC-A::Mean"]).toBe(MEAN);
    expect(row.cells["FSC-A::GeoMean"]).toBeCloseTo(GEOMEAN, 12);
    expect(row.cells["FSC-A::SD"]).toBeCloseTo(SD, 12);

    // The per-cell chart: the gate's cells, as many as counted, and their statistics.
    const settings = normalizeProportionsSettings({
      ...BASE_PROPORTIONS_SETTINGS, valueKind: "statistic", plotType: "box", channel: "FSC-A",
      files: ["D1"], hierarchy: state.active_hierarchy_id, parent: state.root_population_id!, selectedPops: [popId],
    });
    const model = buildCellValuesModel(settings, [entry], state, { D1: {} }, { poolBy: "unit", values: "raw" });
    const cells = model.violins.find((v) => v.unit === "D1")!.values;
    expect([...cells]).toEqual([10, 20, 40, 80]);
    expect(cellStatistic(cells, "median")).toBe(row.cells["FSC-A::Median"]);
    expect(cellStatistic(cells, "mean")).toBe(row.cells["FSC-A::Mean"]);
    expect(cellStatistic(cells, "geomean")).toBe(row.cells["FSC-A::GeoMean"]);
    const box = cellBoxStats(cells);
    expect([box.q1, box.median, box.q3, box.lo, box.hi]).toEqual([Q1, MEDIAN, Q3, 10, 80]);

    // The Layout chart's summary of the same values.
    const group = summarise("control", [...cells].map((value, i) => ({ sampleId: `D1-${i}`, name: "D1.fcs", group: "control", value })));
    expect(group.n).toBe(4);
    expect(group.mean).toBe(row.cells["FSC-A::Mean"]);
    expect(group.sd).toBe(row.cells["FSC-A::SD"]);
    expect([group.q1, group.median, group.q3]).toEqual([box.q1, box.median, box.q3]);
    expect([group.min, group.max]).toEqual([10, 80]);
  });
});
