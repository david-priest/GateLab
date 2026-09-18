import type { StoredHierarchy } from "./hierarchies";
import { isFigureSpec } from "./figureSchema";
import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState } from "../store";
import { newPopulation, newRootPopulation, newGate } from "./models";
import { cloneHierarchyTree, storeHierarchy } from "./hierarchies";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import {
  buildFigurePanel,
  captureFigureTransforms,
  figureDisplaySample,
  figureHierarchies,
  figureRanges,
  layoutFigure,
  migrateFigure,
  canonicalGateId,
  withFigureLabelOffsets,
  prepareFigureSource,
  resolveFigurePopulation,
  resolvePopulationInTree,
  type FigureSample,
  type FigureSpec,
} from "./figure";
import { defaultIllustrationConfig, figureStyle } from "./figureDefaults";

export function figureFixture() {
  const state = initialCoreState();
  const root = newRootPopulation();
  const gate = newGate("CD4_positive", "rectangle", "FSC-A", "SSC-A", [
    [0, 0],
    [150, 150],
  ]);
  const pop = newPopulation("Singlets", [], root.population_id);
  pop.gate_refs = [{ gate_id: gate.gate_id, include: true }];
  root.children = [pop.population_id];
  Object.assign(state, {
    gates: { [gate.gate_id]: gate },
    gate_order: [gate.gate_id],
    populations: { [root.population_id]: root, [pop.population_id]: pop },
    root_population_id: root.population_id,
    active_population_id: pop.population_id,
  });
  const copy = cloneHierarchyTree(
    state.populations,
    root.population_id,
    state.gates,
    state.gate_order,
  );
  const leaf = {
    ...storeHierarchy({ id: "leaf", name: "D2 copy" }, { ...state, ...copy }),
    source_hierarchy_id: "main",
    source_population_ids: Object.fromEntries(
      Object.entries(copy.idMap).map(([a, b]) => [b, a]),
    ),
    source_gate_ids: Object.fromEntries(
      Object.entries(copy.gateIdMap).map(([a, b]) => [b, a]),
    ),
    owner_sample_id: "D2",
    structure_locked: true,
  };
  state.hierarchies.push(leaf);
  state.stored_hierarchies.leaf = leaf;
  const samples: FigureSample[] = [1, 2].map((i) => {
    const fcs: FcsFile = {
      version: "FCS3.1",
      nEvents: 3,
      instrument: "flow",
      keywords: {},
      spillover: null,
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [
        Float32Array.from([10, 100, 200].map((x) => x * i)),
        Float32Array.from([10, 100, 200]),
      ],
    };
    return {
      id: `D${i}`,
      name: `D${i}.fcs`,
      sample: new Sample(fcs),
      hierarchyId: i === 1 ? "main" : "leaf",
      metadata: { condition: i === 1 ? "control" : "treated" },
    };
  });
  const trees = figureHierarchies(state);
  const figure = migrateFigure(null, samples, trees, "main", "FSC-A", "SSC-A");
  return { state, root, pop, gate, leaf, copy, samples, trees, figure };
}

describe("population metadata groupings", () => {
  it("groups populations by a field of the population table, trimming the panels outside each group", () => {
    const f = figureFixture();
    f.figure.populations = [
      { hierarchyId: "main", populationId: f.root.population_id, label: "All Events" },
      { hierarchyId: "main", populationId: f.pop.population_id, label: "Singlets" },
    ];
    f.figure.rows = ["popmeta:kind", "populations"];
    f.figure.columns = ["samples", "plots"];
    f.figure.pages = [];
    const table = { [f.root.population_id]: { kind: "everything" }, [f.pop.population_id]: { kind: "gated" } };
    const page = layoutFigure(f.figure, f.samples, f.trees, table)[0];
    expect(page.rows.map((row) => row.map((v) => v.label))).toEqual([["everything", "All Events"], ["gated", "Singlets"]]);
    expect(page.panels).toHaveLength(4);
    expect(page.panels.every((p) => p.samples.length === 1)).toBe(true);
    expect(page.panels.filter((p) => p.row === 0).every((p) => p.population.label === "All Events")).toBe(true);
    // Without the table every population is "Unassigned", one group, and the figure lays out as ungrouped.
    const bare = layoutFigure(f.figure, f.samples, f.trees)[0];
    expect(bare.rows.map((row) => row.map((v) => v.label))).toEqual([["Unassigned", "All Events"], ["Unassigned", "Singlets"]]);
    expect(isFigureSpec(f.figure)).toBe(true);
  });
});

describe("independent figures", () => {
  it("scopes populations to their assigned hierarchy group without matching duplicate names", () => {
    const f = figureFixture();
    const copy = cloneHierarchyTree(
      f.state.populations,
      f.root.population_id,
      f.state.gates,
      f.state.gate_order,
    );
    f.trees.other = storeHierarchy(
      { id: "other", name: "Other template" },
      { ...f.state, ...copy },
    );
    f.figure.populations = [
      {
        hierarchyId: "main",
        populationId: f.pop.population_id,
        label: "Singlets",
      },
      {
        hierarchyId: "other",
        populationId: copy.idMap[f.pop.population_id],
        label: "Singlets",
      },
    ];
    f.figure.rows = [];
    f.figure.columns = ["samples", "populations", "plots"];
    const page = layoutFigure(f.figure, f.samples, f.trees)[0];
    expect(page.panels).toHaveLength(2);
    expect(page.panels.flatMap((p) => p.samples)).toEqual(["D1", "D2"]);
    expect(page.panels.every((p) => p.population.hierarchyId === "main")).toBe(
      true,
    );
    const sources = f.samples.map((s) =>
      prepareFigureSource(s, f.trees[s.hierarchyId], f.state),
    );
    expect(
      page.panels
        .map((p) =>
          buildFigurePanel(
            p,
            f.figure,
            sources,
            f.trees,
            figureStyle(defaultIllustrationConfig()),
            {},
          ),
        )
        .every((p) => p.config && !p.problem),
    ).toBe(true);

    // A real deletion within a file's assigned family must still produce a visible error.
    delete f.trees.leaf.populations[f.copy.idMap[f.pop.population_id]];
    const broken = layoutFigure(f.figure, f.samples, f.trees)[0];
    expect(broken.panels).toHaveLength(2);
    const data = buildFigurePanel(
      broken.panels[1],
      f.figure,
      sources,
      f.trees,
      figureStyle(defaultIllustrationConfig()),
      {},
    );
    expect(data.problem).toContain("population missing");
  });

  it("retains valid zero-event panels and full-data export bypasses the preview cap", () => {
    const f = figureFixture();
    const gate = f.gate;
    if (gate.gate_type !== "rectangle") throw new Error("fixture");
    gate.vertices = [
      [900, 900],
      [1000, 1000],
    ];
    const trees = figureHierarchies(f.state),
      source = prepareFigureSource(f.samples[0], trees.main, f.state);
    const panel = layoutFigure(f.figure, f.samples)[0].panels[0];
    const empty = buildFigurePanel(
      panel,
      f.figure,
      [source],
      trees,
      figureStyle(defaultIllustrationConfig()),
      {},
    );
    expect(empty.problem).toBeUndefined();
    expect(empty.config?.n_events).toBe(0);
    expect(empty.config?.x).toEqual([]);
    const rootPanel = {
      ...panel,
      population: {
        hierarchyId: "main",
        populationId: f.root.population_id,
        label: "All Events",
      },
    };
    const options = {
      ...figureStyle(defaultIllustrationConfig()),
      maxEvents: Infinity,
    };
    expect(
      (
        buildFigurePanel(
          rootPanel,
          f.figure,
          [source],
          trees,
          { ...options, maxEvents: 1 },
          {},
        ).config?.x as number[]
      ).length,
    ).toBe(1);
    expect(
      (
        buildFigurePanel(
          rootPanel,
          f.figure,
          [source],
          trees,
          options,
          {},
          true,
        ).config?.x as number[]
      ).length,
    ).toBe(3);
  });
  it("checks ancestor boundaries and distinguishes a changed gate kind from tailoring", () => {
    const f = figureFixture(),
      child = newPopulation("CD4_positive", [], f.pop.population_id);
    f.trees.main.populations[child.population_id] = child;
    const local = newPopulation(
      child.name,
      [],
      f.copy.idMap[f.pop.population_id],
    );
    f.leaf.populations[local.population_id] = local;
    f.leaf.source_population_ids[local.population_id] = child.population_id;
    const ref = {
      hierarchyId: "main",
      populationId: child.population_id,
      label: child.name,
    };
    const gate = f.leaf.gates[f.copy.gateIdMap[f.gate.gate_id]];
    if (gate.gate_type !== "rectangle") throw new Error("fixture");
    gate.vertices = [
      [0, 0],
      [300, 300],
    ];
    expect(resolveFigurePopulation(ref, f.leaf, f.trees).status).toBe(
      "tailored",
    );
    gate.gate_type = "polygon";
    expect(resolveFigurePopulation(ref, f.leaf, f.trees).status).toBe(
      "changed",
    );
  });
  it("keeps quadrant overlays with their complete percentages", () => {
    const f = figureFixture();
    const quadrant = {
      gate_id: "quadrant",
      name: "Quadrants",
      gate_type: "quadrant" as const,
      x_channel: "FSC-A",
      y_channel: "SSC-A",
      center: [75, 75] as [number, number],
      space: "raw" as const,
      color: "#2671c6",
      label_offset: null,
    };
    f.state.gates.quadrant = quadrant;
    f.state.gate_order.push("quadrant");
    const trees = figureHierarchies(f.state),
      source = prepareFigureSource(f.samples[0], trees.main, f.state);
    const panel = layoutFigure(f.figure, f.samples)[0].panels[0];
    const data = buildFigurePanel(
      panel,
      f.figure,
      [source],
      trees,
      figureStyle(defaultIllustrationConfig()),
      {},
    );
    expect(
      (data.config?.gates as { gate_type: string }[]).some(
        (gate) => gate.gate_type === "quadrant",
      ),
    ).toBe(true);
  });
  it("resolves a Layout plot's population into the file's tree by provenance, then by unique name", () => {
    const f = figureFixture();
    const leafId = Object.entries(f.leaf.source_population_ids).find(([, source]) => source === f.pop.population_id)![0];
    const main = f.trees.main;
    // Present as named; a main id followed into the copy and a copy id back into main; unknown stays missing.
    expect(resolvePopulationInTree(f.pop.population_id, main, f.trees)).toEqual({ id: f.pop.population_id, missing: false });
    expect(resolvePopulationInTree(f.pop.population_id, f.leaf, f.trees)).toEqual({ id: leafId, missing: false });
    expect(resolvePopulationInTree(leafId, main, f.trees)).toEqual({ id: f.pop.population_id, missing: false });
    expect(resolvePopulationInTree("nowhere", f.leaf, f.trees)).toEqual({ id: "nowhere", missing: true });
    // A tree of no shared lineage with one population of the same name matches by name.
    const stranger = cloneHierarchyTree(f.state.populations, f.root.population_id, f.state.gates, f.state.gate_order);
    const other = storeHierarchy({ id: "other", name: "Other" }, { ...f.state, ...stranger });
    const trees = { ...f.trees, other };
    const otherSinglets = Object.values(other.populations).find((pop) => pop.name === "Singlets")!.population_id;
    expect(resolvePopulationInTree(f.pop.population_id, other, trees)).toEqual({ id: otherSinglets, missing: false });
  });

  it("maps a persisted leaf UUID back to a shared lineage without matching names", () => {
    const f = figureFixture();
    const cfg = {
      ...defaultIllustrationConfig(),
      popIds: [f.copy.idMap[f.pop.population_id]],
      xChannels: ["FSC-A"],
      yChannel: "SSC-A",
    };
    const migrated = migrateFigure(
      cfg,
      f.samples,
      f.trees,
      "main",
      "FSC-A",
      "SSC-A",
    );
    expect(migrated.populations[0].populationId).toBe(f.pop.population_id);
    expect(
      resolveFigurePopulation(migrated.populations[0], f.leaf, f.trees),
    ).toMatchObject({ id: f.copy.idMap[f.pop.population_id] });
    const missing = migrateFigure(
      { ...cfg, popIds: ["deleted"] },
      f.samples,
      f.trees,
      "main",
      "FSC-A",
      "SSC-A",
    );
    expect(missing.populations[0].label).toBe("Unavailable saved population");
    expect(
      resolveFigurePopulation(missing.populations[0], f.leaf, f.trees).status,
    ).toBe("missing");
  });

  it("keeps a figure's label offsets under the gate id its copies descend from", () => {
    const trees = {
      main: { id: "main", gates: { g1: {} }, source_hierarchy_id: undefined, source_gate_ids: {} },
      copy: { id: "copy", gates: { c1: {} }, source_hierarchy_id: "main", source_gate_ids: { c1: "g1" } },
      grand: { id: "grand", gates: { d1: {} }, source_hierarchy_id: "copy", source_gate_ids: { d1: "c1" } },
    } as unknown as Record<string, StoredHierarchy>;
    expect(canonicalGateId("d1", trees.grand, trees)).toBe("g1");
    expect(canonicalGateId("c1", trees.copy, trees)).toBe("g1");
    expect(canonicalGateId("g1", trees.main, trees)).toBe("g1");
    const gates = [{ gate_id: "d1", label_offset: [0, 1] }, { gate_id: "other", label_offset: [2, 2] }];
    const placed = withFigureLabelOffsets(gates, { labelOffsets: { g1: [5, 6] } }, trees.grand, trees);
    expect(placed[0].label_offset).toEqual([5, 6]);
    expect(placed[1].label_offset).toEqual([2, 2]);
    expect(withFigureLabelOffsets(gates, {}, trees.grand, trees)[0].label_offset).toEqual([0, 1]);
  });

  it("loads a saved figure's default \"shared\" axes as \"gating\" unless the policy was chosen", () => {
    const f = figureFixture();
    const base = migrateFigure(null, f.samples, f.trees, "main", "FSC-A", "SSC-A");
    const load = (patch: Partial<typeof base>) =>
      migrateFigure({ ...defaultIllustrationConfig(), figure: { ...base, ...patch } }, f.samples, f.trees, "main", "FSC-A", "SSC-A");
    expect(load({ scalePolicy: "shared" }).scalePolicy).toBe("gating");
    expect(load({ scalePolicy: "shared", scalePolicyChosen: true }).scalePolicy).toBe("shared");
    expect(load({ scalePolicy: "individual" }).scalePolicy).toBe("individual");
    expect(load({ scalePolicy: "gating" }).scalePolicy).toBe("gating");
  });
  it("distinguishes tailored geometry, structural drift, deletion and unrelated same-name populations", () => {
    const f = figureFixture(),
      ref = f.figure.populations[0];
    const gate = f.leaf.gates[f.copy.gateIdMap[f.gate.gate_id]];
    if (gate.gate_type !== "rectangle") throw new Error("fixture");
    gate.vertices = [
      [0, 0],
      [300, 300],
    ];
    expect(resolveFigurePopulation(ref, f.leaf, f.trees).status).toBe(
      "tailored",
    );
    f.leaf.populations[f.copy.idMap[f.pop.population_id]].gate_refs = [];
    expect(resolveFigurePopulation(ref, f.leaf, f.trees).status).toBe(
      "changed",
    );
    delete f.leaf.populations[f.copy.idMap[f.pop.population_id]];
    const replacement = newPopulation(
      "Singlets",
      [],
      f.leaf.root_population_id,
    );
    f.leaf.populations[replacement.population_id] = replacement;
    expect(resolveFigurePopulation(ref, f.leaf, f.trees).status).toBe(
      "missing",
    );
  });
  it("builds every file with its own gates and counts", () => {
    const f = figureFixture();
    const gate = f.leaf.gates[f.copy.gateIdMap[f.gate.gate_id]];
    if (gate.gate_type !== "rectangle") throw new Error("fixture");
    gate.vertices = [
      [0, 0],
      [500, 500],
    ];
    const sources = f.samples
      .map((s) => prepareFigureSource(s, f.trees[s.hierarchyId], f.state))
      .map((s) => ({
        ...s,
        sample: figureDisplaySample(s.sample, f.figure.transforms),
      }));
    const page = layoutFigure(f.figure, f.samples)[0],
      ranges = figureRanges(sources, f.figure);
    const panels = page.panels.map((p) =>
      buildFigurePanel(
        p,
        f.figure,
        sources,
        f.trees,
        figureStyle(defaultIllustrationConfig()),
        ranges,
      ),
    );
    expect(panels.map((p) => p.config?.n_events)).toEqual([2, 3]);
    expect(panels[0].config?.x_range).toEqual(panels[1].config?.x_range);
    const switched = coreReducer(f.state, {
      type: "switchHierarchy",
      id: "leaf",
    });
    expect(
      migrateFigure(
        { ...defaultIllustrationConfig(), figure: f.figure },
        f.samples,
        figureHierarchies(switched),
        "leaf",
        "SSC-A",
        "FSC-A",
      ),
    ).toEqual(f.figure);
  });
  it("keeps the figure transform fixed without mutating the sample", () => {
    const f = figureFixture(),
      s = f.samples[0].sample;
    const spec = s.transformSpec("FSC-A");
    const linear = figureDisplaySample(s, { "FSC-A": { kind: "identity" } });
    expect([...linear.displayColumn(0)]).toEqual([10, 100, 200]);
    expect(s.transformSpec("FSC-A")).toEqual(spec);
    const captured = captureFigureTransforms(
      { ...f.figure, transforms: { "FSC-A": { kind: "identity" } } },
      f.samples,
    );
    expect(captured.transforms["FSC-A"]).toEqual({ kind: "identity" });
  });
  it("supports transpose, metadata pages and distinct overlays versus pooling", () => {
    const f = figureFixture();
    const figure: FigureSpec = { ...f.figure, pages: ["metadata:condition"] };
    const pages = layoutFigure(figure, f.samples);
    expect(pages.map((p) => p.label)).toEqual(["control", "treated"]);
    expect(pages[0].panels).toHaveLength(1);
    expect(pages[0].panels[0].samples).toEqual(["D1"]);
    const transposed = layoutFigure(
      { ...f.figure, rows: ["samples"], columns: ["populations", "plots"] },
      f.samples,
    )[0];
    expect(transposed.rows).toHaveLength(2);
    const sources = f.samples.map((s) =>
      prepareFigureSource(s, f.trees[s.hierarchyId], f.state),
    );
    const overlay = { ...f.figure, composition: "overlay" as const };
    const panel = layoutFigure(overlay, f.samples)[0].panels[0];
    const data = buildFigurePanel(
      panel,
      overlay,
      sources,
      f.trees,
      figureStyle(defaultIllustrationConfig()),
      {},
    );
    expect(data.config?.overlay_traces).toHaveLength(1);
    expect(data.config?.gates).toEqual([]);
    const pooled = buildFigurePanel(
      panel,
      { ...overlay, composition: "pool" },
      sources,
      f.trees,
      figureStyle(defaultIllustrationConfig()),
      {},
    );
    expect(pooled.config?.overlay_traces).toEqual([]);
    expect(pooled.config?.x).toHaveLength(3);
    expect(pooled.config?.n_events).toBe(3);
  });
});
