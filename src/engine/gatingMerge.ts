import type { Gate, Population, PopulationMap } from "./models";
import { sortPopulationTree } from "./models";

export type GatingImportMode = "replace" | "merge";

export interface GatingStrategyGraph {
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string;
}

export interface GatingMergeResult extends GatingStrategyGraph {
  gateIdMap: Record<string, string>;
  populationIdMap: Record<string, string>;
}

function importedId(sourceId: string, used: Set<string>): string {
  if (!used.has(sourceId)) {
    used.add(sourceId);
    return sourceId;
  }
  let suffix = 1;
  let candidate = `${sourceId}-imported`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${sourceId}-imported-${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function cloneGate(gate: Gate, gateId: string): Gate {
  const labelOffset = gate.label_offset ? [...gate.label_offset] as [number, number] : null;
  if (gate.gate_type === "quadrant") {
    return { ...gate, gate_id: gateId, center: [...gate.center], label_offset: labelOffset };
  }
  return {
    ...gate,
    gate_id: gateId,
    vertices: gate.vertices.map((vertex) => [...vertex] as [number, number]),
    label_offset: labelOffset,
  };
}

function clonePopulation(population: Population): Population {
  return {
    ...population,
    gate_refs: population.gate_refs.map((ref) => ({ ...ref })),
    children: [...population.children],
  };
}

function orderedIds(order: string[], available: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...order, ...Object.keys(available)]) {
    if (!(id in available) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Add an imported Gating-ML strategy beside the current one without changing
 * either strategy's ancestry. The imported synthetic root is omitted and its
 * direct children are attached to the current root. Scientific labels are left
 * untouched; only colliding internal IDs are remapped.
 */
export function mergeGatingStrategies(
  current: GatingStrategyGraph,
  imported: GatingStrategyGraph,
): GatingMergeResult {
  if (!current.populations[current.root_population_id]) {
    throw new Error("The current population hierarchy has no valid root.");
  }
  if (!imported.populations[imported.root_population_id]) {
    throw new Error("The imported population hierarchy has no valid root.");
  }

  const gates: Record<string, Gate> = { ...current.gates };
  const gateIdMap: Record<string, string> = {};
  const usedGateIds = new Set(Object.keys(gates));
  for (const sourceId of Object.keys(imported.gates)) {
    const targetId = importedId(sourceId, usedGateIds);
    gateIdMap[sourceId] = targetId;
    gates[targetId] = cloneGate(imported.gates[sourceId], targetId);
  }

  const currentOrder = orderedIds(current.gate_order, current.gates);
  const importedOrder = orderedIds(imported.gate_order, imported.gates).map((id) => gateIdMap[id]);
  const gate_order = [...currentOrder, ...importedOrder];

  const populations: PopulationMap = Object.fromEntries(
    Object.entries(current.populations).map(([id, population]) => [id, clonePopulation(population)]),
  );
  const populationIdMap: Record<string, string> = {};
  const usedPopulationIds = new Set(Object.keys(populations));
  for (const sourceId of Object.keys(imported.populations)) {
    if (sourceId === imported.root_population_id) continue;
    populationIdMap[sourceId] = importedId(sourceId, usedPopulationIds);
  }

  for (const [sourceId, sourcePopulation] of Object.entries(imported.populations)) {
    if (sourceId === imported.root_population_id) continue;
    const targetId = populationIdMap[sourceId];
    const parentId = sourcePopulation.parent_id === imported.root_population_id
      ? current.root_population_id
      : sourcePopulation.parent_id
        ? populationIdMap[sourcePopulation.parent_id]
        : undefined;
    if (!parentId || !populations[parentId]) {
      throw new Error(`Imported population "${sourcePopulation.name}" has a missing parent.`);
    }
    const gate_refs = sourcePopulation.gate_refs.map((ref) => {
      const gateId = gateIdMap[ref.gate_id];
      if (!gateId) {
        throw new Error(`Imported population "${sourcePopulation.name}" has a dangling gate reference.`);
      }
      return { ...ref, gate_id: gateId };
    });
    populations[targetId] = {
      ...sourcePopulation,
      population_id: targetId,
      parent_id: parentId,
      children: [],
      gate_refs,
      event_count: null,
      percent_of_parent: null,
      colorSlot: undefined,
    };
  }

  for (const targetId of Object.values(populationIdMap)) {
    const parentId = populations[targetId].parent_id;
    if (!parentId || !populations[parentId]) {
      throw new Error(`Imported population "${populations[targetId].name}" has a missing parent.`);
    }
    populations[parentId].children = [...new Set([...populations[parentId].children, targetId])];
  }
  sortPopulationTree(populations, current.root_population_id);

  return {
    gates,
    gate_order,
    populations,
    root_population_id: current.root_population_id,
    gateIdMap,
    populationIdMap,
  };
}

export function hasGatingStrategy(graph: Pick<GatingStrategyGraph, "gates" | "populations" | "root_population_id">): boolean {
  return Object.keys(graph.gates).length > 0 ||
    Object.keys(graph.populations).some((id) => id !== graph.root_population_id);
}

/** Explain why combining two gate graphs would change the meaning of existing gates. */
export function gatingMergeSpaceConflict({
  hasExistingStrategy,
  isFlow,
  currentCompensation,
  importedCompensationTarget,
  currentCytofCofactor,
  importedCytofCofactor,
}: {
  hasExistingStrategy: boolean;
  isFlow: boolean;
  currentCompensation: boolean;
  importedCompensationTarget: boolean | null;
  currentCytofCofactor: number;
  importedCytofCofactor: number | null;
}): string | null {
  if (!hasExistingStrategy) return null;
  if (importedCompensationTarget !== null && importedCompensationTarget !== currentCompensation) {
    return "Merge is unavailable because this import would change compensation and reinterpret the existing gates. Replace the current strategy instead.";
  }
  if (!isFlow && importedCytofCofactor !== null && Number.isFinite(importedCytofCofactor) &&
      Math.abs(importedCytofCofactor - currentCytofCofactor) > 1e-12) {
    return "Merge is unavailable because this import uses a different CyTOF cofactor and would reinterpret the existing gates. Replace the current strategy instead.";
  }
  return null;
}
