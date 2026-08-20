import { describe, it, expect } from "vitest";
import {
  newRootPopulation,
  newPopulation,
  linkChildToParent,
  type PopulationMap,
} from "../engine/models";
import { illustrationPickerPopulations } from "./illustrationPopulations";

/** Root plus `n` children of the root. */
function workspace(n: number): { populations: PopulationMap; rootId: string; childIds: string[] } {
  const root = newRootPopulation();
  let populations: PopulationMap = { [root.population_id]: root };
  const childIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const pop = newPopulation(`Pop ${i + 1}`, [], root.population_id);
    populations[pop.population_id] = pop;
    populations = linkChildToParent(populations, pop.population_id, root.population_id);
    childIds.push(pop.population_id);
  }
  return { populations, rootId: root.population_id, childIds };
}

describe("illustrationPickerPopulations", () => {
  it("offers and preselects the root when nothing has been gated yet", () => {
    // The regression: the picker excluded the root, so a workspace with no gates had
    // nothing to select and could not render an illustration at all.
    const { populations, rootId } = workspace(0);
    const { order, gated, defaultSelection } = illustrationPickerPopulations(populations, rootId);
    expect(order.map((o) => o.popId)).toEqual([rootId]);
    expect(gated).toEqual([]);
    expect(defaultSelection).toEqual([rootId]);
  });

  it("still offers the root once populations exist", () => {
    const { populations, rootId } = workspace(2);
    const { order } = illustrationPickerPopulations(populations, rootId);
    expect(order[0].popId).toBe(rootId);
    expect(order).toHaveLength(3);
  });

  it("preselects real populations, not the root, when any exist", () => {
    const { populations, rootId, childIds } = workspace(2);
    const { defaultSelection } = illustrationPickerPopulations(populations, rootId);
    expect(defaultSelection).toEqual(childIds);
    expect(defaultSelection).not.toContain(rootId);
  });

  it("preselects at most four populations", () => {
    const { populations, rootId, childIds } = workspace(7);
    const { defaultSelection } = illustrationPickerPopulations(populations, rootId);
    expect(defaultSelection).toEqual(childIds.slice(0, 4));
  });

  it("returns nothing for a workspace with no root at all", () => {
    const { defaultSelection, order } = illustrationPickerPopulations({}, null);
    expect(order).toEqual([]);
    expect(defaultSelection).toEqual([]);
  });
});
