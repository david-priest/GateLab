// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "../engine/fcs";
import { Sample } from "../engine/sample";
import { clearPersistedTabState } from "../ui/tabState";
import { ImagesTab } from "./ImagesTab";
import type { ImageService, RenderResult, SourceInfo } from "./imageService";
import type { CellImageSource } from "./imageSource";
import { defaultChannelDisplay } from "./imageWallSettings";

const names = new Map<number, string>([[2, "LightLoss (Imaging)"], [3, "FSC"], [4, "SSC (Imaging)"], [5, "A"], [6, "B"], [7, "C"]]);

function fileOf(n: number): FcsFile {
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) { a[i] = (n - i) * 10; b[i] = i * 5; }
  return {
    version: "FCS3.1", nEvents: n, instrument: "flow", keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [a, b], spillover: null,
  };
}

const images: CellImageSource = {
  kind: "cvw", fileName: "D1.cvw", file: null, handle: null, eventCount: 6, recordingId: "r",
  channelNames: names, pixelAspectRatio: 0.3, display: defaultChannelDisplay(names), mask: null,
};

/** A service that knows which events have images and renders nothing (no-image), recording what it was asked. */
function fakeService(hasImage: number[]) {
  const renders: { eventIndex: number; lane: string; spec: unknown }[] = [];
  const suspended: string[] = [];
  const info: SourceInfo = {
    eventCount: hasImage.length, imageCount: hasImage.filter(Boolean).length, hasImage: Uint8Array.from(hasImage),
    scale: { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 }, channelNames: Object.fromEntries(names), pixelAspectRatio: 0.3, recordingId: "r",
  };
  const service = {
    attach() {}, detach() {}, hasSource: () => true,
    knownInfo: () => info, info: async () => info,
    cached: () => null,
    render(_fileKey: string, eventIndex: number, spec: unknown, lane: string) {
      renders.push({ eventIndex, lane, spec });
      return { promise: Promise.resolve({ kind: "no-image" } as RenderResult), cancel: () => undefined };
    },
    suspend(lane: string) { suspended.push(`suspend:${lane}`); },
    resume(lane: string) { suspended.push(`resume:${lane}`); },
    dispose() {},
  } as unknown as ImageService;
  return { service, renders, suspended };
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearPersistedTabState();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // A viewport the virtual grid can lay out in: every tile fits.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 400; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 400; } });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

const sample = new Sample(fileOf(6));
const entry = { id: "D1", name: "D1.fcs", images, sample };

function render(over: Partial<React.ComponentProps<typeof ImagesTab>> = {}) {
  const { service, renders, suspended } = fakeService([1, 0, 1, 1, 1, 1]);
  const props: React.ComponentProps<typeof ImagesTab> = {
    visible: true, stateKey: "w:D1", service, entry, mask: null, populationLabel: "All Events",
    view: undefined, onViewChange: vi.fn(), pinned: null, onPin: vi.fn(), onShowOnPlot: vi.fn(), ...over,
  };
  act(() => root.render(<ImagesTab {...props} />));
  return { props, renders, suspended };
}

const tileIndices = () => [...host.querySelectorAll<HTMLElement>(".gl-wall-tile-index")].map((e) => e.textContent);

describe("ImagesTab", () => {
  it("shows a tile for every event of the population that has an image, in event order", async () => {
    const { renders } = render({ mask: Uint8Array.from([1, 1, 1, 0, 1, 1]) });
    await settle();
    expect(host.textContent).toContain("5 cells in All Events · 4 with images");
    expect(tileIndices()).toEqual(["0", "2", "4", "5"]);
    expect(renders.map((r) => r.eventIndex).sort()).toEqual([0, 2, 4, 5]);
    expect(renders.every((r) => r.lane === "batch")).toBe(true);
  });

  it("sorts by a channel, both ways", async () => {
    render();
    await settle();
    const select = host.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      select.value = "FSC-A";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    // FSC-A falls with the event index, so ascending order is the reverse event order.
    expect(tileIndices()).toEqual(["5", "4", "3", "2", "0"]);
    const reverse = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.title === "Reverse the order")!;
    await act(async () => { reverse.click(); });
    await settle();
    expect(tileIndices()).toEqual(["0", "2", "3", "4", "5"]);
  });

  it("pins a clicked tile, marks the pinned one, and offers to show it on the plot", async () => {
    const onPin = vi.fn();
    const onShowOnPlot = vi.fn();
    render({ onPin, onShowOnPlot, pinned: { sampleId: "D1", eventIndex: 3 } });
    await settle();
    const tiles = [...host.querySelectorAll<HTMLButtonElement>(".gl-wall-tile")];
    expect(tiles.find((t) => t.classList.contains("gl-wall-tile-pinned"))?.textContent).toContain("3");
    await act(async () => { tiles[0].click(); });
    expect(onPin).toHaveBeenCalledWith({ sampleId: "D1", eventIndex: 0 });
    const show = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Show on plot")!;
    expect(show.disabled).toBe(false);
    await act(async () => { show.click(); });
    expect(onShowOnPlot).toHaveBeenCalled();
  });

  it("is dormant while hidden, and leaves the batch lane alone for the plot's thumbnails", async () => {
    const { suspended, renders } = render({ visible: false });
    await settle();
    expect(host.querySelector(".gl-images-tab")).toBeNull();
    expect(host.querySelectorAll(".gl-wall-tile")).toHaveLength(0);
    expect(renders).toHaveLength(0);
    expect(suspended).toEqual([]);
  });

  it("offers the tree's populations, shows the cells a gate leaves out, and sends the wall to Layout in its order", async () => {
    const onChoosePopulation = vi.fn();
    const onSendToLayout = vi.fn();
    const populations = [{ id: "root", name: "All Events", depth: 0 }, { id: "p1", name: "CD4_positive", depth: 1 }];
    // Population p1 holds events 0, 2 and 3 of its parent (everything); the gate leaves out 1, 4 and 5.
    const mask = Uint8Array.from([1, 0, 1, 1, 0, 0]);
    const excludedMask = Uint8Array.from([0, 1, 0, 0, 1, 1]);
    const { props } = render({ mask, populationId: "p1", populationLabel: "CD4_positive", populations, onChoosePopulation, excludedMask, parentName: "All Events", onSendToLayout });
    await settle();
    expect(tileIndices()).toEqual(["0", "2", "3"]);
    const picker = host.querySelector<HTMLSelectElement>('select[aria-label="Population"]')!;
    expect([...picker.options].map((o) => o.textContent)).toEqual(["All Events", "\u00a0\u00a0CD4_positive"]);
    expect(picker.value).toBe("p1");
    await act(async () => {
      picker.value = "root";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChoosePopulation).toHaveBeenCalledWith("root");
    // The cells the gate leaves out: imaged ones among 1, 4 and 5 (event 1 has no image).
    const leftOut = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Left out by its gate")!;
    await act(async () => { leftOut.click(); });
    await settle();
    expect(tileIndices()).toEqual(["4", "5"]);
    expect(host.textContent).toContain("3 cells in All Events without CD4_positive · 2 with images");
    // Back in the population, sorted by FSC-A descending, the first two go to Layout in that order.
    const inPop = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "In the population")!;
    await act(async () => { inPop.click(); });
    const sortBy = [...host.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Sort by"))!.querySelector("select")!;
    await act(async () => { sortBy.value = "FSC-A"; sortBy.dispatchEvent(new Event("change", { bubbles: true })); });
    const cells = host.querySelector<HTMLSelectElement>('select[aria-label="Cells to send"]')!;
    await act(async () => { cells.value = "12"; cells.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(tileIndices()).toEqual(["3", "2", "0"]);
    const send = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Send to Layout")!;
    await act(async () => { send.click(); });
    expect(onSendToLayout).toHaveBeenCalledTimes(1);
    const recipe = onSendToLayout.mock.calls[0][0];
    expect(recipe).toMatchObject({ kind: "imagewall", sampleId: "D1", fileName: "D1.fcs", populationId: "p1", populationName: "CD4_positive", events: [3, 2, 0], imaged: 3, populationCount: 3, sortKey: "FSC-A", sortLabel: "FSC-A", sortDesc: false, exposure: 1, columns: 6 });
    expect(recipe.display).toHaveLength(6);
    expect(recipe.tile).toBeGreaterThanOrEqual(24);
    expect(props.entry).toBe(entry);
  });

  it("borders, filters and sorts the wall by class, and sends the colours with the block", async () => {
    const onSendToLayout = vi.fn();
    // Events 0 and 4 are single, 2 and 3 multiple, 5 unknown; 1 has no image.
    const classIndex: Record<number, number | null> = { 0: 0, 2: 2, 3: 2, 4: 0, 5: null };
    const classes = [{ label: "single", colour: "#1f77b4" }, { label: "single, irregular", colour: "#ff7f0e" }, { label: "multiple objects", colour: "#2ca02c" }];
    render({ classOf: (e) => classIndex[e] ?? null, classes, classTitle: "Single cells", onSendToLayout });
    await settle();
    const tiles = () => [...host.querySelectorAll<HTMLElement>(".gl-wall-tile")].map((t) => [t.querySelector(".gl-wall-tile-index")!.textContent, t.querySelector<HTMLElement>(".gl-wall-tile-ring")?.style.boxShadow ?? ""]);
    expect(tiles().map(([i]) => i)).toEqual(["0", "2", "3", "4", "5"]);
    expect(tiles()[0][1]).toContain("#1f77b4");
    expect(tiles()[1][1]).toContain("#2ca02c");
    expect(tiles()[4][1]).toBe("");
    expect(host.querySelector(".gl-images-legend")?.textContent).toBe("singlesingle, irregularmultiple objects");
    // Sorted by class: the singles, then the multiples, then the unknown.
    const sortBy = [...host.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Sort by"))!.querySelector("select")!;
    await act(async () => { sortBy.value = "__class__"; sortBy.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(tiles().map(([i]) => i)).toEqual(["0", "4", "2", "3", "5"]);
    // One class only.
    const showClass = host.querySelector<HTMLSelectElement>('select[aria-label="Show class"]')!;
    await act(async () => { showClass.value = "2"; showClass.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(tiles().map(([i]) => i)).toEqual(["2", "3"]);
    const send = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Send to Layout")!;
    await act(async () => { send.click(); });
    const recipe = onSendToLayout.mock.calls[0][0];
    expect(recipe).toMatchObject({ events: [2, 3], sortKey: "__class__", sortLabel: "Single cells", tileColours: ["#2ca02c", "#2ca02c"] });
    expect(recipe.legend).toEqual(classes);
  });

  it("says so when the viewed file has no images", async () => {
    render({ entry: { ...entry, images: null } });
    await settle();
    expect(host.textContent).toContain("No cell images are attached to the viewed file");
  });

  it("asks for the mask outline when switched on, and sends it with the wall to Layout", async () => {
    const onViewChange = vi.fn();
    const onSendToLayout = vi.fn();
    const { renders } = render({ mask: null, onViewChange, onSendToLayout, view: { display: images.display.slice(), exposure: 1, outline: true }, entry: { ...entry, images: { ...images, mask: { slot: 4, fraction: 0.2 } } } });
    await settle();
    expect(renders.length).toBeGreaterThan(0);
    expect((renders[0].spec as { outline?: unknown }).outline).toEqual({ slot: 4, fraction: 0.2 });
    const box = host.querySelector<HTMLInputElement>(".gl-images-check input")!;
    expect(box.checked).toBe(true);
    act(() => { box.click(); });
    expect(onViewChange).toHaveBeenCalledWith("D1", expect.objectContaining({ outline: false }));
    const send = [...host.querySelectorAll("button")].find((b) => /Send to Layout/.test(b.textContent ?? ""))!;
    act(() => { send.click(); });
    expect(onSendToLayout.mock.calls[0][0]).toMatchObject({ outline: { slot: 4, fraction: 0.2 } });
  });

  it("limits the wall to a range dragged on the sort channel's histogram, and the Layout recipe says so", async () => {
    const onSendToLayout = vi.fn();
    render({ mask: null, onSendToLayout });
    await settle();
    // Sort by FSC-A: imaged events 0, 2, 3, 4, 5 carry 60, 40, 30, 20, 10.
    const sort = [...host.querySelectorAll<HTMLSelectElement>(".gl-images-toolbar select")].find((s) => [...s.options].some((o) => o.value === "FSC-A"))!;
    act(() => { sort.value = "FSC-A"; sort.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(tileIndices()).toEqual(["5", "4", "3", "2", "0"]);
    const canvas = host.querySelector<HTMLCanvasElement>(".gl-wall-histogram")!;
    expect(canvas).toBeTruthy();
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 220, height: 40, right: 220, bottom: 40, x: 0, y: 0, toJSON: () => ({}) });
    const pointer = (type: string, clientX: number) => act(() => { canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY: 10, button: 0 })); });
    // The span is 10..60; a drag over the left half keeps 10..35.
    pointer("pointerdown", 0);
    pointer("pointermove", 110);
    pointer("pointerup", 110);
    await settle();
    expect(tileIndices()).toEqual(["5", "4", "3"]);
    expect(host.querySelector(".gl-images-range")?.textContent).toContain("10–35");
    const send = [...host.querySelectorAll("button")].find((b) => /Send to Layout/.test(b.textContent ?? ""))!;
    act(() => { send.click(); });
    expect(onSendToLayout.mock.calls[0][0]).toMatchObject({ events: [5, 4, 3], rangeLabel: "FSC-A 10–35" });
    // A click on the histogram clears the limit; so does the × button.
    pointer("pointerdown", 50);
    pointer("pointerup", 51);
    await settle();
    expect(tileIndices()).toEqual(["5", "4", "3", "2", "0"]);
    expect(host.querySelector(".gl-images-range")).toBeNull();
  });


  it("finds similar cells by sorting the wall on the channel the app returns, and picks all shown", async () => {
    const onFindSimilar = vi.fn(() => "FSC-A");
    const onMakePopulation = vi.fn();
    render({ mask: null, onMakePopulation, onFindSimilar });
    await settle();
    const tiles = () => [...host.querySelectorAll<HTMLButtonElement>(".gl-wall-tile")];
    act(() => { tiles()[1].dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })); });
    const find = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Find similar")!;
    act(() => { find.click(); });
    await settle();
    expect(onFindSimilar).toHaveBeenCalledWith([2], "picks");
    expect(tileIndices()).toEqual(["5", "4", "3", "2", "0"]);
    const sort = [...host.querySelectorAll<HTMLSelectElement>(".gl-images-toolbar select")].find((s) => [...s.options].some((o) => o.value === "FSC-A"))!;
    expect(sort.value).toBe("FSC-A");
    const all = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Pick all shown")!;
    act(() => { all.click(); });
    await settle();
    expect(host.querySelector(".gl-images-picked")?.textContent).toContain("5 picked");
  });

  it("shows the histogram in event order too, of a chosen channel, and a drag on it limits the wall by that channel", async () => {
    const onSendToLayout = vi.fn();
    render({ mask: null, onSendToLayout });
    await settle();
    const canvas = host.querySelector<HTMLCanvasElement>(".gl-wall-histogram")!;
    expect(canvas).toBeTruthy();
    const choose = host.querySelector<HTMLSelectElement>('select[aria-label="Histogram of"]')!;
    expect(choose.value).toBe("FSC-A");
    expect(tileIndices()).toEqual(["0", "2", "3", "4", "5"]);
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 220, height: 40, right: 220, bottom: 40, x: 0, y: 0, toJSON: () => ({}) });
    const pointer = (type: string, clientX: number) => act(() => { canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY: 10, button: 0 })); });
    // FSC-A runs 10..60 over the imaged events; the left half keeps 10..35: events 3, 4, 5, still in event order.
    pointer("pointerdown", 0); pointer("pointermove", 110); pointer("pointerup", 110);
    await settle();
    expect(tileIndices()).toEqual(["3", "4", "5"]);
    const send = [...host.querySelectorAll("button")].find((b) => /Send to Layout/.test(b.textContent ?? ""))!;
    act(() => { send.click(); });
    expect(onSendToLayout.mock.calls[0][0]).toMatchObject({ events: [3, 4, 5], sortKey: "", rangeLabel: "FSC-A 10–35" });
    act(() => { choose.value = "SSC-A"; choose.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(tileIndices()).toEqual(["0", "2", "3", "4", "5"]);
    const sort = [...host.querySelectorAll<HTMLSelectElement>(".gl-images-toolbar select")].find((s) => s !== choose && [...s.options].some((o) => o.value === "FSC-A"))!;
    act(() => { sort.value = "FSC-A"; sort.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(host.querySelector('select[aria-label="Histogram of"]')).toBeNull();
    expect(host.querySelector(".gl-wall-histogram")).toBeTruthy();
  });


  it("picks as Photos does: click one, Cmd-click toggles, Shift-click extends, Escape clears, Cmd-A takes all shown", async () => {
    const onMakePopulation = vi.fn();
    const onPin = vi.fn();
    render({ mask: null, onMakePopulation, onPin });
    await settle();
    // Wall order is event order: 0, 2, 3, 4, 5.
    const tiles = () => [...host.querySelectorAll<HTMLButtonElement>(".gl-wall-tile")];
    const pickedIndices = () => tiles().filter((t) => t.classList.contains("gl-wall-tile-picked")).map((t) => t.getAttribute("data-event"));
    expect(host.querySelector(".gl-images-picked")?.textContent).toContain("0 picked");
    // A click picks that cell alone and shows it in the inspector.
    act(() => { tiles()[1].click(); });
    expect(pickedIndices()).toEqual(["2"]);
    expect(onPin).toHaveBeenCalledWith({ sampleId: "D1", eventIndex: 2 });
    act(() => { tiles()[3].click(); });
    expect(pickedIndices()).toEqual(["4"]);
    // Cmd-click adds one, and removes it again; Shift-click extends from the last click.
    act(() => { tiles()[0].dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })); });
    expect(pickedIndices()).toEqual(["0", "4"]);
    act(() => { tiles()[0].dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })); });
    expect(pickedIndices()).toEqual(["4"]);
    act(() => { tiles()[1].click(); });
    act(() => { tiles()[3].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })); });
    expect(pickedIndices()).toEqual(["2", "3", "4"]);
    // The corner box toggles one without changing the inspector; with Shift it extends.
    onPin.mockClear();
    const box = (k: number) => tiles()[k].querySelector<HTMLElement>(".gl-wall-tile-pick")!;
    act(() => { box(1).click(); });
    expect(pickedIndices()).toEqual(["3", "4"]);
    expect(onPin).not.toHaveBeenCalled();
    act(() => { box(1).click(); });
    expect(pickedIndices()).toEqual(["2", "3", "4"]);
    act(() => { box(4).dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })); });
    expect(pickedIndices()).toEqual(["2", "3", "4", "5"]);
    // Space toggles the focused tile; Escape clears; Cmd-A picks every cell on the wall.
    act(() => { tiles()[0].focus(); tiles()[0].dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })); });
    expect(pickedIndices()).toEqual(["0", "2", "3", "4", "5"]);
    act(() => { tiles()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(pickedIndices()).toEqual([]);
    act(() => { tiles()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true })); });
    expect(pickedIndices()).toEqual(["0", "2", "3", "4", "5"]);
    expect(host.querySelector(".gl-images-picked")?.textContent).toContain("5 picked");
    // Make population takes the picks, sorted, and clears them.
    const name = host.querySelector<HTMLInputElement>('input[aria-label="Population name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Bright");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const make = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Make population")!;
    act(() => { make.click(); });
    expect(onMakePopulation).toHaveBeenCalledWith([0, 2, 3, 4, 5], "Bright");
    expect(pickedIndices()).toEqual([]);
  });

  it("picks with a dragged rectangle: a drag replaces, Cmd-drag adds, Option-drag removes, and a press that does not move is a click", async () => {
    const onPin = vi.fn();
    render({ mask: null, onMakePopulation: vi.fn(), onPin });
    await settle();
    const tiles = () => [...host.querySelectorAll<HTMLButtonElement>(".gl-wall-tile")];
    const pickedIndices = () => tiles().filter((t) => t.classList.contains("gl-wall-tile-picked")).map((t) => t.getAttribute("data-event"));
    const grid = host.querySelector<HTMLDivElement>(".gl-images-scroll")!;
    grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
    const drag = (from: [number, number], to: [number, number], init: MouseEventInit = {}) => {
      act(() => { grid.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: from[0], clientY: from[1], button: 0, ...init })); });
      act(() => { grid.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: to[0], clientY: to[1], ...init })); });
      expect(host.querySelector(".gl-images-marquee")).toBeTruthy();
      act(() => { grid.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: to[0], clientY: to[1], button: 0, ...init })); });
      act(() => { grid.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: to[0], clientY: to[1] })); });
    };
    // Tiles are 72 px on a 76 px step from a 6 px padding: the first three of row 0 lie under x 6..222.
    act(() => { tiles()[4].click(); });
    expect(pickedIndices()).toEqual(["5"]);
    drag([10, 10], [170, 40]);
    expect(pickedIndices()).toEqual(["0", "2", "3"]);
    expect(host.querySelector(".gl-images-marquee")).toBeNull();
    drag([250, 10], [300, 40], { metaKey: true });
    expect(pickedIndices()).toEqual(["0", "2", "3", "4"]);
    drag([10, 10], [100, 40], { altKey: true });
    expect(pickedIndices()).toEqual(["3", "4"]);
    // The press that ends a drag is not a click; a press that does not move is.
    expect(onPin).toHaveBeenCalledTimes(1);
    act(() => { tiles()[1].dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 90, clientY: 30, button: 0 })); });
    act(() => { tiles()[1].dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 90, clientY: 30, button: 0 })); });
    act(() => { tiles()[1].click(); });
    expect(onPin).toHaveBeenLastCalledWith({ sampleId: "D1", eventIndex: 2 });
    expect(pickedIndices()).toEqual(["2"]);
  });

  it("unpicks the shown cells or all of them, and re-renders only the tiles a pick touches", async () => {
    render({ mask: null, onMakePopulation: vi.fn() });
    await settle();
    const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
    const tiles = () => [...host.querySelectorAll<HTMLButtonElement>(".gl-wall-tile")];
    act(() => { button("Pick all shown").click(); });
    await settle();
    expect(host.querySelector(".gl-images-picked")?.textContent).toContain("5 picked");
    act(() => { button("Unpick shown").click(); });
    await settle();
    expect(host.querySelector(".gl-images-picked")?.textContent).toContain("0 picked");
    act(() => { button("Pick all shown").click(); });
    await settle();
    act(() => { button("Unpick all").click(); });
    await settle();
    expect(host.querySelector(".gl-images-picked")?.textContent).toContain("0 picked");
    const nodesBefore = tiles();
    act(() => { nodesBefore[0].dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })); });
    await settle();
    const nodesAfter = tiles();
    expect(nodesAfter[2]).toBe(nodesBefore[2]);
    expect(nodesAfter[0].classList.contains("gl-wall-tile-picked")).toBe(true);
  });
});
