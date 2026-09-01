import type { Gate, PopulationMap } from "./models";

/**
 * Which gates belong on the current plot, by hierarchy rather than by channel pair alone.
 *
 * Gates are matched to a plot by their two channels, so every gate drawn on the same pair
 * anywhere in the tree draws on top of the others: a CD27 x CD11c plot of one IgD branch also
 * draws the CD27 gates of its sibling branches, which overlap and cannot be told apart.
 *
 * Default: the displayed population's own subtree — the gates drawn on it, and those drawn on
 * its descendants. Sibling branches are hidden because their gates were never drawn on these
 * events.
 *
 * Selecting a gate narrows further to that gate's own sub-branch: the gates sharing its parent
 * population. Clicking EarlyMem CD27+ while viewing CD45RB+IgD+ leaves EarlyMem CD27+ and
 * EarlyMem CD27− and hides the rest, so an overlapping pair can be read one branch at a time.
 *
 * The selected gate is always kept, so selecting a gate from the Gates list can never hide the
 * very gate being selected. If filtering yields nothing — a gate owned by no population, or a
 * tree that produced no match — the unfiltered order is returned rather than a blank plot.
 *
 * A gate owned by no population belongs to no branch, so branch structure says nothing about
 * whether it should be drawn — hiding it is a side effect of the filter, not a judgement.
 * `showUnowned` keeps such gates visible regardless of the branch: without it a freshly drawn
 * gate that skipped population creation vanishes the moment anything else is selected.
 */
export function branchScopedGateOrder(
  populations: PopulationMap,
  gates: Record<string, Gate>,
  gateOrder: string[],
  activePopulationId: string | null,
  rootPopulationId: string | null,
  selectedGateId: string | null,
  showUnowned = false,
): string[] {
  const gateOwner = new Map<string, string>(); // gate id → population that defines it
  for (const pop of Object.values(populations)) {
    for (const ref of pop.gate_refs) gateOwner.set(ref.gate_id, pop.population_id);
  }

  const visible = new Set<string>();
  const selectedOwner = selectedGateId ? gateOwner.get(selectedGateId) : undefined;

  if (selectedOwner) {
    const branchParent = populations[selectedOwner]?.parent_id ?? null;
    for (const pop of Object.values(populations)) {
      if (pop.parent_id !== branchParent) continue;
      for (const ref of pop.gate_refs) visible.add(ref.gate_id);
    }
  } else {
    const stack: Array<string | null> = [activePopulationId ?? rootPopulationId];
    const seen = new Set<string | null>();
    while (stack.length) {
      const id = stack.pop() ?? null;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const pop of Object.values(populations)) {
        if (pop.parent_id !== id) continue;
        for (const ref of pop.gate_refs) visible.add(ref.gate_id);
        stack.push(pop.population_id);
      }
    }
  }
  if (selectedGateId) visible.add(selectedGateId);
  if (showUnowned) {
    for (const id of Object.keys(gates)) if (!gateOwner.has(id)) visible.add(id);
  }

  const ids = gateOrder.length ? gateOrder : Object.keys(gates);
  const filtered = ids.filter((id) => visible.has(id));
  return filtered.length ? filtered : ids;
}
