// @vitest-environment jsdom
// The workspace's figure style: its editor shows points and stores px, edits the gate ink beside
// the sizes and resets to the defaults; and one change in it reaches a Layout sheet (its flow plot
// and its Plotting block), a Plotting chart and an Illustration figure that follow it, while a
// sheet saved before the style keeps its own sizes. Synthetic files D1 and D2, population
// CD4_positive; nothing here is a real experiment.

import { act, forwardRef, useImperativeHandle, useMemo, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { BASE_PROPORTIONS_SETTINGS, PROPORTIONS_SAMPLE_FACTOR, type ProportionsSettings } from "../engine/proportionsSettings";
import { createDefaultLayoutWorkspace, normalizeLayoutWorkspace, type LayoutWorkspace } from "../engine/layout";
import { DEFAULT_FIGURE_STYLE, type FigureStyle } from "../engine/figureStyle";
import { defaultIllustrationConfig } from "../engine/figureDefaults";
import type { IllustrationConfig } from "../engine/workspace";
import { DEFAULT_GATE_LINE_WIDTH, GateInkContext, type GateInk } from "../plots/gateInk";
import { I18nProvider } from "./i18n";
import { FigureStyleFollow, FigureStyleProvider, ptFromPx, pxFromPt } from "./figureStyle";
import { LayoutTab } from "./LayoutTab";
import { PlottingTab } from "./PlottingTab";
import { IllustrationTab } from "./IllustrationTab";
import { clearPersistedTabState } from "./tabState";

const draws = vi.hoisted(() => ({ plots: [] as Record<string, unknown>[], figures: [] as Record<string, unknown>[] }));
vi.mock("../plots/loadPlots", () => ({
  loadMiniPlots: () => ({
    renderMiniPlot: (host: HTMLElement, config: Record<string, unknown>) => {
      draws.plots.push(config);
      host.setAttribute("style", "position: relative; width: 200px; height: 200px;");
    },
    renderStrategyGrid: () => {},
  }),
}));
vi.mock("../plots/figurePlot", () => ({
  drawFigurePlot: (node: HTMLElement, config: Record<string, unknown>) => {
    draws.figures.push(config);
    node.innerHTML = '<svg aria-label="Rendered plot"></svg>';
  },
}));
vi.mock("../plots/layoutExport", () => ({ composeSheetPages: () => [], writeComposedPages: async () => {} }));
vi.mock("react-moveable", () => ({
  default: forwardRef((_props: Record<string, unknown>, ref) => {
    useImperativeHandle(ref, () => ({ isMoveableElement: () => false, waitToChangeTarget: async () => {}, dragStart: () => {}, stopDrag: () => {}, updateRect: () => {} }));
    return null;
  }),
}));
vi.mock("react-selecto", () => ({
  default: forwardRef((_props: Record<string, unknown>, ref) => {
    useImperativeHandle(ref, () => ({ setSelectedTargets: () => {}, clickTarget: () => {} }));
    return null;
  }),
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  clearPersistedTabState();
  draws.plots = [];
  draws.figures = [];
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

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => { await vi.runAllTimersAsync(); });
}

// FSC-A in raw units; CD4_positive holds FSC from 1000. D1 (control): 1200, 2400, 500; D2 (treated): 3100, 4200.
const FSC: Record<string, number[]> = { D1: [1200, 2400, 500], D2: [3100, 4200] };
const METADATA = { D1: { condition: "control" }, D2: { condition: "treated" } };

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
    files: ["D1", "D2"],
    hierarchy: DEFAULT_HIERARCHY_ID,
    parent: rootPop.population_id,
    selectedPops: [pop.population_id],
    groupSel: "condition",
    unitSel: PROPORTIONS_SAMPLE_FACTOR,
    legend: false,
  };
  return { state: state as CoreState, samples: ["D1", "D2"].map(file), rootId: rootPop.population_id, popId: pop.population_id, settings };
}

/** A sheet with a flow plot and a Plotting block at the sheet's text sizes; its own tick size 13. */
function sheetWith(fx: ReturnType<typeof fixture>, follow: boolean): LayoutWorkspace {
  const saved = JSON.parse(JSON.stringify(createDefaultLayoutWorkspace()));
  saved.sheets[0].style = { fontTick: 13 };
  if (follow) saved.sheets[0].followFigureStyle = true;
  saved.sheets[0].items = [
    { id: "flow", x: 60, y: 60, width: 220, height: 220, z: 0, recipe: { kind: "biplot", sampleId: "D1", populationId: fx.rootId, xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "scatter" } },
    { id: "chart", x: 300, y: 60, width: 320, height: 260, z: 1, recipe: { kind: "proportions", settings: fx.settings, panel: {}, textSize: "sheet" } },
  ];
  return normalizeLayoutWorkspace(saved);
}

/** The app's two workspace settings the editor changes, held as the app holds them. */
function Workspace({ children, onStyle }: Readonly<{ children: ReactNode; onStyle?: (style: FigureStyle, ink: GateInk) => void }>) {
  const [style, setStyle] = useState<FigureStyle>({ ...DEFAULT_FIGURE_STYLE });
  const [coloured, setColoured] = useState(true);
  const [lineWidth, setLineWidth] = useState(DEFAULT_GATE_LINE_WIDTH);
  const ink = useMemo<GateInk>(() => ({ coloured, lineWidth, labelBackground: 0.85, setColoured, setLineWidth, setLabelBackground: () => undefined }), [coloured, lineWidth]);
  onStyle?.(style, ink);
  return (
    <I18nProvider>
      <GateInkContext.Provider value={ink}>
        <FigureStyleProvider style={style} onChange={setStyle}>
          <FigureStyleFollow following onFollow={() => undefined} />
          {children}
        </FigureStyleProvider>
      </GateInkContext.Provider>
    </I18nProvider>
  );
}

const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
const dialogField = (label: string) => host.querySelector<HTMLInputElement>(`.gl-figure-style-editor input[aria-label="${label}"]`)!;
function commit(input: HTMLInputElement, value: string) {
  act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  });
  act(() => input.blur());
}

describe("The figure style editor", () => {
  it("shows sizes in points, stores px, sets the gate ink and resets to the defaults", () => {
    let seen: { style: FigureStyle; ink: GateInk } | null = null;
    act(() => root.render(<Workspace onStyle={(style, ink) => { seen = { style, ink }; }}>{null}</Workspace>));
    act(() => button("Edit figure style").click());
    expect(host.querySelector(".gl-figure-style-editor")).not.toBeNull();
    // 9 px is 6.75 pt.
    expect(dialogField("Tick").value).toBe("6.75");
    expect(ptFromPx(12)).toBe(9);
    expect(pxFromPt(7)).toBe(9.33);
    commit(dialogField("Tick"), "9");
    commit(dialogField("Histogram line width"), "1.5");
    commit(dialogField("Gate line width"), "1.5");
    act(() => (host.querySelector(".gl-figure-style-editor input[type='checkbox']") as HTMLInputElement).click());
    expect(seen!.style).toEqual({ ...DEFAULT_FIGURE_STYLE, fontTick: 12, histLineWidth: 2 });
    expect(seen!.ink.lineWidth).toBe(2);
    expect(seen!.ink.coloured).toBe(false);
    act(() => button("Reset to defaults").click());
    expect(seen!.style).toEqual(DEFAULT_FIGURE_STYLE);
    expect(seen!.ink.lineWidth).toBe(DEFAULT_GATE_LINE_WIDTH);
    act(() => button("Close").click());
    expect(host.querySelector(".gl-figure-style-editor")).toBeNull();
  });
});

describe("A change to the figure style", () => {
  it("reaches a Layout sheet, a Plotting chart and an Illustration figure that follow it", async () => {
    const fx = fixture();
    const configRef: { current: IllustrationConfig | null } = {
      current: { ...defaultIllustrationConfig(), popIds: [fx.popId], xChannels: ["FSC-A"], yChannel: "SSC-A", followFigureStyle: true },
    };
    function Harness() {
      const [workspace, setWorkspace] = useState(() => sheetWith(fx, true));
      return (
        <Workspace>
          <div className="layout">
            <LayoutTab
              workspace={workspace}
              onChange={setWorkspace}
              samples={fx.samples as never}
              checkedSampleIds={["D1", "D2"]}
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
          </div>
          <div className="plotting">
            <PlottingTab
              samples={fx.samples}
              activeSampleId="D1"
              state={fx.state}
              derived={recompute(fx.samples[0].sample, fx.state)}
              metadata={METADATA}
              metadataColumns={[{ name: "condition" }]}
              divisionProfiles={{}}
              dataRevisionKey="r1"
            />
          </div>
          <div className="figure">
            <IllustrationTab
              samples={fx.samples}
              state={fx.state}
              configRef={configRef}
              checkedSampleIds={["D1", "D2"]}
              defaultX="FSC-A"
              defaultY="SSC-A"
              presets={[]}
              onSavePreset={vi.fn()}
              onDeletePreset={vi.fn()}
              onConfigChange={vi.fn()}
              onOpenGating={vi.fn()}
              dataRevision="initial"
            />
          </div>
        </Workspace>
      );
    }
    act(() => root.render(<Harness />));
    await flush();
    const flowTick = () => (draws.plots.at(-1)!.font_sizes as { tick: number }).tick;
    const blockTick = () => host.querySelector('.layout [data-item-id="chart"] svg.gl-prop-panel text[text-anchor="end"]')!.getAttribute("font-size");
    const chartTick = () => host.querySelector('.plotting svg text[text-anchor="end"]')!.getAttribute("font-size");
    const figureTick = () => (draws.figures.at(-1)!.font_sizes as { tick: number }).tick;
    // The sheet's own 13 gives way to the style's 9; a new chart and figure draw at 9 too.
    expect([flowTick(), blockTick(), chartTick(), figureTick()]).toEqual([9, "9", "9", 9]);
    // The sheet's Style shows the line in place of its fonts and line widths.
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".layout button")].find((b) => b.textContent === "Style")!.click());
    expect(host.querySelector(".layout")!.textContent).toContain("Using the workspace figure style");
    expect(host.querySelector('.layout input[aria-label="Tick font"]')).toBeNull();
    expect(host.querySelector('.layout input[aria-label="Histogram line width"]')).toBeNull();

    act(() => button("Edit figure style").click());
    commit(dialogField("Tick"), "9");
    await flush();
    expect([flowTick(), blockTick(), chartTick(), figureTick()]).toEqual([12, "12", "12", 12]);
  });

  it("leaves a sheet saved before the style at its own sizes", async () => {
    const fx = fixture();
    act(() => root.render(
      <Workspace>
        <LayoutTab
          workspace={sheetWith(fx, false)}
          onChange={vi.fn()}
          samples={fx.samples as never}
          checkedSampleIds={["D1", "D2"]}
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
      </Workspace>,
    ));
    await flush();
    act(() => button("Edit figure style").click());
    commit(dialogField("Tick"), "9");
    await flush();
    expect((draws.plots.at(-1)!.font_sizes as { tick: number }).tick).toBe(13);
    expect(host.querySelector('[data-item-id="chart"] svg.gl-prop-panel text[text-anchor="end"]')!.getAttribute("font-size")).toBe("13");
  });
});
