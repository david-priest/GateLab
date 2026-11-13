// A file on a copy whose source tree is gone is still in a group: the copy heads its own.
import { describe, expect, it } from "vitest";
import { groupsOf } from "./groups";

describe("a copy whose source tree no longer exists", () => {
  const hierarchies = [{ id: "main", name: "Main" }, { id: "c", name: "D1 copy", owner_sample_id: "f1", source_hierarchy_id: "gone" }];
  const shape = (groups: ReturnType<typeof groupsOf>) =>
    groups.map((g) => ({ template: g.template.id, members: g.members.map((m) => m.fileId), orphans: g.orphanCopies.map((o) => o.id) }));

  it("heads a group that holds its file", () => {
    const groups = groupsOf(hierarchies, [{ id: "f1", name: "D1.fcs" }, { id: "f2", name: "D2.fcs" }], { f1: "c", f2: "main" });
    expect(shape(groups)).toEqual([
      { template: "main", members: ["f2"], orphans: [] },
      { template: "c", members: ["f1"], orphans: [] },
    ]);
  });

  it("is not listed as its own orphan when its file is not loaded", () => {
    const groups = groupsOf(hierarchies, [{ id: "f2", name: "D2.fcs" }], { f2: "main" });
    expect(shape(groups)).toEqual([
      { template: "main", members: ["f2"], orphans: [] },
      { template: "c", members: [], orphans: [] },
    ]);
  });

  it("leaves a copy whose source is present under its template", () => {
    const whole = [{ id: "main", name: "Main" }, { id: "c", name: "D1 copy", owner_sample_id: "f1", source_hierarchy_id: "main" }];
    expect(shape(groupsOf(whole, [{ id: "f1", name: "D1.fcs" }], { f1: "c" }))).toEqual([{ template: "main", members: ["f1"], orphans: [] }]);
  });
});
