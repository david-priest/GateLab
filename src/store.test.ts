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
