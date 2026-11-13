// A population keeps its own gate through the edit template when another gate has the same name
// but for a trailing space, which a table cell does not hold.
import { describe, expect, it } from "vitest";
import { serializePopulationEditTemplate, parsePopulationEditTable } from "./populationTable";
import type { Gate, PopulationMap } from "./models";

const g = (id: string, name: string): Gate => ({ gate_id: id, name, gate_type: "polygon", x_channel: "a", y_channel: "b", vertices: [[0, 0], [1, 0], [1, 1]], color: "#000", label_offset: null });

describe("population template round trip with a gate name that differs only by a trailing space", () => {
  it("keeps the population on its own gate", () => {
    const gates = { g1: g("g1", "CD4"), g2: g("g2", "CD4 ") };
    const populations: PopulationMap = {
      root: { population_id: "root", name: "All", gate_refs: [], gate_logic: "and", parent_id: null, children: ["p1", "p2"], event_count: null, percent_of_parent: null },
      p1: { population_id: "p1", name: "A", gate_refs: [{ gate_id: "g1", include: true }], gate_logic: "and", parent_id: "root", children: [], event_count: null, percent_of_parent: null },
      p2: { population_id: "p2", name: "B", gate_refs: [{ gate_id: "g2", include: true }], gate_logic: "and", parent_id: "root", children: [], event_count: null, percent_of_parent: null },
    };
    const state = { populations, gates, rootPopulationId: "root" };
    const csv = serializePopulationEditTemplate(state);
    const preview = parsePopulationEditTable(csv, state);
    const p2 = preview.updates.find((u) => u.popId === "p2")!;
    expect(p2.gateRefs[0].gate_id).toBe("g2");
    expect(preview.updates.find((u) => u.popId === "p1")!.gateRefs[0].gate_id).toBe("g1");
    expect(preview.gateDefinitionCount).toBe(0);
  });
});
