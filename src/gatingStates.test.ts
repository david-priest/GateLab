// Saved gating states: the gating saved by name, and restored as one undo entry. Synthetic files
// D1 to D3 and gates Cells / CD4_positive throughout.

import { describe, expect, it } from "vitest";
import { cloneHierarchyTree, storeHierarchy, type StoredHierarchy } from "./engine/hierarchies";
import type { Gate } from "./engine/models";
import {
  captureGatingState,
  GATING_STATES_FIELD,
  gatingStateIsCurrent,
  gatingStatesChannelKeys,
  gatingStatesOnChannels,
  gatingStateSummary,
  nextGatingStateName,
  readGatingStates,
  restoredGatingState,
  uniqueGatingStateName,
  type SavedGatingState,
} from "./gatingStates";
import { coreReducer, initialCoreState, type CoreState } from "./store";

const FILES = ["D1", "D2"];

function gated(): CoreState {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 100 });
  for (const name of ["Cells", "CD4_positive"]) {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name,
      xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [100, 100]],
      createPop: { name, parentId: state.active_population_id! } });
  }
  return state;
}

/** The gated tree, and D1 on a copy of it of its own. */
function withFileCopy(): CoreState {
  const state = gated();
  const template = storeHierarchy(state.hierarchies[0], state);
  const c = cloneHierarchyTree(template.populations, template.root_population_id!, template.gates, template.gate_order);
  const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
  const copy: StoredHierarchy = { id: "c1", name: "D1 · Main", owner_sample_id: "D1", structure_locked: true, source_hierarchy_id: "main",
    source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
    gates: c.gates, gate_order: c.gate_order, populations: c.populations, root_population_id: c.root_population_id,
    active_population_id: c.root_population_id, selected_pop_ids: [] };
  return coreReducer(state, { type: "addHierarchyCopies", copies: [copy], activeHierarchyId: "main", assignments: { D1: "c1", D2: "main" } });
}

const gateNamed = (state: CoreState, name: string): Gate => Object.values(state.gates).find((gate) => gate.name === name)!;
const verts = (gate: Gate): [number, number][] => (gate as unknown as { vertices: [number, number][] }).vertices;
const moveCells = (state: CoreState, x: number): CoreState =>
  coreReducer(state, { type: "editGate", gateId: gateNamed(state, "Cells").gate_id, vertices: [[x, 0], [100 + x, 100]] });
const restore = (state: CoreState, saved: SavedGatingState, files: readonly string[] = FILES): CoreState =>
  coreReducer(state, { type: "adoptStrategy", base: state, next: restoredGatingState(state, saved, files) });

describe("a saved gating state", () => {
  it("brings back the gates and populations as they were, as one undo entry", () => {
    const before = gated();
    const saved = captureGatingState(before, FILES, "Before the move", new Date("2026-11-25T03:00:00Z"), "s1");
    expect(saved).toMatchObject({ id: "s1", name: "Before the move", savedAt: "2026-11-25T03:00:00.000Z", files: FILES });

    let edited = moveCells(before, 40);
    edited = coreReducer(edited, { type: "addGate", gateType: "rectangle", name: "CD8_positive",
      xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[5, 5], [50, 50]],
      createPop: { name: "CD8_positive", parentId: edited.root_population_id! } });
    expect(Object.keys(edited.gates)).toHaveLength(3);

    const restored = restore(edited, saved);
    expect(restored.gates).toEqual(before.gates);
    expect(restored.gate_order).toEqual(before.gate_order);
    expect(Object.keys(restored.populations).sort()).toEqual(Object.keys(before.populations).sort());
    expect(verts(gateNamed(restored, "Cells"))).toEqual([[0, 0], [100, 100]]);
    expect(restored.gate_version).toBeGreaterThan(edited.gate_version);
    expect(restored.undo).toHaveLength(edited.undo.length + 1);

    // One Undo is the gating as it was before the restore; Redo restores the saved state again.
    const undone = coreReducer(restored, { type: "undo" });
    expect(undone.gates).toEqual(edited.gates);
    expect(Object.keys(undone.populations)).toHaveLength(Object.keys(edited.populations).length);
    expect(coreReducer(undone, { type: "redo" }).gates).toEqual(before.gates);
  });

  it("is a copy: gating after it was saved does not reach it, and it restores more than once", () => {
    const before = gated();
    const saved = captureGatingState(before, FILES, "State 1");
    const asSaved = JSON.stringify(saved);
    const once = restore(moveCells(before, 40), saved);
    const twice = restore(moveCells(once, 70), saved);
    expect(verts(gateNamed(twice, "Cells"))).toEqual([[0, 0], [100, 100]]);
    expect(JSON.stringify(saved)).toBe(asSaved);
  });

  it("brings back every tree and the tree each file was under", () => {
    const before = withFileCopy();
    const saved = captureGatingState(before, FILES, "State 1");
    const cleared = coreReducer(before, { type: "clearGating", nEvents: 100 });
    expect(cleared.hierarchies.map((tree) => tree.id)).toEqual(["main"]);

    const restored = restore(cleared, saved);
    expect(restored.hierarchies.map((tree) => tree.id)).toEqual(["main", "c1"]);
    expect(restored.active_hierarchy_id).toBe("main");
    expect(restored.stored_hierarchies.c1.gates).toEqual(before.stored_hierarchies.c1.gates);
    expect(restored.stored_hierarchies.c1.populations).toEqual(before.stored_hierarchies.c1.populations);
    expect(restored.file_hierarchies).toEqual({ D1: "c1", D2: "main" });
    expect(coreReducer(restored, { type: "undo" }).hierarchies.map((tree) => tree.id)).toEqual(["main"]);
  });

  it("leaves out a file removed since, and keeps a file added since on its tree while the state holds that tree", () => {
    const before = withFileCopy();
    const saved = captureGatingState(before, FILES, "State 1");
    // D2 was removed and D3 added, under the first tree; D3 then under D1's copy.
    const onMain = { ...before, file_hierarchies: { D1: "c1", D3: "main" } };
    expect(restore(onMain, saved, ["D1", "D3"]).file_hierarchies).toEqual({ D1: "c1", D3: "main" });
    const onCopy = { ...before, file_hierarchies: { D1: "main", D3: "c1" } };
    expect(restore(onCopy, saved, ["D1", "D3"]).file_hierarchies).toEqual({ D1: "c1", D3: "c1" });
    // A tree made since is not in the saved state: the file added since is on the first tree.
    const onNew = { ...before, file_hierarchies: { D1: "c1", D3: "made-since" } };
    expect(restore(onNew, saved, ["D1", "D3"]).file_hierarchies).toEqual({ D1: "c1" });
  });

  it("brings back the groups and the files in them", () => {
    const grouped = coreReducer(gated(), { type: "addGroup", id: "g1", name: "treated", fileIds: ["D1"] });
    expect(grouped.file_groups).toEqual({ D1: "g1" });
    const saved = captureGatingState(grouped, FILES, "Grouped");
    const ungrouped = coreReducer(grouped, { type: "deleteGroup", id: "g1" });
    expect(ungrouped.groups).toEqual([]);

    const restored = restore(ungrouped, saved);
    expect(restored.groups.map((group) => group.name)).toEqual(["treated"]);
    expect(restored.file_groups).toEqual({ D1: "g1" });
    expect(restored.hierarchies.some((tree) => tree.owner_group_id === "g1")).toBe(true);
  });

  it("reads the same after a save and a reopening as in the session it was saved in", () => {
    const before = withFileCopy();
    const saved = captureGatingState(before, FILES, "State 1");
    const [reopened] = readGatingStates(JSON.parse(JSON.stringify({ [GATING_STATES_FIELD]: [saved] })));
    expect(reopened).toEqual(saved);
    const edited = moveCells(before, 40);
    expect(restore(edited, reopened).gates).toEqual(restore(edited, saved).gates);
  });
});

describe("whether a saved state is the gating as it is now", () => {
  it("is so when saved, not once a gate moves, and again once restored", () => {
    const before = withFileCopy();
    const saved = captureGatingState(before, FILES, "State 1");
    expect(gatingStateIsCurrent(before, saved, FILES)).toBe(true);
    const edited = moveCells(before, 40);
    expect(gatingStateIsCurrent(edited, saved, FILES)).toBe(false);
    expect(gatingStateIsCurrent(restore(edited, saved), saved, FILES)).toBe(true);
  });

  it("does not depend on what is selected or shown", () => {
    const before = gated();
    const saved = captureGatingState(before, FILES, "State 1");
    const elsewhere = coreReducer(before, { type: "setActivePopulation", popId: before.root_population_id! });
    expect(elsewhere.active_population_id).not.toBe(before.active_population_id);
    expect(gatingStateIsCurrent(elsewhere, saved, FILES)).toBe(true);
  });

  it("is not so when a file has moved to another tree", () => {
    const before = withFileCopy();
    const saved = captureGatingState(before, FILES, "State 1");
    const moved = coreReducer(before, { type: "assignFileHierarchies", assignments: { D2: "c1" } });
    expect(gatingStateIsCurrent(moved, saved, FILES)).toBe(false);
  });
});

describe("the saved states in a workspace file", () => {
  it("are none in a workspace without the field, or with something else under it", () => {
    expect(readGatingStates(null)).toEqual([]);
    expect(readGatingStates({})).toEqual([]);
    expect(readGatingStates({ [GATING_STATES_FIELD]: "State 1" })).toEqual([]);
  });

  it("leave out an entry that is not a whole gating, and keep the others", () => {
    const good = captureGatingState(gated(), FILES, "State 1", new Date("2026-11-25T03:00:00Z"), "s1");
    const read = readGatingStates({ [GATING_STATES_FIELD]: [
      null,
      { id: "no-gating", name: "x" },
      { ...good, id: "no-root", gating: { ...good.gating, root_population_id: "missing" } },
      { ...good, id: "bad-tree", gating: { ...good.gating, stored_hierarchies: [{ id: "c1" }] } },
      good,
      { ...good, name: "the same id again" },
      { ...good, id: "s2", name: "  ", savedAt: 5, files: ["D1", 2], file_hierarchies: { D1: "main", D2: 3 } },
    ] });
    expect(read.map((saved) => saved.id)).toEqual(["s1", "s2"]);
    expect(read[1]).toMatchObject({ name: "State 2", savedAt: "", files: ["D1"], file_hierarchies: { D1: "main" }, file_groups: {} });
  });

  it("have their gates restated on the channel keys the files have now", () => {
    const saved = captureGatingState(withFileCopy(), FILES, "State 1");
    expect([...new Set(gatingStatesChannelKeys([saved]))].sort()).toEqual(["FSC-A", "SSC-A"]);
    expect(gatingStatesOnChannels([saved], new Map())).toEqual([saved]);

    const [restated] = gatingStatesOnChannels([saved], new Map([["FSC-A", "FSC-A (1)"]]));
    expect(Object.values(restated.gating.gates).map((gate) => gate.x_channel)).toEqual(["FSC-A (1)", "FSC-A (1)"]);
    expect(Object.values(restated.gating.stored_hierarchies![0].gates!).map((gate) => gate.x_channel)).toEqual(["FSC-A (1)", "FSC-A (1)"]);
    expect(Object.values(restated.gating.gates).map((gate) => gate.y_channel)).toEqual(["SSC-A", "SSC-A"]);
    // The saved state itself is not changed.
    expect(Object.values(saved.gating.gates).map((gate) => gate.x_channel)).toEqual(["FSC-A", "FSC-A"]);
  });
});

describe("a saved state's name and summary", () => {
  const named = (name: string, id: string) => captureGatingState(gated(), FILES, name, new Date("2026-11-25T03:00:00Z"), id);

  it("counts the gates, the populations the user made, and the trees", () => {
    expect(gatingStateSummary(named("State 1", "s1"))).toEqual({ gates: 2, populations: 2, trees: 1 });
    expect(gatingStateSummary(captureGatingState(withFileCopy(), FILES, "State 1"))).toEqual({ gates: 2, populations: 2, trees: 2 });
  });

  it("offers the first State N not taken", () => {
    expect(nextGatingStateName([])).toBe("State 1");
    expect(nextGatingStateName([named("State 1", "s1")])).toBe("State 2");
    expect(nextGatingStateName([named("State 2", "s1")])).toBe("State 3");
    expect(nextGatingStateName([named("Before sorting", "s1"), named("State 3", "s2")])).toBe("State 4");
  });

  it("numbers a name another state has", () => {
    const states = [named("Tight gates", "s1"), named("Tight gates 2", "s2")];
    expect(uniqueGatingStateName(states, "Loose gates")).toBe("Loose gates");
    expect(uniqueGatingStateName(states, "Tight gates")).toBe("Tight gates 3");
    // Renaming a state to the name it has keeps it.
    expect(uniqueGatingStateName(states, "Tight gates", "s1")).toBe("Tight gates");
  });
});
