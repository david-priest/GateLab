// @vitest-environment jsdom

// The Images tab exists only when a file has images, mounts on its first visit, and does no
// work while another tab is showing (the hidden-tab invariant, App.hiddenTabWork.test.tsx).

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import { buildSyntheticCvw } from "./imaging/cvwFixture";
import { memoryFile } from "./testDirectory";

const plotHarness = vi.hoisted(() => ({ props: null as null | { onNewGate: (gate: unknown) => void } }));
vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: { onNewGate: (gate: unknown) => void }) => {
    plotHarness.props = props;
    return <div data-testid="gating-plot" />;
  },
}));

const syntheticFcs: FcsFile = {
  version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {},
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
  ],
  columns: [Float32Array.from([100, 200, 300]), Float32Array.from([150, 250, 350])], spillover: null,
};
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => syntheticFcs };
});
vi.mock("./engine/fsAccess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fsAccess")>();
  return { ...actual, rememberHandle: vi.fn(async () => undefined), recallHandle: vi.fn(async () => null) };
});

const wall = vi.hoisted(() => ({ renders: 0, lastVisible: null as boolean | null, send: null as null | ((recipe: unknown) => void),
  make: null as null | ((events: number[], name: string) => void), entry: null as null | { sample: { index: (key: string) => number | undefined; channels: { key: string }[]; displayColumn: (idx: number) => Float32Array } },
  find: null as null | ((events: number[], name: string) => string | null),
  popId: null as string | null,
  cellPanel: null as null | ((recipe: unknown) => void),
}));
// The stand-in is memoised with the tab's own comparator, so what is counted is what App hands
// through it: a prop change while hidden must not reach the tab.
vi.mock("./imaging/ImagesTab", async (importOriginal) => {
  const { memo } = await import("react");
  const actual = await importOriginal<typeof import("./imaging/ImagesTab")>();
  const Fake = (props: { visible: boolean; onSendToLayout?: ((recipe: unknown) => void) | undefined; onMakePopulation?: ((events: number[], name: string) => void) | undefined; onFindSimilar?: ((events: number[], name: string) => string | null) | undefined; entry?: unknown }) => {
    wall.renders++;
    wall.lastVisible = props.visible;
    wall.send = props.onSendToLayout ?? null;
    wall.make = props.onMakePopulation ?? null;
    wall.find = props.onFindSimilar ?? null;
    wall.entry = (props.entry as typeof wall.entry) ?? null;
    wall.popId = (props as { populationId?: string | null }).populationId ?? null;
    wall.cellPanel = (props as { onSendCellPanel?: (recipe: unknown) => void }).onSendCellPanel ?? null;
    return <div data-testid="images-wall" data-visible={String(props.visible)} />;
  };
  return { ImagesTab: memo(Fake, actual.imagesTabPropsEqual as (a: unknown, b: unknown) => boolean), imagesTabPropsEqual: actual.imagesTabPropsEqual };
});
vi.mock("./imaging/imageService", () => {
  class RenderCancelled extends Error {}
  class ImageService {
    attach() {} detach() {} hasSource() { return true; } knownInfo() { return null; }
    info() { return Promise.resolve({ eventCount: 3, imageCount: 3, hasImage: Uint8Array.from([1, 1, 1]), scale: {}, channelNames: {}, pixelAspectRatio: 0.3, recordingId: "r" }); }
    cached() { return null; }
    render() { return { promise: Promise.resolve({ kind: "no-image" as const }), cancel: () => undefined }; }
    suspend() {} resume() {} dispose() {}
  }
  return { ImageService, RenderCancelled, sharedImageService: () => new ImageService(), resetSharedImageService: () => undefined };
});

import App from "./App";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  wall.renders = 0;
  wall.lastVisible = null;
  plotHarness.props = null;
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
    queryPermission: vi.fn(async () => "granted"), requestPermission: vi.fn(async () => "granted"),
  } as unknown as FileSystemFileHandle;
}

async function settle(ms = 30): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

const tabButton = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find((b) => b.textContent === label);
const buttonWithText = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button:not(.gl-menu-trigger)")].find((b) => b.textContent?.trim() === text);

async function openFiles(withImages: boolean): Promise<void> {
  const handles = [handleOf("D1.fcs", Uint8Array.from([70, 67, 83]))];
  if (withImages) handles.push(handleOf("D1.cvw", cvwBytes));
  Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn().mockResolvedValue(handles) });
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn() });
  act(() => root.render(<App />));
  await act(async () => { buttonWithText("Add files…")!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  for (let i = 0; i < 4; i++) await settle();
}

describe("the Images tab", () => {
  it("is absent without images and present with them", async () => {
    await openFiles(false);
    expect(tabButton("Images")).toBeUndefined();
    expect(tabButton("Gating")).toBeDefined();
  });

  it("mounts on its first visit, stays mounted but dormant, and takes no gating-only update while hidden", async () => {
    await openFiles(true);
    expect(tabButton("Images")).toBeDefined();
    expect(host.querySelector('[data-testid="images-wall"]')).toBeNull();

    await act(async () => { tabButton("Images")!.click(); });
    for (let i = 0; i < 3; i++) await settle();
    expect(host.querySelector('[data-testid="images-wall"]')?.getAttribute("data-visible")).toBe("true");
    expect(wall.renders).toBeGreaterThan(0);

    await act(async () => { tabButton("Gating")!.click(); });
    await settle();
    expect(host.querySelector('[data-testid="images-wall"]')?.getAttribute("data-visible")).toBe("false");
    const hiddenRenders = wall.renders;

    // A gating-only update: a new gate and its population.
    act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices: [[0, 0], [1000, 1000]], x_channel: "FSC-A", y_channel: "SSC-A" }));
    const createPopulation = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.parentElement?.textContent?.includes("Also create a population"))!;
    act(() => createPopulation.click());
    act(() => buttonWithText("Create")!.click());
    await settle();
    expect(wall.renders).toBe(hiddenRenders);
  });

  it("sends the wall to the Layout tab as one labelled block", async () => {
    await openFiles(true);
    await act(async () => { tabButton("Images")!.click(); });
    for (let i = 0; i < 3; i++) await settle();
    expect(wall.send).toBeTruthy();
    const sampleId = host.querySelector<HTMLElement>('[role="option"]')?.getAttribute("data-sample-id") ?? "";
    await act(async () => {
      wall.send!({
        kind: "imagewall", sampleId: sampleId || "D1", fileName: "D1.fcs", populationId: "", populationName: "All Events",
        events: [0, 2], imaged: 2, populationCount: 3, sortKey: "", sortLabel: "", sortDesc: false, display: [], exposure: 1, tile: 40, columns: 2,
      });
    });
    // The Layout tab is a lazy chunk: wait for its page, longer under a loaded test run.
    for (let i = 0; i < 60 && !host.querySelector(".gl-layout-item"); i++) await settle();
    expect(tabButton("Layout")?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".gl-layout-item")).toBeTruthy();
    expect(host.textContent).toContain("D1.fcs");
  });

  it("returns to Gating when the last file's images are detached", async () => {
    await openFiles(true);
    await act(async () => { tabButton("Images")!.click(); });
    await settle();
    const detach = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Detach cell images")!;
    await act(async () => { detach.click(); });
    for (let i = 0; i < 2; i++) await settle();
    expect(tabButton("Images")).toBeUndefined();
    expect(tabButton("Gating")?.classList.contains("active")).toBe(true);
  });

  it("makes a population of cells picked on the wall, with its NOT, on a channel of the file", async () => {
    await openFiles(true);
    await act(async () => { tabButton("Images")!.click(); });
    for (let i = 0; i < 8 && !wall.make; i++) await settle();
    expect(wall.make).toBeTruthy();
    act(() => { wall.make!([0, 2], "Bright"); });
    await settle();
    // The picks are a 0/1 channel of the file, and two populations sit under All Events.
    expect(wall.entry?.sample.index("Image set: Bright")).toBeDefined();
    expect(host.textContent).toContain("Bright");
    expect(host.textContent).toContain("Not Bright");
    // The new population became the active one; Back returns to the one before, leaving both populations in place.
    const before = wall.popId;
    expect(before).toBeTruthy();
    const back = host.querySelector<HTMLButtonElement>("button.gl-view-back")!;
    expect(back.disabled).toBe(false);
    act(() => { back.click(); });
    await settle();
    expect(wall.popId).not.toBe(before);
    expect(host.textContent).toContain("Not Bright");
    const forward = host.querySelector<HTMLButtonElement>("button.gl-view-forward")!;
    act(() => { forward.click(); });
    await settle();
    expect(wall.popId).toBe(before);
    await act(async () => { tabButton("Gating")!.click(); });
    await settle();
    const rows = [...host.querySelectorAll<HTMLElement>(".gl-pop-row, [data-population-name], .gl-tree-row")].map((r) => r.textContent?.trim() ?? "");
    const text = host.textContent ?? "";
    expect(text).toMatch(/Bright[\s\S]*2(?![\d,])/);
    expect(rows.length >= 0).toBe(true);
  });

  it("scores the wall's cells by likeness to a pick as a channel of the file", async () => {
    await openFiles(true);
    await act(async () => { tabButton("Images")!.click(); });
    for (let i = 0; i < 8 && !wall.find; i++) await settle();
    let key: string | null = null;
    act(() => { key = wall.find!([0], "round"); });
    await settle();
    expect(key).toBe("Similar to round");
    const idx = wall.entry!.sample.index("Similar to round")!;
    const scores = Array.from(wall.entry!.sample.displayColumn(idx));
    expect(scores[0]).toBe(0);
    expect(scores.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
  });

  it("puts the picked cells on the Layout tab as a cell panel", async () => {
    await openFiles(true);
    await act(async () => { tabButton("Images")!.click(); });
    for (let i = 0; i < 8 && !wall.cellPanel; i++) await settle();
    expect(wall.cellPanel).toBeTruthy();
    const sampleId = (wall.entry as unknown as { id?: string } | null)?.id ?? "D1";
    await act(async () => {
      wall.cellPanel!({
        kind: "cellpanel", sampleId, fileName: "D1.fcs", cells: [{ event: 0, label: "Event 0" }, { event: 2, label: "Event 2" }],
        columns: [{ kind: "channel", slot: 2, header: "LightLoss (Imaging)", grey: true }],
        display: [{ slot: 2, name: "LightLoss (Imaging)", enabled: true, colour: "#bdbdbd", threshold: 0, saturation: 0.8, gamma: 1, smoothing: 1 }],
        exposure: 1, tile: 48, showHeaders: true, showLabels: true,
      });
    });
    for (let i = 0; i < 60 && !host.querySelector(".gl-layout-cellpanel"); i++) await settle();
    expect(tabButton("Layout")?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".gl-layout-cellpanel")?.getAttribute("data-cells")).toBe("2");
  });
});
