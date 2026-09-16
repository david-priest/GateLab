// Option-drag: the same gates under another parent. Synthetic populations throughout.

import { describe, it, expect } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "./store";

/** root → A (gate a) → A1 (gate a1); root → B. */
function fixture(): { state: CoreState; a: string; a1: string; b: string; gateA: string; gateA1: string } {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 10 });
  const root = state.root_population_id!;
  state = coreReducer(state, { type: "addGate", gateType: "rectangle", xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [1, 1]], name: "gate a", createPop: { name: "A", parentId: root } });
  const a = state.populations[root].children[0];
  state = coreReducer(state, { type: "addGate", gateType: "rectangle", xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [2, 2]], name: "gate a1", createPop: { name: "A1", parentId: a } });
  const a1 = state.populations[a].children[0];
  state = coreReducer(state, { type: "addPopulation", name: "B", parentId: root, gateRefs: [] });
  const b = state.populations[root].children.find((id) => id !== a)!;
  return { state, a, a1, b, gateA: state.populations[a].gate_refs[0].gate_id, gateA1: state.populations[a1].gate_refs[0].gate_id };
}

describe("copying populations to another parent", () => {
  it("clones the subtree under fresh ids, sharing the gates, and leaves the originals in place", () => {
    const { state, a, a1, b, gateA, gateA1 } = fixture();
    const next = coreReducer(state, { type: "copyPopulations", popIds: [a], targetId: b, placement: "inside" });
    expect(next).not.toBe(state);
    const copyA = next.populations[b].children[0];
    expect(copyA).not.toBe(a);
    expect(next.populations[copyA]).toMatchObject({ name: "A", parent_id: b });
    expect(next.populations[copyA].gate_refs.map((r) => r.gate_id)).toEqual([gateA]);
    const copyA1 = next.populations[copyA].children[0];
    expect(copyA1).not.toBe(a1);
    expect(next.populations[copyA1]).toMatchObject({ name: "A1", parent_id: copyA });
    expect(next.populations[copyA1].gate_refs.map((r) => r.gate_id)).toEqual([gateA1]);
    // The originals, and the gate table, are untouched; the copies and the originals share gates.
    expect(next.populations[a]).toEqual(state.populations[a]);
    expect(next.gates).toBe(state.gates);
    expect(next.undo).toHaveLength(state.undo.length + 1);
    // Undo takes the copies away again.
    expect(coreReducer(next, { type: "undo" }).populations).toEqual(state.populations);
  });

  it("places the copies as a move would: before or after a sibling, and prunes a copied ancestor's descendants", () => {
    const { state, a, a1, b } = fixture();
    const root = state.root_population_id!;
    // A1 with A: one copy of A (with A1 inside), not A and a stray A1.
    const before = coreReducer(state, { type: "copyPopulations", popIds: [a1, a], targetId: b, placement: "before" });
    const rootChildren = before.populations[root].children;
    expect(rootChildren).toHaveLength(3);
    expect(rootChildren.indexOf(b)).toBe(2);
    const copy = rootChildren[1];
    expect(before.populations[copy].name).toBe("A");
    expect(before.populations[copy].children).toHaveLength(1);
    const after = coreReducer(state, { type: "copyPopulations", popIds: [a], targetId: a, placement: "after" });
    expect(after.populations[root].children.map((id) => after.populations[id].name)).toEqual(["A", "A", "B"]);
  });

  it("refuses the root, an unknown target, and a sibling placement whose target is not a child of the parent", () => {
    const { state, a, b } = fixture();
    expect(coreReducer(state, { type: "copyPopulations", popIds: [state.root_population_id!], targetId: b, placement: "inside" })).toBe(state);
    expect(coreReducer(state, { type: "copyPopulations", popIds: [a], targetId: "nowhere", placement: "inside" })).toBe(state);
    expect(coreReducer(state, { type: "copyPopulations", popIds: [a], targetId: state.root_population_id!, placement: "after" })).toBe(state);
  });
});
