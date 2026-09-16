/**
 * Group-gate propagation: a template's edits reach its structure-locked copies.
 *
 * FlowJo's rule, applied to the per-file model's first level: a sample's gate follows the group
 * gate until the sample tailors it, and the group's structure (gates added, removed, renamed,
 * populations moved) is every sample's structure. Here a file-owned, structure-locked copy is
 * kept in step with its template after each edit: structure follows the template completely,
 * ids of things the copy already had are kept (so assignments, metadata and selections hold),
 * and each gate's geometry follows unless the copy had tailored it, which is judged against the
 * template's gate BEFORE the edit. A copy that was already out of step before the edit (it was
 * unlocked, changed, and locked again) is left alone: provenance there is a record, not a link.
 */

import type { Gate, PopulationMap } from "./models";
import type { StoredHierarchy } from "./hierarchies";
import { gateIdentity, strategyStructureKey } from "./tailoredImport";

export interface TemplateTree {
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string;
}

/** Everything about a gate except what names it and how it is painted. */
function geometryOf(g: Gate): unknown {
  const { gate_id: _id, name: _name, color: _color, label_offset: _label, quadrant_label_offsets: _qlabels, ...rest } =
    g as Gate & { label_offset?: unknown; quadrant_label_offsets?: unknown };
  void _id; void _name; void _color; void _label; void _qlabels;
  return rest;
}

export function gateGeometryEquals(a: Gate, b: Gate): boolean {
  return JSON.stringify(geometryOf(a)) === JSON.stringify(geometryOf(b));
}

/** `target` carrying `source`'s geometry: its own id, name and paint, everything else from `source`. */
export function withGeometryOf(target: Gate, source: Gate): Gate {
  const { gate_id, name, color, label_offset, quadrant_label_offsets } = target as Gate & { label_offset?: unknown; quadrant_label_offsets?: unknown };
  const { quadrant_label_offsets: _sourceLabels, ...geometry } = structuredClone(source) as Gate & { quadrant_label_offsets?: unknown };
  void _sourceLabels;
  return { ...geometry, gate_id, name, color, label_offset, ...(quadrant_label_offsets !== undefined ? { quadrant_label_offsets } : {}) } as Gate;
}

function invert(map: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(map ?? {}).map(([a, b]) => [b, a]));
}

/** Whether a copy's structure is its template's, so a change to the template can be carried over. */
export function copyInStep(copy: StoredHierarchy, template: TemplateTree): boolean {
  if (!copy.root_population_id) return false;
  return strategyStructureKey({ gates: copy.gates, gate_order: copy.gate_order, populations: copy.populations, root_population_id: copy.root_population_id })
    === strategyStructureKey(template);
}

/**
 * The copy after the template went from `before` to `after`. Null when the copy was not in step
 * with `before`, or when nothing about it would change.
 */
export function syncLockedCopy(copy: StoredHierarchy, before: TemplateTree, after: TemplateTree): StoredHierarchy | null {
  if (!copyInStep(copy, before)) return null;
  const sourceToCopyGate = invert(copy.source_gate_ids);
  const sourceToCopyPop = invert(copy.source_population_ids);

  // Gates: keep the copy's id where the template gate was already mapped; geometry follows the
  // template unless the copy had tailored it and the gate is still the same gate.
  const gates: Record<string, Gate> = {};
  const gateMap: Record<string, string> = {};
  let changed = false;
  for (const id of after.gate_order) {
    const t = after.gates[id];
    if (!t) continue;
    const copyId = sourceToCopyGate[id] ?? crypto.randomUUID();
    gateMap[id] = copyId;
    const was = before.gates[id];
    const own = copy.gates[copyId];
    const tailored = !!(own && was && !gateGeometryEquals(own, was) && gateIdentity(was) === gateIdentity(t));
    const next: Gate = tailored
      ? { ...own, name: t.name, color: t.color }
      : { ...structuredClone(t), gate_id: copyId, label_offset: own?.label_offset ?? t.label_offset } as Gate;
    gates[copyId] = next;
    if (!own || JSON.stringify(own) !== JSON.stringify(next)) changed = true;
  }
  const gate_order = after.gate_order.filter((id) => gateMap[id]).map((id) => gateMap[id]);
  if (gate_order.length !== copy.gate_order.length || gate_order.some((id, i) => id !== copy.gate_order[i])) changed = true;

  // Populations: the template's tree with the copy's ids where they exist.
  const popMap: Record<string, string> = {};
  const visitIds = (id: string): void => {
    if (popMap[id] || !after.populations[id]) return;
    popMap[id] = sourceToCopyPop[id] ?? crypto.randomUUID();
    for (const c of after.populations[id].children) visitIds(c);
  };
  visitIds(after.root_population_id);
  const populations: PopulationMap = {};
  for (const [id, copyId] of Object.entries(popMap)) {
    const t = after.populations[id];
    const own = copy.populations[copyId];
    const next = {
      ...structuredClone(t),
      population_id: copyId,
      parent_id: t.parent_id ? popMap[t.parent_id] ?? null : null,
      children: t.children.filter((c) => popMap[c]).map((c) => popMap[c]),
      gate_refs: t.gate_refs.map((r) => ({ ...r, gate_id: gateMap[r.gate_id] ?? r.gate_id })),
      // Counts are recomputed on the copy's own file; the colour slot is the copy's.
      event_count: own?.event_count ?? null,
      percent_of_parent: own?.percent_of_parent ?? null,
      ...(own?.colorSlot !== undefined ? { colorSlot: own.colorSlot } : {}),
    };
    populations[copyId] = next;
    if (!own || JSON.stringify(own) !== JSON.stringify(next)) changed = true;
  }
  if (Object.keys(populations).length !== Object.keys(copy.populations).length) changed = true;
  if (!changed) return null;

  const root = popMap[after.root_population_id];
  return {
    ...copy,
    gates,
    gate_order,
    populations,
    root_population_id: root,
    active_population_id: copy.active_population_id && populations[copy.active_population_id] ? copy.active_population_id : root,
    selected_pop_ids: copy.selected_pop_ids.filter((id) => populations[id]),
    source_gate_ids: invert(gateMap),
    source_population_ids: invert(popMap),
  };
}

/**
 * The copy's gates whose geometry differs from the template's, by the copy's own gate ids: the
 * marks FlowJo puts on a sample's tailored gates. A copy gate with no source, or whose source
 * is gone, counts as tailored too, since the template no longer says where it should be.
 */
export function tailoredGateIds(copy: StoredHierarchy, template: TemplateTree | null): Set<string> {
  const out = new Set<string>();
  if (!template) return out;
  for (const [copyId, gate] of Object.entries(copy.gates)) {
    const sourceId = copy.source_gate_ids?.[copyId];
    const source = sourceId ? template.gates[sourceId] : undefined;
    if (!source || !gateGeometryEquals(gate, source)) out.add(copyId);
  }
  return out;
}
