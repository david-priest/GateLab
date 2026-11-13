// @vitest-environment jsdom
// A Plotting chart's group and division colours on a Layout sheet that iterates: a group keeps the
// colour it has among all the chart's files on every page, and a panel block agrees with a legend
// block left fixed. Synthetic files D1 (control) and D2 (treated); nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, type CoreState } from "../store";
import { BASE_PROPORTIONS_SETTINGS, type ProportionsSettings } from "../engine/proportionsSettings";
import { createLayoutSheet, type LayoutItem, type LayoutProportionsRecipe } from "../engine/layout";
import { expandLayoutSheet, type LayoutUnit } from "../engine/layoutBatch";
import { paletteColors } from "../engine/palettes";
import type { DivisionProfileLike } from "../engine/factors";
import { I18nProvider } from "./i18n";
import { LayoutProportionsSurface } from "./LayoutProportions";
import { plottingGroupColours, plottingGroupLevels } from "./plottingColours";

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

// Small holds FSC below 25 and Large FSC from 25, in raw units. D1's FSC is 10, 20, 30, 40, 50;
// D2's is 15, 18, 35, 45.
function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const small = { ...newGate("Small", "rectangle", "FSC-A", "SSC-A", [[0, 0], [25, 1000]]), space: "raw" as const };
  const large = { ...newGate("Large", "rectangle", "FSC-A", "SSC-A", [[25, 0], [1000, 1000]]), space: "raw" as const };
  const smallPop = newPopulation("Small", [newGateRef(small.gate_id)], rootPop.population_id);
  const largePop = newPopulation("Large", [newGateRef(large.gate_id)], rootPop.population_id);
  rootPop.children = [smallPop.population_id, largePop.population_id];
  Object.assign(state, {
    gates: { [small.gate_id]: small, [large.gate_id]: large },
    gate_order: [small.gate_id, large.gate_id],
    populations: { [rootPop.population_id]: rootPop, [smallPop.population_id]: smallPop, [largePop.population_id]: largePop },
    root_population_id: rootPop.population_id,
    active_population_id: rootPop.population_id,
  });
  const file = (id: string, fsc: number[]) => {
    const fcs: FcsFile = {
      version: "FCS3.1",
      nEvents: fsc.length,
      instrument: "flow",
      keywords: {},
      spillover: null,
      channels: [
        { index: 0, name: "SSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from(fsc.map(() => 100)), Float32Array.from(fsc)],
    };
    return { id, name: `${id}.fcs`, fileName: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
  };
  const core = state as CoreState;
  return {
    state: core,
    samples: [file("D1", [10, 20, 30, 40, 50]), file("D2", [15, 18, 35, 45])],
    settings: {
      ...BASE_PROPORTIONS_SETTINGS,
      files: ["D1", "D2"],
      hierarchy: core.active_hierarchy_id,
      parent: rootPop.population_id,
      selectedPops: [smallPop.population_id, largePop.population_id],
      includeUngated: false,
      groupSel: "condition",
      palette: "viridis",
      xAxis: "groups",
    } as ProportionsSettings,
  };
}

const METADATA = { D1: { condition: "control" }, D2: { condition: "treated" } };
const UNITS: LayoutUnit[] = [
  { id: "D1", name: "D1", fileName: "D1.fcs" },
  { id: "D2", name: "D2", fileName: "D2.fcs" },
];

/** A panel block that follows a file iteration and a legend block left fixed, as drawn on D2's page. */
function boundOnTreatedPage(settings: ProportionsSettings, panel: LayoutProportionsRecipe["panel"]) {
  const item = (id: string, recipe: LayoutProportionsRecipe): LayoutItem => ({ id, x: 57, y: 57, width: 400, height: 400, z: 0, recipe });
  const sheet = createLayoutSheet("S");
  sheet.items = [
    item("p", { kind: "proportions", settings, panel, iterated: true }),
    item("l", { kind: "proportions", settings, panel: { legend: true } }),
  ];
  sheet.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
  const page = expandLayoutSheet(sheet, UNITS)[1];
  const recipeOf = (id: string) => page.items.find((entry) => entry.templateId === id)!.recipe as LayoutProportionsRecipe;
  expect(recipeOf("p").settings.files).toEqual(["D2"]);
  return { panel: recipeOf("p"), legend: recipeOf("l") };
}

function draw(fx: ReturnType<typeof fixture>, recipes: { recipe: LayoutProportionsRecipe; id: string }[], divisionProfiles: Record<string, DivisionProfileLike> = {}) {
  act(() =>
    root.render(
      <I18nProvider>
        {recipes.map(({ recipe, id }) => (
          <LayoutProportionsSurface
            key={id}
            recipe={recipe}
            chartFiles={fx.settings.files}
            samples={fx.samples as never}
            state={fx.state}
            metadataById={METADATA}
            divisionProfiles={divisionProfiles}
            width={600}
            height={400}
            containerId={id}
            globalScales={{ "FSC-A": [0, 100] }}
          />
        ))}
      </I18nProvider>,
    ),
  );
}

const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
const markFills = (id: string) => [...new Set([...host.querySelectorAll(`#${id} .gl-prop-mark[fill]`)].map((mark) => mark.getAttribute("fill")))];
const swatch = (label: string) =>
  [...host.querySelectorAll<HTMLElement>("#legend .gl-prop-legend-item")]
    .find((entry) => entry.textContent === label)!
    .querySelector<HTMLElement>(".gl-prop-swatch")!.style.background;

describe("Plotting group colours under a Layout iteration", () => {
  const treated = paletteColors("viridis", 2)[1];

  it.each([
    ["a per-cell chart", { valueKind: "cells", plotType: "violin" }, { population: "Large" }],
    ["a statistic chart", { valueKind: "statistic", plotType: "box", channel: "FSC-A" }, { population: "Large" }],
    ["a proportion boxplot", { valueKind: "proportion", plotType: "box" }, { population: "Large" }],
  ] as const)("keeps the second group's colour on a page without the first, in %s, as the fixed legend shows it", (_, kind, panel) => {
    const fx = fixture();
    const settings = { ...fx.settings, channel: "FSC-A", ...kind } as ProportionsSettings;
    const { panel: bound, legend } = boundOnTreatedPage(settings, panel);
    draw(fx, [{ recipe: bound, id: "panel" }, { recipe: legend, id: "legend" }]);
    expect(markFills("panel")).toEqual([treated]);
    expect(swatch("treated")).toBe(rgb(treated));
    expect(swatch("control")).toBe(rgb(paletteColors("viridis", 2)[0]));
  });

  it("keeps each division level's colour on a page whose files reach fewer levels", () => {
    const fx = fixture();
    // D1 is split at 25 (Div0, Div1); D2 at 20 and 30 (Div0 to Div2).
    const profiles: Record<string, DivisionProfileLike> = {
      D1: { channelKey: "FSC-A", boundaries: [25], n: 1 },
      D2: { channelKey: "FSC-A", boundaries: [20, 30], n: 2 },
    };
    const settings = { ...fx.settings, categoryKind: "division", plotType: "stacked" } as ProportionsSettings;
    const item = (id: string, recipe: LayoutProportionsRecipe): LayoutItem => ({ id, x: 57, y: 57, width: 400, height: 400, z: 0, recipe });
    const sheet = createLayoutSheet("S");
    sheet.items = [item("p", { kind: "proportions", settings, iterated: true }), item("l", { kind: "proportions", settings, panel: { legend: true } })];
    sheet.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const page = expandLayoutSheet(sheet, UNITS)[0];
    const recipeOf = (id: string) => page.items.find((entry) => entry.templateId === id)!.recipe as LayoutProportionsRecipe;
    draw(fx, [{ recipe: recipeOf("p"), id: "panel" }, { recipe: recipeOf("l"), id: "legend" }], profiles);
    const all = paletteColors("viridis", 3);
    expect(markFills("panel").sort()).toEqual([all[0], all[1]].sort());
    expect(swatch("Div1")).toBe(rgb(all[1]));
  });
});

describe("plottingGroupLevels and plottingGroupColours", () => {
  it("lists the groups of the chart's files, and colours a subset by its place among them", () => {
    const files = [{ id: "D1", name: "D1.fcs" }, { id: "D2", name: "D2.fcs" }, { id: "D3", name: "D3.fcs" }];
    const metadata = { D1: { condition: "treated" }, D2: { condition: "control" }, D3: {} };
    // In the file list's order, as Illustration orders a column's values: each at its first file.
    expect(plottingGroupLevels({ files: ["D1", "D2"], groupSel: "condition" }, files, metadata)).toEqual(["treated", "control"]);
    expect(plottingGroupLevels({ files: ["D3", "D2", "D1"], groupSel: "condition" }, files, metadata)).toEqual(["treated", "control", "(NA)"]);
    const all = paletteColors("paired", 2);
    expect(plottingGroupColours("paired", ["treated"], ["control", "treated"])).toEqual([all[1]]);
    // Without the full list, the groups drawn are the list, as before.
    expect(plottingGroupColours("paired", ["treated"])).toEqual([paletteColors("paired", 1)[0]]);
  });
});
