// Where each file reads each population, for many tailored files: every population of every tree,
// for every file's tree. Each tree's lineage is walked once, where it used to be walked for every
// population of the file's tree on every question, so the cost grew with the square of the number
// of tailored files. The public BCR-XL example tree, copied per file.

import { describe, expect, it } from "vitest";
import {
  cloneHierarchyTree,
  correspondingHierarchyId,
  populationCorrespondence,
  type StoredHierarchy,
} from "../engine/hierarchies";
import type { CoreState } from "../store";
import { bcrxlAvailable, bcrxlTree, type BcrxlTree } from "./bcrxlSceFixture";
import { buildHostedMemberships, type HierarchyTree, type HostedMembershipSample } from "./hostedMemberships";

const invert = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));

// With every file tailored, building the payload asks (files + 1) × populations × files questions.
describe.runIf(bcrxlAvailable())("memberships payload with many tailored files (public BCR-XL tree)", () => {
  it("walks each tree's lineage once, not once per file per population", () => {
    const main = bcrxlTree();
    const files = 100;
    const populationCount = Object.keys(main.populations).length;
    let lineageReads = 0;
    const counted = (map: Record<string, string>) => new Proxy(map, {
      get(target, key, receiver) { lineageReads += 1; return Reflect.get(target, key, receiver); },
    });
    const copies: StoredHierarchy[] = Array.from({ length: files }, (_, i) => {
      const clone = cloneHierarchyTree(main.populations, main.root_population_id, main.gates, main.gate_order);
      return {
        id: `copy-${i}`, name: `file ${i} · Main`, owner_sample_id: `sample-${i}`, structure_locked: true,
        source_hierarchy_id: "main", source_gate_ids: invert(clone.gateIdMap),
        source_population_ids: counted(invert(clone.idMap)),
        gates: clone.gates, gate_order: clone.gate_order, populations: clone.populations,
        root_population_id: clone.root_population_id, active_population_id: clone.root_population_id, selected_pop_ids: [],
      };
    });
    const state = {
      gates: main.gates, gate_order: main.gate_order, populations: main.populations, root_population_id: main.root_population_id,
      hierarchies: [{ id: "main", name: "Main" }, ...copies.map(({ id, name, owner_sample_id, source_hierarchy_id }) =>
        ({ id, name, owner_sample_id, structure_locked: true, source_hierarchy_id }))],
      active_hierarchy_id: "main",
      stored_hierarchies: Object.fromEntries(copies.map((copy) => [copy.id, copy])),
      file_hierarchies: {},
    } as unknown as CoreState;
    const events = 64;
    const samples: HostedMembershipSample[] = copies.map((copy, i) => ({
      sampleId: `sample-${i}`, eventCount: events, hierarchyId: copy.id,
      gatingFor: (tree: HierarchyTree) => ({
        masks: Object.fromEntries(Object.keys(tree.populations).map((id) => [id, new Uint8Array(events).fill(1)])),
        stats: { event_count: {}, percent_of_parent: {}, percent_of_total: {} }, populations: {}, gateMasks: {},
      }),
    }));

    const started = performance.now();
    const built = buildHostedMemberships(state, samples);
    const elapsed = performance.now() - started;
    expect(built.populations).toHaveLength((files + 1) * populationCount);
    // Each copy population's lineage is two steps: one read of the map on the way up. The old walk
    // read it on every question for every population of the file's tree, 1.3 million times here.
    expect(lineageReads).toBeLessThan(4 * (files + 1) * populationCount);
    // On the timing, only a generous bound: the old walk took seconds here.
    expect(elapsed).toBeLessThan(5_000);
  }, 60_000);
});

describe.runIf(bcrxlAvailable())("population correspondence, cached (public BCR-XL tree)", () => {
  it("answers exactly as correspondingHierarchyId for every population of every pair of trees", () => {
    const main = bcrxlTree();
    const stored = (id: string, tree: BcrxlTree, ref: Partial<StoredHierarchy> = {}): StoredHierarchy => ({
      id, name: id, ...tree, active_population_id: tree.root_population_id, selected_pop_ids: [], ...ref,
    });
    const copyOf = (id: string, source: StoredHierarchy, ref: Partial<StoredHierarchy> = {}): StoredHierarchy => {
      const clone = cloneHierarchyTree(source.populations, source.root_population_id!, source.gates, source.gate_order);
      return stored(id, { gates: clone.gates, gate_order: clone.gate_order, populations: clone.populations, root_population_id: clone.root_population_id }, {
        source_hierarchy_id: source.id, source_gate_ids: invert(clone.gateIdMap), source_population_ids: invert(clone.idMap), ...ref,
      });
    };
    const tree = stored("main", main);
    const group = copyOf("group", tree, { owner_group_id: "g1" });
    const groupFile = copyOf("group-file", group, { owner_sample_id: "sample-2" });
    // Unlocked and restructured: one population removed, one of its own added.
    const restructured = copyOf("restructured", tree, { owner_sample_id: "sample-1", structure_locked: false });
    const removed = Object.keys(restructured.populations).find((id) => restructured.populations[id].name === "IgM+ B cells")!;
    delete restructured.populations[removed];
    restructured.populations["copy-only"] = { ...restructured.populations[restructured.root_population_id!], population_id: "copy-only", name: "Copy only", parent_id: restructured.root_population_id, children: [] };
    // Two of this copy's populations claim the same source: neither is that source's counterpart.
    const ambiguous = copyOf("ambiguous", tree, { owner_sample_id: "sample-0" });
    const [first, second] = Object.keys(ambiguous.populations).filter((id) => id !== ambiguous.root_population_id);
    ambiguous.source_population_ids = { ...ambiguous.source_population_ids, [second]: ambiguous.source_population_ids![first] };
    const independent = stored("independent", structuredClone(main));
    const trees = Object.fromEntries([tree, group, groupFile, restructured, ambiguous, independent].map((t) => [t.id, t]));

    const cached = populationCorrespondence(trees);
    let matched = 0;
    let unmatched = 0;
    for (const source of Object.values(trees)) {
      for (const populationId of [...Object.keys(source.populations), "no-such-population"]) {
        for (const target of Object.values(trees)) {
          const expected = correspondingHierarchyId(source, populationId, target, trees, "population");
          expect(cached(source.id, populationId, target.id), `${source.id}/${populationId} → ${target.id}`).toBe(expected);
          if (expected) matched += 1;
          else unmatched += 1;
        }
      }
    }
    expect(matched).toBeGreaterThan(200);
    expect(unmatched).toBeGreaterThan(50);
  });
});
