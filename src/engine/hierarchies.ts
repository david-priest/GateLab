// hierarchies.ts — several population hierarchies over one shared set of gates.
//
// A workspace holds one gate table and any number of population hierarchies. Exactly one
// hierarchy is active: its tree is the store's live `populations` / `root_population_id` /
// `active_population_id` / `selected_pop_ids`, which is what every plot, table and export reads.
// The others are parked here as StoredHierarchy records and swapped in on a switch. Gates are
// never copied per hierarchy: a gate edited on one hierarchy is the same gate on every other,
// which is the point — two debarcoding layouts over the same barcode gates, say, where the gate
// coordinates must not diverge.

import {
  newRootPopulation,
  removePopulationReparentChildren,
  sortPopulationTree,
  type Gate,
  type PopulationMap,
} from "./models";

export interface HierarchyRef {
  id: string;
  name: string;
}

/** A hierarchy that is not the active one: its whole tree, ready to become live. */
export interface StoredHierarchy extends HierarchyRef {
  populations: PopulationMap;
  root_population_id: string | null;
  active_population_id: string | null;
  selected_pop_ids: string[];
}

export const DEFAULT_HIERARCHY_ID = "main";
export const DEFAULT_HIERARCHY_NAME = "Main";

export function newHierarchyId(): string {
  return crypto.randomUUID();
}

/** A tree holding only a root, the way a fresh workspace starts. */
export function emptyHierarchyTree(eventCount: number | null = null): {
  populations: PopulationMap;
  root_population_id: string;
} {
  const root = newRootPopulation(eventCount);
  return { populations: { [root.population_id]: root }, root_population_id: root.population_id };
}

/**
 * A copy of a tree under fresh population ids, so two hierarchies never share a population id
 * (population metadata, masks and selections are keyed by it). Gate references are kept as
 * they are: the gates are shared. Returns the old→new id map so callers can carry metadata.
 */
export function cloneHierarchyTree(
  populations: PopulationMap,
  rootId: string,
): { populations: PopulationMap; root_population_id: string; idMap: Record<string, string> } {
  const idMap: Record<string, string> = {};
  const visit = (id: string): void => {
    if (idMap[id] || !populations[id]) return;
    idMap[id] = crypto.randomUUID();
    for (const child of populations[id].children) visit(child);
  };
  visit(rootId);
  const out: PopulationMap = {};
  for (const [oldId, newId] of Object.entries(idMap)) {
    const pop = populations[oldId];
    out[newId] = {
      ...pop,
      population_id: newId,
      parent_id: pop.parent_id ? idMap[pop.parent_id] ?? null : null,
      children: pop.children.filter((c) => idMap[c]).map((c) => idMap[c]),
      gate_refs: pop.gate_refs.map((r) => ({ ...r })),
    };
  }
  return { populations: out, root_population_id: idMap[rootId], idMap };
}

/** Every gate id some population of the tree references. */
export function referencedGateIds(populations: PopulationMap): Set<string> {
  const ids = new Set<string>();
  for (const pop of Object.values(populations)) for (const r of pop.gate_refs) ids.add(r.gate_id);
  return ids;
}

/**
 * The tree after these gates are deleted: references to them are dropped, and a population
 * built on a deleted quadrant gate goes with it (its children move up), the same rule the
 * live tree follows.
 */
export function pruneDeletedGates(
  populations: PopulationMap,
  rootId: string | null,
  gates: Record<string, Gate>,
  deleted: ReadonlySet<string>,
): PopulationMap {
  const out: PopulationMap = {};
  for (const [id, pop] of Object.entries(populations)) {
    out[id] = { ...pop, children: [...pop.children], gate_refs: pop.gate_refs.map((r) => ({ ...r })) };
  }
  for (const gid of deleted) {
    if (gates[gid]?.gate_type !== "quadrant") continue;
    for (const pid of Object.keys(out)) {
      if (out[pid] && out[pid].gate_refs.some((r) => r.gate_id === gid)) removePopulationReparentChildren(out, pid);
    }
  }
  for (const pop of Object.values(out)) {
    if (pop.gate_refs.some((r) => deleted.has(r.gate_id))) pop.gate_refs = pop.gate_refs.filter((r) => !deleted.has(r.gate_id));
  }
  if (rootId && out[rootId]) sortPopulationTree(out, rootId);
  return out;
}

/** The stored record of the active hierarchy, for parking it before a switch. */
export function storeHierarchy(
  ref: HierarchyRef,
  live: {
    populations: PopulationMap;
    root_population_id: string | null;
    active_population_id: string | null;
    selected_pop_ids: string[];
  },
): StoredHierarchy {
  return {
    id: ref.id,
    name: ref.name,
    populations: live.populations,
    root_population_id: live.root_population_id,
    active_population_id: live.active_population_id,
    selected_pop_ids: live.selected_pop_ids,
  };
}

/** A name no other hierarchy uses: "Main copy", "Main copy 2", … */
export function uniqueHierarchyName(base: string, taken: readonly HierarchyRef[]): string {
  const names = new Set(taken.map((h) => h.name));
  const trimmed = base.trim() || DEFAULT_HIERARCHY_NAME;
  if (!names.has(trimmed)) return trimmed;
  let i = 2;
  while (names.has(`${trimmed} ${i}`)) i++;
  return `${trimmed} ${i}`;
}
