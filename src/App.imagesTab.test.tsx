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

const wall = vi.hoisted(() => ({ renders: 0, lastVisible: null as boolean | null }));
// The stand-in is memoised with the tab's own comparator, so what is counted is what App hands
// through it: a prop change while hidden must not reach the tab.
vi.mock("./imaging/ImagesTab", async (importOriginal) => {
  const { memo } = await import("react");
  const actual = await importOriginal<typeof import("./imaging/ImagesTab")>();
  const Fake = (props: { visible: boolean }) => {
    wall.renders++;
    wall.lastVisible = props.visible;
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
const buttonWithText = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);

async function openFiles(withImages: boolean): Promise<void> {
  const handles = [handleOf("D1.fcs", Uint8Array.from([70, 67, 83]))];
  if (withImages) handles.push(handleOf("D1.cvw", cvwBytes));
  Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn().mockResolvedValue(handles) });
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn() });
  act(() => root.render(<App />));
  await act(async () => { buttonWithText("+ Files…")!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
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
});
