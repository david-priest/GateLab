// Editing a spider quadrant: the centre moves alone and each arm's end slides along its own edge
// of the box. Synthetic state throughout.

import { describe, it, expect } from "vitest";
import { coreReducer, initialCoreState, spiderBoxGrowth, type CoreState } from "./store";
import { gateMaskQuadrant } from "./engine/gates";
import { spiderBox, type QuadrantArms, type QuadrantGate } from "./engine/models";

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

  it("slides an arm's end along its own edge, held within the box; dropped inside, the edge stays", () => {
    const { state, id } = withSpider();
    // Dropped above the bottom edge and past the box's right: the down end stays on the bottom
    // edge, at the box's right. A drag never pulls an edge in.
    let next = coreReducer(state, { type: "setQuadrantArm", gateId: id, arm: "down", end: [9000, 2500] });
    expect(gate(next, id).arms!.down).toEqual([4000, 0]);
    next = coreReducer(next, { type: "setQuadrantArm", gateId: id, arm: "left", end: [50, 3000] });
    expect(gate(next, id).arms!.left).toEqual([0, 3000]);
    expect(gate(next, id).arms!.up).toEqual(ARMS.up);
    expect(gate(next, id).arms!.right).toEqual(ARMS.right);
    expect(gate(next, id).center).toEqual([1000, 1000]);
  });

  it("takes an edge out with an end dropped beyond it, the box growing (David, 2026-11-10)", () => {
    const { state, id } = withSpider();
    let next = coreReducer(state, { type: "setQuadrantArm", gateId: id, arm: "up", end: [2000, 9000] });
    expect(gate(next, id).arms!.up).toEqual([2000, 9000]);
    next = coreReducer(next, { type: "setQuadrantArm", gateId: id, arm: "left", end: [-500, 3000] });
    expect(gate(next, id).arms!.left).toEqual([-500, 3000]);
    // The other ends stay where they were, on edges of the grown box.
    expect(gate(next, id).arms!.down).toEqual(ARMS.down);
    expect(gate(next, id).arms!.right).toEqual(ARMS.right);
    expect(spiderBox(gate(next, id).arms!)).toEqual([-500, 4000, 0, 9000]);
  });

  it("grows the box about the centre to cover a range, no arm turning", () => {
    const { state, id } = withSpider();
    // Centre (1000, 1000); the box is 0-4000 both ways. To reach y 10000 the ends go out 3 times as far.
    const next = coreReducer(state, { type: "growSpiderBox", gateId: id, box: [0, 4000, 0, 10000] });
    expect(gate(next, id).arms).toEqual({ down: [1000, -2000], right: [10000, 1000], up: [1000, 10000], left: [-2000, 1000] });
    expect(next.undo.length).toBe(state.undo.length + 1);
    expect(spiderBoxGrowth(gate(next, id), [0, 4000, 0, 10000])).toBe(1);
    // Already covered: nothing changes.
    expect(coreReducer(state, { type: "growSpiderBox", gateId: id, box: [100, 3000, 100, 3000] })).toBe(state);
  });

  it("draws and counts: an event beyond the top edge joins its quadrant once the box grows", () => {
    // A leaning spider: centre (1000, 1000), up arm to (2000, 4000), right arm to (4000, 1500).
    const arms: QuadrantArms = { down: [800, 0], right: [4000, 1500], up: [2000, 4000], left: [0, 900] };
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
    state = coreReducer(state, { type: "addQuadrant", xChannel: "FSC-A", yChannel: "SSC-A", center: [1000, 1000], prefix: "D1", parentId: state.root_population_id!, arms });
    const id = Object.values(state.gates).find((g) => g.gate_type === "quadrant")!.gate_id;
    // Above the box (y 6000), right of the up arm's line extended (x 3500 > 1000 + 1000 * 5000 / 3000);
    // above the box, left of it; inside the upper-right quadrant; inside the upper-left.
    const xs = [3500, 1500, 3000, 500], ys = [6000, 6000, 3000, 3000];
    const counts = (s: CoreState) => [1, 2, 3, 4].map((q) => {
      const g = gate(s, id);
      return Array.from(gateMaskQuadrant(xs, ys, g.center, q, undefined, g.arms)).reduce((a, b) => a + b, 0);
    });
    // Q1 upper-left, Q2 upper-right: before, the two events above the box are in no quadrant.
    expect(counts(state)).toEqual([1, 1, 0, 0]);
    // Dragging the up end to y 6500 along its own line: the top edge goes out to 6500.
    let next = coreReducer(state, { type: "setQuadrantArm", gateId: id, arm: "up", end: [2833.33, 6500] });
    expect(counts(next)).toEqual([2, 2, 0, 0]);
    // Extend to edges, from the original: the same two events join, by the box growing about the centre.
    next = coreReducer(state, { type: "growSpiderBox", gateId: id, box: [0, 4000, 0, 7000] });
    expect(counts(next)).toEqual([2, 2, 0, 0]);
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
