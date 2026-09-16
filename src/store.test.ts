import { describe, it, expect } from "vitest";
import {
  coreReducer,
  derivePopulationView,
  initialCoreState,
  recompute,
  recomputeGating,
  type CoreState,
} from "./store";
import { Sample } from "./engine/sample";
import { cloneHierarchyTree, emptyHierarchyTree } from "./engine/hierarchies";
import { newRootPopulation as rootPopulation, type Gate as GateRecord } from "./engine/models";
import type { FcsFile } from "./engine/fcs";

// Synthetic flow file: FSC-A/SSC-A scatter split cleanly by a rectangle.
function makeSample(): Sample {
  const n = 6;
  const mk = (v: number[]) => Float32Array.from(v);
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: n,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    // asinh/150 keeps ordering; a rectangle in raw space splits cleanly.
    columns: [mk([100, 100, 100, 5000, 5000, 5000]), mk([100, 100, 5000, 100, 5000, 5000])],
  };
  return new Sample(fcs);
}

function withGate(): { state: CoreState; sample: Sample } {
  const sample = makeSample();
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: sample.fcs.nEvents });
  // Rectangle in gating (raw) space capturing FSC-A < 1000 → first 3 events.
  state = coreReducer(state, {
    type: "addGate",
    gateType: "rectangle",
    xChannel: "FSC-A",
    yChannel: "SSC-A",
    vertices: [
      [-1000, -1000],
      [1000, 100000],
    ],
    name: "FSClo",
    createPop: { name: "FSClo", parentId: state.root_population_id! },
  });
  return { state, sample };
}

describe("store: gate + population flow", () => {
  it("starts a genuinely empty workspace with no inherited selections or undo history", () => {
    let { state } = withGate();
    const gateId = state.gate_order[0];
    const popId = state.active_population_id!;
    state = coreReducer(state, { type: "toggleGateSelect", gateId, checked: true });
    state = coreReducer(state, { type: "togglePopSelect", popId, checked: true });
    const previousRevision = state.gate_version;

    const fresh = coreReducer(state, { type: "newWorkspace" });

    expect(fresh).toMatchObject({
      gates: {},
      gate_order: [],
      populations: {},
      root_population_id: null,
      active_population_id: null,
      selected_gate_id: null,
      selected_gate_ids: [],
      selected_pop_ids: [],
      undo: [],
      redo: [],
      gate_version: previousRevision + 1,
    });
  });

  it("addGate with createPop makes a gate, a population, and sets active", () => {
    const { state } = withGate();
    expect(Object.keys(state.gates).length).toBe(1);
    expect(state.gate_order.length).toBe(1);
    expect(state.selected_gate_id).toBe(state.gate_order[0]);
    // root + 1 child
    expect(Object.keys(state.populations).length).toBe(2);
    const child = Object.values(state.populations).find((p) => p.name === "FSClo")!;
    expect(state.active_population_id).toBe(child.population_id);
  });

  it("recompute gives correct counts and percentages", () => {
    const { state, sample } = withGate();
    const d = recompute(sample, state);
    const root = state.root_population_id!;
    const child = Object.values(state.populations).find((p) => p.name === "FSClo")!.population_id;
    expect(d.stats.event_count[root]).toBe(6);
    expect(d.stats.event_count[child]).toBe(3);
    expect(d.stats.percent_of_parent[child]).toBe(50);
    expect(d.stats.percent_of_total[child]).toBe(50);
    // active is the child → gate count is within that population (all 3)
    expect(d.gateCounts[state.gate_order[0]].event_count).toBe(3);
  });

  it("changes the active population without rebuilding stable gating results", () => {
    const { state, sample } = withGate();
    const root = state.root_population_id!;
    const child = state.active_population_id!;
    const gating = recomputeGating(sample, state);

    const rootView = derivePopulationView(sample, { ...state, active_population_id: root }, gating);
    const childView = derivePopulationView(sample, { ...state, active_population_id: child }, gating);

    expect(rootView.masks).toBe(gating.masks);
    expect(childView.masks).toBe(gating.masks);
    expect(rootView.stats).toBe(gating.stats);
    expect(childView.stats).toBe(gating.stats);
    expect(rootView.activeMask).toBe(gating.masks[root]);
    expect(childView.activeMask).toBe(gating.masks[child]);
    expect(rootView.gateCounts[state.gate_order[0]].event_count).toBe(3);
    expect(childView.gateCounts[state.gate_order[0]].event_count).toBe(3);
  });

  it("toggleGateSelect / togglePopSelect track ids without changing selection", () => {
    let { state } = withGate();
    const gid = state.gate_order[0];
    state = coreReducer(state, { type: "toggleGateSelect", gateId: gid, checked: true });
    expect(state.selected_gate_ids).toContain(gid);
    state = coreReducer(state, { type: "toggleGateSelect", gateId: gid, checked: false });
    expect(state.selected_gate_ids).not.toContain(gid);
  });

  it("undo reverts gate creation", () => {
    let { state } = withGate();
    expect(Object.keys(state.gates).length).toBe(1);
    state = coreReducer(state, { type: "undo" });
    expect(Object.keys(state.gates).length).toBe(0);
    expect(Object.keys(state.populations).length).toBe(1); // root only
    state = coreReducer(state, { type: "redo" });
    expect(Object.keys(state.gates).length).toBe(1);
  });

  it("deletePopulations reparents children to the grandparent", () => {
    const sample = makeSample();
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: sample.fcs.nEvents });
    const root = state.root_population_id!;
    // child gate + population
    state = coreReducer(state, {
      type: "addGate", gateType: "rectangle", xChannel: "FSC-A", yChannel: "SSC-A",
      vertices: [[-1000, -1000], [1000, 100000]], name: "child",
      createPop: { name: "child", parentId: root },
    });
    const childId = state.active_population_id!;
    // grandchild under child
    state = coreReducer(state, {
      type: "addPopulation", name: "grand", parentId: childId,
      gateRefs: [{ gate_id: state.gate_order[0], include: true }],
    });
    const grandId = state.active_population_id!;
    // delete the middle population → grand reparents to root
    state = coreReducer(state, { type: "deletePopulations", popIds: [childId] });
    expect(state.populations[childId]).toBeUndefined();
    expect(state.populations[grandId]).toBeDefined();
    expect(state.populations[grandId].parent_id).toBe(root);
    expect(state.populations[root].children).toContain(grandId);
  });

  it("deleteGates removes the gate and strips its gate_refs", () => {
    let { state } = withGate();
    const gid = state.gate_order[0];
    state = coreReducer(state, { type: "deleteGates", gateIds: [gid] });
    expect(state.gates[gid]).toBeUndefined();
    expect(state.gate_order).not.toContain(gid);
    // population survives but its gate_ref is gone
    const pop = Object.values(state.populations).find((p) => p.name === "FSClo")!;
    expect(pop.gate_refs.length).toBe(0);
  });

  it("deleting a quadrant gate cascades its four populations and prunes the gate", () => {
    const sample = makeSample();
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: sample.fcs.nEvents });
    state = coreReducer(state, {
      type: "addQuadrant", xChannel: "FSC-A", yChannel: "SSC-A",
      center: [1000, 1000], prefix: "", parentId: state.root_population_id!,
    });
    const gid = state.gate_order[0];
    state = coreReducer(state, { type: "deleteGates", gateIds: [gid] });
    expect(Object.keys(state.gates).length).toBe(0);
    expect(Object.keys(state.populations).length).toBe(1); // root only
  });

  it("sortGatesAlpha orders gate_order case-insensitively", () => {
    const sample = makeSample();
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: sample.fcs.nEvents });
    for (const nm of ["zeta", "Alpha", "mid"]) {
      state = coreReducer(state, {
        type: "addGate", gateType: "rectangle", xChannel: "FSC-A", yChannel: "SSC-A",
        vertices: [[0, 0], [1, 1]], name: nm,
      });
    }
    state = coreReducer(state, { type: "sortGatesAlpha" });
    expect(state.gate_order.map((g) => state.gates[g].name)).toEqual(["Alpha", "mid", "zeta"]);
  });

  it("editPopulation changes name, parent, and gate refs", () => {
    const sample = makeSample();
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: sample.fcs.nEvents });
    const root = state.root_population_id!;
    state = coreReducer(state, {
      type: "addGate", gateType: "rectangle", xChannel: "FSC-A", yChannel: "SSC-A",
      vertices: [[-1000, -1000], [1000, 100000]], name: "g1", createPop: { name: "child", parentId: root },
    });
    const childId = state.active_population_id!;
    state = coreReducer(state, { type: "addPopulation", name: "grand", parentId: childId, gateRefs: [] });
    const grandId = state.active_population_id!;
    state = coreReducer(state, {
      type: "addGate", gateType: "rectangle", xChannel: "FSC-A", yChannel: "SSC-A",
      vertices: [[0, 0], [1, 1]], name: "g2",
    });
    const gid2 = state.gate_order[1];
    state = coreReducer(state, {
      type: "editPopulation", popId: grandId, name: "Grand2", parentId: root,
      gateRefs: [{ gate_id: gid2, include: true }],
    });
    const g = state.populations[grandId];
    expect(g.name).toBe("Grand2");
    expect(g.parent_id).toBe(root);
    expect(state.populations[root].children).toContain(grandId);
    expect(state.populations[childId].children).not.toContain(grandId);
    expect(g.gate_refs.map((r) => r.gate_id)).toEqual([gid2]);
  });

  it("editPopulation refuses a cyclic re-parent (guard)", () => {
    const sample = makeSample();
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: sample.fcs.nEvents });
    const root = state.root_population_id!;
    state = coreReducer(state, { type: "addPopulation", name: "A", parentId: root, gateRefs: [] });
    const a = state.active_population_id!;
    state = coreReducer(state, { type: "addPopulation", name: "B", parentId: a, gateRefs: [] });
    const b = state.active_population_id!;
    // Try to move A under its own descendant B → must be rejected (A stays under root).
    state = coreReducer(state, { type: "editPopulation", popId: a, name: "A", parentId: b, gateRefs: [] });
    expect(state.populations[a].parent_id).toBe(root);
  });

  it("quadrant gate creates four populations", () => {
    const sample = makeSample();
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: sample.fcs.nEvents });
    state = coreReducer(state, {
      type: "addQuadrant",
      xChannel: "FSC-A",
      yChannel: "SSC-A",
      center: [1000, 1000],
      prefix: "",
      parentId: state.root_population_id!,
    });
    expect(Object.keys(state.gates).length).toBe(1);
    expect(Object.keys(state.populations).length).toBe(5); // root + 4
    const d = recompute(sample, state);
    const total = Object.values(state.populations)
      .filter((p) => p.population_id !== state.root_population_id)
      .reduce((s, p) => s + (d.stats.event_count[p.population_id] ?? 0), 0);
    expect(total).toBe(6); // quadrants partition all events
  });

  it("editGate replaces a poly/rect gate's vertices, bumps version, and is undoable", () => {
    const { state, sample } = withGate();
    const gid = state.gate_order[0];
    const v0 = state.gate_version;
    const newVerts: [number, number][] = [[-1000, -1000], [100000, 100000]]; // widen to include all FSC (incl. 5000)
    const edited = coreReducer(state, { type: "editGate", gateId: gid, vertices: newVerts });
    expect((edited.gates[gid] as { vertices: unknown }).vertices).toEqual(newVerts);
    expect(edited.gate_version).toBe(v0 + 1);
    // wider rectangle now captures more events
    expect(recompute(sample, edited).stats.event_count[state.active_population_id!] ?? 0).toBeGreaterThan(
      recompute(sample, state).stats.event_count[state.active_population_id!] ?? 0,
    );
    // undo restores the original vertices
    const undone = coreReducer(edited, { type: "undo" });
    expect((undone.gates[gid] as { vertices: unknown }).vertices).toEqual(state.gates[gid] && (state.gates[gid] as { vertices: unknown }).vertices);
  });

  it("duplicateSelectedPopulations clones with 'copy' naming under the same parent", () => {
    const { state } = withGate();
    const src = Object.values(state.populations).find((p) => p.name === "FSClo")!;
    const dup = coreReducer(state, { type: "duplicateSelectedPopulations", popIds: [src.population_id] });
    const copy = Object.values(dup.populations).find((p) => p.name === "FSClo copy");
    expect(copy).toBeTruthy();
    expect(copy!.parent_id).toBe(src.parent_id);
    expect(copy!.gate_refs.map((r) => r.gate_id)).toEqual(src.gate_refs.map((r) => r.gate_id));
    expect(Object.keys(dup.populations).length).toBe(Object.keys(state.populations).length + 1);
  });

  it("bulkRenamePopulations renames by current name", () => {
    const { state } = withGate();
    const renamed = coreReducer(state, { type: "bulkRenamePopulations", mapping: { FSClo: "Small" } });
    expect(Object.values(renamed.populations).some((p) => p.name === "Small")).toBe(true);
    expect(Object.values(renamed.populations).some((p) => p.name === "FSClo")).toBe(false);
    expect(renamed.gate_version).toBe(state.gate_version);
    expect(renamed.tree_version).toBe(state.tree_version + 1);
  });

  it("renamePopulation is undoable without invalidating gating memberships", () => {
    const { state } = withGate();
    const population = Object.values(state.populations).find((p) => p.name === "FSClo")!;
    const renamed = coreReducer(state, {
      type: "renamePopulation",
      popId: population.population_id,
      name: "  Small cells  ",
    });

    expect(renamed.populations[population.population_id].name).toBe("Small cells");
    expect(renamed.gate_version).toBe(state.gate_version);
    expect(renamed.tree_version).toBe(state.tree_version + 1);
    expect(renamed.undo).toHaveLength(state.undo.length + 1);
    const undone = coreReducer(renamed, { type: "undo" });
    expect(undone.populations[population.population_id].name).toBe("FSClo");
    expect(undone.gate_version).toBe(state.gate_version);
    expect(undone.tree_version).toBe(renamed.tree_version + 1);
  });

  it("preserves presentation-only undo markers across an intervening scientific undo/redo", () => {
    const { state } = withGate();
    const population = state.active_population_id!;
    const gateId = state.gate_order[0];
    const renamedOnce = coreReducer(state, {
      type: "renamePopulation",
      popId: population,
      name: "First name",
    });
    const editedGate = coreReducer(renamedOnce, {
      type: "editGate",
      gateId,
      vertices: [[-2000, -2000], [2000, 2000]],
    });
    const renamedTwice = coreReducer(editedGate, {
      type: "renamePopulation",
      popId: population,
      name: "Second name",
    });

    const undoRename = coreReducer(renamedTwice, { type: "undo" });
    expect(undoRename.gate_version).toBe(editedGate.gate_version);
    const undoGate = coreReducer(undoRename, { type: "undo" });
    expect(undoGate.gate_version).toBe(undoRename.gate_version + 1);
    const redoGate = coreReducer(undoGate, { type: "redo" });
    expect(redoGate.gate_version).toBe(undoGate.gate_version + 1);
    const redoRename = coreReducer(redoGate, { type: "redo" });
    expect(redoRename.populations[population].name).toBe("Second name");
    expect(redoRename.gate_version).toBe(redoGate.gate_version);
  });

  it("setPopulationGateRefs replaces a definition atomically and rejects invalid refs", () => {
    let { state } = withGate();
    const population = Object.values(state.populations).find((p) => p.name === "FSClo")!;
    state = coreReducer(state, {
      type: "addGate",
      gateType: "rectangle",
      xChannel: "FSC-A",
      yChannel: "SSC-A",
      vertices: [[0, 0], [10, 10]],
      name: "Second",
    });
    const secondGateId = state.gate_order[1];
    const edited = coreReducer(state, {
      type: "setPopulationGateRefs",
      popId: population.population_id,
      gateRefs: [{ gate_id: secondGateId, include: true }],
    });

    expect(edited.populations[population.population_id].gate_refs).toEqual([
      { gate_id: secondGateId, include: true },
    ]);
    expect(edited.gate_version).toBe(state.gate_version + 1);
    expect(edited.undo).toHaveLength(state.undo.length + 1);
    expect(coreReducer(edited, { type: "undo" }).populations[population.population_id].gate_refs)
      .toEqual(state.populations[population.population_id].gate_refs);

    const invalid = coreReducer(state, {
      type: "setPopulationGateRefs",
      popId: population.population_id,
      gateRefs: [{ gate_id: "missing", include: true }],
    });
    expect(invalid).toBe(state);
  });

  it("bulkEditPopulations applies names and gate definitions atomically with one undo step", () => {
    const { state } = withGate();
    const population = Object.values(state.populations).find((p) => p.name === "FSClo")!;
    const edited = coreReducer(state, {
      type: "bulkEditPopulations",
      updates: [{
        popId: population.population_id,
        name: "Small",
        gateRefs: [],
      }],
    });

    expect(edited.populations[population.population_id]).toMatchObject({
      name: "Small",
      gate_refs: [],
    });
    expect(edited.undo).toHaveLength(state.undo.length + 1);
    expect(edited.gate_version).toBe(state.gate_version + 1);

    const invalid = coreReducer(state, {
      type: "bulkEditPopulations",
      updates: [
        {
          popId: population.population_id,
          name: "Would change",
          gateRefs: [],
        },
        {
          popId: "missing",
          name: "Invalid",
          gateRefs: [],
        },
      ],
    });
    expect(invalid).toBe(state);
  });

  it("moveSelectedPopulations reparents and guards cycles", () => {
    const sample = makeSample();
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: sample.fcs.nEvents });
    const box: [number, number][] = [[-1, -1], [100000, 100000]];
    for (const name of ["A", "B"]) {
      state = coreReducer(state, { type: "addGate", gateType: "rectangle", xChannel: "FSC-A", yChannel: "SSC-A", vertices: box, name, createPop: { name, parentId: state.root_population_id! } });
    }
    const A = Object.values(state.populations).find((p) => p.name === "A")!;
    const B = Object.values(state.populations).find((p) => p.name === "B")!;
    const moved = coreReducer(state, { type: "moveSelectedPopulations", popIds: [A.population_id], parentId: B.population_id });
    expect(moved.populations[A.population_id].parent_id).toBe(B.population_id);
    // B under A (now a descendant of B) would cycle → no-op
    const cyc = coreReducer(moved, { type: "moveSelectedPopulations", popIds: [B.population_id], parentId: A.population_id });
    expect(cyc.populations[B.population_id].parent_id).toBe(moved.populations[B.population_id].parent_id);
  });

  it("movePopulation persists sibling order without invalidating gating masks", () => {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 10 });
    const root = state.root_population_id!;
    for (const name of ["Alpha", "Zulu", "Beta"]) {
      state = coreReducer(state, { type: "addPopulation", name, parentId: root, gateRefs: [] });
    }
    const byName = Object.fromEntries(
      Object.values(state.populations).map((population) => [population.name, population.population_id]),
    );
    const before = [...state.populations[root].children];
    const moved = coreReducer(state, {
      type: "movePopulation",
      popId: byName.Beta,
      targetId: byName.Alpha,
      placement: "before",
    });

    expect(moved.populations[root].children).toEqual([
      byName.Beta,
      byName.Alpha,
      byName.Zulu,
    ]);
    expect(moved.gate_version).toBe(state.gate_version);
    expect(moved.tree_version).toBe(state.tree_version + 1);
    const undone = coreReducer(moved, { type: "undo" });
    expect(undone.populations[root].children).toEqual(before);
    expect(undone.gate_version).toBe(state.gate_version);
    expect(undone.tree_version).toBe(moved.tree_version + 1);
  });

  it("movePopulation reparents into a target and rejects descendant cycles", () => {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 10 });
    const root = state.root_population_id!;
    state = coreReducer(state, { type: "addPopulation", name: "A", parentId: root, gateRefs: [] });
    const a = state.active_population_id!;
    state = coreReducer(state, { type: "addPopulation", name: "B", parentId: root, gateRefs: [] });
    const b = state.active_population_id!;
    state = coreReducer(state, { type: "addPopulation", name: "C", parentId: a, gateRefs: [] });
    const c = state.active_population_id!;
    const moved = coreReducer(state, {
      type: "movePopulation",
      popId: c,
      targetId: b,
      placement: "inside",
    });

    expect(moved.populations[c].parent_id).toBe(b);
    expect(moved.populations[b].children).toContain(c);
    expect(moved.populations[a].children).not.toContain(c);
    expect(moved.gate_version).toBe(state.gate_version + 1);

    const cyclic = coreReducer(moved, {
      type: "movePopulation",
      popId: b,
      targetId: c,
      placement: "inside",
    });
    expect(cyclic).toBe(moved);
  });

  it("sortPopulationsAlpha is explicit, undoable, and presentation-only", () => {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 10 });
    const root = state.root_population_id!;
    for (const name of ["Zulu", "Alpha", "Beta"]) {
      state = coreReducer(state, { type: "addPopulation", name, parentId: root, gateRefs: [] });
    }
    const creationOrder = [...state.populations[root].children];
    const sorted = coreReducer(state, { type: "sortPopulationsAlpha" });

    expect(sorted.populations[root].children.map((id) => sorted.populations[id].name))
      .toEqual(["Alpha", "Beta", "Zulu"]);
    expect(sorted.gate_version).toBe(state.gate_version);
    expect(sorted.tree_version).toBe(state.tree_version + 1);
    expect(coreReducer(sorted, { type: "undo" }).populations[root].children).toEqual(creationOrder);
  });

  it("moveQuadrantCenter updates the crosshair centre", () => {
    const sample = makeSample();
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: sample.fcs.nEvents });
    state = coreReducer(state, { type: "addQuadrant", xChannel: "FSC-A", yChannel: "SSC-A", center: [1000, 1000], prefix: "", parentId: state.root_population_id! });
    const gid = state.gate_order[0];
    const moved = coreReducer(state, { type: "moveQuadrantCenter", gateId: gid, center: [2500, 2500] });
    expect((moved.gates[gid] as { center: [number, number] }).center).toEqual([2500, 2500]);
    expect(moved.gate_version).toBe(state.gate_version + 1);
  });

  it("importGating merge retains the current hierarchy and selection and remains undoable", () => {
    let { state } = withGate();
    const existingGateId = state.gate_order[0];
    const existingPopId = state.active_population_id!;
    state = coreReducer(state, { type: "toggleGateSelect", gateId: existingGateId, checked: true });
    state = coreReducer(state, { type: "togglePopSelect", popId: existingPopId, checked: true });

    const importedGateId = "imported-gate";
    const importedRootId = "imported-root";
    const importedPopId = "imported-pop";
    const merged = coreReducer(state, {
      type: "importGating",
      mode: "merge",
      gates: {
        [importedGateId]: {
          gate_id: importedGateId,
          name: "Imported",
          gate_type: "rectangle",
          x_channel: "FSC-A",
          y_channel: "SSC-A",
          vertices: [[0, 0], [10000, 10000]],
          color: "#4daf4a",
          label_offset: null,
        },
      },
      gate_order: [importedGateId],
      populations: {
        [importedRootId]: {
          population_id: importedRootId,
          name: "All Events",
          gate_refs: [],
          gate_logic: "and",
          parent_id: null,
          children: [importedPopId],
          event_count: null,
          percent_of_parent: 100,
        },
        [importedPopId]: {
          population_id: importedPopId,
          name: "Imported population",
          gate_refs: [{ gate_id: importedGateId, include: true }],
          gate_logic: "and",
          parent_id: importedRootId,
          children: [],
          event_count: null,
          percent_of_parent: null,
        },
      },
      root_population_id: importedRootId,
    });

    expect(merged.root_population_id).toBe(state.root_population_id);
    expect(merged.active_population_id).toBe(existingPopId);
    expect(merged.selected_gate_id).toBe(existingGateId);
    expect(merged.selected_gate_ids).toEqual([existingGateId]);
    expect(merged.selected_pop_ids).toEqual([existingPopId]);
    expect(Object.keys(merged.gates)).toHaveLength(2);
    expect(merged.populations[importedPopId].parent_id).toBe(state.root_population_id);
    expect(merged.populations[state.root_population_id!].children).toEqual(
      expect.arrayContaining([existingPopId, importedPopId]),
    );

    const undone = coreReducer(merged, { type: "undo" });
    expect(Object.keys(undone.gates)).toEqual([existingGateId]);
    expect(undone.populations[importedPopId]).toBeUndefined();
  });
});

describe("moving several populations at once", () => {
  function treeFixture() {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 10 });
    const root = state.root_population_id!;
    for (const name of ["Alpha", "Zulu", "Beta", "Parent"]) {
      state = coreReducer(state, { type: "addPopulation", name, parentId: root, gateRefs: [] });
    }
    const byName = Object.fromEntries(
      Object.values(state.populations).map((population) => [population.name, population.population_id]),
    );
    state = coreReducer(state, { type: "addPopulation", name: "Child", parentId: byName.Parent, gateRefs: [] });
    byName.Child = Object.values(state.populations).find((p) => p.name === "Child")!.population_id;
    return { state, root, byName };
  }

  it("moves a checked set into a parent in tree order, keeping each subtree", () => {
    const { state, root, byName } = treeFixture();
    const moved = coreReducer(state, {
      type: "movePopulations",
      popIds: [byName.Beta, byName.Alpha],
      targetId: byName.Parent,
      placement: "inside",
    });
    expect(moved.populations[root].children).toEqual([byName.Zulu, byName.Parent]);
    expect(moved.populations[byName.Parent].children).toEqual([byName.Child, byName.Alpha, byName.Beta]);
    expect(moved.populations[byName.Alpha].parent_id).toBe(byName.Parent);
    expect(moved.gate_version).toBe(state.gate_version + 1);
    const undone = coreReducer(moved, { type: "undo" });
    expect(undone.populations[root].children).toEqual(state.populations[root].children);
  });

  it("places a block before or after a sibling without changing masks", () => {
    const { state, root, byName } = treeFixture();
    const moved = coreReducer(state, {
      type: "movePopulations",
      popIds: [byName.Parent, byName.Beta],
      targetId: byName.Alpha,
      placement: "before",
    });
    expect(moved.populations[root].children).toEqual([byName.Beta, byName.Parent, byName.Alpha, byName.Zulu]);
    expect(moved.gate_version).toBe(state.gate_version);
    expect(moved.tree_version).toBe(state.tree_version + 1);
  });

  it("prunes a population whose ancestor is also moving, and refuses a target inside the set", () => {
    const { state, byName } = treeFixture();
    const moved = coreReducer(state, {
      type: "movePopulations",
      popIds: [byName.Child, byName.Parent],
      targetId: byName.Zulu,
      placement: "inside",
    });
    expect(moved.populations[byName.Zulu].children).toEqual([byName.Parent]);
    expect(moved.populations[byName.Parent].children).toEqual([byName.Child]);
    expect(moved.populations[byName.Child].parent_id).toBe(byName.Parent);
    // Dropping the set onto one of its own members, or into a moving subtree, is a no-op.
    expect(coreReducer(state, { type: "movePopulations", popIds: [byName.Alpha, byName.Beta], targetId: byName.Beta, placement: "inside" })).toBe(state);
    expect(coreReducer(state, { type: "movePopulations", popIds: [byName.Parent], targetId: byName.Child, placement: "inside" })).toBe(state);
    expect(coreReducer(state, { type: "movePopulations", popIds: [state.root_population_id!], targetId: byName.Zulu, placement: "inside" })).toBe(state);
  });

  it("setPopSelection replaces the checked set, dropping the root and unknown ids", () => {
    const { state, byName } = treeFixture();
    const next = coreReducer(state, { type: "setPopSelection", popIds: [byName.Zulu, state.root_population_id!, "missing", byName.Zulu, byName.Alpha] });
    expect(next.selected_pop_ids).toEqual([byName.Zulu, byName.Alpha]);
    expect(coreReducer(next, { type: "setPopSelection", popIds: [byName.Zulu, byName.Alpha] })).toBe(next);
  });
});

describe("several population hierarchies, each owning its gates", () => {
  function withGates() {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 10 });
    const root = state.root_population_id!;
    const box: [number, number][] = [[-1, -1], [100000, 100000]];
    for (const name of ["A", "B"]) {
      state = coreReducer(state, { type: "addGate", gateType: "rectangle", xChannel: "FSC-A", yChannel: "SSC-A", vertices: box, name, createPop: { name, parentId: root } });
    }
    const gateId = (name: string) => Object.values(state.gates).find((g) => g.name === name)!.gate_id;
    const popId = (name: string) => Object.values(state.populations).find((p) => p.name === name)!.population_id;
    return { state, root, gateId, popId };
  }

  it("starts with one default hierarchy and adds an empty one that becomes active", () => {
    const { state } = withGates();
    expect(state.hierarchies).toEqual([{ id: "main", name: "Main" }]);
    const tree = emptyHierarchyTree(10);
    const next = coreReducer(state, { type: "addHierarchy", id: "h2", name: "Scheme B", ...tree });
    expect(next.hierarchies.map((h) => h.name)).toEqual(["Main", "Scheme B"]);
    expect(next.active_hierarchy_id).toBe("h2");
    expect(Object.keys(next.populations)).toEqual([tree.root_population_id]);
    expect(next.root_population_id).toBe(tree.root_population_id);
    // A new hierarchy owns its geometry, so it starts with NO gates rather than inheriting
    // whatever was on screen. The parked one keeps its own, tree and gates together.
    expect(next.gates).toEqual({});
    expect(next.gate_order).toEqual([]);
    expect(next.stored_hierarchies.main.gates).toBe(state.gates);
    expect(Object.keys(next.stored_hierarchies.main.populations)).toHaveLength(3);
    expect(next.stored_hierarchies.main.root_population_id).toBe(state.root_population_id);
    // Undo brings the first hierarchy back as active, with the second gone again.
    const undone = coreReducer(next, { type: "undo" });
    expect(undone.active_hierarchy_id).toBe("main");
    expect(undone.hierarchies).toHaveLength(1);
    expect(undone.populations).toEqual(state.populations);
  });

  it("parks trees but does not restore an unrelated hierarchy's old browsing selection", () => {
    const { state, popId } = withGates();
    let s = coreReducer(state, { type: "togglePopSelect", popId: popId("A"), checked: true });
    s = coreReducer(s, { type: "setActivePopulation", popId: popId("B") });
    s = coreReducer(s, { type: "addHierarchy", id: "h2", name: "B", ...emptyHierarchyTree(10) });
    expect(s.selected_pop_ids).toEqual([]);
    s = coreReducer(s, { type: "switchHierarchy", id: "main" });
    expect(s.active_hierarchy_id).toBe("main");
    expect(s.active_population_id).toBe(s.root_population_id);
    expect(s.selected_pop_ids).toEqual([]);
    expect(Object.keys(s.stored_hierarchies)).toEqual(["h2"]);
    expect(coreReducer(s, { type: "switchHierarchy", id: "main" })).toBe(s);
    expect(coreReducer(s, { type: "switchHierarchy", id: "nope" })).toBe(s);
  });

  it("renames and deletes hierarchies, never the last one", () => {
    const { state } = withGates();
    let s = coreReducer(state, { type: "addHierarchy", id: "h2", name: "B", ...emptyHierarchyTree(10) });
    s = coreReducer(s, { type: "renameHierarchy", id: "main", name: "Scheme A" });
    expect(s.hierarchies.map((h) => h.name)).toEqual(["Scheme A", "B"]);
    expect(s.stored_hierarchies.main.name).toBe("Scheme A");
    // Deleting the active one makes the next listed hierarchy live.
    s = coreReducer(s, { type: "deleteHierarchy", id: "h2" });
    expect(s.hierarchies.map((h) => h.id)).toEqual(["main"]);
    expect(s.active_hierarchy_id).toBe("main");
    expect(Object.keys(s.populations)).toHaveLength(3);
    expect(s.stored_hierarchies).toEqual({});
    expect(coreReducer(s, { type: "deleteHierarchy", id: "main" })).toBe(s);
  });

  it("editing a gate in one hierarchy leaves the others alone", () => {
    // The reason hierarchies own their gates. Three files each gated by their own hierarchy is
    // not per-file gating at all if moving a boundary in one moves it in the others.
    const { state, gateId } = withGates();
    const a = gateId("A");
    let s = coreReducer(state, { type: "addHierarchy", id: "h2", name: "B", ...emptyHierarchyTree(10) });
    s = coreReducer(s, { type: "switchHierarchy", id: "main" });
    s = coreReducer(s, {
      type: "updateGate",
      gateId: a,
      patch: { vertices: [[5, 5], [6, 6]] },
    } as unknown as Parameters<typeof coreReducer>[1]);
    const gateA = s.gates[a];
    const movedHere = gateA && "vertices" in gateA ? gateA.vertices : null;
    expect(movedHere).not.toBeNull();
    s = coreReducer(s, { type: "switchHierarchy", id: "h2" });
    // The other hierarchy never had this gate, and gains nothing from the edit.
    expect(s.gates[a]).toBeUndefined();
    s = coreReducer(s, { type: "switchHierarchy", id: "main" });
    const back = s.gates[a];
    expect(back && "vertices" in back ? back.vertices : null).toEqual(movedHere);
  });

  it("deleting a gate touches only the hierarchy it belongs to", () => {
    const { state, gateId, popId } = withGates();
    const a = popId("A");
    let s = coreReducer(state, { type: "addHierarchy", id: "h2", name: "B", ...emptyHierarchyTree(10) });
    s = coreReducer(s, { type: "switchHierarchy", id: "main" });
    s = coreReducer(s, { type: "deleteGates", gateIds: [gateId("A")] });
    expect(s.gates[gateId("A")]).toBeUndefined();
    expect(s.populations[a].gate_refs).toEqual([]);
    expect(s.populations[popId("B")].gate_refs).toHaveLength(1);
  });

  it("a duplicated hierarchy carries its own copy of every gate, and a tree with dangling references is refused", () => {
    const { state, gateId, popId } = withGates();
    const copy = cloneHierarchyTree(state.populations, state.root_population_id!, state.gates, state.gate_order);
    let s = coreReducer(state, {
      type: "addHierarchy", id: "h2", name: "Copy",
      populations: copy.populations, root_population_id: copy.root_population_id,
      gates: copy.gates, gate_order: copy.gate_order,
    });
    expect(s.active_hierarchy_id).toBe("h2");
    expect(Object.keys(s.gates)).toHaveLength(2);
    expect(s.gate_order).toEqual(copy.gate_order);
    for (const pop of Object.values(s.populations)) for (const r of pop.gate_refs) expect(s.gates[r.gate_id]).toBeDefined();
    expect(s.gates[gateId("A")]).toBeUndefined(); // the copy has ids of its own
    expect(s.stored_hierarchies.main.gates).toBe(state.gates);
    // Deleting a copied gate in the copy leaves the original hierarchy's gate where it was.
    const copiedA = copy.gateIdMap[gateId("A")];
    s = coreReducer(s, { type: "deleteGates", gateIds: [copiedA] });
    expect(s.gates[copiedA]).toBeUndefined();
    expect(s.stored_hierarchies.main.gates[gateId("A")]).toBeDefined();
    expect(s.stored_hierarchies.main.populations[popId("A")].gate_refs).toHaveLength(1);
    // The same tree without its gates cannot become a hierarchy: its populations would name
    // gates that do not exist, and the workspace could not be saved.
    const refused = coreReducer(state, {
      type: "addHierarchy", id: "h3", name: "Broken",
      populations: copy.populations, root_population_id: copy.root_population_id,
    });
    expect(refused).toBe(state);
  });

  it("carries a template's edits to its locked copies, and never a copy's tailoring back", () => {
    const { state, root, gateId, popId } = withGates();
    const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
    const copyOf = (id: string, owner: string) => {
      const c = cloneHierarchyTree(state.populations, state.root_population_id!, state.gates, state.gate_order);
      return {
        id, name: `${owner}.fcs · Main`, owner_sample_id: owner, structure_locked: true, source_hierarchy_id: "main",
        source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
        gates: c.gates, gate_order: c.gate_order, populations: c.populations, root_population_id: c.root_population_id,
        active_population_id: c.root_population_id, selected_pop_ids: [],
      };
    };
    // Two locked copies of Main, Main stays active.
    let s = coreReducer(state, { type: "addHierarchyCopies", activeHierarchyId: "main", copies: [copyOf("file-1", "D1"), copyOf("file-2", "D2")] });
    expect(s.active_hierarchy_id).toBe("main");
    const copyGate = (hid: string, name: string) => Object.values(s.stored_hierarchies[hid].gates).find((g) => g.name === name)!;
    const copyPop = (hid: string, name: string) => Object.values(s.stored_hierarchies[hid].populations).find((p) => p.name === name);
    const verts = (g: unknown) => (g as { vertices: [number, number][] }).vertices;

    // D2 tailors gate A. (Switching parks Main; the copy is live and its geometry is editable.)
    s = coreReducer(s, { type: "switchHierarchy", id: "file-2" });
    const d2A = Object.values(s.gates).find((g) => g.name === "A")!.gate_id;
    s = coreReducer(s, { type: "editGate", gateId: d2A, vertices: [[5, 5], [50, 50]] });
    expect(verts(s.gates[d2A])[0]).toEqual([5, 5]);
    // Tailoring a copy touches neither the template nor the sibling.
    expect(verts(s.stored_hierarchies.main.gates[gateId("A")])[0]).toEqual([-1, -1]);
    expect(verts(copyGate("file-1", "A"))[0]).toEqual([-1, -1]);
    s = coreReducer(s, { type: "switchHierarchy", id: "main" });

    // Main moves gate A: D1 follows, D2 keeps its own; B is untouched everywhere.
    s = coreReducer(s, { type: "editGate", gateId: gateId("A"), vertices: [[0, 0], [1000, 1000]] });
    expect(verts(copyGate("file-1", "A"))[0]).toEqual([0, 0]);
    expect(verts(copyGate("file-2", "A"))[0]).toEqual([5, 5]);
    expect(verts(copyGate("file-1", "B"))[0]).toEqual([-1, -1]);
    // Ids and provenance are unchanged by a geometry edit.
    const d1A = copyGate("file-1", "A").gate_id;
    expect(s.hierarchies.find((h) => h.id === "file-1")!.source_gate_ids![d1A]).toBe(gateId("A"));

    // Main adds a gate and population under A: both copies gain them, with their own ids.
    s = coreReducer(s, { type: "addGate", gateType: "rectangle", xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[1, 1], [2, 2]], name: "C", createPop: { name: "C", parentId: popId("A") } });
    for (const hid of ["file-1", "file-2"]) {
      const c = copyPop(hid, "C")!;
      expect(c).toBeDefined();
      expect(c.population_id).not.toBe(Object.values(s.populations).find((p) => p.name === "C")!.population_id);
      expect(s.stored_hierarchies[hid].populations[c.parent_id!].name).toBe("A");
      expect(s.stored_hierarchies[hid].gates[c.gate_refs[0].gate_id].name).toBe("C");
      expect(s.hierarchies.find((h) => h.id === hid)!.source_population_ids![c.population_id]).toBe(Object.values(s.populations).find((p) => p.name === "C")!.population_id);
    }
    // Rename and delete follow too.
    s = coreReducer(s, { type: "renamePopulation", popId: popId("B"), name: "B renamed" });
    expect(copyPop("file-1", "B renamed")).toBeDefined();
    expect(copyPop("file-1", "B")).toBeUndefined();
    s = coreReducer(s, { type: "deletePopulations", popIds: [popId("B")] });
    expect(copyPop("file-1", "B renamed")).toBeUndefined();
    expect(copyPop("file-2", "B renamed")).toBeUndefined();
    // Undo restores every copy along with the template.
    const undone = coreReducer(s, { type: "undo" });
    expect(Object.values(undone.stored_hierarchies["file-1"].populations).some((p) => p.name === "B renamed")).toBe(true);

    // A copy unlocked and changed is out of step and no longer follows.
    s = coreReducer(s, { type: "setHierarchyStructureLocked", id: "file-2", locked: false });
    s = coreReducer(s, { type: "switchHierarchy", id: "file-2" });
    s = coreReducer(s, { type: "addPopulation", name: "Own", parentId: s.root_population_id!, gateRefs: [] });
    s = coreReducer(s, { type: "switchHierarchy", id: "main" });
    s = coreReducer(s, { type: "setHierarchyStructureLocked", id: "file-2", locked: true });
    s = coreReducer(s, { type: "editGate", gateId: gateId("A"), vertices: [[7, 7], [70, 70]] });
    expect(verts(copyGate("file-1", "A"))[0]).toEqual([7, 7]);
    expect(verts(copyGate("file-2", "A"))[0]).toEqual([5, 5]);
    expect(copyPop("file-2", "Own")).toBeDefined();
    void root;
  });

  it("adds independent per-file copies atomically and clears gate selection when one becomes active", () => {
    const { state, gateId } = withGates();
    const first = cloneHierarchyTree(state.populations, state.root_population_id!, state.gates, state.gate_order);
    const second = cloneHierarchyTree(state.populations, state.root_population_id!, state.gates, state.gate_order);
    let selected = coreReducer(state, { type: "selectGate", gateId: gateId("A") });
    selected = coreReducer(selected, { type: "toggleGateSelect", gateId: gateId("B"), checked: true });
    let next = coreReducer(selected, {
      type: "addHierarchyCopies",
      activeHierarchyId: "file-1",
      copies: [
        {
          id: "file-1", name: "D1.fcs · Main",
          owner_sample_id: "sample-1", structure_locked: true, source_hierarchy_id: "main",
          source_gate_ids: Object.fromEntries(Object.entries(first.gateIdMap).map(([source, copy]) => [copy, source])),
          source_population_ids: Object.fromEntries(Object.entries(first.idMap).map(([source, copy]) => [copy, source])),
          gates: first.gates, gate_order: first.gate_order,
          populations: first.populations, root_population_id: first.root_population_id,
          active_population_id: first.root_population_id, selected_pop_ids: [],
        },
        {
          id: "file-2", name: "D2.fcs · Main",
          owner_sample_id: "sample-2", structure_locked: true, source_hierarchy_id: "main",
          source_gate_ids: Object.fromEntries(Object.entries(second.gateIdMap).map(([source, copy]) => [copy, source])),
          source_population_ids: Object.fromEntries(Object.entries(second.idMap).map(([source, copy]) => [copy, source])),
          gates: second.gates, gate_order: second.gate_order,
          populations: second.populations, root_population_id: second.root_population_id,
          active_population_id: second.root_population_id, selected_pop_ids: [],
        },
      ],
    });
    expect(next.hierarchies.map((hierarchy) => hierarchy.id)).toEqual(["main", "file-1", "file-2"]);
    expect(next.active_hierarchy_id).toBe("file-1");
    expect(next.selected_gate_id).toBeNull();
    expect(next.selected_gate_ids).toEqual([]);
    expect(Object.keys(next.gates)).toHaveLength(2);
    expect(new Set([...Object.keys(first.gates), ...Object.keys(second.gates)]).size).toBe(4);

    const firstGate = first.gate_order[0];
    next = coreReducer(next, { type: "editGate", gateId: firstGate, vertices: [[5, 5], [6, 6]] });
    expect(coreReducer(next, { type: "renameGate", gateId: firstGate, name: "Changed structure" })).toBe(next);
    // Deleting the template unlinks its copies: each stays, as a tree of its own, following nothing.
    const gone = coreReducer(next, { type: "deleteHierarchy", id: "main" });
    expect(gone.hierarchies.map((hierarchy) => hierarchy.id)).toEqual(["file-1", "file-2"]);
    expect(gone.active_hierarchy_id).toBe("file-1");
    for (const hierarchy of [...gone.hierarchies, gone.stored_hierarchies["file-2"]!]) {
      expect(hierarchy.owner_sample_id).toBeUndefined();
      expect(hierarchy.structure_locked).toBeUndefined();
      expect(hierarchy.source_hierarchy_id).toBeUndefined();
      expect(hierarchy.source_gate_ids).toBeUndefined();
      expect(hierarchy.source_population_ids).toBeUndefined();
    }
    expect(Object.keys(gone.stored_hierarchies)).toEqual(["file-2"]);
    expect(coreReducer(gone, { type: "renameGate", gateId: firstGate, name: "Free now" }).gates[firstGate].name).toBe("Free now");
    next = coreReducer(next, { type: "switchHierarchy", id: "file-2" });
    const untouched = next.gates[second.gate_order[0]];
    expect(untouched && "vertices" in untouched ? untouched.vertices : null).not.toEqual([[5, 5], [6, 6]]);
  });

  it("allows a locked file hierarchy to tailor geometry, then permits structure after explicit unlock", () => {
    const { state, gateId } = withGates();
    const copy = cloneHierarchyTree(state.populations, state.root_population_id!, state.gates, state.gate_order);
    let next = coreReducer(state, {
      type: "addHierarchyCopies",
      activeHierarchyId: "file-1",
      copies: [{
        id: "file-1",
        name: "D1.fcs · Main",
        owner_sample_id: "sample-1",
        structure_locked: true,
        source_hierarchy_id: "main",
        source_gate_ids: Object.fromEntries(Object.entries(copy.gateIdMap).map(([source, child]) => [child, source])),
        source_population_ids: Object.fromEntries(Object.entries(copy.idMap).map(([source, child]) => [child, source])),
        gates: copy.gates,
        gate_order: copy.gate_order,
        populations: copy.populations,
        root_population_id: copy.root_population_id,
        active_population_id: copy.root_population_id,
        selected_pop_ids: [],
      }],
    });
    const copiedGate = copy.gateIdMap[gateId("A")];

    next = coreReducer(next, { type: "editGate", gateId: copiedGate, vertices: [[2, 2], [3, 3]] });
    const tailored = next.gates[copiedGate];
    expect(tailored && "vertices" in tailored ? tailored.vertices : null).toEqual([[2, 2], [3, 3]]);
    expect(coreReducer(next, { type: "renameGate", gateId: copiedGate, name: "Blocked" })).toBe(next);
    expect(coreReducer(next, { type: "deleteGates", gateIds: [copiedGate] })).toBe(next);

    next = coreReducer(next, { type: "setHierarchyStructureLocked", id: "file-1", locked: false });
    expect(next.hierarchies.find((hierarchy) => hierarchy.id === "file-1")?.structure_locked).toBe(false);
    next = coreReducer(next, { type: "renameGate", gateId: copiedGate, name: "Allowed" });
    expect(next.gates[copiedGate].name).toBe("Allowed");
  });

  it("unlinks a copy from its group: a tree of its own with no owner, lock or source, undoably", () => {
    const { state, gateId } = withGates();
    const copy = cloneHierarchyTree(state.populations, state.root_population_id!, state.gates, state.gate_order);
    let next = coreReducer(state, {
      type: "addHierarchyCopies",
      activeHierarchyId: "main",
      copies: [{
        id: "file-1",
        name: "D1.fcs · Main",
        owner_sample_id: "sample-1",
        structure_locked: true,
        source_hierarchy_id: "main",
        source_gate_ids: Object.fromEntries(Object.entries(copy.gateIdMap).map(([source, child]) => [child, source])),
        source_population_ids: Object.fromEntries(Object.entries(copy.idMap).map(([source, child]) => [child, source])),
        gates: copy.gates,
        gate_order: copy.gate_order,
        populations: copy.populations,
        root_population_id: copy.root_population_id,
        active_population_id: copy.root_population_id,
        selected_pop_ids: [],
      }],
    });
    expect(coreReducer(next, { type: "unlinkHierarchy", id: "main" })).toBe(next);
    expect(coreReducer(next, { type: "unlinkHierarchy", id: "nope" })).toBe(next);

    // Parked: the stored copy and its menu entry both lose the link.
    const parked = coreReducer(next, { type: "unlinkHierarchy", id: "file-1" });
    const ref = parked.hierarchies.find((hierarchy) => hierarchy.id === "file-1")!;
    expect(ref).toEqual({ id: "file-1", name: "D1.fcs · Main" });
    expect(parked.stored_hierarchies["file-1"]!.source_hierarchy_id).toBeUndefined();
    expect(parked.stored_hierarchies["file-1"]!.owner_sample_id).toBeUndefined();
    expect(Object.keys(parked.stored_hierarchies["file-1"]!.gates)).toEqual(Object.keys(copy.gates));
    // A template edit no longer reaches it.
    const copiedGate = copy.gateIdMap[gateId("A")];
    const edited = coreReducer(parked, { type: "editGate", gateId: gateId("A"), vertices: [[7, 7], [8, 8]] });
    const stored = edited.stored_hierarchies["file-1"]!.gates[copiedGate];
    expect(stored && "vertices" in stored ? stored.vertices : null).not.toEqual([[7, 7], [8, 8]]);
    expect(coreReducer(parked, { type: "undo" }).hierarchies.find((hierarchy) => hierarchy.id === "file-1")?.source_hierarchy_id).toBe("main");

    // Live: structure opens up at once.
    next = coreReducer(next, { type: "switchHierarchy", id: "file-1" });
    expect(coreReducer(next, { type: "renameGate", gateId: copiedGate, name: "Blocked" })).toBe(next);
    next = coreReducer(next, { type: "unlinkHierarchy", id: "file-1" });
    expect(next.hierarchies.find((hierarchy) => hierarchy.id === "file-1")).toEqual({ id: "file-1", name: "D1.fcs · Main" });
    expect(coreReducer(next, { type: "renameGate", gateId: copiedGate, name: "Allowed" }).gates[copiedGate].name).toBe("Allowed");
  });

  it("clears a selected gate whenever a different hierarchy is activated", () => {
    const { state, gateId } = withGates();
    let next = coreReducer(state, { type: "addHierarchy", id: "h2", name: "B", ...emptyHierarchyTree(10) });
    next = coreReducer(next, { type: "switchHierarchy", id: "main" });
    next = coreReducer(next, { type: "selectGate", gateId: gateId("A") });
    expect(next.selected_gate_id).toBe(gateId("A"));
    next = coreReducer(next, { type: "switchHierarchy", id: "h2" });
    expect(next.selected_gate_id).toBeNull();
    expect(next.selected_gate_ids).toEqual([]);
  });

  it("deleting a gate in one hierarchy leaves a parked hierarchy that holds the same gate id untouched", () => {
    const { state, gateId, popId } = withGates();
    // A workspace written before hierarchies owned their gates gave every hierarchy the shared
    // table's ids; the same id in two tables is two gates.
    const tree = cloneHierarchyTree(state.populations, state.root_population_id!);
    let s = coreReducer(state, {
      type: "addHierarchy", id: "h2", name: "Same ids",
      populations: tree.populations, root_population_id: tree.root_population_id,
      gates: state.gates, gate_order: state.gate_order,
    });
    s = coreReducer(s, { type: "deleteGates", gateIds: [gateId("A")] });
    expect(s.gates[gateId("A")]).toBeUndefined();
    expect(s.stored_hierarchies.main.gates[gateId("A")]).toBeDefined();
    expect(s.stored_hierarchies.main.populations[popId("A")].gate_refs).toHaveLength(1);
  });

  it("replacing the active hierarchy's strategy leaves the parked ones untouched", () => {
    // This used to retain any gate a parked hierarchy referenced, because one table served them
    // all. Each owns its own now, so a replace is confined to the hierarchy being replaced.
    const { state, gateId } = withGates();
    let s = coreReducer(state, { type: "addHierarchy", id: "h2", name: "B", ...emptyHierarchyTree(10) });
    s = coreReducer(s, { type: "switchHierarchy", id: "main" });
    const root = rootPopulation(10);
    const g: GateRecord = { gate_id: "new-g", name: "New", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A", vertices: [[0, 0], [1, 1]], color: "#000", label_offset: null };
    s = coreReducer(s, {
      type: "importGating",
      mode: "replace",
      gates: { "new-g": g },
      gate_order: ["new-g"],
      populations: { [root.population_id]: root },
      root_population_id: root.population_id,
    });
    expect(Object.keys(s.gates)).toEqual(["new-g"]);
    expect(s.gate_order).toEqual(["new-g"]);
    expect(s.root_population_id).toBe(root.population_id);
    // The parked hierarchy is empty because it was created empty, not because it lost anything.
    expect(s.stored_hierarchies.h2.gates).toEqual({});
    void gateId;
  });

  it("loads a workspace with parked hierarchies and defaults to one without", () => {
    const { state } = withGates();
    const parked = emptyHierarchyTree(10);
    const loaded = coreReducer(initialCoreState(), {
      type: "loadWorkspace",
      gates: state.gates,
      gate_order: state.gate_order,
      populations: state.populations,
      root_population_id: state.root_population_id,
      active_population_id: state.active_population_id,
      selected_gate_id: null,
      hierarchies: [{ id: "main", name: "Scheme A" }, { id: "h2", name: "Scheme B" }],
      active_hierarchy_id: "main",
      // A parked hierarchy carries its own gates now, so a switch to it brings its geometry.
      stored_hierarchies: [{ id: "h2", name: "Scheme B", gates: {}, gate_order: [], populations: parked.populations, root_population_id: parked.root_population_id, active_population_id: null, selected_pop_ids: [] }],
    });
    expect(loaded.hierarchies.map((h) => h.name)).toEqual(["Scheme A", "Scheme B"]);
    expect(Object.keys(loaded.stored_hierarchies)).toEqual(["h2"]);
    const plain = coreReducer(initialCoreState(), {
      type: "loadWorkspace",
      gates: state.gates,
      gate_order: state.gate_order,
      populations: state.populations,
      root_population_id: state.root_population_id,
      active_population_id: state.active_population_id,
      selected_gate_id: null,
    });
    expect(plain.hierarchies).toEqual([{ id: "main", name: "Main" }]);
    expect(plain.stored_hierarchies).toEqual({});
  });
});
