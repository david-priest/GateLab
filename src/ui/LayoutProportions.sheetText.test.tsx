// @vitest-environment jsdom
// A Plotting block on a Layout sheet drawn with the sheet's text sizes: laid out to its frame's
// size, its text the sheet's (as a flow plot's is), clipped and marked in a frame too small for
// it, and its measured-value ticks written as the flow plots write them. A block saved before
// the choice keeps its own sizes, zoomed. Synthetic files D1 to D4, groups control and treated;
// nothing here is a real experiment.

import { act, forwardRef, useImperativeHandle, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, type CoreState } from "../store";
import { BASE_PROPORTIONS_SETTINGS, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "../engine/proportionsSettings";
import { createDefaultLayoutWorkspace, DEFAULT_LAYOUT_STYLE, normalizeLayoutWorkspace, type LayoutPlotStyle, type LayoutProportionsRecipe, type LayoutWorkspace } from "../engine/layout";
import { I18nProvider } from "./i18n";
import { LayoutProportionsSurface } from "./LayoutProportions";
import { LayoutTab } from "./LayoutTab";
import { formatLinearTick, formatMeasured } from "./chart/chartFormat";

const draws = vi.hoisted(() => ({ plots: [] as Record<string, unknown>[], selecto: null as Record<string, any> | null }));
vi.mock("../plots/loadPlots", () => ({
  loadMiniPlots: () => ({
    renderMiniPlot: (host: HTMLElement, config: Record<string, unknown>) => {
      draws.plots.push(config);
      host.setAttribute("style", "position: relative; width: 200px; height: 200px;");
    },
    renderStrategyGrid: () => {},
  }),
}));
vi.mock("../plots/layoutExport", () => ({ composeSheetPages: () => [], writeComposedPages: async () => {} }));
vi.mock("react-moveable", () => ({
  default: forwardRef((_props: Record<string, any>, ref) => {
    useImperativeHandle(ref, () => ({ isMoveableElement: () => false, waitToChangeTarget: async () => {}, dragStart: () => {}, stopDrag: () => {}, updateRect: () => {} }));
    return null;
  }),
}));
vi.mock("react-selecto", () => ({
  default: forwardRef((props: Record<string, any>, ref) => {
    draws.selecto = props;
    useImperativeHandle(ref, () => ({ setSelectedTargets: () => {}, clickTarget: () => {} }));
    return null;
  }),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  draws.plots = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// FSC-A in raw units; the gate CD4_positive holds FSC from 1000. Per file: D1 (control) 1200,
// 2400, 500; D2 (treated) 3100, 4200; D3 (control) 1500, 300; D4 (treated) 3600, 5100, 200.
const FSC: Record<string, number[]> = { D1: [1200, 2400, 500], D2: [3100, 4200], D3: [1500, 300], D4: [3600, 5100, 200] };
const METADATA = { D1: { condition: "control" }, D2: { condition: "treated" }, D3: { condition: "control" }, D4: { condition: "treated" } };

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
  const file = (id: string) => {
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
    return { id, name: `${id}.fcs`, fileName: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs), metadata: METADATA[id as keyof typeof METADATA] };
  };
  const settings: ProportionsSettings = {
    ...BASE_PROPORTIONS_SETTINGS,
    valueKind: "statistic",
    plotType: "dots",
    channel: "FSC-A",
    statistic: "median",
    xAxis: "groups",
    files: ["D1", "D2", "D3", "D4"],
    hierarchy: DEFAULT_HIERARCHY_ID,
    parent: rootPop.population_id,
    selectedPops: [pop.population_id],
    groupSel: "condition",
    unitSel: PROPORTIONS_SAMPLE_FACTOR,
    legend: false,
  };
  return { state: state as CoreState, samples: ["D1", "D2", "D3", "D4"].map(file), rootId: rootPop.population_id, popId: pop.population_id, settings };
}

const SHEET_STYLE: LayoutPlotStyle = { ...DEFAULT_LAYOUT_STYLE, fontTick: 13, fontAxis: 15, fontTitle: 16, fontLegend: 12 };

function surface(fx: ReturnType<typeof fixture>, recipe: LayoutProportionsRecipe, width: number, height: number) {
  act(() =>
    root.render(
      <I18nProvider>
        <LayoutProportionsSurface
          recipe={recipe}
          samples={fx.samples as never}
          state={fx.state}
          metadataById={METADATA}
          divisionProfiles={{}}
          width={width}
          height={height}
          containerId="block"
          sheetStyle={SHEET_STYLE}
        />
      </I18nProvider>,
    ),
  );
}

const panel = () => host.querySelector<SVGSVGElement>("#block svg.gl-prop-panel")!;
/** The value axis's tick labels: the text at the axis's left, anchored at its end. */
const valueTicks = () => [...panel().querySelectorAll("text[text-anchor='end']")].map((text) => text.textContent);
const tickFont = () => panel().querySelector("text[text-anchor='end']")!.getAttribute("font-size");

describe("A Plotting block with the sheet's text sizes", () => {
  it("is redrawn at its frame's size: resizing changes its panel, not its text", () => {
    const fx = fixture();
    const recipe: LayoutProportionsRecipe = { kind: "proportions", settings: fx.settings, panel: {}, textSize: "sheet" };
    surface(fx, recipe, 300, 260);
    const small = { width: Number(panel().getAttribute("width")), height: Number(panel().getAttribute("height")), font: tickFont() };
    surface(fx, recipe, 520, 420);
    const large = { width: Number(panel().getAttribute("width")), height: Number(panel().getAttribute("height")), font: tickFont() };
    expect(small.font).toBe("13");
    expect(large.font).toBe("13");
    // The panel fills the frame less the frame functions' 24 px and the 12 px about a block.
    expect(small.width).toBe(300 + 8 - 12 - 24);
    expect(large.width).toBe(520 + 8 - 12 - 24);
    expect(large.height).toBeGreaterThan(small.height);
    expect(host.querySelector("#block")!.closest(".gl-layout-proportions-host")!.querySelector("[style*='zoom']")!.getAttribute("style")).toContain("zoom: 1");
    expect(host.textContent).not.toContain("too small");
    // The panel title takes the sheet's title size.
    expect(panel().querySelector("text[font-weight='600']")!.getAttribute("font-size")).toBe("16");
  });

  it("is clipped and marked in a frame too small for it at the sheet's sizes", () => {
    const fx = fixture();
    surface(fx, { kind: "proportions", settings: fx.settings, panel: {}, textSize: "sheet" }, 60, 50);
    expect(tickFont()).toBe("13");
    expect(host.querySelector(".gl-layout-too-small")?.textContent).toBe("too small");
  });

  it("writes its measured-value ticks as the flow plots do", () => {
    const fx = fixture();
    surface(fx, { kind: "proportions", settings: fx.settings, panel: {}, textSize: "sheet" }, 400, 320);
    const ticks = valueTicks();
    expect(ticks.some((label) => label?.endsWith("K"))).toBe(true);
    expect(ticks.every((label) => !label?.includes(","))).toBe(true);
  });

  it("draws a block saved without the choice as before: its own sizes, zoomed", () => {
    const fx = fixture();
    surface(fx, { kind: "proportions", settings: fx.settings, panel: {} }, 300, 260);
    expect(tickFont()).toBe(String(fx.settings.fontTick));
    expect(valueTicks()).toEqual(valueTicks().map((label) => formatMeasured(Number(label!.replace(/,/g, "")))));
    expect(host.querySelector(".gl-layout-too-small")).toBeNull();
    expect(host.querySelector(".gl-layout-proportions-host")!.innerHTML).toMatchSnapshot();
  });
});

describe("The flow plots' tick format", () => {
  it("is what mini_plot.js _formatLinearVal writes, beside the Plotting tab's", () => {
    const values = [0, 0.125, 2.5, 12.34, 150.5, 1000, 1500, 25000, 2500000, -1500];
    expect(values.map(formatLinearTick)).toEqual(["0", "0.13", "2.5", "12.3", "151", "1K", "1.5K", "25K", "2.5M", "-1.5K"]);
    expect(values.map(formatMeasured)).toEqual(["0", "0.125", "2.5", "12.34", "150.5", "1,000", "1,500", "25,000", "2,500,000", "-1,500"]);
  });
});

function layoutWorkspace(fx: ReturnType<typeof fixture>, textSize?: "sheet"): LayoutWorkspace {
  const saved = JSON.parse(JSON.stringify(createDefaultLayoutWorkspace()));
  saved.sheets[0].style = { fontTick: 13, fontAxis: 15, fontTitle: 16 };
  saved.sheets[0].items = [
    { id: "flow", x: 60, y: 60, width: 220, height: 220, z: 0, recipe: { kind: "biplot", sampleId: "D1", populationId: fx.rootId, xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "scatter" } },
    { id: "chart", x: 300, y: 60, width: 320, height: 260, z: 1, recipe: { kind: "proportions", settings: fx.settings, panel: {}, ...(textSize ? { textSize } : {}) } },
  ];
  return normalizeLayoutWorkspace(saved);
}

function mountLayout(fx: ReturnType<typeof fixture>, initial: LayoutWorkspace) {
  const changes: LayoutWorkspace[] = [];
  function Harness() {
    const [workspace, setWorkspace] = useState(initial);
    return (
      <I18nProvider>
        <LayoutTab
          workspace={workspace}
          onChange={(next) => { changes.push(next); setWorkspace(next); }}
          samples={fx.samples as never}
          checkedSampleIds={["D1", "D2", "D3", "D4"]}
          metadataColumns={["condition"]}
          activeSampleId="D1"
          activePopulationId={fx.rootId}
          state={fx.state}
          globalScales={{}}
          defaultX="FSC-A"
          defaultY="SSC-A"
          illustrationConfig={null}
          dataRevision={0}
          densityColorPower={1.6}
          onOpenInGating={vi.fn()}
        />
      </I18nProvider>
    );
  }
  act(() => root.render(<Harness />));
  return changes;
}

describe("A Plotting block and a flow plot on one sheet", () => {
  it("have the same tick font size when the block takes the sheet's text sizes", async () => {
    vi.useFakeTimers();
    const fx = fixture();
    mountLayout(fx, layoutWorkspace(fx, "sheet"));
    for (let i = 0; i < 5; i++) await act(async () => { await vi.runAllTimersAsync(); });
    const flow = draws.plots.at(-1)!.font_sizes as { tick: number };
    const chartTick = host.querySelector('[data-item-id="chart"] svg.gl-prop-panel text[text-anchor="end"]')!.getAttribute("font-size");
    expect(flow.tick).toBe(13);
    expect(chartTick).toBe("13");
  });

  it("keeps a block saved before the choice at its own sizes, and the inspector switches it to the sheet's", async () => {
    vi.useFakeTimers();
    const fx = fixture();
    const changes = mountLayout(fx, layoutWorkspace(fx));
    for (let i = 0; i < 5; i++) await act(async () => { await vi.runAllTimersAsync(); });
    const chartTick = () => host.querySelector('[data-item-id="chart"] svg.gl-prop-panel text[text-anchor="end"]')!.getAttribute("font-size");
    expect(chartTick()).toBe(String(fx.settings.fontTick));
    act(() => { draws.selecto!.onSelectEnd({ selected: [host.querySelector('[data-item-id="chart"]')], isDragStart: false, isClick: true, inputEvent: {} }); });
    const select = [...host.querySelectorAll<HTMLLabelElement>("label")].find((label) => label.textContent?.startsWith("Text size"))!.querySelector("select")!;
    expect(select.value).toBe("chart");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "sheet");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect((changes.at(-1)!.sheets[0].items[1].recipe as LayoutProportionsRecipe).textSize).toBe("sheet");
    expect(chartTick()).toBe("13");
  });
});
