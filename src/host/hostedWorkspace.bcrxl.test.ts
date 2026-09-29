// A hosted workspace whose gates were saved in another space than the SCE gates in: every
// hierarchy's own gate table moves into the SCE's space, not the live one alone. Each hierarchy owns
// its gates, so a parked tree left behind would be gated at raw values read as display coordinates.
// Public BCR-XL (CyTOF, gated in display space) with the public example tree.

import { beforeAll, describe, expect, it } from "vitest";
import { cloneHierarchyTree } from "../engine/hierarchies";
import type { Gate } from "../engine/models";
import type { Sample } from "../engine/sample";
import type { WorkspaceFileV3 } from "../engine/workspaceV3";
import { recomputeGating, type CoreState } from "../store";
import { bcrxlAvailable, bcrxlHost, bcrxlSce, bcrxlTree, type BcrxlTree } from "./bcrxlSceFixture";
import { loadHostedDataset } from "./hostedSample";
import { convertHostedGateSpace } from "./hostedWorkspace";

/** Every rectangle and polygon of a gate table with its vertices moved by `f`, per axis. */
function mapVertices(gates: Record<string, Gate>, f: (channel: string, value: number) => number): Record<string, Gate> {
  return Object.fromEntries(Object.entries(gates).map(([id, gate]) => {
    if (gate.gate_type !== "rectangle" && gate.gate_type !== "polygon") throw new Error(`unexpected ${gate.gate_type}`);
    return [id, { ...gate, vertices: gate.vertices.map(([x, y]) => [f(gate.x_channel, x), f(gate.y_channel, y)]) }];
  }));
}

const counts = (sample: Sample, tree: Pick<BcrxlTree, "gates" | "populations" | "root_population_id">) => {
  const gating = recomputeGating(sample, { ...tree, gate_order: Object.keys(tree.gates) } as unknown as CoreState);
  return Object.fromEntries(Object.entries(tree.populations).map(([id, p]) => [p.name, gating.stats.event_count[id]]));
};

describe.runIf(bcrxlAvailable())("convertHostedGateSpace and stored hierarchies (public BCR-XL)", () => {
  let sample: Sample;
  let main: BcrxlTree;
  beforeAll(async () => {
    const sce = bcrxlSce();
    sample = (await loadHostedDataset(bcrxlHost(sce).host.datasets!, sce.dataset))[1].sample;
    main = bcrxlTree();
  });

  it("converts the gates of every stored hierarchy as well as the live table", () => {
    expect(sample.gatingSpace).toBe("display");
    // A parked copy of the tree, with its own gates, and the whole workspace written in raw space.
    const clone = cloneHierarchyTree(main.populations, main.root_population_id, main.gates, main.gate_order);
    const toRaw = (channel: string, value: number) => sample.displayToRaw(channel, value);
    const workspace = {
      version: 3,
      gating: {
        gates: mapVertices(main.gates, toRaw), gate_order: main.gate_order, populations: main.populations,
        root_population_id: main.root_population_id, active_population_id: null, selected_gate_id: null,
        hierarchies: [{ id: "main", name: "Main" }, { id: "copy", name: "Copy", owner_sample_id: "sample-1", source_hierarchy_id: "main" }],
        active_hierarchy_id: "main",
        stored_hierarchies: [{
          id: "copy", name: "Copy", owner_sample_id: "sample-1", source_hierarchy_id: "main",
          gates: mapVertices(clone.gates, toRaw), gate_order: clone.gate_order, populations: clone.populations,
          root_population_id: clone.root_population_id, active_population_id: null,
        }],
      },
    } as unknown as WorkspaceFileV3;

    const converted = convertHostedGateSpace(workspace, sample, "raw");
    const stored = converted.gating.stored_hierarchies![0];
    // Back in display space, both tables: the public coordinates within float rounding.
    for (const [table, original] of [[converted.gating.gates, main.gates], [stored.gates!, clone.gates]] as const) {
      for (const [id, gate] of Object.entries(table)) {
        const expected = original[id];
        if (gate.gate_type !== "rectangle" || expected.gate_type !== "rectangle") throw new Error("expected rectangles");
        gate.vertices.forEach(([x, y], k) => {
          expect(x).toBeCloseTo(expected.vertices[k][0], 4);
          expect(y).toBeCloseTo(expected.vertices[k][1], 4);
        });
      }
    }
    // And the parked copy gates this file exactly as the tree does: the public example's counts.
    const own = counts(sample, { gates: stored.gates!, populations: stored.populations, root_population_id: stored.root_population_id! });
    expect(own).toEqual(counts(sample, main));
    expect(own).toMatchObject({ "B cells": 130, "T cells": 1995, "IgM+ B cells": 97, "CD8 T cells": 1258 });
  });

  it("leaves a stored hierarchy without its own gates on the shared table", () => {
    const workspace = {
      version: 3,
      gating: {
        gates: main.gates, gate_order: main.gate_order, populations: main.populations,
        root_population_id: main.root_population_id, active_population_id: null, selected_gate_id: null,
        hierarchies: [{ id: "main", name: "Main" }, { id: "old", name: "Old" }],
        active_hierarchy_id: "main",
        stored_hierarchies: [{ id: "old", name: "Old", populations: main.populations, root_population_id: main.root_population_id, active_population_id: null }],
      },
    } as unknown as WorkspaceFileV3;
    const converted = convertHostedGateSpace(workspace, sample, "raw");
    expect(converted.gating.stored_hierarchies![0].gates).toBeUndefined();
    expect(converted.gating.gates).not.toBe(main.gates);
  });
});
