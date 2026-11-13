// @vitest-environment jsdom
// A plot overlaying chosen populations: the ridges keep the legend's order in every file, and a
// ticked population that is no longer listed stays visible in the checklist. Synthetic files D1
// and D2; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IllustrationTab } from "./IllustrationTab";
import { coreReducer, initialCoreState, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { newPopulation, newRootPopulation } from "../engine/models";
import { figureHierarchies, migrateFigure, type FigurePopulation, type FigureSample } from "../engine/figure";
import type { IllustrationConfig } from "../engine/workspace";
import { defaultIllustrationConfig } from "../engine/figureDefaults";

const draws = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock("../plots/figurePlot", () => ({
  drawFigurePlot: (node: HTMLElement, config: Record<string, unknown>) => {
    draws.calls.push(config);
    node.innerHTML = '<svg aria-label="Rendered plot"></svg>';
  },
}));

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  draws.calls = [];
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

// Each event is [FSC-A, SSC-A]; the quadrant gate's centre is at 50, 50. Q1 is low FSC-A, high
// SSC-A. D1 has one event in each quadrant; D2 has none in Q1 and two in Q2.
const EVENTS: Record<string, [number, number][]> = {
  D1: [[10, 90], [90, 90], [90, 10], [10, 10]],
  D2: [[90, 90], [90, 90], [90, 10], [10, 10]],
};

function fixture(extraTree = false) {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "FSC-A", yChannel: "SSC-A",
    center: [50, 50], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["Q1", "Q2", "Q3", "Q4"],
  });
  const main = state as CoreState;
  const quadrants = ["Q1", "Q2", "Q3", "Q4"].map((name) => Object.values(main.populations).find((p) => p.name === name)!);
  const refs: FigurePopulation[] = quadrants.map((p) => ({ hierarchyId: main.active_hierarchy_id, populationId: p.population_id, label: p.name }));
  let other: FigurePopulation | null = null;
  if (extraTree) {
    // A second, unrelated tree that no selected file uses, holding CD4_positive.
    const rootPop = newRootPopulation(),
      child = newPopulation("CD4_positive", [], rootPop.population_id);
    rootPop.children = [child.population_id];
    state = coreReducer(state, {
      type: "addHierarchy", id: "B2", name: "B2 tree",
      populations: { [rootPop.population_id]: rootPop, [child.population_id]: child },
      root_population_id: rootPop.population_id,
    });
    state = coreReducer(state, { type: "switchHierarchy", id: DEFAULT_HIERARCHY_ID });
    other = { hierarchyId: "B2", populationId: child.population_id, label: "CD4_positive" };
  }
  const core = state as CoreState;
  const samples: FigureSample[] = ["D1", "D2"].map((id) => {
    const fcs: FcsFile = {
      version: "FCS3.1",
      nEvents: 4,
      instrument: "flow",
      keywords: {},
      spillover: null,
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [0, 1].map((c) => Float32Array.from(EVENTS[id].map((event) => event[c]))),
    };
    return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
  });
  const trees = figureHierarchies(core);
  const figure = migrateFigure(null, samples, trees, core.active_hierarchy_id, "FSC-A", "SSC-A");
  figure.populations = [{ hierarchyId: core.active_hierarchy_id, populationId: core.root_population_id!, label: "All Events" }];
  figure.plots = [{ id: "size", name: "Size", x: "FSC-A", y: "FSC-A", type: "histogram", populations: refs }];
  const configRef: { current: IllustrationConfig | null } = {
    current: { ...defaultIllustrationConfig(), xChannels: ["FSC-A"], yChannel: "SSC-A", figure },
  };
  return {
    core,
    refs,
    other,
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

describe("Illustration: ridgelines of chosen populations", () => {
  it("draws the ridges in the legend's order in every file, a population empty in a file as an empty ridge", async () => {
    const fx = fixture();
    fx.props.configRef.current = { ...fx.props.configRef.current!, histLayout: "ridgeline" };
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    const panels = [...host.querySelectorAll<HTMLElement>("td[data-figure-panel]")];
    expect(panels).toHaveLength(2);
    // The legend numbers the ridges Q1 to Q4 in both files.
    for (const panel of panels)
      expect([...panel.querySelectorAll(".gl-figure-legend span")].map((s) => s.textContent)).toEqual(["1. Q1", "2. Q2", "3. Q3", "4. Q4"]);
    const ridgelines = draws.calls.filter((c) => c.hist_layout === "ridgeline");
    expect(ridgelines).toHaveLength(2);
    // The ridges top to bottom: the main trace, then the overlaid ones.
    const rows = ridgelines.map((c) => [
      (c.x as number[]).length,
      ...(c.overlay_traces as { x: number[]; name: string }[]).map((t) => `${t.name}:${t.x.length}`),
    ]);
    expect(rows).toContainEqual([1, "Q2:1", "Q3:1", "Q4:1"]);
    // D2 has no Q1 events: Q1 keeps the first row, empty, and Q2's two events are the second.
    expect(rows).toContainEqual([0, "Q2:2", "Q3:1", "Q4:1"]);
  });
});

describe("Illustration: a ticked overlay population that is no longer listed", () => {
  const checklist = () => host.querySelector('[aria-label="Populations overlaid in Size"]')!;
  const row = (label: string) => [...checklist().querySelectorAll("label")].find((l) => l.querySelector(".gl-strategy-pop-name")?.textContent === label);
  async function openPlots() {
    await flush();
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "Plots")!.click());
    await flush();
  }

  it("keeps a population deleted from the workspace in the checklist, marked, until it is unticked", async () => {
    const fx = fixture();
    const deleted: FigurePopulation = { hierarchyId: fx.core.active_hierarchy_id, populationId: "deleted-pop", label: "CD8_positive" };
    const figure = () => fx.props.configRef.current!.figure!;
    figure().plots[0] = { ...figure().plots[0], populations: [...fx.refs, deleted] };
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await openPlots();
    const gone = row("CD8_positive");
    expect(gone).toBeDefined();
    expect(gone!.querySelector("input")!.checked).toBe(true);
    expect(gone!.textContent).toContain("Not in the workspace");
    // Ticking another box does not drop it.
    act(() => row("Q2")!.querySelector("input")!.click());
    await flush();
    expect(figure().plots[0].populations?.map((p) => p.label)).toEqual(["Q1", "Q3", "Q4", "CD8_positive"]);
    // Unticking it removes it, and the list no longer shows it.
    act(() => row("CD8_positive")!.querySelector("input")!.click());
    await flush();
    expect(figure().plots[0].populations?.map((p) => p.label)).toEqual(["Q1", "Q3", "Q4"]);
    expect(row("CD8_positive")).toBeUndefined();
  });

  it("keeps a population in none of the selected files in the checklist, marked 0 of 2", async () => {
    const fx = fixture(true);
    const other = fx.other!;
    const figure = () => fx.props.configRef.current!.figure!;
    figure().plots[0] = { ...figure().plots[0], populations: [...fx.refs, other] };
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await openPlots();
    const absent = row("CD4_positive");
    expect(absent).toBeDefined();
    expect(absent!.querySelector("input")!.checked).toBe(true);
    expect(absent!.textContent).toContain("0/2");
    act(() => row("Q2")!.querySelector("input")!.click());
    await flush();
    // In the list's order, which puts the other tree's populations first.
    expect(figure().plots[0].populations?.map((p) => p.label)).toEqual(["CD4_positive", "Q1", "Q3", "Q4"]);
    act(() => row("CD4_positive")!.querySelector("input")!.click());
    await flush();
    expect(figure().plots[0].populations?.map((p) => p.label)).toEqual(["Q1", "Q3", "Q4"]);
    expect(row("CD4_positive")).toBeUndefined();
  });
});
