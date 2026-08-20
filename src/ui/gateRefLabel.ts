// gateRefLabel.ts — how an excluded (NOT) gate reference reads.
//
// The pill used to prefix an excluded reference with a bare "-". That is genuinely
// ambiguous in cytometry: "CD4-" already means CD4-negative, so "-CD4" can be read as
// a marker name rather than as an exclusion. The prefix is spelled out instead.

/** Text of a gate-reference pill: gate name, NOT prefix when excluded, quadrant suffix. */
export function gateRefLabel(
  gateName: string,
  include: boolean,
  quadrant?: number,
): string {
  const base = include ? gateName : `NOT ${gateName}`;
  return quadrant === undefined ? base : `${base} [Q${quadrant}]`;
}

/** Accessible description of what an excluded reference does to membership. */
export const EXCLUDE_HINT =
  "Excluded (NOT): keeps the events OUTSIDE this gate, intersected with the rest of the population.";
