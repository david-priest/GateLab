// A group's working tree, parked in stored_hierarchies, is saved with its owner_group_id, so the
// reopened workspace still treats it as the group's tree after the template is edited.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "./store";
import { workspaceGatingRecord } from "./workspaceRecords";
import type { StoredHierarchy } from "./engine/hierarchies";

function fixture(): CoreState {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 100 });
  for (const name of ["Cells", "CD4_positive"]) {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name,
      xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [100, 100]],
      createPop: { name, parentId: state.active_population_id! } });
  }
  return coreReducer(state, { type: "addGroup", id: "gA", name: "Group A", fileIds: ["D1"] });
}

/** The saved gating, through JSON, loaded back into a fresh store. */
function reopen(state: CoreState): CoreState {
  const g = JSON.parse(JSON.stringify(workspaceGatingRecord(state))) as ReturnType<typeof workspaceGatingRecord>;
  return coreReducer(initialCoreState(), {
    type: "loadWorkspace",
    gates: g.gates, gate_order: g.gate_order, populations: g.populations,
    root_population_id: g.root_population_id, active_population_id: g.active_population_id,
    selected_gate_id: g.selected_gate_id, hierarchies: g.hierarchies, active_hierarchy_id: g.active_hierarchy_id,
    stored_hierarchies: g.stored_hierarchies?.map((h) => ({ ...h, gate_order: h.gate_order ?? Object.keys(h.gates!), selected_pop_ids: [] }) as StoredHierarchy),
    file_hierarchies: {}, groups: g.groups ?? [], file_groups: { D1: "gA" },
  });
}

describe("a group's parked tree in the saved workspace", () => {
  it("is written with its owner_group_id", () => {
    const state = fixture();
    const copyId = state.hierarchies.find((h) => h.owner_group_id === "gA")!.id;
    const saved = workspaceGatingRecord(state).stored_hierarchies!.find((h) => h.id === copyId)!;
    expect(saved.owner_group_id).toBe("gA");
  });

  it("is still the group's tree after the template is edited in the reopened workspace", () => {
    const reopened = reopen(fixture());
    const cells = Object.values(reopened.gates).find((g) => g.name === "Cells")!;
    const edited = coreReducer(reopened, { type: "editGate", gateId: cells.gate_id, vertices: [[5, 5], [100, 100]] });
    expect(edited.hierarchies.some((h) => h.owner_group_id === "gA")).toBe(true);
  });
});
