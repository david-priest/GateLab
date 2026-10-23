// @vitest-environment jsdom

// Hovering a dot on the gating plot shows that cell in the docked inspector; clicking pins it.
// Nothing of this exists in a workspace without images.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import type { ScatterPayload } from "./engine/sample";
import { buildSyntheticCvw } from "./imaging/cvwFixture";
import { memoryFile } from "./testDirectory";

const plotCapture = vi.hoisted(() => ({ payload: null as ScatterPayload | null }));
vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: ({ payload }: { payload: ScatterPayload | null }) => {
    plotCapture.payload = payload;
    return <div id="cytof-plot-container"><div className="cytof-overlay" /></div>;
  },
}));

const syntheticFcs: FcsFile = {
  version: "FCS3.1",
  nEvents: 3,
  instrument: "flow",
  keywords: {},
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    { index: 2, name: "Size (FSC)", marker: null, bits: 32, range: 10000, feature: "MaskSize" },
    { index: 3, name: "WaveformPresent", marker: null, bits: 32, range: 2 },
    { index: 4, name: "Eccentricity (FSC)", marker: null, bits: 32, range: 10, feature: "Eccentricity" },
    { index: 5, name: "Radial Moment (FSC)", marker: null, bits: 32, range: 100, feature: "RadialMoment" },
  ],
  // Event 1 was not imaged: hover never lands on it.
  columns: [
    Float32Array.from([100, 200, 300]), Float32Array.from([150, 250, 350]), Float32Array.from([1800, 2200, 2600]), Uint32Array.from([1, 0, 1]),
    Float32Array.from([1.1, 1.9, 1.3]), Float32Array.from([12, 30, 15]),
  ],
  spillover: null,
};

vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => syntheticFcs };
});

vi.mock("./engine/fsAccess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fsAccess")>();
  return { ...actual, rememberHandle: vi.fn(async () => undefined), recallHandle: vi.fn(async () => null) };
});

const fake = vi.hoisted(() => ({
  constructed: 0,
  renders: [] as { fileKey: string; eventIndex: number; lane: string }[],
  attached: [] as string[],
  classified: [] as string[],
  classification: null as null | { objectCount: Uint8Array; objectArea: Uint32Array; features?: Record<string, Float32Array> },
}));
vi.mock("./imaging/imageService", () => {
  class RenderCancelled extends Error {}
  class ImageService {
    constructor() { fake.constructed++; }
    attach(fileKey: string) { fake.attached.push(fileKey); }
    detach() { /* nothing */ }
    hasSource() { return true; }
    knownInfo() { return null; }
    info() {
      return Promise.resolve({
        eventCount: 3, imageCount: 3, hasImage: Uint8Array.from([1, 1, 1]),
        scale: { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 },
        channelNames: { 2: "LightLoss (Imaging)", 3: "FSC", 4: "SSC (Imaging)", 5: "A", 6: "B", 7: "C" },
        pixelAspectRatio: 0.3, recordingId: "r",
      });
    }
    cached() { return null; }
    render(fileKey: string, eventIndex: number, _spec: unknown, lane: string) {
      fake.renders.push({ fileKey, eventIndex, lane });
      return { promise: Promise.resolve({ kind: "no-image" as const }), cancel: () => undefined };
    }
    suspend() { /* nothing */ }
    resume() { /* nothing */ }
    dispose() { /* nothing */ }
    classify(fileKey: string, onProgress?: (done: number, total: number) => void) {
      fake.classified.push(fileKey);
      onProgress?.(3, 3);
      // Event 1 was not imaged; the others hold one and two objects.
      const result = {
        objectCount: Uint8Array.from([1, 255, 2]), objectArea: Uint32Array.from([120, 0, 300]),
        features: { perimeter: Float32Array.from([40, 0, 70]), circularity: Float32Array.from([0.9, 0, 0.5]) },
      };
      fake.classification = result;
      return { promise: Promise.resolve(result), cancel: () => undefined };
    }
    classification() { return fake.classification; }
  }
  return { ImageService, RenderCancelled, sharedImageService: () => new ImageService(), resetSharedImageService: () => undefined };
});

import App from "./App";
import { clearPersistedTabState } from "./ui/tabState";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;

const rectOf = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearPersistedTabState();
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  fake.constructed = 0;
  fake.renders.length = 0;
  fake.attached.length = 0;
  fake.classified.length = 0;
  fake.classification = null;
  plotCapture.payload = null;
  // The data area and the plot area share one box here, so pixel (100 + fx·400, 50 + fy·400)
  // is the display point (fx, fy) of the ranges.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("cytof-overlay") || this.classList.contains("gl-plot-area")) return rectOf(100, 50, 400, 400);
    return rectOf(0, 0, 0, 0);
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  uuid = 0;
  for (const key of ["showOpenFilePicker", "showSaveFilePicker"]) delete (window as unknown as Record<string, unknown>)[key];
});

const cvwBytes = buildSyntheticCvw([{ samples: 256 }, { samples: 256 }, { samples: 256 }]);

function handleOf(name: string, bytes: Uint8Array): FileSystemFileHandle {
  return {
    kind: "file", name,
    getFile: vi.fn(async () => memoryFile(name, bytes)),
    queryPermission: vi.fn(async () => "granted"),
    requestPermission: vi.fn(async () => "granted"),
  } as unknown as FileSystemFileHandle;
}

async function settle(ms = 30): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function openFiles(withImages: boolean): Promise<void> {
  const handles = [handleOf("D1.fcs", Uint8Array.from([70, 67, 83]))];
  if (withImages) handles.push(handleOf("D1.cvw", cvwBytes));
  Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn().mockResolvedValue(handles) });
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn() });
  act(() => root.render(<App />));
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add files…")!;
  await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  for (let i = 0; i < 4; i++) await settle();
}

/** The pixel, in client coordinates, where the plotted point of event `eventIndex` sits. */
function pixelOfEvent(eventIndex: number): [number, number] {
  const payload = plotCapture.payload!;
  const plotted = payload.plotted!;
  const k = plotted.indices ? Array.from(plotted.indices).indexOf(eventIndex) : eventIndex;
  const fx = (plotted.xd[k] - payload.x_range[0]) / (payload.x_range[1] - payload.x_range[0]);
  const fy = (payload.y_range[1] - plotted.yd[k]) / (payload.y_range[1] - payload.y_range[0]);
  return [100 + fx * 400, 50 + fy * 400];
}

function pointer(type: string, clientX: number, clientY: number, buttons = 0): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, buttons, button: 0 });
}

const plotArea = () => host.querySelector<HTMLElement>(".gl-plot-area")!;

describe("hovering a cell", () => {
  it("shows nothing imaging-related for a file without images", async () => {
    await openFiles(false);
    expect(fake.constructed).toBe(0);
    expect(host.querySelector(".gl-cell-inspector")).toBeNull();
    expect(plotCapture.payload?.plotted).toBeTruthy();
  });

  it("asks for the hovered event's image and shows which event it is; a drag does not", async () => {
    await openFiles(true);
    expect(fake.constructed).toBe(1);
    expect(fake.attached).toHaveLength(1);
    // The inspector is a lazy chunk; under a full parallel run it can land a few ticks later.
    for (let i = 0; i < 20 && !host.querySelector(".gl-cell-inspector"); i++) await settle(25);
    expect(host.querySelector(".gl-cell-inspector")).toBeTruthy();
    expect(host.textContent).toContain("Nearest imaged cell");
    const [px, py] = pixelOfEvent(2);
    await act(async () => { plotArea().dispatchEvent(pointer("pointermove", px, py)); });
    for (let i = 0; i < 3; i++) await settle(40);
    expect(host.textContent).toContain("Event 2 of D1.fcs");
    expect(fake.renders.some((r) => r.eventIndex === 2 && r.lane === "interactive")).toBe(true);
    expect(host.textContent).toContain("No image for this event");
    expect(host.querySelector(".gl-cell-marker-hover")).toBeTruthy();
    // Chorus's feature for the event, read from the FCS.
    expect(host.textContent).toContain("Size (FSC)");
    expect(host.textContent).toContain("2,600");

    const before = fake.renders.length;
    const [qx, qy] = pixelOfEvent(0);
    await act(async () => { plotArea().dispatchEvent(pointer("pointermove", qx, qy, 1)); });
    for (let i = 0; i < 3; i++) await settle(40);
    expect(host.textContent).toContain("Event 2 of D1.fcs");
    expect(fake.renders.length).toBe(before);

    // An event without an image is never offered: hovering it names nothing.
    const [nx, ny] = pixelOfEvent(1);
    await act(async () => { plotArea().dispatchEvent(pointer("pointermove", nx, ny)); });
    for (let i = 0; i < 3; i++) await settle(40);
    expect(host.textContent).not.toContain("Event 1 of D1.fcs");
    expect(host.textContent).not.toContain("Event 2 of D1.fcs");

    // Far from any dot: nothing hovered.
    await act(async () => { plotArea().dispatchEvent(pointer("pointermove", 101, 51)); });
    for (let i = 0; i < 3; i++) await settle(40);
    expect(host.querySelector(".gl-cell-marker-hover")).toBeNull();
  });

  it("colours the plot by whether an event has an image", async () => {
    await openFiles(true);
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Colour by"]')!.click(); });
    const list = host.querySelector<HTMLSelectElement>(".gl-searchable-select-panel select")!;
    expect([...list.options].map((o) => o.textContent)).toContain("Has an image");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(list, "image");
      list.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    await settle();
    const payload = plotCapture.payload as (ScatterPayload & { overlay_mode?: boolean; color_b64?: string }) | null;
    expect(payload?.overlay_mode).toBe(true);
    const colours = Uint8Array.from(atob(payload!.color_b64!), (c) => c.charCodeAt(0));
    expect(Array.from(colours)).toEqual([0, 1, 0]);
    // The legend below the plot names the two classes (the payload carries no labels on purpose).
    expect(host.textContent).toContain("has an image");
    expect(host.textContent).toContain("no image");
  });

  it("colours the plot by the objects counted in each image, and names the count in the inspector", async () => {
    await openFiles(true);
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Colour by"]')!.click(); });
    const list = host.querySelector<HTMLSelectElement>(".gl-searchable-select-panel select")!;
    expect([...list.options].map((o) => o.textContent)).toContain("Objects in image");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(list, "objects");
      list.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    for (let i = 0; i < 3; i++) await settle(40);
    expect(fake.classified).toHaveLength(1);
    const payload = plotCapture.payload as (ScatterPayload & { overlay_mode?: boolean; color_b64?: string; color_palette?: string[] }) | null;
    expect(payload?.overlay_mode).toBe(true);
    const colours = Uint8Array.from(atob(payload!.color_b64!), (c) => c.charCodeAt(0));
    expect(Array.from(colours)).toEqual([1, 4, 2]);
    expect(payload!.color_palette).toHaveLength(5);
    expect(host.textContent).toContain("one object");
    expect(host.textContent).toContain("two objects");
    expect(host.textContent).not.toContain("Counting objects");
    // The count, the mask area and the class are now channels of the file, offered wherever channels are.
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Size by"]')!.click(); });
    const sizeOptions = [...host.querySelector<HTMLSelectElement>(".gl-searchable-select-panel select")!.options].map((o) => o.textContent);
    expect(sizeOptions).toEqual(expect.arrayContaining(["Objects in image", "Object area (GateLab mask)", "Single cell class", "Perimeter (GateLab mask)", "Circularity (GateLab mask)"]));
    expect(sizeOptions).not.toContain("Diameter (GateLab mask)");
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Size by"]')!.click(); });
    // The inspector names the count of the cell under the cursor.
    const [px, py] = pixelOfEvent(2);
    await act(async () => { plotArea().dispatchEvent(pointer("pointermove", px, py)); });
    for (let i = 0; i < 3; i++) await settle(40);
    expect(host.textContent).toContain("Event 2 of D1.fcs");
    expect(host.querySelector(".gl-cell-objects")?.textContent).toBe("2 objects");
  });

  it("colours the plot by single cells, filters the thumbnails by class, and names the class in the panel", async () => {
    await openFiles(true);
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Colour by"]')!.click(); });
    const list = host.querySelector<HTMLSelectElement>(".gl-searchable-select-panel select")!;
    expect([...list.options].map((o) => o.textContent)).toContain("Single cells");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(list, "cellclass");
      list.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    for (let i = 0; i < 3; i++) await settle(40);
    const payload = plotCapture.payload as (ScatterPayload & { overlay_mode?: boolean; color_b64?: string; color_palette?: string[] }) | null;
    expect(payload?.overlay_mode).toBe(true);
    // Event 0 holds one object and no feature flags it; event 1 was not imaged; event 2 holds two.
    expect(Array.from(Uint8Array.from(atob(payload!.color_b64!), (c) => c.charCodeAt(0)))).toEqual([0, 4, 2]);
    expect(payload!.color_palette).toHaveLength(5);
    expect(host.textContent).toContain("single (1)");
    expect(host.textContent).toContain("multiple objects (1)");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Strictness"]')?.value).toBe("3");
    // Thumbnails of one class only.
    const toggle = host.querySelector<HTMLInputElement>(".gl-thumbs-field input[type=checkbox]")!;
    await act(async () => { toggle.click(); });
    for (let i = 0; i < 3; i++) await settle(40);
    expect(fake.renders.filter((r) => r.lane === "batch").map((r) => r.eventIndex).sort()).toEqual([0, 2]);
    const classes = host.querySelector<HTMLSelectElement>('select[aria-label="Thumbnails of"]')!;
    expect([...classes.options].map((o) => o.textContent)).toEqual(["all cells", "single", "single, irregular", "multiple objects", "no object"]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(classes, "2");
      classes.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { toggle.click(); });
    await settle();
    fake.renders.length = 0;
    await act(async () => { toggle.click(); });
    for (let i = 0; i < 3; i++) await settle(40);
    expect(fake.renders.filter((r) => r.lane === "batch").map((r) => r.eventIndex)).toEqual([2]);
    // The panel names the class of the cell under the cursor.
    const [px, py] = pixelOfEvent(0);
    await act(async () => { plotArea().dispatchEvent(pointer("pointermove", px, py)); });
    for (let i = 0; i < 3; i++) await settle(40);
    expect(host.querySelector(".gl-cell-class")?.textContent).toBe("single");
    // The ring carries a dot in the cell's class colour, so the event sits in front of its neighbours.
    const dot = host.querySelector<HTMLElement>(".gl-cell-marker-hover .gl-cell-marker-dot");
    expect((plotCapture.payload as { color_palette?: string[] }).color_palette![0]).toBe("#1f77b4");
    expect(dot?.style.background).toBe("rgb(31, 119, 180)");
  });

  it("sizes the points by a channel, for every event or for one class, and offers the separating plot", async () => {
    await openFiles(true);
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Colour by"]')!.click(); });
    const list = host.querySelector<HTMLSelectElement>(".gl-searchable-select-panel select")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(list, "cellclass");
      list.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    for (let i = 0; i < 3; i++) await settle(40);
    // Size by the image size feature: 1800, 2200, 2600 span the 1st to 99th percentile.
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Size by"]')!.click(); });
    const sizeList = host.querySelector<HTMLSelectElement>(".gl-searchable-select-panel select")!;
    const sizeKey = [...sizeList.options].find((o) => o.textContent?.startsWith("Size (FSC)"))!.value;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sizeList, sizeKey);
      sizeList.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    await settle();
    const sizes = () => Array.from(Uint8Array.from(atob((plotCapture.payload as { size_b64?: string }).size_b64 ?? ""), (c) => c.charCodeAt(0)));
    expect(sizes()).toEqual([6, 23, 40]);
    // For single cells only: event 0 alone, at the middle size.
    const forClass = host.querySelector<HTMLSelectElement>('select[aria-label="Size the points of"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(forClass, "0");
      forClass.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(sizes()).toEqual([23, 0, 0]);
    // The separating plot: with one event in a class there is nothing to rank, and it says so.
    const summary = host.querySelector<HTMLElement>(".gl-separating > summary")!;
    expect(summary.textContent).toBe("Imaging plots");
    expect(host.querySelector(".gl-separating-heading")?.textContent).toBe("Suggested plots");
    // The presets the file's features allow: BD's doublet plot and size against shape, both on the FSC image here.
    const presets = [...host.querySelectorAll<HTMLButtonElement>(".gl-separating-presets button")].map((b) => b.textContent);
    expect(presets).toEqual(["Doublets", "Size and shape"]);
    expect(host.textContent).toContain("X · FSC-A");
    await act(async () => { host.querySelector<HTMLButtonElement>(".gl-separating-presets button")!.click(); });
    await settle();
    expect(host.textContent).toContain("X · Radial Moment (FSC)");
    expect(host.textContent).toContain("Y · Eccentricity (FSC)");
    // Back restores the axes the plot had before the preset; it is a view step, not an undo.
    const back = host.querySelector<HTMLButtonElement>("button.gl-view-back")!;
    expect(back.disabled).toBe(false);
    await act(async () => { back.click(); });
    await settle();
    expect(host.textContent).toContain("X · FSC-A");
    expect(host.textContent).toContain("Y · SSC-A");
    // Forward returns to the preset's axes; a Back after that is possible again.
    const forward = host.querySelector<HTMLButtonElement>("button.gl-view-forward")!;
    expect(forward.disabled).toBe(false);
    await act(async () => { forward.click(); });
    await settle();
    expect(host.textContent).toContain("X · Radial Moment (FSC)");
    expect(forward.disabled).toBe(true);
    expect(back.disabled).toBe(false);
    expect(host.textContent).toContain("Separating plot");
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Separate"]')!.value).toBe("0");
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="from"]')!.value).toBe("2");
    const rank = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Rank channel pairs")!;
    await act(async () => { rank.click(); await new Promise((r) => setTimeout(r, 30)); });
    await settle();
    expect(host.textContent).toContain("Too few events in a class to rank");
  });

  it("pins the clicked cell and unpins on Escape", async () => {
    await openFiles(true);
    const [px, py] = pixelOfEvent(2);
    await act(async () => {
      plotArea().dispatchEvent(pointer("pointerdown", px, py, 1));
      plotArea().dispatchEvent(pointer("pointerup", px, py, 0));
    });
    for (let i = 0; i < 3; i++) await settle(40);
    expect(host.textContent).toContain("Pinned");
    expect(host.textContent).toContain("Event 2 of D1.fcs");
    expect(host.querySelector(".gl-cell-marker-pinned")).toBeTruthy();
    // Hovering elsewhere does not move a pinned cell.
    await act(async () => { plotArea().dispatchEvent(pointer("pointermove", 101, 51)); });
    for (let i = 0; i < 3; i++) await settle(40);
    expect(host.textContent).toContain("Event 2 of D1.fcs");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    await settle();
    expect(host.textContent).toContain("Nearest imaged cell");
    expect(host.querySelector(".gl-cell-marker-pinned")).toBeNull();
  });

  it("adds the cell shown in the inspector to a cell panel on the Layout tab, and the next one to the same panel", async () => {
    await openFiles(true);
    const pin = async (event: number) => {
      const [px, py] = pixelOfEvent(event);
      await act(async () => {
        plotArea().dispatchEvent(pointer("pointerdown", px, py, 1));
        plotArea().dispatchEvent(pointer("pointerup", px, py, 0));
      });
      for (let i = 0; i < 3; i++) await settle(40);
    };
    await pin(2);
    const add = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add to a cell panel");
    expect(add()).toBeTruthy();
    await act(async () => { add()!.click(); });
    for (let i = 0; i < 60 && !host.querySelector(".gl-layout-cellpanel"); i++) await settle();
    const panel = () => host.querySelectorAll<HTMLElement>(".gl-layout-cellpanel");
    expect(panel()).toHaveLength(1);
    expect(panel()[0].getAttribute("data-cells")).toBe("1");
    // Back on Gating, another cell goes onto the same panel.
    const gating = [...host.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find((b) => b.textContent === "Gating")!;
    await act(async () => { gating.click(); });
    for (let i = 0; i < 3; i++) await settle(40);
    await pin(0);
    await act(async () => { add()!.click(); });
    for (let i = 0; i < 20 && panel()[0]?.getAttribute("data-cells") !== "2"; i++) await settle();
    expect(panel()).toHaveLength(1);
    expect(panel()[0].getAttribute("data-cells")).toBe("2");
  });

  it("lays thumbnails over the plot when asked, for imaged events only", async () => {
    await openFiles(true);
    const toggle = host.querySelector<HTMLInputElement>(".gl-thumbs-field input[type=checkbox]")!;
    expect(toggle.checked).toBe(false);
    expect(host.querySelector(".gl-plot-thumbs")).toBeNull();
    await act(async () => { toggle.click(); });
    for (let i = 0; i < 3; i++) await settle(40);
    expect(host.querySelector(".gl-plot-thumbs")).toBeTruthy();
    const batch = fake.renders.filter((r) => r.lane === "batch").map((r) => r.eventIndex).sort();
    expect(batch).toEqual([0, 2]);
    await act(async () => { toggle.click(); });
    await settle();
    expect(host.querySelector(".gl-plot-thumbs")).toBeNull();
  });

  it("folds the panel and moves it between the pane and its own column", async () => {
    await openFiles(true);
    expect(host.querySelector(".gl-side .gl-cell-inspector")).toBeTruthy();
    expect(host.querySelector(".gl-cell-column")).toBeNull();
    const dock = host.querySelector<HTMLButtonElement>(".gl-cell-dock")!;
    await act(async () => { dock.click(); });
    expect(host.querySelector(".gl-cell-column .gl-cell-inspector")).toBeTruthy();
    expect(host.querySelector(".gl-side .gl-cell-inspector")).toBeNull();
    const fold = host.querySelector<HTMLButtonElement>(".gl-cell-inspector .gl-side-disclosure")!;
    await act(async () => { fold.click(); });
    expect(host.querySelector(".gl-cell-inspector-collapsed")).toBeTruthy();
    expect(host.textContent).not.toContain("Hover a dot to see its cell");
    await act(async () => { host.querySelector<HTMLButtonElement>(".gl-cell-inspector .gl-side-disclosure")!.click(); });
    expect(host.querySelector(".gl-cell-inspector-collapsed")).toBeNull();
  });
});
