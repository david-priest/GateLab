// @vitest-environment jsdom
// The order a Plotting chart draws its files and groups in: files in the file list's order, as
// Illustration orders them, and a metadata column's values in the column's own order of its levels
// (the workspace's, set from the Plotting or the Metadata tab), else at their first file. The chart,
// its colours, its legend, its CSV and a Layout block under an iteration all follow it. Synthetic
// files D1 to D3, groups control and treated; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newPopulation, newRootPopulation } from "../engine/models";
import { paletteColors } from "../engine/palettes";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import type { MetadataColumn } from "../engine/metadata";
import { initialCoreState, recompute, type CoreState } from "../store";
import type { CellValuesModel } from "../engine/cellValuesModel";
import { I18nProvider } from "./i18n";
import { ProportionsChart, PlottingTab } from "./PlottingTab";
import { MetadataTab } from "./MetadataTab";
import { cellsDataCsv, proportionsDataCsv, statisticDataCsv } from "./plottingData";
import { plottingFacetLevels, plottingFactorLevels, plottingGroupLevels } from "./plottingColours";
import { columnLevelsAfterReorder, moveLevel } from "./LevelOrderControl";
import { cellPanels } from "./CellValuesChart";
import { statisticChartFrame } from "./StatisticChart";
import { clearPersistedTabState } from "./tabState";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearPersistedTabState();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const METADATA = { D1: { condition: "control" }, D2: { condition: "treated" }, D3: { condition: "control" } };

function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const child = newPopulation("Lymphocytes", [], rootPop.population_id);
  rootPop.children = [child.population_id];
  Object.assign(state, {
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
  const sample = (id: string) => ({ id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) });
  return { state: state as CoreState, sample };
}

type File = ReturnType<ReturnType<typeof fixture>["sample"]>;

/** The tab as App holds it: the column's levels in the workspace, set through onColumnLevels. */
function renderTab(samples: File[], initial: MetadataColumn[]) {
  const fx = fixture();
  let columns = initial;
  const onColumnLevels = vi.fn((name: string, levels: string[] | undefined) => {
    columns = columns.map((c) => (c.name === name ? (levels ? { ...c, levels } : { name: c.name }) : c));
    draw();
  });
  const draw = () =>
    act(() =>
      root.render(
        <I18nProvider>
          <PlottingTab
            samples={samples}
            activeSampleId={samples[0].id}
            state={fx.state}
            derived={recompute(samples[0].sample, fx.state)}
            metadata={METADATA}
            metadataColumns={columns}
            divisionProfiles={{}}
            dataRevisionKey="r1"
            onColumnLevels={onColumnLevels}
          />
        </I18nProvider>,
      ),
    );
  draw();
  return { onColumnLevels, columns: () => columns };
}

/** The stacked bar's category ticks: each tick's own text, not its tooltip. */
const ticks = (labels: string[]) =>
  [...host.querySelectorAll("svg text")]
    .map((text) => [...text.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(""))
    .filter((text) => labels.includes(text));

describe("The Plotting tab's order of files and groups", () => {
  it("draws files in the file list's order, not their names' order, and says so where the group is the file", () => {
    const fx = fixture();
    // Listed D2 before D1: alphabetical and file-list order differ.
    renderTab([fx.sample("D2"), fx.sample("D1")], []);
    expect(ticks(["D1.fcs", "D2.fcs"])).toEqual(["D2.fcs", "D1.fcs"]);
    expect(host.querySelector(".gl-prop-order")).toBeNull();
    expect(host.querySelector(".gl-prop-order-hint")!.textContent).toBe("Files are drawn in the file list's order.");
  });

  it("draws a column's values at their first file without levels, and in the column's levels with them", () => {
    const fx = fixture();
    renderTab([fx.sample("D2"), fx.sample("D1")], [{ name: "condition" }]);
    expect(ticks(["control", "treated"])).toEqual(["treated", "control"]);
    act(() => root.unmount());
    root = createRoot(host);
    // A workspace saved with the column's levels opens with them.
    renderTab([fx.sample("D2"), fx.sample("D1")], [{ name: "condition", levels: ["control", "treated"] }]);
    expect(ticks(["control", "treated"])).toEqual(["control", "treated"]);
  });

  it("sets the column's levels for the workspace when moved, and clears them on reset", () => {
    const fx = fixture();
    const tab = renderTab([fx.sample("D1"), fx.sample("D2")], [{ name: "condition" }]);
    expect(ticks(["control", "treated"])).toEqual(["control", "treated"]);
    const order = host.querySelector<HTMLDetailsElement>(".gl-prop-order")!;
    expect(order.open).toBe(false);
    expect(order.querySelector(".gl-prop-order-line")!.textContent).toBe("control, treated");
    expect(order.querySelector(".gl-prop-order-hint")!.textContent).toBe("This order applies wherever the column is used.");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Move up: treated"]')!.click());
    expect(tab.onColumnLevels).toHaveBeenLastCalledWith("condition", ["treated", "control"]);
    expect(tab.columns()).toEqual([{ name: "condition", levels: ["treated", "control"] }]);
    expect(ticks(["control", "treated"])).toEqual(["treated", "control"]);
    expect(host.querySelector(".gl-prop-order-line")!.textContent).toBe("treated, control");
    act(() => host.querySelector<HTMLButtonElement>(".gl-prop-order-reset")!.click());
    expect(tab.onColumnLevels).toHaveBeenLastCalledWith("condition", undefined);
    expect(tab.columns()).toEqual([{ name: "condition" }]);
    expect(ticks(["control", "treated"])).toEqual(["control", "treated"]);
    expect(host.querySelector(".gl-prop-order-reset")).toBeNull();
  });

  it("keeps a column's levels for values the chart's files do not carry", () => {
    expect(columnLevelsAfterReorder(["treated", "control"], ["control", "naive", "treated"])).toEqual(["treated", "control", "naive"]);
    expect(columnLevelsAfterReorder(["treated", "control"])).toEqual(["treated", "control"]);
    expect(moveLevel(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveLevel(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
  });

  it("colours and lists treated first in the legend, and writes it first in the CSV", () => {
    const groupLevels = plottingGroupLevels({ files: ["D1", "D2"], groupSel: "condition" }, [{ id: "D1", name: "D1.fcs" }, { id: "D2", name: "D2.fcs" }], METADATA, { condition: ["treated"] });
    expect(groupLevels).toEqual(["treated", "control"]);
    const model = {
      catLevels: ["Lymphocytes"],
      perSample: [
        { unit: "D1", group: "control", facet: null, catCounts: [2, 1], popCounts: [2] },
        { unit: "D2", group: "treated", facet: null, catCounts: [1, 2], popCounts: [1] },
      ],
      hasFacet: false,
    };
    act(() =>
      root.render(
        <ProportionsChart
          plotType="box"
          model={model}
          catColors={["#2f80ed"]}
          palette="paired"
          groupLevels={groupLevels}
          averagePerUnit
          populations={{}}
          fonts={{ tick: 9, axis: 10, legend: 11 }}
        />,
      ),
    );
    const items = [...host.querySelectorAll<HTMLElement>(".gl-prop-legend-item")];
    expect(items.map((item) => item.querySelector(".gl-prop-legend-label")!.textContent)).toEqual(["treated", "control"]);
    const colours = paletteColors("paired", 2);
    const swatch = (i: number) => items[i].querySelector<HTMLElement>(".gl-prop-swatch")!.style.background;
    const probe = document.createElement("span");
    const css = (colour: string) => ((probe.style.background = colour), probe.style.background);
    expect([swatch(0), swatch(1)]).toEqual([css(colours[0]), css(colours[1])]);
    expect(ticks(["control", "treated"])).toEqual(["treated", "control"]);

    const csv = proportionsDataCsv({ ...model, catLevels: ["Lymphocytes", "rest"] }, { group: "condition" }, (id) => `${id}.fcs`, true, { groups: groupLevels });
    const groupsInRows = csv.trim().split("\n").slice(1).map((line) => line.split(",")[1]);
    expect(groupsInRows).toEqual(["treated", "treated", "control", "control"]);
  });

  it("orders per-cell and statistic panels, slots and CSV rows by the chart's levels", () => {
    const violin = (cat: number, group: string, facet: string | null, unit: string | null, values: number[], files: string[]) =>
      ({ cat, group, facet, unit, values: Float32Array.from(values), files });
    const model: CellValuesModel = {
      catLevels: ["CD4_positive"],
      levels: [{ popId: "p", depth: 1 }],
      violins: [violin(0, "control", "B1", "D1.fcs", [1, 2, 3], ["D1.fcs"]), violin(0, "treated", "B2", "D2.fcs", [4, 5, 6], ["D2.fcs"])],
      hasFacet: true,
      channelLabel: "FSC-A",
      excluded: [],
      noChannel: [],
      extent: [1, 6],
      axisSource: null,
    };
    const order = { groups: ["treated", "control"], facets: ["B2", "B1"], units: ["D2.fcs", "D1.fcs"] };
    const { panels, groups } = cellPanels(model, "groups", undefined, undefined, order);
    expect(groups).toEqual(["treated", "control"]);
    expect(panels.map((panel) => panel.facet)).toEqual(["B2", "B1"]);
    expect(panels[0].slots.map((slot) => slot.label)).toEqual(["treated", "control"]);
    const cellRows = cellsDataCsv(model, model, {}, "FSC-A", { ...order, xAxis: "groups" }).trim().split("\n").slice(1).map((line) => line.split(",")[0]);
    expect(cellRows).toEqual(["treated", "control"]);
    const settings = { statistic: "median", errorBar: "sd", test: false, xAxis: "groups", unitSel: "__sample__", panelWidth: 0, height: 200, fontTick: 9, fontAxis: 10, plotType: "dots" } as const;
    const frame = statisticChartFrame(model, settings, undefined, undefined, order);
    expect(frame.groups).toEqual(["treated", "control"]);
    expect(frame.points.map((point) => point.unit)).toEqual(["D2.fcs", "D1.fcs"]);
    const statRows = statisticDataCsv(model, settings, {}, "FSC-A", order).trim().split("\n").slice(1).map((line) => line.split(",")[0]);
    expect(statRows).toEqual(["D2.fcs", "D1.fcs"]);
  });

  it("keeps the whole chart's order for a block drawn for some of its files", () => {
    const files = [{ id: "D1", name: "D1.fcs" }, { id: "D2", name: "D2.fcs" }, { id: "D3", name: "D3.fcs" }];
    const settings = { files: ["D1", "D2", "D3"], groupSel: "condition", facetSel: "condition" };
    const levels = { condition: ["treated", "control"] };
    // A Layout iteration narrows the files; the levels are taken over all of the chart's files.
    expect(plottingGroupLevels(settings, files, METADATA, levels)).toEqual(["treated", "control"]);
    expect(plottingFacetLevels(settings, files, METADATA, levels)).toEqual(["treated", "control"]);
    expect(plottingGroupLevels(settings, files, METADATA)).toEqual(["control", "treated"]);
    expect(plottingFacetLevels({ ...settings, facetSel: "" }, files, METADATA, levels)).toEqual([]);
    // The file factor's levels are file names, in the file list's order; a column's levels do not touch them.
    expect(plottingFactorLevels({ files: ["D3", "D1"] }, "__sample__", files, METADATA, levels)).toEqual(["D1.fcs", "D3.fcs"]);
  });
});

describe("The Metadata tab's order of a column's values", () => {
  it("shows each column's order and sets the column's levels", () => {
    const fx = fixture();
    const onColumnLevels = vi.fn();
    act(() =>
      root.render(
        <I18nProvider>
          <MetadataTab
            samples={[fx.sample("D1"), fx.sample("D2"), fx.sample("D3")]}
            metadata={METADATA}
            columns={[{ name: "condition", levels: ["treated"] }]}
            onSetCell={() => {}}
            onAddColumn={() => {}}
            onRenameColumn={() => {}}
            onDeleteColumn={() => {}}
            onColumnLevels={onColumnLevels}
            onImport={() => {}}
            populationRows={[]}
            populationMetadata={{}}
            populationColumns={[]}
            onSetPopCell={() => {}}
            onAddPopColumn={() => {}}
            onRenamePopColumn={() => {}}
            onDeletePopColumn={() => {}}
          />
        </I18nProvider>,
      ),
    );
    const order = host.querySelector<HTMLDetailsElement>(".gl-meta-orders .gl-prop-order")!;
    expect(order.querySelector(".gl-prop-order-line")!.textContent).toBe("treated, control");
    act(() => host.querySelector<HTMLButtonElement>('.gl-meta-orders button[aria-label="Move up: control"]')!.click());
    expect(onColumnLevels).toHaveBeenLastCalledWith("condition", ["control", "treated"]);
    act(() => host.querySelector<HTMLButtonElement>(".gl-meta-orders .gl-prop-order-reset")!.click());
    expect(onColumnLevels).toHaveBeenLastCalledWith("condition", undefined);
  });
});
