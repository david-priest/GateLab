// strategyProposal.ts — a gating strategy proposed as a whole, from any source: an agent through
// the relay, a host such as GateLabR, or a file. A proposal is a list of keyed
// commands (agent/commands.ts) that later steps name as @key.population or @key.gate, and the
// target populations it is for. It is replayed on reducer copies of the live state, so it is
// checked and counted before anything changes; the app applies it only when the user accepts, as
// one undo step, with its source on every gate it made.

import { coreReducer, type Action, type CoreState } from "../store";
import type { GateProvenance } from "../engine/models";
import { AgentCommandError, commandToAction, type AgentCommand, type CommandContext } from "../agent/commands";
import type { AgentPopulation } from "../agent/protocol";
import { correspondingHierarchyId, storeHierarchy } from "../engine/hierarchies";

/** Where a proposal came from: the agent relay, a host (autogate or host, as the host names it), or a file. */
export type StrategyProposalSource = "agent" | "autogate" | "host" | "file";

export const STRATEGY_PROPOSAL_SOURCES: readonly StrategyProposalSource[] = ["agent", "autogate", "host", "file"];

/** The most steps one proposal may carry when the host sets no other limit. */
export const DEFAULT_PROPOSAL_STEP_LIMIT = 128;

/** The most target populations one proposal may name. */
export const PROPOSAL_TARGET_LIMIT = 128;

/** The active tree's root, by name, for a source that cannot read its id first. */
export const ROOT_ALIAS = "@root";

export interface StrategyProposalStep {
  /** Unique in the proposal; later steps name what this one made as @key.population or @key.gate. */
  key: string;
  command: AgentCommand;
}

/** A whole strategy, as any source proposes it. */
export interface StrategyProposal {
  source: StrategyProposalSource;
  /** The writer's name put on every gate it makes: the agent's, or the host's. */
  by: string;
  rationale: string;
  /** Checked as they are replayed. */
  steps: unknown;
  /** What each target is called by the source (a label, a key) → its population id or alias. */
  targets: Record<string, string>;
  /** The samples to count the preview on; every loaded sample when absent. */
  sampleIds?: string[];
}

/**
 * A gate's provenance with the proposal's source. GateProvenance lives in the frozen models.ts; the
 * source rides on it as one more field, which a workspace keeps as it keeps the rest of the gate
 * and evaluation never reads.
 */
export interface StrategyProvenance extends GateProvenance {
  source: StrategyProposalSource;
}

export function strategyProvenance(by: string, rationale: string, source: StrategyProposalSource): StrategyProvenance {
  return { by, rationale, at: new Date().toISOString(), source };
}

/** The source a gate's provenance records, or null for a gate made before sources were recorded. */
export function provenanceSource(provenance: GateProvenance | undefined): StrategyProposalSource | null {
  const source = (provenance as Partial<StrategyProvenance> | undefined)?.source;
  return typeof source === "string" && (STRATEGY_PROPOSAL_SOURCES as readonly string[]).includes(source) ? (source as StrategyProposalSource) : null;
}

/** The refusal when the gating moved between the preview the user saw and their acceptance. */
export class StrategyMovedError extends AgentCommandError {
  constructor() {
    super("The gating changed after the proposal was previewed; it has to be previewed again.");
    this.name = "StrategyMovedError";
  }
}

export interface ReplayedStrategy {
  next: CoreState;
  /** @key.population and @key.gate → the id that step made on the copy. */
  aliases: Record<string, string>;
  /** An id field's value with its alias resolved; an unknown alias is refused. */
  resolve: (id: unknown) => unknown;
}

/**
 * Replay a proposal's steps on reducer copies of `base`: no dispatch, view update, autosave or
 * host write. Each step is checked as an agent command is (commandToAction) under the context
 * `contextFor` gives for the state it applies to; undo and redo are refused, keys must be unique
 * identifiers, and a step that made exactly one population or gate can be named by later ones.
 */
export function replayStrategy(base: CoreState, steps: unknown, stepLimit: number, contextFor: (state: CoreState) => CommandContext, route: (state: CoreState, action: Action) => Action = (_state, action) => action): ReplayedStrategy {
  if (!Array.isArray(steps) || steps.length > stepLimit) throw new AgentCommandError(`A proposal needs at most ${stepLimit} steps.`);
  let next = base;
  const aliases: Record<string, string> = {};
  const resolve = (id: unknown): unknown => {
    if (typeof id !== "string" || !id.startsWith("@")) return id;
    if (id === ROOT_ALIAS && base.root_population_id) return base.root_population_id;
    if (!aliases[id]) throw new AgentCommandError(`Unknown proposal reference ${id}.`);
    return aliases[id];
  };
  const keys = new Set<string>();
  for (const step of steps as StrategyProposalStep[]) {
    if (!step || typeof step.key !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(step.key) || keys.has(step.key)) throw new AgentCommandError("Proposal step keys must be unique identifiers.");
    keys.add(step.key);
    const command: Record<string, unknown> = step.command && typeof step.command === "object" && !Array.isArray(step.command) ? { ...(step.command as Record<string, unknown>) } : {};
    if (["undo", "redo"].includes(String(command.type))) throw new AgentCommandError("Proposal steps cannot undo or redo live history.");
    for (const field of ["parentId", "gateId", "populationId", "targetId"]) if (command[field] !== undefined) command[field] = resolve(command[field]);
    if (Array.isArray(command.gates)) command.gates = command.gates.map((g) => {
      const gate = g && typeof g === "object" && !Array.isArray(g) ? (g as Record<string, unknown>) : {};
      return { ...gate, gateId: resolve(gate.gateId) };
    });
    const previous = next;
    next = coreReducer(next, route(next, commandToAction(command as AgentCommand, contextFor(next))));
    const populations = Object.keys(next.populations).filter((id) => !previous.populations[id]);
    const gates = Object.keys(next.gates).filter((id) => !previous.gates[id]);
    if (populations.length === 1) aliases[`@${step.key}.population`] = populations[0];
    if (gates.length === 1) aliases[`@${step.key}.gate`] = gates[0];
  }
  return { next, aliases, resolve };
}

/** The targets' ids on the replayed state, each a population there, and every ancestor of them. */
export function strategyTargets(next: CoreState, targets: readonly string[], resolve: (id: unknown) => unknown): { populationIds: string[]; wanted: string[] } {
  const wanted = new Set<string>();
  const populationIds = targets.map((id) => String(resolve(id)));
  for (const target of populationIds) {
    if (!next.populations[target]) throw new AgentCommandError(`Unknown proposal population ${target}.`);
    let id: string | null = target;
    while (id && !wanted.has(id)) { wanted.add(id); id = next.populations[id]?.parent_id ?? null; }
  }
  return { populationIds, wanted: [...wanted] };
}

/** What a replayed proposal does to what was there before it: made, changed and removed, by id. */
export function strategyChanges(base: CoreState, next: CoreState) {
  const made = <T,>(from: Record<string, T>, to: Record<string, T>) => Object.keys(to).filter((id) => !from[id]);
  const changed = <T,>(from: Record<string, T>, to: Record<string, T>) => Object.keys(from).filter((id) => to[id] && to[id] !== from[id]);
  const removed = <T,>(from: Record<string, T>, to: Record<string, T>) => Object.keys(from).filter((id) => !to[id]);
  const live = base.hierarchies.find((h) => h.id === base.active_hierarchy_id);
  const trees = { ...base.stored_hierarchies, ...(live ? { [live.id]: storeHierarchy(live, base) } : {}) };
  const scopedGateChanges = Object.entries(base.stored_hierarchies).flatMap(([hierarchyId, before]) => {
    const after = next.stored_hierarchies[hierarchyId];
    const ref = base.hierarchies.find((h) => h.id === hierarchyId);
    if (!after || !ref || hierarchyId === base.active_hierarchy_id) return [];
    return changed(before.gates, after.gates).filter((gateId) => JSON.stringify(before.gates[gateId]) !== JSON.stringify(after.gates[gateId])).map((gateId) => ({
      hierarchyId, gateId,
      canonicalGateId: live ? correspondingHierarchyId(before, gateId, trees[live.id], trees, "gate") : null,
      name: before.gates[gateId].name,
      scope: ref.owner_sample_id ? "file" as const : ref.owner_group_id ? "group" as const : "tree" as const,
      ownerName: ref.owner_group_id ? base.groups.find((g) => g.id === ref.owner_group_id)?.name ?? ref.name : ref.name,
    }));
  });
  return {
    createdGateIds: made(base.gates, next.gates),
    createdPopulationIds: made(base.populations, next.populations),
    changedGateIds: [...new Set([...changed(base.gates, next.gates), ...scopedGateChanges.flatMap((g) => g.canonicalGateId ? [g.canonicalGateId] : [])])],
    scopedGateChanges,
    // A population whose child was added is not itself changed; what defines it is compared.
    changedPopulationIds: changed(base.populations, next.populations).filter((id) => {
      const a = base.populations[id], b = next.populations[id];
      return a.name !== b.name || a.parent_id !== b.parent_id || a.gate_logic !== b.gate_logic || JSON.stringify(a.gate_refs) !== JSON.stringify(b.gate_refs);
    }),
    removedGateIds: removed(base.gates, next.gates),
    removedPopulationIds: removed(base.populations, next.populations),
  };
}

/** A proposal counted on a copy of the state, for the user to accept or reject. */
export interface StrategyReview {
  proposal: StrategyProposal;
  /** The state it was previewed on; it is applied only while the gating is still this one. */
  base: CoreState;
  next: CoreState;
  aliases: Record<string, string>;
  /** Each target as the source named it → its population id on the copy. */
  targets: Record<string, string>;
  /** The samples the counts are over. */
  sampleIds: string[];
  /** The active tree under the proposal, in tree order, with what is new and what is a target. */
  populations: (AgentPopulation & { isNew: boolean; isTarget: boolean })[];
  changes: ReturnType<typeof strategyChanges>;
}

/** An accepted proposal: what it made, under the ids the live state now has. */
export interface StrategyApplied {
  revision: number;
  targets: Record<string, string>;
  aliases: Record<string, string>;
  createdGateIds: string[];
  createdPopulationIds: string[];
}
