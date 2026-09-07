import { describe, expect, it } from "vitest";
import { buildHostedMemberships, workspaceHierarchyTrees, type HierarchyTree } from "./hostedMemberships";
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

const state = {
  gates: {
    "g-live": { gate_id: "g-live", name: "Live" },
    "g-cd19": { gate_id: "g-cd19", name: "CD19+" },
    "g-bc": { gate_id: "g-bc", name: "BC 01" },
  },
  populations: main,
  root_population_id: "root",
  hierarchies: [{ id: "main", name: "Main" }, { id: "bc", name: "Barcodes" }],
  active_hierarchy_id: "main",
  stored_hierarchies: {
    bc: { id: "bc", name: "Barcodes", populations: parked, root_population_id: "root2",
      active_population_id: null, selected_pop_ids: [] },
  },
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
  });

  it("packs every population of every hierarchy per sample, parents before children", () => {
    const requested: string[] = [];
    const samples = [
      { sampleId: "sample-0", eventCount: 3, gatingFor: (tree: HierarchyTree) => {
        requested.push(`sample-0:${tree.id}`);
        return tree.id === "main"
          ? gating({ root: [1, 1, 1], live: [1, 1, 0], b: [1, 0, 0] })
          : gating({ root2: [1, 1, 1], s1: [0, 1, 0] });
      } },
      { sampleId: "sample-1", eventCount: 9, gatingFor: (tree: HierarchyTree) =>
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
  });

  it("refuses a population a sample could not evaluate rather than sending a gap", () => {
    const samples = [{ sampleId: "sample-0", eventCount: 3, gatingFor: () => gating({ root: [1, 1, 1] }) }];
    expect(() => buildHostedMemberships(state, samples)).toThrow(/'Live' of hierarchy 'Main'.*'sample-0'/);
  });
});
