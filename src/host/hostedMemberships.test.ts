import { describe, expect, it } from "vitest";
import { buildHostedMemberships, hostedMembershipReader, workspaceHierarchyTrees, type HierarchyTree } from "./hostedMemberships";
import type { CoreState, GatingDerived } from "../store";
import type { PopulationMap } from "../engine/models";
const decodeUint8Base64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function population(id: string, name: string, parent: string | null, children: string[], gate?: string) {
  return {
    population_id: id, name, parent_id: parent, children,
    gate_refs: gate ? [{ gate_id: gate, include: true }] : [],
    gate_logic: "and" as const, event_count: null, percent_of_parent: null,
  };
}

const main: PopulationMap = {
  root: population("root", "All Events", null, ["live"]),
  live: population("live", "Live", "root", ["b"], "g-live"),
  b: population("b", "B cells", "live", [], "g-cd19"),
};
const parked: PopulationMap = {
  root2: population("root2", "All Events", null, ["s1"]),
  s1: population("s1", "Sample 01", "root2", [], "g-bc"),
};

// Every hierarchy owns its gate table: the live one is the store's, a parked one travels with it.
const state = {
  gates: {
    "g-live": { gate_id: "g-live", name: "Live" },
    "g-cd19": { gate_id: "g-cd19", name: "CD19+" },
  },
  gate_order: ["g-live", "g-cd19"],
  populations: main,
  root_population_id: "root",
  hierarchies: [{ id: "main", name: "Main" }, { id: "bc", name: "Barcodes" }],
  active_hierarchy_id: "main",
  stored_hierarchies: {
    bc: { id: "bc", name: "Barcodes", populations: parked, root_population_id: "root2",
      gates: { "g-bc": { gate_id: "g-bc", name: "BC 01" } }, gate_order: ["g-bc"],
      active_population_id: null, selected_pop_ids: [] },
  },
  file_hierarchies: {},
} as unknown as CoreState;

function gating(masks: Record<string, number[]>): GatingDerived {
  return {
    masks: Object.fromEntries(Object.entries(masks).map(([id, bits]) => [id, Uint8Array.from(bits)])),
    stats: { event_count: {}, percent_of_parent: {}, percent_of_total: {} },
    populations: {},
    gateMasks: {},
  };
}

describe("hosted memberships", () => {
  it("lists the live tree as the active hierarchy and parked trees from the store", () => {
    const trees = workspaceHierarchyTrees(state);
    expect(trees.map((t) => [t.id, t.active, t.root_population_id])).toEqual([
      ["main", true, "root"], ["bc", false, "root2"],
    ]);
    expect(trees[1].populations).toBe(parked);
    // A parked tree carries its own gates, not the live table's.
    expect(Object.keys(trees[0].gates)).toEqual(["g-live", "g-cd19"]);
    expect(Object.keys(trees[1].gates)).toEqual(["g-bc"]);
  });

  it("packs every population of every hierarchy per sample, parents before children", () => {
    const requested: string[] = [];
    const samples = [
      { sampleId: "sample-0", eventCount: 3, hierarchyId: "main", gatingFor: (tree: HierarchyTree) => {
        requested.push(`sample-0:${tree.id}`);
        return tree.id === "main"
          ? gating({ root: [1, 1, 1], live: [1, 1, 0], b: [1, 0, 0] })
          : gating({ root2: [1, 1, 1], s1: [0, 1, 0] });
      } },
      { sampleId: "sample-1", eventCount: 9, hierarchyId: "main", gatingFor: (tree: HierarchyTree) =>
        tree.id === "main"
          ? gating({ root: Array(9).fill(1), live: [0, 0, 0, 0, 0, 0, 0, 0, 1], b: Array(9).fill(0) })
          : gating({ root2: Array(9).fill(1), s1: Array(9).fill(0) }) },
    ];
    const built = buildHostedMemberships(state, samples);

    expect(built.hierarchies).toEqual([
      { id: "main", name: "Main", active: true, rootPopulationId: "root" },
      { id: "bc", name: "Barcodes", active: false, rootPopulationId: "root2" },
    ]);
    expect(built.populations.map((p) => `${p.hierarchyId}/${p.populationId}`)).toEqual([
      "main/root", "main/live", "main/b", "bc/root2", "bc/s1",
    ]);
    // Each sample is gated once per hierarchy, not once per population.
    expect(requested).toEqual(["sample-0:main", "sample-0:bc"]);

    const live = built.populations[1];
    expect(live.parentId).toBe("root");
    expect(live.gates).toEqual([{ gateId: "g-live", gateName: "Live", include: true }]);
    expect(live.sampleMasks.map((m) => [m.sampleId, m.eventCount])).toEqual([["sample-0", 3], ["sample-1", 9]]);
    // LSB-first bits: events 0 and 1 → 0b011 = 3; event 8 alone → second byte bit 0.
    expect([...decodeUint8Base64(live.sampleMasks[0].membershipBitsBase64)]).toEqual([3]);
    expect([...decodeUint8Base64(live.sampleMasks[1].membershipBitsBase64)]).toEqual([0, 1]);
    // A parked hierarchy's gates are named from its own table, not sent as bare ids.
    expect(built.populations[4].gates).toEqual([{ gateId: "g-bc", gateName: "BC 01", include: true }]);
  });

  it("refuses a population a sample could not evaluate rather than sending a gap", () => {
    const samples = [{ sampleId: "sample-0", eventCount: 3, hierarchyId: "main", gatingFor: () => gating({ root: [1, 1, 1] }) }];
    expect(() => buildHostedMemberships(state, samples)).toThrow(/'Live' of hierarchy 'Main'.*'sample-0'/);
  });
});

// The tree, one file's tailored copy of it, and an unrelated tree. The copy's populations point at
// the tree's by provenance, as ensureCopyForFile writes them.
describe("hosted memberships under per-file trees", () => {
  const copy: PopulationMap = {
    croot: population("croot", "All Events", null, ["clive"]),
    clive: population("clive", "Live", "croot", ["cb"], "cg-live"),
    cb: population("cb", "B cells", "clive", [], "cg-cd19"),
  };
  const copyRef = {
    id: "copy", name: "D2 · Main", owner_sample_id: "f2", structure_locked: true, source_hierarchy_id: "main",
    source_population_ids: { croot: "root", clive: "live", cb: "b" },
    source_gate_ids: { "cg-live": "g-live", "cg-cd19": "g-cd19" },
  };
  const copyGates = {
    "cg-live": { gate_id: "cg-live", name: "Live" },
    "cg-cd19": { gate_id: "cg-cd19", name: "CD19+" },
  };
  const mainGates = state.gates;
  const bcStored = (state.stored_hierarchies as Record<string, unknown>).bc;
  const hierarchies = [{ id: "main", name: "Main" }, copyRef, { id: "bc", name: "Barcodes" }];
  const treeLive = {
    ...state,
    hierarchies,
    stored_hierarchies: {
      copy: { ...copyRef, gates: copyGates, gate_order: ["cg-live", "cg-cd19"], populations: copy,
        root_population_id: "croot", active_population_id: null, selected_pop_ids: [] },
      bc: bcStored,
    },
    file_hierarchies: { f2: "copy" },
  } as unknown as CoreState;
  // The same workspace saved while D2 is viewed alone: its copy is live and the tree is parked.
  const copyLive = {
    ...treeLive,
    gates: copyGates,
    gate_order: ["cg-live", "cg-cd19"],
    populations: copy,
    root_population_id: "croot",
    active_hierarchy_id: "copy",
    stored_hierarchies: {
      main: { id: "main", name: "Main", gates: mainGates, gate_order: ["g-live", "g-cd19"], populations: main,
        root_population_id: "root", active_population_id: null, selected_pop_ids: [] },
      bc: bcStored,
    },
  } as unknown as CoreState;

  // Masks that say which tree gated them: each tree puts its own events inside.
  const byTree: Record<string, Record<string, number[]>> = {
    main: { root: [1, 1, 1], live: [1, 1, 0], b: [1, 0, 0] },
    copy: { croot: [1, 1, 1], clive: [0, 1, 1], cb: [0, 0, 1] },
    bc: { root2: [1, 1, 1], s1: [0, 1, 0] },
  };
  function samplesFor(requested: string[]) {
    return [
      { sampleId: "D1", hierarchyId: "main" },
      { sampleId: "D2", hierarchyId: "copy" },
    ].map(({ sampleId, hierarchyId }) => ({
      sampleId, hierarchyId, eventCount: 3,
      gatingFor: (tree: HierarchyTree) => {
        requested.push(`${sampleId}:${tree.id}:${Object.keys(tree.gates).join("+")}`);
        return gating(byTree[tree.id]);
      },
    }));
  }
  const decoded = (built: ReturnType<typeof buildHostedMemberships>) => Object.fromEntries(
    built.populations.map((p) => [
      `${p.hierarchyId}/${p.populationName}`,
      Object.fromEntries(p.sampleMasks.map((m) => [m.sampleId, [...decodeUint8Base64(m.membershipBitsBase64)][0]])),
    ]),
  );

  for (const [label, workspace] of [["tree live", treeLive], ["D2's copy live", copyLive]] as const) {
    it(`reads each file under its own tree in every hierarchy of its family, ${label}`, () => {
      const requested: string[] = [];
      const built = buildHostedMemberships(workspace, samplesFor(requested));
      // LSB-first: [1, 1, 0] → 3, [0, 1, 1] → 6, [1, 0, 0] → 1, [0, 0, 1] → 4, [0, 1, 0] → 2.
      expect(decoded(built)).toEqual({
        "main/All Events": { D1: 7, D2: 7 },
        "main/Live": { D1: 3, D2: 6 },
        "main/B cells": { D1: 1, D2: 4 },
        "copy/All Events": { D1: 7, D2: 7 },
        "copy/Live": { D1: 3, D2: 6 },
        "copy/B cells": { D1: 1, D2: 4 },
        // Another family: every file under that tree's own gates.
        "bc/All Events": { D1: 7, D2: 7 },
        "bc/Sample 01": { D1: 2, D2: 2 },
      });
      // Each file is gated once under its own tree and once under the other family's, each time
      // with that tree's own gate table; never under a sibling it does not follow.
      expect(requested.sort()).toEqual([
        "D1:bc:g-bc", "D1:main:g-live+g-cd19", "D2:bc:g-bc", "D2:copy:cg-live+cg-cd19",
      ]);
      expect(built.populations.find((p) => p.hierarchyId === "copy" && p.populationName === "B cells")!.gates)
        .toEqual([{ gateId: "cg-cd19", gateName: "CD19+", include: true }]);
      expect(built.hierarchies.map((h) => [h.id, h.active])).toEqual([
        ["main", workspace === treeLive], ["copy", workspace === copyLive], ["bc", false],
      ]);
    });
  }

  it("names the tree and population each file is read from", () => {
    const reader = hostedMembershipReader(treeLive, samplesFor([]));
    const main = reader.trees.find((t) => t.id === "main")!;
    const bc = reader.trees.find((t) => t.id === "bc")!;
    expect([0, 1].map((i) => reader.source(i, main, "b")!).map((s) => [s.tree.id, s.populationId]))
      .toEqual([["main", "b"], ["copy", "cb"]]);
    expect([0, 1].map((i) => reader.source(i, bc, "s1")!).map((s) => [s.tree.id, s.populationId]))
      .toEqual([["bc", "s1"], ["bc", "s1"]]);
  });
});
