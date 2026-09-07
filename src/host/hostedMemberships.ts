// hostedMemberships.ts — every population's membership, for every hierarchy and every SCE
// sample, in the form the R host stores beside the workspace.
//
// The workspace JSON holds gate geometry; which events fall inside a population is decided here in
// the browser, per gate space and transform. R cannot reproduce that without a second gating
// engine that could silently disagree, so an explicit save hands R the answer: one packed bitmask
// per population per sample, plus the tree each population sits in, so the whole hierarchy can be
// read back in R as a matrix or a per-event leaf assignment.

import type { CoreState, GatingDerived } from "../store";
import type { PopulationMap } from "../engine/models";
import { populationTreeOrder } from "../engine/populations";
import { encodeUint8Base64 } from "../engine/encode";
import { packMembershipBits } from "./colDataContract";
import type {
  GateLabHostMembershipPopulation,
  GateLabHostWorkspaceMemberships,
} from "./workspaceContract";

/** One hierarchy's tree, whether it is the live one or parked in stored_hierarchies. */
export interface HierarchyTree {
  id: string;
  name: string;
  active: boolean;
  populations: PopulationMap;
  root_population_id: string | null;
}

/** An SCE sample and a way to gate it under any hierarchy. */
export interface HostedMembershipSample {
  sampleId: string;
  eventCount: number;
  gatingFor(tree: HierarchyTree): GatingDerived;
}

/** The hierarchies of a workspace in menu order, the active one carrying the live tree. */
export function workspaceHierarchyTrees(state: CoreState): HierarchyTree[] {
  return state.hierarchies.map((ref) => {
    if (ref.id === state.active_hierarchy_id) {
      return {
        id: ref.id,
        name: ref.name,
        active: true,
        populations: state.populations,
        root_population_id: state.root_population_id,
      };
    }
    const stored = state.stored_hierarchies[ref.id];
    return {
      id: ref.id,
      name: ref.name,
      active: false,
      populations: stored?.populations ?? {},
      root_population_id: stored?.root_population_id ?? null,
    };
  });
}

/**
 * Build the memberships payload for an explicit save.
 *
 * Every population of every hierarchy is included, root included, so the R side can rebuild the
 * tree without the workspace JSON. A population that a sample cannot evaluate is an error rather
 * than a gap: a partial set would read in R as "these events are outside", which is wrong.
 */
export function buildHostedMemberships(
  state: CoreState,
  samples: readonly HostedMembershipSample[],
): GateLabHostWorkspaceMemberships {
  const trees = workspaceHierarchyTrees(state).filter((tree) => tree.root_population_id);
  const populations: GateLabHostMembershipPopulation[] = [];
  for (const tree of trees) {
    const rootId = tree.root_population_id!;
    const gatingBySample = samples.map((sample) => sample.gatingFor(tree));
    for (const { popId } of populationTreeOrder(tree.populations, rootId)) {
      const population = tree.populations[popId];
      if (!population) continue;
      const sampleMasks = samples.map((sample, index) => {
        const mask = gatingBySample[index].masks[popId];
        if (!mask || mask.length !== sample.eventCount) {
          throw new Error(
            `Population '${population.name}' of hierarchy '${tree.name}' could not be ` +
              `evaluated for SCE sample '${sample.sampleId}'.`,
          );
        }
        return {
          sampleId: sample.sampleId,
          eventCount: mask.length,
          membershipBitsBase64: encodeUint8Base64(packMembershipBits(mask)),
        };
      });
      populations.push({
        hierarchyId: tree.id,
        populationId: popId,
        populationName: population.name,
        parentId: population.parent_id,
        gateLogic: population.gate_logic,
        gates: population.gate_refs.map((ref) => ({
          gateId: ref.gate_id,
          gateName: state.gates[ref.gate_id]?.name ?? ref.gate_id,
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
