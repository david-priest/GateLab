// A quadrant gate's four labels each keep their own dragged offset. Synthetic state throughout.

import { describe, it, expect } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "./store";
import type { QuadrantGate } from "./engine/models";
import { gateGeometryEquals, withGeometryOf } from "./engine/templateSync";

function withQuadrant(): { state: CoreState; id: string } {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 6 });
  state = coreReducer(state, { type: "addQuadrant", xChannel: "FSC-A", yChannel: "SSC-A", center: [1000, 1000], prefix: "", parentId: state.root_population_id! });
  const id = Object.values(state.gates).find((g) => g.gate_type === "quadrant")!.gate_id;
  return { state, id };
}

describe("quadrant label offsets", () => {
  it("moves one quadrant's label, keeps the others, and records no undo entry", () => {
    const { state, id } = withQuadrant();
    const undoDepth = state.undo.length;
    let next = coreReducer(state, { type: "moveGateLabel", gateId: id, labelOffset: [1, 2], quadrant: 2 });
    expect((next.gates[id] as QuadrantGate).quadrant_label_offsets).toEqual([null, null, [1, 2], null]);
    expect(next.gates[id].label_offset).toBe(state.gates[id].label_offset);
    expect(next.undo).toHaveLength(undoDepth);
    next = coreReducer(next, { type: "moveGateLabel", gateId: id, labelOffset: [-3, 0], quadrant: 0 });
    expect((next.gates[id] as QuadrantGate).quadrant_label_offsets).toEqual([[-3, 0], null, [1, 2], null]);
    // The gate label itself is still its own thing.
    next = coreReducer(next, { type: "moveGateLabel", gateId: id, labelOffset: [5, 5] });
    expect(next.gates[id].label_offset).toEqual([5, 5]);
    expect((next.gates[id] as QuadrantGate).quadrant_label_offsets).toEqual([[-3, 0], null, [1, 2], null]);
  });

  it("refuses a quadrant index that is not one of the four, and a quadrant on a polygon", () => {
    const { state, id } = withQuadrant();
    expect(coreReducer(state, { type: "moveGateLabel", gateId: id, labelOffset: [1, 1], quadrant: 4 })).toBe(state);
    expect(coreReducer(state, { type: "moveGateLabel", gateId: id, labelOffset: [1, 1], quadrant: -1 })).toBe(state);
    const poly = coreReducer(state, { type: "addGate", gateType: "rectangle", xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [1, 1]], name: "Cells" });
    const pid = Object.values(poly.gates).find((g) => g.gate_type === "rectangle")!.gate_id;
    expect(coreReducer(poly, { type: "moveGateLabel", gateId: pid, labelOffset: [1, 1], quadrant: 1 })).toBe(poly);
  });

  it("is cosmetic: it never counts as tailoring, and pushing geometry keeps the target's labels", () => {
    const { state, id } = withQuadrant();
    const moved = coreReducer(state, { type: "moveGateLabel", gateId: id, labelOffset: [1, 2], quadrant: 1 });
    expect(gateGeometryEquals(state.gates[id], moved.gates[id])).toBe(true);
    const shifted = { ...moved.gates[id], center: [2000, 2000] } as QuadrantGate;
    const pushed = withGeometryOf(state.gates[id], shifted) as QuadrantGate;
    expect(pushed.center).toEqual([2000, 2000]);
    expect(pushed.quadrant_label_offsets).toBeUndefined(); // the target had none
    const back = withGeometryOf(moved.gates[id], state.gates[id]) as QuadrantGate;
    expect(back.quadrant_label_offsets).toEqual([null, [1, 2], null, null]); // the target keeps its own
  });
});
