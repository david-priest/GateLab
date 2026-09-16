/**
 * A per-file import the way FlowJo means it: one structure, tailored per file.
 *
 * A FlowJo workspace gates every sample of a group with the same tree and lets a sample's gate
 * coordinates be tailored. An S8 experiment's recordings carry the same tree at different
 * moments. Read one file at a time, each of those looks like its own strategy; read together,
 * they are one structure with per-file geometry. This module tells the two apart: files whose
 * strategies have the same STRUCTURE (populations by path, each with its logic and the identity
 * of the gates it references, geometry left out) form a group; the group's lead strategy becomes
 * a template hierarchy, and every file of the group gets a file-owned, structure-locked copy of
 * it carrying that file's own gate coordinates, with provenance back to the template's gates.
 * A file whose structure differs starts a group of its own. That is the per-file hierarchy
 * model's first level (tailoring); the copy's explicit unlock is the second.
 */

import type { Gate, PopulationMap } from "./models";
import { cloneHierarchyTree, newHierarchyId, uniqueHierarchyName, type HierarchyRef, type StoredHierarchy } from "./hierarchies";

export interface StrategyTree {
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string;
}

export interface TailoredFile {
  fileId: string;
  fileName: string;
  /** The file's strategy, parsed against its own channels. */
  tree: StrategyTree;
  /** Where the strategy came from, for naming the template: a FlowJo group, a Chorus sort. */
  origin?: string | null;
}

export interface TailoredGroup {
  key: string;
  /** The file whose strategy is the template's. */
  lead: TailoredFile;
  files: TailoredFile[];
}

/** What a gate is, apart from where it is: its name, kind and axes. */
export function gateIdentity(g: Gate): string {
  return JSON.stringify([g.name, g.gate_type, g.x_channel, g.y_channel]);
}

/**
 * The structure of a strategy: every population by its path from the root, with its logic and
 * the identities of the gates it references. Two files gated the same way with tailored
 * coordinates share a structure; a file with a population more, or a gate on other axes, does not.
 */
export function strategyStructureKey(tree: StrategyTree): string {
  const entries: string[] = [];
  const visit = (id: string, path: string): void => {
    const pop = tree.populations[id];
    if (!pop) return;
    const refs = pop.gate_refs
      .map((r) => {
        const g = tree.gates[r.gate_id];
        return JSON.stringify([g ? gateIdentity(g) : `missing:${r.gate_id}`, r.include, r.quadrant ?? null]);
      })
      .sort();
    entries.push(JSON.stringify([path, pop.gate_logic, refs]));
    for (const child of pop.children) {
      const c = tree.populations[child];
      if (c) visit(child, `${path}/${c.name}`);
    }
  };
  visit(tree.root_population_id, "");
  entries.sort();
  return JSON.stringify(entries);
}

/**
 * Files by structure, in the order first seen. The lead of each group is its first file, unless
 * `leadFileId` names a file in it, so the file the user chose supplies the template's coordinates.
 */
export function groupByStructure(files: readonly TailoredFile[], leadFileId: string | null = null): TailoredGroup[] {
  const groups = new Map<string, TailoredGroup>();
  for (const f of files) {
    const key = strategyStructureKey(f.tree);
    const g = groups.get(key);
    if (g) g.files.push(f);
    else groups.set(key, { key, lead: f, files: [f] });
  }
  for (const g of groups.values()) {
    const chosen = leadFileId ? g.files.find((f) => f.fileId === leadFileId) : undefined;
    if (chosen) g.lead = chosen;
  }
  return [...groups.values()];
}

function invert(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));
}

/**
 * A file-owned, structure-locked copy of `template` carrying `file`'s own gate coordinates.
 * The copy's populations and gates are the template's with fresh ids and provenance back to
 * it; each gate's geometry is the file's gate of the same identity, matched in order where a
 * name recurs. The two strategies must share a structure (groupByStructure guarantees it).
 */
export function tailoredCopy(
  template: { id: string; name: string; tree: StrategyTree },
  file: TailoredFile,
  taken: readonly HierarchyRef[],
): StoredHierarchy {
  const clone = cloneHierarchyTree(template.tree.populations, template.tree.root_population_id, template.tree.gates, template.tree.gate_order);
  const own = new Map<string, Gate[]>();
  for (const id of file.tree.gate_order) {
    const g = file.tree.gates[id];
    if (!g) continue;
    const key = gateIdentity(g);
    own.set(key, [...(own.get(key) ?? []), g]);
  }
  for (const id of template.tree.gate_order) {
    const templateGate = template.tree.gates[id];
    const copyId = clone.gateIdMap[id];
    if (!templateGate || !copyId) continue;
    const candidates = own.get(gateIdentity(templateGate));
    const fileGate = candidates?.shift();
    if (!fileGate) continue;
    // The file's coordinates, space and transforms; the template's identity and colour.
    clone.gates[copyId] = { ...structuredClone(fileGate), gate_id: copyId, name: templateGate.name, color: templateGate.color };
  }
  const id = newHierarchyId();
  const name = uniqueHierarchyName(`${file.fileName} · ${template.name}`, taken);
  return {
    id,
    name,
    owner_sample_id: file.fileId,
    structure_locked: true,
    source_hierarchy_id: template.id,
    source_gate_ids: invert(clone.gateIdMap),
    source_population_ids: invert(clone.idMap),
    gates: clone.gates,
    gate_order: clone.gate_order,
    populations: clone.populations,
    root_population_id: clone.root_population_id,
    active_population_id: clone.root_population_id,
    selected_pop_ids: [],
  };
}

export interface PerFilePlan {
  /** The template that takes the active hierarchy, or null when every template is new. */
  activeTemplate: { name: string; tree: StrategyTree } | null;
  /** Templates to add as new hierarchies, complete. */
  newTemplates: StoredHierarchy[];
  /** One tailored copy per file. */
  copies: StoredHierarchy[];
  /** File id → the copy it is gated under. */
  assignments: Record<string, string>;
  /** One line per template: its name and files. */
  summary: string[];
}

/**
 * Lay a per-file import out: a template per structure, a tailored copy per file. The group
 * holding `primaryFileId` takes the active hierarchy when `replaceActive` (the import replaces
 * what is there); every other template is a new hierarchy. Names are unique among `existing`.
 */
export function planPerFileImport(
  files: readonly TailoredFile[],
  opts: {
    existing: readonly HierarchyRef[];
    activeHierarchyId: string;
    primaryFileId: string | null;
    replaceActive: boolean;
    /** The template's name for a group; made unique here. */
    nameFor: (group: TailoredGroup, index: number) => string;
  },
): PerFilePlan {
  const groups = groupByStructure(files, opts.primaryFileId);
  const taken: HierarchyRef[] = opts.existing.map((h) => ({ id: h.id, name: h.name }));
  const plan: PerFilePlan = { activeTemplate: null, newTemplates: [], copies: [], assignments: {}, summary: [] };
  const templates: Array<{ id: string; name: string; tree: StrategyTree; group: TailoredGroup }> = [];
  groups.forEach((group, i) => {
    const name = uniqueHierarchyName(opts.nameFor(group, i), taken);
    const isPrimary = opts.primaryFileId !== null && group.files.some((f) => f.fileId === opts.primaryFileId);
    if (isPrimary && opts.replaceActive && !plan.activeTemplate) {
      plan.activeTemplate = { name, tree: group.lead.tree };
      templates.push({ id: opts.activeHierarchyId, name, tree: group.lead.tree, group });
      // The active hierarchy's old name is gone with its tree; the new one must stay unique.
      const idx = taken.findIndex((h) => h.id === opts.activeHierarchyId);
      if (idx >= 0) taken[idx] = { id: opts.activeHierarchyId, name };
      else taken.push({ id: opts.activeHierarchyId, name });
    } else {
      const id = newHierarchyId();
      const t = group.lead.tree;
      plan.newTemplates.push({
        id, name,
        gates: t.gates, gate_order: t.gate_order, populations: t.populations,
        root_population_id: t.root_population_id, active_population_id: t.root_population_id, selected_pop_ids: [],
      });
      templates.push({ id, name, tree: t, group });
      taken.push({ id, name });
    }
  });
  for (const t of templates) {
    for (const f of t.group.files) {
      const copy = tailoredCopy(t, f, taken);
      taken.push({ id: copy.id, name: copy.name });
      plan.copies.push(copy);
      plan.assignments[f.fileId] = copy.id;
    }
    plan.summary.push(`${t.name} (${t.group.files.map((f) => f.fileName).join(", ")})`);
  }
  return plan;
}

/** A template's name from where its files came: their common origin, else the lead file. */
export function templateNameFromOrigin(group: TailoredGroup, fallback: string): string {
  const origins = new Set(group.files.map((f) => (f.origin ?? "").trim()).filter(Boolean));
  if (origins.size === 1) return [...origins][0];
  return fallback;
}
