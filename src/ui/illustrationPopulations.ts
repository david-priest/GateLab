// illustrationPopulations.ts — which populations the Illustration picker offers, and
// which it preselects.
//
// The root ("All Events") is offered here, unlike in the Proportions tab and the
// colData export modal, where it is deliberately excluded because its proportion is
// always 100% and its column always true. Illustrating every event is a legitimate
// figure, and in a workspace with no gates yet it is the only thing there is to plot.

import { populationTreeOrder } from "../engine/populations";
import type { PopulationMap } from "../engine/models";

/** How many populations a fresh (preset-less) picker preselects. */
export const ILLUSTRATION_DEFAULT_POPULATION_COUNT = 4;

export interface IllustrationPickerPopulations {
  /** Every population in tree order, root first. */
  order: { popId: string; depth: number; isLastPath: boolean[] }[];
  /** Tree order minus the root. */
  gated: { popId: string; depth: number; isLastPath: boolean[] }[];
  /** Preselection for a picker with no saved config. */
  defaultSelection: string[];
}

export function illustrationPickerPopulations(
  populations: PopulationMap,
  rootId: string | null,
): IllustrationPickerPopulations {
  const order = populationTreeOrder(populations, rootId);
  const gated = order.filter(({ popId }) => popId !== rootId);
  // Prefer real populations so a gated workspace preselects exactly what it always
  // did; fall back to the root only when it is all that exists.
  const source = gated.length ? gated : order;
  return {
    order,
    gated,
    defaultSelection: source
      .slice(0, ILLUSTRATION_DEFAULT_POPULATION_COUNT)
      .map((entry) => entry.popId),
  };
}
