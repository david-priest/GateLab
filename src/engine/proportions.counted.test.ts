// The Plotting chart's numbers against the gate list's, on gates drawn around known events.
// Synthetic donors D1 and D2, each with a control and a treated file; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "./hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation, type Population } from "./models";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { buildProportionsModel, defaultProportionsSettings, divisionFittedPopulation, type ProportionsSampleRef } from "./proportionsModel";
import { DIVISION_NA_CODE, divisionEventCodes } from "./division";
import { computeBoxes, computeStackedBars, perUnitProps } from "./proportions";

// Gates in raw scatter units: A holds FSC below 55, B (inside A) SSC below 25, C FSC from 65,
// and D, beside A and C under the root, FSC 35 to 75, which overlaps both.
function tree(withOverlap = false) {
  const state = initialCoreState();
  const root = newRootPopulation();
  const gateA = newGate("A", "rectangle", "FSC-A", "SSC-A", [[0, 0], [55, 1000]]);
  const gateB = newGate("B", "rectangle", "FSC-A", "SSC-A", [[0, 0], [1000, 25]]);
  const gateC = newGate("C", "rectangle", "FSC-A", "SSC-A", [[65, 0], [1000, 1000]]);
  const a = newPopulation("A", [newGateRef(gateA.gate_id)], root.population_id);
  const b = newPopulation("B", [newGateRef(gateB.gate_id)], a.population_id);
  const c = newPopulation("C", [newGateRef(gateC.gate_id)], root.population_id);
  const gateD = newGate("D", "rectangle", "FSC-A", "SSC-A", [[35, 0], [75, 1000]]);
  const d = newPopulation("D", [newGateRef(gateD.gate_id)], root.population_id);
  root.children = withOverlap ? [a.population_id, c.population_id, d.population_id] : [a.population_id, c.population_id];
  a.children = [b.population_id];
  const populations: Record<string, Population> = { [root.population_id]: root, [a.population_id]: a, [b.population_id]: b, [c.population_id]: c };
  if (withOverlap) populations[d.population_id] = d;
  Object.assign(state, {
    gates: { [gateA.gate_id]: gateA, [gateB.gate_id]: gateB, [gateC.gate_id]: gateC, ...(withOverlap ? { [gateD.gate_id]: gateD } : {}) },
    gate_order: [gateA.gate_id, gateB.gate_id, gateC.gate_id, ...(withOverlap ? [gateD.gate_id] : [])],
    populations,
    root_population_id: root.population_id,
    active_population_id: root.population_id,
  });
  return { state: state as CoreState, rootId: root.population_id, a: a.population_id, b: b.population_id, c: c.population_id, d: d.population_id };
}

function file(id: string, fsc: number[], ssc: number[]): ProportionsSampleRef {
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: fsc.length,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from(fsc), Float32Array.from(ssc)],
  };
  return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
}

// Each file has 10 events; A, B and C hold different numbers in each.
const FILES = [
  file("D1-control", [10, 20, 30, 40, 50, 60, 70, 80, 90, 95], [10, 20, 30, 40, 50, 50, 50, 50, 50, 50]), // A 5, B 2, C 4
  file("D1-treated", [10, 20, 30, 60, 70, 80, 90, 95, 96, 97], [10, 50, 50, 50, 50, 50, 50, 50, 50, 50]), // A 3, B 1, C 6
  file("D2-control", [10, 20, 30, 40, 60, 60, 70, 80, 90, 95], [10, 10, 10, 40, 50, 50, 50, 50, 50, 50]), // A 4, B 3, C 4
  file("D2-treated", [10, 20, 60, 60, 60, 70, 80, 90, 95, 96], [10, 50, 50, 50, 50, 50, 50, 50, 50, 50]), // A 2, B 1, C 5
];
const METADATA = {
  "D1-control": { donor: "D1", condition: "control" },
  "D1-treated": { donor: "D1", condition: "treated" },
  "D2-control": { donor: "D2", condition: "control" },
  "D2-treated": { donor: "D2", condition: "treated" },
};

/** What the gate list shows for a file: each population's events over its parent's, and over all. */
function gateList(state: CoreState, entry: ProportionsSampleRef) {
  const derived = recompute(entry.sample, state);
  const n = entry.sample.fcs.nEvents;
  return (popId: string) => ({ count: derived.populations[popId].event_count ?? 0, ofAll: (derived.populations[popId].event_count ?? 0) / n });
}

describe("Plotting numbers against the gate list", () => {
  it("gives each population its whole share as the gate list counts it, nested selections included", () => {
    const fx = tree();
    const settings = { ...defaultProportionsSettings(FILES, fx.state, []), selectedPops: [fx.a, fx.b, fx.c] };
    const model = buildProportionsModel(settings, FILES, fx.state, METADATA, {});
    expect(model.catLevels).toEqual(["A", "B", "C", "ungated"]);
    expect(model.overlapping).toEqual([]);
    const units = perUnitProps(model.perSample, model.catLevels.length);
    for (const [index, entry] of FILES.entries()) {
      const list = gateList(fx.state, entry);
      expect(model.perSample[index].popCounts).toEqual([list(fx.a).count, list(fx.b).count, list(fx.c).count]);
      const unit = units.find((row) => row.unit === entry.id)!;
      expect(unit.shares[0]).toBeCloseTo(list(fx.a).ofAll, 12);
      expect(unit.shares[1]).toBeCloseTo(list(fx.b).ofAll, 12);
      expect(unit.shares[2]).toBeCloseTo(list(fx.c).ofAll, 12);
      // The stacked bar's partition: A keeps only what B does not hold; the rest is what no selection holds.
      const counts = model.perSample[index].catCounts;
      expect(counts[0]).toBe(list(fx.a).count - list(fx.b).count);
      expect(counts[3]).toBe(entry.sample.fcs.nEvents - list(fx.a).count - list(fx.c).count);
    }
    // The counts the comments above give, so a change to the fixture cannot pass unnoticed.
    expect(FILES.map((entry) => [fx.a, fx.b, fx.c].map((id) => gateList(fx.state, entry)(id).count))).toEqual([
      [5, 2, 4],
      [3, 1, 6],
      [4, 3, 4],
      [2, 1, 5],
    ]);
  });

  it("names a population that overlaps another, and boxes it whole where the stacked bar cannot", () => {
    const fx = tree(true);
    const settings = { ...defaultProportionsSettings(FILES, fx.state, []), selectedPops: [fx.a, fx.c, fx.d] };
    const model = buildProportionsModel(settings, FILES, fx.state, METADATA, {});
    expect(model.catLevels).toEqual(["A", "C", "D", "ungated"]);
    expect(model.overlapping).toEqual(["D"]);
    const units = perUnitProps(model.perSample, model.catLevels.length);
    for (const [index, entry] of FILES.entries()) {
      const list = gateList(fx.state, entry);
      // D's events in A or C are drawn in A or C; the box still gives D all of them.
      expect(model.perSample[index].catCounts[2]).toBeLessThan(list(fx.d).count);
      expect(units.find((row) => row.unit === entry.id)!.shares[2]).toBeCloseTo(list(fx.d).ofAll, 12);
    }
    expect(FILES.map((entry) => gateList(fx.state, entry)(fx.d).count)).toEqual([4, 2, 4, 4]);
  });

  it("draws a child's share of its parent as the gate list's percent of parent", () => {
    const fx = tree();
    const settings = { ...defaultProportionsSettings(FILES, fx.state, []), parent: fx.a, selectedPops: [fx.b] };
    const model = buildProportionsModel(settings, FILES, fx.state, METADATA, {});
    expect(model.catLevels).toEqual(["B", "rest of A"]);
    for (const [index, entry] of FILES.entries()) {
      const [b, rest] = model.perSample[index].catCounts;
      const list = gateList(fx.state, entry);
      expect(b).toBe(list(fx.b).count);
      expect(b + rest).toBe(list(fx.a).count);
    }
  });

  it("takes a donor with a file in each condition as one replicate in each, never one of both pooled", () => {
    const fx = tree();
    const settings = {
      ...defaultProportionsSettings(FILES, fx.state, []),
      selectedPops: [fx.a, fx.b, fx.c],
      groupSel: "condition",
      unitSel: "donor",
    };
    const model = buildProportionsModel(settings, FILES, fx.state, METADATA, {});
    const nCat = model.catLevels.length;
    const units = perUnitProps(model.perSample, nCat);
    expect(units.map((unit) => [unit.unit, unit.group]).sort()).toEqual([
      ["D1", "control"], ["D1", "treated"], ["D2", "control"], ["D2", "treated"],
    ]);
    const boxes = computeBoxes(units, nCat, false);
    const share = (id: string, popId: string) => gateList(fx.state, FILES.find((entry) => entry.id === id)!)(popId).ofAll;
    const boxOf = (cat: number, group: string) => boxes.find((box) => box.cat === cat && box.group === group)!;
    // A in the control files is 5/10 and 4/10, in the treated files 3/10 and 2/10.
    const near = (got: number[], want: number[]) => {
      expect(got).toHaveLength(want.length);
      [...got].sort().forEach((value, index) => expect(value).toBeCloseTo([...want].sort()[index], 12));
    };
    near(boxOf(0, "control").values, [share("D1-control", fx.a), share("D2-control", fx.a)]);
    near(boxOf(0, "treated").values, [share("D1-treated", fx.a), share("D2-treated", fx.a)]);
    near(boxOf(1, "control").values, [share("D1-control", fx.b), share("D2-control", fx.b)]);
    near(boxOf(2, "treated").values, [share("D1-treated", fx.c), share("D2-treated", fx.c)]);
    expect(boxOf(0, "control").stats.med).toBeCloseTo(0.45, 12);
    expect(boxOf(2, "treated").stats.med).toBeCloseTo(0.55, 12);
    // The stacked bar averages the same per-donor shares: two bars, each the mean of two donors.
    const bars = computeStackedBars(model.perSample, nCat, { averagePerUnit: true, hasUnit: true, hasFacet: false });
    expect(bars.map((bar) => bar.group).sort()).toEqual(["control", "treated"]);
    const control = bars.find((bar) => bar.group === "control")!;
    // Own shares, deepest wins: A's own is A without B, (3/10 + 1/10) / 2.
    expect(control.segments[0].value).toBeCloseTo(0.2, 12);
    expect(control.segments[1].value).toBeCloseTo(0.25, 12);
  });
});

describe("Plotting division categories against the gate list", () => {
  // One boundary on SSC at 25: events below it are Div1, the rest Div0. Within A, Div1 is B.
  const profile = { channelKey: "SSC-A", boundaries: [25], n: 1 };
  const below25 = (entry: ProportionsSampleRef) => {
    const ssc = entry.sample.fcs.columns[1];
    let count = 0;
    for (let e = 0; e < ssc.length; e++) if (ssc[e] < 25) count++;
    return count;
  };

  it("counts within the population the profile was fitted in, as the Division tab does", () => {
    const fx = tree();
    const profiles = Object.fromEntries(FILES.map((entry) => [entry.id, { ...profile, populationId: fx.a, hierarchyId: DEFAULT_HIERARCHY_ID }]));
    const settings = { ...defaultProportionsSettings(FILES, fx.state, []), categoryKind: "division" as const };
    const model = buildProportionsModel(settings, FILES, fx.state, METADATA, profiles);
    expect(model.catLevels).toEqual(["Div0", "Div1"]);
    expect(model.divisionWithin).toEqual(["A"]);
    expect(model.excluded).toEqual([]);
    for (const [index, entry] of FILES.entries()) {
      const list = gateList(fx.state, entry);
      expect(model.perSample[index].catCounts).toEqual([list(fx.a).count - list(fx.b).count, list(fx.b).count]);
    }
    // D1-control: A holds 5 events, B 2 of them.
    expect(model.perSample[0].catCounts).toEqual([3, 2]);
  });

  it("counts every event for a profile saved without its population, or fitted at the root", () => {
    const fx = tree();
    const settings = { ...defaultProportionsSettings(FILES, fx.state, []), categoryKind: "division" as const };
    for (const fitted of [profile, { ...profile, populationId: fx.rootId, hierarchyId: DEFAULT_HIERARCHY_ID }]) {
      const model = buildProportionsModel(settings, FILES, fx.state, METADATA, Object.fromEntries(FILES.map((entry) => [entry.id, fitted])));
      expect(model.divisionWithin).toEqual([null]);
      for (const [index, entry] of FILES.entries()) {
        expect(model.perSample[index].catCounts).toEqual([entry.sample.fcs.nEvents - below25(entry), below25(entry)]);
      }
    }
  });

  it("leaves out a file whose tree no longer holds the population its profile was fitted in", () => {
    const fx = tree();
    const profiles = Object.fromEntries(FILES.map((entry) => [entry.id, { ...profile, populationId: "pop-deleted", hierarchyId: DEFAULT_HIERARCHY_ID }]));
    const settings = { ...defaultProportionsSettings(FILES, fx.state, []), categoryKind: "division" as const };
    const model = buildProportionsModel(settings, FILES, fx.state, METADATA, profiles);
    expect(model.perSample).toEqual([]);
    expect(model.excluded).toEqual(FILES.map((entry) => entry.name));
  });
});

describe("Division calls written to colData", () => {
  // The same boundary as above: SSC below 25 is Div1, the rest Div0.
  const profile = { channelKey: "SSC-A", boundaries: [25], n: 1 };
  const codesFor = (entry: ProportionsSampleRef, fittedIn: Partial<{ populationId: string; hierarchyId: string }>, state: CoreState) => {
    const fitted = divisionFittedPopulation(entry, { ...profile, ...fittedIn }, state);
    if (fitted === "excluded") throw new Error("excluded");
    return divisionEventCodes(entry.sample.fcs.columns[1], profile.boundaries, fitted.mask);
  };

  it("are NA outside the population the profile was fitted in, and the levels inside it unchanged", () => {
    const fx = tree();
    for (const entry of FILES) {
      const inA = recompute(entry.sample, fx.state).masks[fx.a];
      const all = codesFor(entry, {}, fx.state);
      const codes = codesFor(entry, { populationId: fx.a, hierarchyId: DEFAULT_HIERARCHY_ID }, fx.state);
      const list = gateList(fx.state, entry);
      let na = 0;
      const perLevel = [0, 0];
      for (let e = 0; e < codes.length; e++) {
        if (!inA[e]) {
          expect(codes[e]).toBe(DIVISION_NA_CODE);
          na++;
        } else {
          // Inside A, an event keeps the level it had when every event was called.
          expect(codes[e]).toBe(all[e]);
          perLevel[codes[e]]++;
        }
      }
      expect(na).toBe(entry.sample.fcs.nEvents - list(fx.a).count);
      expect(perLevel).toEqual([list(fx.a).count - list(fx.b).count, list(fx.b).count]);
    }
    // D1-control: 10 events, 5 in A (3 Div0, 2 Div1), 5 NA.
    const codes = codesFor(FILES[0], { populationId: fx.a, hierarchyId: DEFAULT_HIERARCHY_ID }, fx.state);
    expect([...codes]).toEqual([1, 1, 0, 0, 0, DIVISION_NA_CODE, DIVISION_NA_CODE, DIVISION_NA_CODE, DIVISION_NA_CODE, DIVISION_NA_CODE]);
  });

  it("call every event for a profile saved without its population, or fitted at the root", () => {
    const fx = tree();
    for (const fittedIn of [{}, { populationId: fx.rootId, hierarchyId: DEFAULT_HIERARCHY_ID }]) {
      const codes = codesFor(FILES[0], fittedIn, fx.state);
      expect([...codes]).not.toContain(DIVISION_NA_CODE);
      expect([...codes]).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    }
  });

  it("leave a file out when its tree no longer holds the population", () => {
    const fx = tree();
    expect(divisionFittedPopulation(FILES[0], { ...profile, populationId: "pop-deleted", hierarchyId: DEFAULT_HIERARCHY_ID }, fx.state)).toBe("excluded");
  });
});
