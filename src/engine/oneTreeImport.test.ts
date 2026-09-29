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

  // The tree's name is decided by the lead (its sample's tree name, else its file's), which is only
  // known once the plan has chosen it: both callers passed "" and renamed the tree afterwards, so
  // each file's copy was named "D2.fcs · " and the FlowJo export dialog listed it as "D2.fcs · D2.fcs ·"
  // (the release candidate's verifier; master the same).
  it("names each file's copy after the tree's name, decided from the lead it chooses", () => {
    const plan = planOneTreeImport(FILES, { templateId: "main", name: (lead) => `strategy of ${lead.fileName}`, leadFileId: "f1", existing: [] });
    expect(plan.template.name).toBe("strategy of D1.fcs");
    expect(plan.copies.map((c) => c.name)).toEqual(["D2.fcs · strategy of D1.fcs", "D4.fcs · strategy of D1.fcs"]);
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

// Two samples of one workspace can label a detector differently: "Aqua" in one file's $PnS and
// "aqua" in the other's, and name a population "Live cells" in one and "live cells" in the
// other. GateLab keys a channel by its label, so the second file's gates were on channels the
// tree did not have: it was reported as carrying a different tree, lost its own gates, and
// followed the tree's -- which name a channel it does not have, and so held no event.
describe("a per-file import where two files label a detector differently", () => {
  const live = (id: string, name: string, x: string, shift: number): StrategyTree => {
    const root = newRootPopulation(1000);
    const gates: Record<string, Gate> = { [id]: poly(id, name, x, "SSC-A", shift) };
    const populations: PopulationMap = {
      [root.population_id]: { ...root, children: ["p-live"] },
      "p-live": { population_id: "p-live", name, gate_refs: [{ gate_id: id, include: true }], gate_logic: "and", parent_id: root.population_id, children: [], event_count: null, percent_of_parent: null },
    };
    return { gates, gate_order: [id], populations, root_population_id: root.population_id };
  };
  const tree1 = live("g1", "live cells", "aqua", 0);
  const tree2 = live("g2", "Live cells", "Aqua", 7);
  const detectors1 = { aqua: "V525-A", "SSC-A": "SSC-A" };
  const detectors2 = { Aqua: "V525-A", "SSC-A": "SSC-A" };

  it("matches the gates by detector, and the file keeps its own gate on its own channel", () => {
    const plan = planOneTreeImport(
      [
        { fileId: "f1", fileName: "D1.fcs", tree: tree1, detectors: detectors1 },
        { fileId: "f2", fileName: "D2.fcs", tree: tree2, detectors: detectors2 },
      ],
      { templateId: "main", name: "Imported", leadFileId: "f1", existing: [] },
    );
    expect(plan.differing).toEqual([]);
    expect(plan.copies).toHaveLength(1);
    const [gate] = Object.values(plan.copies[0].gates);
    // D2's own coordinates, on D2's own channel for that detector, under the tree's name.
    expect(gate).toMatchObject({ x_channel: "Aqua", name: "live cells" });
    expect((gate as unknown as { vertices: number[][] }).vertices[0]).toEqual([17, 10]);
    expect(Object.values(plan.copies[0].populations).map((p) => p.name)).toContain("live cells");
  });

  it("without the detectors, reports a gate drawn on another channel once, not as dropped and following at once", () => {
    const plan = planOneTreeImport(
      [{ fileId: "f1", fileName: "D1.fcs", tree: tree1 }, { fileId: "f2", fileName: "D2.fcs", tree: tree2 }],
      { templateId: "main", name: "Imported", leadFileId: "f1", existing: [] },
    );
    expect(plan.differing).toEqual([{ fileId: "f2", fileName: "D2.fcs", dropped: [], followed: [], redrawn: ["live cells"] }]);
    expect(describeDiffering(plan.differing)).toBe("D2.fcs (drawn on other axes or as another kind, following the tree's: live cells)");
  });

  // Each sample draws its own gate: D2's "Live cells" is a rectangle where the tree's is a
  // polygon, on the same detectors. It is the same gate drawn two ways, and D2 keeps its own; it
  // was reported as another tree and followed the tree's (FR-FCM-Z2C8's staining3: 848 events
  // where its own gate counts FlowJo's 76,134).
  it("keeps a file's own gate of one name on the same detectors when it is drawn as another kind", () => {
    const rect = (t: StrategyTree): StrategyTree => ({ ...t, gates: Object.fromEntries(Object.entries(t.gates).map(([k, g]) => [k, { ...g, gate_type: "rectangle" } as Gate])) });
    const plan = planOneTreeImport(
      [
        { fileId: "f1", fileName: "D1.fcs", tree: tree1, detectors: detectors1 },
        { fileId: "f2", fileName: "D2.fcs", tree: rect(tree2), detectors: detectors2 },
      ],
      { templateId: "main", name: "Imported", leadFileId: "f1", existing: [] },
    );
    expect(plan.differing).toEqual([]);
    const [gate] = Object.values(plan.copies[0].gates);
    expect(gate).toMatchObject({ x_channel: "Aqua", gate_type: "rectangle", name: "live cells" });
  });

  // D2 did not record the tree's "live cells" gate, so it follows the tree's. On the tree's label
  // it named a channel D2 does not have, and held no event, nor did anything beneath it.
  it("puts a gate the file follows on the file's own channel for the same stain, and not for another stain", () => {
    const plan = planOneTreeImport(
      [
        { fileId: "f1", fileName: "D1.fcs", tree: tree1, detectors: detectors1 },
        { fileId: "f2", fileName: "D2.fcs", tree: live("g2", "Live", "Aqua", 7), detectors: detectors2 },
        { fileId: "f3", fileName: "D3.fcs", tree: live("g3", "Live", "CD8", 0), detectors: { CD8: "V525-A", "SSC-A": "SSC-A" } },
      ],
      { templateId: "main", name: "Imported", leadFileId: "f1", existing: [] },
    );
    expect(plan.differing.map((d) => [d.fileName, d.followed])).toEqual([["D2.fcs", ["live cells"]], ["D3.fcs", ["live cells"]]]);
    const copyOf = (id: string) => plan.copies.find((c) => c.owner_sample_id === id);
    // The tree's coordinates, on D2's own "Aqua".
    const [d2] = Object.values(copyOf("f2")!.gates);
    expect(d2).toMatchObject({ x_channel: "Aqua", gate_type: "polygon" });
    expect((d2 as unknown as { vertices: number[][] }).vertices[0]).toEqual([10, 10]);
    // D3 labels the detector as another stain: the tree's gate is left on the tree's label.
    expect(copyOf("f3")).toBeUndefined();
    expect(plan.assignments.f3).toBe("main");
  });

  // The tree's file carries no $PnS for the detector, so its channel is the detector's own name
  // and names no stain; D2 labels it. The gate D2 follows goes on D2's channel for that detector.
  it("puts a gate the file follows on the file's channel when the tree's channel is unlabelled", () => {
    const unlabelled = live("g1", "live cells", "V525-A", 0);
    const plan = planOneTreeImport(
      [
        { fileId: "f1", fileName: "D1.fcs", tree: unlabelled, detectors: { "V525-A": "V525-A", "SSC-A": "SSC-A" } },
        { fileId: "f2", fileName: "D2.fcs", tree: live("g2", "Live", "CD3 Al700", 7), detectors: { "CD3 Al700": "V525-A", "SSC-A": "SSC-A" } },
      ],
      { templateId: "main", name: "Imported", leadFileId: "f1", existing: [] },
    );
    const [gate] = Object.values(plan.copies.find((c) => c.owner_sample_id === "f2")!.gates);
    expect(gate).toMatchObject({ x_channel: "CD3 Al700", gate_type: "polygon" });
  });
});

// An intersection or a complement is a population with no gate of its own: it is defined by other
// populations' gates. A file whose strategy carried one the tree lacks lost it -- its gates were
// all in the tree -- and the result named only gates, so it went without a word. FR-FCM-Z2TL
// carries three Boolean populations on some samples of a workspace and not on the others.
describe("a per-file import where a file carries an intersection or complement the tree lacks", () => {
  const withDerived = (shift: number): StrategyTree => {
    const t = tree(shift, { deep: true });
    const add = (id: string, name: string, refs: { gate_id: string; include: boolean }[]) => {
      t.populations["p-singlets"].children.push(id);
      t.populations[id] = { population_id: id, name, gate_refs: refs, gate_logic: "and", parent_id: "p-singlets", children: [], event_count: null, percent_of_parent: null };
    };
    add("p-both", "Singlets&CD4_positive", [{ gate_id: `singlets-${shift}`, include: true }, { gate_id: `cd4-${shift}`, include: true }]);
    add("p-not", "not CD4", [{ gate_id: `cd4-${shift}`, include: false }]);
    return t;
  };

  it("names it as dropped from the file, and as followed by a file that did not record it", () => {
    const files: TailoredFile[] = [
      { fileId: "f1", fileName: "D1.fcs", tree: tree(0, { deep: true }) },
      { fileId: "f2", fileName: "D2.fcs", tree: withDerived(4) },
    ];
    const plan = planOneTreeImport(files, { templateId: "main", name: "Imported", leadFileId: "f1", existing: [] });
    expect(plan.differing).toEqual([{ fileId: "f2", fileName: "D2.fcs", dropped: ["Singlets&CD4_positive", "not CD4"], followed: [] }]);
    expect(describeDiffering(plan.differing)).toBe("D2.fcs (not in the tree, dropped: Singlets&CD4_positive, not CD4)");
    const reverse = planOneTreeImport(files, { templateId: "main", name: "Imported", leadFileId: "f2", existing: [] });
    expect(reverse.differing).toEqual([{ fileId: "f1", fileName: "D1.fcs", dropped: [], followed: ["Singlets&CD4_positive", "not CD4"] }]);
  });

  it("does not name one the file and the tree both carry", () => {
    const extra = withDerived(2);
    extra.gates["extra-2"] = poly("extra-2", "Extra", "FSC-A", "SSC-A", 2);
    extra.gate_order.push("extra-2");
    extra.populations["p-singlets"].children.push("p-extra");
    extra.populations["p-extra"] = { population_id: "p-extra", name: "Extra", gate_refs: [{ gate_id: "extra-2", include: true }], gate_logic: "and", parent_id: "p-singlets", children: [], event_count: null, percent_of_parent: null };
    const plan = planOneTreeImport(
      [
        { fileId: "f1", fileName: "D1.fcs", tree: withDerived(0) },
        { fileId: "f2", fileName: "D2.fcs", tree: withDerived(4) },
        { fileId: "f3", fileName: "D3.fcs", tree: extra },
      ],
      { templateId: "main", name: "Imported", leadFileId: "f1", existing: [] },
    );
    expect(plan.differing).toEqual([{ fileId: "f3", fileName: "D3.fcs", dropped: ["Extra"], followed: [] }]);
  });
});
