// @vitest-environment jsdom
// The Illustration tab's plots, a tab each across the top as the Layout tab's sheets, one plot
// shown at a time with its editor; the tabs rename, duplicate, move and delete plots, and Add to
// Layout offers the plot shown or the whole figure. Synthetic files D1 and D2; nothing here is a
// real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IllustrationTab } from "./IllustrationTab";
import { coreReducer, initialCoreState, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { figureHierarchies, migrateFigure, type FigureSample } from "../engine/figure";
import type { IllustrationConfig } from "../engine/workspace";
import { defaultIllustrationConfig } from "../engine/figureDefaults";

vi.mock("../plots/figurePlot", () => ({
  drawFigurePlot: (node: HTMLElement) => {
    node.innerHTML = '<svg aria-label="Rendered plot"></svg>';
  },
}));

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  // jsdom lays nothing out and has no scrolling.
  Element.prototype.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
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
  for (let i = 0; i < 5; i++)
    await act(async () => {
      await vi.runAllTimersAsync();
    });
}

/** Each file's FSC-A; D2's high events lie ten times higher than D1's, in the same quadrants. With `time`, a Time channel comes first. */
function fixture(fsc: Record<string, number[]> = { D1: [10, 90, 90, 10], D2: [10, 90, 90, 10] }, time = false) {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "FSC-A", yChannel: "SSC-A",
    center: [50, 50], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["Q1", "Q2", "Q3", "Q4"],
  });
  const core = state as CoreState;
  const samples: FigureSample[] = ["D1", "D2"].map((id) => {
    const fcs: FcsFile = {
      version: "FCS3.1",
      nEvents: 4,
      instrument: "flow",
      keywords: {},
      spillover: null,
      channels: [
        ...(time ? [{ index: 0, name: "Time", marker: null, bits: 32, range: 262144 }] : []),
        { index: time ? 1 : 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: time ? 2 : 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [...(time ? [Float32Array.from([1, 2, 3, 4])] : []), Float32Array.from(fsc[id]), Float32Array.from([90, 90, 10, 10])],
    };
    return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
  });
  const trees = figureHierarchies(core);
  const quadrants = Object.values(core.populations)
    .filter((p) => p.parent_id === core.root_population_id)
    .map((p) => ({ hierarchyId: core.active_hierarchy_id, populationId: p.population_id, label: p.name }));
  const figure = migrateFigure(null, samples, trees, core.active_hierarchy_id, "FSC-A", "SSC-A");
  figure.populations = [{ hierarchyId: core.active_hierarchy_id, populationId: core.root_population_id!, label: "All Events" }];
  figure.plots = [
    { id: "size", name: "Size", x: "FSC-A", y: "FSC-A", type: "histogram" },
    { id: "violin", name: "FSC violin", x: "FSC-A", y: "FSC-A", type: "chart", chart: { valueKind: "cells", plotType: "violin" }, populations: quadrants },
  ];
  figure.rows = ["populations", "plots"];
  figure.columns = ["samples"];
  figure.panelSize = 260;
  const configRef: { current: IllustrationConfig | null } = {
    current: { ...defaultIllustrationConfig(), xChannels: ["FSC-A"], yChannel: "SSC-A", figure },
  };
  return {
    core,
    samples,
    quadrants,
    props: {
      samples,
      state: core,
      configRef,
      checkedSampleIds: samples.map((s) => s.id),
      defaultX: "FSC-A",
      defaultY: "SSC-A",
      presets: [],
      onSavePreset: vi.fn(),
      onDeletePreset: vi.fn(),
      onConfigChange: vi.fn(),
      onOpenGating: vi.fn(),
      dataRevision: "initial",
    },
  };
}

const openSection = (name: string) =>
  act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === name)!.click());

const plotTabs = () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Plots"] [role="tab"]')];
const plotTab = (name: string) => plotTabs().find((b) => b.textContent === name)!;
const tabState = () => plotTabs().map((b) => [b.textContent, b.getAttribute("aria-selected")]);
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
const editorNames = () => [...host.querySelectorAll<HTMLElement>(".gl-figure-plot-editor")].map((e) => e.querySelector<HTMLInputElement>("input")!.value);
/** A right-click menu item: clicked, or only found (and the menu closed) when `click` is false. */
function menuItem(label: string, click = true) {
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.trim() === label)!;
  if (click) act(() => item.click());
  else act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  return item;
}
function tabMenu(name: string, label: string, click = true) {
  act(() => { plotTab(name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); });
  return menuItem(label, click);
}
/** The plot ids of the panels drawn in the preview, in order, each once. */
const drawnPlots = (fx: ReturnType<typeof fixture>) => {
  const figure = fx.props.configRef.current!.figure!;
  const keys = [...host.querySelectorAll<HTMLElement>(".gl-figure-viewport [data-figure-panel]")].map((cell) => cell.dataset.figurePanel!);
  return [...new Set(keys.map((key) => figure.plots.find((plot) => key.includes(`"id":"${plot.id}"`))?.id ?? key))];
};

describe("Illustration: a tab per plot", () => {
  it("shows one plot at a time, the first at first, with its editor alone, and saves every plot", async () => {
    const fx = fixture();
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    expect(tabState()).toEqual([["Size", "true"], ["FSC violin", "false"]]);
    expect(drawnPlots(fx)).toEqual(["size"]);
    openSection("Plot");
    expect(editorNames()).toEqual(["Size"]);
    act(() => plotTab("FSC violin").click());
    await flush();
    expect(tabState()).toEqual([["Size", "false"], ["FSC violin", "true"]]);
    expect(drawnPlots(fx)).toEqual(["violin"]);
    expect(editorNames()).toEqual(["FSC violin"]);
    // The choice is the session's: the figure the workspace saves keeps both plots.
    expect(fx.props.configRef.current!.figure!.plots.map((p) => p.id)).toEqual(["size", "violin"]);
  });

  it("renames, duplicates, moves and deletes plots from their tabs, each one undo step", async () => {
    const fx = fixture();
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    const plots = () => fx.props.configRef.current!.figure!.plots.map((p) => p.name);
    act(() => plotTab("Size").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const name = host.querySelector<HTMLInputElement>('[aria-label="Plots"] input[aria-label="Name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "FSC size");
      name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    act(() => name.blur());
    await flush();
    expect(plots()).toEqual(["FSC size", "FSC violin"]);
    tabMenu("FSC violin", "Duplicate");
    await flush();
    expect(tabState()).toEqual([["FSC size", "false"], ["FSC violin", "false"], ["FSC violin copy", "true"]]);
    tabMenu("FSC violin copy", "Move left");
    await flush();
    expect(plots()).toEqual(["FSC size", "FSC violin copy", "FSC violin"]);
    // The plot shown deleted: the one before it is shown.
    tabMenu("FSC violin copy", "Delete");
    await flush();
    expect(tabState()).toEqual([["FSC size", "true"], ["FSC violin", "false"]]);
    act(() => button("Undo").click());
    await flush();
    expect(plots()).toEqual(["FSC size", "FSC violin copy", "FSC violin"]);
    act(() => button("Undo").click());
    act(() => button("Undo").click());
    act(() => button("Undo").click());
    await flush();
    expect(plots()).toEqual(["Size", "FSC violin"]);
    act(() => button("Redo").click());
    await flush();
    expect(plots()).toEqual(["FSC size", "FSC violin"]);
  });

  it("adds a plot with + and shows it", async () => {
    const fx = fixture();
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="New plot"]')!.click());
    await flush();
    expect(tabState()).toEqual([["Size", "false"], ["FSC violin", "false"], ["Plot 3", "true"]]);
    const added = fx.props.configRef.current!.figure!.plots[2];
    expect(added).toMatchObject({ type: "biplot", x: "FSC-A", y: "SSC-A" });
    expect(drawnPlots(fx)).toEqual([added.id]);
  });

  it("adds the plot shown, or the whole figure, to the Layout tab", async () => {
    const fx = fixture();
    const onAddFigureToLayout = vi.fn();
    act(() => root.render(<IllustrationTab {...fx.props} onAddFigureToLayout={onAddFigureToLayout} />));
    await flush();
    act(() => plotTab("FSC violin").click());
    await flush();
    act(() => button("Add to Layout").click());
    menuItem("This plot");
    expect(onAddFigureToLayout.mock.calls[0][0].figure.plots.map((p: { id: string }) => p.id)).toEqual(["violin"]);
    act(() => button("Add to Layout").click());
    menuItem("Every plot (the whole figure)");
    expect(onAddFigureToLayout.mock.calls[1][0].figure.plots.map((p: { id: string }) => p.id)).toEqual(["size", "violin"]);
  });

  it("shows a figure of one plot as one tab, which cannot be deleted from its tab", async () => {
    const fx = fixture();
    const onAddFigureToLayout = vi.fn();
    fx.props.configRef.current!.figure!.plots = fx.props.configRef.current!.figure!.plots.slice(0, 1);
    act(() => root.render(<IllustrationTab {...fx.props} onAddFigureToLayout={onAddFigureToLayout} />));
    await flush();
    expect(tabState()).toEqual([["Size", "true"]]);
    expect(tabMenu("Size", "Delete", false).disabled).toBe(true);
    // One plot: Add to Layout takes it at once, as before.
    act(() => button("Add to Layout").click());
    expect(onAddFigureToLayout).toHaveBeenCalledTimes(1);
  });

  it("has no strip of buttons over the figure: Edit gates is under Data, the Layout actions under Export", async () => {
    const fx = fixture();
    const onOpenGating = vi.fn();
    act(() => root.render(<IllustrationTab {...fx.props} onOpenGating={onOpenGating} onAddFigureToLayout={vi.fn()} onAddToLayout={vi.fn()} />));
    await flush();
    expect(host.querySelector("header")).toBeNull();
    act(() => [...host.querySelectorAll<HTMLButtonElement>("#figure-section-data button")].find((b) => b.textContent === "Edit gates")!.click());
    expect(onOpenGating).toHaveBeenCalledTimes(1);
    expect([...host.querySelectorAll("#figure-section-export .gl-figure-layout-actions button")].map((b) => b.textContent)).toEqual(["Add to Layout", "Add panels to Layout"]);
  });

  it("resizes the figure from its corner grip: stretched while dragged, the panel size set on release, Escape cancelling", async () => {
    const fx = fixture();
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    const page = host.querySelector<HTMLElement>(".gl-figure-paper")!;
    page.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON: () => ({}) });
    const grip = host.querySelector<HTMLElement>(".gl-figure-resize")!;
    const pointer = (type: string, target: EventTarget, x: number, y: number) =>
      act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y })); });
    // Half as wide again: the page is stretched by 1.5 while dragged, the panels 260 → 390 px on release.
    pointer("pointerdown", grip, 600, 400);
    pointer("pointermove", window, 900, 410);
    expect(page.style.transform).toBe("scale(1.5)");
    expect(host.textContent).toContain("Panel size 390 px");
    pointer("pointerup", window, 900, 410);
    await flush();
    expect(page.style.transform).toBe("");
    expect(fx.props.configRef.current!.figure!.panelSize).toBe(390);
    // Escape leaves the size as it was.
    const again = host.querySelector<HTMLElement>(".gl-figure-paper")!;
    again.getBoundingClientRect = page.getBoundingClientRect;
    pointer("pointerdown", host.querySelector<HTMLElement>(".gl-figure-resize")!, 600, 400);
    pointer("pointermove", window, 300, 400);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    pointer("pointerup", window, 300, 400);
    await flush();
    expect(fx.props.configRef.current!.figure!.panelSize).toBe(390);
  });
});
