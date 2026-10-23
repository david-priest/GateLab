// Editing a spider quadrant: the centre moves alone and each arm's end slides along its own edge
// of the box. Synthetic state throughout.

import { describe, it, expect } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "./store";
import type { QuadrantArms, QuadrantGate } from "./engine/models";

const ARMS: QuadrantArms = { down: [1000, 0], right: [4000, 1000], up: [1000, 4000], left: [0, 1000] };

function withSpider(): { state: CoreState; id: string } {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 6 });
  state = coreReducer(state, { type: "addQuadrant", xChannel: "FSC-A", yChannel: "SSC-A", center: [1000, 1000], prefix: "D1", parentId: state.root_population_id!, arms: ARMS });
  const id = Object.values(state.gates).find((g) => g.gate_type === "quadrant")!.gate_id;
  return { state, id };
}
const gate = (s: CoreState, id: string) => s.gates[id] as QuadrantGate;

describe("a spider quadrant in the store", () => {
  it("is created with its arms and four populations", () => {
    const { state, id } = withSpider();
    expect(gate(state, id).arms).toEqual(ARMS);
    const quadrants = Object.values(state.populations).flatMap((p) => p.gate_refs.filter((r) => r.gate_id === id).map((r) => r.quadrant));
    expect(quadrants.sort()).toEqual([1, 2, 3, 4]);
  });

  it("refuses arms that are not valid when it is created, leaving the crosshair", () => {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 6 });
    state = coreReducer(state, { type: "addQuadrant", xChannel: "FSC-A", yChannel: "SSC-A", center: [5000, 1000], prefix: "D2", parentId: state.root_population_id!, arms: ARMS });
    const q = Object.values(state.gates).find((g) => g.gate_type === "quadrant") as QuadrantGate;
    expect(q.arms).toBeUndefined();
  });

  it("moves the centre alone, its arms' ends staying where they are, as one undo step", () => {
    const { state, id } = withSpider();
    const next = coreReducer(state, { type: "moveQuadrantCenter", gateId: id, center: [2000, 3000] });
    expect(gate(next, id).center).toEqual([2000, 3000]);
    expect(gate(next, id).arms).toEqual(ARMS);
    expect(next.undo.length).toBe(state.undo.length + 1);
    expect(next.gates[id]).not.toBe(state.gates[id]);
  });

  it("refuses a centre outside the box the ends span", () => {
    const { state, id } = withSpider();
    expect(coreReducer(state, { type: "moveQuadrantCenter", gateId: id, center: [5000, 1000] })).toBe(state);
    expect(coreReducer(state, { type: "moveQuadrantCenter", gateId: id, center: [1000, 0] })).toBe(state);
  });

  it("slides an arm's end along its own edge, held within the box", () => {
    const { state, id } = withSpider();
    // Dropped above and beyond the box: the down end stays on the bottom edge, at the box's right.
    let next = coreReducer(state, { type: "setQuadrantArm", gateId: id, arm: "down", end: [9000, 2500] });
    expect(gate(next, id).arms!.down).toEqual([4000, 0]);
    next = coreReducer(next, { type: "setQuadrantArm", gateId: id, arm: "left", end: [-50, 3000] });
    expect(gate(next, id).arms!.left).toEqual([0, 3000]);
    expect(gate(next, id).arms!.up).toEqual(ARMS.up);
    expect(gate(next, id).arms!.right).toEqual(ARMS.right);
    expect(gate(next, id).center).toEqual([1000, 1000]);
  });

  it("leaves a quadrant without arms alone when an arm is set", () => {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 6 });
    state = coreReducer(state, { type: "addQuadrant", xChannel: "FSC-A", yChannel: "SSC-A", center: [1000, 1000], prefix: "", parentId: state.root_population_id! });
    const id = Object.values(state.gates).find((g) => g.gate_type === "quadrant")!.gate_id;
    expect(coreReducer(state, { type: "setQuadrantArm", gateId: id, arm: "down", end: [0, 0] })).toBe(state);
  });

  it("undoes an arm's move", () => {
    const { state, id } = withSpider();
    const moved = coreReducer(state, { type: "setQuadrantArm", gateId: id, arm: "up", end: [3000, 4000] });
    expect(gate(moved, id).arms!.up).toEqual([3000, 4000]);
    const undone = coreReducer(moved, { type: "undo" });
    expect(gate(undone, id).arms!.up).toEqual(ARMS.up);
  });
});
