// populationChecks.ts — two checks on evaluated populations, for the UI to show where it chooses.
//
// Sibling overlap. Populations under one parent are often meant to be disjoint, and a table that
// sums them counts an event once per sibling it falls in. McNeil et al. (Cytometry A 2013;
// 83:728–738) give the case: CD4 and CD8 drawn on separate plots both hold the CD4+CD8+ cells.
// Quadrants of one gate and a population with its complement cannot overlap; two gates drawn
// separately can, and only the events say whether they do.
//
// Low event counts. A percentage from a few events is imprecise however it is computed (the ONE
// Study precision profile, Streitz et al., Transplant Res 2013;2:17). The threshold is the user's.
//
// Headless: both take the masks and counts the caller already holds and evaluate nothing.

import type { MaskMap } from "../engine/populations";
import type { PopulationMap } from "../engine/models";

export interface SiblingOverlap {
  parentId: string;
  /** The two siblings, in the parent's child order. */
  a: string;
  b: string;
  /** Events in both. */
  shared: number;
}

/**
 * Every pair of siblings that shares at least one event, with the number shared. A population
 * without a mask (not evaluated for this file) is skipped, never treated as empty.
 */
export function siblingOverlaps(populations: PopulationMap, masks: MaskMap): SiblingOverlap[] {
  const out: SiblingOverlap[] = [];
  for (const parent of Object.values(populations)) {
    const kids = parent.children.filter((id) => populations[id] && masks[id]);
    for (let i = 0; i < kids.length; i++) {
      const mi = masks[kids[i]];
      for (let j = i + 1; j < kids.length; j++) {
        const mj = masks[kids[j]];
        if (mi.length !== mj.length) continue;
        let shared = 0;
        for (let k = 0; k < mi.length; k++) if (mi[k] && mj[k]) shared++;
        if (shared > 0) out.push({ parentId: parent.population_id, a: kids[i], b: kids[j], shared });
      }
    }
  }
  return out;
}

/** The populations whose count is below `minEvents`; populations with no count are left out. */
export function belowMinEvents(counts: Record<string, number | null>, minEvents: number): string[] {
  return Object.entries(counts)
    .filter(([, n]) => n !== null && n < minEvents)
    .map(([id]) => id);
}

/**
 * The workspace's minimum event count, saved at the top level of the workspace JSON under
 * MIN_EVENTS_FIELD. Nothing in gating reads it, and a GateLab without this field ignores it, so no
 * workspace feature is declared.
 */
export const MIN_EVENTS_FIELD = "minEvents";

/** The minimum event count a workspace JSON object holds, or null when it holds no positive whole number. */
export function readMinEvents(workspace: unknown): number | null {
  if (!workspace || typeof workspace !== "object") return null;
  const v = (workspace as Record<string, unknown>)[MIN_EVENTS_FIELD];
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}
