import { describe, expect, it } from "vitest";
import { newGateRef, newPopulation, newRootPopulation, type Gate, type PopulationMap } from "./models";
import { cloneHierarchyTree, emptyHierarchyTree, pruneDeletedGates, referencedGateIds, uniqueHierarchyName } from "./hierarchies";

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

  it("starts an empty hierarchy with a root only", () => {
    const t = emptyHierarchyTree(42);
    expect(Object.keys(t.populations)).toEqual([t.root_population_id]);
    expect(t.populations[t.root_population_id].event_count).toBe(42);
  });

  it("collects the gate ids a tree references", () => {
    const { populations } = tree();
    expect([...referencedGateIds(populations)].sort()).toEqual(["g1", "g2", "g3", "q"]);
  });

  it("prunes deleted gates the way the live tree does, quadrant populations included", () => {
    const { populations, rootId, ids } = tree();
    const gates = { q: { gate_type: "quadrant" } as Gate, g1: { gate_type: "polygon" } as Gate };
    const pruned = pruneDeletedGates(populations, rootId, gates, new Set(["g1", "q"]));
    // B was built on the quadrant gate, so it goes and C moves up under A.
    expect(pruned[ids.b]).toBeUndefined();
    expect(pruned[ids.a].children).toEqual([ids.c]);
    expect(pruned[ids.c].parent_id).toBe(ids.a);
    expect(pruned[ids.a].gate_refs).toEqual([]);
    // The source is untouched.
    expect(populations[ids.a].gate_refs).toHaveLength(1);
    expect(populations[ids.b]).toBeDefined();
  });

  it("picks a name no other hierarchy uses", () => {
    const taken = [{ id: "1", name: "Main" }, { id: "2", name: "Main copy" }];
    expect(uniqueHierarchyName("Main copy", taken)).toBe("Main copy 2");
    expect(uniqueHierarchyName("Other", taken)).toBe("Other");
    expect(uniqueHierarchyName("   ", taken)).toBe("Main 2");
  });
});
