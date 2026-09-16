import { describe, it, expect } from "vitest";
import type { HierarchyRef } from "./hierarchies";
import { groupsOf, templateOf } from "./groups";

const H: HierarchyRef[] = [
  { id: "main", name: "Main" },
  { id: "c1", name: "D1.fcs · Main", owner_sample_id: "f1", structure_locked: true, source_hierarchy_id: "main" },
  { id: "c2", name: "D2.fcs · Main", owner_sample_id: "f2", structure_locked: true, source_hierarchy_id: "main" },
  { id: "treated", name: "treated" },
  { id: "c3", name: "D3.fcs · treated", owner_sample_id: "f3", structure_locked: true, source_hierarchy_id: "treated" },
  { id: "c3b", name: "D4.fcs · copy of D3", owner_sample_id: "f4", structure_locked: true, source_hierarchy_id: "c3" },
  { id: "orphan", name: "gone.fcs · Main", owner_sample_id: "f9", structure_locked: true, source_hierarchy_id: "main" },
  { id: "free", name: "Scratch" },
];
const FILES = [
  { id: "f1", name: "D1.fcs" }, { id: "f2", name: "D2.fcs" }, { id: "f3", name: "D3.fcs" },
  { id: "f4", name: "D4.fcs" }, { id: "f5", name: "D5.fcs" }, { id: "f6", name: "D6.fcs" },
];
const ASSIGN = { f1: "c1", f2: "c2", f3: "c3", f4: "c3b", f6: "free" };

describe("groups", () => {
  it("follows a copy up to the tree nobody owns", () => {
    expect(templateOf("c1", H)?.id).toBe("main");
    expect(templateOf("c3b", H)?.id).toBe("treated");
    expect(templateOf("main", H)?.id).toBe("main");
    expect(templateOf("free", H)?.id).toBe("free");
    expect(templateOf("nope", H)).toBeNull();
  });

  it("puts every file in exactly one group, copies beneath their template, unassigned files under the first", () => {
    const groups = groupsOf(H, FILES, ASSIGN, (copy) => copy.id === "c2");
    expect(groups.map((g) => [g.template.name, g.index])).toEqual([["Main", 1], ["treated", 4], ["Scratch", 8]]);
    const main = groups[0];
    expect(main.members.map((m) => [m.fileName, m.treeId, m.tailored])).toEqual([
      ["D1.fcs", "c1", false], ["D2.fcs", "c2", true], ["D5.fcs", "main", null],
    ]);
    expect(main.orphanCopies.map((h) => h.id)).toEqual(["orphan"]);
    const treated = groups[1];
    expect(treated.members.map((m) => [m.fileName, m.treeId])).toEqual([["D3.fcs", "c3"], ["D4.fcs", "c3b"]]);
    expect(groups[2].members.map((m) => m.fileName)).toEqual(["D6.fcs"]);
    // Every loaded file appears once.
    const all = groups.flatMap((g) => g.members.map((m) => m.fileId)).sort();
    expect(all).toEqual(["f1", "f2", "f3", "f4", "f5", "f6"]);
  });
});
