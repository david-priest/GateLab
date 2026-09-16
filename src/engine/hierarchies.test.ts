import { describe, expect, it } from "vitest";
import { newGateRef, newPopulation, newRootPopulation, type Gate, type PopulationMap } from "./models";
import {
  adoptGates,
  cloneHierarchyTree,
  emptyHierarchyTree,
  fileHierarchyId,
  HIERARCHY_COLOURS,
  hierarchyColour,
  referencedGateIds,
  uniqueHierarchyName,
} from "./hierarchies";

function tree(): { populations: PopulationMap; rootId: string; ids: Record<string, string> } {
  const root = newRootPopulation(100);
  const a = newPopulation("A", [newGateRef("g1", true)], root.population_id);
  const b = newPopulation("B", [newGateRef("g2", true), newGateRef("q", true, 2)], a.population_id);
  const c = newPopulation("C", [newGateRef("g3", false)], b.population_id);
  root.children.push(a.population_id);
  a.children.push(b.population_id);
  b.children.push(c.population_id);
  const populations = Object.fromEntries([root, a, b, c].map((p) => [p.population_id, p]));
  return { populations, rootId: root.population_id, ids: { root: root.population_id, a: a.population_id, b: b.population_id, c: c.population_id } };
}

describe("hierarchies", () => {
  it("clones a tree under fresh ids, keeping structure and gate references", () => {
    const { populations, rootId, ids } = tree();
    const copy = cloneHierarchyTree(populations, rootId);
    expect(Object.keys(copy.populations)).toHaveLength(4);
    expect(new Set(Object.keys(copy.populations)).size).toBe(4);
    for (const oldId of Object.keys(populations)) expect(copy.populations[oldId]).toBeUndefined();
    const nb = copy.populations[copy.idMap[ids.b]];
    expect(nb.parent_id).toBe(copy.idMap[ids.a]);
    expect(nb.children).toEqual([copy.idMap[ids.c]]);
    expect(nb.gate_refs).toEqual(populations[ids.b].gate_refs);
    expect(nb.gate_refs).not.toBe(populations[ids.b].gate_refs);
    expect(copy.root_population_id).toBe(copy.idMap[rootId]);
    expect(copy.populations[copy.root_population_id].parent_id).toBeNull();
    // The source is untouched.
    expect(populations[ids.b].children).toEqual([ids.c]);
  });

  it("adopts another hierarchy's gates as copies, rewriting the strategy's references to them", () => {
    const { populations, rootId, ids } = tree();
    const source = {
      g1: { gate_id: "g1", gate_type: "polygon", name: "G1", vertices: [[0, 0], [1, 0], [1, 1]] } as unknown as Gate,
      q: { gate_id: "q", gate_type: "quadrant", name: "Q", center: [1, 1] } as unknown as Gate,
    };
    const own: Record<string, Gate> = { g2: { gate_id: "g2", gate_type: "rectangle", name: "G2", vertices: [[0, 0], [1, 1]] } as unknown as Gate };
    const adopted = adoptGates({ gates: own, gate_order: ["g2"], populations, root_population_id: rootId }, source, ["g1", "q", "g1", "absent"]);
    // g1 and q are copied once each under fresh ids; g2 was the strategy's own and stays.
    expect(Object.keys(adopted.gates)).toHaveLength(3);
    expect(adopted.gates.g2).toBe(own.g2);
    const copies = adopted.gate_order.slice(0, 2);
    expect(copies.every((id) => id !== "g1" && id !== "q" && adopted.gates[id])).toBe(true);
    expect(adopted.gate_order[2]).toBe("g2");
    expect(adopted.gates[copies[0]].name).toBe("G1");
    expect(adopted.gates[copies[1]].name).toBe("Q");
    expect(adopted.populations[ids.a].gate_refs[0].gate_id).toBe(copies[0]);
    expect(adopted.populations[ids.b].gate_refs.map((r) => r.gate_id)).toEqual(["g2", copies[1]]);
    expect(adopted.populations[ids.b].gate_refs[1].quadrant).toBe(2);
    // g3 is referenced but neither owned nor adopted, so it is left for the caller to notice.
    expect(adopted.populations[ids.c].gate_refs[0].gate_id).toBe("g3");
    // The source and the original strategy are untouched.
    expect(source.g1.gate_id).toBe("g1");
    expect(populations[ids.a].gate_refs[0].gate_id).toBe("g1");
    // Nothing to adopt returns the strategy itself.
    const same = { gates: own, gate_order: ["g2"], populations, root_population_id: rootId };
    expect(adoptGates(same, source, ["absent"])).toBe(same);
  });

  it("starts an empty hierarchy with a root only", () => {
    const t = emptyHierarchyTree(42);
    expect(Object.keys(t.populations)).toEqual([t.root_population_id]);
    expect(t.populations[t.root_population_id].event_count).toBe(42);
  });

  it("collects the gate ids a tree references", () => {
    const { populations } = tree();
    expect([...referencedGateIds(populations)].sort()).toEqual(["g1", "g2", "g3", "q"]);
  });

  it("copies the gates under fresh ids when given them, and points the copy's references at the copies", () => {
    const { populations, rootId, ids } = tree();
    const gates = {
      g1: { gate_id: "g1", gate_type: "polygon", name: "G1", vertices: [[0, 0], [1, 0], [1, 1]] } as unknown as Gate,
      g2: { gate_id: "g2", gate_type: "rectangle", name: "G2", vertices: [[0, 0], [1, 1]] } as unknown as Gate,
      g3: { gate_id: "g3", gate_type: "rectangle", name: "G3", vertices: [[2, 2], [3, 3]] } as unknown as Gate,
      q: { gate_id: "q", gate_type: "quadrant", name: "Q", center: [1, 1] } as unknown as Gate,
    };
    const copy = cloneHierarchyTree(populations, rootId, gates, ["q", "g3", "g2", "g1"]);
    expect(Object.keys(copy.gates)).toHaveLength(4);
    for (const oldId of Object.keys(gates)) {
      expect(copy.gates[oldId]).toBeUndefined();
      expect(copy.gates[copy.gateIdMap[oldId]].gate_id).toBe(copy.gateIdMap[oldId]);
    }
    expect(copy.gate_order).toEqual(["q", "g3", "g2", "g1"].map((id) => copy.gateIdMap[id]));
    const nb = copy.populations[copy.idMap[ids.b]];
    expect(nb.gate_refs.map((r) => r.gate_id)).toEqual([copy.gateIdMap.g2, copy.gateIdMap.q]);
    expect(nb.gate_refs[1].quadrant).toBe(2);
    // Every reference in the copy resolves in the copy's own table; the source keeps its ids and
    // its geometry is not shared with the copy.
    for (const pop of Object.values(copy.populations)) for (const r of pop.gate_refs) expect(copy.gates[r.gate_id]).toBeDefined();
    expect(populations[ids.b].gate_refs[0].gate_id).toBe("g2");
    expect(gates.g1.gate_id).toBe("g1");
    expect((copy.gates[copy.gateIdMap.g1] as { vertices: number[][] }).vertices).not.toBe((gates.g1 as { vertices: number[][] }).vertices);
  });

  it("picks a name no other hierarchy uses", () => {
    const taken = [{ id: "1", name: "Main" }, { id: "2", name: "Main copy" }];
    expect(uniqueHierarchyName("Main copy", taken)).toBe("Main copy 2");
    expect(uniqueHierarchyName("Other", taken)).toBe("Other");
    expect(uniqueHierarchyName("   ", taken)).toBe("Main 2");
  });
});

describe("per-file hierarchy assignment", () => {
  const hs = [{ id: "main", name: "Main" }, { id: "h2", name: "Day 7" }];

  it("resolves an assigned hierarchy, and falls back to the first for none or a deleted one", () => {
    expect(fileHierarchyId("h2", hs)).toBe("h2");
    expect(fileHierarchyId(undefined, hs)).toBe("main");
    expect(fileHierarchyId("gone", hs)).toBe("main");
    expect(fileHierarchyId("h2", [])).toBe("main");
  });

  it("colours hierarchies by menu position and wraps round", () => {
    expect(hierarchyColour(0)).toBe(HIERARCHY_COLOURS[0]);
    expect(hierarchyColour(1)).toBe(HIERARCHY_COLOURS[1]);
    expect(hierarchyColour(HIERARCHY_COLOURS.length)).toBe(HIERARCHY_COLOURS[0]);
    expect(new Set(HIERARCHY_COLOURS).size).toBe(HIERARCHY_COLOURS.length);
  });
});
