// Synthetic strategies: the same tree gated on three files with tailored coordinates, and one
// file with a population more. Nothing here is a real experiment.

import { describe, it, expect } from "vitest";
import type { Gate, PopulationMap } from "./models";
import { newRootPopulation } from "./models";
import { gateIdentity, groupByStructure, planPerFileImport, strategyStructureKey, tailoredCopy, templateNameFromOrigin, type StrategyTree, type TailoredFile } from "./tailoredImport";

function poly(id: string, name: string, x: string, y: string, shift: number): Gate {
  return {
    gate_id: id, name, gate_type: "polygon", x_channel: x, y_channel: y,
    vertices: [[10 + shift, 10], [90 + shift, 10], [90 + shift, 90], [10 + shift, 90]],
    color: "#123456", label_offset: null,
  } as unknown as Gate;
}

/** root → Cells (gate cells) → Singlets (gate singlets) [→ CD4_positive (gate cd4) when `deep`]. */
function tree(shift: number, deep = false): StrategyTree {
  const root = newRootPopulation(1000);
  const gates: Record<string, Gate> = {
    [`cells-${shift}`]: poly(`cells-${shift}`, "Cells", "FSC-A", "SSC-A", shift),
    [`singlets-${shift}`]: poly(`singlets-${shift}`, "Singlets", "FSC-A", "FSC-H", shift),
  };
  const populations: PopulationMap = {
    [root.population_id]: { ...root, children: ["p-cells"] },
    "p-cells": { population_id: "p-cells", name: "Cells", gate_refs: [{ gate_id: `cells-${shift}`, include: true }], gate_logic: "and", parent_id: root.population_id, children: ["p-singlets"], event_count: null, percent_of_parent: null },
    "p-singlets": { population_id: "p-singlets", name: "Singlets", gate_refs: [{ gate_id: `singlets-${shift}`, include: true }], gate_logic: "and", parent_id: "p-cells", children: [], event_count: null, percent_of_parent: null },
  };
  if (deep) {
    gates[`cd4-${shift}`] = poly(`cd4-${shift}`, "CD4_positive", "FITC-A", "PE-A", shift);
    populations["p-singlets"].children = ["p-cd4"];
    populations["p-cd4"] = { population_id: "p-cd4", name: "CD4_positive", gate_refs: [{ gate_id: `cd4-${shift}`, include: true }], gate_logic: "and", parent_id: "p-singlets", children: [], event_count: null, percent_of_parent: null };
  }
  return { gates, gate_order: Object.keys(gates), populations, root_population_id: root.population_id };
}

const FILES: TailoredFile[] = [
  { fileId: "f1", fileName: "D1.fcs", tree: tree(0), origin: "All Samples" },
  { fileId: "f2", fileName: "D2.fcs", tree: tree(5), origin: "All Samples" },
  { fileId: "f3", fileName: "D3.fcs", tree: tree(9), origin: "All Samples" },
  { fileId: "f4", fileName: "D4.fcs", tree: tree(0, true), origin: "treated" },
];

describe("a per-file import as one structure tailored per file", () => {
  it("keys a structure by its populations and gate identities, not by geometry", () => {
    expect(strategyStructureKey(tree(0))).toBe(strategyStructureKey(tree(7)));
    expect(strategyStructureKey(tree(0))).not.toBe(strategyStructureKey(tree(0, true)));
    expect(gateIdentity(poly("a", "Cells", "FSC-A", "SSC-A", 0))).toBe(gateIdentity(poly("b", "Cells", "FSC-A", "SSC-A", 40)));
    expect(gateIdentity(poly("a", "Cells", "FSC-A", "SSC-A", 0))).not.toBe(gateIdentity(poly("a", "Cells", "FSC-A", "SSC-H", 0)));
  });

  it("groups files by structure and lets the chosen file lead", () => {
    const groups = groupByStructure(FILES, "f2");
    expect(groups.map((g) => g.files.map((f) => f.fileId))).toEqual([["f1", "f2", "f3"], ["f4"]]);
    expect(groups[0].lead.fileId).toBe("f2");
    expect(groups[1].lead.fileId).toBe("f4");
    expect(groupByStructure(FILES)[0].lead.fileId).toBe("f1");
  });

  it("makes a locked, file-owned copy of the template carrying the file's own coordinates", () => {
    const template = { id: "T", name: "All Samples", tree: tree(0) };
    const copy = tailoredCopy(template, FILES[2], [{ id: "T", name: "All Samples" }]);
    expect(copy.owner_sample_id).toBe("f3");
    expect(copy.structure_locked).toBe(true);
    expect(copy.source_hierarchy_id).toBe("T");
    expect(copy.name).toBe("D3.fcs · All Samples");
    // Fresh ids, mapped back to the template's.
    expect(Object.keys(copy.gates)).not.toContain("cells-0");
    for (const [copyId, sourceId] of Object.entries(copy.source_gate_ids!)) {
      expect(template.tree.gates[sourceId]).toBeDefined();
      expect(copy.gates[copyId].name).toBe(template.tree.gates[sourceId].name);
    }
    for (const [copyId, sourceId] of Object.entries(copy.source_population_ids!)) {
      expect(copy.populations[copyId].name).toBe(template.tree.populations[sourceId].name);
    }
    // The file's geometry (shift 9), the template's colour.
    const cells = Object.values(copy.gates).find((g) => g.name === "Cells")!;
    expect((cells as unknown as { vertices: number[][] }).vertices[0]).toEqual([19, 10]);
    expect(cells.color).toBe("#123456");
    // Every reference in the copy resolves inside the copy.
    for (const p of Object.values(copy.populations)) for (const r of p.gate_refs) expect(copy.gates[r.gate_id]).toBeDefined();
  });

  it("plans templates and copies: the primary's group takes the active hierarchy when replacing", () => {
    const plan = planPerFileImport(FILES, {
      existing: [{ id: "main", name: "Main" }],
      activeHierarchyId: "main",
      primaryFileId: "f1",
      replaceActive: true,
      nameFor: (g, i) => templateNameFromOrigin(g, `Strategy ${i + 1}`),
    });
    expect(plan.activeTemplate?.name).toBe("All Samples");
    expect(plan.activeTemplate?.tree).toBe(FILES[0].tree);
    expect(plan.newTemplates.map((t) => t.name)).toEqual(["treated"]);
    expect(plan.copies).toHaveLength(4);
    expect(Object.keys(plan.assignments).sort()).toEqual(["f1", "f2", "f3", "f4"]);
    const f2 = plan.copies.find((c) => c.id === plan.assignments["f2"])!;
    expect(f2.source_hierarchy_id).toBe("main");
    expect(f2.name).toBe("D2.fcs · All Samples");
    const f4 = plan.copies.find((c) => c.id === plan.assignments["f4"])!;
    expect(f4.source_hierarchy_id).toBe(plan.newTemplates[0].id);
    expect(plan.summary).toEqual(["All Samples (D1.fcs, D2.fcs, D3.fcs)", "treated (D4.fcs)"]);
    // Names stay unique among everything, including the copies.
    const names = [...plan.newTemplates, ...plan.copies].map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps the active hierarchy when merging, and makes every template new", () => {
    const plan = planPerFileImport(FILES.slice(0, 2), {
      existing: [{ id: "main", name: "All Samples" }],
      activeHierarchyId: "main",
      primaryFileId: "f1",
      replaceActive: false,
      nameFor: (g, i) => templateNameFromOrigin(g, `Strategy ${i + 1}`),
    });
    expect(plan.activeTemplate).toBeNull();
    expect(plan.newTemplates.map((t) => t.name)).toEqual(["All Samples 2"]);
    expect(plan.copies.map((c) => c.name)).toEqual(["D1.fcs · All Samples 2", "D2.fcs · All Samples 2"]);
  });

  it("names a template after a common origin, else the fallback", () => {
    const [shared, own] = groupByStructure(FILES);
    expect(templateNameFromOrigin(shared, "x")).toBe("All Samples");
    expect(templateNameFromOrigin({ ...shared, files: [FILES[0], { ...FILES[1], origin: "other" }] }, "fallback")).toBe("fallback");
    expect(templateNameFromOrigin(own, "x")).toBe("treated");
  });
});
