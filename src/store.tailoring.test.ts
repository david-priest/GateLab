import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "./store";
import { cloneHierarchyTree, storeHierarchy, selectionAcrossHierarchies, type StoredHierarchy } from "./engine/hierarchies";
import { copyTailoring } from "./engine/copyTailoring";
import { gateGeometryEquals, tailoredGateIds } from "./engine/templateSync";
import type { Gate } from "./engine/models";

function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 100 });
  for (const name of ["Cells", "CD4_positive"]) {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name,
      xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [100, 100]],
      createPop: { name, parentId: state.active_population_id! } });
  }
  const template = storeHierarchy(state.hierarchies[0], state);
  const makeCopy = (id: string, source = template): StoredHierarchy => {
    const c = cloneHierarchyTree(source.populations, source.root_population_id!, source.gates, source.gate_order);
    const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
    return { id, name: id, owner_sample_id: id, structure_locked: true, source_hierarchy_id: source.id,
      source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
      gates: c.gates, gate_order: c.gate_order, populations: c.populations, root_population_id: c.root_population_id,
      active_population_id: c.root_population_id, selected_pop_ids: [] };
  };
  const a = makeCopy("D1"), b = makeCopy("D2");
  state = coreReducer(state, { type: "addHierarchyCopies", copies: [a, b], activeHierarchyId: a.id });
  return { state, template, a, b, makeCopy };
}
const live = (s: CoreState) => storeHierarchy(s.hierarchies.find((h) => h.id === s.active_hierarchy_id)!, s);
const popId = (tree: StoredHierarchy, name: string) => Object.values(tree.populations).find((p) => p.name === name)!.population_id;
const moved = (gate: Gate, x: number): Gate => ({ ...gate, vertices: [[x, 0], [100 + x, 100]] } as Gate);

describe("gate-level revert", () => {
  it.each(["rectangle", "polygon", "ellipse", "quadrant"] as const)("restores %s geometry only, undoably, and resumes group propagation", (kind) => {
    let { state, a, template, b } = fixture();
    const id = a.gate_order[0], sourceId = a.source_gate_ids![id];
    const base = template.gates[sourceId];
    const geometry: Gate = kind === "ellipse"
      ? { ...base, gate_type: kind, mean: [10, 10], covariance: [[4, 0], [0, 9]], distance_square: 1 }
      : kind === "quadrant" ? { ...base, gate_type: kind, center: [10, 10], curl: { power: 1.5, kx: 0.1, ky: 0.2 } }
      : { ...base, gate_type: kind, vertices: [[0, 0], [100, 0], [100, 100], [0, 100]] };
    template = { ...template, gates: { ...template.gates, [sourceId]: geometry } };
    const tailored = { ...geometry, gate_id: id, space: "display", transforms: { "FSC-A": { kind: "asinh", cofactor: 5 } }, color: "#123456", label_offset: [3, 4] } as Gate;
    state = { ...state, gates: { ...state.gates, [id]: tailored, [a.gate_order[1]]: moved(state.gates[a.gate_order[1]], 20) }, stored_hierarchies: { ...state.stored_hierarchies, main: template } };
    const before = state;
    state = coreReducer(state, { type: "revertGateToGroup", gateId: id });
    expect(gateGeometryEquals(state.gates[id], geometry)).toBe(true);
    expect(state.gates[id].color).toBe("#123456");
    expect(state.gates[id].label_offset).toEqual([3, 4]);
    expect(state.gates[a.gate_order[1]]).toBe(before.gates[a.gate_order[1]]);
    expect(state.stored_hierarchies[b.id]).toBe(before.stored_hierarchies[b.id]);
    expect(state.populations).toBe(before.populations);
    expect([...tailoredGateIds(live(state), { ...template, root_population_id: template.root_population_id! })]).toEqual([a.gate_order[1]]);
    expect(coreReducer(state, { type: "undo" }).gates).toEqual(before.gates);
    expect(coreReducer(coreReducer(state, { type: "undo" }), { type: "redo" }).gates).toEqual(state.gates);
    expect(coreReducer(state, { type: "revertGateToGroup", gateId: id })).toBe(state);
    state = coreReducer(state, { type: "switchHierarchy", id: template.id });
    // A scientific group edit reaches the reverted gate, not its still-tailored neighbour.
    // Exercise the normal reducer edit path for rectangles/polygons; ellipse and quadrant use their own actions.
    state = kind === "quadrant"
      ? coreReducer(state, { type: "moveQuadrantCenter", gateId: sourceId, center: [30, 40] })
      : kind === "ellipse" ? coreReducer(state, { type: "moveEllipse", gateId: sourceId, mean: [30, 40] })
      : coreReducer(state, { type: "editGate", gateId: sourceId, vertices: [[30, 40], [100, 100]] });
    expect(gateGeometryEquals(state.stored_hierarchies[a.id].gates[id], state.gates[sourceId])).toBe(true);
    expect(state.stored_hierarchies[a.id].gates[a.gate_order[1]]).toEqual(before.gates[a.gate_order[1]]);
  });

  it("does nothing without a valid linked source", () => {
    const { state, a } = fixture();
    expect(coreReducer(state, { type: "revertGateToGroup", gateId: "missing" })).toBe(state);
    const unlinked = coreReducer(state, { type: "unlinkHierarchy", id: a.id });
    expect(coreReducer(unlinked, { type: "revertGateToGroup", gateId: a.gate_order[0] })).toBe(unlinked);
  });
});

describe("copying current tailoring to checked files", () => {
  it("restores the previous group link with Undo when a checked file came from another group", () => {
    let { state, template, makeCopy } = fixture();
    const other: StoredHierarchy = { ...makeCopy("other"), owner_sample_id: undefined,
      structure_locked: undefined, source_hierarchy_id: undefined, source_gate_ids: undefined, source_population_ids: undefined };
    const target = makeCopy("D4", other);
    state = { ...state, hierarchies: [...state.hierarchies, other], stored_hierarchies: { ...state.stored_hierarchies, other } };
    state = coreReducer(state, { type: "addHierarchyCopies", copies: [target], activeHierarchyId: state.active_hierarchy_id });
    const before = state;
    const trees = { ...state.stored_hierarchies, [state.active_hierarchy_id]: live(state) };
    state = coreReducer(state, { type: "replaceHierarchyCopies", copies: [copyTailoring(template, target, template, trees)] });
    expect(state.stored_hierarchies.D4.source_hierarchy_id).toBe("main");
    expect(state.stored_hierarchies.other).toEqual(other);
    const undone = coreReducer(state, { type: "undo" });
    expect(undone.stored_hierarchies.D4).toEqual(before.stored_hierarchies.D4);
    expect(undone.hierarchies.find(h => h.id === "D4")!.source_hierarchy_id).toBe("other");
  });

  it("reverts multiple copies to the template in one undo step while preserving ids and unrelated copies", () => {
    let { state, template, a, b, makeCopy } = fixture();
    const c = makeCopy("D3");
    state = coreReducer(state, { type: "addHierarchyCopies", copies: [c], activeHierarchyId: a.id });
    state = coreReducer(state, { type: "editGate", gateId: a.gate_order[0], vertices: [[20, 0], [120, 100]] });
    state = coreReducer(state, { type: "switchHierarchy", id: b.id });
    state = coreReducer(state, { type: "editGate", gateId: b.gate_order[0], vertices: [[40, 0], [140, 100]] });
    state = coreReducer(state, { type: "switchHierarchy", id: "main" });
    const before = state;
    const trees: Record<string, StoredHierarchy> = { ...state.stored_hierarchies, main: live(state) };
    const copies = [a, b].map(copy => copyTailoring(template, trees[copy.id], template, trees));
    state = coreReducer(state, { type: "replaceHierarchyCopies", copies });
    for (const copy of [a, b]) {
      const reset = state.stored_hierarchies[copy.id];
      expect(reset.gate_order).toEqual(copy.gate_order);
      expect(Object.keys(reset.populations)).toEqual(Object.keys(copy.populations));
      expect(tailoredGateIds(reset, { ...template, root_population_id: template.root_population_id! }).size).toBe(0);
    }
    expect(state.gates).toEqual(before.gates);
    expect(state.stored_hierarchies.D3).toEqual(before.stored_hierarchies.D3);
    expect(state.undo.length).toBe(before.undo.length + 1);
    const undone = coreReducer(state, { type: "undo" });
    expect(undone.stored_hierarchies).toEqual(before.stored_hierarchies);
    expect(coreReducer(undone, { type: "redo" }).stored_hierarchies).toEqual(state.stored_hierarchies);
    const edited = coreReducer(state, { type: "editGate", gateId: template.gate_order[0], vertices: [[60, 0], [160, 100]] });
    for (const copy of [a, b]) expect(gateGeometryEquals(edited.stored_hierarchies[copy.id].gates[copy.gate_order[0]], edited.gates[template.gate_order[0]])).toBe(true);
  });

  it("copies repeatedly within one group, retains destination ids, and restores the full operation with Undo", () => {
    let { state, template, a, b } = fixture();
    const before = b;
    for (const shift of [20, 40]) {
      state = coreReducer(state, { type: "editGate", gateId: a.gate_order[0], vertices: [[shift, 0], [shift + 100, 100]] });
      const source = live(state);
      const dest = copyTailoring(source, state.stored_hierarchies[b.id], template, { ...state.stored_hierarchies, [a.id]: source });
      state = coreReducer(state, { type: "replaceHierarchyCopies", copies: [dest] });
      expect(gateGeometryEquals(dest.gates[b.gate_order[0]], state.gates[a.gate_order[0]])).toBe(true);
      expect(dest.gate_order).toEqual(b.gate_order);
      expect(Object.keys(dest.populations)).toEqual(Object.keys(b.populations));
      expect(dest.source_hierarchy_id).toBe("main");
      expect(dest.source_gate_ids).toEqual(b.source_gate_ids);
      expect(state.stored_hierarchies.main).toEqual(template);
    }
    const undo = coreReducer(state, { type: "undo" });
    expect(gateGeometryEquals(undo.stored_hierarchies[b.id].gates[b.gate_order[0]], state.stored_hierarchies[b.id].gates[b.gate_order[0]])).toBe(false);
    expect(before.gates[b.gate_order[0]]).toEqual(b.gates[b.gate_order[0]]);
    expect(coreReducer(undo, { type: "redo" }).stored_hierarchies[b.id]).toEqual(state.stored_hierarchies[b.id]);
  });

  it("flattens a copy of a copy to the group without a sibling dependency", () => {
    const { a, b, template, makeCopy } = fixture();
    const child = makeCopy("D3", a);
    const result = copyTailoring(child, b, template, { main: template, D1: a, D2: b, D3: child });
    expect(result.source_hierarchy_id).toBe("main");
    expect(result.source_gate_ids).toEqual(b.source_gate_ids);
    expect(result.source_population_ids).toEqual(b.source_population_ids);
  });

  it("never binds a locally recreated same-name gate to the old template gate", () => {
    const { a, b, template } = fixture();
    const recreated = { ...a, source_gate_ids: {} };
    expect(() => copyTailoring(recreated, b, template, { main: template, D1: recreated, D2: b })).toThrow("without a group counterpart");
  });
});

describe("one browsing position across files", () => {
  it("follows the current population and checked populations, not the destination's remembered selection", () => {
    let { state, a, b } = fixture();
    state = coreReducer(state, { type: "setActivePopulation", popId: popId(a, "CD4_positive") });
    state = coreReducer(state, { type: "togglePopSelect", popId: popId(a, "Cells"), checked: true });
    state = coreReducer(state, { type: "switchHierarchy", id: b.id });
    expect(state.active_population_id).toBe(popId(b, "CD4_positive"));
    expect(state.selected_pop_ids).toEqual([popId(b, "Cells")]);
    state = coreReducer(state, { type: "setActivePopulation", popId: popId(b, "Cells") });
    state = coreReducer(state, { type: "switchHierarchy", id: a.id });
    expect(state.active_population_id).toBe(popId(a, "Cells"));
  });

  it("uses the nearest ancestor for missing branches and root for unrelated same-name trees", () => {
    const { a, b, template } = fixture();
    a.active_population_id = popId(a, "CD4_positive");
    delete b.populations[popId(b, "CD4_positive")];
    expect(selectionAcrossHierarchies(a, b, { main: template, D1: a, D2: b }).active_population_id).toBe(popId(b, "Cells"));
    const unrelated = { ...b, source_hierarchy_id: undefined, source_population_ids: undefined };
    expect(selectionAcrossHierarchies(a, unrelated, { main: template, D1: a, D2: unrelated }).active_population_id).toBe(b.root_population_id);
  });

  it("retains browsing position when a file's copy is created lazily", () => {
    const { state, template, makeCopy } = fixture();
    let next = coreReducer(state, { type: "switchHierarchy", id: "main" });
    next = coreReducer(next, { type: "setActivePopulation", popId: popId(template, "Cells") });
    const c = makeCopy("D3");
    next = coreReducer(next, { type: "addHierarchyCopies", copies: [c], activeHierarchyId: c.id, keepBrowsingPosition: true });
    expect(next.active_population_id).toBe(popId(c, "Cells"));
  });

  it("does not guess between ambiguous copies and restores valid gate selections through Undo", () => {
    const { state, a, b, template } = fixture();
    const source = { ...a, active_population_id: popId(a, "Cells") };
    const duplicateId = "duplicate-population";
    const ambiguous = { ...b, populations: { ...b.populations, [duplicateId]: { ...b.populations[popId(b, "Cells")], population_id: duplicateId } },
      source_population_ids: { ...b.source_population_ids, [duplicateId]: b.source_population_ids![popId(b, "Cells")] } };
    expect(selectionAcrossHierarchies(source, ambiguous, { main: template, D1: source, D2: ambiguous }).active_population_id).toBe(b.root_population_id);
    const selected = coreReducer(state, { type: "selectGate", gateId: a.gate_order[0] });
    const switched = coreReducer(selected, { type: "switchHierarchy", id: b.id });
    expect(switched.selected_gate_id).toBe(b.gate_order[0]);
    const undone = coreReducer(switched, { type: "undo" });
    expect(undone.selected_gate_id).toBe(a.gate_order[0]);
    expect(undone.gates[undone.selected_gate_id!]).toBeDefined();
    expect(coreReducer(undone, { type: "redo" }).selected_gate_id).toBe(b.gate_order[0]);
  });
});
