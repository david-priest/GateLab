// A workspace where one file's tree lacks populations the others' tree holds, for the Plotting
// builders' per-file populations (cellValuesModel and proportionsModel counted tests). Synthetic
// files D1, D2 and D3, conditions control and treated; nothing here is a real experiment.

import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { cloneHierarchyTree, DEFAULT_HIERARCHY_ID, storeHierarchy, type StoredHierarchy } from "./hierarchies";
import { figureHierarchies } from "./figure";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import type { ProportionsSampleRef } from "./proportionsModel";

// Each event is [FITC-A (CD4), PE-A (CD8), FSC-A]. The quadrant's centre is FITC 1000, PE 1000.
type Event = [number, number, number];
const LOW = 100;
const HIGH = 5000;

// D1 (control, tree Main):    CD8_positive FSC 10, 20, 30; double_positive 40; CD4_positive 50, 60, 70, 80
// D2 (treated, tree Main):    CD8_positive 15; CD4_positive 55, 65; double_negative 90, 100
// D3 (treated, tree D3_tree): CD8_positive 25, 35; CD4_positive 75
// In Main, FSC_high (FSC from 62) and FSC_low split CD4_positive (D1 70, 80 | 50, 60; D2 65 | 55),
// and FSC_top (FSC from 75) lies within FSC_high (D1 80). D3's tree is a copy of Main made before
// those gates, so it holds the quadrant only.
const EVENTS: Record<string, Event[]> = {
  D1: [[LOW, HIGH, 10], [LOW, HIGH, 20], [LOW, HIGH, 30], [HIGH, HIGH, 40], [HIGH, LOW, 50], [HIGH, LOW, 60], [HIGH, LOW, 70], [HIGH, LOW, 80]],
  D2: [[LOW, HIGH, 15], [HIGH, LOW, 55], [HIGH, LOW, 65], [LOW, LOW, 90], [LOW, LOW, 100]],
  D3: [[LOW, HIGH, 25], [LOW, HIGH, 35], [HIGH, LOW, 75]],
};
export const PARTIAL_METADATA = { D1: { condition: "control" }, D2: { condition: "treated" }, D3: { condition: "treated" } };
export const D3_TREE = "D3_tree";

function file(id: string, hierarchyId: string): ProportionsSampleRef {
  const channels = [
    { index: 0, name: "FITC-A", marker: "CD4", bits: 32, range: 262144 },
    { index: 1, name: "PE-A", marker: "CD8", bits: 32, range: 262144 },
    { index: 2, name: "FSC-A", marker: null, bits: 32, range: 262144 },
  ];
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: EVENTS[id].length,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels,
    columns: channels.map((_, c) => Float32Array.from(EVENTS[id].map((event) => event[c]))),
  };
  return { id, name: `${id}.fcs`, hierarchyId, sample: new Sample(fcs) };
}

export type PartialPopulation = "All Events" | "CD8_positive" | "double_positive" | "CD4_positive" | "double_negative" | "FSC_high" | "FSC_low" | "FSC_top";

/** The workspace: a quadrant drawn in Main, a copy of Main for D3, then FSC_high, FSC_low and FSC_top in Main. */
export function partialWorkspace() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 8 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "CD4", yChannel: "CD8",
    center: [1000, 1000], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["CD8_positive", "double_positive", "CD4_positive", "double_negative"],
  });
  const template = storeHierarchy(state.hierarchies[0], state);
  const clone = cloneHierarchyTree(template.populations, template.root_population_id!, template.gates, template.gate_order);
  const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]));
  const copy: StoredHierarchy = {
    id: D3_TREE, name: "D3.fcs · Main", owner_sample_id: "D3", structure_locked: false, source_hierarchy_id: DEFAULT_HIERARCHY_ID,
    source_gate_ids: invert(clone.gateIdMap), source_population_ids: invert(clone.idMap),
    gates: clone.gates, gate_order: clone.gate_order, populations: clone.populations, root_population_id: clone.root_population_id,
    active_population_id: clone.root_population_id, selected_pop_ids: [],
  };
  state = coreReducer(state, { type: "addHierarchyCopies", copies: [copy], activeHierarchyId: DEFAULT_HIERARCHY_ID });
  const named = (name: string) => Object.values(state.populations).find((p) => p.name === name)!.population_id;
  state = coreReducer(state, {
    type: "addGate", gateType: "rectangle", xChannel: "FSC-A", yChannel: "CD8", space: "raw",
    vertices: [[62, 0], [1000, 262144]], name: "FSC_high",
    createPop: { name: "FSC_high", notName: "FSC_low", parentId: named("CD4_positive") },
  });
  state = coreReducer(state, {
    type: "addGate", gateType: "rectangle", xChannel: "FSC-A", yChannel: "CD8", space: "raw",
    vertices: [[75, 0], [1000, 262144]], name: "FSC_top",
    createPop: { name: "FSC_top", parentId: named("FSC_high") },
  });
  const core = state as CoreState;
  const trees = figureHierarchies(core);
  const files = [file("D1", DEFAULT_HIERARCHY_ID), file("D2", DEFAULT_HIERARCHY_ID), file("D3", D3_TREE)];
  /** A population's id in a tree, Main by default; undefined where the tree lacks it. */
  const idOf = (name: PartialPopulation, treeId: string = DEFAULT_HIERARCHY_ID) => {
    const tree = trees[treeId];
    return name === "All Events" ? tree.root_population_id! : Object.values(tree.populations).find((p) => p.name === name)?.population_id;
  };
  const main = (name: PartialPopulation) => idOf(name)!;
  /** The gate list's count of a population in a file, in the file's own tree. */
  const counted = (fileId: string, name: PartialPopulation) => {
    const entry = files.find((f) => f.id === fileId)!;
    const tree = trees[entry.hierarchyId!];
    const id = idOf(name, tree.id);
    return id ? recompute(entry.sample, { ...core, ...tree }).populations[id].event_count : undefined;
  };
  return { core, trees, files, idOf, main, counted };
}
