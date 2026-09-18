// Several gates' vertices at once, as one undo step: what the border snap after a pan or stretch
// dispatches. Synthetic state throughout.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState } from "./store";
import type { PolyRectGate } from "./engine/models";

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 20 });
  for (const name of ["Cells", "CD4_positive"]) {
    state = coreReducer(state, { type: "addGate", gateType: "polygon", name, xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [10, 0], [10, 10]] });
  }
  state = coreReducer(state, { type: "addQuadrant", xChannel: "FSC-A", yChannel: "SSC-A", center: [5, 5], prefix: "", parentId: state.root_population_id! });
  const ids = Object.values(state.gates).filter((g) => g.gate_type === "polygon").map((g) => g.gate_id);
  const quadrant = Object.values(state.gates).find((g) => g.gate_type === "quadrant")!.gate_id;
  return { state, ids, quadrant };
}

describe("editGates", () => {
  it("moves every named polygon in one undo step and bumps the gate version once", () => {
    const { state, ids } = fixture();
    const next = coreReducer(state, { type: "editGates", edits: [
      { gateId: ids[0], vertices: [[1, 1], [11, 1], [11, 11]] },
      { gateId: ids[1], vertices: [[2, 2], [12, 2], [12, 12]] },
    ] });
    expect((next.gates[ids[0]] as PolyRectGate).vertices).toEqual([[1, 1], [11, 1], [11, 11]]);
    expect((next.gates[ids[1]] as PolyRectGate).vertices).toEqual([[2, 2], [12, 2], [12, 12]]);
    expect(next.undo).toHaveLength(state.undo.length + 1);
    expect(next.gate_version).toBe(state.gate_version + 1);
    const undone = coreReducer(next, { type: "undo" });
    expect((undone.gates[ids[0]] as PolyRectGate).vertices).toEqual((state.gates[ids[0]] as PolyRectGate).vertices);
    expect((undone.gates[ids[1]] as PolyRectGate).vertices).toEqual((state.gates[ids[1]] as PolyRectGate).vertices);
  });

  it("skips a quadrant, an unknown gate and an empty list without recording anything", () => {
    const { state, ids, quadrant } = fixture();
    expect(coreReducer(state, { type: "editGates", edits: [] })).toBe(state);
    expect(coreReducer(state, { type: "editGates", edits: [{ gateId: quadrant, vertices: [[0, 0]] }, { gateId: "nope", vertices: [[0, 0]] }] })).toBe(state);
    const next = coreReducer(state, { type: "editGates", edits: [{ gateId: quadrant, vertices: [[0, 0]] }, { gateId: ids[0], vertices: [[3, 3], [13, 3], [13, 13]] }] });
    expect(next.gates[quadrant]).toBe(state.gates[quadrant]);
    expect((next.gates[ids[0]] as PolyRectGate).vertices).toEqual([[3, 3], [13, 3], [13, 13]]);
  });
});
