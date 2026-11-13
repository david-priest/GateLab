// @vitest-environment jsdom
// The Plotting tab's per-cell chart: switching to it, what it draws, its hand-off to the Layout
// tab, its export and its Layout block. Synthetic files D1 and D2; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { BASE_PROPORTIONS_SETTINGS, type ProportionsSettings } from "../engine/proportionsSettings";
import { I18nProvider } from "./i18n";
import { composeProportionsChartSvg, PlottingTab, resolveCellChannel } from "./PlottingTab";
import { cellValuesBlockFrame, fitPlottingToFrame, LayoutProportionsSurface, plottingBlockSizer, proportionsSampleRefs, SHEET_BLOCK_CHROME } from "./LayoutProportions";
import { buildCellValuesModel } from "../engine/cellValuesModel";
import { cellChartAxis } from "./CellValuesChart";
import { clearPersistedTabState, readProportionsSettings, restorePlottingState, savedPlottingState } from "./tabState";
import { createLayoutSheet } from "../engine/layout";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearPersistedTabState();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

// Small holds FSC below 25 and Large FSC from 25, both in raw units. D1's FSC is 10, 20, 30, 40,
// 50 (Small 2, Large 3); D2's is 15, 18, 35, 45 (Small 2, Large 2).
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
    return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
  };
  return {
    state: state as CoreState,
    samples: [file("D1", [10, 20, 30, 40, 50]), file("D2", [15, 18, 35, 45])],
    rootId: rootPop.population_id,
    small: smallPop.population_id,
    large: largePop.population_id,
  };
}

function mount(fx: ReturnType<typeof fixture>, opts: { onAddToLayout?: (settings: unknown) => void; onAddPanelsToLayout?: (settings: unknown, blocks: unknown) => void; onConfigChange?: () => void; illustrationPanelSize?: number } = {}) {
  act(() =>
    root.render(
      <I18nProvider>
        <PlottingTab
          samples={fx.samples}
          activeSampleId="D1"
          state={fx.state}
          derived={recompute(fx.samples[0].sample, fx.state)}
          metadata={{ D1: { condition: "control" }, D2: { condition: "treated" } }}
          metadataColumns={[{ name: "condition" }]}
          divisionProfiles={{}}
          dataRevisionKey="r1"
          onAddToLayout={opts.onAddToLayout}
          onAddPanelsToLayout={opts.onAddPanelsToLayout}
          onConfigChange={opts.onConfigChange}
          gatingRange={(channel) => (channel === "FSC-A" ? [0, 100] : undefined)}
          illustrationPanelSize={opts.illustrationPanelSize}
        />
      </I18nProvider>,
    ),
  );
}

const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
const radio = (name: string, index: number) => [...host.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)][index];
const labelled = (text: string) =>
  [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.trim().startsWith(text))!.querySelector("input, select") as HTMLInputElement & HTMLSelectElement;
// A panel's title in full, as its tooltip holds it (the drawn text may be shortened).
const panelTitles = () => [...host.querySelectorAll("#gl-prop-svg svg.gl-prop-panel")].map((svg) => svg.querySelector("text > title")?.textContent);

function chooseCells() {
  act(() => radio("prop-value", 1).click());
}

describe("Plotting tab: channel per cell", () => {
  it("draws a violin per population in a panel per group, on forward scatter by default", () => {
    const fx = fixture();
    mount(fx);
    chooseCells();
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Channel"]')!.value).toBe("FSC-A");
    // Group is the first metadata column: a panel per condition, Small and Large along x.
    expect(panelTitles()).toEqual(["condition: control", "condition: treated"]);
    const violins = host.querySelectorAll("#gl-prop-svg path.gl-prop-mark");
    expect(violins).toHaveLength(4);
    const tips = [...violins].map((path) => path.querySelector("title")?.textContent);
    expect(tips[0]).toBe("Small · control: 2 cells from 1 file, median 15");
    expect(tips[1]).toBe("Large · control: 3 cells from 1 file, median 40");
    expect(tips[3]).toBe("Large · treated: 2 cells from 1 file, median 40");
    // The axis is the Gating tab's range for the channel.
    const ticks = [...host.querySelectorAll("#gl-prop-svg svg.gl-prop-panel")][0].querySelectorAll("text");
    expect([...ticks].map((t) => t.textContent)).toContain("100");
  });

  it("puts the groups along x when asked, with a panel per population, and draws boxes", () => {
    const fx = fixture();
    mount(fx);
    chooseCells();
    act(() => {
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="Place condition"]')!;
      select.value = "x";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(panelTitles()).toEqual(["Small", "Large"]);
    act(() => radio("prop-type", 1).click());
    expect(host.querySelectorAll("#gl-prop-svg path.gl-prop-mark")).toHaveLength(0);
    expect(host.querySelectorAll("#gl-prop-svg rect.gl-prop-mark")).toHaveLength(4);
    expect(host.querySelector(".gl-prop-legend-title")?.textContent).toBe("condition");
  });

  it("colours each mark by its panel's population when asked, with the groups along x", () => {
    const fx = fixture();
    mount(fx);
    chooseCells();
    const option = () => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.trim() === "Colour by population")?.querySelector("input");
    // With the populations along x the marks already take their population's colour.
    expect(option()).toBeUndefined();
    act(() => {
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="Place condition"]')!;
      select.value = "x";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const fills = () =>
      [...host.querySelectorAll("#gl-prop-svg svg.gl-prop-panel")].map((panel) => [...new Set([...panel.querySelectorAll("path.gl-prop-mark")].map((mark) => mark.getAttribute("fill")))]);
    // By group: each panel's two violins differ, and the panels repeat the same two colours.
    const byGroup = fills();
    expect(byGroup.map((panel) => panel.length)).toEqual([2, 2]);
    expect(byGroup[0]).toEqual(byGroup[1]);
    act(() => option()!.click());
    // By population: one colour in each panel, a different one in the other.
    const byPopulation = fills();
    expect(byPopulation.map((panel) => panel.length)).toEqual([1, 1]);
    expect(byPopulation[0][0]).not.toBe(byPopulation[1][0]);
    expect(savedPlottingState()["prop.colourByPopulation"]).toBe(true);
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS).colourByPopulation).toBe(true);
  });

  it("turns off the controls a per-cell chart has no use for, and returns to proportions as it was", () => {
    const fx = fixture();
    mount(fx);
    chooseCells();
    expect(labelled("Replicate unit").disabled).toBe(true);
    expect(labelled("Include ungated").disabled).toBe(true);
    expect(labelled("Show replicate points").disabled).toBe(true);
    expect([...host.querySelectorAll<HTMLInputElement>('input[name="prop-type"]')].map((input) => input.parentElement!.textContent)).toEqual(["Violin", "Boxplot", "Split violin", "Ridgelines"]);
    act(() => radio("prop-value", 0).click());
    expect([...host.querySelectorAll<HTMLInputElement>('input[name="prop-type"]')].map((input) => input.parentElement!.textContent)).toEqual(["Stacked bar", "Boxplot", "Bar", "Points"]);
    expect(radio("prop-type", 0).checked).toBe(true);
    expect(host.querySelectorAll("#gl-prop-svg path.gl-prop-mark")).toHaveLength(0);
  });

  it("marks the workspace unsaved on a change, and keeps the choice across a save and reopen", () => {
    const fx = fixture();
    const onConfigChange = vi.fn();
    mount(fx, { onConfigChange });
    expect(onConfigChange).not.toHaveBeenCalled();
    chooseCells();
    expect(onConfigChange).toHaveBeenCalled();
    const saved = savedPlottingState();
    expect(saved["prop.valueKind"]).toBe("cells");
    expect(saved["prop.plotType"]).toBe("violin");
    clearPersistedTabState();
    restorePlottingState({ ...saved, "prop.channel": "FSC-A", "prop.xAxis": "groups", "prop.cellRange": "fit", "prop.violinBox": false });
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS)).toMatchObject({ valueKind: "cells", plotType: "violin", channel: "FSC-A", xAxis: "groups", cellRange: "fit", violinBox: false });
  });

  it("hands the per-cell chart to the Layout tab with its channel, and the block draws it", () => {
    const fx = fixture();
    const onAddToLayout = vi.fn();
    mount(fx, { onAddToLayout });
    chooseCells();
    act(() => button("Add to Layout")!.click());
    const settings = onAddToLayout.mock.calls[0][0];
    expect(settings).toMatchObject({ valueKind: "cells", plotType: "violin", channel: "FSC-A", xAxis: "populations", cellRange: "gating", violinBox: true, selectedPops: [fx.small, fx.large] });

    const sheet = createLayoutSheet();
    const sizer = plottingBlockSizer(settings, proportionsSampleRefs(fx.samples.map((s) => ({ ...s, fileName: s.name }))), fx.state, {}, {}, { "FSC-A": [0, 100] });
    expect(sizer).not.toBeNull();
    // Two panels side by side over a one-row legend, within the page.
    const frame = sizer!(sheet);
    expect(frame.width).toBeGreaterThan(360);
    expect(frame.height).toBeGreaterThan(settings.height);
    act(() =>
      root.render(
        <I18nProvider>
          <LayoutProportionsSurface
            recipe={{ kind: "proportions", settings }}
            samples={fx.samples.map((s) => ({ ...s, fileName: s.name })) as never}
            state={fx.state}
            metadataById={{ D1: { condition: "control" }, D2: { condition: "treated" } }}
            divisionProfiles={{}}
            width={600}
            height={400}
            containerId="layout-proportions-x"
            globalScales={{ "FSC-A": [0, 100] }}
          />
        </I18nProvider>,
      ),
    );
    expect(host.querySelectorAll("#layout-proportions-x path.gl-prop-mark")).toHaveLength(4);
  });

  it("exports every panel and the legend, without a highlight", () => {
    const fx = fixture();
    mount(fx);
    chooseCells();
    const item = [...host.querySelectorAll<HTMLButtonElement>(".gl-prop-legend-item")].find((entry) => entry.textContent === "Large")!;
    act(() => item.click());
    expect([...host.querySelectorAll("#gl-prop-svg .gl-prop-mark-group")].some((g) => g.getAttribute("opacity") === "0.16")).toBe(true);
    const composed = composeProportionsChartSvg("gl-prop-svg")!;
    expect(composed.root.querySelectorAll("path.gl-prop-mark")).toHaveLength(4);
    expect([...composed.root.querySelectorAll(".gl-prop-mark-group")].every((g) => !g.hasAttribute("opacity"))).toBe(true);
    expect(composed.root.textContent).toContain("Small");
  });

  it("draws a proportion chart saved with a violin as the stacked bar the Layout tab takes", () => {
    const fx = fixture();
    restorePlottingState({ "prop.valueKind": "proportion", "prop.plotType": "violin" });
    mount(fx);
    expect(radio("prop-type", 0).checked).toBe(true);
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS).plotType).toBe("stacked");
  });

  it("resolves the channel as the tab does: the one chosen where a drawn file has it, else forward scatter", () => {
    const fx = fixture();
    expect(resolveCellChannel("SSC-A", fx.samples)).toBe("SSC-A");
    expect(resolveCellChannel("CD45RA", fx.samples)).toBe("FSC-A");
    expect(resolveCellChannel("", fx.samples)).toBe("FSC-A");
  });
});

describe("Plotting tab: panel arrangement", () => {
  const grid = () => host.querySelector<HTMLDivElement>("#gl-prop-svg .gl-prop-panels")!.style.gridTemplateColumns;
  const panelWidths = () => [...host.querySelectorAll("#gl-prop-svg svg.gl-prop-panel")].map((svg) => Number(svg.getAttribute("width")));
  const choose = (label: string, value: string) =>
    act(() => {
      const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`) ?? labelled(label);
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

  it("wraps the panels a set number to a row, or puts each group in a column with a row per facet", () => {
    const fx = fixture();
    restorePlottingState({ "prop.panelsPerRow": 1 });
    mount(fx);
    chooseCells();
    expect(grid()).toBe("repeat(1, max-content)");
    // Facet by file: a panel per file and condition, D1 only in control and D2 only in treated.
    choose("Facet", "__sample__");
    // The facet and the groups are the panels' dimensions, wrapped until one is put on Columns.
    expect([...host.querySelectorAll('[data-shelf="wrap"] .gl-figure-dimension > span')].map((s) => s.textContent)).toEqual(["Files", "condition"]);
    choose("Place condition", "columns");
    expect(grid()).toBe("repeat(2, max-content)");
    expect(panelTitles()).toEqual(["condition: control · File: D1.fcs", "condition: treated · File: D1.fcs", "condition: control · File: D2.fcs", "condition: treated · File: D2.fcs"]);
    expect(labelled("Per row").disabled).toBe(true);
    expect(savedPlottingState()["prop.panelColumns"]).toBe("groups");
  });

  it("shows each chart's dimensions on the Arrange dimensions shelves, a stacked bar's populations fixed as its stack", () => {
    const fx = fixture();
    mount(fx);
    const shelf = (id: string) => [...host.querySelectorAll(`[data-shelf="${id}"] .gl-figure-dimension`)].map((chip) => `${chip.querySelector("span")!.textContent}${chip.querySelector("select") ? "" : " (fixed)"}`);
    // A stacked bar: the groups along x and the populations its stack, neither moved.
    expect(shelf("x")).toEqual(["condition (fixed)", "Stack (fixed)"]);
    choose("Facet", "__sample__");
    expect(shelf("wrap")).toEqual(["Files"]);
    choose("Place Files", "columns");
    expect(shelf("columns")).toEqual(["Files"]);
    expect(savedPlottingState()["prop.panelColumns"]).toBe("facet");
    expect(grid()).toBe("repeat(2, max-content)");
    // A proportion boxplot: a panel per population, which may take the columns; the groups stay along x.
    act(() => radio("prop-type", 1).click());
    expect(shelf("x")).toEqual(["condition (fixed)"]);
    expect(shelf("wrap")).toEqual(["Populations"]);
    expect([...host.querySelectorAll<HTMLOptionElement>('select[aria-label="Place Populations"] option')].map((o) => `${o.value}${o.disabled ? " (off)" : ""}`)).toEqual(["x (off)", "columns", "rows", "pages", "wrap"]);
    choose("Place Populations", "columns");
    expect(shelf("columns")).toEqual(["Populations"]);
    expect(shelf("wrap")).toEqual(["Files"]);
    expect(savedPlottingState()["prop.panelColumns"]).toBe("populations");
    // A per-cell chart: the populations along x by default; put on Columns, the groups come along x.
    chooseCells();
    expect(shelf("x")).toEqual(["Populations"]);
    choose("Place Populations", "columns");
    expect(shelf("x")).toEqual(["condition"]);
    expect(savedPlottingState()["prop.xAxis"]).toBe("groups");
    expect(panelTitles()).toEqual(["Small · File: D1.fcs", "Large · File: D1.fcs", "Small · File: D2.fcs", "Large · File: D2.fcs"]);
  });

  it("makes a grid by rows and columns, headed above each column and beside each row, kept on a reload, exported, and framed on the Layout tab", () => {
    const fx = fixture();
    mount(fx);
    chooseCells();
    choose("Facet", "__sample__");
    choose("Place Populations", "columns");
    choose("Place Files", "rows");
    expect(savedPlottingState()).toMatchObject({ "prop.xAxis": "groups", "prop.panelColumns": "populations", "prop.panelRows": "facet" });
    // A heading column, then a column per population; a heading row, then a row per file.
    expect(grid()).toBe("max-content repeat(2, max-content)");
    const headings = (side: string) => [...host.querySelectorAll(`#gl-prop-svg svg.gl-prop-heading[data-heading="${side}"] title`)].map((t) => t.textContent);
    expect(headings("column")).toEqual(["Small", "Large"]);
    expect(headings("row")).toEqual(["File: D1.fcs", "File: D2.fcs"]);
    // The titles leave out what the headings say: here everything, so the panels have none.
    const panelTexts = [...host.querySelectorAll("#gl-prop-svg svg.gl-prop-panel")].map((svg) => [...svg.querySelectorAll("text > title")].map((t) => t.textContent));
    expect(panelTexts).toHaveLength(4);
    for (const texts of panelTexts) expect(texts.filter((text) => /Small|Large|File/.test(text ?? ""))).toEqual([]);
    // The export draws the headings with the panels.
    const exported = composeProportionsChartSvg("gl-prop-svg")!;
    expect(exported.root.querySelectorAll("svg.gl-prop-heading")).toHaveLength(4);
    expect(exported.root.querySelectorAll("svg.gl-prop-panel")).toHaveLength(4);
    // The Layout block's frame makes room for the headings, and a block laid out to its frame keeps the grid.
    const files = proportionsSampleRefs(fx.samples.map((s) => ({ ...s, fileName: s.name })) as never);
    const metadata = { D1: { condition: "control" }, D2: { condition: "treated" } };
    const settings: ProportionsSettings = { ...BASE_PROPORTIONS_SETTINGS, valueKind: "cells", plotType: "violin", channel: "FSC-A", files: ["D1", "D2"], selectedPops: [fx.small, fx.large], groupSel: "condition", facetSel: "__sample__", xAxis: "groups", panelColumns: "populations", panelRows: "facet" };
    const sized = (extra: Partial<ProportionsSettings>) => plottingBlockSizer({ ...settings, ...extra }, files, fx.state, metadata, {}, { "FSC-A": [0, 100] })!(createLayoutSheet());
    const headed = sized({ panelWidth: 300 });
    const plain = sized({ panelWidth: 300, panelRows: "" });
    expect(headed.width).toBeGreaterThan(plain.width);
    expect(headed.height).toBeGreaterThan(plain.height - 1);
    // Laid out to a sheet block's frame (textSize "sheet"), the grid with its headings fills the frame.
    const target = { width: 700, height: 520 };
    const cellModel = buildCellValuesModel(settings, files, fx.state, metadata);
    const axis = cellChartAxis(cellModel, settings.cellRange, [0, 100], {})!;
    const frame = (s: ProportionsSettings) => cellValuesBlockFrame(s, cellModel, axis, null);
    const fitted = fitPlottingToFrame(settings, frame, target.width, target.height);
    expect(fitted.fits).toBe(true);
    const filled = frame(fitted.settings);
    expect(filled.width).toBeLessThanOrEqual(target.width);
    expect(filled.width).toBeGreaterThan(target.width - 4);
    // Reopened, the chart draws the same grid.
    const saved = savedPlottingState();
    act(() => root.unmount());
    root = createRoot(host);
    clearPersistedTabState();
    restorePlottingState(saved);
    mount(fx);
    expect(headings("row")).toEqual(["File: D1.fcs", "File: D2.fcs"]);
  });

  it("heads a proportion boxplot's grid and a statistic chart's grid as the per-cell chart's", () => {
    const fx = fixture();
    mount(fx);
    act(() => radio("prop-type", 1).click());
    choose("Facet", "__sample__");
    choose("Place Populations", "rows");
    choose("Place Files", "columns");
    const headings = (side: string) => [...host.querySelectorAll(`#gl-prop-svg svg.gl-prop-heading[data-heading="${side}"] title`)].map((t) => t.textContent);
    expect(headings("column")).toEqual(["File: D1.fcs", "File: D2.fcs"]);
    expect(headings("row")).toEqual(["Small", "Large", "ungated"]);
    // A proportion panel's title is its first text; in the grid it says nothing the headings say.
    const titles = [...host.querySelectorAll("#gl-prop-svg svg.gl-prop-panel")].map((svg) => svg.querySelector("text")?.textContent);
    expect(titles.every((title) => title === "")).toBe(true);
    act(() => radio("prop-value", 2).click());
    choose("Place Populations", "rows");
    expect(headings("row")).toEqual(["Small", "Large"]);
    expect(headings("column")).toEqual(["File: D1.fcs", "File: D2.fcs"]);
  });

  it("draws every panel at the width asked, and matches an Illustration panel's size", () => {
    const fx = fixture();
    restorePlottingState({ "prop.panelWidth": 300 });
    mount(fx, { illustrationPanelSize: 320 });
    chooseCells();
    expect(panelWidths()).toEqual([300, 300]);
    act(() => button("Match Illustration panel size")!.click());
    expect(panelWidths()).toEqual([320, 320]);
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS)).toMatchObject({ panelWidth: 320, height: 320 - 68 });
    // A proportion boxplot takes the same width and arrangement.
    act(() => radio("prop-value", 0).click());
    act(() => radio("prop-type", 1).click());
    // Small, Large and the rest of the root.
    expect(panelWidths()).toEqual([320, 320, 320]);
  });

  it("restores a width below the least as the least, and 0 as fitted", () => {
    restorePlottingState({ "prop.panelWidth": 50, "prop.panelsPerRow": 40, "prop.panelColumns": "rows" });
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS)).toMatchObject({ panelWidth: 120, panelsPerRow: 12, panelColumns: "" });
    clearPersistedTabState();
    restorePlottingState({ "prop.panelWidth": 0 });
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS).panelWidth).toBe(0);
  });

  it("sizes the Layout block for the arrangement", () => {
    const fx = fixture();
    const files = proportionsSampleRefs(fx.samples.map((s) => ({ ...s, fileName: s.name })) as never);
    const settings = { ...BASE_PROPORTIONS_SETTINGS, valueKind: "cells" as const, plotType: "violin" as const, channel: "FSC-A", files: ["D1", "D2"], selectedPops: [fx.small, fx.large], groupSel: "condition" };
    const metadata = { D1: { condition: "control" }, D2: { condition: "treated" } };
    const frame = (extra: Partial<typeof settings & { panelsPerRow: number; panelWidth: number }>) =>
      plottingBlockSizer({ ...settings, ...extra }, files, fx.state, metadata, {}, { "FSC-A": [0, 100] })!(createLayoutSheet());
    const sideBySide = frame({});
    const stacked = frame({ panelsPerRow: 1 });
    expect(stacked.height).toBeGreaterThan(sideBySide.height);
    // Two panels and the gap between them, the card's 24 px, and the frame's own margins about a block drawn at the sheet's text sizes.
    expect(frame({ panelWidth: 400 }).width).toBe(2 * 400 + 12 + 24 + SHEET_BLOCK_CHROME);
  });
});

describe("Plotting tab: a block per panel on the Layout tab", () => {
  const surface = (fx: ReturnType<typeof fixture>, settings: ProportionsSettings, panel: unknown, id: string) => (
    <LayoutProportionsSurface
      recipe={{ kind: "proportions", settings, panel: panel as never }}
      samples={fx.samples.map((s) => ({ ...s, fileName: s.name })) as never}
      state={fx.state}
      metadataById={{ D1: { condition: "control" }, D2: { condition: "treated" } }}
      divisionProfiles={{}}
      width={600}
      height={400}
      containerId={id}
      globalScales={{ "FSC-A": [0, 100] }}
    />
  );

  it("sends each panel with its place in the arrangement, and a block draws its panel alone or the legend alone", () => {
    const fx = fixture();
    const onAddPanelsToLayout = vi.fn();
    restorePlottingState({ "prop.panelsPerRow": 1 });
    mount(fx, { onAddToLayout: vi.fn(), onAddPanelsToLayout });
    chooseCells();
    act(() => button("Add panels to Layout")!.click());
    const [settings, blocks] = onAddPanelsToLayout.mock.calls[0] as [ProportionsSettings, unknown];
    expect(blocks).toEqual([
      { panel: { group: "control" }, row: 0, column: 0 },
      { panel: { group: "treated" }, row: 1, column: 0 },
    ]);

    act(() =>
      root.render(
        <I18nProvider>
          {surface(fx, settings, { group: "treated" }, "panel-x")}
          {surface(fx, settings, { legend: true }, "legend-x")}
        </I18nProvider>,
      ),
    );
    // The treated panel alone: D2's Small and Large, no legend.
    expect(host.querySelectorAll("#panel-x svg.gl-prop-panel")).toHaveLength(1);
    expect(host.querySelectorAll("#panel-x path.gl-prop-mark")).toHaveLength(2);
    expect(host.querySelector<HTMLElement>("#panel-x .gl-prop-legend")!.hidden).toBe(true);
    expect(host.querySelectorAll("#legend-x svg.gl-prop-panel")).toHaveLength(0);
    expect(host.querySelector<HTMLElement>("#legend-x .gl-prop-legend")!.hidden).toBe(false);

    // A block of one panel is framed at the panel's size, smaller than the whole chart's.
    const files = proportionsSampleRefs(fx.samples.map((s) => ({ ...s, fileName: s.name })) as never);
    const metadata = { D1: { condition: "control" }, D2: { condition: "treated" } };
    const whole = plottingBlockSizer(settings, files, fx.state, metadata, {}, { "FSC-A": [0, 100] })!(createLayoutSheet());
    const one = plottingBlockSizer(settings, files, fx.state, metadata, {}, { "FSC-A": [0, 100] }, { group: "treated" })!(createLayoutSheet());
    expect(one.height).toBeLessThan(whole.height);
    expect(one.width).toBeLessThan(whole.width);
  });
});


describe("Plotting tab: split violin and ridgelines", () => {
  const typeRadio = (label: string) => [...host.querySelectorAll<HTMLInputElement>('input[name="prop-type"]')].find((input) => input.parentElement!.textContent === label)!;
  const setAlongX = (value: "populations" | "groups") =>
    act(() => {
      const select = host.querySelector<HTMLSelectElement>(`select[aria-label="Place ${value === "groups" ? "condition" : "Populations"}"]`)!;
      select.value = "x";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

  it("offers the split violin only with the two groups along x, says why not otherwise, and draws a split violin per population", () => {
    const fx = fixture();
    mount(fx);
    chooseCells();
    expect(typeRadio("Split violin").disabled).toBe(true);
    expect(typeRadio("Split violin").parentElement!.title).toContain("exactly two groups");
    expect(typeRadio("Ridgelines").parentElement!.title).toContain("Illustration tab draws ridgelines of single files with gates");
    setAlongX("groups");
    expect(typeRadio("Split violin").disabled).toBe(false);
    act(() => typeRadio("Split violin").click());
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS).plotType).toBe("splitViolin");
    expect(labelled("Median and quartiles inside").disabled).toBe(false);
    expect(panelTitles()).toEqual(["Small", "Large"]);
    expect(host.querySelectorAll("#gl-prop-svg path.gl-prop-mark")).toHaveLength(4);
    expect(host.querySelectorAll("#gl-prop-svg line.gl-prop-split-median")).toHaveLength(4);
    // Back to the populations along x: whole violins, the choice kept for when the groups return.
    setAlongX("populations");
    expect(host.querySelectorAll("#gl-prop-svg line.gl-prop-split-median")).toHaveLength(0);
    expect(typeRadio("Split violin").checked).toBe(true);
  });

  it("exports the split violin and draws it on a Layout block framed as a violin is", () => {
    const fx = fixture();
    const onAddToLayout = vi.fn();
    restorePlottingState({ "prop.xAxis": "groups" });
    mount(fx, { onAddToLayout });
    chooseCells();
    act(() => typeRadio("Split violin").click());
    expect(composeProportionsChartSvg("gl-prop-svg")!.root.querySelectorAll("line.gl-prop-split-median")).toHaveLength(4);
    act(() => button("Add to Layout")!.click());
    const settings = onAddToLayout.mock.calls[0][0] as ProportionsSettings;
    expect(settings.plotType).toBe("splitViolin");
    const files = proportionsSampleRefs(fx.samples.map((s) => ({ ...s, fileName: s.name })) as never);
    const metadata = { D1: { condition: "control" }, D2: { condition: "treated" } };
    const frame = (s: ProportionsSettings) => plottingBlockSizer(s, files, fx.state, metadata, {}, { "FSC-A": [0, 100] })!(createLayoutSheet());
    expect(frame(settings)).toEqual(frame({ ...settings, plotType: "violin" }));
    act(() =>
      root.render(
        <I18nProvider>
          <LayoutProportionsSurface
            recipe={{ kind: "proportions", settings }}
            samples={fx.samples.map((s) => ({ ...s, fileName: s.name })) as never}
            state={fx.state}
            metadataById={metadata}
            divisionProfiles={{}}
            width={600}
            height={400}
            containerId="layout-split"
            globalScales={{ "FSC-A": [0, 100] }}
          />
        </I18nProvider>,
      ),
    );
    expect(host.querySelectorAll("#layout-split line.gl-prop-split-median")).toHaveLength(4);
  });

  it("draws ridgelines in the tab, its export and a Layout block, and frames a block of one panel at the panel's size", () => {
    const fx = fixture();
    const onAddToLayout = vi.fn();
    // The chart's own text sizes, whose panel is a whole number of pixels high.
    restorePlottingState({ "prop.showN": true, "prop.followFigureStyle": false });
    mount(fx, { onAddToLayout });
    chooseCells();
    act(() => typeRadio("Ridgelines").click());
    expect(labelled("Median and quartiles inside").disabled).toBe(true);
    // A panel per group, a row per population.
    expect(panelTitles()).toEqual(["condition: control", "condition: treated"]);
    expect(host.querySelectorAll("#gl-prop-svg path.gl-prop-mark")).toHaveLength(4);
    expect([...host.querySelectorAll("#gl-prop-svg text.gl-prop-n")].map((text) => text.textContent)).toEqual(["n = 2", "n = 3", "n = 2", "n = 2"]);
    expect(composeProportionsChartSvg("gl-prop-svg")!.root.querySelectorAll("path.gl-prop-mark")).toHaveLength(4);
    const drawn = [...host.querySelectorAll("#gl-prop-svg svg.gl-prop-panel")][1];
    act(() => button("Add to Layout")!.click());
    const settings = onAddToLayout.mock.calls[0][0] as ProportionsSettings;
    expect(settings.plotType).toBe("ridgeline");

    const files = proportionsSampleRefs(fx.samples.map((s) => ({ ...s, fileName: s.name })) as never);
    const metadata = { D1: { condition: "control" }, D2: { condition: "treated" } };
    const model = buildCellValuesModel(settings, files, fx.state, metadata);
    const axis = cellChartAxis(model, "gating", [0, 100])!;
    expect(cellValuesBlockFrame(settings, model, axis, null, { group: "treated" })).toEqual({
      width: Math.round(Number(drawn.getAttribute("width")) + 24),
      height: Math.round(Number(drawn.getAttribute("height")) + 24),
    });
    const frame = (extra: Partial<ProportionsSettings>) => plottingBlockSizer({ ...settings, ...extra }, files, fx.state, metadata, {}, { "FSC-A": [0, 100] })!(createLayoutSheet());
    expect(frame({ panelWidth: 400 }).width).toBe(2 * 400 + 12 + 24 + SHEET_BLOCK_CHROME);
    expect(frame({ panelsPerRow: 1 }).height).toBeGreaterThan(frame({}).height);
    act(() =>
      root.render(
        <I18nProvider>
          <LayoutProportionsSurface
            recipe={{ kind: "proportions", settings, panel: { group: "treated" } }}
            samples={fx.samples.map((s) => ({ ...s, fileName: s.name })) as never}
            state={fx.state}
            metadataById={metadata}
            divisionProfiles={{}}
            width={600}
            height={400}
            containerId="layout-ridges"
            globalScales={{ "FSC-A": [0, 100] }}
          />
        </I18nProvider>,
      ),
    );
    expect(host.querySelectorAll("#layout-ridges svg.gl-prop-panel")).toHaveLength(1);
    expect(host.querySelectorAll("#layout-ridges path.gl-prop-mark")).toHaveLength(2);
  });
});

describe("Plotting tab: pages", () => {
  const choose = (label: string, value: string) =>
    act(() => {
      const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`) ?? labelled(label);
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const pager = () => host.querySelector(".gl-prop-pager span")?.textContent;
  const surface = (fx: ReturnType<typeof fixture>, settings: ProportionsSettings, panel: unknown, id: string) => (
    <LayoutProportionsSurface
      recipe={{ kind: "proportions", settings, panel: panel as never }}
      samples={fx.samples.map((s) => ({ ...s, fileName: s.name })) as never}
      state={fx.state}
      metadataById={{ D1: { condition: "control" }, D2: { condition: "treated" } }}
      divisionProfiles={{}}
      width={600}
      height={400}
      containerId={id}
      globalScales={{ "FSC-A": [0, 100] }}
    />
  );

  it("draws a page per value with the pager, exports the page shown, and hands that page to the Layout tab, whose block keeps drawing it", () => {
    const fx = fixture();
    const onAddToLayout = vi.fn();
    const onAddPanelsToLayout = vi.fn();
    mount(fx, { onAddToLayout, onAddPanelsToLayout });
    chooseCells();
    choose("Facet", "__sample__");
    choose("Place Files", "pages");
    expect(savedPlottingState()["prop.pageBy"]).toBe("facet");
    expect([...host.querySelectorAll('[data-shelf="pages"] .gl-figure-dimension > span')].map((s) => s.textContent)).toEqual(["Files"]);
    // The first page: D1's panels, a panel per condition.
    expect(pager()).toBe("Page 1 of 2 · File: D1.fcs");
    expect(panelTitles()).toEqual(["condition: control · File: D1.fcs", "condition: treated · File: D1.fcs"]);
    expect(button("Previous")!.disabled).toBe(true);
    act(() => button("Next")!.click());
    expect(pager()).toBe("Page 2 of 2 · File: D2.fcs");
    expect(panelTitles()).toEqual(["condition: control · File: D2.fcs", "condition: treated · File: D2.fcs"]);
    expect(button("Next")!.disabled).toBe(true);
    // The export writes the page shown, as Illustration's does, and says so.
    expect(host.textContent).toContain("Export writes the page shown, page 2 of 2.");
    const exported = composeProportionsChartSvg("gl-prop-svg")!;
    expect(exported.root.querySelectorAll("svg.gl-prop-panel")).toHaveLength(2);
    // "Add to Layout" names the page shown; "Add panels to Layout" sends that page's panels.
    act(() => button("Add to Layout")!.click());
    const [settings, panel] = onAddToLayout.mock.calls[0] as [ProportionsSettings, unknown];
    expect(settings.pageBy).toBe("facet");
    expect(panel).toEqual({ page: "D2.fcs" });
    act(() => button("Add panels to Layout")!.click());
    const [, blocks] = onAddPanelsToLayout.mock.calls[0] as [ProportionsSettings, { panel: Record<string, string>; row: number; column: number }[]];
    expect(blocks.map(({ panel: p, row, column }) => [p.facet, p.group, row, column])).toEqual([["D2.fcs", "control", 0, 0], ["D2.fcs", "treated", 0, 1]]);

    // A block of a page draws that page's panels with the legend; another page's block, its own.
    act(() =>
      root.render(
        <I18nProvider>
          {surface(fx, settings, { page: "D2.fcs" }, "page-2")}
          {surface(fx, settings, { page: "D1.fcs" }, "page-1")}
          {surface(fx, settings, { page: "D3.fcs" }, "page-gone")}
        </I18nProvider>,
      ),
    );
    const titles = (id: string) => [...host.querySelectorAll(`#${id} svg.gl-prop-panel`)].map((svg) => svg.querySelector("text > title")?.textContent);
    expect(titles("page-2")).toEqual(["condition: control · File: D2.fcs", "condition: treated · File: D2.fcs"]);
    expect(titles("page-1")).toEqual(["condition: control · File: D1.fcs", "condition: treated · File: D1.fcs"]);
    expect(host.querySelector<HTMLElement>("#page-2 .gl-prop-legend")!.hidden).toBe(false);
    // D2's control panel holds no cells; its treated panel D2's Small 2 and Large 2.
    expect(host.querySelectorAll("#page-2 path.gl-prop-mark")).toHaveLength(2);
    expect(host.textContent).toContain("No panel for page D3.fcs in this chart.");
    // A block of a page is framed for the page's panels, smaller than the whole chart's.
    const files = proportionsSampleRefs(fx.samples.map((s) => ({ ...s, fileName: s.name })) as never);
    const metadata = { D1: { condition: "control" }, D2: { condition: "treated" } };
    const whole = plottingBlockSizer({ ...settings, pageBy: "" }, files, fx.state, metadata, {}, { "FSC-A": [0, 100] })!(createLayoutSheet());
    const onePage = plottingBlockSizer(settings, files, fx.state, metadata, {}, { "FSC-A": [0, 100] }, { page: "D2.fcs" })!(createLayoutSheet());
    expect(onePage.width).toBeLessThan(whole.width);
  });

  it("opens a chart saved before pages as it was drawn, on one page", () => {
    const fx = fixture();
    restorePlottingState({ "prop.valueKind": "cells", "prop.plotType": "violin", "prop.facetSel": "__sample__", "prop.panelsPerRow": 2 });
    mount(fx);
    expect(host.querySelector(".gl-prop-pager")).toBeNull();
    expect(panelTitles()).toHaveLength(4);
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS).pageBy).toBe("");
  });
});

describe("Plotting tab: a block per panel of a grid by rows and columns", () => {
  it("sends each panel with its row and column in the grid, and a block draws its panel with its whole title", () => {
    const fx = fixture();
    const onAddPanelsToLayout = vi.fn();
    mount(fx, { onAddToLayout: vi.fn(), onAddPanelsToLayout });
    chooseCells();
    act(() => {
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="Facet"]') ?? labelled("Facet");
      select.value = "__sample__";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    for (const [chip, shelf] of [["Populations", "columns"], ["Files", "rows"]]) {
      act(() => {
        const select = host.querySelector<HTMLSelectElement>(`select[aria-label="Place ${chip}"]`)!;
        select.value = shelf;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    act(() => button("Add panels to Layout")!.click());
    const [settings, blocks] = onAddPanelsToLayout.mock.calls[0] as [ProportionsSettings, { panel: Record<string, string>; row: number; column: number }[]];
    expect(settings.panelRows).toBe("facet");
    expect(blocks.map(({ panel, row, column }) => [panel.facet, panel.population, row, column])).toEqual([
      ["D1.fcs", "Small", 0, 0],
      ["D1.fcs", "Large", 0, 1],
      ["D2.fcs", "Small", 1, 0],
      ["D2.fcs", "Large", 1, 1],
    ]);
    act(() =>
      root.render(
        <I18nProvider>
          <LayoutProportionsSurface
            recipe={{ kind: "proportions", settings, panel: blocks[3].panel as never }}
            samples={fx.samples.map((s) => ({ ...s, fileName: s.name })) as never}
            state={fx.state}
            metadataById={{ D1: { condition: "control" }, D2: { condition: "treated" } }}
            divisionProfiles={{}}
            width={600}
            height={400}
            containerId="grid-panel"
            globalScales={{ "FSC-A": [0, 100] }}
          />
        </I18nProvider>,
      ),
    );
    // One panel, no headings: its title says its population and its file.
    expect(host.querySelectorAll("#grid-panel svg.gl-prop-panel")).toHaveLength(1);
    expect(host.querySelectorAll("#grid-panel svg.gl-prop-heading")).toHaveLength(0);
    expect(host.querySelector("#grid-panel svg.gl-prop-panel text > title")?.textContent).toBe("Large · File: D2.fcs");
  });
});

describe("Plotting tab: several channels", () => {
  // The fixture's files with side scatter that varies, so each channel has an axis of its own:
  // D1's SSC is 200 to 600, D2's 250 to 550; the gates take every SSC from 0 to 1000.
  function twoChannelFixture() {
    const fx = fixture();
    const ssc: Record<string, number[]> = { D1: [200, 300, 400, 500, 600], D2: [250, 350, 450, 550] };
    const fscOf: Record<string, number[]> = { D1: [10, 20, 30, 40, 50], D2: [15, 18, 35, 45] };
    const samples = fx.samples.map((entry) => {
      const fsc = fscOf[entry.id];
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
        columns: [Float32Array.from(ssc[entry.id]), Float32Array.from(fsc)],
      };
      return { ...entry, sample: new Sample(fcs) };
    });
    return { ...fx, samples };
  }
  const choose = (label: string, value: string) =>
    act(() => {
      const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const tick = (label: string) => act(() => [...host.querySelectorAll<HTMLLabelElement>(".gl-prop-channels label")].find((l) => l.textContent === label)!.querySelector("input")!.click());
  const axisTitles = (id = "gl-prop-svg") => [...host.querySelectorAll(`#${id} svg.gl-prop-panel`)].map((svg) => [...svg.querySelectorAll("text")].map((t) => t.textContent).find((text) => text === "FSC-A" || text === "SSC-A"));
  const surface = (fx: ReturnType<typeof fixture>, settings: ProportionsSettings, panel: unknown, id: string) => (
    <LayoutProportionsSurface
      recipe={{ kind: "proportions", settings, panel: panel as never }}
      samples={fx.samples.map((s) => ({ ...s, fileName: s.name })) as never}
      state={fx.state}
      metadataById={{ D1: { condition: "control" }, D2: { condition: "treated" } }}
      divisionProfiles={{}}
      width={900}
      height={600}
      containerId={id}
      globalScales={{ "FSC-A": [0, 100] }}
    />
  );

  it("draws each channel in panels of its own on its own value axis, as a dimension on the shelves, in its CSV and on the Layout tab", async () => {
    const fx = twoChannelFixture();
    const onAddToLayout = vi.fn();
    const onAddPanelsToLayout = vi.fn();
    mount(fx, { onAddToLayout, onAddPanelsToLayout });
    chooseCells();
    // One channel: no Channels chip, the chart as before.
    expect(host.querySelector('[aria-label="Place Channels"]')).toBeNull();
    tick("SSC-A");
    expect(savedPlottingState()).toMatchObject({ "prop.channel": "FSC-A", "prop.channels": ["FSC-A", "SSC-A"] });
    // A panel per group for each channel, the channel's panels after the other's, each titled with its channel.
    expect(panelTitles()).toEqual(["condition: control · FSC-A", "condition: treated · FSC-A", "condition: control · SSC-A", "condition: treated · SSC-A"]);
    expect(axisTitles()).toEqual(["FSC-A", "FSC-A", "SSC-A", "SSC-A"]);
    // Each channel's axis is its own: FSC on the Gating tab's 0 to 100, SSC fitted to its cells.
    const tickLabels = (i: number) => [...[...host.querySelectorAll("#gl-prop-svg svg.gl-prop-panel")][i].querySelectorAll("text")].map((t) => t.textContent);
    expect(tickLabels(0)).toContain("100");
    expect(tickLabels(2)).not.toContain("100");
    // The SSC violins hold the gate's cells: D1's Small 2 and Large 3, D2's Small 2 and Large 2.
    const tips = [...host.querySelectorAll("#gl-prop-svg path.gl-prop-mark")].map((path) => path.querySelector("title")?.textContent);
    expect(tips.slice(4)).toEqual([
      "Small · control: 2 cells from 1 file, median 250",
      "Large · control: 3 cells from 1 file, median 500",
      "Small · treated: 2 cells from 1 file, median 300",
      "Large · treated: 2 cells from 1 file, median 500",
    ]);
    // "Channels" is a chip that goes on a panel shelf, never along x.
    expect([...host.querySelectorAll<HTMLOptionElement>('select[aria-label="Place Channels"] option')].map((o) => `${o.value}${o.disabled ? " (off)" : ""}`)).toEqual(["x (off)", "columns", "rows", "pages", "wrap"]);
    expect(host.textContent).toContain("they do not run along x");
    choose("Place Channels", "columns");
    choose("Place condition", "rows");
    expect(host.querySelector<HTMLDivElement>("#gl-prop-svg .gl-prop-panels")!.style.gridTemplateColumns).toBe("max-content repeat(2, max-content)");
    expect([...host.querySelectorAll('#gl-prop-svg svg.gl-prop-heading[data-heading="column"] title')].map((t) => t.textContent)).toEqual(["FSC-A", "SSC-A"]);

    // The CSV leads each row with its channel; the value columns are named without one.
    const blobs: Blob[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (blob: Blob) => (blobs.push(blob), "blob:x"), revokeObjectURL: () => undefined }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    act(() => button("Data (CSV)")!.click());
    const lines = (await blobs[0].text()).split("\r\n");
    expect(lines[0]).toBe("Channel,condition,Population,Files,Cells,Median,Q1,Q3,Lower whisker,Upper whisker");
    expect(lines.filter((line) => line.startsWith("FSC-A,"))).toHaveLength(4);
    expect(lines.filter((line) => line.startsWith("SSC-A,"))).toHaveLength(4);
    // D1's Large cells by side scatter: 400, 500, 600, median 500.
    expect(lines.some((line) => line.startsWith("SSC-A,control,Large,D1.fcs,3,500,"))).toBe(true);
    click.mockRestore();

    // A block per panel names its channel; a block of one channel's panel draws it on that channel's axis.
    act(() => button("Add panels to Layout")!.click());
    const [settings, blocks] = onAddPanelsToLayout.mock.calls[0] as [ProportionsSettings, { panel: Record<string, string>; row: number; column: number }[]];
    expect(settings.channels).toEqual(["FSC-A", "SSC-A"]);
    expect(blocks.map(({ panel, row, column }) => [panel.channel, panel.group, row, column])).toEqual([
      ["FSC-A", "control", 0, 0],
      ["SSC-A", "control", 0, 1],
      ["FSC-A", "treated", 1, 0],
      ["SSC-A", "treated", 1, 1],
    ]);
    act(() =>
      root.render(
        <I18nProvider>
          {surface(fx, settings, undefined, "whole")}
          {surface(fx, settings, { channel: "SSC-A", group: "treated" }, "one")}
        </I18nProvider>,
      ),
    );
    expect(axisTitles("whole")).toEqual(["FSC-A", "SSC-A", "FSC-A", "SSC-A"]);
    expect(axisTitles("one")).toEqual(["SSC-A"]);
    expect([...host.querySelectorAll("#one path.gl-prop-mark")].map((path) => path.querySelector("title")?.textContent)).toEqual([
      "Small · treated: 2 cells from 1 file, median 300",
      "Large · treated: 2 cells from 1 file, median 500",
    ]);
  });

  it("puts the channels on pages, and a statistic chart draws each channel on its own axis", () => {
    const fx = twoChannelFixture();
    mount(fx);
    chooseCells();
    tick("SSC-A");
    choose("Place Channels", "pages");
    expect(host.querySelector(".gl-prop-pager span")?.textContent).toBe("Page 1 of 2 · FSC-A");
    expect(axisTitles()).toEqual(["FSC-A", "FSC-A"]);
    act(() => button("Next")!.click());
    expect(axisTitles()).toEqual(["SSC-A", "SSC-A"]);
    // A statistic of each file's cells: a panel per group for each channel, each on its own axis.
    choose("Place Channels", "wrap");
    act(() => radio("prop-value", 2).click());
    const titles = [...host.querySelectorAll("#gl-prop-svg svg.gl-prop-panel")].map((svg) => [...svg.querySelectorAll("text > title")].map((t) => t.textContent));
    expect(titles.map((texts) => texts.find((text) => text?.startsWith("Median")))).toEqual(["Median FSC-A", "Median FSC-A", "Median SSC-A", "Median SSC-A"]);
  });

  it("opens a chart saved with one channel as it was drawn", () => {
    const fx = twoChannelFixture();
    restorePlottingState({ "prop.valueKind": "cells", "prop.plotType": "violin", "prop.channel": "SSC-A" });
    mount(fx);
    expect(panelTitles()).toEqual(["condition: control", "condition: treated"]);
    expect(readProportionsSettings(BASE_PROPORTIONS_SETTINGS).channels).toEqual(["SSC-A"]);
  });
});
