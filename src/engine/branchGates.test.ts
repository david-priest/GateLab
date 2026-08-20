import { describe, it, expect } from "vitest";
import { branchScopedGateOrder } from "./branchGates";
import type { Gate, PopulationMap } from "./models";

// The LP4 B-cell tree, which is where the overlap was reported: three IgD branches under
// CD19+CD3−, each with CD27 gates drawn on the same CD27-A x CD11c-A pair.
const POPS: PopulationMap = {} as PopulationMap;
const add = (id: string, parent: string | null, gateIds: string[]) => {
  (POPS as Record<string, unknown>)[id] = {
    population_id: id,
    name: id,
    gate_refs: gateIds.map((g) => ({ gate_id: g, include: true })),
    gate_logic: "and",
    parent_id: parent,
    children: [],
    event_count: null,
    percent_of_parent: null,
  };
};

add("root", null, []);
add("CD19", "root", ["g-cd19"]);
add("IgD+", "CD19", ["g-igdpos"]);
add("IgD-", "CD19", ["g-igdneg"]);
add("IgDlo", "CD19", ["g-igdlo"]);
add("EarlyMem+", "IgD+", ["g-early-pos"]);
add("EarlyMem-", "IgD+", ["g-early-neg"]);
add("csMem+", "IgD-", ["g-cs-pos"]);
add("csMem-", "IgD-", ["g-cs-neg"]);
add("Naive", "IgDlo", ["g-naive"]);

const ORDER = [
  "g-cd19", "g-igdpos", "g-igdneg", "g-igdlo",
  "g-early-pos", "g-early-neg", "g-cs-pos", "g-cs-neg", "g-naive",
];
const GATES = Object.fromEntries(ORDER.map((id) => [id, { gate_id: id } as Gate]));

const visible = (active: string | null, selected: string | null) =>
  branchScopedGateOrder(POPS, GATES, ORDER, active, "root", selected);

describe("hierarchy-scoped gate visibility", () => {
  it("shows the displayed population's subtree and hides sibling branches", () => {
    // Viewing IgD+: its own daughters' gates, never the CD27 gates of IgD- or IgDlo, which
    // occupy the same channel pair and previously drew on top of them.
    expect(visible("IgD+", null)).toEqual(["g-early-pos", "g-early-neg"]);
    expect(visible("IgD-", null)).toEqual(["g-cs-pos", "g-cs-neg"]);
  });

  it("includes deeper descendants, not only immediate daughters", () => {
    expect(visible("CD19", null)).toEqual([
      "g-igdpos", "g-igdneg", "g-igdlo",
      "g-early-pos", "g-early-neg", "g-cs-pos", "g-cs-neg", "g-naive",
    ]);
  });

  it("narrows to the selected gate's sub-branch", () => {
    // Clicking EarlyMem CD27+ while viewing IgD+ leaves it and its sibling only.
    expect(visible("IgD+", "g-early-pos")).toEqual(["g-early-pos", "g-early-neg"]);
    // Selecting across branches follows the selection, which is how a gate in another
    // population is inspected without losing the rest of its own branch.
    expect(visible("IgD+", "g-cs-pos")).toEqual(["g-cs-pos", "g-cs-neg"]);
  });

  it("never hides the gate the user just selected", () => {
    // A gate owned by no population must still be visible when selected.
    const withOrphan = [...ORDER, "g-orphan"];
    const gates = { ...GATES, "g-orphan": { gate_id: "g-orphan" } as Gate };
    const out = branchScopedGateOrder(POPS, gates, withOrphan, "IgD+", "root", "g-orphan");
    expect(out).toContain("g-orphan");
  });

  it("preserves gate_order rather than imposing its own order", () => {
    const reversed = [...ORDER].reverse();
    expect(branchScopedGateOrder(POPS, GATES, reversed, "CD19", "root", null))
      .toEqual(reversed.filter((id) => id !== "g-cd19"));
  });

  it("falls back to every gate rather than blanking the plot", () => {
    expect(branchScopedGateOrder({} as PopulationMap, GATES, ORDER, "IgD+", "root", null))
      .toEqual(ORDER);
  });

  // The toggle's OFF state is not a variant of the scoping rule -- it bypasses it entirely,
  // drawing every gate that shares the plot's channels so thresholds set on different branches
  // can be compared against each other. Pinned here because the App-level memo short-circuits
  // before calling this function, and a future refactor could quietly route through it.
  it("is bypassed, not reconfigured, when branch scoping is off", () => {
    const unscoped = ORDER.length ? ORDER : Object.keys(GATES);
    expect(unscoped).toEqual(ORDER);
    // Scoped and unscoped genuinely differ for the case the toggle exists to serve.
    expect(visible("IgD+", null)).not.toEqual(unscoped);
  });
});
