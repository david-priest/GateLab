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
import { foldName, gateMatchKey, groupByStructure, strategyStructureKey, tailoredCopy, type StrategyTree, type TailoredFile, type TailoredGroup } from "./tailoredImport";
import { gateGeometryEquals } from "./templateSync";

export interface DifferingFile {
  fileId: string;
  fileName: string;
  /** Gates the file recorded that the tree has no counterpart for: not imported. */
  dropped: string[];
  /** Gates of the tree the file did not record: they follow the tree. */
  followed: string[];
  /**
   * Gates the file and the tree both have by name, drawn on other axes or as another kind: the
   * file's are not imported, and it follows the tree's. They were listed as both "dropped" and
   * "following the tree", which read as the same gate being two things at once.
   */
  redrawn?: string[];
  /**
   * Intersections and complements the file and the tree both have by name, built on other gates
   * or in another way: the file's are not imported, and it follows the tree's.
   */
  rebuilt?: string[];
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

function identities(tree: StrategyTree, detectors?: Readonly<Record<string, string>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of tree.gate_order) {
    const g = tree.gates[id];
    if (g) out.set(gateMatchKey(g, detectors), g.name);
  }
  return out;
}

/**
 * The populations of a strategy that carry no gate of their own -- intersections, complements,
 * quadrants -- by what they are: name, logic and the identities of the gates they combine. A file's
 * that the tree lacks is not imported, and it was named by no gate: an intersection on a NOT went
 * from its file, and the result named only gates.
 */
function derivedPopulations(tree: StrategyTree, detectors?: Readonly<Record<string, string>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const pop of Object.values(tree.populations)) {
    if (pop.population_id === tree.root_population_id) continue;
    // A population named by its gate is its gate, and the gates are compared already.
    if (pop.gate_refs.some((r) => { const g = tree.gates[r.gate_id]; return !!g && foldName(g.name) === foldName(pop.name); })) continue;
    const refs = pop.gate_refs.map((r) => {
      const g = tree.gates[r.gate_id];
      return JSON.stringify([g ? gateMatchKey(g, detectors) : `missing:${r.gate_id}`, r.include, r.quadrant ?? null]);
    }).sort();
    out.set(JSON.stringify([foldName(pop.name), pop.gate_logic, refs]), pop.name);
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
  template: { id: string; name: string; tree: StrategyTree; detectors?: Readonly<Record<string, string>> },
  files: readonly TailoredFile[],
  existing: readonly HierarchyRef[],
  sameStructure: ReadonlySet<string>,
): TailoringPlan {
  const taken: HierarchyRef[] = existing.map((h) => ({ id: h.id, name: h.name }));
  const plan: TailoringPlan = { copies: [], assignments: {}, differing: [], following: 0 };
  for (const file of files) {
    const byDetector = !!(template.detectors && file.detectors);
    const treeIdentities = identities(template.tree, byDetector ? template.detectors : undefined);
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
    const own = identities(file.tree, byDetector ? file.detectors : undefined);
    const droppedAll = [...own].filter(([key]) => !treeIdentities.has(key)).map(([, name]) => name);
    const followedAll = [...treeIdentities].filter(([key]) => !own.has(key)).map(([, name]) => name);
    const fold = (n: string) => n.trim().replace(/\s+/g, " ").toLowerCase();
    const droppedNames = new Set(droppedAll.map(fold));
    const redrawn = followedAll.filter((n) => droppedNames.has(fold(n)));
    const redrawnNames = new Set(redrawn.map(fold));
    const dropped = droppedAll.filter((n) => !redrawnNames.has(fold(n)));
    const followed = followedAll.filter((n) => !redrawnNames.has(fold(n)));
    // Intersections and complements, which no gate names: one the file carries and the tree does
    // not is dropped, and one the tree carries and the file did not record is followed. One of a
    // name both carry, built otherwise, follows the tree's.
    const treeDerived = derivedPopulations(template.tree, byDetector ? template.detectors : undefined);
    const ownDerived = derivedPopulations(file.tree, byDetector ? file.detectors : undefined);
    const lostDerived = [...ownDerived].filter(([key]) => !treeDerived.has(key)).map(([, name]) => name);
    const addedDerived = [...treeDerived].filter(([key]) => !ownDerived.has(key)).map(([, name]) => name);
    const lostNames = new Set(lostDerived.map(fold));
    const rebuilt = addedDerived.filter((n) => lostNames.has(fold(n)));
    const rebuiltNames = new Set(rebuilt.map(fold));
    dropped.push(...lostDerived.filter((n) => !rebuiltNames.has(fold(n))));
    followed.push(...addedDerived.filter((n) => !rebuiltNames.has(fold(n))));
    plan.differing.push({
      fileId: file.fileId, fileName: file.fileName, dropped, followed,
      ...(redrawn.length ? { redrawn } : {}), ...(rebuilt.length ? { rebuilt } : {}),
    });
  }
  return plan;
}

/**
 * `name` is the tree's, or how to name it from the lead file the plan chooses; each file's copy is
 * named after it ("D2.fcs · <name>"). Passed "" and renamed afterwards, the copies were "D2.fcs · ".
 */
export function planOneTreeImport(
  files: readonly TailoredFile[],
  opts: { templateId: string; name: string | ((lead: TailoredFile) => string); leadFileId: string | null; existing: readonly HierarchyRef[] },
): OneTreePlan {
  if (!files.length) throw new Error("planOneTreeImport needs at least one file");
  const groups = groupByStructure(files, opts.leadFileId);
  const lead = leadGroup(groups, opts.leadFileId);
  const name = typeof opts.name === "function" ? opts.name(lead.lead) : opts.name;
  const template = { id: opts.templateId, name, tree: lead.lead.tree, ...(lead.lead.detectors ? { detectors: lead.lead.detectors } : {}) };
  const tailoring = tailorFilesToTree(template, files, opts.existing, new Set(lead.files.map((f) => f.fileId)));
  return { template, lead: lead.lead, ...tailoring };
}

/** One line per differing file, for the import's report. */
export function describeDiffering(differing: readonly DifferingFile[]): string {
  return differing
    .map((d) => {
      const parts: string[] = [];
      if (d.redrawn?.length) parts.push(`drawn on other axes or as another kind, following the tree's: ${d.redrawn.join(", ")}`);
      if (d.rebuilt?.length) parts.push(`built on other gates, following the tree's: ${d.rebuilt.join(", ")}`);
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
