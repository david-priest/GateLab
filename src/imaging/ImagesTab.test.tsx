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
  const renders: { eventIndex: number; lane: string }[] = [];
  const suspended: string[] = [];
  const info: SourceInfo = {
    eventCount: hasImage.length, imageCount: hasImage.filter(Boolean).length, hasImage: Uint8Array.from(hasImage),
    scale: { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 }, channelNames: Object.fromEntries(names), pixelAspectRatio: 0.3, recordingId: "r",
  };
  const service = {
    attach() {}, detach() {}, hasSource: () => true,
    knownInfo: () => info, info: async () => info,
    cached: () => null,
    render(_fileKey: string, eventIndex: number, _spec: unknown, lane: string) {
      renders.push({ eventIndex, lane });
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

  it("says so when the viewed file has no images", async () => {
    render({ entry: { ...entry, images: null } });
    await settle();
    expect(host.textContent).toContain("No cell images are attached to the viewed file");
  });
});
