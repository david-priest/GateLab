// @vitest-environment jsdom
// Chart plots in an Illustration figure: the plot editor's chart types, a violin row under a
// histogram row sharing its columns and panel width, the chart in the SVG export, and the chart
// panels handed to the Layout tab in the cells of the grid. Synthetic files D1 and D2; nothing
// here is a real experiment.

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
import { gridSvgFile } from "../plots/gridExport";
import type { LayoutProportionsRecipe } from "../engine/layout";
import { I18nProvider } from "./i18n";
import { LayoutProportionsSurface } from "./LayoutProportions";

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
const typePickers = () =>
  [...host.querySelectorAll<HTMLLabelElement>(".gl-figure-plot-editor label")].filter((l) => l.firstChild?.textContent?.trim() === "Type").map((l) => l.querySelector("select")!);
const choose = (select: HTMLSelectElement, value: string) =>
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

describe("Illustration: chart plots", () => {
  it("offers the chart types after the plot types, with each kind's options and the channel where it has one", async () => {
    const fx = fixture();
    fx.props.configRef.current!.figure!.plots[1] = { id: "two", name: "Two", x: "FSC-A", y: "SSC-A", type: "biplot" };
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    openSection("Plots");
    const editor = () => host.querySelectorAll<HTMLElement>(".gl-figure-plot-editor")[1];
    expect([...typePickers()[1].options].map((o) => o.textContent)).toEqual([
      "Biplot", "Histogram", "Summary heatmap", "Violin", "Boxplot", "Statistic per file", "Composition",
    ]);
    const figure = () => fx.props.configRef.current!.figure!;
    choose(typePickers()[1], "chart:violin");
    await flush();
    expect(figure().plots[1]).toMatchObject({ type: "chart", chart: { valueKind: "cells", plotType: "violin" } });
    expect(editor().textContent).toContain("Median and quartiles inside");
    expect(editor().textContent).toContain("Show population labels");
    expect(editor().textContent).toContain("Channel");
    expect(editor().textContent).not.toContain("Y channel");
    choose(typePickers()[1], "chart:statistic");
    await flush();
    expect(figure().plots[1].chart).toEqual({ valueKind: "statistic", plotType: "box" });
    expect(editor().querySelector('select[aria-label="Statistic"]')).not.toBeNull();
    choose(typePickers()[1], "chart:proportion");
    await flush();
    expect(figure().plots[1].chart).toEqual({ valueKind: "proportion", plotType: "stacked" });
    expect(editor().textContent).not.toContain("Channel");
    // The chart's own populations: the overlay checklist, labelled Populations.
    const picker = [...editor().querySelectorAll("label")].find((l) => l.firstChild?.textContent?.trim() === "Populations")!.querySelector("select")!;
    expect([...picker.options].map((o) => o.textContent)).toContain("Its own list…");
    choose(picker, "__overlay__");
    await flush();
    expect(editor().querySelector('[aria-label="Populations · Two"]')).not.toBeNull();
    // Back to a histogram drops the chart.
    choose(typePickers()[1], "histogram");
    await flush();
    expect(figure().plots[1].type).toBe("histogram");
    expect(figure().plots[1].chart).toBeUndefined();
  });

  it("keeps the Plotting settings a chart carries when its kind is changed", async () => {
    const fx = fixture();
    const carried = { showN: true, grid: true, errorBar: "sem" as const, valueMin: 10, replicateMarks: "median" as const };
    fx.props.configRef.current!.figure!.plots[1] = { id: "two", name: "Two", x: "FSC-A", y: "SSC-A", type: "chart", chart: { valueKind: "cells", plotType: "violin", ...carried } };
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    openSection("Plots");
    const figure = () => fx.props.configRef.current!.figure!;
    choose(typePickers()[1], "chart:statistic");
    await flush();
    expect(figure().plots[1].chart).toEqual({ valueKind: "statistic", plotType: "box", ...carried });
    choose(typePickers()[1], "chart:box");
    await flush();
    expect(figure().plots[1].chart).toEqual({ valueKind: "cells", plotType: "box", ...carried });
  });

  it("draws the violin row under the histogram row, each file's chart in its histogram's column at the same width, and exports it as vector", async () => {
    const fx = fixture();
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    const rows = [...host.querySelectorAll<HTMLTableRowElement>("#figure-preview-grid tbody tr")];
    expect(rows).toHaveLength(2);
    const cells = rows.map((row) => [...row.querySelectorAll<HTMLElement>("td[data-figure-panel]")]);
    expect(cells.map((row) => row.length)).toEqual([2, 2]);
    for (let column = 0; column < 2; column++) {
      const histogram = cells[0][column].querySelector<HTMLElement>(".mini-plot-cell")!;
      const chart = cells[1][column].querySelector<HTMLElement>(".gl-figure-chart")!;
      expect(histogram).not.toBeNull();
      expect(chart).not.toBeNull();
      // The same file heads both: the column's panels draw it.
      expect(JSON.parse(cells[1][column].dataset.figurePanel!)).toContainEqual(JSON.parse(cells[0][column].dataset.figurePanel!).find((v: { dimension: string }) => v.dimension === "samples"));
      expect(chart.style.width).toBe(histogram.style.width);
      expect(chart.style.width).toBe("260px");
      const svg = chart.querySelector("svg.gl-prop-panel")!;
      expect(svg.getAttribute("width")).toBe("260");
      // Four quadrants along x, their names under the panel, no title and no legend in the chart.
      expect([...svg.querySelectorAll("text title")].map((t) => t.textContent)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
      expect(chart.querySelector(".gl-prop-legend")?.hasAttribute("hidden")).toBe(true);
    }
    // The populations are named in their colours once, under the first chart panel.
    expect(host.querySelectorAll(".gl-figure-chart-panel .gl-figure-legend")).toHaveLength(1);
    const file = gridSvgFile("figure-preview-grid")!;
    expect(file.xml.match(/class="gl-prop-panel"/g)).toHaveLength(2);
  });

  it("hides the population names when the plot says so", async () => {
    const fx = fixture();
    fx.props.configRef.current!.figure!.plots[1].chart = { valueKind: "cells", plotType: "box", populationLabels: false };
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    const svg = host.querySelector(".gl-figure-chart svg.gl-prop-panel")!;
    expect([...svg.querySelectorAll("text title")].map((t) => t.textContent)).toEqual(["", "", "", ""]);
  });

  it("draws a statistic plot's panels on one value axis while the figure's axes are shared, each on its own when they are the file's own", async () => {
    const fx = fixture({ D1: [10, 90, 90, 10], D2: [20, 900, 900, 20] });
    const figure = fx.props.configRef.current!.figure!;
    figure.plots[1].chart = { valueKind: "statistic", plotType: "box" };
    figure.scalePolicy = "shared";
    const topTicks = () =>
      [...host.querySelectorAll<SVGSVGElement>(".gl-figure-chart svg.gl-prop-panel")].map((svg) =>
        [...svg.querySelectorAll('text[text-anchor="end"]')].filter((t) => !t.querySelector("title")).map((t) => t.textContent).at(-1),
      );
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    // D1's medians reach 90 and D2's 900: both panels on the axis that holds 900.
    expect(topTicks()).toEqual(["1,000", "1,000"]);
    act(() => root.unmount());
    root = createRoot(host);
    fx.props.configRef.current!.figure!.scalePolicy = "individual";
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    expect(topTicks()).toEqual(["100", "1,000"]);
  });

  it("sends each chart panel to the Layout tab as a Plotting block of one panel, in its cell under its histogram", async () => {
    const fx = fixture();
    const onAddToLayout = vi.fn();
    act(() => root.render(<IllustrationTab {...fx.props} onAddToLayout={onAddToLayout} />));
    await flush();
    openSection("Export");
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add panels to Layout")!.click());
    const [recipes, cells, , panelSize] = onAddToLayout.mock.calls[0];
    expect(panelSize).toBe(260);
    const placed = recipes.map((recipe: { kind: string; sampleId?: string; settings?: { files: string[] } }, i: number) => [
      recipe.kind, recipe.sampleId ?? recipe.settings!.files.join(), cells[i].row, cells[i].column,
    ]);
    expect(placed).toEqual([
      ["histogram", "D1", 0, 0],
      ["histogram", "D2", 0, 1],
      ["proportions", "D1", 1, 0],
      ["proportions", "D2", 1, 1],
    ]);
    const chart = recipes[2];
    expect(chart.panel).toEqual({});
    expect(chart.settings).toMatchObject({
      valueKind: "cells",
      plotType: "violin",
      channel: "FSC-A",
      xAxis: "populations",
      selectedPops: fx.quadrants.map((q) => q.populationId),
      panelWidth: 260,
      legend: false,
    });
  });

  /** A panel's value-axis ticks as numbers: "1K" and "1,000" alike are 1000. */
  const tickValues = (svg: Element) =>
    [...svg.querySelectorAll('text[text-anchor="end"]')]
      .filter((t) => !t.querySelector("title"))
      .map((t) => t.textContent!.replace(/,/g, ""))
      .filter((label) => /^-?[\d.]+[KM]?$/.test(label))
      .map((label) => Number(label.replace(/[KM]$/, "")) * (label.endsWith("K") ? 1e3 : label.endsWith("M") ? 1e6 : 1));
  /** The blocks the chart panels are sent as, and each one's value ticks drawn on a Layout sheet beside the panel's here. */
  async function sentBlocks(fx: ReturnType<typeof fixture>) {
    const onAddToLayout = vi.fn();
    act(() => root.render(<IllustrationTab {...fx.props} onAddToLayout={onAddToLayout} />));
    await flush();
    const drawn = [...host.querySelectorAll<SVGSVGElement>(".gl-figure-chart svg.gl-prop-panel")].map(tickValues);
    openSection("Export");
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add panels to Layout")!.click());
    const blocks = (onAddToLayout.mock.calls[0][0] as { kind: string }[]).filter((r): r is LayoutProportionsRecipe => r.kind === "proportions");
    const sheet = document.createElement("div");
    document.body.appendChild(sheet);
    const sheetRoot = createRoot(sheet);
    const onSheet = blocks.map((recipe, i) => {
      act(() =>
        sheetRoot.render(
          <I18nProvider>
            <LayoutProportionsSurface recipe={recipe} samples={fx.samples} state={fx.core} metadataById={{}} divisionProfiles={{}} width={268} height={268} containerId={`block-${i}`} />
          </I18nProvider>,
        ),
      );
      return tickValues(sheet.querySelector(`#block-${i} svg.gl-prop-panel`)!);
    });
    act(() => sheetRoot.unmount());
    sheet.remove();
    return { blocks, drawn, onSheet };
  }

  it("sends a statistic plot's panels on the value axis they share here, and each on its own when the files' axes are their own", async () => {
    const fx = fixture({ D1: [10, 90, 90, 10], D2: [20, 900, 900, 20] });
    const figure = fx.props.configRef.current!.figure!;
    figure.plots[1].chart = { valueKind: "statistic", plotType: "box" };
    figure.scalePolicy = "shared";
    let sent = await sentBlocks(fx);
    expect(sent.blocks.map((block) => [block.settings.valueMin, block.settings.valueMax])).toEqual([[0, 1000], [0, 1000]]);
    expect(sent.onSheet).toEqual(sent.drawn);
    expect(sent.onSheet.map((ticks) => ticks.at(-1))).toEqual([1000, 1000]);
    act(() => root.unmount());
    root = createRoot(host);
    fx.props.configRef.current!.figure!.scalePolicy = "individual";
    sent = await sentBlocks(fx);
    expect(sent.blocks.map((block) => [block.settings.valueMin ?? null, block.settings.valueMax ?? null])).toEqual([[null, null], [null, null]]);
    expect(sent.onSheet.map((ticks) => ticks.at(-1))).toEqual([100, 1000]);
  });

  it("sends a violin plot's panels on the channel range the figure draws them on", async () => {
    const fx = fixture({ D1: [10, 90, 90, 10], D2: [20, 900, 900, 20] });
    fx.props.configRef.current!.figure!.scalePolicy = "shared";
    const sent = await sentBlocks(fx);
    const ranges = sent.blocks.map((block) => [block.settings.valueMin, block.settings.valueMax]);
    expect(ranges[0]).toEqual(ranges[1]);
    expect(ranges[0].every((limit) => typeof limit === "number")).toBe(true);
    expect(sent.onSheet).toEqual(sent.drawn);
  });

  it("starts a new chart plot on its plot's measured channel, or on the Plotting tab's default channel instead of Time", async () => {
    const fx = fixture(undefined, true);
    fx.props.configRef.current!.figure!.plots[1] = { id: "two", name: "Two", x: "SSC-A", y: "FSC-A", type: "biplot" };
    act(() => root.render(<IllustrationTab {...fx.props} />));
    await flush();
    openSection("Plots");
    const figure = () => fx.props.configRef.current!.figure!;
    // A plot on a measured channel keeps it.
    choose(typePickers()[1], "chart:statistic");
    await flush();
    expect(figure().plots[1]).toMatchObject({ type: "chart", x: "SSC-A" });
    // A plot added here starts on the files' first channel, Time.
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add plot")!.click());
    await flush();
    expect(figure().plots[2].x).toBe("Time");
    choose(typePickers()[2], "chart:violin");
    await flush();
    expect(figure().plots[2]).toMatchObject({ type: "chart", x: "FSC-A" });
  });
});
