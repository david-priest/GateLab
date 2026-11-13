// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { initialCoreState } from "../store";
import { populationBranchGateOrder } from "../engine/branchGates";
import { buildFigurePanel, figureHierarchies, layoutFigure, migrateFigure, prepareFigureSource, type FigureSample } from "../engine/figure";
import { defaultIllustrationConfig, figureStyle } from "../engine/figureDefaults";
import { buildIllustrationPayload, type GateOverlay } from "../engine/illustration";
import { newGate, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import { loadMiniPlots } from "./loadPlots";

beforeEach(() => {
  document.body.innerHTML = '<div id="plot"></div>';
  const noop = new Proxy({}, { get: (_target, key) => key === "measureText" ? () => ({ width: 0 }) : () => undefined, set: () => true });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => noop });
});

function fixture() {
  const state = initialCoreState();
  const root = newRootPopulation();
  const rectangle = newGate("Rectangle", "rectangle", "FSC-A", "SSC-A", [[0, 0], [2, 2]]);
  const triangle = newGate("Triangle", "polygon", "FSC-A", "SSC-A", [[2, 2], [5, 2], [5, 5]]);
  const quadrant = { gate_id: "quadrant", name: "Quadrant", gate_type: "quadrant" as const, x_channel: "FSC-A", y_channel: "SSC-A", center: [1, 1] as [number, number], color: "#123456", label_offset: null };
  const leaf = newPopulation("CD4_positive", [{ gate_id: rectangle.gate_id, include: true }], root.population_id);
  const sibling = newPopulation("Sibling", [{ gate_id: triangle.gate_id, include: true }, { gate_id: quadrant.gate_id, include: true, quadrant: 2 }], root.population_id);
  root.children = [leaf.population_id, sibling.population_id];
  Object.assign(state, {
    gates: { [rectangle.gate_id]: rectangle, [triangle.gate_id]: triangle, [quadrant.gate_id]: quadrant },
    gate_order: [rectangle.gate_id, triangle.gate_id, quadrant.gate_id],
    populations: { [root.population_id]: root, [leaf.population_id]: leaf, [sibling.population_id]: sibling },
    root_population_id: root.population_id,
    active_population_id: leaf.population_id,
  });
  const sample = new Sample({
    version: "FCS3.1", instrument: "flow", nEvents: 4, keywords: {}, spillover: null,
    channels: ["FSC-A", "SSC-A"].map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: [Float32Array.from([0.5, 1.5, 3, 4]), Float32Array.from([0.5, 1.5, 3, 1])],
  });
  const samples: FigureSample[] = [{ id: "D1", name: "D1.fcs", hierarchyId: "main", sample }];
  const trees = figureHierarchies(state);
  const source = prepareFigureSource(samples[0], trees.main, state);
  const figure = migrateFigure(null, samples, trees, "main", "FSC-A", "SSC-A");
  figure.populations = [{ hierarchyId: "main", populationId: leaf.population_id, label: leaf.name }];
  const style = figureStyle(defaultIllustrationConfig());
  const panel = layoutFigure(figure, samples)[0].panels[0];
  const build = (branchGatesOnly?: boolean) => buildFigurePanel(panel, { ...figure, branchGatesOnly }, [source], trees, style, {}).config!;
  return { state, leaf, rectangle, source, style, build };
}

describe("Illustration leaf branch", () => {
  it("counts the leaf's events and keeps sibling shapes absent through the all-gates toggle", () => {
    const f = fixture();
    expect(f.source.gating.stats.event_count[f.leaf.population_id]).toBe(2);
    expect(f.source.gating.stats.percent_of_parent[f.leaf.population_id]).toBe(50);
    expect(Array.from(f.source.gating.masks[f.leaf.population_id])).toEqual([1, 1, 0, 0]);
    expect(populationBranchGateOrder(f.state.populations, f.state.gates, f.state.gate_order, f.leaf.population_id)).toEqual([]);
    const host = document.getElementById("plot")!;

    for (const branchOnly of [undefined, true, false, true]) {
      const config = f.build(branchOnly);
      expect(config).toMatchObject({ n_events: 2, x: [0.5, 1.5], y: [0.5, 1.5] });
      const gates = config.gates as GateOverlay[];
      if (branchOnly === false) {
        expect(gates.map((gate) => gate.name)).toEqual(["Rectangle", "Triangle", "Quadrant"]);
        expect(gates.find((gate) => gate.gate_id === f.rectangle.gate_id)).toMatchObject({ event_count: 2, percent_of_parent: 100 });
      } else expect(gates).toEqual([]);
      loadMiniPlots().renderMiniPlot(host, config);
      expect(host.querySelectorAll("[data-gate-shape]")).toHaveLength(branchOnly === false ? 2 : 0);
      expect(host.querySelectorAll(".quadrant-gate")).toHaveLength(branchOnly === false ? 1 : 0);
    }
  });

  it("preserves the all-gates fallback unless the order is explicitly a branch scope", () => {
    const f = fixture();
    const payload = (order: string[], gateOrderIsScope?: boolean) => buildIllustrationPayload(
      f.source.sample, f.state.gates, order, f.state.populations,
      f.source.gating.masks, f.source.gating.stats.event_count,
      [f.leaf.population_id], ["FSC-A"], "SSC-A", {}, { ...f.style, gateOrderIsScope }, f.source.gating.gateMasks,
    ) as { gate_overlays: Record<string, GateOverlay[]> };
    const key = `${f.leaf.population_id}|FSC-A`;
    expect(payload([]).gate_overlays[key].map((gate) => gate.name)).toEqual(["Rectangle", "Triangle", "Quadrant"]);
    expect(payload([], true).gate_overlays[key]).toEqual([]);
  });
});
