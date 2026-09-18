// hierarchies.ts — several population hierarchies, each with its own gates.
//
// A workspace holds any number of population hierarchies. Exactly one is active: its tree and
// gate table are the store's live `gates` / `gate_order` / `populations` / `root_population_id` /
// `active_population_id` / `selected_pop_ids`, which is what every plot, table and export reads.
// The others are parked here as StoredHierarchy records, gates included, and swapped in on a
// switch. A hierarchy owns its geometry: editing or deleting a gate on one leaves every other
// untouched, and a duplicated hierarchy gets its own copy of every gate.

import { newRootPopulation, type Gate, type PopulationMap } from "./models";

export interface HierarchyRef {
  id: string;
  name: string;
  /** A per-file working leaf is locked to this stable sample id. Templates have no owner. */
  owner_sample_id?: string;
  /**
   * A group's working tree, locked to this group id: the tree's structure with the group's own
   * gate coordinates. Its files' copies follow it the way an ungrouped file's copy follows the
   * tree. Never a sample's, never live for a file.
   */
  owner_group_id?: string;
  /** File-owned leaves protect their source structure by default; geometry remains editable. */
  structure_locked?: boolean;
  /** Immediate snapshot source. This is provenance, not live inheritance. */
  source_hierarchy_id?: string;
  /** This hierarchy's copied gate id → the source hierarchy's gate id. */
  source_gate_ids?: Record<string, string>;
  /** This hierarchy's copied population id → the source hierarchy's population id. */
  source_population_ids?: Record<string, string>;
}

/** A hierarchy that is not the active one: its whole tree, ready to become live. */
export interface StoredHierarchy extends HierarchyRef {
  /** The hierarchy's OWN gates. Editing one leaves every other hierarchy untouched. */
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string | null;
  active_population_id: string | null;
  selected_pop_ids: string[];
}

/**
 * The gate a copied gate descends from: its id in the tree at the root of the copy chain. Two
 * gates in two trees are the same gate when this agrees, which is how a label placement, one
 * per gate, reaches every tree the gate is drawn in.
 */
export function canonicalGateId(
  gateId: string,
  tree: StoredHierarchy,
  trees: Record<string, StoredHierarchy>,
): string {
  let current: StoredHierarchy | undefined = tree;
  let id = gateId;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const mapped = current.source_gate_ids?.[id];
    if (!mapped || !current.source_hierarchy_id) break;
    id = mapped;
    current = trees[current.source_hierarchy_id];
  }
  return id;
}

/** A working copy, a file's or a group's, as opposed to the tree itself. */
export function isCopyRef(h: Pick<HierarchyRef, "owner_sample_id" | "owner_group_id">): boolean {
  return !!h.owner_sample_id || !!h.owner_group_id;
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
 * (population metadata, masks and selections are keyed by it). Given the hierarchy's gates, they
 * are copied under fresh gate ids as well and every reference rewritten, so the copy owns its
 * geometry the way every hierarchy does; without them the references are kept as they are.
 * Returns the old→new id maps so callers can carry metadata.
 */
export function cloneHierarchyTree(
  populations: PopulationMap,
  rootId: string,
  gates?: Record<string, Gate>,
  gate_order?: string[],
): {
  populations: PopulationMap;
  root_population_id: string;
  idMap: Record<string, string>;
  gates: Record<string, Gate>;
  gate_order: string[];
  gateIdMap: Record<string, string>;
} {
  const idMap: Record<string, string> = {};
  const visit = (id: string): void => {
    if (idMap[id] || !populations[id]) return;
    idMap[id] = crypto.randomUUID();
    for (const child of populations[id].children) visit(child);
  };
  visit(rootId);
  const gateIdMap: Record<string, string> = {};
  const outGates: Record<string, Gate> = {};
  for (const [oldId, gate] of Object.entries(gates ?? {})) {
    const newId = crypto.randomUUID();
    gateIdMap[oldId] = newId;
    outGates[newId] = { ...structuredClone(gate), gate_id: newId };
  }
  const out: PopulationMap = {};
  for (const [oldId, newId] of Object.entries(idMap)) {
    const pop = populations[oldId];
    out[newId] = {
      ...pop,
      population_id: newId,
      parent_id: pop.parent_id ? idMap[pop.parent_id] ?? null : null,
      children: pop.children.filter((c) => idMap[c]).map((c) => idMap[c]),
      gate_refs: pop.gate_refs.map((r) => ({ ...r, gate_id: gateIdMap[r.gate_id] ?? r.gate_id })),
    };
  }
  const order = (gate_order ?? Object.keys(gates ?? {})).filter((id) => gateIdMap[id]).map((id) => gateIdMap[id]);
  return { populations: out, root_population_id: idMap[rootId], idMap, gates: outGates, gate_order: order, gateIdMap };
}

/**
 * A strategy built against another hierarchy's gates, made to own them: the named gates are
 * copied from `source` under fresh ids and every reference in the strategy is rewritten to the
 * copies. A barcode scheme imported into a NEW hierarchy reuses the gates of the hierarchy it
 * is imported from, by name and channels; those belong to that hierarchy, so the new one takes
 * copies rather than references it cannot resolve. Ids not in `source`, or already in the
 * strategy's own table, are left as they are.
 */
export function adoptGates<T extends { gates: Record<string, Gate>; gate_order: string[]; populations: PopulationMap }>(
  strategy: T,
  source: Record<string, Gate>,
  ids: readonly string[],
): T {
  const gateIdMap: Record<string, string> = {};
  const gates: Record<string, Gate> = { ...strategy.gates };
  const copied: string[] = [];
  for (const id of ids) {
    if (gateIdMap[id] || gates[id] || !source[id]) continue;
    const newId = crypto.randomUUID();
    gateIdMap[id] = newId;
    gates[newId] = { ...structuredClone(source[id]), gate_id: newId };
    copied.push(newId);
  }
  if (!copied.length) return strategy;
  const populations: PopulationMap = {};
  for (const [pid, pop] of Object.entries(strategy.populations)) {
    populations[pid] = { ...pop, gate_refs: pop.gate_refs.map((r) => ({ ...r, gate_id: gateIdMap[r.gate_id] ?? r.gate_id })) };
  }
  return { ...strategy, gates, gate_order: [...copied, ...strategy.gate_order], populations };
}

/** Every gate id some population of the tree references. */
export function referencedGateIds(populations: PopulationMap): Set<string> {
  const ids = new Set<string>();
  for (const pop of Object.values(populations)) for (const r of pop.gate_refs) ids.add(r.gate_id);
  return ids;
}

/** The stored record of the active hierarchy, for parking it before a switch. */
export function storeHierarchy(
  ref: HierarchyRef,
  live: {
    gates: Record<string, Gate>;
    gate_order: string[];
    populations: PopulationMap;
    root_population_id: string | null;
    active_population_id: string | null;
    selected_pop_ids: string[];
  },
): StoredHierarchy {
  return {
    ...ref,
    gates: live.gates,
    gate_order: live.gate_order,
    populations: live.populations,
    root_population_id: live.root_population_id,
    active_population_id: live.active_population_id,
    selected_pop_ids: live.selected_pop_ids,
  };
}

/** Match copied entities by provenance, never by a potentially reused display name. */
export function correspondingHierarchyId(
  source: StoredHierarchy,
  id: string,
  target: StoredHierarchy,
  trees: Readonly<Record<string, StoredHierarchy>>,
  kind: "population" | "gate",
): string | null {
  const entities = kind === "population" ? "populations" : "gates";
  const mapping = kind === "population" ? "source_population_ids" : "source_gate_ids";
  const lineage = (tree: StoredHierarchy, entityId: string): Set<string> => {
    const keys = new Set<string>();
    let current: StoredHierarchy | undefined = tree;
    while (current) {
      const key = JSON.stringify([current.id, entityId]);
      if (keys.has(key)) break;
      keys.add(key);
      const parentId: string | undefined = current[mapping]?.[entityId];
      if (!parentId || !current.source_hierarchy_id) break;
      entityId = parentId;
      current = trees[current.source_hierarchy_id];
    }
    return keys;
  };
  if (!source[entities][id]) return null;
  if (source.id === target.id && target[entities][id]) return id;
  const keys = lineage(source, id);
  const matches = Object.keys(target[entities]).filter((candidate) =>
    [...lineage(target, candidate)].some((key) => keys.has(key)));
  return matches.length === 1 ? matches[0] : null;
}

/** The same browsing position across files; a missing branch falls back to its nearest ancestor. */
export function selectionAcrossHierarchies(
  source: StoredHierarchy,
  target: StoredHierarchy,
  trees: Readonly<Record<string, StoredHierarchy>>,
): Pick<StoredHierarchy, "active_population_id" | "selected_pop_ids"> {
  let id = source.active_population_id;
  let active: string | null = null;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    active = correspondingHierarchyId(source, id, target, trees, "population");
    if (active) break;
    id = source.populations[id]?.parent_id ?? null;
  }
  return {
    active_population_id: active ?? target.root_population_id,
    selected_pop_ids: [...new Set((source.selected_pop_ids ?? []).flatMap((pid) => {
      const match = correspondingHierarchyId(source, pid, target, trees, "population");
      return match ? [match] : [];
    }))],
  };
}

/**
 * The hierarchy a file is gated under when the workspace assigns hierarchies per file: its
 * own assignment when that names a listed hierarchy, else the first hierarchy. A file that was
 * never assigned, or whose hierarchy has since been deleted, therefore falls back to the first
 * one rather than to nothing, so every file always has a tree.
 */
export function fileHierarchyId(assigned: string | undefined, hierarchies: readonly HierarchyRef[]): string {
  if (assigned && hierarchies.some((h) => h.id === assigned)) return assigned;
  return hierarchies[0]?.id ?? DEFAULT_HIERARCHY_ID;
}

/**
 * The colour a hierarchy is shown in, by its position in the menu, so the files assigned to
 * it and the menu entry read as the same thing. Ten colours, ColorBrewer Set1/Dark2 picks
 * that stay apart from the green "checked" and blue "active" file marks; an eleventh
 * hierarchy wraps round.
 */
export const HIERARCHY_COLOURS = [
  "#7b3fa0", "#e6820e", "#1f9e89", "#c2185b", "#5b6abf",
  "#8d6e2f", "#00838f", "#a61b1b", "#6d8b1e", "#5c5c5c",
] as const;

export function hierarchyColour(index: number): string {
  return HIERARCHY_COLOURS[((index % HIERARCHY_COLOURS.length) + HIERARCHY_COLOURS.length) % HIERARCHY_COLOURS.length];
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
