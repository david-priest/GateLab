// A curled quadrant and a straight one on one crosshair are two gates, and reusing identical
// gates on import keeps both.
import { describe, expect, it } from "vitest";
import { mergeGatingStrategies, type GatingStrategyGraph } from "./gatingMerge";
import type { Gate } from "./models";

const quad = (id: string, curl?: unknown): Gate => ({
  gate_id: id, name: "FL1-A × FL2-A quadrant", gate_type: "quadrant", x_channel: "FL1-A", y_channel: "FL2-A",
  center: [100, 200], color: "#000", label_offset: null, ...(curl ? { curl } : {}),
} as unknown as Gate);

const graph = (gate: Gate, rootId: string, popId: string): GatingStrategyGraph => ({
  gates: { [gate.gate_id]: gate },
  gate_order: [gate.gate_id],
  root_population_id: rootId,
  populations: {
    [rootId]: { population_id: rootId, name: "All Events", parent_id: null, children: [popId], gate_refs: [], gate_logic: "AND", event_count: null, percent_of_parent: null },
    [popId]: { population_id: popId, name: "Q2", parent_id: rootId, children: [], gate_refs: [{ gate_id: gate.gate_id, include: true, quadrant: 2 }], gate_logic: "AND", event_count: null, percent_of_parent: null },
  } as unknown as GatingStrategyGraph["populations"],
});

describe("reuseIdenticalGates and a quadrant's curl", () => {
  it("does not fuse a curled quadrant with a straight one of the same crosshair", () => {
    const current = graph(quad("straight"), "r1", "p1");
    const imported = graph(quad("curled", { x: 10, y: 10, power: 2 }), "r2", "p2");
    const merged = mergeGatingStrategies(current, imported, "r1", true);
    expect(merged.gateIdMap["curled"]).not.toBe("straight");
  });
});
