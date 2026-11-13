// @vitest-environment jsdom
// A Plotting chart's panels as Layout blocks: populations of one name kept apart, a block finding
// its panel by its population's id, saying so when it finds none, and drawing one panel when an
// iteration leaves it matching several; the blocks of one chart sharing one model. Synthetic files
// D1 and D2; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { coreReducer, initialCoreState, recompute, type CoreState } from "../store";
import { BASE_PROPORTIONS_SETTINGS, type ProportionsSettings } from "../engine/proportionsSettings";
import { buildCellValuesModel } from "../engine/cellValuesModel";
import { createLayoutSheet, type LayoutProportionsPanel, type LayoutProportionsRecipe } from "../engine/layout";
import { expandLayoutSheet } from "../engine/layoutBatch";
import { arrangeCellPanels, cellPanels } from "./CellValuesChart";
import { placedOrOnly } from "./panelArrangement";
import { plottingPanelBlocks, onlyPanelMatches } from "./plottingPanels";
import { LayoutProportionsPanelNote, LayoutProportionsSurface, proportionsSampleRefs } from "./LayoutProportions";
import { I18nProvider } from "./i18n";

const built = vi.hoisted(() => ({ count: 0 }));
vi.mock("../engine/cellValuesModel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/cellValuesModel")>();
  return {
    ...actual,
    buildCellValuesModel: (...args: Parameters<typeof actual.buildCellValuesModel>) => {
      built.count++;
      return actual.buildCellValuesModel(...args);
    },
  };
});

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

// Small holds FSC below 25, Large from 25. Two populations named Ki67_positive sit side by side
// under the root, one over FSC below 25 and one from 25, so nothing in their names tells them
// apart. D1's FSC is 10, 20, 30, 40, 50 (below 25: 2, from 25: 3); D2's 15, 18, 35, 45 (2 and 2).
function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const gate = (name: string, from: number, to: number) => ({ ...newGate(name, "rectangle", "FSC-A", "SSC-A", [[from, 0], [to, 1000]]), space: "raw" as const });
  const gates = [gate("Small", 0, 25), gate("Large", 25, 1000), gate("Ki67_positive", 0, 25), gate("Ki67_positive", 25, 1000)];
  const pops = gates.map((g) => newPopulation(g.name, [newGateRef(g.gate_id)], rootPop.population_id));
  rootPop.children = pops.map((p) => p.population_id);
  Object.assign(state, {
    gates: Object.fromEntries(gates.map((g) => [g.gate_id, g])),
    gate_order: gates.map((g) => g.gate_id),
    populations: Object.fromEntries([rootPop, ...pops].map((p) => [p.population_id, p])),
    root_population_id: rootPop.population_id,
    active_population_id: rootPop.population_id,
  });
  const file = (id: string, fsc: number[]) => {
    const fcs: FcsFile = {
      version: "FCS3.1", nEvents: fsc.length, instrument: "flow", keywords: {}, spillover: null,
      channels: [
        { index: 0, name: "SSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from(fsc.map(() => 100)), Float32Array.from(fsc)],
    };
    return { id, name: `${id}.fcs`, fileName: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
  };
  const [small, large, ki67Low, ki67High] = pops.map((p) => p.population_id);
  const settings: ProportionsSettings = {
    ...BASE_PROPORTIONS_SETTINGS,
    valueKind: "cells",
    plotType: "violin",
    channel: "FSC-A",
    files: ["D1", "D2"],
    hierarchy: state.active_hierarchy_id,
    parent: rootPop.population_id,
    selectedPops: [small, large, ki67Low, ki67High],
    groupSel: "condition",
    xAxis: "groups",
  };
  return { state: state as CoreState, samples: [file("D1", [10, 20, 30, 40, 50]), file("D2", [15, 18, 35, 45])], settings, small, large, ki67Low, ki67High };
}

const METADATA = { D1: { condition: "control", donor: "D1" }, D2: { condition: "control", donor: "D2" } };

function draw(fx: ReturnType<typeof fixture>, recipe: LayoutProportionsRecipe, state: CoreState = fx.state) {
  act(() =>
    root.render(
      <I18nProvider>
        <LayoutProportionsSurface
          recipe={recipe}
          samples={fx.samples as never}
          state={state}
          metadataById={METADATA}
          divisionProfiles={{}}
          width={600}
          height={400}
          containerId="block"
          globalScales={{ "FSC-A": [0, 100] }}
        />
      </I18nProvider>,
    ),
  );
}
function note(fx: ReturnType<typeof fixture>, recipe: LayoutProportionsRecipe, state: CoreState = fx.state) {
  act(() =>
    root.render(
      <I18nProvider>
        <LayoutProportionsPanelNote recipe={recipe} samples={fx.samples as never} state={state} metadataById={METADATA} divisionProfiles={{}} />
      </I18nProvider>,
    ),
  );
  return host.textContent;
}
const drawnPanels = () => host.querySelectorAll("#block svg.gl-prop-panel");
const cellsIn = (fx: ReturnType<typeof fixture>, popId: string, fileId: string) => recompute(fx.samples.find((s) => s.id === fileId)!.sample, fx.state).populations[popId].event_count;

describe("Populations of one name in a Plotting chart", () => {
  it("keeps a column for each in \"A column per population\", keyed by the population", () => {
    const fx = fixture();
    const model = buildCellValuesModel(fx.settings, proportionsSampleRefs(fx.samples as never), fx.state, METADATA);
    const { panels } = cellPanels(model, "groups");
    const placed = arrangeCellPanels(panels, "groups", false, { panelColumns: "populations", panelsPerRow: 5 });
    expect(placed.columns).toBe(4);
    expect(placed.cells.filter(Boolean).map((panel) => panel!.populationId)).toEqual([fx.small, fx.large, fx.ki67Low, fx.ki67High]);
    const blocks = plottingPanelBlocks({ ...fx.settings, panelColumns: "populations" }, null, model);
    expect(blocks.map((block) => (block.panel as { populationId?: string }).populationId)).toEqual([fx.small, fx.large, fx.ki67Low, fx.ki67High]);
    expect(blocks.map((block) => block.column)).toEqual([0, 1, 2, 3]);
  });

  it("draws the one population a per-panel block holds, its cells as the gate list counts them", () => {
    const fx = fixture();
    const model = buildCellValuesModel(fx.settings, proportionsSampleRefs(fx.samples as never), fx.state, METADATA);
    const { panels } = cellPanels(model, "groups");
    const blocks = plottingPanelBlocks(fx.settings, null, model);
    const high = blocks.find((block) => (block.panel as { populationId?: string }).populationId === fx.ki67High)!.panel;
    const only = placedOrOnly(arrangeCellPanels(panels, "groups", false, fx.settings), panels, high, (panel) => panel);
    expect(only.cells).toHaveLength(1);
    expect(only.cells[0]!.populationId).toBe(fx.ki67High);
    const n = only.cells[0]!.slots[0].violin!.values.length;
    expect(n).toBe((cellsIn(fx, fx.ki67High, "D1") ?? 0) + (cellsIn(fx, fx.ki67High, "D2") ?? 0));
    expect(n).toBe(5);

    draw(fx, { kind: "proportions", settings: fx.settings, panel: high });
    expect(drawnPanels()).toHaveLength(1);
  });
});

describe("A per-panel block finding its panel", () => {
  it("finds a renamed population by its id, and in another chart that holds it", () => {
    const fx = fixture();
    const panel: LayoutProportionsPanel = { population: "Large", populationId: fx.large };
    const renamed = structuredClone(fx.state.populations);
    renamed[fx.large].name = "Big";
    const state = { ...fx.state, populations: renamed };
    draw(fx, { kind: "proportions", settings: fx.settings, panel }, state);
    expect(drawnPanels()).toHaveLength(1);
    expect(drawnPanels()[0].querySelector("text > title")?.textContent).toBe("Big");

    // "Replace with the current Plotting chart" keeps the block's panel; the new chart still holds it.
    const other = { ...fx.settings, selectedPops: [fx.ki67Low, fx.large] };
    draw(fx, { kind: "proportions", settings: other, panel });
    expect(drawnPanels()).toHaveLength(1);
    expect(drawnPanels()[0].querySelector("text > title")?.textContent).toBe("Large");
  });

  it("says what it looks for when the chart has no such panel", () => {
    const fx = fixture();
    const renamed = structuredClone(fx.state.populations);
    renamed[fx.large].name = "Big";
    // Saved before blocks kept the id, a renamed population is looked for by its old name.
    draw(fx, { kind: "proportions", settings: fx.settings, panel: { population: "Large" } }, { ...fx.state, populations: renamed });
    expect(drawnPanels()).toHaveLength(0);
    expect(host.textContent).toContain("No panel for Large in this chart.");
    draw(fx, { kind: "proportions", settings: { ...fx.settings, facetSel: "donor" }, panel: { facet: "D3", population: "Small", populationId: fx.small } });
    expect(host.textContent).toContain("No panel for D3, Small in this chart.");
    // The inspector says the same; a block that finds its panel has no note.
    expect(note(fx, { kind: "proportions", settings: fx.settings, panel: { population: "Large" } }, { ...fx.state, populations: renamed })).toBe("No panel for Large in this chart.");
    expect(note(fx, { kind: "proportions", settings: fx.settings, panel: { population: "Large", populationId: fx.large } }, { ...fx.state, populations: renamed })).toBe("");
  });

  it("draws one panel when the iteration leaves it matching a panel in each facet", () => {
    const fx = fixture();
    // Faceted by donor, the block holds D1's Small; the sheet iterates over the condition, so the
    // control unit's two files make the chart and the block no longer picks a facet.
    const settings = { ...fx.settings, facetSel: "donor", files: ["D1"] };
    const sheet = createLayoutSheet("S");
    sheet.items = [{ id: "p", x: 57, y: 57, width: 300, height: 300, z: 0, recipe: { kind: "proportions", settings, panel: { facet: "D1", population: "Small", populationId: fx.small }, iterated: true } }];
    sheet.iteration = { mode: "metadata", column: "condition", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const [page] = expandLayoutSheet(sheet, [{ id: "control", name: "control", fileName: "", sampleIds: ["D1", "D2"] }]);
    const bound = page.items[0].recipe as LayoutProportionsRecipe;
    expect(bound.panel).toEqual({ population: "Small", populationId: fx.small });
    const model = buildCellValuesModel(bound.settings, proportionsSampleRefs(fx.samples as never), fx.state, METADATA);
    expect(onlyPanelMatches(bound.settings, null, model, bound.panel)).toBe(2);
    draw(fx, bound);
    expect(drawnPanels()).toHaveLength(1);
    expect(drawnPanels()[0].querySelector("text > title")?.textContent).toContain("D1");
    expect(note(fx, bound)).toBe("2 panels of the chart match this block; it draws the first.");
  });
});

describe("The blocks of one Plotting chart on a sheet", () => {
  it("share one model build; moving a block does not build it again, changing a gate does", () => {
    const fx = fixture();
    const settings = { ...fx.settings, files: ["D1"] };
    const panels = plottingPanelBlocks(settings, null, buildCellValuesModel(settings, proportionsSampleRefs(fx.samples as never), fx.state, METADATA)).map((block) => block.panel);
    const sheet = createLayoutSheet("S");
    // Six blocks, each with its own copy of the settings, as a sheet opened from a save holds them.
    sheet.items = [...panels, { legend: true as const }, panels[0]].map((panel, i) => ({
      id: `b${i}`, x: 20 + i * 100, y: 20, width: 90, height: 90, z: i,
      recipe: { kind: "proportions" as const, settings: structuredClone(settings), panel, iterated: true },
    }));
    expect(sheet.items).toHaveLength(6);
    sheet.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const unit = { id: "D1", name: "D1", fileName: "D1.fcs" };
    const render = (state: CoreState) => {
      const [page] = expandLayoutSheet(sheet, [unit]);
      act(() =>
        root.render(
          <I18nProvider>
            {page.items.map((item) => (
              <LayoutProportionsSurface
                key={item.id}
                recipe={item.recipe as LayoutProportionsRecipe}
                // A new array of the same files on every render, as App hands them over.
                samples={[...fx.samples] as never}
                state={state}
                metadataById={{ ...METADATA }}
                divisionProfiles={{}}
                width={200}
                height={200}
                containerId={`block-${item.id}`}
                globalScales={{ "FSC-A": [0, 100] }}
                dataRevision="r1"
              />
            ))}
          </I18nProvider>,
        ),
      );
    };
    built.count = 0;
    render(fx.state);
    expect(built.count).toBe(1);
    expect(host.querySelectorAll("svg.gl-prop-panel")).toHaveLength(5);

    sheet.items[2] = { ...sheet.items[2], x: sheet.items[2].x + 40 };
    render(fx.state);
    expect(built.count).toBe(1);

    const smallGate = Object.values(fx.state.gates).find((gate) => gate.name === "Small")!;
    const moved = coreReducer(fx.state, { type: "editGate", gateId: smallGate.gate_id, vertices: [[0, 0], [12, 1000]] }) as CoreState;
    expect(moved.gates).not.toBe(fx.state.gates);
    render(moved);
    expect(built.count).toBe(2);
  });
});
