// A template and a locked copy of it, synthetic; the template moves, grows, shrinks and renames.

import { describe, it, expect } from "vitest";
import type { Gate, PopulationMap } from "./models";
import { newRootPopulation } from "./models";
import { cloneHierarchyTree, type StoredHierarchy } from "./hierarchies";
import { copyInStep, gateGeometryEquals, syncLockedCopy, tailoredGateIds, type TemplateTree } from "./templateSync";

function poly(id: string, name: string, x: string, y: string, shift: number): Gate {
  return {
    gate_id: id, name, gate_type: "polygon", x_channel: x, y_channel: y,
    vertices: [[10 + shift, 10], [90 + shift, 10], [90 + shift, 90], [10 + shift, 90]],
    color: "#123456", label_offset: null,
  } as unknown as Gate;
}

function template(shift = 0): TemplateTree {
  const root = newRootPopulation(1000);
  const gates: Record<string, Gate> = {
    cells: poly("cells", "Cells", "FSC-A", "SSC-A", shift),
    singlets: poly("singlets", "Singlets", "FSC-A", "FSC-H", shift),
  };
  const populations: PopulationMap = {
    [root.population_id]: { ...root, children: ["p-cells"] },
    "p-cells": { population_id: "p-cells", name: "Cells", gate_refs: [{ gate_id: "cells", include: true }], gate_logic: "and", parent_id: root.population_id, children: ["p-singlets"], event_count: null, percent_of_parent: null, colorSlot: 0 },
    "p-singlets": { population_id: "p-singlets", name: "Singlets", gate_refs: [{ gate_id: "singlets", include: true }], gate_logic: "and", parent_id: "p-cells", children: [], event_count: null, percent_of_parent: null, colorSlot: 1 },
  };
  return { gates, gate_order: ["cells", "singlets"], populations, root_population_id: root.population_id };
}

function lockedCopy(t: TemplateTree): StoredHierarchy {
  const c = cloneHierarchyTree(t.populations, t.root_population_id, t.gates, t.gate_order);
  const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
  return {
    id: "copy", name: "D1.fcs · Main", owner_sample_id: "f1", structure_locked: true, source_hierarchy_id: "main",
    source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
    gates: c.gates, gate_order: c.gate_order, populations: c.populations, root_population_id: c.root_population_id,
    active_population_id: c.root_population_id, selected_pop_ids: [],
  };
}
const verts = (g: Gate) => (g as unknown as { vertices: number[][] }).vertices;
/** The same template with every gate slid by `shift`: ids unchanged, geometry moved. */
function shifted(t: TemplateTree, shift: number): TemplateTree {
  const out: TemplateTree = structuredClone(t);
  for (const g of Object.values(out.gates)) (g as unknown as { vertices: number[][] }).vertices = verts(g).map(([x, y]) => [x + shift, y]);
  return out;
}
const gateNamed = (h: { gates: Record<string, Gate> }, name: string) => Object.values(h.gates).find((g) => g.name === name)!;
const popNamed = (h: { populations: PopulationMap }, name: string) => Object.values(h.populations).find((p) => p.name === name)!;

describe("a locked copy follows its template", () => {
  it("compares geometry, not names or colours", () => {
    expect(gateGeometryEquals(poly("a", "Cells", "FSC-A", "SSC-A", 0), poly("b", "Other", "FSC-A", "SSC-A", 0))).toBe(true);
    expect(gateGeometryEquals(poly("a", "Cells", "FSC-A", "SSC-A", 0), poly("a", "Cells", "FSC-A", "SSC-A", 1))).toBe(false);
  });

  it("moves an untailored gate with the template and leaves a tailored one where the file put it", () => {
    const before = template();
    const copy = lockedCopy(before);
    // The file tailored Singlets by 30; Cells is untouched.
    const tailoredCopy: StoredHierarchy = { ...copy, gates: { ...copy.gates } };
    const singletsId = Object.keys(copy.gates).find((id) => copy.gates[id].name === "Singlets")!;
    tailoredCopy.gates[singletsId] = poly(singletsId, "Singlets", "FSC-A", "FSC-H", 30);
    expect(copyInStep(tailoredCopy, before)).toBe(true);
    // The template moves both gates by 5.
    const after = shifted(before, 5);
    const synced = syncLockedCopy(tailoredCopy, before, after)!;
    expect(synced).not.toBeNull();
    expect(verts(gateNamed(synced, "Cells"))[0]).toEqual([15, 10]);
    expect(verts(gateNamed(synced, "Singlets"))[0]).toEqual([40, 10]);
    // Ids kept, provenance kept.
    expect(Object.keys(synced.gates).sort()).toEqual(Object.keys(copy.gates).sort());
    expect(Object.keys(synced.populations).sort()).toEqual(Object.keys(copy.populations).sort());
    expect(synced.source_gate_ids).toEqual(copy.source_gate_ids);
    expect(synced.owner_sample_id).toBe("f1");
    expect(synced.structure_locked).toBe(true);
  });

  it("carries a new gate and population into the copy with fresh ids and provenance", () => {
    const before = template();
    const copy = lockedCopy(before);
    const after: TemplateTree = structuredClone(before);
    after.gates.cd4 = poly("cd4", "CD4_positive", "FITC-A", "PE-A", 0);
    after.gate_order.push("cd4");
    after.populations["p-cd4"] = { population_id: "p-cd4", name: "CD4_positive", gate_refs: [{ gate_id: "cd4", include: true }], gate_logic: "and", parent_id: "p-singlets", children: [], event_count: null, percent_of_parent: null, colorSlot: 2 };
    after.populations["p-singlets"].children = ["p-cd4"];
    const synced = syncLockedCopy(copy, before, after)!;
    const cd4 = popNamed(synced, "CD4_positive");
    expect(cd4).toBeDefined();
    expect(cd4.population_id).not.toBe("p-cd4");
    expect(synced.source_population_ids![cd4.population_id]).toBe("p-cd4");
    expect(synced.populations[cd4.parent_id!].name).toBe("Singlets");
    expect(synced.populations[popNamed(synced, "Singlets").population_id].children).toEqual([cd4.population_id]);
    const cd4Gate = synced.gates[cd4.gate_refs[0].gate_id];
    expect(cd4Gate.name).toBe("CD4_positive");
    expect(cd4Gate.gate_id).not.toBe("cd4");
    expect(synced.source_gate_ids![cd4Gate.gate_id]).toBe("cd4");
    expect(synced.gate_order).toHaveLength(3);
    for (const p of Object.values(synced.populations)) for (const r of p.gate_refs) expect(synced.gates[r.gate_id]).toBeDefined();
  });

  it("removes what the template removed, renames what it renamed, and keeps the copy's own counts and colours", () => {
    const before = template();
    const copy = lockedCopy(before);
    const singletsCopyId = popNamed(copy, "Singlets").population_id;
    const withCounts: StoredHierarchy = { ...copy, populations: { ...copy.populations, [singletsCopyId]: { ...copy.populations[singletsCopyId], event_count: 42, colorSlot: 7 } } };
    const after: TemplateTree = structuredClone(before);
    after.populations["p-cells"].name = "Live cells";
    after.gates.cells.name = "Live cells";
    after.gates.cells.color = "#ff0000";
    const synced = syncLockedCopy(withCounts, before, after)!;
    expect(popNamed(synced, "Live cells")).toBeDefined();
    expect(gateNamed(synced, "Live cells").color).toBe("#ff0000");
    expect(synced.populations[singletsCopyId].event_count).toBe(42);
    expect(synced.populations[singletsCopyId].colorSlot).toBe(7);
    // Now delete Singlets from the template.
    const shrunk: TemplateTree = structuredClone(after);
    delete shrunk.populations["p-singlets"]; shrunk.populations["p-cells"].children = [];
    delete shrunk.gates.singlets; shrunk.gate_order = ["cells"];
    const synced2 = syncLockedCopy(synced, after, shrunk)!;
    expect(Object.values(synced2.populations).map((p) => p.name).sort()).toEqual(["All Events", "Live cells"]);
    expect(Object.keys(synced2.gates)).toHaveLength(1);
    expect(synced2.active_population_id).toBe(synced2.root_population_id);
  });

  it("leaves a copy alone when it was already out of step, and when nothing would change", () => {
    const before = template();
    const copy = lockedCopy(before);
    // A copy that grew a population of its own while unlocked.
    const diverged: StoredHierarchy = structuredClone(copy);
    const extra = { population_id: "own", name: "Own", gate_refs: [], gate_logic: "and" as const, parent_id: copy.root_population_id, children: [], event_count: null, percent_of_parent: null };
    diverged.populations.own = extra;
    diverged.populations[copy.root_population_id!].children = [...copy.populations[copy.root_population_id!].children, "own"];
    expect(copyInStep(diverged, before)).toBe(false);
    expect(syncLockedCopy(diverged, before, shifted(before, 5))).toBeNull();
    // A cosmetic-only change to the template that the copy already has.
    expect(syncLockedCopy(copy, before, before)).toBeNull();
  });

  it("names the copy's tailored gates by the copy's own ids", () => {
    const before = template();
    const copy = lockedCopy(before);
    expect(tailoredGateIds(copy, before).size).toBe(0);
    const singletsId = Object.keys(copy.gates).find((id) => copy.gates[id].name === "Singlets")!;
    const tailored: StoredHierarchy = { ...copy, gates: { ...copy.gates, [singletsId]: poly(singletsId, "Singlets", "FSC-A", "FSC-H", 30) } };
    expect([...tailoredGateIds(tailored, before)]).toEqual([singletsId]);
    // Renaming or recolouring in the copy is not tailoring.
    const cellsId = Object.keys(copy.gates).find((id) => copy.gates[id].name === "Cells")!;
    const recoloured: StoredHierarchy = { ...copy, gates: { ...copy.gates, [cellsId]: { ...copy.gates[cellsId], color: "#000000" } } };
    expect(tailoredGateIds(recoloured, before).size).toBe(0);
    // Without a template nothing is tailored; a gate whose source is gone is.
    expect(tailoredGateIds(copy, null).size).toBe(0);
    const shrunk: TemplateTree = { ...before, gates: { cells: before.gates.cells }, gate_order: ["cells"] };
    expect([...tailoredGateIds(copy, shrunk)]).toEqual([singletsId]);
  });
});
