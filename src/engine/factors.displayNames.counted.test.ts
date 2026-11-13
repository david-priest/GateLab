// Populations of one name under different parents, as a Plotting chart names and counts them:
// each named with the fewest ancestors that tell it apart, its cells as the gate list counts them.
// Synthetic file F1; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { BASE_PROPORTIONS_SETTINGS, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "./proportionsSettings";
import type { ProportionsSampleRef } from "./proportionsModel";
import { buildCellValuesModel } from "./cellValuesModel";
import { populationDisplayNames } from "./factors";

// Each event is [FITC-A (CD4), PE-A (CD8), FSC-A]. B1 is FSC-A below 50, B2 above.
const LOW = 100;
const HIGH = 5000;
const EVENTS = [[HIGH, LOW, 10], [HIGH, LOW, 20], [LOW, HIGH, 30], [HIGH, LOW, 60], [LOW, HIGH, 70], [LOW, HIGH, 80]];
function f1(): ProportionsSampleRef {
  const channels = [
    { index: 0, name: "FITC-A", marker: "CD4", bits: 32, range: 262144 },
    { index: 1, name: "PE-A", marker: "CD8", bits: 32, range: 262144 },
    { index: 2, name: "FSC-A", marker: null, bits: 32, range: 262144 },
  ];
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: EVENTS.length, instrument: "flow", keywords: {}, spillover: null, channels,
    columns: channels.map((_, c) => Float32Array.from(EVENTS.map((event) => event[c]))),
  };
  return { id: "F1", name: "F1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
}

function gate(state: CoreState, name: string, parentId: string, x: string, from: number, to: number): [CoreState, string] {
  const next = coreReducer(state, {
    type: "addGate", gateType: "rectangle", name, xChannel: x, yChannel: "FSC-A", space: "raw",
    vertices: [[from, -1e6], [to, 1e6]], createPop: { name, parentId },
  }) as CoreState;
  const pop = Object.values(next.populations).find((p) => p.name === name && p.parent_id === parentId)!;
  return [next, pop.population_id];
}

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: EVENTS.length }) as CoreState;
  const root = state.root_population_id!;
  let b1: string, b2: string, cd4a: string, cd4b: string, cd8: string, ki67a: string, ki67b: string, ki67c: string;
  [state, b1] = gate(state, "B1", root, "FSC-A", 0, 50);
  [state, b2] = gate(state, "B2", root, "FSC-A", 50, 1000);
  [state, cd4a] = gate(state, "CD4_positive", b1, "CD4", 1000, 1e6);
  [state, cd4b] = gate(state, "CD4_positive", b2, "CD4", 1000, 1e6);
  [state, cd8] = gate(state, "CD8_positive", b1, "CD8", 1000, 1e6);
  [state, ki67a] = gate(state, "Ki67_positive", cd4a, "FSC-A", 0, 1000);
  [state, ki67b] = gate(state, "Ki67_positive", cd4b, "FSC-A", 0, 1000);
  [state, ki67c] = gate(state, "Ki67_positive", cd8, "FSC-A", 0, 1000);
  return { state, root, b1, b2, cd4a, cd4b, cd8, ki67a, ki67b, ki67c };
}

describe("populationDisplayNames", () => {
  it("names each population of a recurring name by the fewest ancestors that tell it apart", () => {
    const fx = fixture();
    const names = populationDisplayNames(fx.state.populations);
    expect(names[fx.b1]).toBe("B1");
    expect(names[fx.cd8]).toBe("CD8_positive");
    expect(names[fx.cd4a]).toBe("B1 › CD4_positive");
    expect(names[fx.cd4b]).toBe("B2 › CD4_positive");
    expect(names[fx.ki67a]).toBe("B1 › CD4_positive › Ki67_positive");
    expect(names[fx.ki67b]).toBe("B2 › CD4_positive › Ki67_positive");
    expect(names[fx.ki67c]).toBe("CD8_positive › Ki67_positive");
  });

  it("gives a chart of the three a level each, its cells as the gate list counts them", () => {
    const fx = fixture();
    const settings: ProportionsSettings = {
      ...BASE_PROPORTIONS_SETTINGS,
      valueKind: "cells", plotType: "violin", channel: "FSC-A", files: ["F1"],
      hierarchy: fx.state.active_hierarchy_id, parent: fx.root,
      selectedPops: [fx.ki67a, fx.ki67b, fx.ki67c], groupSel: PROPORTIONS_SAMPLE_FACTOR, xAxis: "groups",
    };
    const file = f1();
    const model = buildCellValuesModel(settings, [file], fx.state, {});
    expect(new Set(model.catLevels).size).toBe(3);
    const counts = recompute(file.sample, fx.state).populations;
    const byId = Object.fromEntries(model.levels.map((level, cat) => [level.popId, model.violins.find((v) => v.cat === cat)?.values.length ?? 0]));
    expect(byId[fx.ki67a]).toBe(counts[fx.ki67a].event_count);
    expect(byId[fx.ki67b]).toBe(counts[fx.ki67b].event_count);
    expect(byId[fx.ki67c]).toBe(counts[fx.ki67c].event_count);
    expect([byId[fx.ki67a], byId[fx.ki67b], byId[fx.ki67c]]).toEqual([2, 1, 1]);
  });
});
