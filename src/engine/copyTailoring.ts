import type { Gate, PopulationMap } from "./models";
import { correspondingHierarchyId, selectionAcrossHierarchies, type StoredHierarchy } from "./hierarchies";
import { copyInStep } from "./templateSync";

/** Copy a tree into a file-owned leaf, retaining corresponding ids and linking directly to the group. */
export function copyTailoring(
  source: StoredHierarchy,
  target: StoredHierarchy,
  template: StoredHierarchy,
  trees: Readonly<Record<string, StoredHierarchy>>,
): StoredHierarchy {
  if (!target.owner_sample_id || !source.root_population_id || !template.root_population_id) {
    throw new Error("Copying requires a file-owned destination and a valid source and group tree.");
  }
  if (!copyInStep(source, { ...template, root_population_id: template.root_population_id })) {
    throw new Error("This tree's structure differs from its group. Unlink it before using it as a new group.");
  }
  const popMap: Record<string, string> = {};
  const gateMap: Record<string, string> = {};
  const source_population_ids: Record<string, string> = {};
  const source_gate_ids: Record<string, string> = {};
  for (const id of Object.keys(source.populations)) {
    const templateId = correspondingHierarchyId(source, id, template, trees, "population");
    if (!templateId) throw new Error("This tree has populations without a group counterpart. Unlink it before using it as a new group.");
    const ownId = correspondingHierarchyId(source, id, target, trees, "population")
      ?? (id === source.root_population_id ? target.root_population_id : null) ?? crypto.randomUUID();
    popMap[id] = ownId;
    source_population_ids[ownId] = templateId;
  }
  for (const id of Object.keys(source.gates)) {
    const templateId = correspondingHierarchyId(source, id, template, trees, "gate");
    if (!templateId) throw new Error("This tree has gates without a group counterpart. Unlink it before using it as a new group.");
    const ownId = correspondingHierarchyId(source, id, target, trees, "gate") ?? crypto.randomUUID();
    gateMap[id] = ownId;
    source_gate_ids[ownId] = templateId;
  }
  const gates: Record<string, Gate> = {};
  for (const [id, ownId] of Object.entries(gateMap)) {
    gates[ownId] = { ...structuredClone(source.gates[id]), gate_id: ownId };
  }
  const populations: PopulationMap = {};
  for (const [id, ownId] of Object.entries(popMap)) {
    const pop = source.populations[id];
    populations[ownId] = {
      ...structuredClone(pop), population_id: ownId,
      parent_id: pop.parent_id ? popMap[pop.parent_id] : null,
      children: pop.children.map((child) => popMap[child]),
      gate_refs: pop.gate_refs.map((ref) => ({ ...ref, gate_id: gateMap[ref.gate_id] })),
      event_count: null, percent_of_parent: null,
    };
  }
  const copied: StoredHierarchy = {
    ...target, structure_locked: true, source_hierarchy_id: template.id,
    source_gate_ids, source_population_ids, gates, populations,
    gate_order: source.gate_order.map((id) => gateMap[id]),
    root_population_id: popMap[source.root_population_id],
  };
  return { ...copied, ...selectionAcrossHierarchies(target, copied, { ...trees, [copied.id]: copied }) };
}
