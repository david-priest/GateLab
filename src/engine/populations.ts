// populations.ts — apply the gating strategy across the population tree (BFS) and
// compute per-gate counts within a population. Ported from GateLabR gate_engine.R
// (apply_gating_strategy + compute_gate_counts). Masks are Uint8Array (1 = member).

import type { AssayData, GateAssayData } from "./gates";
import { columnsForGate, getGateMask } from "./gates";
import type { Gate, PopulationMap } from "./models";

export type MaskMap = Record<string, Uint8Array>;
export type GateMaskCache = Record<string, Uint8Array>;

function gateMaskKey(gateId: string, quadrant?: number): string {
  return quadrant === undefined ? gateId : `${gateId}::quadrant:${quadrant}`;
}

interface GateMaskMemoEntry {
  gate: Gate;
  x: ArrayLike<number> | undefined;
  y: ArrayLike<number> | undefined;
  /** One mask for a simple gate; four, in quadrant order, for a quadrant gate. */
  masks: readonly Uint8Array[];
}

/**
 * Per-gate memo for {@link computeGateMasks}, held across recomputes by the caller.
 *
 * Editing one gate used to recompute every gate's mask: one point-in-polygon test per event per
 * gate, over the whole file. In an eight-gate workspace that is eight times the necessary work on
 * every commit, and it is the hitch felt when a drag is released on a multi-million-event sample.
 *
 * Reuse is keyed on precisely the inputs the mask is computed from -- the gate object and the two
 * resolved columns, all compared by reference -- so it cannot serve a stale mask. The store
 * replaces a gate object on every geometry edit, and Sample replaces a column object whenever
 * compensation, the active assay, or a transform invalidates its caches. Anything that would
 * change the answer therefore changes a key, and anything that changes no key computes the same
 * answer, because a mask is a pure function of those inputs.
 */
export interface GateMaskMemo {
  entries: Map<string, GateMaskMemoEntry>;
}

export function createGateMaskMemo(): GateMaskMemo {
  return { entries: new Map() };
}

/**
 * Compute each gate's full-data mask once for a gating-strategy version. Population
 * selection only changes which population mask these are intersected with, so these
 * masks can be reused until a gate, transform, compensation setting, or sample changes.
 */
export function computeGateMasks(
  gates: Record<string, Gate>,
  data: AssayData | GateAssayData,
  memo?: GateMaskMemo,
): GateMaskCache {
  const masks: GateMaskCache = {};
  for (const [gateId, gate] of Object.entries(gates)) {
    const d = columnsForGate(data, gate);
    // Resolving the columns is what the mask is keyed on, and Sample caches them, so this is a
    // lookup rather than a second transform pass.
    const x = d.column(gate.x_channel);
    const y = d.column(gate.y_channel);
    const cached = memo?.entries.get(gateId);
    const reusable = cached && cached.gate === gate && cached.x === x && cached.y === y
      ? cached.masks
      : null;

    const computed = reusable ?? (gate.gate_type === "quadrant"
      ? [1, 2, 3, 4].map((quadrant) => getGateMask(gate, d, quadrant))
      : [getGateMask(gate, d)]);

    if (gate.gate_type === "quadrant") {
      for (let q = 1; q <= 4; q++) masks[gateMaskKey(gateId, q)] = computed[q - 1];
    } else {
      masks[gateMaskKey(gateId)] = computed[0];
    }
    memo?.entries.set(gateId, { gate, x, y, masks: computed });
  }
  // Forget gates that no longer exist, so a long editing session does not retain one mask per
  // deleted gate. Masks for surviving gates are the same objects this call just returned, so the
  // memo adds no retention of its own.
  if (memo) {
    for (const gateId of [...memo.entries.keys()]) {
      if (!(gateId in gates)) memo.entries.delete(gateId);
    }
  }
  return masks;
}

function countMask(m: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < m.length; i++) s += m[i];
  return s;
}

/** round(x, 2) — standard half-up rounding (counts are exact; this is display %). */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export interface GatingResult {
  masks: MaskMap;
  populations: PopulationMap;
}

/**
 * Apply the full gating strategy via BFS from the root population.
 * Mutates and returns `populations` (event_count / percent_of_parent) plus the
 * per-population event masks. `gateMasks` optionally supplies precomputed masks
 * for every gate (including each quadrant).
 */
export function applyGatingStrategy(
  gates: Record<string, Gate>,
  populations: PopulationMap,
  rootPopulationId: string,
  data: AssayData | GateAssayData,
  gateMasks?: GateMaskCache,
): GatingResult {
  const n = data.n;
  const result: MaskMap = {};

  const resolveGateMask = (gateId: string, gateDef: Gate, quadrant?: number): Uint8Array => {
    if (gateMasks) {
      const m = gateMasks[gateMaskKey(gateId, quadrant)];
      if (m && m.length === n) return m;
    }
    return getGateMask(gateDef, columnsForGate(data, gateDef), quadrant);
  };

  // Root gets all events
  const rootMask = new Uint8Array(n).fill(1);
  result[rootPopulationId] = rootMask;
  populations[rootPopulationId].event_count = n;
  populations[rootPopulationId].percent_of_parent = 100.0;
  const populationCounts: Record<string, number> = { [rootPopulationId]: n };

  // Which events each population actually holds, carried down the tree.
  //
  // A population is always a subset of its parent, so a child only has to look at the events the
  // parent kept. Walking all n events per population instead made a deep tree cost far more than
  // it holds: under a QC branch that keeps 7% of a 1.2M-event file, each leaf was testing 1.2M
  // events to decide 80k of them, once per gate reference. Indices also make the count exact
  // without a second full pass to add up a mask.
  const memberIndices: Record<string, Uint32Array> = {};
  const rootIndices = new Uint32Array(n);
  for (let i = 0; i < n; i++) rootIndices[i] = i;
  memberIndices[rootPopulationId] = rootIndices;

  const queue: string[] = [rootPopulationId];
  while (queue.length > 0) {
    const popId = queue.shift()!;
    const pop = populations[popId];
    const parentIndices = memberIndices[popId];

    for (const childId of pop.children) {
      const child = populations[childId];
      if (!child) continue;

      // Resolve each reference's mask once, dropping references to gates that no longer exist.
      // An "and" over no surviving reference is still the parent, and an "or" over none is still
      // empty, which is what the mask-at-a-time form did.
      const refs: { mask: Uint8Array; include: boolean }[] = [];
      for (const ref of child.gate_refs) {
        const gateDef = gates[ref.gate_id];
        if (!gateDef) continue;
        refs.push({
          mask: resolveGateMask(ref.gate_id, gateDef, ref.quadrant),
          include: ref.include,
        });
      }

      const childMask = new Uint8Array(n);
      const kept = new Uint32Array(parentIndices.length);
      let keptCount = 0;
      const requireAll = child.gate_refs.length === 0 || child.gate_logic !== "or";

      for (let k = 0; k < parentIndices.length; k++) {
        const i = parentIndices[k];
        // "and" starts inside and falls out on the first failing reference; "or" starts outside
        // and stops at the first satisfied one. Either way the remaining references are skipped.
        let inside = requireAll;
        for (let r = 0; r < refs.length; r++) {
          const gm = refs[r].mask;
          const bit = refs[r].include ? gm[i] : gm[i] ? 0 : 1;
          if (requireAll) {
            if (!bit) { inside = false; break; }
          } else if (bit) { inside = true; break; }
        }
        if (inside) {
          childMask[i] = 1;
          kept[keptCount++] = i;
        }
      }

      result[childId] = childMask;
      memberIndices[childId] = kept.subarray(0, keptCount);

      const childCount = keptCount;
      const parentCount = populationCounts[popId] ?? parentIndices.length;
      populationCounts[childId] = childCount;
      child.event_count = childCount;
      child.percent_of_parent = parentCount > 0 ? round2((childCount / parentCount) * 100) : 0;

      queue.push(childId);
    }
  }

  return { masks: result, populations };
}

export interface GateCount {
  event_count: number | null;
  percent_of_parent: number | null;
  quadrants?: { event_count: number; percent_of_parent: number }[];
}

/**
 * Per-gate counts within a population mask. Quadrant gates yield four counts,
 * all relative to the parent population. Ported from compute_gate_counts().
 */
export function computeGateCounts(
  gates: Record<string, Gate>,
  popMask: Uint8Array | null,
  data: AssayData | GateAssayData,
  gateMasks?: GateMaskCache,
): Record<string, GateCount> {
  const mask = popMask ?? new Uint8Array(data.n).fill(1);
  const parentCount = countMask(mask);
  const counts: Record<string, GateCount> = {};

  for (const gid of Object.keys(gates)) {
    const gate = gates[gid];
    if (gate.gate_type === "quadrant") {
      const quads = [1, 2, 3, 4].map((q) => {
        const gm = gateMasks?.[gateMaskKey(gid, q)] ?? getGateMask(gate, columnsForGate(data, gate), q);
        let nIn = 0;
        for (let i = 0; i < mask.length; i++) if (mask[i] && gm[i]) nIn++;
        return {
          event_count: nIn,
          percent_of_parent: parentCount > 0 ? round2((nIn / parentCount) * 100) : 0,
        };
      });
      counts[gid] = { event_count: null, percent_of_parent: null, quadrants: quads };
    } else {
      const gm = gateMasks?.[gateMaskKey(gid)] ?? getGateMask(gate, columnsForGate(data, gate));
      let nIn = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i] && gm[i]) nIn++;
      counts[gid] = {
        event_count: nIn,
        percent_of_parent: parentCount > 0 ? round2((nIn / parentCount) * 100) : 0,
      };
    }
  }
  return counts;
}

/**
 * Populations in display order: root first, then each node's children in their
 * persisted order. Depth is 0 at the root. Used by the tree view and tables so
 * every consumer stays in lockstep with user-controlled ordering.
 */
export function populationTreeOrder(
  populations: PopulationMap,
  rootId: string | null,
): { popId: string; depth: number; isLastPath: boolean[] }[] {
  const out: { popId: string; depth: number; isLastPath: boolean[] }[] = [];
  if (!rootId || !populations[rootId]) return out;
  const visited = new Set<string>();
  // isLastPath[i] = "the ancestor at depth i+1 is its parent's last child" — feeds the tree
  // connector glyphs (└ vs ├, │ carried down). Matches PopulationTree's own recursion exactly.
  const walk = (popId: string, depth: number, isLastPath: boolean[]) => {
    if (visited.has(popId)) return;
    visited.add(popId);
    const pop = populations[popId];
    if (!pop) return;
    out.push({ popId, depth, isLastPath });
    const childIds = [...new Set(pop.children)].filter((c) => c in populations);
    childIds.forEach((cid, i) => walk(cid, depth + 1, [...isLastPath, i === childIds.length - 1]));
  };
  walk(rootId, 0, []);
  return out;
}

/** Lowest colour slot not used by any population — a new population takes this, so it reuses a freed
 * slot rather than drifting and avoids colliding with an existing population's colour where possible. */
export function pickPopColorSlot(populations: PopulationMap): number {
  const used = new Set<number>();
  for (const p of Object.values(populations)) if (typeof p.colorSlot === "number") used.add(p.colorSlot);
  let s = 0;
  while (used.has(s)) s++;
  return s;
}

/** Backfill colorSlot on any population missing it (loaded from a pre-colorSlot workspace / GatingML),
 * assigning in tree order so the result is deterministic and matches the population tree. In place. */
export function ensurePopColorSlots(populations: PopulationMap, rootId: string | null): void {
  for (const { popId } of populationTreeOrder(populations, rootId)) {
    const p = populations[popId];
    if (p && popId !== rootId && typeof p.colorSlot !== "number") p.colorSlot = pickPopColorSlot(populations);
  }
}
