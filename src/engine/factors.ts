// factors.ts — resolve the Proportions tab's grouping variables. GateLabR reads per-event colData
// factors; GateLab synthesises them per Sample from three sources:
//   • per-EVENT population Partition — each event → the DEEPEST selected population it belongs to
//     (events in none → "ungated"). This is the Category axis (user asked to allow populations).
//   • per-SAMPLE metadata field (or the sample name) — the Group / Unit / Facet axes, constant
//     within a sample.
// Population masks come from the shared gating tree via recompute() → Derived.masks, per Sample.

import { populationTreeOrder } from "./populations";
import { divisionLevelCounts } from "./division";
import type { PopulationMap } from "./models";
import type { Sample } from "./sample";

export interface PartitionLevel {
  popId: string;
  name: string;
  depth: number;
}

/** Selected populations as tree-ordered levels (deepest-membership tie-break uses `depth`). */
export function resolvePartitionLevels(
  populations: PopulationMap,
  rootId: string | null,
  selectedPopIds: string[],
): PartitionLevel[] {
  const order = populationTreeOrder(populations, rootId);
  const treeIndex: Record<string, number> = {};
  const depth: Record<string, number> = {};
  order.forEach(({ popId, depth: d }, i) => { treeIndex[popId] = i; depth[popId] = d; });
  return selectedPopIds
    .filter((id) => id in treeIndex && id !== rootId)
    .sort((a, b) => treeIndex[a] - treeIndex[b])
    .map((popId) => ({ popId, name: populations[popId]?.name ?? popId, depth: depth[popId] }));
}

/**
 * Count events per partition level for ONE sample: each event is assigned to the deepest selected
 * population whose mask contains it (ties → earlier tree order), else "ungated". `counts` aligns to
 * `levels`; `ungated` is the leftover.
 */
export function partitionCountsFor(
  masks: Record<string, Uint8Array>,
  levels: PartitionLevel[],
  nEvents: number,
): { counts: number[]; ungated: number } {
  const counts = new Array(levels.length).fill(0);
  let ungated = 0;
  const maskList = levels.map((l) => masks[l.popId] ?? null);
  for (let e = 0; e < nEvents; e++) {
    let best = -1;
    let bestDepth = -1;
    for (let li = 0; li < levels.length; li++) {
      const m = maskList[li];
      if (m && m[e] && levels[li].depth > bestDepth) { best = li; bestDepth = levels[li].depth; }
    }
    if (best >= 0) counts[best]++;
    else ungated++;
  }
  return { counts, ungated };
}

// ── Category: per-event division level (from a Division-tab profile) ───────────
export interface DivisionProfileLike {
  channelKey: string;
  boundaries: number[];
  n: number;
  /** Optional only for legacy callers; App filters profiles against the active Sample binding. */
  coordinateBindingKey?: string;
}

/** Div0..DivN level names for the given max N. */
export function divisionLevels(maxN: number): string[] {
  return Array.from({ length: Math.max(0, maxN) + 1 }, (_, i) => `Div${i}`);
}

/** Per-level counts for one sample's whole-sample events, padded to Div0..DivMaxN (0s if no profile). */
export function divisionCountsFor(sample: Sample, profile: DivisionProfileLike | undefined, maxN: number): number[] {
  const out = new Array(maxN + 1).fill(0);
  if (!profile) return out;
  const idx = sample.index(profile.channelKey);
  if (idx === undefined) return out;
  const c = divisionLevelCounts(sample.displayColumn(idx), profile.boundaries);
  for (let i = 0; i < c.length && i <= maxN; i++) out[i] = c[i];
  return out;
}

/**
 * Per-event partition ASSIGNMENT (for the colour overlay): each event → the index of the deepest
 * selected population it belongs to, or -1 (ungated). Same deepest-membership rule as partitionCountsFor.
 */
export function partitionAssign(
  masks: Record<string, Uint8Array>,
  levels: PartitionLevel[],
  nEvents: number,
): Int32Array {
  const out = new Int32Array(nEvents).fill(-1);
  const maskList = levels.map((l) => masks[l.popId] ?? null);
  for (let e = 0; e < nEvents; e++) {
    let best = -1;
    let bestDepth = -1;
    for (let li = 0; li < levels.length; li++) {
      const m = maskList[li];
      if (m && m[e] && levels[li].depth > bestDepth) { best = li; bestDepth = levels[li].depth; }
    }
    out[e] = best;
  }
  return out;
}

export const NA_VALUE = "(NA)";

/** A per-sample grouping value: the sample name itself, or one of its metadata fields. */
export type PerSampleFactor = { kind: "sample" } | { kind: "metadata"; field: string };

export function resolvePerSampleValue(
  spec: PerSampleFactor,
  sampleName: string,
  metadataRow: Record<string, string> | undefined,
): string {
  if (spec.kind === "sample") return sampleName;
  const v = metadataRow?.[spec.field];
  return v && v.length ? v : NA_VALUE;
}
