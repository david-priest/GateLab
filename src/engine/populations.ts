// populations.ts — apply the gating strategy across the population tree (BFS) and
// compute per-gate counts within a population. Ported from GateLabR gate_engine.R
// (apply_gating_strategy + compute_gate_counts). Masks are Uint8Array (1 = member).

import type { AssayData } from "./gates";
import { getGateMask } from "./gates";
import type { Gate, PopulationMap } from "./models";

export type MaskMap = Record<string, Uint8Array>;
export type GateMaskCache = Record<string, Uint8Array>;

function gateMaskKey(gateId: string, quadrant?: number): string {
  return quadrant === undefined ? gateId : `${gateId}::quadrant:${quadrant}`;
}

/**
 * Compute each gate's full-data mask once for a gating-strategy version. Population
 * selection only changes which population mask these are intersected with, so these
 * masks can be reused until a gate, transform, compensation setting, or sample changes.
 */
export function computeGateMasks(
  gates: Record<string, Gate>,
  data: AssayData,
): GateMaskCache {
  const masks: GateMaskCache = {};
  for (const [gateId, gate] of Object.entries(gates)) {
    if (gate.gate_type === "quadrant") {
      for (let q = 1; q <= 4; q++) masks[gateMaskKey(gateId, q)] = getGateMask(gate, data, q);
    } else {
      masks[gateMaskKey(gateId)] = getGateMask(gate, data);
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
  data: AssayData,
  gateMasks?: GateMaskCache,
): GatingResult {
  const n = data.n;
  const result: MaskMap = {};

  const resolveGateMask = (gateId: string, gateDef: Gate, quadrant?: number): Uint8Array => {
    if (gateMasks) {
      const m = gateMasks[gateMaskKey(gateId, quadrant)];
      if (m && m.length === n) return m;
    }
    return getGateMask(gateDef, data, quadrant);
  };

  // Root gets all events
  const rootMask = new Uint8Array(n).fill(1);
  result[rootPopulationId] = rootMask;
  populations[rootPopulationId].event_count = n;
  populations[rootPopulationId].percent_of_parent = 100.0;
  const populationCounts: Record<string, number> = { [rootPopulationId]: n };

  const queue: string[] = [rootPopulationId];
  while (queue.length > 0) {
    const popId = queue.shift()!;
    const pop = populations[popId];
    const parentMask = result[popId];

    for (const childId of pop.children) {
      const child = populations[childId];
      if (!child) continue;

      let childMask: Uint8Array;
      if (child.gate_refs.length > 0) {
        if (child.gate_logic === "or") {
          const orMask = new Uint8Array(n);
          for (const ref of child.gate_refs) {
            const gateDef = gates[ref.gate_id];
            if (!gateDef) continue;
            const gm = resolveGateMask(ref.gate_id, gateDef, ref.quadrant);
            for (let i = 0; i < n; i++) {
              const bit = ref.include ? gm[i] : gm[i] ? 0 : 1;
              orMask[i] = orMask[i] | bit;
            }
          }
          childMask = new Uint8Array(n);
          for (let i = 0; i < n; i++) childMask[i] = parentMask[i] & orMask[i];
        } else {
          // AND (default)
          childMask = new Uint8Array(parentMask); // copy
          for (const ref of child.gate_refs) {
            const gateDef = gates[ref.gate_id];
            if (!gateDef) continue;
            const gm = resolveGateMask(ref.gate_id, gateDef, ref.quadrant);
            for (let i = 0; i < n; i++) {
              const bit = ref.include ? gm[i] : gm[i] ? 0 : 1;
              childMask[i] = childMask[i] & bit;
            }
          }
        }
      } else {
        // No gate refs: inherit parent events
        childMask = new Uint8Array(parentMask);
      }

      result[childId] = childMask;

      const childCount = countMask(childMask);
      const parentCount = populationCounts[popId] ?? countMask(parentMask);
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
  data: AssayData,
  gateMasks?: GateMaskCache,
): Record<string, GateCount> {
  const mask = popMask ?? new Uint8Array(data.n).fill(1);
  const parentCount = countMask(mask);
  const counts: Record<string, GateCount> = {};

  for (const gid of Object.keys(gates)) {
    const gate = gates[gid];
    if (gate.gate_type === "quadrant") {
      const quads = [1, 2, 3, 4].map((q) => {
        const gm = gateMasks?.[gateMaskKey(gid, q)] ?? getGateMask(gate, data, q);
        let nIn = 0;
        for (let i = 0; i < mask.length; i++) if (mask[i] && gm[i]) nIn++;
        return {
          event_count: nIn,
          percent_of_parent: parentCount > 0 ? round2((nIn / parentCount) * 100) : 0,
        };
      });
      counts[gid] = { event_count: null, percent_of_parent: null, quadrants: quads };
    } else {
      const gm = gateMasks?.[gateMaskKey(gid)] ?? getGateMask(gate, data);
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
 * Populations in display order: root first, then each node's children sorted
 * case-insensitively by name (ties broken by id) — the exact order GateLabR's
 * population tree uses (app.R:5734-5737). Depth is 0 at the root. Used by the
 * tree view and the Statistics table so they stay in lockstep.
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
    let childIds = [...new Set(pop.children)].filter((c) => c in populations);
    if (childIds.length > 1) {
      childIds = childIds.sort((a, b) => {
        const na = (populations[a].name || a).toLowerCase();
        const nb = (populations[b].name || b).toLowerCase();
        return na < nb ? -1 : na > nb ? 1 : a < b ? -1 : a > b ? 1 : 0;
      });
    }
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
