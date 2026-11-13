// @vitest-environment jsdom
// The Illustration plot editor's "Overlay chosen populations": a plot overlays populations of its
// own in each panel, starting from a fixed population and its siblings (a quadrant gate's four
// quadrants), while other plots keep theirs. Synthetic files D1 and D2; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IllustrationTab } from "./IllustrationTab";
import { coreReducer, initialCoreState, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { figureHierarchies, layoutFigure, migrateFigure, type FigureSample } from "../engine/figure";
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

function fixture() {
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
        { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from([10, 90, 90, 10]), Float32Array.from([90, 90, 10, 10])],
    };
    return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
  });
  const trees = figureHierarchies(core);
  const quadrants = Object.values(core.populations).filter((p) => p.parent_id === core.root_population_id);
  const q3 = quadrants.find((p) => p.name === "Q3")!;
  const figure = migrateFigure(null, samples, trees, core.active_hierarchy_id, "FSC-A", "SSC-A");
  figure.populations = [{ hierarchyId: core.active_hierarchy_id, populationId: core.root_population_id!, label: "All Events" }];
  figure.plots = [
    { id: "biplot", name: "Quadrants", x: "FSC-A", y: "SSC-A", type: "biplot" },
    { id: "size", name: "Size", x: "FSC-A", y: "FSC-A", type: "histogram", population: { hierarchyId: core.active_hierarchy_id, populationId: q3.population_id, label: "Q3" } },
  ];
  const configRef: { current: IllustrationConfig | null } = {
    current: { ...defaultIllustrationConfig(), xChannels: ["FSC-A"], yChannel: "SSC-A", figure },
  };
  return {
    core,
    samples,
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

const populationPickers = () =>
  [...host.querySelectorAll<HTMLLabelElement>("label")].filter((l) => l.firstChild?.textContent?.trim() === "Populations").map((l) => l.querySelector("select")!);

describe("Illustration: a plot overlaying chosen populations", () => {
  it("switches a fixed population to an overlay of it and its siblings, and the checklist edits them", async () => {
    const fx = fixture();
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "Plots")!.click());
    const pickers = populationPickers();
    expect(pickers).toHaveLength(2);
    expect([...pickers[1].options].map((o) => o.textContent).slice(0, 2)).toEqual([
      "Each selected population in its own panel",
      "The selected populations together in one panel",
    ]);
    expect([...pickers[1].options].pop()!.textContent).toBe("Its own list…");
    act(() => {
      pickers[1].value = "__overlay__";
      pickers[1].dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    const figure = () => fx.props.configRef.current!.figure!;
    expect(figure().plots[1].population).toBeUndefined();
    expect(figure().plots[1].populations?.map((p) => p.label)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(figure().plots[0].populations).toBeUndefined();

    const list = host.querySelector('[aria-label="Populations overlaid in Size"]')!;
    const box = (label: string) => [...list.querySelectorAll("label")].find((l) => l.textContent === label)!.querySelector("input")!;
    expect(box("Q2").checked).toBe(true);
    act(() => box("Q2").click());
    await flush();
    expect(figure().plots[1].populations?.map((p) => p.label)).toEqual(["Q1", "Q3", "Q4"]);
    act(() => box("Q2").click());
    await flush();
    // Kept in tree order whatever order they are ticked in.
    expect(figure().plots[1].populations?.map((p) => p.label)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(host.textContent).toContain("4 overlaid in each panel, each in its population's colour");

    // The histogram row overlays the four in every file's panel; the biplot row keeps one population.
    const page = layoutFigure(figure(), fx.samples, figureHierarchies(fx.core))[0];
    expect(page.panels.filter((p) => p.plot.id === "size").every((p) => p.populations?.length === 4)).toBe(true);
    expect(page.panels.filter((p) => p.plot.id === "biplot").every((p) => !p.populations)).toBe(true);

    // Back to one population drops the list.
    act(() => {
      const picker = populationPickers()[1];
      picker.value = "";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(figure().plots[1].populations).toBeUndefined();
    expect(host.querySelector('[aria-label="Populations overlaid in Size"]')).toBeNull();
  });

  it("heads the row of an overlaying plot by its populations, and the other plot's row by the figure's population", async () => {
    const fx = fixture();
    const figure = fx.props.configRef.current!.figure!;
    const quadrantRefs = ["Q1", "Q2", "Q3", "Q4"].map((name) => {
      const p = Object.values(fx.core.populations).find((candidate) => candidate.name === name)!;
      return { hierarchyId: fx.core.active_hierarchy_id, populationId: p.population_id, label: name };
    });
    figure.plots[1] = { ...figure.plots[1], population: undefined, populations: quadrantRefs };
    figure.rows = ["populations", "plots"];
    figure.columns = ["samples"];
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    const headings = [...host.querySelectorAll<HTMLElement>(".gl-figure-grid .gl-figure-row-heading")].map((th) => th.textContent);
    expect(headings).toEqual(["All Events", "Quadrants", "Q1, Q2, Q3, Q4", "Size"]);
  });

  it("puts an overlaying panel on the Layout tab as one plot of its populations", async () => {
    const fx = fixture();
    const figure = fx.props.configRef.current!.figure!;
    const quadrantRefs = Object.values(fx.core.populations)
      .filter((p) => p.parent_id === fx.core.root_population_id)
      .map((p) => ({ hierarchyId: fx.core.active_hierarchy_id, populationId: p.population_id, label: p.name }));
    figure.plots[1] = { ...figure.plots[1], population: undefined, populations: quadrantRefs };
    const onAddToLayout = vi.fn();
    act(() => root.render(<IllustrationTab {...fx.props} onAddToLayout={onAddToLayout} />));
    await flush();
    const histogram = [...host.querySelectorAll<HTMLElement>("td[data-figure-panel]")].at(-1)!;
    act(() => { histogram.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 90 })); });
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "Add this panel to the Layout tab")!.click());
    const recipe = onAddToLayout.mock.calls[0][0][0];
    expect(recipe).toMatchObject({ kind: "histogram", populationIds: quadrantRefs.map((r) => r.populationId), populationId: quadrantRefs[0].populationId });
  });
});
