// @vitest-environment jsdom
// An Illustration chart panel over several files, sent to the Layout tab as a Plotting block of one
// panel (figureChartRecipe), drawn there as the figure draws it: a point per file for a statistic,
// the files' cells pooled for a violin, and a bar per file for a composition, whether the files
// share a metadata value on a shelf, are pooled, or sit on no shelf. Synthetic files D1 to D4,
// groups control and treated; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, type CoreState } from "../store";
import { figureHierarchies, layoutFigure, migrateFigure, type FigureChart, type FigureSample } from "../engine/figure";
import { defaultIllustrationConfig } from "../engine/figureDefaults";
import type { LayoutProportionsRecipe } from "../engine/layout";
import { I18nProvider } from "./i18n";
import { LayoutProportionsSurface } from "./LayoutProportions";
import { figureChartRecipe } from "./figureLayoutRecipes";
import { buildCellValuesModel } from "../engine/cellValuesModel";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

// FSC-A in raw units; CD4_positive holds FSC from 1000. D1 and D3 are control, D2 and D4 treated.
const FSC: Record<string, number[]> = { D1: [1200, 2400, 500], D2: [3100, 4200], D3: [1500, 300], D4: [3600, 5100, 200] };
const METADATA: Record<string, Record<string, string>> = { D1: { condition: "control" }, D2: { condition: "treated" }, D3: { condition: "control" }, D4: { condition: "treated" } };

function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const gate = { ...newGate("CD4_positive", "rectangle", "FSC-A", "SSC-A", [[1000, 0], [100000, 1000]]), space: "raw" as const };
  const pop = newPopulation("CD4_positive", [newGateRef(gate.gate_id)], rootPop.population_id);
  rootPop.children = [pop.population_id];
  Object.assign(state, {
    gates: { [gate.gate_id]: gate },
    gate_order: [gate.gate_id],
    populations: { [rootPop.population_id]: rootPop, [pop.population_id]: pop },
    root_population_id: rootPop.population_id,
    active_population_id: rootPop.population_id,
  });
  const samples: FigureSample[] = ["D1", "D2", "D3", "D4"].map((id) => {
    const fsc = FSC[id];
    const fcs: FcsFile = {
      version: "FCS3.1",
      nEvents: fsc.length,
      instrument: "flow",
      keywords: {},
      spillover: null,
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from(fsc), Float32Array.from(fsc.map(() => 100))],
    };
    return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs), metadata: METADATA[id] };
  });
  const core = state as CoreState;
  return { core, samples, popId: pop.population_id, rootId: rootPop.population_id };
}

type Shelf = "none" | "pooled" | "metadata";

/** The chart plot's blocks, one per panel, for the files arranged as the shelf says. */
function blocks(fx: ReturnType<typeof fixture>, chart: FigureChart, shelf: Shelf, population = { id: fx.popId, label: "CD4_positive" }): LayoutProportionsRecipe[] {
  const trees = figureHierarchies(fx.core);
  const figure = migrateFigure(null, fx.samples, trees, fx.core.active_hierarchy_id, "FSC-A", "SSC-A");
  figure.sampleIds = ["D1", "D2", "D3", "D4"];
  figure.populations = [{ hierarchyId: fx.core.active_hierarchy_id, populationId: population.id, label: population.label }];
  figure.plots = [{ id: "chart", name: "Chart", x: "FSC-A", y: "FSC-A", type: "chart", chart }];
  figure.rows = ["plots"];
  figure.columns = shelf === "metadata" ? ["metadata:condition"] : shelf === "pooled" ? ["samples"] : [];
  figure.pages = [];
  figure.composition = shelf === "pooled" ? "pool" : "separate";
  const config = { ...defaultIllustrationConfig(), figure };
  const panels = layoutFigure(figure, fx.samples, trees).flatMap((page) => page.panels);
  return panels.flatMap((panel) => figureChartRecipe(panel, figure, config, () => true, trees) ?? []);
}

function draw(fx: ReturnType<typeof fixture>, recipe: LayoutProportionsRecipe) {
  act(() =>
    root.render(
      <I18nProvider>
        <LayoutProportionsSurface
          recipe={recipe}
          samples={fx.samples}
          state={fx.core}
          metadataById={METADATA}
          divisionProfiles={{}}
          width={320}
          height={320}
          containerId="block"
        />
      </I18nProvider>,
    ),
  );
}
const points = () => host.querySelectorAll("#block svg.gl-prop-panel .gl-prop-point").length;
/** The violins' tooltips: each says its cells and the files they come from. */
const violins = () => [...host.querySelectorAll("#block svg.gl-prop-panel .gl-prop-mark title")].map((title) => title.textContent!.replace(/^.*: /, "").replace(/, median.*$/, ""));
/** The composition's bars: one CD4_positive segment each. */
const bars = () => [...host.querySelectorAll("#block svg.gl-prop-panel title")].filter((title) => title.textContent!.startsWith("CD4_positive:")).length;

describe("An Illustration chart panel over several files, as a Layout block", () => {
  for (const shelf of ["none", "pooled"] as const) {
    it(`draws a statistic point for each of the panel's files when the files are ${shelf === "none" ? "on no shelf" : "pooled"}`, () => {
      const fx = fixture();
      const recipes = blocks(fx, { valueKind: "statistic", plotType: "box" }, shelf);
      expect(recipes.map((recipe) => recipe.settings.files)).toEqual([["D1", "D2", "D3", "D4"]]);
      draw(fx, recipes[0]);
      expect(points()).toBe(4);
    });
  }

  it("draws a statistic point for each file of a metadata value on a shelf", () => {
    const fx = fixture();
    const recipes = blocks(fx, { valueKind: "statistic", plotType: "box" }, "metadata");
    expect(recipes.map((recipe) => recipe.settings.files)).toEqual([["D1", "D3"], ["D2", "D4"]]);
    for (const recipe of recipes) {
      draw(fx, recipe);
      expect(points()).toBe(2);
    }
  });

  for (const shelf of ["none", "pooled"] as const) {
    it(`pools every file's cells in one violin when the files are ${shelf === "none" ? "on no shelf" : "pooled"}`, () => {
      const fx = fixture();
      const recipes = blocks(fx, { valueKind: "cells", plotType: "violin" }, shelf);
      draw(fx, recipes[0]);
      expect(violins()).toEqual(["7 cells from 4 files"]);
    });
  }

  it("pools the cells of each metadata value's files in its violin", () => {
    const fx = fixture();
    const drawn = blocks(fx, { valueKind: "cells", plotType: "violin" }, "metadata").map((recipe) => {
      draw(fx, recipe);
      return violins();
    });
    expect(drawn).toEqual([["3 cells from 2 files"], ["4 cells from 2 files"]]);
  });

  it("draws the root population's cells, every event of the panel's files, when the panel is on the root", () => {
    const fx = fixture();
    const recipes = blocks(fx, { valueKind: "cells", plotType: "violin" }, "none", { id: fx.rootId, label: "All Events" });
    expect(recipes.map((recipe) => recipe.settings.selectedPops)).toEqual([[fx.rootId]]);
    const model = buildCellValuesModel(recipes[0].settings, fx.samples, fx.core, METADATA);
    expect(model.levels).toEqual([{ popId: fx.rootId, depth: 0 }]);
    expect(model.catLevels).toEqual(["All Events"]);
    // The panel's cells: every event of D1 to D4.
    const events = fx.samples.reduce((total, entry) => total + entry.sample.fcs.nEvents, 0);
    expect(events).toBe(10);
    draw(fx, recipes[0]);
    expect(violins()).toEqual([`${events} cells from 4 files`]);
    expect([...host.querySelectorAll("#block svg.gl-prop-panel .gl-prop-mark title")].map((title) => title.textContent!.startsWith("All Events"))).toEqual([true]);
  });

  for (const shelf of ["none", "pooled", "metadata"] as const) {
    it(`draws a composition bar for each of the panel's files (${shelf})`, () => {
      const fx = fixture();
      const drawn = blocks(fx, { valueKind: "proportion", plotType: "stacked" }, shelf).map((recipe) => {
        draw(fx, recipe);
        return bars();
      });
      expect(drawn).toEqual(shelf === "metadata" ? [2, 2] : [4]);
    });
  }
});
