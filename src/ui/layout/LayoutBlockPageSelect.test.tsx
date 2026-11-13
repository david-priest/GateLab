// @vitest-environment jsdom
// The Layout inspector's Page select for a figure block and a Plotting block with pages, and the
// undo of "Every page, one sheet each". Moveable and Selecto are stood in for by props recorders,
// as in LayoutTab.test.tsx. Synthetic files D1 and D2 (control, treated); nothing here is a real experiment.
import { act, forwardRef, useImperativeHandle, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutWorkspace, type LayoutProportionsRecipe, type LayoutWorkspace } from "../../engine/layout";
import { DEFAULT_HIERARCHY_ID } from "../../engine/hierarchies";
import { newGate, newPopulation, newRootPopulation } from "../../engine/models";
import { Sample } from "../../engine/sample";
import type { FcsFile } from "../../engine/fcs";
import { figureHierarchies, migrateFigure, type FigureSample } from "../../engine/figure";
import { defaultIllustrationConfig } from "../../engine/figureDefaults";
import { defaultProportionsSettings } from "../../engine/proportionsModel";
import type { IllustrationConfig } from "../../engine/workspace";
import { initialCoreState, type CoreState } from "../../store";
import { I18nProvider } from "../i18n";
import { LayoutTab } from "../LayoutTab";
import { addFigurePageSheets } from "../layoutHandoff/everyPage";

const draws = vi.hoisted(() => ({ selecto: null as Record<string, any> | null }));
vi.mock("../../plots/loadPlots", () => ({
  loadMiniPlots: () => ({ renderMiniPlot: () => undefined, renderStrategyGrid: () => undefined }),
}));
vi.mock("../../plots/figurePlot", () => ({
  drawFigurePlot: (node: HTMLElement) => {
    node.innerHTML = "<svg></svg>";
  },
}));
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
  vi.useFakeTimers();
  draws.selecto = null;
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
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
const element = (id: string) => host.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!;
const select = (id: string) => act(() => {
  draws.selecto!.onSelectEnd({ selected: [element(id)], isDragStart: false, isClick: true, inputEvent: {} });
});
const pageSelect = () => host.querySelector<HTMLSelectElement>('select[aria-label="Page"]');
const choose = (field: HTMLSelectElement, value: string) => act(() => {
  field.value = value;
  field.dispatchEvent(new Event("change", { bubbles: true }));
});

/** D1 (control) and D2 (treated), with CD4_positive gated under the root. */
function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const gate = newGate("CD4_gate", "rectangle", "FSC-A", "SSC-A", [[0, 0], [15, 35]]);
  const child = newPopulation("CD4_positive", [{ gate_id: gate.gate_id, include: true }], rootPop.population_id);
  rootPop.children = [child.population_id];
  Object.assign(state, {
    gates: { [gate.gate_id]: gate },
    gate_order: [gate.gate_id],
    populations: { [rootPop.population_id]: rootPop, [child.population_id]: child },
    root_population_id: rootPop.population_id,
    active_population_id: rootPop.population_id,
  });
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
    columns: [Float32Array.from([10, 20, 30]), Float32Array.from([30, 20, 10])],
  };
  const samples: FigureSample[] = [
    { id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs), metadata: { condition: "control" } },
    { id: "D2", name: "D2.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs), metadata: { condition: "treated" } },
  ];
  return { state: state as CoreState, samples, rootId: rootPop.population_id };
}

/** An Illustration figure of the two files, a page per file. */
function pagedFigure(fx: ReturnType<typeof fixture>): IllustrationConfig {
  const config: IllustrationConfig = { ...defaultIllustrationConfig(), popIds: [fx.rootId], xChannels: ["FSC-A"], yChannel: "SSC-A" };
  config.figure = migrateFigure(config, fx.samples, figureHierarchies(fx.state), DEFAULT_HIERARCHY_ID, "FSC-A", "SSC-A");
  config.figure.rows = [];
  config.figure.columns = ["populations", "plots"];
  config.figure.pages = ["samples"];
  return config;
}

function mount(fx: ReturnType<typeof fixture>, initial: LayoutWorkspace, extra: Record<string, unknown> = {}) {
  const changes: LayoutWorkspace[] = [];
  function Harness() {
    const [workspace, setWorkspace] = useState(initial);
    return (
      <I18nProvider>
        <LayoutTab
          workspace={workspace}
          onChange={(next) => { changes.push(next); setWorkspace(next); }}
          samples={fx.samples}
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
          {...extra}
        />
      </I18nProvider>
    );
  }
  act(() => root.render(<Harness />));
  return changes;
}

function withItem(recipe: LayoutWorkspace["sheets"][number]["items"][number]["recipe"]): LayoutWorkspace {
  const workspace = createDefaultLayoutWorkspace();
  workspace.sheets[0].items.push({ id: "block", x: 57, y: 57, width: 400, height: 300, z: 1, recipe });
  return workspace;
}
const lastRecipe = (changes: LayoutWorkspace[]) => changes.at(-1)!.sheets[0].items[0].recipe;

describe("Layout inspector: the Page select", () => {
  it("lists a figure block's pages by label, and a change is one undo step", async () => {
    const fx = fixture();
    const changes = mount(fx, withItem({ kind: "figure", illustration: pagedFigure(fx), page: 0 }));
    await flush();
    select("block");
    const field = pageSelect()!;
    expect([...field.options].map((option) => option.textContent)).toEqual(["D1.fcs", "D2.fcs"]);
    expect(field.value).toBe("0");
    choose(field, "1");
    expect(lastRecipe(changes)).toMatchObject({ kind: "figure", page: 1 });
    act(() => button("Undo").click());
    expect(lastRecipe(changes)).toMatchObject({ kind: "figure", page: 0 });
  });

  it("is not shown for a figure of one page", async () => {
    const fx = fixture();
    const config = pagedFigure(fx);
    config.figure!.columns = ["samples", "populations", "plots"];
    config.figure!.pages = [];
    mount(fx, withItem({ kind: "figure", illustration: config, page: 0 }));
    await flush();
    select("block");
    expect(pageSelect()).toBeNull();
  });

  it("lists a Plotting block's pages as the pager names them, or the whole chart, and a change is one undo step", async () => {
    const fx = fixture();
    const settings = { ...defaultProportionsSettings(fx.samples, fx.state, [{ name: "condition" }]), plotType: "box" as const, facetSel: "__sample__", pageBy: "facet" as const };
    const changes = mount(fx, withItem({ kind: "proportions", settings, textSize: "sheet" }));
    await flush();
    select("block");
    const field = pageSelect()!;
    expect([...field.options].map((option) => option.textContent)).toEqual(["Whole chart", "File: D1.fcs", "File: D2.fcs"]);
    expect(field.value).toBe("");
    choose(field, "1");
    expect((lastRecipe(changes) as LayoutProportionsRecipe).panel).toEqual({ page: "D2.fcs" });
    expect(pageSelect()!.value).toBe("1");
    choose(pageSelect()!, "");
    expect((lastRecipe(changes) as LayoutProportionsRecipe).panel).toBeUndefined();
    act(() => button("Undo").click());
    expect((lastRecipe(changes) as LayoutProportionsRecipe).panel).toEqual({ page: "D2.fcs" });
  });

  it("is not shown for a Plotting block of one panel", async () => {
    const fx = fixture();
    const settings = { ...defaultProportionsSettings(fx.samples, fx.state, [{ name: "condition" }]), plotType: "box" as const, facetSel: "__sample__", pageBy: "facet" as const };
    mount(fx, withItem({ kind: "proportions", settings, panel: { facet: "D1.fcs" }, textSize: "sheet" }));
    await flush();
    select("block");
    expect(pageSelect()).toBeNull();
  });
});

describe("Layout: Every page, one sheet each", () => {
  it("opens on the first new sheet, and one Undo removes every sheet it added", async () => {
    const fx = fixture();
    const before = createDefaultLayoutWorkspace();
    const after = addFigurePageSheets(before, pagedFigure(fx), ["D1.fcs", "D2.fcs"], { samples: fx.samples, metadata: {}, hierarchyOfFile: () => DEFAULT_HIERARCHY_ID, state: fx.state });
    // Handed over once, as App hands it after an add, then gone.
    const takeUndoSeed = vi.fn().mockReturnValueOnce(before).mockReturnValue(null);
    const changes = mount(fx, after, { takeUndoSeed });
    await flush();
    const tabs = () => [...host.querySelectorAll<HTMLButtonElement>(".gl-layout-sheet-tab")];
    expect(tabs().map((tab) => tab.textContent)).toEqual(["Layout 1", "D1.fcs", "D2.fcs"]);
    expect(tabs().find((tab) => tab.getAttribute("aria-selected") === "true")!.textContent).toBe("D1.fcs");
    act(() => button("Undo").click());
    expect(changes.at(-1)!.sheets.map((sheet) => sheet.name)).toEqual(["Layout 1"]);
    expect(button("Undo").disabled).toBe(true);
  });
});
