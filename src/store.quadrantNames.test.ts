// A quadrant gate's populations take the names the caller chose, and can be renamed together
// as one undo step. Synthetic state throughout.

import { describe, it, expect } from "vitest";
import { coreReducer, initialCoreState } from "./store";
import { quadrantPopulationNames } from "./engine/quadrantNames";

function quadrantPops(state: ReturnType<typeof initialCoreState>) {
  const gate = Object.values(state.gates).find((g) => g.gate_type === "quadrant")!;
  return [1, 2, 3, 4].map((q) =>
    Object.values(state.populations).find((p) => p.gate_refs.some((r) => r.gate_id === gate.gate_id && r.quadrant === q))!,
  );
}

describe("addQuadrant names", () => {
  it("uses the four names given, in quadrant order", () => {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 6 });
    state = coreReducer(state, {
      type: "addQuadrant", xChannel: "FITC-A", yChannel: "PE-A", xLabel: "CD4", yLabel: "CD8",
      names: quadrantPopulationNames("dndp", "CD4", "CD8"),
      center: [1000, 1000], prefix: "", parentId: state.root_population_id!,
    });
    expect(quadrantPops(state).map((p) => p.name)).toEqual(["CD8 SP", "DP", "CD4 SP", "DN"]);
  });

  it("falls back to the labels and signs without names", () => {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 6 });
    state = coreReducer(state, {
      type: "addQuadrant", xChannel: "FITC-A", yChannel: "PE-A", xLabel: "CD4", yLabel: "CD8",
      center: [1000, 1000], prefix: "", parentId: state.root_population_id!,
    });
    expect(quadrantPops(state).map((p) => p.name)).toEqual(["CD4- CD8+", "CD4+ CD8+", "CD4+ CD8-", "CD4- CD8-"]);
  });
});

describe("renamePopulations", () => {
  it("renames several populations as one undo step and skips blanks, unknown ids and unchanged names", () => {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 6 });
    state = coreReducer(state, {
      type: "addQuadrant", xChannel: "FITC-A", yChannel: "PE-A", xLabel: "CD4", yLabel: "CD8",
      center: [1000, 1000], prefix: "", parentId: state.root_population_id!,
    });
    const pops = quadrantPops(state);
    const depth = state.undo.length;
    const next = coreReducer(state, {
      type: "renamePopulations",
      names: { [pops[0].population_id]: "CD8 SP", [pops[1].population_id]: "  DP ", [pops[2].population_id]: "", nope: "x", [pops[3].population_id]: pops[3].name },
    });
    expect(quadrantPops(next).map((p) => p.name)).toEqual(["CD8 SP", "DP", "CD4+ CD8-", "CD4- CD8-"]);
    expect(next.undo).toHaveLength(depth + 1);
    const undone = coreReducer(next, { type: "undo" });
    expect(quadrantPops(undone).map((p) => p.name)).toEqual(pops.map((p) => p.name));
  });

  it("is a no-op, and not an undo step, when nothing changes", () => {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 6 });
    state = coreReducer(state, {
      type: "addQuadrant", xChannel: "FITC-A", yChannel: "PE-A", center: [1000, 1000], prefix: "", parentId: state.root_population_id!,
    });
    const pop = quadrantPops(state)[0];
    expect(coreReducer(state, { type: "renamePopulations", names: { [pop.population_id]: pop.name, missing: "y" } })).toBe(state);
  });
});
