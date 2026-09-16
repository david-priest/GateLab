// Synthetic strategies: one tree on four files, one of which has a gate more and one a gate
// fewer. Donors D1 to D4; nothing here is a real experiment.

import { describe, it, expect } from "vitest";
import type { Gate, PopulationMap } from "./models";
import { newRootPopulation } from "./models";
import type { StrategyTree, TailoredFile } from "./tailoredImport";
import { describeDiffering, planOneTreeImport } from "./oneTreeImport";

function poly(id: string, name: string, x: string, y: string, shift: number): Gate {
  return {
    gate_id: id, name, gate_type: "polygon", x_channel: x, y_channel: y,
    vertices: [[10 + shift, 10], [90 + shift, 10], [90 + shift, 90], [10 + shift, 90]],
    color: "#123456", label_offset: null,
  } as unknown as Gate;
}

/** root → Cells → Singlets [→ CD4_positive when deep]; `shallow` stops at Cells. */
function tree(shift: number, opts: { deep?: boolean; shallow?: boolean } = {}): StrategyTree {
  const root = newRootPopulation(1000);
  const gates: Record<string, Gate> = { [`cells-${shift}`]: poly(`cells-${shift}`, "Cells", "FSC-A", "SSC-A", shift) };
  const populations: PopulationMap = {
    [root.population_id]: { ...root, children: ["p-cells"] },
    "p-cells": { population_id: "p-cells", name: "Cells", gate_refs: [{ gate_id: `cells-${shift}`, include: true }], gate_logic: "and", parent_id: root.population_id, children: [], event_count: null, percent_of_parent: null },
  };
  if (!opts.shallow) {
    gates[`singlets-${shift}`] = poly(`singlets-${shift}`, "Singlets", "FSC-A", "FSC-H", shift);
    populations["p-cells"].children = ["p-singlets"];
    populations["p-singlets"] = { population_id: "p-singlets", name: "Singlets", gate_refs: [{ gate_id: `singlets-${shift}`, include: true }], gate_logic: "and", parent_id: "p-cells", children: [], event_count: null, percent_of_parent: null };
  }
  if (opts.deep) {
    gates[`cd4-${shift}`] = poly(`cd4-${shift}`, "CD4_positive", "FITC-A", "PE-A", shift);
    populations["p-singlets"].children = ["p-cd4"];
    populations["p-cd4"] = { population_id: "p-cd4", name: "CD4_positive", gate_refs: [{ gate_id: `cd4-${shift}`, include: true }], gate_logic: "and", parent_id: "p-singlets", children: [], event_count: null, percent_of_parent: null };
  }
  return { gates, gate_order: Object.keys(gates), populations, root_population_id: root.population_id };
}

const FILES: TailoredFile[] = [
  { fileId: "f1", fileName: "D1.fcs", tree: tree(0) },
  { fileId: "f2", fileName: "D2.fcs", tree: tree(5) },
  { fileId: "f3", fileName: "D3.fcs", tree: tree(0) },
  { fileId: "f4", fileName: "D4.fcs", tree: tree(3, { deep: true }) },
  { fileId: "f5", fileName: "D5.fcs", tree: tree(0, { shallow: true }) },
];

describe("a per-file import as one tree tailored per file", () => {
  it("takes the viewed file's strategy as the tree and keeps a copy only where coordinates differ", () => {
    const plan = planOneTreeImport(FILES, { templateId: "main", name: "Imported", leadFileId: "f1", existing: [{ id: "main", name: "Main" }] });
    expect(plan.template).toMatchObject({ id: "main", name: "Imported" });
    expect(plan.lead.fileId).toBe("f1");
    expect(Object.keys(plan.template.tree.gates)).toEqual(["cells-0", "singlets-0"]);
    // D1 is the tree; D3 and D5 record the same coordinates; D2 and D4 are shifted.
    expect(plan.copies.map((c) => c.owner_sample_id)).toEqual(["f2", "f4"]);
    expect(plan.assignments).toEqual({ f1: "main", f2: plan.copies[0].id, f3: "main", f4: plan.copies[1].id, f5: "main" });
    expect(plan.following).toBe(3);
    for (const copy of plan.copies) {
      expect(copy).toMatchObject({ structure_locked: true, source_hierarchy_id: "main" });
      expect(Object.keys(copy.gates)).toHaveLength(2); // the tree's structure, never the file's
    }
  });

  it("reports the files whose structure differs: what was dropped and what follows the tree", () => {
    const plan = planOneTreeImport(FILES, { templateId: "main", name: "Imported", leadFileId: "f1", existing: [] });
    expect(plan.differing).toEqual([
      { fileId: "f4", fileName: "D4.fcs", dropped: ["CD4_positive"], followed: [] },
      { fileId: "f5", fileName: "D5.fcs", dropped: [], followed: ["Singlets"] },
    ]);
    expect(describeDiffering(plan.differing)).toBe(
      "D4.fcs (not in the tree, dropped: CD4_positive); D5.fcs (not recorded, following the tree: Singlets)",
    );
  });

  it("leads with the largest structure group when no file is chosen", () => {
    const plan = planOneTreeImport(FILES, { templateId: "main", name: "Imported", leadFileId: null, existing: [] });
    expect(plan.lead.fileId).toBe("f1");
    const deepFirst = planOneTreeImport([FILES[3], FILES[4], FILES[1]], { templateId: "main", name: "Imported", leadFileId: null, existing: [] });
    // Three groups of one: the first seen leads.
    expect(deepFirst.lead.fileId).toBe("f4");
    expect(Object.keys(deepFirst.template.tree.gates)).toHaveLength(3);
  });

  it("follows the chosen file even when its structure is the minority", () => {
    const plan = planOneTreeImport(FILES, { templateId: "main", name: "Imported", leadFileId: "f5", existing: [] });
    expect(plan.lead.fileId).toBe("f5");
    expect(Object.keys(plan.template.tree.gates)).toEqual(["cells-0"]);
    // Everyone else has Singlets, which the tree lacks: dropped and said so.
    expect(plan.differing.map((d) => d.fileName)).toEqual(["D1.fcs", "D2.fcs", "D3.fcs", "D4.fcs"]);
    expect(plan.differing[3].dropped).toEqual(["Singlets", "CD4_positive"]);
    expect(plan.copies.map((c) => c.owner_sample_id)).toEqual(["f2", "f4"]);
  });
});
