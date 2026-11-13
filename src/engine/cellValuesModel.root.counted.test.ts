// The per-cell chart of the tree's root population against the gate list. A block sent from an
// Illustration chart panel on All Events drew the root's first child instead; these tests hold
// the root as a population of its own. Synthetic files D1 and D2; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation } from "./models";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { BASE_PROPORTIONS_SETTINGS, normalizeProportionsSettings, type ProportionsSettings } from "./proportionsSettings";
import { buildProportionsModel, type ProportionsSampleRef } from "./proportionsModel";
import { buildCellValuesModel } from "./cellValuesModel";

// Each event is [FITC-A, FSC-A]. CD4_positive holds FITC-A from 1000; FSC-A is the value drawn.
type Event = [number, number];

function file(id: string, events: Event[]): ProportionsSampleRef {
  const channels = [
    { index: 0, name: "FITC-A", marker: "CD4", bits: 32, range: 262144 },
    { index: 1, name: "FSC-A", marker: null, bits: 32, range: 262144 },
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

// D1: six events, one without a finite FSC-A; CD4_positive holds the two with FITC-A 5000.
// D2: three events, CD4_positive holds one.
const D1 = file("D1", [[5000, 10], [5000, 20], [100, 30], [100, NaN], [100, 50], [100, 60]]);
const D2 = file("D2", [[5000, 15], [100, 25], [100, 35]]);
const FILES = [D1, D2];

/** All Events with CD4_positive and CD4_negative beneath it, drawn as rectangles on CD4 (FITC-A). */
function tree() {
  const state = initialCoreState();
  const root = newRootPopulation();
  const pos = { ...newGate("CD4_positive", "rectangle", "CD4", "FSC-A", [[1000, -1e6], [262144, 1e6]]), space: "raw" as const };
  const neg = { ...newGate("CD4_negative", "rectangle", "CD4", "FSC-A", [[-1e6, -1e6], [1000, 1e6]]), space: "raw" as const };
  const cd4 = newPopulation("CD4_positive", [newGateRef(pos.gate_id)], root.population_id);
  const other = newPopulation("CD4_negative", [newGateRef(neg.gate_id)], root.population_id);
  root.children = [cd4.population_id, other.population_id];
  Object.assign(state, {
    gates: { [pos.gate_id]: pos, [neg.gate_id]: neg },
    gate_order: [pos.gate_id, neg.gate_id],
    populations: { [root.population_id]: root, [cd4.population_id]: cd4, [other.population_id]: other },
    root_population_id: root.population_id,
    active_population_id: root.population_id,
  });
  return { state: state as CoreState, root: root.population_id, cd4: cd4.population_id, other: other.population_id };
}

function settings(over: Partial<ProportionsSettings>): ProportionsSettings {
  return normalizeProportionsSettings({ ...BASE_PROPORTIONS_SETTINGS, valueKind: "cells", plotType: "violin", channel: "FSC-A", files: ["D1", "D2"], parent: "", ...over });
}

/** The gate list's count of a population in a file. */
function counted(state: CoreState, entry: ProportionsSampleRef, popId: string): number {
  return recompute(entry.sample, state).populations[popId].event_count ?? 0;
}

/** Events of a file with a finite value in a channel. */
function finite(entry: ProportionsSampleRef, channel: string): number {
  return Array.from(entry.sample.displayColumn(entry.sample.index(channel)!)).filter(Number.isFinite).length;
}

describe("Per-cell values of the root population", () => {
  it("draws every event of each file with a finite value when the root alone is selected", () => {
    const fx = tree();
    const model = buildCellValuesModel(settings({ hierarchy: fx.state.active_hierarchy_id, selectedPops: [fx.root] }), FILES, fx.state, {});
    expect(model.catLevels).toEqual(["All Events"]);
    expect(model.levels).toEqual([{ popId: fx.root, depth: 0 }]);
    expect(model.excluded).toEqual([]);
    expect(counted(fx.state, D1, fx.root)).toBe(6);
    expect(finite(D1, "FSC-A")).toBe(5);
    expect(model.violins.map((v) => [v.cat, v.group, v.values.length])).toEqual([
      [0, "D1.fcs", finite(D1, "FSC-A")],
      [0, "D2.fcs", counted(fx.state, D2, fx.root)],
    ]);
    expect([...model.violins[0].values]).toEqual([10, 20, 30, 50, 60]);
  });

  it("draws the root and a child together, the child as the gate list counts it", () => {
    const fx = tree();
    const model = buildCellValuesModel(settings({ hierarchy: fx.state.active_hierarchy_id, selectedPops: [fx.cd4, fx.root] }), FILES, fx.state, {});
    expect(model.catLevels).toEqual(["All Events", "CD4_positive"]);
    expect(model.levels).toEqual([{ popId: fx.root, depth: 0 }, { popId: fx.cd4, depth: 1 }]);
    for (const entry of FILES) {
      expect(model.violins.find((v) => v.cat === 0 && v.group === entry.name)!.values.length).toBe(finite(entry, "FSC-A"));
      expect(model.violins.find((v) => v.cat === 1 && v.group === entry.name)!.values.length).toBe(counted(fx.state, entry, fx.cd4));
    }
    expect([counted(fx.state, D1, fx.cd4), counted(fx.state, D2, fx.cd4)]).toEqual([2, 1]);
  });

  it("gives the root's per-file statistic over its cells", () => {
    const fx = tree();
    const s = settings({ valueKind: "statistic", plotType: "box", hierarchy: fx.state.active_hierarchy_id, selectedPops: [fx.root] });
    const model = buildCellValuesModel(s, FILES, fx.state, {}, { poolBy: "unit", values: "raw" });
    expect(model.violins.map((v) => [v.unit, [...v.values]])).toEqual([
      ["D1", [10, 20, 30, 50, 60]],
      ["D2", [15, 25, 35]],
    ]);
  });

  it("still reads a selection of an unknown population as the parent's children", () => {
    const fx = tree();
    const model = buildCellValuesModel(settings({ hierarchy: fx.state.active_hierarchy_id, selectedPops: ["unknown"] }), FILES, fx.state, {});
    expect(model.catLevels).toEqual(["CD4_positive", "CD4_negative"]);
  });

  it("leaves the root out of a proportion chart, as before", () => {
    const fx = tree();
    const s = normalizeProportionsSettings({ ...BASE_PROPORTIONS_SETTINGS, files: ["D1", "D2"], hierarchy: fx.state.active_hierarchy_id, parent: "", selectedPops: [fx.root] });
    const withRoot = buildProportionsModel(s, FILES, fx.state, {}, {});
    const unknown = buildProportionsModel({ ...s, selectedPops: ["unknown"] }, FILES, fx.state, {}, {});
    expect(withRoot.catLevels).toEqual(["CD4_positive", "CD4_negative", "ungated"]);
    expect(withRoot).toEqual(unknown);
  });
});
