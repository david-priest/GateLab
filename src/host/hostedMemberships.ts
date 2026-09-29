// hostedMemberships.ts — every population's membership, for every hierarchy and every SCE
// sample, in the form the R host stores beside the workspace.
//
// The workspace JSON holds gate geometry; which events fall inside a population is decided here in
// the browser, per gate space and transform. R cannot reproduce that without a second gating
// engine that could silently disagree, so an explicit save hands R the answer: one packed bitmask
// per population per sample, plus the tree each population sits in, so the whole hierarchy can be
// read back in R as a matrix or a per-event leaf assignment.

import type { CoreState, GatingDerived } from "../store";
import type { Gate, PopulationMap } from "../engine/models";
import { populationTreeOrder } from "../engine/populations";
import { encodeUint8Base64 } from "../engine/encode";
import { populationCorrespondence, storeHierarchy, type StoredHierarchy } from "../engine/hierarchies";
import { templateOf } from "../engine/groups";
import { packMembershipBits, type GateLabHostPopulationSampleMask } from "./colDataContract";
import type {
  GateLabHostMembershipPopulation,
  GateLabHostWorkspaceMemberships,
} from "./workspaceContract";

/**
 * One hierarchy's tree and its own gate table, whether it is the live one or parked in
 * stored_hierarchies. Every hierarchy owns its gates, so a parked tree is meaningless without them:
 * its references do not resolve in the live table, and a population whose gates are all dropped is
 * its parent.
 */
export interface HierarchyTree {
  id: string;
  name: string;
  active: boolean;
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string | null;
}

/** What the reader needs of a sample gated under one tree: its masks, and for the Statistics tab its counts. */
export type TreeGating = Pick<GatingDerived, "masks" | "stats">;

/** A sample, the tree it is gated under, and a way to gate it under any hierarchy. */
export interface MembershipSample {
  /**
   * The hierarchy the sample is gated under: the tree, its group's copy, or its own tailored copy,
   * as state.file_hierarchies assigns it (the first hierarchy when it assigns none).
   */
  hierarchyId: string;
  /** The file name, for a note saying a population was not evaluated for it. */
  name?: string;
  /** The sample gated under `tree`, with that tree's own gates. */
  gatingFor(tree: HierarchyTree): TreeGating;
}

/** An SCE sample, the tree it is gated under, and a way to gate it under any hierarchy. */
export interface HostedMembershipSample extends MembershipSample {
  sampleId: string;
  eventCount: number;
}

/** The hierarchies of a workspace in menu order, the active one carrying the live tree. */
export function workspaceHierarchyTrees(state: CoreState): HierarchyTree[] {
  return state.hierarchies.map((ref) => {
    if (ref.id === state.active_hierarchy_id) {
      return {
        id: ref.id,
        name: ref.name,
        active: true,
        gates: state.gates,
        gate_order: state.gate_order,
        populations: state.populations,
        root_population_id: state.root_population_id,
      };
    }
    const stored = state.stored_hierarchies[ref.id];
    return {
      id: ref.id,
      name: ref.name,
      active: false,
      gates: stored?.gates ?? {},
      gate_order: stored?.gate_order ?? [],
      populations: stored?.populations ?? {},
      root_population_id: stored?.root_population_id ?? null,
    };
  });
}

/** The gating state that evaluates `tree`: the store with that tree's gates and populations. */
export function gatingStateForTree(state: CoreState, tree: HierarchyTree): CoreState {
  return {
    ...state,
    gates: tree.gates,
    gate_order: tree.gate_order,
    populations: tree.populations,
    root_population_id: tree.root_population_id,
  };
}

/** Where one sample's membership of one population is read from. */
export interface MembershipSource {
  tree: HierarchyTree;
  populationId: string;
}

export interface HostedMembershipReader {
  trees: HierarchyTree[];
  /**
   * The tree and population that sample `index`'s membership of `populationId` in `tree` comes
   * from, or null when it is not evaluated: the tree the sample is gated under is of the same
   * family and has no counterpart for that population (a copy whose structure was unlocked and
   * changed). Another tree's gates never stand in for the sample's own.
   */
  source(index: number, tree: HierarchyTree, populationId: string): MembershipSource | null;
  /** Sample `index` gated under `tree`, gated at most once per tree. */
  gating(index: number, tree: HierarchyTree): TreeGating;
  /**
   * Sample `index`'s membership of `populationId` in `tree`, read under the tree it is gated
   * under; null when it is not evaluated (see `source`), undefined when the gating has no mask
   * for it, which is an error.
   */
  mask(index: number, tree: HierarchyTree, populationId: string): Uint8Array | null | undefined;
  /** Why `mask` is null for sample `index`: names the file, the population and the file's tree. */
  notEvaluatedNote(index: number, tree: HierarchyTree, populationId: string): string;
}

/**
 * Every sample's population masks, read under the tree that sample is gated under.
 *
 * A hierarchy's population is read, for each sample, from the tree the sample is gated under
 * whenever that tree is the hierarchy itself or another tree of its family: the tree, a group's
 * copy and a file's tailored copy all come from one template, followed up through the copies. The
 * population is found there by provenance, the way the FCS export finds it, so a tailored file's
 * events come from its own coordinates whichever tree of the family is asked for, and whichever of
 * them is live. When the sample's tree has no counterpart for the population, the population is
 * not evaluated for that sample. A hierarchy of another family is read with its own gates. Each
 * sample is gated at most once per tree, and each tree's lineage is walked once.
 */
export function hostedMembershipReader(
  state: CoreState,
  samples: readonly MembershipSample[],
): HostedMembershipReader {
  const trees = workspaceHierarchyTrees(state);
  const treeById = new Map(trees.map((tree) => [tree.id, tree]));
  const activeRef = state.hierarchies.find((ref) => ref.id === state.active_hierarchy_id);
  const stored: Record<string, StoredHierarchy> = activeRef
    ? { ...state.stored_hierarchies, [activeRef.id]: storeHierarchy(activeRef, state) }
    : state.stored_hierarchies;
  const counterpart = populationCorrespondence(stored);
  const families = new Map<string, string>();
  const familyOf = (id: string): string => {
    let family = families.get(id);
    if (family === undefined) {
      family = templateOf(id, state.hierarchies)?.id ?? id;
      families.set(id, family);
    }
    return family;
  };
  const gatings = samples.map(() => new Map<string, TreeGating>());
  const gating = (index: number, tree: HierarchyTree): TreeGating => {
    let result = gatings[index].get(tree.id);
    if (!result) {
      result = samples[index].gatingFor(tree);
      gatings[index].set(tree.id, result);
    }
    return result;
  };
  const source = (index: number, tree: HierarchyTree, populationId: string): MembershipSource | null => {
    const own = treeById.get(samples[index].hierarchyId);
    if (!own || own.id === tree.id || !own.root_population_id) return { tree, populationId };
    if (familyOf(own.id) !== familyOf(tree.id)) return { tree, populationId };
    // Every event of the sample, in whichever tree.
    if (populationId === tree.root_population_id) return { tree: own, populationId: own.root_population_id };
    const ownId = counterpart(tree.id, populationId, own.id);
    return ownId ? { tree: own, populationId: ownId } : null;
  };
  return {
    trees,
    source,
    gating,
    mask(index, tree, populationId) {
      const from = source(index, tree, populationId);
      return from ? gating(index, from.tree).masks[from.populationId] : null;
    },
    notEvaluatedNote(index, tree, populationId) {
      const sample = samples[index];
      const own = treeById.get(sample.hierarchyId);
      const name = tree.populations[populationId]?.name ?? populationId;
      return `'${name}' of '${tree.name}' was not evaluated for ${sample.name ?? "a sample"}: ` +
        `the tree it is gated under, '${own?.name ?? sample.hierarchyId}', has no such population.`;
    },
  };
}

/**
 * One sample's membership of one population as the host receives it: the packed bits from the
 * tree the sample is gated under, or, when that tree has no counterpart for the population, no
 * bits and a note, which the host records as NA for the sample's events rather than as outside.
 * A population that cannot be evaluated at all is an error rather than a gap: a partial set
 * would read in R as "these events are outside", which is wrong.
 */
export function hostedSampleMask(
  reader: HostedMembershipReader,
  samples: readonly HostedMembershipSample[],
  index: number,
  tree: HierarchyTree,
  populationId: string,
): GateLabHostPopulationSampleMask {
  const sample = samples[index];
  const mask = reader.mask(index, tree, populationId);
  if (mask === null) {
    return {
      sampleId: sample.sampleId,
      eventCount: sample.eventCount,
      membershipBitsBase64: "",
      notEvaluated: reader.notEvaluatedNote(index, tree, populationId),
    };
  }
  if (!mask || mask.length !== sample.eventCount) {
    const name = tree.populations[populationId]?.name ?? populationId;
    throw new Error(
      `Population '${name}' of hierarchy '${tree.name}' could not be ` +
        `evaluated for SCE sample '${sample.name ?? sample.sampleId}'.`,
    );
  }
  return {
    sampleId: sample.sampleId,
    eventCount: mask.length,
    membershipBitsBase64: encodeUint8Base64(packMembershipBits(mask)),
  };
}

/** The notes of every mask sent as not evaluated, in payload order. */
export function notEvaluatedNotes(masks: Iterable<GateLabHostPopulationSampleMask>): string[] {
  const notes: string[] = [];
  for (const mask of masks) if (mask.notEvaluated) notes.push(mask.notEvaluated);
  return notes;
}

/**
 * Build the memberships payload for an explicit save.
 *
 * Every population of every hierarchy is included, root included, so the R side can rebuild the
 * tree without the workspace JSON. Each sample's masks are read under the tree it is gated under
 * (hostedMembershipReader), so the tree R reads by default gives every file's own gating whichever
 * tree was live at the save. A population the sample's own tree has no counterpart for is sent as
 * not evaluated, with a note, and one it cannot evaluate at all is an error (hostedSampleMask).
 */
export function buildHostedMemberships(
  state: CoreState,
  samples: readonly HostedMembershipSample[],
): GateLabHostWorkspaceMemberships {
  const reader = hostedMembershipReader(state, samples);
  const trees = reader.trees.filter((tree) => tree.root_population_id);
  const populations: GateLabHostMembershipPopulation[] = [];
  for (const tree of trees) {
    const rootId = tree.root_population_id!;
    for (const { popId } of populationTreeOrder(tree.populations, rootId)) {
      const population = tree.populations[popId];
      if (!population) continue;
      const sampleMasks = samples.map((_, index) => hostedSampleMask(reader, samples, index, tree, popId));
      populations.push({
        hierarchyId: tree.id,
        populationId: popId,
        populationName: population.name,
        parentId: population.parent_id,
        gateLogic: population.gate_logic,
        gates: population.gate_refs.map((ref) => ({
          gateId: ref.gate_id,
          gateName: tree.gates[ref.gate_id]?.name ?? ref.gate_id,
          include: ref.include,
          ...(ref.quadrant !== undefined ? { quadrant: ref.quadrant } : {}),
        })),
        sampleMasks,
      });
    }
  }
  return {
    hierarchies: trees.map((tree) => ({
      id: tree.id,
      name: tree.name,
      active: tree.active,
      rootPopulationId: tree.root_population_id!,
    })),
    populations,
  };
}
