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
  /**
   * The file's own channel keys, each to the detector ($PnN) it reads. Where every file of an
   * import gives them, gates are matched across files by detector, not by the file's label for
   * it: a file whose $PnS labels a detector "Aqua" where the tree's file has "aqua" -- or another
   * stain altogether, on the same detector -- lost its own gates on it, and followed the tree's,
   * which name a channel the file does not have and so held no event.
   */
  detectors?: Readonly<Record<string, string>>;
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

/** The gate fields keyed by channel name, each describing the axis on that channel. */
const CHANNEL_KEYED_FIELDS = ["transforms", "flowjo_axes", "flowjo_bounds"] as const;

/**
 * `gate` on the channels `x` and `y`: its axes become those channels, and every field keyed by
 * channel (`transforms`, `flowjo_axes`, `flowjo_bounds`) is keyed by them too, the x axis's entry
 * under `x` and the y axis's under `y`. A FlowJo grid polygon holds its grid in `transforms`, keyed
 * by channel; moved onto a channel of another name with the old keys, its axes named no transform,
 * each fell back to the display transform while its vertices stayed on grid channels, and the gate
 * held 491 events where the same gate on the same events holds 3,750. `flowjo_vertices` is one
 * pair per vertex, x then y, and needs no change.
 */
export function onChannels<T extends Gate>(gate: T, x: string, y: string): T {
  if (gate.x_channel === x && gate.y_channel === y) return gate;
  const rename = new Map<string, string>([[gate.x_channel, x], [gate.y_channel, y]]);
  const out = { ...gate, x_channel: x, y_channel: y } as Record<string, unknown>;
  for (const field of CHANNEL_KEYED_FIELDS) {
    const byChannel = out[field];
    if (!byChannel || typeof byChannel !== "object") continue;
    out[field] = Object.fromEntries(Object.entries(byChannel).map(([channel, value]) => [rename.get(channel) ?? channel, value]));
  }
  return out as T;
}

/** A population or gate name as two files' strategies may spell it: without case or extra space. */
export function foldName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * What a gate is across the files of one import: its name without case, its kind, and the
 * detectors its axes read when `detectors` maps the file's channel keys to them. Two samples of
 * one FlowJo workspace name a population "Live cells" and "live cells", or label one detector
 * "Aqua" and "aqua"; FlowJo gates by the detector ($PnN), and so does this.
 *
 * By detector, a rectangle, a polygon and an ellipse of one name on the same detectors are one
 * gate drawn two ways -- each sample of a workspace draws its own -- so the file keeps its own:
 * FR-FCM-Z2C8's staining3 draws "Live cells" as a polygon where the tree's sample has a
 * rectangle, and following the tree's rectangle it counted 848 where its own counts FlowJo's
 * 76,134. A quadrant gate is not interchangeable with them: its populations name its quadrants.
 */
export function gateMatchKey(g: Gate, detectors?: Readonly<Record<string, string>>): string {
  const axis = (key: string) => (detectors ? `det:${detectors[key] ?? key}` : key);
  const kind = detectors && g.gate_type !== "quadrant" ? "region" : g.gate_type;
  return JSON.stringify([foldName(g.name), kind, axis(g.x_channel), axis(g.y_channel)]);
}

/** A channel label as a stain, whatever its case, spacing or punctuation: "IL-21 PE" is "il21pe". */
function stainOf(label: string): string {
  return label.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The file's own channel for a tree's channel: the file's channel on the same detector, unless
 * the two label it as different stains -- then the tree's channel as it is. A channel with no
 * label of its own is keyed by its detector's name and names no stain, so it agrees with any; a
 * label spelled otherwise ("aqua" and "Aqua", "IL-21 PE" and "IL21 PE") is the same stain. A file
 * that has a channel of the tree's very label on that detector keeps it.
 */
function sameStainChannel(key: string, treeDetectors: Readonly<Record<string, string>>, fileDetectors: Readonly<Record<string, string>>): string {
  const detector = treeDetectors[key];
  if (detector === undefined || fileDetectors[key] === detector) return key;
  const unlabelled = (k: string) => stainOf(k) === stainOf(detector);
  const own = Object.entries(fileDetectors).find(([k, d]) => d === detector && (unlabelled(k) || unlabelled(key) || stainOf(k) === stainOf(key)));
  return own ? own[0] : key;
}

/** Whether the files of an import all say which detector each channel is, so gates match by it. */
export function matchByDetector(files: readonly Pick<TailoredFile, "detectors">[]): boolean {
  return files.length > 0 && files.every((f) => !!f.detectors);
}

/**
 * The structure of a strategy as the files of one import are grouped by it: strategyStructureKey,
 * with names folded and, where `detectors` is given, gates identified by the detectors they read.
 */
export function strategyMatchKey(tree: StrategyTree, detectors?: Readonly<Record<string, string>>): string {
  return structureKeyWith(tree, (g) => gateMatchKey(g, detectors), foldName);
}

/**
 * The structure of a strategy: every population by its path from the root, with its logic and
 * the identities of the gates it references. Two files gated the same way with tailored
 * coordinates share a structure; a file with a population more, or a gate on other axes, does not.
 */
export function strategyStructureKey(tree: StrategyTree): string {
  return structureKeyWith(tree, gateIdentity, (name) => name);
}

function structureKeyWith(tree: StrategyTree, identify: (g: Gate) => string, spell: (name: string) => string): string {
  const entries: string[] = [];
  const visit = (id: string, path: string): void => {
    const pop = tree.populations[id];
    if (!pop) return;
    const refs = pop.gate_refs
      .map((r) => {
        const g = tree.gates[r.gate_id];
        return JSON.stringify([g ? identify(g) : `missing:${r.gate_id}`, r.include, r.quadrant ?? null]);
      })
      .sort();
    entries.push(JSON.stringify([path, pop.gate_logic, refs]));
    for (const child of pop.children) {
      const c = tree.populations[child];
      if (c) visit(child, `${path}/${spell(c.name)}`);
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
  const byDetector = matchByDetector(files);
  for (const f of files) {
    const key = strategyMatchKey(f.tree, byDetector ? f.detectors : undefined);
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
  template: { id: string; name: string; tree: StrategyTree; detectors?: Readonly<Record<string, string>> },
  file: TailoredFile,
  taken: readonly HierarchyRef[],
): StoredHierarchy {
  const clone = cloneHierarchyTree(template.tree.populations, template.tree.root_population_id, template.tree.gates, template.tree.gate_order);
  // By detector where both say which detector each channel is: the file's gate then keeps the
  // file's own channel for it, which is the channel its events are in.
  const byDetector = !!(template.detectors && file.detectors);
  const own = new Map<string, Gate[]>();
  for (const id of file.tree.gate_order) {
    const g = file.tree.gates[id];
    if (!g) continue;
    const key = gateMatchKey(g, byDetector ? file.detectors : undefined);
    own.set(key, [...(own.get(key) ?? []), g]);
  }
  for (const id of template.tree.gate_order) {
    const templateGate = template.tree.gates[id];
    const copyId = clone.gateIdMap[id];
    if (!templateGate || !copyId) continue;
    const candidates = own.get(gateMatchKey(templateGate, byDetector ? template.detectors : undefined));
    const fileGate = candidates?.shift();
    if (!fileGate) {
      // A gate of the tree the file did not record follows the tree -- on the file's own channel
      // for the same detector, where the two do not label it as different stains ("aqua" and
      // "Aqua" are one stain; an unlabelled channel names none). On the tree's label it named a
      // channel the file does not have, and held no event, nor did anything beneath it. A detector
      // the two label as different stains is left as it is: the tree's gate is not the file's there.
      if (byDetector) {
        const x = sameStainChannel(templateGate.x_channel, template.detectors!, file.detectors!);
        const y = sameStainChannel(templateGate.y_channel, template.detectors!, file.detectors!);
        // What the gate keys by channel goes with it (onChannels).
        if (x !== templateGate.x_channel || y !== templateGate.y_channel) {
          clone.gates[copyId] = onChannels(clone.gates[copyId], x, y);
        }
      }
      continue;
    }
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
