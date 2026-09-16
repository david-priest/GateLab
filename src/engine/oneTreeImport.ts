/**
 * A per-file import under the one-tree rule: one tree for the workspace, tailored per file.
 *
 * A FlowJo workspace with a tree per sample, a FACSChorus experiment's recordings, the S8's
 * per-file recordings: each file arrives with a strategy of its own. The workspace holds one
 * tree, so one file's strategy becomes the tree, and every other file gets the tree with its
 * own coordinates on the gates the two have in common, matched by name, kind and axes. Gates a
 * file recorded that the tree does not have are dropped and reported; gates of the tree the
 * file did not record follow the tree. A file whose coordinates end up identical to the tree's
 * keeps no copy: it follows the tree directly, so a copy exists only where something is
 * tailored.
 */

import type { HierarchyRef, StoredHierarchy } from "./hierarchies";
import { gateIdentity, groupByStructure, strategyStructureKey, tailoredCopy, type StrategyTree, type TailoredFile, type TailoredGroup } from "./tailoredImport";
import { gateGeometryEquals } from "./templateSync";

export interface DifferingFile {
  fileId: string;
  fileName: string;
  /** Gates the file recorded that the tree has no counterpart for: not imported. */
  dropped: string[];
  /** Gates of the tree the file did not record: they follow the tree. */
  followed: string[];
}

export interface OneTreePlan {
  /** The tree: the lead file's strategy, complete, under the template's id. */
  template: { id: string; name: string; tree: StrategyTree };
  lead: TailoredFile;
  /** A copy per file whose coordinates differ from the tree's on some shared gate. */
  copies: StoredHierarchy[];
  /** Every imported file: its copy's id where it has one, else the template's id. */
  assignments: Record<string, string>;
  /** Files whose structure differs from the tree's, and how. */
  differing: DifferingFile[];
  /** How many files follow the tree with no tailoring. */
  following: number;
}

/** The group holding `leadFileId`, else the largest group, first seen breaking ties. */
export function leadGroup(groups: readonly TailoredGroup[], leadFileId: string | null): TailoredGroup {
  const chosen = leadFileId ? groups.find((g) => g.files.some((f) => f.fileId === leadFileId)) : undefined;
  if (chosen) return chosen;
  return groups.reduce((best, g) => (g.files.length > best.files.length ? g : best), groups[0]);
}

function identities(tree: StrategyTree): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of tree.gate_order) {
    const g = tree.gates[id];
    if (g) out.set(gateIdentity(g), g.name);
  }
  return out;
}

export interface TailoringPlan {
  /** A copy per file whose coordinates differ from the tree's on some shared gate. */
  copies: StoredHierarchy[];
  /** Every file given: its copy's id where it has one, else the template's id. */
  assignments: Record<string, string>;
  /** Files whose structure differs from the tree's, and how. */
  differing: DifferingFile[];
  /** How many files follow the tree with no tailoring. */
  following: number;
}

/**
 * Give every file the tree, with the file's own coordinates on the gates the two share. A file
 * whose coordinates match the tree's keeps no copy. `sameStructure` names the files whose
 * strategy is the tree's structure exactly; the others are reported with what was dropped.
 */
export function tailorFilesToTree(
  template: { id: string; name: string; tree: StrategyTree },
  files: readonly TailoredFile[],
  existing: readonly HierarchyRef[],
  sameStructure: ReadonlySet<string>,
): TailoringPlan {
  const taken: HierarchyRef[] = existing.map((h) => ({ id: h.id, name: h.name }));
  const plan: TailoringPlan = { copies: [], assignments: {}, differing: [], following: 0 };
  const treeIdentities = identities(template.tree);
  for (const file of files) {
    const copy = tailoredCopy(template, file, taken);
    const tailored = Object.entries(copy.source_gate_ids ?? {}).some(([own, source]) => {
      const a = copy.gates[own];
      const b = template.tree.gates[source];
      return a && b && !gateGeometryEquals(a, b);
    });
    if (tailored) {
      taken.push({ id: copy.id, name: copy.name });
      plan.copies.push(copy);
      plan.assignments[file.fileId] = copy.id;
    } else {
      plan.assignments[file.fileId] = template.id;
      plan.following += 1;
    }
    if (sameStructure.has(file.fileId)) continue;
    const own = identities(file.tree);
    const dropped = [...own].filter(([key]) => !treeIdentities.has(key)).map(([, name]) => name);
    const followed = [...treeIdentities].filter(([key]) => !own.has(key)).map(([, name]) => name);
    plan.differing.push({ fileId: file.fileId, fileName: file.fileName, dropped, followed });
  }
  return plan;
}

export function planOneTreeImport(
  files: readonly TailoredFile[],
  opts: { templateId: string; name: string; leadFileId: string | null; existing: readonly HierarchyRef[] },
): OneTreePlan {
  if (!files.length) throw new Error("planOneTreeImport needs at least one file");
  const groups = groupByStructure(files, opts.leadFileId);
  const lead = leadGroup(groups, opts.leadFileId);
  const template = { id: opts.templateId, name: opts.name, tree: lead.lead.tree };
  const tailoring = tailorFilesToTree(template, files, opts.existing, new Set(lead.files.map((f) => f.fileId)));
  return { template, lead: lead.lead, ...tailoring };
}

/** One line per differing file, for the import's report. */
export function describeDiffering(differing: readonly DifferingFile[]): string {
  return differing
    .map((d) => {
      const parts: string[] = [];
      if (d.dropped.length) parts.push(`not in the tree, dropped: ${d.dropped.join(", ")}`);
      if (d.followed.length) parts.push(`not recorded, following the tree: ${d.followed.join(", ")}`);
      return `${d.fileName} (${parts.join("; ") || "same gates, arranged differently"})`;
    })
    .join("; ");
}

/** Whether two strategies share a structure: populations by path, each with its logic and gate identities. */
export function sameStructure(a: StrategyTree, b: StrategyTree): boolean {
  return strategyStructureKey(a) === strategyStructureKey(b);
}
