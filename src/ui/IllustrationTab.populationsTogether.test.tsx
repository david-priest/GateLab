// @vitest-environment jsdom
// The Illustration tab's populations are picked in one place, the Data section's tree, and each
// plot says how it uses them: each in its own panel, together in one panel, one fixed population,
// or a list of its own. "Add summary panel" adds a summary violin of the ticked populations
// together. Synthetic files D1, D2 and D3 in groups control and treated; nothing here is a real
// experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IllustrationTab } from "./IllustrationTab";
import { coreReducer, initialCoreState, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { figureHierarchies, layoutFigure, migrateFigure, type FigurePopulation, type FigureSample } from "../engine/figure";
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

const GROUPS: Record<string, string> = { D1: "control", D2: "treated", D3: "control" };

/** Three files of four events, one in each quadrant of a quadrant gate; a histogram plot, files on columns. */
function fixture(ticked: string[] = ["Q1"]) {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
  state = coreReducer(state, {
    type: "addQuadrant", xChannel: "FSC-A", yChannel: "SSC-A",
    center: [50, 50], space: "raw", prefix: "", parentId: state.root_population_id!,
    names: ["Q1", "Q2", "Q3", "Q4"],
  });
  const core = state as CoreState;
  const samples: FigureSample[] = ["D1", "D2", "D3"].map((id, i) => {
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
      columns: [Float32Array.from([10, 90, 90, 10].map((v) => v * (i + 1))), Float32Array.from([90, 90, 10, 10])],
    };
    return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs), metadata: { group: GROUPS[id] } };
  });
  const trees = figureHierarchies(core);
  const ref = (name: string): FigurePopulation => ({
    hierarchyId: core.active_hierarchy_id,
    populationId: Object.values(core.populations).find((p) => p.name === name)!.population_id,
    label: name,
  });
  const figure = migrateFigure(null, samples, trees, core.active_hierarchy_id, "FSC-A", "SSC-A");
  figure.populations = ticked.map(ref);
  figure.plots = [{ id: "size", name: "Size", x: "FSC-A", y: "FSC-A", type: "histogram" }];
  figure.rows = ["populations", "plots"];
  figure.columns = ["samples"];
  figure.panelSize = 200;
  const configRef: { current: IllustrationConfig | null } = {
    current: { ...defaultIllustrationConfig(), xChannels: ["FSC-A"], yChannel: "SSC-A", figure },
  };
  return {
    core,
    samples,
    trees,
    ref,
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
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
const pickers = () =>
  [...host.querySelectorAll<HTMLLabelElement>(".gl-figure-plot-editor label")]
    .filter((l) => l.firstChild?.textContent?.trim() === "Populations")
    .map((l) => l.querySelector("select")!);
const choose = (select: HTMLSelectElement, value: string) =>
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

describe("Illustration: populations picked in the Data tree, used by each plot", () => {
  it("adds a summary panel of the ticked populations together, one panel however many are ticked", async () => {
    const fx = fixture(["Q1"]);
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    openSection("Plots");
    const add = button("Add summary panel");
    expect(add.title).toBe("One chart across the files, a mark per file, with the selected populations together");
    act(() => add.click());
    await flush();
    const figure = () => fx.props.configRef.current!.figure!;
    expect(figure().plots).toHaveLength(2);
    expect(figure().plots[1]).toMatchObject({
      name: "Summary 2",
      x: "FSC-A",
      type: "chart",
      chart: { valueKind: "cells", plotType: "violin", summary: true },
      together: true,
    });
    expect(figure().plots[1].population).toBeUndefined();
    expect(figure().plots[1].populations).toBeUndefined();
    expect(pickers()[1].value).toBe("__together__");
    expect(host.querySelectorAll(".gl-figure-chart")).toHaveLength(1);
    expect(host.querySelector<HTMLTableCellElement>("td[data-figure-panel][colspan='3']")).not.toBeNull();
    expect(host.querySelector(".gl-figure-chart")!.getAttribute("aria-label")).toBe("Summary 2; 3 cells");

    // Three ticked: still one summary panel, now of the three populations in each file.
    act(() => root.unmount());
    root = createRoot(host);
    figure().populations = ["Q1", "Q2", "Q3"].map(fx.ref);
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    const charts = host.querySelectorAll(".gl-figure-chart");
    expect(charts).toHaveLength(1);
    expect(charts[0].getAttribute("aria-label")).toBe("Summary 2; 9 cells");
    const [page] = layoutFigure(figure(), fx.samples, fx.trees);
    const summaries = page.panels.filter((p) => p.plot.together && p.span);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].samples).toEqual(["D1", "D2", "D3"]);
    expect(summaries[0].populations?.map((p) => p.label)).toEqual(["Q1", "Q2", "Q3"]);
    // Its row is headed by the populations it draws.
    const headings = [...host.querySelectorAll<HTMLElement>(".gl-figure-grid .gl-figure-row-heading")].map((th) => th.textContent);
    expect(headings).toContain("Q1, Q2, Q3");
  });

  it("goes to the Layout tab as one Plotting block of the ticked populations", async () => {
    const fx = fixture(["Q1", "Q2", "Q3"]);
    fx.props.configRef.current!.figure!.plots.push({
      id: "summary", name: "Summary", x: "FSC-A", y: "FSC-A", type: "chart",
      chart: { valueKind: "cells", plotType: "violin", summary: true }, together: true,
    });
    const onAddToLayout = vi.fn();
    act(() => root.render(<IllustrationTab {...fx.props} onAddToLayout={onAddToLayout} />));
    await flush();
    openSection("Export");
    act(() => button("Add panels to Layout").click());
    const [recipes] = onAddToLayout.mock.calls[0];
    const blocks = recipes.filter((recipe: { kind: string }) => recipe.kind === "proportions");
    expect(blocks).toHaveLength(1);
    // One panel, every population side by side at each file, as the figure's summary draws it.
    expect(blocks[0].panel).toEqual({});
    expect(blocks[0].settings).toMatchObject({ files: ["D1", "D2", "D3"], panelsPerRow: 1, populationsTogether: true });
    expect(blocks[0].settings.selectedPops).toEqual(["Q1", "Q2", "Q3"].map((name) => fx.ref(name).populationId));
  });

  it("offers four ways to use the populations, in order, and stores each", async () => {
    const fx = fixture(["Q1", "Q2"]);
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    openSection("Plots");
    const [picker] = pickers();
    const options = [...picker.options].map((o) => o.textContent);
    expect(options[0]).toBe("Each selected population in its own panel");
    expect(options[1]).toBe("The selected populations together in one panel");
    expect(options.slice(2, -1).every((text) => text!.startsWith("One population: "))).toBe(true);
    expect(options).toContain("One population: Q3");
    expect(options[options.length - 1]).toBe("Its own list…");
    expect(picker.value).toBe("");
    const plot = () => fx.props.configRef.current!.figure!.plots[0];
    const editor = () => host.querySelector<HTMLElement>(".gl-figure-plot-editor")!;
    // Following the tree, the editor says how many are ticked.
    expect(editor().textContent).toContain("2 selected in Data");

    choose(pickers()[0], "__together__");
    await flush();
    expect(plot().together).toBe(true);
    expect(plot().population).toBeUndefined();
    expect(plot().populations).toBeUndefined();
    expect(editor().textContent).toContain("2 selected in Data");

    choose(pickers()[0], JSON.stringify([fx.ref("Q3").hierarchyId, fx.ref("Q3").populationId]));
    await flush();
    expect(plot().together).toBeUndefined();
    expect(plot().population?.label).toBe("Q3");
    expect(editor().textContent).not.toContain("selected in Data");

    choose(pickers()[0], "__overlay__");
    await flush();
    expect(plot().together).toBeUndefined();
    expect(plot().population).toBeUndefined();
    expect(plot().populations?.map((p) => p.label)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(editor().textContent).toContain("These populations are this plot's alone and do not follow the tree in Data.");
    expect(editor().textContent).not.toContain("selected in Data");

    choose(pickers()[0], "");
    await flush();
    expect(plot().together).toBeUndefined();
    expect(plot().population).toBeUndefined();
    expect(plot().populations).toBeUndefined();
  });

  it("loads a saved figure with a plot's own list on \"Its own list…\", with its hint", async () => {
    const fx = fixture(["Q1"]);
    fx.props.configRef.current!.figure!.plots[0].populations = ["Q2", "Q4"].map(fx.ref);
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    openSection("Plots");
    const [picker] = pickers();
    expect(picker.value).toBe("__overlay__");
    expect(picker.selectedOptions[0].textContent).toBe("Its own list…");
    expect(host.textContent).toContain("These populations are this plot's alone and do not follow the tree in Data.");
  });

  it("says under the Data section's Populations heading what the tree does", async () => {
    const fx = fixture(["Q1"]);
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    openSection("Data");
    expect(host.querySelector("#figure-section-data")?.textContent ?? host.textContent).toContain(
      "Ticked populations are drawn by every plot set to follow them (Plots → Populations).",
    );
  });
});
