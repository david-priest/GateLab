import { describe, it, expect } from "vitest";
import type { FcsFile } from "../engine/fcs";
import { Sample } from "../engine/sample";
import { applyGatingStrategy } from "../engine/populations";
import {
  newGate,
  newGateRef,
  newPopulation,
  newQuadrantGate,
  newRootPopulation,
  UNBOUNDED,
  type Gate,
  type PopulationMap,
} from "../engine/models";
import { belowMinEvents, MIN_EVENTS_FIELD, readMinEvents, siblingOverlaps } from "./populationChecks";

// Eight events: CD4 and CD8 each high (500) or low (5); two events are CD4+CD8+.
function synthetic(): Sample {
  const cd4 = new Float32Array([500, 500, 500, 5, 5, 5, 500, 5]);
  const cd8 = new Float32Array([500, 5, 5, 500, 500, 5, 500, 5]);
  return new Sample({
    version: "FCS3.1", nEvents: 8, instrument: "flow", keywords: {},
    channels: [
      { index: 0, name: "FL1-A", marker: "CD4", bits: 32, range: 262144 },
      { index: 1, name: "FL2-A", marker: "CD8", bits: 32, range: 262144 },
    ],
    columns: [cd4, cd8],
    spillover: null,
  } as unknown as FcsFile);
}

function evaluate(sample: Sample, gates: Record<string, Gate>, populations: PopulationMap, rootId: string) {
  const { masks } = applyGatingStrategy(gates, populations, rootId, sample.gateAssayData());
  const counts: Record<string, number> = {};
  for (const [id, m] of Object.entries(masks)) counts[id] = m.reduce((s, v) => s + v, 0);
  return { masks, counts };
}

describe("siblingOverlaps", () => {
  it("finds CD4+ and CD8+ drawn on separate gates sharing the double positives", () => {
    const sample = synthetic();
    const [cd4, cd8] = sample.channels.map((c) => c.key);
    const g4 = newGate("CD4 gate", "rectangle", cd4, cd8, [[100, -UNBOUNDED], [UNBOUNDED, UNBOUNDED]]);
    const g8 = newGate("CD8 gate", "rectangle", cd4, cd8, [[-UNBOUNDED, 100], [UNBOUNDED, UNBOUNDED]]);
    const root = newRootPopulation();
    const p4 = newPopulation("CD4_positive", [newGateRef(g4.gate_id)], root.population_id);
    const p8 = newPopulation("CD8_positive", [newGateRef(g8.gate_id)], root.population_id);
    root.children = [p4.population_id, p8.population_id];
    const pops: PopulationMap = { [root.population_id]: root, [p4.population_id]: p4, [p8.population_id]: p8 };
    const { masks, counts } = evaluate(sample, { [g4.gate_id]: g4, [g8.gate_id]: g8 }, pops, root.population_id);
    expect(counts[p4.population_id]).toBe(4);
    expect(counts[p8.population_id]).toBe(4);
    expect(siblingOverlaps(pops, masks)).toEqual([
      { parentId: root.population_id, a: p4.population_id, b: p8.population_id, shared: 2 },
    ]);
  });

  it("reports nothing for the four quadrants of one gate, or a population and its complement", () => {
    const sample = synthetic();
    const [cd4, cd8] = sample.channels.map((c) => c.key);
    const quad = newQuadrantGate("CD4 CD8", cd4, cd8, [100, 100]);
    const g4 = newGate("CD4 gate", "rectangle", cd4, cd8, [[100, -UNBOUNDED], [UNBOUNDED, UNBOUNDED]]);
    const root = newRootPopulation();
    const qs = [1, 2, 3, 4].map((q) => newPopulation(`Q${q}`, [newGateRef(quad.gate_id, true, q)], root.population_id));
    const inside = newPopulation("CD4_positive", [newGateRef(g4.gate_id)], qs[0].population_id);
    const outside = newPopulation("CD4_negative", [newGateRef(g4.gate_id, false)], qs[0].population_id);
    root.children = qs.map((p) => p.population_id);
    qs[0].children = [inside.population_id, outside.population_id];
    const pops: PopulationMap = Object.fromEntries(
      [root, ...qs, inside, outside].map((p) => [p.population_id, p]),
    );
    const { masks, counts } = evaluate(sample, { [quad.gate_id]: quad, [g4.gate_id]: g4 }, pops, root.population_id);
    expect(qs.map((p) => counts[p.population_id])).toEqual([2, 2, 2, 2]);
    expect(siblingOverlaps(pops, masks)).toEqual([]);
  });

  it("skips a population with no mask rather than reading it as empty", () => {
    const root = newRootPopulation();
    const a = newPopulation("A", [], root.population_id);
    const b = newPopulation("B", [], root.population_id);
    root.children = [a.population_id, b.population_id];
    const pops: PopulationMap = { [root.population_id]: root, [a.population_id]: a, [b.population_id]: b };
    expect(siblingOverlaps(pops, { [a.population_id]: new Uint8Array([1, 1]) })).toEqual([]);
  });
});

describe("belowMinEvents", () => {
  it("lists counts under the threshold and leaves out populations with no count", () => {
    expect(belowMinEvents({ a: 10, b: 99, c: 100, d: null }, 100)).toEqual(["a", "b"]);
  });
});

describe("readMinEvents", () => {
  it("reads a positive whole number and drops anything else", () => {
    expect(readMinEvents({ [MIN_EVENTS_FIELD]: 100 })).toBe(100);
    for (const v of [0, -5, 2.5, "100", null, undefined, Number.NaN]) {
      expect(readMinEvents({ [MIN_EVENTS_FIELD]: v })).toBeNull();
    }
    expect(readMinEvents(null)).toBeNull();
    expect(readMinEvents("workspace")).toBeNull();
  });
});
