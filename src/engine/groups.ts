/**
 * Groups: the hierarchy list read the way FlowJo reads a workspace.
 *
 * A group is a template tree plus the files gated under it, each either directly or through a
 * file-owned copy whose source is the template. A tree that no file owns is a template, whether
 * or not anything derives from it yet; a free tree (one nobody copied) is a group of its own.
 * A copy's group is its source's group, followed up until a tree nobody owns, so a copy of a
 * copy still sits under the template it came from. Nothing here changes state: it is the view
 * the menu shows, computed from the hierarchy list and the file assignments.
 */

import type { HierarchyRef } from "./hierarchies";
import { fileHierarchyId, isCopyRef } from "./hierarchies";

export interface GroupMember {
  fileId: string;
  fileName: string;
  /** The tree the file is gated under: the template itself, or its copy. */
  treeId: string;
  /** The file's copy, when it has one. */
  copy: HierarchyRef | null;
  /** Whether the copy's gates differ from the template's; null until told. */
  tailored: boolean | null;
}

export interface HierarchyGroup {
  template: HierarchyRef;
  /** 1-based position of the template in the hierarchy menu. */
  index: number;
  members: GroupMember[];
  /** Copies of this template that belong to no loaded file (their file was removed). */
  orphanCopies: HierarchyRef[];
}

/** The template a tree belongs to: itself when nobody owns it, else its source's, followed up. */
export function templateOf(treeId: string, hierarchies: readonly HierarchyRef[]): HierarchyRef | null {
  const byId = new Map(hierarchies.map((h) => [h.id, h]));
  let cur = byId.get(treeId) ?? null;
  const seen = new Set<string>();
  while (cur && isCopyRef(cur) && cur.source_hierarchy_id && !seen.has(cur.id)) {
    seen.add(cur.id);
    const src = byId.get(cur.source_hierarchy_id);
    if (!src) break;
    cur = src;
  }
  return cur;
}

export function groupsOf(
  hierarchies: readonly HierarchyRef[],
  files: readonly { id: string; name: string }[],
  fileHierarchies: Readonly<Record<string, string>>,
  tailoredOf?: (copy: HierarchyRef) => boolean | null,
): HierarchyGroup[] {
  const byId = new Map(hierarchies.map((h) => [h.id, h]));
  const groups: HierarchyGroup[] = [];
  const groupByTemplate = new Map<string, HierarchyGroup>();
  hierarchies.forEach((h, i) => {
    if (isCopyRef(h)) return;
    const g: HierarchyGroup = { template: h, index: i + 1, members: [], orphanCopies: [] };
    groups.push(g);
    groupByTemplate.set(h.id, g);
  });
  const owned = new Set<string>();
  for (const f of files) {
    const treeId = fileHierarchyId(fileHierarchies[f.id], hierarchies);
    const tree = byId.get(treeId) ?? null;
    const template = templateOf(treeId, hierarchies);
    const g = template ? groupByTemplate.get(template.id) : undefined;
    if (!g || !tree) continue;
    const copy = tree.owner_sample_id ? tree : null;
    if (copy) owned.add(copy.id);
    g.members.push({ fileId: f.id, fileName: f.name, treeId, copy, tailored: copy && tailoredOf ? tailoredOf(copy) : null });
  }
  for (const h of hierarchies) {
    if (!h.owner_sample_id || owned.has(h.id)) continue;
    const template = templateOf(h.id, hierarchies);
    const g = template ? groupByTemplate.get(template.id) : undefined;
    if (g) g.orphanCopies.push(h);
  }
  return groups;
}
