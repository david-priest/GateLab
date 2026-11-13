// A population added while a group's tree is live goes to the template on the template's own
// gate, so the template references no gate it does not hold and the workspace still saves.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "./store";
import { workspaceGatingRecord } from "./workspaceRecords";
import { referencedGateIds } from "./engine/hierarchies";

function fixture(): CoreState {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 100 });
  for (const name of ["Cells", "CD4_positive"]) {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name,
      xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [100, 100]],
      createPop: { name, parentId: state.active_population_id! } });
  }
  return coreReducer(state, { type: "addGroup", id: "gA", name: "Group A", fileIds: ["D1"] });
}

describe("a population added on a group's tree", () => {
  it("is added to the template on the template's own gate", () => {
    let state = fixture();
    const groupTree = state.hierarchies.find((h) => h.owner_group_id === "gA")!;
    state = coreReducer(state, { type: "switchHierarchy", id: groupTree.id, silent: true });
    const cells = Object.values(state.gates).find((g) => g.name === "Cells")!;
    state = coreReducer(state, { type: "addPopulation", name: "CD4_negative", parentId: state.root_population_id!,
      gateRefs: [{ gate_id: cells.gate_id, include: false }] });

    const template = state.stored_hierarchies.main;
    const added = Object.values(template.populations).filter((p) => p.name === "CD4_negative");
    expect(added).toHaveLength(1);
    expect(added[0].gate_refs).toHaveLength(1);
    expect(template.gates[added[0].gate_refs[0].gate_id]?.name).toBe("Cells");
    expect(added[0].gate_refs[0].include).toBe(false);
    // Every tree the workspace writes names only gates it holds.
    for (const tree of workspaceGatingRecord(state).stored_hierarchies!) {
      for (const id of referencedGateIds(tree.populations)) expect(tree.gates![id]).toBeDefined();
    }
  });
});
