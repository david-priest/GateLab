// Memberships of a restructured copy, on public BCR-XL data: when the tree a file is gated under
// has no counterpart for a population, that population is not evaluated for the file (NA, with a
// note), never read with another tree's gates. Three public BCR-XL files, the public example tree,
// and file 1's copy of it with IgM+ B cells removed and a population of its own added.

import { beforeAll, describe, expect, it } from "vitest";
import { cloneHierarchyTree, type HierarchyRef, type StoredHierarchy } from "../engine/hierarchies";
import type { Gate } from "../engine/models";
import { recomputeGating, type CoreState } from "../store";
import { bcrxlAvailable, bcrxlHost, bcrxlSce, bcrxlTree, membershipBits, type BcrxlTree } from "./bcrxlSceFixture";
import { loadHostedDataset, type GateLabHostedSample } from "./hostedSample";
import {
  buildHostedMemberships,
  gatingStateForTree,
  type HierarchyTree,
  type HostedMembershipSample,
} from "./hostedMemberships";

const invert = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));
const byName = (tree: { populations: Record<string, { name: string }> }, name: string) =>
  Object.keys(tree.populations).find((id) => tree.populations[id].name === name)!;

/** File 1's unlocked copy: B cells tailored, IgM+ B cells removed, a CD20-high B cells population added. */
function restructuredCopy(main: BcrxlTree): StoredHierarchy {
  const clone = cloneHierarchyTree(main.populations, main.root_population_id, main.gates, main.gate_order);
  const gates: Record<string, Gate> = clone.gates;
  const populations = clone.populations;
  const bGate = Object.values(gates).find((g) => g.name === "B cells: CD20+/CD3-low")!;
  if (bGate.gate_type !== "rectangle") throw new Error("expected the public B cell rectangle");
  const lo = Math.min(...bGate.vertices.map((v) => v[1]));
  bGate.vertices = bGate.vertices.map(([x, y]) => [x, y === lo ? 3.2 : y]);
  const bCells = byName({ populations }, "B cells");
  const igmPos = byName({ populations }, "IgM+ B cells");
  delete populations[igmPos];
  populations[bCells] = { ...populations[bCells], children: populations[bCells].children.filter((c) => c !== igmPos) };
  gates["copy-cd20-high"] = {
    gate_id: "copy-cd20-high", name: "CD20 high", gate_type: "rectangle", x_channel: "IgM", y_channel: "CD20",
    vertices: [[-3, 4.5], [8, 8]], color: "#377eb8", label_offset: null,
  };
  populations["copy-only"] = {
    population_id: "copy-only", name: "CD20-high B cells", parent_id: bCells, children: [],
    gate_refs: [{ gate_id: "copy-cd20-high", include: true }], gate_logic: "and", event_count: null, percent_of_parent: null,
  };
  populations[bCells].children.push("copy-only");
  return {
    id: "copy-1", name: "PBMC8_30min_patient1_BCR-XL · Main", owner_sample_id: "sample-1", structure_locked: false,
    source_hierarchy_id: "main", source_gate_ids: invert(clone.gateIdMap), source_population_ids: invert(clone.idMap),
    gates, gate_order: [...clone.gate_order, "copy-cd20-high"], populations, root_population_id: clone.root_population_id,
    active_population_id: clone.root_population_id, selected_pop_ids: [],
  };
}

function workspace(main: BcrxlTree, copy: StoredHierarchy, live: "main" | "copy-1"): CoreState {
  const mainRef: HierarchyRef = { id: "main", name: "Main" };
  const { gates: _g, gate_order: _o, populations: _p, root_population_id: _r, active_population_id: _a, selected_pop_ids: _s, ...copyRef } = copy;
  const storedMain: StoredHierarchy = { ...mainRef, ...main, active_population_id: main.root_population_id, selected_pop_ids: [] };
  const liveTree = live === "main" ? storedMain : copy;
  return {
    gates: liveTree.gates, gate_order: liveTree.gate_order, populations: liveTree.populations,
    root_population_id: liveTree.root_population_id,
    hierarchies: [mainRef, copyRef],
    active_hierarchy_id: live,
    stored_hierarchies: live === "main" ? { "copy-1": copy } : { main: storedMain },
    file_hierarchies: { "sample-1": "copy-1" },
  } as unknown as CoreState;
}

describe.runIf(bcrxlAvailable())("memberships of a restructured copy (public BCR-XL)", () => {
  let hosted: GateLabHostedSample[];
  let main: BcrxlTree;
  let copy: StoredHierarchy;
  beforeAll(async () => {
    const sce = bcrxlSce();
    hosted = await loadHostedDataset(bcrxlHost(sce).host.datasets!, sce.dataset);
    main = bcrxlTree();
    copy = restructuredCopy(main);
  });

  const samplesFor = (state: CoreState): HostedMembershipSample[] => hosted.map((entry, index) => ({
    sampleId: entry.sampleId,
    eventCount: entry.eventIndex.length,
    name: entry.name,
    hierarchyId: index === 1 ? "copy-1" : "main",
    gatingFor: (tree: HierarchyTree) => recomputeGating(entry.sample, gatingStateForTree(state, tree)),
  }));

  for (const live of ["main", "copy-1"] as const) {
    it(`sends NA with a note, never another tree's gates, with ${live} live`, () => {
      const state = workspace(main, copy, live);
      const built = buildHostedMemberships(state, samplesFor(state));
      const population = (hierarchyId: string, name: string) =>
        built.populations.find((p) => p.hierarchyId === hierarchyId && p.populationName === name)!;

      // Main's IgM+ B cells has no counterpart in file 1's copy.
      const igm = population("main", "IgM+ B cells");
      expect(igm.sampleMasks.map((m) => m.notEvaluated === undefined)).toEqual([true, false, true]);
      expect(igm.sampleMasks[1].membershipBitsBase64).toBe("");
      expect(igm.sampleMasks[1].eventCount).toBe(2838);
      expect(igm.sampleMasks[1].notEvaluated).toMatch(/'IgM\+ B cells' of 'Main'.*PBMC8_30min_patient1_BCR-XL.*'PBMC8_30min_patient1_BCR-XL · Main'/);
      // The copy's own population has no counterpart in Main, which files 0 and 2 are gated under.
      const own = population("copy-1", "CD20-high B cells");
      expect(own.sampleMasks.map((m) => m.notEvaluated === undefined)).toEqual([false, true, false]);
      expect(own.sampleMasks[0].notEvaluated).toMatch(/'CD20-high B cells'.*PBMC8_30min_patient1_Reference.*'Main'/);

      // Every evaluated child lies inside its evaluated parent, in every hierarchy and file.
      const bitsOf = new Map(built.populations.map((p) => [`${p.hierarchyId}/${p.populationId}`,
        p.sampleMasks.map((m) => m.notEvaluated ? null : membershipBits(m.membershipBitsBase64, m.eventCount))]));
      let checked = 0;
      for (const p of built.populations) {
        if (!p.parentId) continue;
        const child = bitsOf.get(`${p.hierarchyId}/${p.populationId}`)!;
        const parent = bitsOf.get(`${p.hierarchyId}/${p.parentId}`)!;
        child.forEach((bits, i) => {
          if (!bits || !parent[i]) return;
          checked += 1;
          expect(bits.every((bit, e) => bit <= parent[i]![e]), `${p.populationName} in file ${i}`).toBe(true);
        });
      }
      expect(checked).toBeGreaterThan(40);

      // File 1's B cells come from its copy (tailored) in both trees, the others' from Main.
      const count = (bits: number[] | null) => bits!.reduce((a, b) => a + b, 0);
      const bMain = bitsOf.get(`main/${byName(main, "B cells")}`)!;
      const bCopy = bitsOf.get(`copy-1/${byName(copy, "B cells")}`)!;
      expect(bMain.map(count)).toEqual(bCopy.map(count));
      expect(count(bMain[1])).toBe(120);
      expect(count(bMain[0])).toBe(209);
    });
  }
});
