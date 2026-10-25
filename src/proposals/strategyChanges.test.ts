import { expect, it } from "vitest";
import { coreReducer, initialCoreState } from "../store";
import { storeHierarchy } from "../engine/hierarchies";
import { strategyChanges } from "./strategyProposal";

it("does not report a refreshed parked snapshot of the live tree as a new scope edit", () => {
  let base = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
  base = coreReducer(base, { type: "addGate", gateType: "rectangle", name: "Cells", xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [2, 2]] });
  const ref = base.hierarchies.find((h) => h.id === base.active_hierarchy_id)!;
  const live = storeHierarchy(ref, base);
  const id = base.gate_order[0];
  const parked = { ...live, gates: { ...live.gates, [id]: { ...live.gates[id], vertices: [[0, 0], [1, 1]] as [number, number][] } } };
  base = { ...base, stored_hierarchies: { ...base.stored_hierarchies, [ref.id]: parked } };
  const next = { ...base, stored_hierarchies: { ...base.stored_hierarchies, [ref.id]: live } };
  expect(strategyChanges(base, next)).toMatchObject({ changedGateIds: [], scopedGateChanges: [] });
});
