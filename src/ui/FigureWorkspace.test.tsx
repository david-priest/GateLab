// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FigureWorkspace } from "./FigureWorkspace";
import { coreReducer, initialCoreState } from "../store";
import { newRootPopulation } from "../engine/models";
import { cloneHierarchyTree, storeHierarchy } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import {
  figureHierarchies,
  migrateFigure,
  type FigureSample,
} from "../engine/figure";
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
const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === text,
  )!;

function fixture() {
  const state = initialCoreState(),
    population = newRootPopulation();
  Object.assign(state, {
    populations: { [population.population_id]: population },
    root_population_id: population.population_id,
    active_population_id: population.population_id,
  });
  const samples: FigureSample[] = Array.from({ length: 17 }, (_, i) => {
    const copy = cloneHierarchyTree(
      state.populations,
      population.population_id,
      {},
      [],
    );
    const id = `D${i + 1}`,
      hierarchyId = `copy-${i}`;
    const ref = {
      id: hierarchyId,
      name: `${id} copy`,
      owner_sample_id: id,
      source_hierarchy_id: "main",
      source_population_ids: Object.fromEntries(
        Object.entries(copy.idMap).map(([a, b]) => [b, a]),
      ),
    };
    state.hierarchies.push(ref);
    state.stored_hierarchies[hierarchyId] = storeHierarchy(ref, {
      ...state,
      ...copy,
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
      columns: [
        Float32Array.from([10, 20, 30]),
        Float32Array.from([30, 20, 10]),
      ],
    };
    return { id, name: `${id}.fcs`, hierarchyId, sample: new Sample(fcs) };
  });
  const configRef: { current: IllustrationConfig | null } = {
    current: {
      ...defaultIllustrationConfig(),
      popIds: [state.stored_hierarchies["copy-16"].root_population_id!],
      xChannels: ["FSC-A"],
      yChannel: "SSC-A",
    },
  };
  const props = {
    samples,
    state,
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
  };
  return props;
}

describe("FigureWorkspace", () => {
  it("explains unused template selections rather than filling every file with missing-population panels", async () => {
    const props = fixture();
    const copy = cloneHierarchyTree(
      props.state.populations,
      props.state.root_population_id!,
      {},
      [],
    );
    const ref = { id: "other", name: "Other template" };
    props.state.hierarchies.push(ref);
    props.state.stored_hierarchies.other = storeHierarchy(ref, {
      ...props.state,
      ...copy,
    });
    const config = props.configRef.current!;
    config.figure = migrateFigure(
      config,
      props.samples,
      figureHierarchies(props.state),
      "main",
      "FSC-A",
      "SSC-A",
    );
    config.figure.populations.push({
      hierarchyId: "other",
      populationId: copy.root_population_id,
      label: "All Events",
    });
    config.figure.rows = [];
    config.figure.columns = ["samples", "populations", "plots"];
    act(() => root.render(<FigureWorkspace {...props} />));
    await flush();
    expect(host.textContent).toContain(
      "17 of 17 files on this page · 17 panels ready",
    );
    expect(host.textContent).toContain("no selected files use this hierarchy");
    expect(host.textContent).toContain("Files / samples");
    expect(host.textContent).not.toContain("population missing");
    act(() => button("Files down rows").click());
    await flush();
    expect(props.configRef.current!.figure!.rows).toEqual(["samples"]);
    expect(host.querySelectorAll('[aria-label="Rendered plot"]')).toHaveLength(
      17,
    );
    act(() => button("Remove unused selections").click());
    await flush();
    expect(props.configRef.current!.figure!.populations).toHaveLength(1);
  });

  it("renders a saved leaf selection across all 17 assigned trees and preserves it across active-file changes", async () => {
    const props = fixture();
    act(() => root.render(<FigureWorkspace {...props} />));
    await flush();
    expect(host.textContent).toContain("17 panels ready");
    expect(host.textContent).toContain(
      "17 files · each uses its assigned hierarchy",
    );
    expect(host.textContent).not.toContain("Unavailable saved population");
    expect(host.querySelectorAll('[aria-label="Rendered plot"]')).toHaveLength(
      17,
    );
    expect(props.configRef.current!.figure!.populations[0].populationId).toBe(
      props.state.root_population_id,
    );
    const spec = structuredClone(props.configRef.current!.figure);
    const state = coreReducer(props.state, {
      type: "switchHierarchy",
      id: "copy-4",
    });
    act(() => root.render(<FigureWorkspace {...props} state={state} />));
    await flush();
    expect(props.configRef.current!.figure).toEqual(spec);
    expect(host.textContent).toContain("17 panels ready");
    expect(host.textContent).toContain("17 of 17 files on this page");
    expect(host.textContent).toContain("Page 1 / 1");
    expect(button("Next").disabled).toBe(true);
  });
  it("applies style changes immediately, keeps panel sizing separate from preview zoom, and supports local undo", async () => {
    const props = fixture();
    act(() => root.render(<FigureWorkspace {...props} />));
    await flush();
    const oldCount = draws.calls.length;
    const size = host.querySelector<HTMLInputElement>(
      '[aria-label="Figure panel size"]',
    )!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(size, "360");
      size.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    expect(draws.calls.length).toBeGreaterThan(oldCount);
    expect(draws.calls.at(-1)!.plot_size).toBe(360);
    act(() => button("Undo").click());
    await flush();
    expect(props.configRef.current!.figure!.panelSize).toBe(280);
    const columns = [...props.configRef.current!.figure!.columns];
    act(() => button("Swap").click());
    await flush();
    expect(props.configRef.current!.figure!.rows).toEqual(columns);
  });
  it("gives an actionable warning for a deleted selection and blocks export", async () => {
    const props = fixture();
    props.configRef.current!.popIds = ["deleted-population"];
    act(() => root.render(<FigureWorkspace {...props} />));
    await flush();
    expect(host.textContent).toContain("Unavailable saved population");
    expect(host.textContent).not.toContain("deleted-population");
    expect(button("Export current page").disabled).toBe(true);
    act(() => button("Remove unavailable selection").click());
    await flush();
    expect(host.textContent).toContain("Build a file / sample comparison");
  });
  it("offers the Gating tab's ranges, fits channels there, and puts one plot per file on the Layout tab", async () => {
    const props = fixture();
    const onFitChannels = vi.fn();
    const onAddToLayout = vi.fn();
    act(() => root.render(<FigureWorkspace {...props} globalScales={{ "FSC-A": [0, 5] }} onFitChannels={onFitChannels} onAddToLayout={onAddToLayout} />));
    await flush();
    act(() => button("Style").click());
    const policy = host.querySelector<HTMLSelectElement>('select[value], select')!;
    const axisSelect = [...host.querySelectorAll<HTMLSelectElement>("select")].find((el) => [...el.options].some((o) => o.value === "gating"))!;
    expect([...axisSelect.options].map((o) => o.value)).toEqual(["shared", "individual", "gating"]);
    void policy;
    act(() => button("Fit data + gates").click());
    await flush();
    expect(onFitChannels).toHaveBeenCalledWith(["FSC-A", "SSC-A"]);
    expect(props.configRef.current!.figure!.scalePolicy).toBe("gating");
    act(() => button("Export").click());
    act(() => button("Add these plots to the Layout tab").click());
    expect(onAddToLayout).toHaveBeenCalledTimes(1);
    const recipes = onAddToLayout.mock.calls[0][0];
    expect(recipes).toHaveLength(17);
    expect(recipes[0]).toMatchObject({ kind: "biplot", sampleId: "D1", xChannel: "FSC-A", yChannel: "SSC-A" });
    expect(["pseudocolor", "scatter", "contour"]).toContain(recipes[0].displayMode);
    expect(recipes[0].title).toContain("D1.fcs");
    expect(recipes[0].populationId).toBe(props.state.stored_hierarchies["copy-0"].root_population_id);
  });

  it("selects figure files by metadata chips over the figure's own selection", async () => {
    const props = fixture();
    props.samples.forEach((sample, i) => { sample.metadata = { batch: i < 8 ? "B1" : "B2" }; });
    act(() => root.render(<FigureWorkspace {...props} />));
    await flush();
    const chip = (value: string) => [...host.querySelectorAll<HTMLButtonElement>(".gl-figure-facets .gl-sample-facet-chip")].find((b) => b.textContent?.startsWith(value))!;
    expect(chip("B1").textContent).toBe("B18/8");
    expect(chip("B1").getAttribute("aria-pressed")).toBe("true");
    act(() => chip("B1").click());
    await flush();
    expect(props.configRef.current!.figure!.sampleIds).toHaveLength(9);
    expect(chip("B1").textContent).toBe("B10/8");
    act(() => chip("B1").click());
    await flush();
    expect(props.configRef.current!.figure!.sampleIds).toHaveLength(17);
  });

  it("cancels scheduled preparation when the tab is closed", async () => {
    act(() => root.render(<FigureWorkspace {...fixture()} />));
    act(() => root.render(<div>Another tab</div>));
    await flush();
    expect(draws.calls).toHaveLength(0);
    expect(host.textContent).toBe("Another tab");
  });
});
