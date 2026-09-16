// A composition is the children of one parent. Synthetic populations D1-style throughout.

import { describe, it, expect } from "vitest";
import { partitionCountsWithin, populationDisplayNames } from "./factors";
import type { PopulationMap } from "./models";

const mask = (bits: number[]) => Uint8Array.from(bits);

describe("partitionCountsWithin", () => {
  const levels = [{ popId: "a", name: "A", depth: 2 }, { popId: "b", name: "B", depth: 2 }];
  it("places only the parent's events, the deepest level winning, and counts the rest of the parent", () => {
    const masks = { parent: mask([1, 1, 1, 1, 0, 0]), a: mask([1, 0, 0, 0, 1, 0]), b: mask([0, 1, 1, 0, 0, 1]) };
    expect(partitionCountsWithin(masks, levels, "parent", 6)).toEqual({ counts: [1, 2], rest: 1 });
  });
  it("with no parent it is the whole file, the leftover being the ungated events", () => {
    const masks = { a: mask([1, 0, 0, 0, 1, 0]), b: mask([0, 1, 1, 0, 0, 1]) };
    expect(partitionCountsWithin(masks, levels, null, 6)).toEqual({ counts: [2, 3], rest: 1 });
  });
  it("a parent with no mask yields nothing rather than the whole file", () => {
    expect(partitionCountsWithin({ a: mask([1, 1]) }, levels, "missing", 2)).toEqual({ counts: [0, 0], rest: 0 });
  });
});

describe("populationDisplayNames", () => {
  it("names a recurring population by its parent, and leaves unique names alone", () => {
    const populations: PopulationMap = {
      root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: ["hi", "lo"], event_count: null, percent_of_parent: null },
      hi: { population_id: "hi", name: "Live_HighLL", gate_refs: [], gate_logic: "and", parent_id: "root", children: ["q1a"], event_count: null, percent_of_parent: null },
      lo: { population_id: "lo", name: "Live_LowLL", gate_refs: [], gate_logic: "and", parent_id: "root", children: ["q1b"], event_count: null, percent_of_parent: null },
      q1a: { population_id: "q1a", name: "Dextran+ Live+", gate_refs: [], gate_logic: "and", parent_id: "hi", children: [], event_count: null, percent_of_parent: null },
      q1b: { population_id: "q1b", name: "Dextran+ Live+", gate_refs: [], gate_logic: "and", parent_id: "lo", children: [], event_count: null, percent_of_parent: null },
    };
    expect(populationDisplayNames(populations)).toEqual({
      root: "All Events", hi: "Live_HighLL", lo: "Live_LowLL",
      q1a: "Live_HighLL › Dextran+ Live+", q1b: "Live_LowLL › Dextran+ Live+",
    });
  });
});
