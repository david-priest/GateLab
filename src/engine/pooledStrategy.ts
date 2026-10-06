// pooledStrategy.ts — the Strategy tab's steps and grid drawn from several files' events
// together, by the rules of pooledPlot.ts: the point cap shared out by population size, the
// counts summed, and a gate drawn only where every pooled file holds it alike. The members
// are the Gating tab's pool, prepared as the Illustration and Layout tabs prepare a file.

import type { GatingDerived } from "../store";
import { resolvePopulationInTree } from "./figure";
import { canonicalGateId, type StoredHierarchy } from "./hierarchies";
import { allocateCombinedSampleCaps } from "./multiSamplePlot";
import {
  finishMultiStrategyNode,
  multiStrategyLayout,
  type MultiStrategyLayoutGate,
  type MultiStrategyLayoutNode,
  type MultiStrategyNode,
} from "./multiStrategy";
import { gateGeometryKey, poolCompatibility } from "./pooledPlot";
import type { Sample } from "./sample";
import {
  displayValues,
  evenIndices,
  strategyStepMasks,
  strategyStepOf,
  thinEvenly,
  type StrategyOptions,
  type StrategyStep,
  type StrategyStepMask,
} from "./strategy";

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** One file of a pool, prepared: gated under its tree, with the traced population followed into that tree. */
export interface StrategyMember {
  id: string;
  name: string;
  sample: Sample;
  tree: StoredHierarchy;
  gating: GatingDerived;
  /** The traced population in this member's tree; "" when the tree has no counterpart. */
  populationId: string;
}

/** A file left out of a pooled strategy, and why. */
export interface StrategyLeftOut {
  name: string;
  reason: string;
}

export interface PooledStrategy {
  steps: StrategyStep[];
  /** The files drawn, the first the reference for axes, labels and gate boundaries. */
  drawn: StrategyMember[];
  /** Gates whose boundary is not drawn, by name: the files do not hold them alike. */
  omittedGates: string[];
  leftOut: StrategyLeftOut[];
}

const EMPTY_POOL: PooledStrategy = { steps: [], drawn: [], omittedGates: [], leftOut: [] };

/**
 * The gating path of the first member's population, drawn from every member's events together.
 * A member joins when its tree has the population, its path holds the same gates in the same
 * order (by lineage, so a copy's gates count) and its channels match the reference's on every
 * step; the rest are left out and named. Per step the point cap is shared out by each member's
 * parent population, the counts are summed over the members, and the gate's boundary is drawn
 * only when every member's gate has the same geometry.
 */
export function computePooledGatingStrategy(
  members: readonly StrategyMember[],
  trees: Record<string, StoredHierarchy>,
  opts: StrategyOptions,
): PooledStrategy {
  const reference = members[0];
  if (!reference) return EMPTY_POOL;
  const pathOf = (member: StrategyMember): StrategyStepMask[] =>
    strategyStepMasks(
      member.sample,
      member.tree.gates,
      member.tree.populations,
      member.tree.root_population_id ?? "",
      member.populationId,
      opts.fullPath,
    );
  const referencePath = pathOf(reference);
  const drawn: StrategyMember[] = [reference];
  const paths: StrategyStepMask[][] = [referencePath];
  const leftOut: StrategyLeftOut[] = [];
  for (const member of members.slice(1)) {
    if (!member.tree.populations[member.populationId]) {
      leftOut.push({ name: member.name, reason: "lacks the population" });
      continue;
    }
    const path = pathOf(member);
    const differs =
      path.length !== referencePath.length ||
      path.some(
        (step, index) =>
          step.ref.include !== referencePath[index].ref.include ||
          canonicalGateId(step.gate.gate_id, member.tree, trees) !==
            canonicalGateId(referencePath[index].gate.gate_id, reference.tree, trees),
      );
    if (differs) {
      leftOut.push({ name: member.name, reason: "its gating path differs" });
      continue;
    }
    const incompatible = referencePath
      .map((step) => poolCompatibility(reference.sample, member.sample, step.gate.x_channel, step.gate.y_channel))
      .find((reason) => reason !== null);
    if (incompatible) {
      leftOut.push({ name: member.name, reason: incompatible });
      continue;
    }
    drawn.push(member);
    paths.push(path);
  }

  const nTotal = drawn.reduce((total, member) => total + member.sample.fcs.nEvents, 0);
  const steps: StrategyStep[] = [];
  const omittedGates: string[] = [];
  for (let index = 0; index < referencePath.length; index++) {
    const referenceStep = referencePath[index];
    const stepMasks = paths.map((path) => path[index]);
    const counts = stepMasks.map((step) => step.nBefore);
    const nBefore = counts.reduce((total, count) => total + count, 0);
    // The path ends where its population runs out, as it does for one file.
    if (nBefore === 0) break;
    const nAfter = stepMasks.reduce((total, step) => total + step.nAfter, 0);
    // The cap shared out by each member's parent population; a member whose share rounds to
    // nothing contributes one point rather than, as a cap of zero would mean, all of them.
    const caps = allocateCombinedSampleCaps(counts, opts.maxEvents);
    const xs: number[][] = [];
    const ys: number[][] = [];
    drawn.forEach((member, m) => {
      const indices = evenIndices(stepMasks[m].before, Math.max(1, caps[m]));
      xs.push(displayValues(member.sample, referenceStep.gate.x_channel, indices));
      ys.push(displayValues(member.sample, referenceStep.gate.y_channel, indices));
    });
    const shape = gateGeometryKey(referenceStep.gate);
    const alike = stepMasks.every((step) => gateGeometryKey(step.gate) === shape);
    if (!alike) omittedGates.push(referenceStep.gate.name);
    steps.push(strategyStepOf(reference.sample, referenceStep, xs.flat(), ys.flat(), { nBefore, nAfter, nTotal }, alike));
  }
  return { steps, drawn, omittedGates, leftOut };
}

export interface PooledMultiStrategy {
  nodes: MultiStrategyNode[];
  /** The channel keys the nodes are drawn on, for Fit. */
  channels: string[];
  drawn: StrategyMember[];
  /** Gates not drawn, by the child population's name: the files do not hold them alike. */
  omittedGates: string[];
  leftOut: StrategyLeftOut[];
}

/**
 * The multi-population grid of the first member's tree, drawn from every member's events. The
 * selected populations belong to `templateTreeId`'s tree and are followed into each member's
 * tree by lineage, as is each node's parent; a member whose tree lacks a node's parent adds
 * nothing to that node. A member whose channels differ from the reference's on any node is
 * left out and named. Per node the cap is shared out by parent population and the counts are
 * summed; a gate is drawn, with the pooled percentage, only when every member holding the
 * node has it with the same geometry.
 */
export function computePooledMultiPopStrategy(
  members: readonly StrategyMember[],
  selectedPopIds: readonly string[],
  templateTreeId: string,
  trees: Record<string, StoredHierarchy>,
  opts: { maxEvents: number; globalScales: Record<string, [number, number]> },
): PooledMultiStrategy {
  const reference = members[0];
  if (!reference) return { nodes: [], channels: [], drawn: [], omittedGates: [], leftOut: [] };
  const resolveIn = (populationId: string, member: StrategyMember, fromTreeId: string): string | null => {
    const resolved = resolvePopulationInTree(populationId, member.tree, trees, fromTreeId);
    return resolved.missing ? null : resolved.id;
  };
  const layoutOf = (member: StrategyMember): MultiStrategyLayoutNode[] => {
    const selected = selectedPopIds
      .map((id) => resolveIn(id, member, templateTreeId))
      .filter((id): id is string => id !== null);
    return multiStrategyLayout(
      member.sample,
      member.tree.gates,
      member.tree.populations,
      member.tree.root_population_id ?? "",
      member.gating.masks,
      selected,
    );
  };
  const referenceNodes = layoutOf(reference);
  const drawn: StrategyMember[] = [reference];
  const layouts: MultiStrategyLayoutNode[][] = [referenceNodes];
  const leftOut: StrategyLeftOut[] = [];
  for (const member of members.slice(1)) {
    const incompatible = referenceNodes
      .map((node) => poolCompatibility(reference.sample, member.sample, node.x_channel, node.y_channel))
      .find((reason) => reason !== null);
    if (incompatible) {
      leftOut.push({ name: member.name, reason: incompatible });
      continue;
    }
    drawn.push(member);
    layouts.push(layoutOf(member));
  }

  const omitted = new Set<string>();
  const nodes = referenceNodes.map((node) => {
    // Each member's node for this one: the parent followed into the member's tree, on the same channels.
    const counterparts = drawn.map((member, index): MultiStrategyLayoutNode | null => {
      if (index === 0) return node;
      const parent = resolveIn(node.parent_id, member, reference.tree.id);
      if (parent === null) return null;
      return (
        layouts[index].find(
          (candidate) =>
            candidate.parent_id === parent &&
            candidate.x_channel === node.x_channel &&
            candidate.y_channel === node.y_channel,
        ) ?? null
      );
    });
    const counts = counterparts.map((counterpart) => counterpart?.n_total ?? 0);
    const caps = allocateCombinedSampleCaps(counts, opts.maxEvents);
    const xs: number[][] = [];
    const ys: number[][] = [];
    counterparts.forEach((counterpart, index) => {
      if (!counterpart) return;
      const indices = thinEvenly(counterpart.parentIdx, Math.max(1, caps[index]));
      xs.push(displayValues(drawn[index].sample, node.x_channel, indices));
      ys.push(displayValues(drawn[index].sample, node.y_channel, indices));
    });
    const nEvents = counts.reduce((total, count) => total + count, 0);
    const gates = node.gates.flatMap((gate) => {
      const canonical = canonicalGateId(gate.entry.gate_id, reference.tree, trees);
      const shape = gate.gateDef ? gateGeometryKey(gate.gateDef) : null;
      let inside = 0;
      let alike = shape !== null;
      counterparts.forEach((counterpart, index) => {
        if (!counterpart || !alike) return;
        const match: MultiStrategyLayoutGate | undefined =
          index === 0
            ? gate
            : counterpart.gates.find(
                (candidate) => canonicalGateId(candidate.entry.gate_id, drawn[index].tree, trees) === canonical,
              );
        if (!match?.gateDef || gateGeometryKey(match.gateDef) !== shape || match.nChild === null) {
          alike = false;
          return;
        }
        inside += match.nChild;
      });
      if (!alike) {
        omitted.add(gate.entry.name);
        return [];
      }
      return [{ entry: gate.entry, gateDef: gate.gateDef, pct: nEvents > 0 ? round1((inside / nEvents) * 100) : null }];
    });
    return finishMultiStrategyNode(reference.sample, node, xs.flat(), ys.flat(), nEvents, gates, opts.globalScales);
  });
  return {
    nodes,
    channels: referenceNodes.flatMap((node) => [node.x_channel, node.y_channel]),
    drawn,
    omittedGates: [...omitted],
    leftOut,
  };
}
