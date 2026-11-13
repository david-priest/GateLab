// @vitest-environment jsdom
// A Layout plot overlaying several populations (an Illustration plot's quadrants carried to the
// Layout tab): drawn pooled under a metadata iteration, with Illustration's overlay mode, from the
// populations a file has, edited from the inspector, and added from "Add Illustration selection"
// as Illustration adds it. Synthetic files D1, D2 and D3; nothing here is a real experiment.

import { act, forwardRef, useImperativeHandle, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutWorkspace, type LayoutItem, type LayoutPlotRecipe, type LayoutProportionsRecipe, type LayoutWorkspace } from "../engine/layout";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { figureHierarchies, migrateFigure, type FigureSample } from "../engine/figure";
import { populationColor } from "../engine/palettes";
import { coreReducer, initialCoreState, type CoreState } from "../store";
import { defaultIllustrationConfig } from "../engine/figureDefaults";
import type { IllustrationConfig } from "../engine/workspace";
import { I18nProvider } from "./i18n";
import { LayoutTab } from "./LayoutTab";

const draws = vi.hoisted(() => ({
  plots: [] as { host: HTMLElement; config: Record<string, unknown> }[],
  selecto: null as Record<string, any> | null,
}));
vi.mock("../plots/loadPlots", () => ({
  loadMiniPlots: () => ({
    renderMiniPlot: (host: HTMLElement, config: Record<string, unknown>) => {
      draws.plots.push({ host, config });
    },
    renderStrategyGrid: () => {},
  }),
}));
vi.mock("react-moveable", () => ({
  default: forwardRef((_props: Record<string, any>, ref) => {
    useImperativeHandle(ref, () => ({
      isMoveableElement: () => false,
      waitToChangeTarget: async () => {},
      dragStart: () => {},
      stopDrag: () => {},
      updateRect: () => {},
    }));
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
  draws.plots = [];
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

// Each event is [FSC-A, SSC-A]; the quadrant's centre is at 50, 50. Q1 upper left, Q2 upper
// right, Q3 lower right, Q4 lower left.
const UL: [number, number] = [10, 90], UR: [number, number] = [90, 90], LR: [number, number] = [90, 10], LL: [number, number] = [10, 10];
function file(events: [number, number][]): Sample {
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: events.length,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from(events.map((e) => e[0])), Float32Array.from(events.map((e) => e[1]))],
  };
  return new Sample(fcs);
}
// Q1, Q2, Q3, Q4 counts. D1: 1, 2, 3, 0. D2: 2, 0, 1, 1. D3: 1, 1, 0, 2. Day 7 is D1 and D3.
function fixture() {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 6 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "FSC-A", yChannel: "SSC-A",
    center: [50, 50], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["Q1", "Q2", "Q3", "Q4"],
  });
  const core = state as CoreState;
  const q = Object.fromEntries(
    Object.values(core.populations).filter((p) => p.parent_id === core.root_population_id).map((p) => [p.name, p]),
  );
  const samples: FigureSample[] = [
    { id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: file([UL, UR, UR, LR, LR, LR]), metadata: { day: "7" } },
    { id: "D2", name: "D2.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: file([UL, UL, LR, LL]), metadata: { day: "0" } },
    { id: "D3", name: "D3.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: file([UL, UR, LL, LL]), metadata: { day: "7" } },
  ];
  return { core, samples, q };
}

function overlayItem(recipe: Partial<LayoutPlotRecipe> & { populationIds: string[] }): LayoutItem {
  return {
    id: "plot", x: 40, y: 40, width: 300, height: 300, z: 0,
    recipe: {
      kind: "histogram", sampleId: "D1", populationId: recipe.populationIds[0], xChannel: "FSC-A", yChannel: null,
      displayMode: "pseudocolor", ...recipe,
    } as LayoutPlotRecipe,
  };
}

function mount(fx: ReturnType<typeof fixture>, start: LayoutWorkspace, illustrationConfig: IllustrationConfig | null = null) {
  const changes: LayoutWorkspace[] = [];
  function Harness() {
    const [workspace, setWorkspace] = useState(start);
    return (
      <I18nProvider>
        <LayoutTab
          workspace={workspace}
          onChange={(next) => { changes.push(next); setWorkspace(next); }}
          samples={fx.samples}
          checkedSampleIds={["D1", "D2", "D3"]}
          metadataColumns={["day"]}
          activeSampleId="D1"
          activePopulationId={fx.core.root_population_id}
          state={fx.core}
          globalScales={{ "FSC-A": [0, 100], "SSC-A": [0, 100] }}
          defaultX="FSC-A"
          defaultY="SSC-A"
          illustrationConfig={illustrationConfig}
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
function workspaceWith(item: LayoutItem, iteration?: LayoutWorkspace["sheets"][number]["iteration"]): LayoutWorkspace {
  const workspace = createDefaultLayoutWorkspace();
  workspace.sheets[0].items = [item];
  if (iteration) workspace.sheets[0].iteration = iteration;
  return workspace;
}
/** The traces drawn on the last plot, lead first: name and event count of each. */
function traces() {
  const config = draws.plots.at(-1)!.config;
  const lead = (config.legend_entries as { name: string }[] | undefined)?.find((entry) => entry.name && !(config.overlay_traces as { name: string }[]).some((t) => t.name === entry.name));
  return {
    legend: (config.legend_entries as { name: string; color: string }[] | undefined) ?? [],
    lead: { name: lead?.name, events: (config.x as ArrayLike<number>).length },
    rest: ((config.overlay_traces as { name: string; x: ArrayLike<number> }[] | undefined) ?? []).map((t) => ({ name: t.name, events: t.x.length })),
  };
}

describe("Layout plots overlaying populations", () => {
  it("draws a leaf population's events without restoring the tree's quadrant outlines", async () => {
    const fx = fixture();
    mount(fx, workspaceWith(overlayItem({ kind: "biplot", populationIds: [fx.q.Q1.population_id], yChannel: "SSC-A" })));
    await flush();
    expect(draws.plots.at(-1)!.config).toMatchObject({ n_events: 1, x: [10], y: [90], gates: [] });
  });

  it("draws every overlaid population over the pooled files of a metadata value, with the legend and colours of one file", async () => {
    const fx = fixture();
    const ids = [fx.q.Q1.population_id, fx.q.Q2.population_id, fx.q.Q3.population_id];
    mount(fx, workspaceWith(
      overlayItem({ populationIds: ids, iterated: true }),
      { mode: "metadata", column: "day", source: { kind: "checked" }, arrangement: { kind: "page-per-unit" } },
    ));
    await flush();
    // Page 1 is day 0: D2 alone.
    expect(host.textContent).toContain("Page 1 of 2");
    let drawn = traces();
    expect([drawn.lead, ...drawn.rest]).toEqual([{ name: "Q1", events: 2 }, { name: "Q2", events: 0 }, { name: "Q3", events: 1 }]);
    const single = drawn.legend;
    draws.plots = [];
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.click());
    await flush();
    // Page 2 is day 7: D1 and D3 pooled, each population counted over both.
    drawn = traces();
    expect(drawn.legend).toEqual(single);
    expect(drawn.legend.map((entry) => entry.name)).toEqual(["Q1", "Q2", "Q3"]);
    expect(drawn.legend.map((entry) => entry.color)).toEqual([fx.q.Q1, fx.q.Q2, fx.q.Q3].map((p) => populationColor("default", p.colorSlot!)));
    expect([drawn.lead, ...drawn.rest]).toEqual([{ name: "Q1", events: 2 }, { name: "Q2", events: 3 }, { name: "Q3", events: 3 }]);
  });

  it("draws an overlaid histogram with the overlay mode it was sent with, and front opaque without one", async () => {
    const fx = fixture();
    const ids = [fx.q.Q1.population_id, fx.q.Q2.population_id];
    mount(fx, workspaceWith(overlayItem({ populationIds: ids, histOverlayMode: "blend" })));
    await flush();
    expect(draws.plots.at(-1)!.config.hist_overlay_mode).toBe("blend");
    act(() => root.unmount());
    root = createRoot(host);
    draws.plots = [];
    mount(fx, workspaceWith(overlayItem({ populationIds: ids })));
    await flush();
    expect(draws.plots.at(-1)!.config.hist_overlay_mode).toBe("front_opaque");
  });

  it("draws the populations a file has when the first is missing, and titles the plot by all of them", async () => {
    const fx = fixture();
    mount(fx, workspaceWith(overlayItem({ populationIds: ["gone", fx.q.Q2.population_id, fx.q.Q3.population_id], title: "{population} | {count}" })));
    await flush();
    expect(host.querySelector(".gl-layout-plot-host.is-missing")).toBeNull();
    const drawn = traces();
    expect(drawn.legend.map((entry) => entry.name)).toEqual(["Q2", "Q3"]);
    expect([drawn.lead, ...drawn.rest]).toEqual([{ name: "Q2", events: 2 }, { name: "Q3", events: 3 }]);
    expect(draws.plots.at(-1)!.config.title).toBe("Q2, Q3 | 2, 3");
  });

  it("draws the one population a file has as a plot of it, and says unavailable only when it has none", async () => {
    const fx = fixture();
    mount(fx, workspaceWith(overlayItem({ populationIds: ["gone", fx.q.Q3.population_id], title: "{population} | {count}" })));
    await flush();
    expect(host.querySelector(".gl-layout-plot-host.is-missing")).toBeNull();
    expect(draws.plots.at(-1)!.config).toMatchObject({ title: "Q3 | 3", n_events: 3 });
    act(() => root.unmount());
    root = createRoot(host);
    draws.plots = [];
    mount(fx, workspaceWith(overlayItem({ populationIds: ["gone", "lost"] })));
    await flush();
    expect(draws.plots).toHaveLength(0);
    expect(host.querySelector(".gl-layout-plot-host.is-missing")).not.toBeNull();
  });

  it("shows the overlaid populations as a checklist under Items, which edits them and turns back to one population", async () => {
    const fx = fixture();
    const ids = [fx.q.Q1.population_id, fx.q.Q2.population_id, fx.q.Q3.population_id];
    const changes = mount(fx, workspaceWith(overlayItem({ populationIds: ids })));
    await flush();
    act(() => {
      draws.selecto!.onSelectEnd({ selected: [host.querySelector('[data-item-id="plot"]')!], isDragStart: false, isClick: true, inputEvent: {} });
    });
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Items")!.click());
    const list = () => host.querySelector<HTMLElement>('[aria-label="Populations overlaid on this plot"]');
    const box = (name: string) => [...list()!.querySelectorAll("label")].find((l) => l.textContent === name)!.querySelector("input")!;
    expect(list()).not.toBeNull();
    // The single Population select gives way to the checklist, one row per population of the file, each with its colour.
    expect([...host.querySelectorAll<HTMLLabelElement>("label.gl-field-inline")].some((l) => l.firstChild?.textContent === "Population")).toBe(false);
    expect([...list()!.querySelectorAll("label")].map((l) => l.textContent)).toEqual(["All Events", "Q1", "Q2", "Q3", "Q4"]);
    expect([box("Q1"), box("Q2"), box("Q3"), box("Q4")].map((b) => b.checked)).toEqual([true, true, true, false]);
    // The shared population picker's swatch (PopulationChecklist).
    const swatch = [...list()!.querySelectorAll("label")].find((l) => l.textContent === "Q2")!.querySelector<HTMLElement>(".gl-strategy-pop-swatch")!;
    expect(swatch.style.background).not.toBe("");
    const recipe = () => changes.at(-1)!.sheets[0].items[0].recipe as LayoutPlotRecipe;
    act(() => box("Q1").click());
    expect(recipe()).toMatchObject({ populationId: fx.q.Q2.population_id, populationIds: [fx.q.Q2.population_id, fx.q.Q3.population_id] });
    act(() => box("Q4").click());
    expect(recipe().populationIds).toEqual([fx.q.Q2.population_id, fx.q.Q3.population_id, fx.q.Q4.population_id]);
    await flush();
    expect(traces().legend.map((entry) => entry.name)).toEqual(["Q2", "Q3", "Q4"]);
    act(() => box("Q3").click());
    act(() => box("Q4").click());
    // Down to one: an ordinary plot of it, with the single select back.
    expect(recipe().populationId).toBe(fx.q.Q2.population_id);
    expect(recipe()).not.toHaveProperty("populationIds");
    expect(list()).toBeNull();
    const select = [...host.querySelectorAll<HTMLLabelElement>("label.gl-field-inline")].find((l) => l.firstChild?.textContent === "Population")!.querySelector("select")!;
    expect(select.value).toBe(fx.q.Q2.population_id);
  });

  it("titles a plot overlaying populations by them under the sheet's default template", async () => {
    const fx = fixture();
    const ids = [fx.q.Q1.population_id, fx.q.Q2.population_id, fx.q.Q3.population_id];
    mount(fx, workspaceWith(overlayItem({ populationIds: ids, label: "Size" })));
    await flush();
    expect(draws.plots.at(-1)!.config.title).toBe("Q1, Q2, Q3 · D1.fcs · Size");
  });

  it("heads an Illustration figure block's overlaid row by its populations", async () => {
    const fx = fixture();
    const trees = figureHierarchies(fx.core);
    const figure = migrateFigure(null, fx.samples.slice(0, 2), trees, fx.core.active_hierarchy_id, "FSC-A", "SSC-A");
    const refs = ["Q1", "Q2", "Q3"].map((name) => ({ hierarchyId: fx.core.active_hierarchy_id, populationId: fx.q[name].population_id, label: name }));
    figure.sampleIds = ["D1", "D2"];
    figure.populations = [{ hierarchyId: fx.core.active_hierarchy_id, populationId: fx.core.root_population_id!, label: "All Events" }];
    figure.plots = [
      { id: "quadrants", name: "Quadrants", x: "FSC-A", y: "SSC-A", type: "biplot" },
      { id: "size", name: "Size", x: "FSC-A", y: "FSC-A", type: "histogram", populations: refs },
    ];
    figure.rows = ["populations", "plots"];
    figure.columns = ["samples"];
    const illustration: IllustrationConfig = { ...defaultIllustrationConfig(), xChannels: ["FSC-A"], yChannel: "SSC-A", figure };
    mount(fx, workspaceWith({ id: "figure", x: 20, y: 20, width: 600, height: 500, z: 0, recipe: { kind: "figure", illustration, page: 0 } }));
    await flush();
    const headings = [...host.querySelectorAll<HTMLElement>(".gl-layout-figure-host .gl-figure-row-heading")].map((th) => th.textContent);
    expect(headings).toEqual(["All Events", "Quadrants", "Q1, Q2, Q3", "Size"]);
  });

  it("adds an Illustration plot overlaying populations as one overlaid plot per file, as Illustration's own Add to Layout does", async () => {
    const fx = fixture();
    const trees = figureHierarchies(fx.core);
    const figure = migrateFigure(null, fx.samples.slice(0, 2), trees, fx.core.active_hierarchy_id, "FSC-A", "SSC-A");
    const refs = ["Q1", "Q2", "Q3"].map((name) => ({ hierarchyId: fx.core.active_hierarchy_id, populationId: fx.q[name].population_id, label: name }));
    figure.sampleIds = ["D1", "D2"];
    figure.populations = [{ hierarchyId: fx.core.active_hierarchy_id, populationId: fx.core.root_population_id!, label: "All Events" }];
    figure.plots = [{ id: "size", name: "Size", x: "FSC-A", y: "FSC-A", type: "histogram", populations: refs }];
    const config: IllustrationConfig = { ...defaultIllustrationConfig(), xChannels: ["FSC-A"], yChannel: "SSC-A", histOverlayMode: "blend", figure };
    const changes = mount(fx, createDefaultLayoutWorkspace(), config);
    await flush();
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add Illustration selection")!.click());
    const added = changes.at(-1)!.sheets[0].items.map((item) => item.recipe as LayoutPlotRecipe);
    expect(added).toHaveLength(2);
    expect(added.map((recipe) => recipe.sampleId)).toEqual(["D1", "D2"]);
    for (const recipe of added) {
      expect(recipe).toMatchObject({
        kind: "histogram", xChannel: "FSC-A", label: "Size", histOverlayMode: "blend",
        populationId: refs[0].populationId, populationIds: refs.map((ref) => ref.populationId),
      });
    }
  });

  it("adds an Illustration chart plot's panels as Plotting blocks of one panel, as Illustration's own Add to Layout does", async () => {
    const fx = fixture();
    const trees = figureHierarchies(fx.core);
    const figure = migrateFigure(null, fx.samples.slice(0, 2), trees, fx.core.active_hierarchy_id, "FSC-A", "SSC-A");
    const refs = ["Q1", "Q2", "Q3"].map((name) => ({ hierarchyId: fx.core.active_hierarchy_id, populationId: fx.q[name].population_id, label: name }));
    figure.sampleIds = ["D1", "D2"];
    figure.populations = [{ hierarchyId: fx.core.active_hierarchy_id, populationId: fx.core.root_population_id!, label: "All Events" }];
    figure.plots = [
      { id: "size", name: "Size", x: "FSC-A", y: "FSC-A", type: "histogram" },
      { id: "violin", name: "FSC violin", x: "FSC-A", y: "FSC-A", type: "chart", chart: { valueKind: "cells", plotType: "violin" }, populations: refs },
    ];
    figure.rows = ["plots"];
    figure.columns = ["samples"];
    const config: IllustrationConfig = { ...defaultIllustrationConfig(), xChannels: ["FSC-A"], yChannel: "SSC-A", figure };
    const changes = mount(fx, createDefaultLayoutWorkspace(), config);
    await flush();
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add Illustration selection")!.click());
    const added = changes.at(-1)!.sheets[0].items.map((item) => item.recipe);
    expect(added.map((recipe) => [recipe.kind, recipe.kind === "proportions" ? recipe.settings.files.join() : (recipe as LayoutPlotRecipe).sampleId])).toEqual([
      ["histogram", "D1"],
      ["histogram", "D2"],
      ["proportions", "D1"],
      ["proportions", "D2"],
    ]);
    for (const recipe of added.slice(2) as LayoutProportionsRecipe[]) {
      expect(recipe).toMatchObject({ panel: {}, textSize: "sheet", title: "FSC violin" });
      expect(recipe.settings).toMatchObject({
        valueKind: "cells", plotType: "violin", channel: "FSC-A", xAxis: "populations",
        selectedPops: refs.map((ref) => ref.populationId), legend: false,
      });
    }
  });
});
