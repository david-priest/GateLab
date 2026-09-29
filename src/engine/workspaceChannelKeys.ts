// workspaceChannelKeys.ts — a saved workspace's channel keys against the files as read now.
//
// A gate names its channels by GateLab's channel key (channels.ts), and a key is derived from the
// file: $PnS, $PnN, or "{$PnS} ({$PnN})" for an unmixed channel. A change to how a file is read
// can therefore change a key without changing the parameter. Two did in 2026-09:
//   • the MACSQuant FCS 3.1 export stopped being taken for a spectral file, so its channels are
//     keyed as conventional ones: "V2-A (FL2-A)" became "V2-A", and "Time", kept by $PnN as a QC
//     channel, became "HDR-T", its $PnS;
//   • TEXT is read as UTF-8, so a label read as Latin-1 before ("IFN-Î³") is now "IFN-γ".
// A gate on the old key matched no event in any file (gates.ts returns an all-false mask for a
// channel the sample lacks), and a workspace reopened with every such population at 0 and no
// message.
//
// On open, a key that no loaded file has is restated as the key the same parameter has now, when
// the files agree on exactly one such parameter; the open message names every key restated. A
// gate whose channel a file still lacks is reported as it is when a file is added.

import type { ResolvedChannel } from "./channels";
import { fileHierarchyId, referencedGateIds } from "./hierarchies";
import type { Gate } from "./models";
import type { WorkspaceFile } from "./workspace";

const utf8 = new TextEncoder();
const latin1 = new TextDecoder("latin1");

/** A string as GateLab read it before 2026-09: its UTF-8 bytes decoded as Latin-1. */
function readAsLatin1(s: string): string {
  return latin1.decode(utf8.encode(s));
}

/**
 * The keys this channel could have had under an earlier reading of the same file: its $PnN (the
 * key of a scatter, QC or imaging channel, and of a channel with no $PnS), the unmixed form
 * "{$PnS} ({$PnN})", and the Latin-1 reading of each of those and of its current key.
 */
export function formerChannelKeys(channel: Pick<ResolvedChannel, "key" | "pnn" | "marker">): string[] {
  const marker = channel.marker?.trim();
  const direct = [channel.pnn, ...(marker ? [`${marker} (${channel.pnn})`] : [])];
  const asLatin1 = [...direct, channel.key].map(readAsLatin1);
  return [...new Set([...direct, ...asLatin1])].filter((k) => k !== channel.key);
}

/**
 * Old key → current key for every key in `keys` that no sample has, where every sample holding a
 * channel whose former key it is holds exactly one, and all of those agree on its current key. A
 * key some sample still has is never restated, so no file loses a channel it gates on.
 */
export function planChannelKeyRemap(
  keys: Iterable<string>,
  samples: readonly (readonly Pick<ResolvedChannel, "key" | "pnn" | "marker">[])[],
): Map<string, string> {
  const present = new Set(samples.flatMap((channels) => channels.map((c) => c.key)));
  const remap = new Map<string, string>();
  for (const key of new Set(keys)) {
    if (!key || present.has(key)) continue;
    const targets = new Set<string>();
    let ambiguous = false;
    for (const channels of samples) {
      const matches = channels.filter((c) => formerChannelKeys(c).includes(key));
      if (matches.length > 1) ambiguous = true;
      if (matches.length === 1) targets.add(matches[0].key);
    }
    if (!ambiguous && targets.size === 1) remap.set(key, [...targets][0]);
  }
  return remap;
}

/** Every channel key a gate table names: both axes, and the axes of any transforms it records. */
export function gateChannelKeys(gates: Record<string, Gate>): Set<string> {
  const keys = new Set<string>();
  for (const gate of Object.values(gates)) {
    keys.add(gate.x_channel);
    keys.add(gate.y_channel);
    for (const key of Object.keys(gate.transforms ?? {})) keys.add(key);
  }
  return keys;
}

/** A gate table with its channel keys restated through `remap`; the same object when none is. */
export function remapGateChannels(
  gates: Record<string, Gate>,
  remap: ReadonlyMap<string, string>,
): Record<string, Gate> {
  if (remap.size === 0) return gates;
  let changed = false;
  const out: Record<string, Gate> = {};
  for (const [id, gate] of Object.entries(gates)) {
    const x = remap.get(gate.x_channel);
    const y = remap.get(gate.y_channel);
    const transformKeys = Object.keys(gate.transforms ?? {});
    if (x === undefined && y === undefined && !transformKeys.some((k) => remap.has(k))) {
      out[id] = gate;
      continue;
    }
    changed = true;
    out[id] = {
      ...gate,
      x_channel: x ?? gate.x_channel,
      y_channel: y ?? gate.y_channel,
      ...(gate.transforms
        ? { transforms: Object.fromEntries(Object.entries(gate.transforms).map(([k, spec]) => [remap.get(k) ?? k, spec])) }
        : {}),
    } as Gate;
  }
  return changed ? out : gates;
}

/** The names of the gates in `gates` that name a channel outside `channelKeys`. */
export function gatesMissingChannels(gates: Record<string, Gate>, channelKeys: ReadonlySet<string>): string[] {
  return Object.values(gates)
    .filter((g) => !channelKeys.has(g.x_channel) || !channelKeys.has(g.y_channel))
    .map((g) => g.name);
}

/**
 * The gates a file is gated by in a saved workspace, resolved as the store's loadWorkspace and
 * fileHierarchyId resolve them: the tree the file names when per-file hierarchies are on, else the
 * first tree; the active tree's gates are `gating.gates`, a parked tree's are its own, or, in a
 * workspace written before trees owned their gates, the shared ones its populations use.
 */
export function savedFileTreeGates(
  gating: WorkspaceFile["gating"],
  assignedHierarchyId: string | undefined,
): Record<string, Gate> {
  const refs = gating.hierarchies ?? [];
  if (refs.length === 0) return gating.gates;
  const activeId = gating.active_hierarchy_id && refs.some((h) => h.id === gating.active_hierarchy_id)
    ? gating.active_hierarchy_id
    : refs[0].id;
  const treeId = fileHierarchyId(gating.perFileHierarchies === true ? assignedHierarchyId : undefined, refs);
  if (treeId === activeId) return gating.gates;
  const stored = gating.stored_hierarchies?.find((h) => h.id === treeId);
  if (!stored) return {};
  if (stored.gates) return stored.gates;
  const out: Record<string, Gate> = {};
  for (const id of referencedGateIds(stored.populations)) if (gating.gates[id]) out[id] = gating.gates[id];
  return out;
}
