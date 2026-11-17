// @vitest-environment jsdom
// While the files are being prepared one after another, a plot of a file already prepared is not
// drawn again as each of the others arrives. The source-preparing hook stands in here so the
// files can be handed over one at a time with the plots drawn between. Synthetic files D1 and D2.

import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutWorkspace, normalizeLayoutWorkspace } from "../engine/layout";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { figureHierarchies, prepareFigureSource, type FigureSample, type FigureSource } from "../engine/figure";
import { initialCoreState, type CoreState } from "../store";
import { I18nProvider } from "./i18n";
import { LayoutTab } from "./LayoutTab";

type Prepared = { key: string; sources: FigureSource[]; pending: number; current: boolean; error: string | null };
const prep = vi.hoisted(() => ({
  result: { key: "k", sources: [], pending: 2, current: true, error: null } as Prepared,
  listeners: new Set<() => void>(),
  draws: [] as { host: HTMLElement }[],
}));
vi.mock("./useFigureSources", () => ({
  useFigureSources: () => useSyncExternalStore(
    (listener) => { prep.listeners.add(listener); return () => prep.listeners.delete(listener); },
    () => prep.result,
  ),
}));
vi.mock("../plots/loadPlots", () => ({
  loadMiniPlots: () => ({
    renderMiniPlot: (host: HTMLElement) => { prep.draws.push({ host }); },
    renderStrategyGrid: () => {},
  }),
}));
vi.mock("react-moveable", () => ({ default: () => null }));
vi.mock("react-selecto", () => ({ default: () => null }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  prep.draws = [];
  prep.listeners.clear();
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
function publish(next: Prepared) {
  prep.result = next;
  act(() => { for (const listener of prep.listeners) listener(); });
}

describe("LayoutTab while files are prepared", () => {
  it("draws a plot of a prepared file once, not again as each other file is prepared", async () => {
    const state = initialCoreState();
    const rootPop = newRootPopulation();
    const child = newPopulation("CD4_positive", [], rootPop.population_id);
    rootPop.children = [child.population_id];
    Object.assign(state, {
      populations: { [rootPop.population_id]: rootPop, [child.population_id]: child },
      root_population_id: rootPop.population_id,
      active_population_id: rootPop.population_id,
    });
    const fcs: FcsFile = {
      version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {}, spillover: null,
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from([10, 20, 30]), Float32Array.from([30, 20, 10])],
    };
    const files: FigureSample[] = [
      { id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs), metadata: { donor: "D1" } },
      { id: "D2", name: "D2.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs), metadata: { donor: "D2" } },
    ];
    const tree = figureHierarchies(state)[DEFAULT_HIERARCHY_ID];
    const [d1, d2] = files.map((file) => prepareFigureSource(file, tree, state));
    const saved = JSON.parse(JSON.stringify(createDefaultLayoutWorkspace()));
    saved.sheets[0].items = [{
      id: "plot-1", x: 80, y: 90, width: 260, height: 280, z: 0,
      recipe: { kind: "biplot", sampleId: "D1", populationId: rootPop.population_id, xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "scatter" },
    }];
    const workspace = normalizeLayoutWorkspace(saved);
    prep.result = { key: "k", sources: [], pending: 2, current: true, error: null };
    act(() => root.render(
      <I18nProvider>
        <LayoutTab
          workspace={workspace}
          onChange={() => {}}
          samples={files}
          checkedSampleIds={["D1", "D2"]}
          metadataColumns={["donor"]}
          activeSampleId="D1"
          activePopulationId={rootPop.population_id}
          state={state as CoreState}
          globalScales={{}}
          defaultX="FSC-A"
          defaultY="SSC-A"
          illustrationConfig={null}
          dataRevision={0}
          densityColorPower={1.6}
          onOpenInGating={() => {}}
        />
      </I18nProvider>,
    ));
    await flush();
    // D1 prepared: its plot is drawn.
    publish({ key: "k", sources: [d1], pending: 1, current: true, error: null });
    await flush();
    expect(prep.draws).toHaveLength(1);
    // D2 prepared after it: the list is new, D1's source is the one it was, and its plot stands.
    publish({ key: "k", sources: [d1, d2], pending: 0, current: true, error: null });
    await flush();
    expect(prep.draws).toHaveLength(1);
  });
});
