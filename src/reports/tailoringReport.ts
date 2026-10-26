// tailoringReport.ts — the gates files are gated with at coordinates of their own or their group's,
// and how far each moved from the gate it follows: for the tailoring table, the Gating-ML export's
// notice, and anyone writing the methods. A tailored gate is the file list badge's rule
// (tailoredInCopy): coordinates that differ from what the copy follows, or a gate the file switched
// on. Headless: reads the state and changes nothing.

import { gateCorners, toRawUnits } from "../engine/gateSpace";
import type { StoredHierarchy } from "../engine/hierarchies";
import { isUnbounded, type Gate } from "../engine/models";
import { tailoredInCopy, workspaceTrees } from "../plots/tailoredGates";
import type { CoreState } from "../store";

/**
 * How a tailored gate differs from the gate it follows, in raw channel values: a gate drawn in
 * display space is taken back to raw through the transforms it records. Only a display gate
 * that records none is compared in display units (TailoredGate.space says which).
 *
 * - same: switched on, at the coordinates it follows.
 * - moved: dx and dy are the largest shift of any vertex (a rectangle's corners, an ellipse's or a
 *   quadrant's centre) on each axis, with its sign; `reshaped` when the vertices did not all move
 *   by the same amount, or an ellipse's size or a quadrant's arms changed.
 * - reshaped: not comparable vertex by vertex (another number of vertices, another gate type or
 *   axes, a bound opened or closed, another space); `why` says which.
 * - no-source: the gate it followed is gone.
 */
export type GateShift =
  | { kind: "same" }
  | { kind: "moved"; dx: number; dy: number; reshaped: boolean; space: "raw" | "display" }
  | { kind: "reshaped"; why: string }
  | { kind: "no-source" };

export interface TailoredGate {
  /** The tree holding this version: a file's copy, or a group's. */
  treeId: string;
  owner: { kind: "file"; fileId: string } | { kind: "group"; groupId: string; name: string };
  /** The gate's id in that tree. */
  gateId: string;
  gateName: string;
  xChannel: string;
  yChannel: string;
  /** What it follows: the tree, or (for a file of a group) the group's version. */
  follows: { kind: "tree" } | { kind: "group"; name: string };
  shift: GateShift;
  /** The files gated with this version, in the order given: the owner, or the group's files that take it unchanged. */
  fileIds: string[];
}

// A shift this small, relative to the coordinates, is rounding, not a move.
const tol = (a: number, b: number) => 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const near = (a: number, b: number) => a === b || Math.abs(a - b) <= tol(a, b);

/** The signed value of largest magnitude. */
function largest(values: readonly number[]): number {
  return values.reduce((best, v) => (Math.abs(v) > Math.abs(best) ? v : best), 0);
}

/**
 * A gate's points in raw channel values, through the transforms a display gate records; null for
 * a display gate that records none for an axis. An unbounded coordinate stays unbounded.
 */
function rawPoints(gate: Gate, points: [number, number][]): [number, number][] | null {
  if ((gate.space ?? "raw") === "raw") return points;
  const x = gate.transforms?.[gate.x_channel];
  const y = gate.transforms?.[gate.y_channel];
  if (!x || !y) return null;
  const raw = (spec: typeof x, v: number) => (isUnbounded(v) ? v : toRawUnits(spec, v));
  return points.map(([px, py]) => [raw(x, px), raw(y, py)]);
}

/** How `gate` differs from `source`, the gate it follows (GateShift). */
export function gateShift(gate: Gate, source: Gate | null | undefined): GateShift {
  if (!source) return { kind: "no-source" };
  if (gate.gate_type !== source.gate_type) return { kind: "reshaped", why: `${source.gate_type} to ${gate.gate_type}` };
  if (gate.x_channel !== source.x_channel || gate.y_channel !== source.y_channel) return { kind: "reshaped", why: "other axes" };
  let points: [number, number][][];
  let otherChange = false;
  if (gate.gate_type === "ellipse" && source.gate_type === "ellipse") {
    points = [[gate.mean], [source.mean]];
    otherChange = !near(gate.distance_square, source.distance_square)
      || gate.covariance.some((row, i) => row.some((v, j) => !near(v, source.covariance[i][j])));
  } else if (gate.gate_type === "quadrant" && source.gate_type === "quadrant") {
    points = [[gate.center], [source.center]];
    // Arms are stored where they end, so a quadrant that only moved has moved them by its centre.
    const relativeArms = (q: typeof gate) => q.arms
      ? Object.values(q.arms).map(([x, y]) => [x - q.center[0], y - q.center[1]])
      : null;
    otherChange = JSON.stringify(gate.curl ?? null) !== JSON.stringify(source.curl ?? null)
      || JSON.stringify(relativeArms(gate)) !== JSON.stringify(relativeArms(source));
  } else if ((gate.gate_type === "polygon" || gate.gate_type === "rectangle") && (source.gate_type === "polygon" || source.gate_type === "rectangle")) {
    const a = gateCorners(gate);
    const b = gateCorners(source);
    if (a.length !== b.length) return { kind: "reshaped", why: `${b.length} to ${a.length} vertices` };
    if (gate.gate_type === "rectangle" && JSON.stringify(gate.bounds ?? null) !== JSON.stringify(source.bounds ?? null)) {
      return { kind: "reshaped", why: "other edge rule" };
    }
    points = [a, b];
  } else {
    return { kind: "reshaped", why: "other shape" };
  }
  // Both in raw values when both can be; else, in the one space they share.
  let space: "raw" | "display" = "raw";
  let mine = rawPoints(gate, points[0]);
  let theirs = rawPoints(source, points[1]);
  if (!mine || !theirs) {
    if ((gate.space ?? "raw") !== (source.space ?? "raw") || JSON.stringify(gate.transforms ?? null) !== JSON.stringify(source.transforms ?? null)) {
      return { kind: "reshaped", why: "other space" };
    }
    [mine, theirs] = points;
    space = "display";
  }
  const dxs: number[] = [];
  const dys: number[] = [];
  for (let i = 0; i < mine.length; i++) {
    for (const axis of [0, 1] as const) {
      const p = mine[i][axis];
      const q = theirs[i][axis];
      if (p === q) {
        (axis === 0 ? dxs : dys).push(0);
        continue;
      }
      // An open bound on one side only: the gate was opened or closed, which no number states.
      if (isUnbounded(p) || isUnbounded(q)) {
        if (Math.sign(p) === Math.sign(q) && isUnbounded(p) && isUnbounded(q)) {
          (axis === 0 ? dxs : dys).push(0);
          continue;
        }
        return { kind: "reshaped", why: "bound opened or closed" };
      }
      (axis === 0 ? dxs : dys).push(near(p, q) ? 0 : p - q);
    }
  }
  const dx = largest(dxs);
  const dy = largest(dys);
  const uneven = dxs.some((v) => !near(v, dxs[0])) || dys.some((v) => !near(v, dys[0]));
  if (dx === 0 && dy === 0 && !otherChange) return { kind: "same" };
  return { kind: "moved", dx, dy, reshaped: uneven || otherChange, space };
}

function gateFollowed(copy: StoredHierarchy, gateId: string, trees: Readonly<Record<string, StoredHierarchy>>): Gate | null {
  const sourceId = copy.source_gate_ids?.[gateId];
  const source = copy.source_hierarchy_id ? trees[copy.source_hierarchy_id] : undefined;
  return (sourceId && source?.gates[sourceId]) || null;
}

/**
 * Every tailored gate that a given file is gated with, by tree and gate, in the order of the files
 * and then of each tree's gates. `files` names the tree each file is gated under. A version no
 * listed file is gated with (a copy whose file was removed) is left out.
 */
export function tailoringReport(state: CoreState, files: readonly { fileId: string; treeId: string }[]): TailoredGate[] {
  const trees = workspaceTrees(state);
  const groupName = (id: string | undefined) => state.groups.find((g) => g.id === id)?.name ?? "";
  const tailoredOf = new Map<string, Set<string>>();
  const tailored = (tree: StoredHierarchy) => {
    let set = tailoredOf.get(tree.id);
    if (!set) {
      set = tailoredInCopy(tree, tree.source_hierarchy_id ? trees[tree.source_hierarchy_id] : undefined);
      tailoredOf.set(tree.id, set);
    }
    return set;
  };
  const rows = new Map<string, TailoredGate>();
  const add = (tree: StoredHierarchy, gateId: string, fileId: string) => {
    const key = `${tree.id}\u0000${gateId}`;
    const found = rows.get(key);
    if (found) {
      if (!found.fileIds.includes(fileId)) found.fileIds.push(fileId);
      return;
    }
    const gate = tree.gates[gateId];
    const source = tree.source_hierarchy_id ? trees[tree.source_hierarchy_id] : undefined;
    rows.set(key, {
      treeId: tree.id,
      owner: tree.owner_group_id
        ? { kind: "group", groupId: tree.owner_group_id, name: groupName(tree.owner_group_id) }
        : { kind: "file", fileId: tree.owner_sample_id ?? fileId },
      gateId,
      gateName: gate.name,
      xChannel: gate.x_channel,
      yChannel: gate.y_channel,
      follows: source?.owner_group_id ? { kind: "group", name: groupName(source.owner_group_id) } : { kind: "tree" },
      shift: gateShift(gate, gateFollowed(tree, gateId, trees)),
      fileIds: [fileId],
    });
  };
  const inOrder = (tree: StoredHierarchy, ids: Set<string>) =>
    [...tree.gate_order.filter((id) => ids.has(id)), ...[...ids].filter((id) => !tree.gate_order.includes(id))];
  for (const { fileId, treeId } of files) {
    const own = trees[treeId];
    if (!own?.source_hierarchy_id || !(own.owner_sample_id || own.owner_group_id)) continue;
    const ownTailored = tailored(own);
    for (const gid of inOrder(own, ownTailored)) if (own.gates[gid]) add(own, gid, fileId);
    // A file's copy of a group's tree: the gates it takes unchanged from the group are the group's tailoring.
    const via = own.owner_sample_id ? trees[own.source_hierarchy_id] : undefined;
    if (!via?.owner_group_id || !via.source_hierarchy_id) continue;
    const viaTailored = tailored(via);
    const takenFromVia = new Map(Object.entries(own.source_gate_ids ?? {}).map(([mine, theirs]) => [theirs, mine]));
    for (const gid of inOrder(via, viaTailored)) {
      const mine = takenFromVia.get(gid);
      if (via.gates[gid] && (!mine || !ownTailored.has(mine))) add(via, gid, fileId);
    }
  }
  return [...rows.values()];
}

/** The files gated with at least one tailored gate, in the order given. */
export function tailoredFileIds(report: readonly TailoredGate[], files: readonly { fileId: string }[]): string[] {
  const ids = new Set(report.flatMap((row) => row.fileIds));
  return files.map((f) => f.fileId).filter((id) => ids.has(id));
}

/** A tailored gate with the names the table and its CSV show, and the reason the user gave. */
export interface NamedTailoredGate extends TailoredGate {
  /** The file's name, or the group's. */
  ownerName: string;
  /** The names of the files gated with this version. */
  fileNames: string[];
  reason: string;
}

/** A shift's number with its sign, to four significant figures. */
export function signedShift(v: number): string {
  if (v === 0) return "0";
  const digits = Math.abs(v).toPrecision(4);
  return (v > 0 ? "+" : "-") + String(Number(digits));
}

/** A shift in words, as the CSV writes it. */
export function shiftText(shift: GateShift, xLabel: string, yLabel: string): string {
  switch (shift.kind) {
    case "same": return "none: switched on at the coordinates it follows";
    case "no-source": return "the gate it followed is gone";
    case "reshaped": return `reshaped: ${shift.why}`;
    case "moved": return `${xLabel} ${signedShift(shift.dx)}, ${yLabel} ${signedShift(shift.dy)}${shift.reshaped ? "; reshaped" : ""}${shift.space === "display" ? " (display units)" : ""}`;
  }
}

/**
 * The table as RFC 4180 CSV (CRLF records; a field with a comma, quote or line break quoted), one
 * row per version: who owns it, the files gated with it, the gate and its axes, what it follows,
 * the shift (dx and dy empty when it is not a move) and the reason.
 */
export function tailoringCsv(rows: readonly NamedTailoredGate[], labelOf: (channel: string) => string): string {
  const field = (value: string | number) => {
    const text = String(value);
    return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ["owner_kind", "owner", "files", "gate", "x_channel", "y_channel", "follows", "dx", "dy", "units", "reshaped", "shift", "reason"];
  const records = rows.map((row) => {
    const moved = row.shift.kind === "moved" ? row.shift : null;
    return [
      row.owner.kind,
      row.ownerName,
      row.fileNames.join("; "),
      row.gateName,
      labelOf(row.xChannel),
      labelOf(row.yChannel),
      row.follows.kind === "group" ? row.follows.name : "tree",
      moved ? moved.dx : "",
      moved ? moved.dy : "",
      moved ? moved.space : "",
      moved ? String(moved.reshaped) : row.shift.kind === "reshaped" ? "true" : "false",
      shiftText(row.shift, labelOf(row.xChannel), labelOf(row.yChannel)),
      row.reason,
    ];
  });
  return [header, ...records].map((record) => record.map(field).join(",") + "\r\n").join("");
}

/**
 * The reasons given for tailored gates, by the tree holding the version and its gate id, saved at
 * the top level of the workspace JSON under TAILORING_REASONS_FIELD. Nothing in gating reads them.
 */
export type TailoringReasons = Record<string, Record<string, string>>;
export const TAILORING_REASONS_FIELD = "tailoringReasons";

/** The reasons a workspace JSON object holds; anything not a string under a tree and a gate is dropped. */
export function readTailoringReasons(workspace: unknown): TailoringReasons {
  if (!workspace || typeof workspace !== "object") return {};
  const raw = (workspace as Record<string, unknown>)[TAILORING_REASONS_FIELD];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: TailoringReasons = {};
  for (const [treeId, gates] of Object.entries(raw)) {
    if (!gates || typeof gates !== "object" || Array.isArray(gates)) continue;
    const kept = Object.entries(gates).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "");
    if (kept.length) out[treeId] = Object.fromEntries(kept);
  }
  return out;
}

/** The reasons worth saving: those given for a gate the workspace still holds, and not blank. */
export function savedTailoringReasons(reasons: TailoringReasons, trees: Readonly<Record<string, StoredHierarchy>>): TailoringReasons {
  const out: TailoringReasons = {};
  for (const [treeId, gates] of Object.entries(reasons)) {
    const kept = Object.entries(gates).filter(([gateId, reason]) => trees[treeId]?.gates[gateId] && reason.trim() !== "");
    if (kept.length) out[treeId] = Object.fromEntries(kept);
  }
  return out;
}
