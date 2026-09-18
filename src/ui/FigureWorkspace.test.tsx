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
      // The field keeps what is typed until Enter or leaving it, so a value below the minimum
      // can be typed; leaving it commits.
      size.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
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
  it("moves a gate label without building every panel again", async () => {
    const props = fixture();
    act(() => root.render(<FigureWorkspace {...props} />));
    await flush();
    const before = draws.calls.length;
    const move = (draws.calls.at(-1)!.gate_style as { on_label_move: (gateId: string, offset: [number, number]) => void }).on_label_move;
    act(() => move("no-such-gate", [5, 6]));
    await flush();
    // The offset is kept on the figure; the panel, which has no such gate, is not drawn again,
    // which a rebuild of every panel would have done.
    expect(props.configRef.current!.figure!.labelOffsets).toEqual({ "no-such-gate": [5, 6] });
    expect(draws.calls.length).toBe(before);
    expect(host.querySelector(".gl-figure-paper")?.getAttribute("style")).not.toContain("0.55");
  });

  it("zooms the figure with Option-scroll and shows the zoom it landed on", async () => {
    const props = fixture();
    act(() => root.render(<FigureWorkspace {...props} />));
    await flush();
    const viewport = host.querySelector<HTMLElement>(".gl-figure-viewport")!;
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Preview zoom"]')!;
    expect(select.value).toBe("fit");
    const plain = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
    act(() => { viewport.dispatchEvent(plain); });
    expect(plain.defaultPrevented).toBe(false);
    expect(select.value).toBe("fit");
    // Fit is 1 here (the viewport has no width in this test); a scroll up zooms in from there.
    const zoom = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -200, altKey: true });
    act(() => { viewport.dispatchEvent(zoom); });
    expect(zoom.defaultPrevented).toBe(true);
    expect(select.value).toBe("1.65");
    expect([...select.options].map((o) => o.textContent)).toContain("165%");
    expect(host.querySelector<HTMLElement>(".gl-figure-paper")?.style.zoom).toBe("1.65");
  });

  it("places a moved label in the store for the gate's tree, and moves a figure's own placements there once", async () => {
    const props = fixture();
    // A gate on the tree, and D17's copy of it, the copy the figure's panel draws.
    const copy = props.state.stored_hierarchies["copy-16"];
    props.state.gates["g-main"] = { gate_id: "g-main", name: "Cells", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A", vertices: [[0, 0], [1, 1]], color: "#000", label_offset: null };
    copy.gates["g-copy"] = { ...props.state.gates["g-main"], gate_id: "g-copy" };
    copy.source_gate_ids = { "g-copy": "g-main" };
    const moves: unknown[][] = [];
    const onGateLabelMove = (...args: unknown[]) => moves.push(args);
    // A figure saved with a placement of its own, under the id the copy descends from.
    props.configRef.current!.figure = undefined;
    act(() => root.render(<FigureWorkspace {...props} />));
    await flush();
    const move = (draws.calls.at(-1)!.gate_style as { on_label_move: (gateId: string, offset: [number, number]) => void }).on_label_move;
    act(() => move("g-copy", [1, 2]));
    await flush();
    expect(props.configRef.current!.figure!.labelOffsets).toEqual({ "g-main": [1, 2] });
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<FigureWorkspace {...props} onGateLabelMove={onGateLabelMove} />));
    await flush();
    // On load the figure's placement went to the store, named for the tree that holds the original.
    expect(moves).toEqual([["main", "g-main", [1, 2], undefined]]);
    expect(props.configRef.current!.figure!.labelOffsets).toBeUndefined();
    const moveAgain = (draws.calls.at(-1)!.gate_style as { on_label_move: (gateId: string, offset: [number, number]) => void }).on_label_move;
    act(() => moveAgain("g-copy", [5, 6]));
    await flush();
    expect(moves.at(-1)).toEqual(["copy-16", "g-copy", [5, 6], undefined]);
    expect(props.configRef.current!.figure!.labelOffsets).toBeUndefined();
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
  it("selects panels by clicking and puts them on the Layout tab in their arrangement", async () => {
    const props = fixture();
    const onAddToLayout = vi.fn();
    act(() => root.render(<FigureWorkspace {...props} onAddToLayout={onAddToLayout} />));
    await flush();
    const panels = [...host.querySelectorAll<HTMLElement>("td[data-figure-panel]")];
    expect(panels.length).toBeGreaterThan(2);
    const click = (el: HTMLElement, init: MouseEventInit = {}) => act(() => {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10, ...init }));
    });
    click(panels[0]);
    expect(panels[0].classList.contains("is-selected")).toBe(true);
    click(panels[2], { metaKey: true });
    expect(host.textContent).toContain("2 panels selected");
    // Shift takes the block between the anchor and the clicked panel.
    click(panels[1], { shiftKey: true });
    expect(host.textContent).toContain("2 panels selected");
    act(() => button("Add selected panels to the Layout tab").click());
    expect(onAddToLayout).toHaveBeenCalledTimes(1);
    const [recipes, cells, headings] = onAddToLayout.mock.calls[0];
    expect(recipes).toHaveLength(2);
    // Two rows of one column: the row headings go along, as text that reads each row's plot.
    expect(headings.columns).toEqual([]);
    expect(headings.rows).toHaveLength(2);
    expect(headings.rows.every((heading: { text: string; template?: string }) => heading.text.length > 0 && heading.template)).toBe(true);
    // The fixture's panels are one column, so the two chosen sit one below the other, closed up to
    // the block they span.
    expect(cells).toEqual([{ row: 0, column: 0 }, { row: 1, column: 0 }]);
    // Escape clears; a moved press is not a click.
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(host.querySelectorAll("td.is-selected")).toHaveLength(0);
    act(() => {
      panels[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
      panels[0].dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 40, clientY: 10 }));
    });
    expect(host.querySelectorAll("td.is-selected")).toHaveLength(0);
  });

  it("selects the panels a drag crosses, adds with Cmd, and clears on a click on blank paper", async () => {
    const props = fixture();
    act(() => root.render(<FigureWorkspace {...props} onAddToLayout={vi.fn()} />));
    await flush();
    const panels = [...host.querySelectorAll<HTMLElement>("td[data-figure-panel]")];
    expect(panels.length).toBeGreaterThan(2);
    // The fixture's panels are one column: give each a place on screen, 100 px apart.
    panels.forEach((cell, i) => vi.spyOn(cell, "getBoundingClientRect").mockReturnValue({ x: 20, y: 100 * i + 20, left: 20, top: 100 * i + 20, right: 120, bottom: 100 * i + 110, width: 100, height: 90, toJSON: () => ({}) }));
    const paper = host.querySelector<HTMLElement>(".gl-figure-paper")!;
    const drag = (from: [number, number], to: [number, number], init: MouseEventInit = {}) => {
      act(() => { paper.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: from[0], clientY: from[1], ...init })); });
      act(() => { window.dispatchEvent(new MouseEvent("mousemove", { clientX: to[0], clientY: to[1] })); });
      expect(host.querySelector(".gl-figure-marquee")).not.toBeNull();
      act(() => { window.dispatchEvent(new MouseEvent("mouseup")); });
      expect(host.querySelector(".gl-figure-marquee")).toBeNull();
    };
    // A band over the first two panels selects them.
    drag([5, 5], [60, 150]);
    expect(host.textContent).toContain("2 panels selected");
    expect(panels[0].classList.contains("is-selected")).toBe(true);
    expect(panels[1].classList.contains("is-selected")).toBe(true);
    expect(panels[2].classList.contains("is-selected")).toBe(false);
    // Cmd keeps what was selected and adds the third; without it the band replaces.
    drag([5, 215], [60, 230], { metaKey: true });
    expect(host.textContent).toContain("3 panels selected");
    drag([5, 215], [60, 230]);
    expect(host.textContent).toContain("1 panel selected");
    // A press on blank paper that does not move clears; one that starts on a control is ignored.
    act(() => { paper.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 5, clientY: 5 })); });
    act(() => { window.dispatchEvent(new MouseEvent("mouseup")); });
    expect(host.querySelectorAll("td.is-selected")).toHaveLength(0);
  });

  it("puts one panel on the Layout tab from a right-click, and opens it in Gating", async () => {
    const props = fixture();
    const onAddToLayout = vi.fn();
    const onOpenInGating = vi.fn();
    act(() => root.render(<FigureWorkspace {...props} onAddToLayout={onAddToLayout} onOpenInGating={onOpenInGating} />));
    await flush();
    const panel = host.querySelector<HTMLElement>("td[data-figure-panel]")!;
    expect(panel).not.toBeNull();
    act(() => { panel.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 90 })); });
    const menuItem = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === label)!;
    act(() => menuItem("Add this panel to the Layout tab").click());
    expect(onAddToLayout).toHaveBeenCalledTimes(1);
    expect(onAddToLayout.mock.calls[0][0]).toHaveLength(1);
    expect(onAddToLayout.mock.calls[0][1]).toEqual([{ row: 0, column: 0 }]);
    expect(onAddToLayout.mock.calls[0][0][0]).toMatchObject({ kind: "biplot", sampleId: expect.any(String), populationId: expect.any(String) });
    act(() => { panel.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 90 })); });
    act(() => menuItem("Open in Gating").click());
    expect(onOpenInGating).toHaveBeenCalledTimes(1);
  });

  it("selects every listed population, none, the leaves or the Gating tab's ticked ones, and finds one by name", async () => {
    const props = fixture();
    props.state.selected_pop_ids = [props.state.root_population_id!];
    act(() => root.render(<FigureWorkspace {...props} />));
    await flush();
    // The second row of actions: the first is the files'.
    const actions = host.querySelectorAll(".gl-figure-list-actions")[1];
    const click = (text: string) => act(() => [...actions.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!.click());
    const populations = () => props.configRef.current!.figure!.populations;
    const listed = host.querySelectorAll('input[aria-label="Find figure populations"] ~ .gl-figure-list .gl-figure-row').length;
    expect(listed).toBeGreaterThan(0);
    click("All");
    expect(populations()).toHaveLength(listed);
    click("None");
    expect(populations()).toHaveLength(0);
    click("Leaves");
    expect(populations().length).toBeGreaterThan(0);
    click("Use checked populations");
    expect(populations()).toHaveLength(1);
    expect(populations()[0].populationId).toBe(props.state.root_population_id);
    const find = host.querySelector<HTMLInputElement>('input[aria-label="Find figure populations"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(find, "no such population");
      find.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelectorAll('input[aria-label="Find figure populations"] ~ .gl-figure-list .gl-figure-row')).toHaveLength(0);
  });

  it("picks a plot's channel through the searchable picker, typing part of a name and pressing Enter", async () => {
    const props = fixture();
    act(() => root.render(<FigureWorkspace {...props} />));
    await flush();
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "Plots")!.click());
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="X channel"]')!;
    expect(trigger).not.toBeNull();
    expect(trigger.textContent).toBe("FSC-A");
    act(() => trigger.click());
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search X channel"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "ssc");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => { search.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })); });
    expect(props.configRef.current!.figure!.plots[0].x).toBe("SSC-A");
    expect(host.querySelector('input[aria-label="Search X channel"]')).toBeNull();
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
    act(() => button("Add as separate plots to the Layout tab").click());
    expect(onAddToLayout).toHaveBeenCalledTimes(1);
    const recipes = onAddToLayout.mock.calls[0][0];
    expect(recipes).toHaveLength(17);
    expect(recipes[0]).toMatchObject({ kind: "biplot", sampleId: "D1", xChannel: "FSC-A", yChannel: "SSC-A" });
    expect(["pseudocolor", "scatter", "contour"]).toContain(recipes[0].displayMode);
    // Titled by the sheet's template on the Layout tab, not here; a named plot would carry its name as label.
    expect(recipes[0].title).toBeUndefined();
    expect(recipes[0].label).toBeUndefined();
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
