// The gates a delete acts on. Synthetic gates g1 and g2; nothing here is a real experiment.
import { describe, expect, it } from "vitest";
import { gateIdsToDelete } from "./gateSelection";
import type { CoreState } from "../store";

const state = (over: Partial<CoreState>): CoreState => ({
  hierarchies: [{ id: "main" }], active_hierarchy_id: "main", selected_gate_ids: [], selected_gate_id: null, ...over,
} as unknown as CoreState);

describe("gateIdsToDelete", () => {
  it("takes the checked gates first, else the selected one, else none", () => {
    expect(gateIdsToDelete(state({ selected_gate_ids: ["g1", "g2"], selected_gate_id: "g1" }))).toEqual(["g1", "g2"]);
    expect(gateIdsToDelete(state({ selected_gate_id: "g2" }))).toEqual(["g2"]);
    expect(gateIdsToDelete(state({}))).toEqual([]);
  });

  it("deletes nothing while the live tree's structure is locked", () => {
    expect(gateIdsToDelete(state({ hierarchies: [{ id: "main", structure_locked: true }] as never, selected_gate_id: "g1" }))).toEqual([]);
  });
});
