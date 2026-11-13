// @vitest-environment jsdom
// A summary chart plot in an Illustration figure ("One panel for all files"): the plot editor's
// checkbox, one chart panel spanning the row of files under their histograms with a mark per file
// under each column's centre, the panel in the SVG export, and the panel handed to the Layout tab
// as one Plotting block of every file. Synthetic files D1, D2 and D3 in groups control and
// treated; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IllustrationTab } from "./IllustrationTab";
import { coreReducer, initialCoreState, type CoreState } from "../store";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { figureHierarchies, migrateFigure, type FigureChart, type FigureSample } from "../engine/figure";
import type { IllustrationConfig } from "../engine/workspace";
import { defaultIllustrationConfig } from "../engine/figureDefaults";
import { PROPORTIONS_SAMPLE_FACTOR } from "../engine/proportionsSettings";
import { gridSvgFile } from "../plots/gridExport";

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

const SIZE = 200;
const GROUPS: Record<string, string> = { D1: "control", D2: "treated", D3: "control" };

/** Three files, each with four events; a violin plot of FSC-A under a histogram row, files on columns. */
function fixture(chart: FigureChart = { valueKind: "cells", plotType: "violin", summary: true }) {
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
  const figure = migrateFigure(null, samples, trees, core.active_hierarchy_id, "FSC-A", "SSC-A");
  figure.populations = [{ hierarchyId: core.active_hierarchy_id, populationId: core.root_population_id!, label: "All Events" }];
  figure.plots = [
    { id: "size", name: "Size", x: "FSC-A", y: "FSC-A", type: "histogram" },
    { id: "violin", name: "FSC violin", x: "FSC-A", y: "FSC-A", type: "chart", chart },
  ];
  figure.rows = ["populations", "plots"];
  figure.columns = ["samples"];
  figure.panelSize = SIZE;
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

const openSection = (name: string) =>
  act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === name)!.click());
const checkbox = (editor: HTMLElement, text: string) =>
  [...editor.querySelectorAll("label")].find((l) => l.textContent?.trim() === text)?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
const labels = (svg: Element) => [...svg.querySelectorAll("text title")].map((t) => t.textContent);

describe("Illustration: a summary panel of all files", () => {
  it("is a checkbox of a chart plot, off by default, with the file labels off where the files are on the columns", async () => {
    const fx = fixture({ valueKind: "cells", plotType: "violin" });
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    openSection("Plots");
    const editor = () => host.querySelectorAll<HTMLElement>(".gl-figure-plot-editor")[1];
    const summary = checkbox(editor(), "One panel for all files")!;
    expect(summary.checked).toBe(false);
    expect(checkbox(editor(), "Show file labels")).toBeNull();
    expect(checkbox(editor(), "Show population labels")).not.toBeNull();
    act(() => summary.click());
    await flush();
    expect(fx.props.configRef.current!.figure!.plots[1].chart).toEqual({ valueKind: "cells", plotType: "violin", summary: true });
    // The file labels repeat the column headings above: off unless asked for.
    const fileLabels = checkbox(editor(), "Show file labels")!;
    expect(fileLabels.checked).toBe(false);
    expect(checkbox(editor(), "Show population labels")).toBeNull();
    act(() => fileLabels.click());
    await flush();
    expect(fx.props.configRef.current!.figure!.plots[1].chart).toMatchObject({ summary: true, fileLabels: true });
    // The histogram plot has none of it.
    expect(checkbox(host.querySelectorAll<HTMLElement>(".gl-figure-plot-editor")[0], "One panel for all files")).toBeNull();
  });

  it("draws one chart panel across the row, a violin per file in its column, the file names hidden under the headings", async () => {
    const fx = fixture();
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    const rows = [...host.querySelectorAll<HTMLTableRowElement>("#figure-preview-grid tbody tr")];
    expect(rows).toHaveLength(2);
    const cells = rows.map((row) => [...row.querySelectorAll<HTMLTableCellElement>("td[data-figure-panel]")]);
    expect(cells.map((row) => row.length)).toEqual([3, 1]);
    const summary = cells[1][0];
    expect(summary.colSpan).toBe(3);
    const charts = host.querySelectorAll<HTMLElement>(".gl-figure-chart");
    expect(charts).toHaveLength(1);
    const chart = charts[0];
    // The panel is as wide as the three columns and the spaces between them.
    expect(chart.style.width).toBe(`${3 * SIZE + 2 * 12}px`);
    const svg = chart.querySelector("svg.gl-prop-panel")!;
    expect(labels(svg)).toEqual(["", "", ""]);
    // Each file's place is centred under its column: the chart is moved left by its axis margin.
    const hang = -parseFloat(chart.querySelector<HTMLElement>(".gl-figure-summary-chart")!.style.marginLeft);
    const ticks = [...svg.querySelectorAll("text")].filter((t) => t.querySelector("title")).map((t) => Number(t.getAttribute("x")) - hang);
    ticks.forEach((x, j) => expect(x).toBeCloseTo(j * (SIZE + 12) + SIZE / 2, 6));
    // Three violins, one per file, each from its file's four events.
    expect(chart.getAttribute("aria-label")).toBe("FSC violin; 12 cells");
    // The value axis has room left of the first column, in the row headings.
    const heading = rows[1].querySelectorAll<HTMLElement>("th")[rows[1].querySelectorAll("th").length - 1];
    expect(parseFloat(heading.style.paddingRight)).toBe(Math.ceil(hang) - 12);
  });

  it("names the files under the marks when asked, and the metadata values when the files are grouped by one", async () => {
    const fx = fixture({ valueKind: "cells", plotType: "box", summary: true, fileLabels: true });
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    expect(labels(host.querySelector(".gl-figure-chart svg.gl-prop-panel")!)).toEqual(["D1.fcs", "D2.fcs", "D3.fcs"]);
    act(() => root.unmount());
    root = createRoot(host);
    const figure = fx.props.configRef.current!.figure!;
    figure.columns = ["metadata:group", "samples"];
    figure.composition = "pool";
    figure.plots[1].chart = { valueKind: "statistic", plotType: "box", summary: true, fileLabels: true };
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    const summary = host.querySelector<HTMLTableCellElement>("#figure-preview-grid tbody tr:nth-child(2) td[data-figure-panel]")!;
    expect(summary.colSpan).toBe(2);
    // The value axis's title, then a box of each group's files.
    expect(labels(summary.querySelector("svg.gl-prop-panel")!)).toEqual(["Median FSC-A", "control", "treated"]);
  });

  it("is exported as one vector chart over the span", async () => {
    const fx = fixture();
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    const file = gridSvgFile("figure-preview-grid")!;
    expect(file.xml.match(/class="gl-prop-panel"/g)).toHaveLength(1);
    const width = Number(host.querySelector(".gl-figure-chart svg.gl-prop-panel")!.getAttribute("width"));
    expect(width).toBeGreaterThan(3 * (SIZE + 12));
    expect(file.xml).toContain(`width="${width}"`);
  });

  it("goes to the Layout tab as one Plotting block of every file, the width of the span, on the figure's value range", async () => {
    const fx = fixture();
    const onAddToLayout = vi.fn();
    act(() => root.render(<IllustrationTab {...fx.props} onAddToLayout={onAddToLayout} />));
    await flush();
    openSection("Export");
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add panels to Layout")!.click());
    const [recipes, cells, , panelSize] = onAddToLayout.mock.calls[0];
    expect(panelSize).toBe(SIZE);
    expect(recipes.map((recipe: { kind: string }) => recipe.kind)).toEqual(["histogram", "histogram", "histogram", "proportions"]);
    expect(cells[3]).toEqual({ row: 1, column: 0, span: { rows: 1, columns: 3 } });
    const block = recipes[3];
    expect(block.textSize).toBe("sheet");
    expect(block.panel).toEqual({});
    expect(block.settings).toMatchObject({
      valueKind: "cells",
      plotType: "violin",
      files: ["D1", "D2", "D3"],
      xAxis: "groups",
      groupSel: PROPORTIONS_SAMPLE_FACTOR,
      panelWidth: 3 * SIZE + 2 * 20,
      // Every population side by side at each file in one panel, coloured by population, as the figure's summary draws it.
      populationsTogether: true,
    });
    expect("colourByPopulation" in block.settings).toBe(false);
    expect(typeof block.settings.valueMin).toBe("number");
    expect(typeof block.settings.valueMax).toBe("number");
  });
});
