// tailoredGates.ts — which version of each gate a file is gated with, for drawing it.
//
// A workspace holds one tree; a file follows it, or tailors a gate's coordinates in a
// structure-locked copy of its own (or its group's). The Gating tab draws the live tree's gates
// and edits move them, so without this the plot drew the tree's gate on a file counted under its
// own: a FlowJo 11 import showed a gate holding 791 events on the plot and 819 in the population
// tree for the same file. Nothing here changes a gate or a count; it only says which stored gate
// is the file's, so the plot can draw that one, mark it, and send an edit of it to its own tree.

import { correspondingHierarchyId, storeHierarchy, type StoredHierarchy } from "../engine/hierarchies";
import { gateMaskKey, type GateMaskCache } from "../engine/populations";
import { templateOf } from "../engine/groups";
import { tailoredGateIds } from "../engine/templateSync";
import type { Gate } from "../engine/models";
import { switchedOnGateIds, type CoreState, type GatingDerived } from "../store";

/** A gate the viewed file holds at coordinates of its own, or its group's. */
export interface TailoredVersion {
  /** The tree holding this version: an edit of it, a revert, or a use for the tree acts there. */
  hierarchyId: string;
  /** The gate's id in that tree. */
  gateId: string;
  /** Who tailored it: the viewed file itself, or the group it is in (named). */
  owner: { kind: "file" } | { kind: "group"; name: string };
  /**
   * What the version follows, drawn dashed beside it: the tree's gate, or the group's for a file
   * of a group. Null for a gate whose source is gone, which counts as tailored all the same.
   */
  reference: Gate | null;
}

/** A live gate as the plot draws it on the viewed file. */
export interface DrawnGate {
  /** What is drawn, under the live gate's id: the file's own version. */
  gate: Gate;
  /** The gate's id in the file's own tree, whose gating the counts come from. */
  ownGateId: string;
  /** Set when the file's version differs from the live tree's. */
  tailored: TailoredVersion | null;
}

/**
 * A version of a live gate that pooled files are gated with instead of the tree's: one file's own
 * (drawn dashed in the file's pool colour) or a group's (in the group's colour), with the pooled
 * files that use it. One per version, however many files share it.
 */
export interface PooledVersion {
  /** The tree holding it: the file's copy, or the group's. */
  hierarchyId: string;
  owner: { kind: "file"; fileId: string } | { kind: "group"; groupId: string; name: string };
  /** The pooled files gated with it, in the order given. */
  fileIds: string[];
  /** The version, under the live gate's id. */
  gate: Gate;
}

/**
 * A copy's tailored gates, by its own gate ids: those the file switched on, and those whose
 * coordinates differ from the tree it follows (tailoredGateIds). The file list's badge and count
 * use the same rule (tailoredInCopy), so a switch, a tag and the badge never disagree.
 */
export function tailoredInCopy(copy: StoredHierarchy, source: StoredHierarchy | null | undefined): Set<string> {
  const out = source?.root_population_id
    ? tailoredGateIds(copy, { ...source, root_population_id: source.root_population_id })
    : new Set<string>();
  for (const id of switchedOnGateIds(copy)) if (copy.gates[id]) out.add(id);
  return out;
}

function tailoredIn(copy: StoredHierarchy, trees: Readonly<Record<string, StoredHierarchy>>): Set<string> {
  return tailoredInCopy(copy, copy.source_hierarchy_id ? trees[copy.source_hierarchy_id] : undefined);
}

/** The gate a copy's gate follows, in the tree it follows. */
function sourceGate(copy: StoredHierarchy, gateId: string, trees: Readonly<Record<string, StoredHierarchy>>): Gate | null {
  const sourceId = copy.source_gate_ids?.[gateId];
  const source = copy.source_hierarchy_id ? trees[copy.source_hierarchy_id] : undefined;
  return (sourceId && source?.gates[sourceId]) || null;
}

/** Every tree of the workspace, the live one included, by id. */
export function workspaceTrees(state: CoreState): Record<string, StoredHierarchy> {
  const live = state.hierarchies.find((h) => h.id === state.active_hierarchy_id);
  return live ? { ...state.stored_hierarchies, [live.id]: storeHierarchy(live, state) } : { ...state.stored_hierarchies };
}

/** Whether `treeId` is another tree of the live tree's family: the copy a file or a group is gated under. */
function inLiveFamily(state: CoreState, treeId: string): boolean {
  if (treeId === state.active_hierarchy_id || !state.stored_hierarchies[treeId]) return false;
  const live = templateOf(state.active_hierarchy_id, state.hierarchies);
  return !!live && templateOf(treeId, state.hierarchies)?.id === live.id;
}

function groupName(state: CoreState, groupId: string | undefined): string {
  return state.groups.find((g) => g.id === groupId)?.name ?? "";
}

/**
 * The viewed file's version of each live gate whose drawing is not simply the live gate:
 *
 * - The file is gated under another tree of the family than the live one (its own copy, or its
 *   group's, while edits go to the tree): every live gate is drawn as that tree has it. A gate the
 *   copy tailors is owned by the file; one the file's copy takes unchanged from its group's, where
 *   the group tailors it, by the group.
 * - The live tree is a copy itself (edits go to the file or the group): the live gates are the
 *   file's, and those it tailors are owned by it.
 *
 * Tailored is tailoredGateIds against what each copy follows, the rule behind the file list's
 * badge, so a tag and the badge name the same gates. Comparing with the live tree instead, on
 * the file's own channels, a copy on channels of its own was counted tailored by the badge and
 * not tagged.
 *
 * `fileTreeId` is the tree the viewed file is gated under; null for no file, or for a pooled view,
 * which draws and edits the tree.
 */
export function viewedFileGates(state: CoreState, fileTreeId: string | null): Map<string, DrawnGate> {
  const out = new Map<string, DrawnGate>();
  if (!fileTreeId || !state.root_population_id) return out;
  const trees = workspaceTrees(state);
  const live = trees[state.active_hierarchy_id];
  if (!live) return out;
  if (inLiveFamily(state, fileTreeId)) {
    const own = trees[fileTreeId];
    const ownRef = state.hierarchies.find((h) => h.id === fileTreeId);
    const ownTailored = tailoredIn(own, trees);
    // A file's copy of a group's tree: a gate it takes unchanged from the group may be the group's tailoring.
    const via = ownRef?.owner_sample_id && ownRef.source_hierarchy_id && ownRef.source_hierarchy_id !== live.id
      ? trees[ownRef.source_hierarchy_id] : undefined;
    const viaTailored = via?.owner_group_id ? tailoredIn(via, trees) : new Set<string>();
    for (const gid of Object.keys(live.gates)) {
      const ownGateId = correspondingHierarchyId(live, gid, own, trees, "gate");
      const ownGate = ownGateId ? own.gates[ownGateId] : undefined;
      if (!ownGateId || !ownGate) continue;
      let tailored: TailoredVersion | null = null;
      const viaId = via ? own.source_gate_ids?.[ownGateId] : undefined;
      if (ownTailored.has(ownGateId)) {
        tailored = {
          hierarchyId: own.id, gateId: ownGateId,
          owner: ownRef?.owner_group_id ? { kind: "group", name: groupName(state, ownRef.owner_group_id) } : { kind: "file" },
          reference: sourceGate(own, ownGateId, trees),
        };
      } else if (via && viaId && viaTailored.has(viaId)) {
        tailored = { hierarchyId: via.id, gateId: viaId, owner: { kind: "group", name: groupName(state, via.owner_group_id) }, reference: sourceGate(via, viaId, trees) };
      }
      out.set(gid, { gate: ownGate.gate_id === gid ? ownGate : { ...ownGate, gate_id: gid }, ownGateId, tailored });
    }
    return out;
  }
  if (fileTreeId !== live.id) return out;
  const liveRef = state.hierarchies.find((h) => h.id === live.id);
  if (!liveRef?.source_hierarchy_id || !(liveRef.owner_sample_id || liveRef.owner_group_id)) return out;
  for (const gid of tailoredIn(live, trees)) {
    const liveGate = live.gates[gid];
    if (!liveGate) continue;
    out.set(gid, {
      gate: liveGate,
      ownGateId: gid,
      tailored: {
        hierarchyId: live.id, gateId: gid,
        owner: liveRef.owner_group_id ? { kind: "group", name: groupName(state, liveRef.owner_group_id) } : { kind: "file" },
        reference: sourceGate(live, gid, trees),
      },
    });
  }
  return out;
}

/**
 * For a pooled view, which draws the live tree's gates: the versions of each live gate the pooled
 * files are gated with instead of the tree's, by live gate id, one per version. A file whose own
 * copy tailors the gate has a version of its own; a file that takes the gate from its group's
 * copy, where the group tailors it, shares the group's with the group's other pooled files.
 * Tailored is the badge's rule (tailoredIn). `files` names the tree each file is gated under; a
 * file under the live tree itself follows it.
 */
export function pooledVersions(
  state: CoreState,
  files: readonly { fileId: string; treeId: string }[],
): Map<string, PooledVersion[]> {
  const out = new Map<string, PooledVersion[]>();
  if (!state.root_population_id) return out;
  const trees = workspaceTrees(state);
  const live = trees[state.active_hierarchy_id];
  if (!live) return out;
  const add = (gid: string, version: Omit<PooledVersion, "fileIds">, fileId: string) => {
    const list = out.get(gid) ?? [];
    const found = list.find((v) => v.hierarchyId === version.hierarchyId);
    if (found) found.fileIds.push(fileId);
    else list.push({ ...version, fileIds: [fileId] });
    out.set(gid, list);
  };
  for (const { fileId, treeId } of files) {
    if (!inLiveFamily(state, treeId)) continue;
    const own = trees[treeId];
    const ownTailored = tailoredIn(own, trees);
    const via = own.owner_sample_id && own.source_hierarchy_id && own.source_hierarchy_id !== live.id ? trees[own.source_hierarchy_id] : undefined;
    const viaTailored = via?.owner_group_id ? tailoredIn(via, trees) : new Set<string>();
    for (const gid of Object.keys(live.gates)) {
      const ownGateId = correspondingHierarchyId(live, gid, own, trees, "gate");
      const ownGate = ownGateId ? own.gates[ownGateId] : undefined;
      if (!ownGateId || !ownGate) continue;
      const viaId = via ? own.source_gate_ids?.[ownGateId] : undefined;
      if (ownTailored.has(ownGateId)) {
        const owner: PooledVersion["owner"] = own.owner_group_id
          ? { kind: "group", groupId: own.owner_group_id, name: groupName(state, own.owner_group_id) }
          : { kind: "file", fileId };
        add(gid, { hierarchyId: own.id, owner, gate: { ...ownGate, gate_id: gid } }, fileId);
      } else if (via && viaId && viaTailored.has(viaId)) {
        add(gid, {
          hierarchyId: via.id,
          owner: { kind: "group", groupId: via.owner_group_id!, name: groupName(state, via.owner_group_id) },
          gate: { ...via.gates[viaId], gate_id: gid },
        }, fileId);
      }
    }
  }
  return out;
}

/** Whether every one of `fileIds` is gated with some version other than the tree's. */
export function noFileFollowsTree(versions: readonly PooledVersion[] | undefined, fileIds: readonly string[]): boolean {
  if (!versions?.length || !fileIds.length) return false;
  const away = new Set(versions.flatMap((v) => v.fileIds));
  return fileIds.every((id) => away.has(id));
}

/**
 * The live tree's gate id of each gate of a file's own tree, for keying that tree's gate masks
 * by the live tree (gatingKeyedByLiveTree keys the populations; this does the gates).
 */
export function liveGateIdsInFileTree(state: CoreState, treeId: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!inLiveFamily(state, treeId)) return out;
  const trees = workspaceTrees(state);
  const live = trees[state.active_hierarchy_id];
  const own = trees[treeId];
  for (const gid of Object.keys(live?.gates ?? {})) {
    const ownGateId = correspondingHierarchyId(live, gid, own, trees, "gate");
    if (ownGateId) out.set(gid, ownGateId);
  }
  return out;
}

/**
 * `keyed`, a file's own tree's gating keyed by the live tree's populations, with each live gate's
 * mask taken from the file's own version of that gate (`own`, that tree's gating). The gate
 * counts on the plot and in the gate list are then the file's own, as the population tree's are;
 * with the live gate's mask they counted the tree's gate within the file's own populations.
 */
export function withOwnGateMasks(keyed: GatingDerived, own: GatingDerived, ownGateIds: ReadonlyMap<string, string>): GatingDerived {
  if (!ownGateIds.size) return keyed;
  const gateMasks: GateMaskCache = { ...keyed.gateMasks };
  for (const [liveId, ownId] of ownGateIds) {
    for (const quadrant of [undefined, 1, 2, 3, 4]) {
      const mask = own.gateMasks[gateMaskKey(ownId, quadrant)];
      if (mask) gateMasks[gateMaskKey(liveId, quadrant)] = mask;
    }
  }
  return { ...keyed, gateMasks };
}
