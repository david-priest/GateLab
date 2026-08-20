// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";

interface CapturedPlotProps {
  payload: {
    x_range: [number, number];
    y_range: [number, number];
    x_b64: string;
    y_b64: string;
    gates: Array<{ gate_id: string; gate_type: string }>;
  };
  onNewGate: (gate: { gate_type: string; vertices: [number, number][]; x_channel: string; y_channel: string }) => void;
}

const plotHarness = vi.hoisted(() => ({ props: null as CapturedPlotProps | null }));

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: CapturedPlotProps) => {
    plotHarness.props = props;
    return <div data-testid="gating-plot" />;
  },
}));

const N_EVENTS = 512;

/**
 * A file whose negative tail is set by `seed`. The logicle W is auto-estimated from each file's
 * OWN 5th percentile, so files with different tails estimate different W — which is exactly how
 * a real multi-file workspace used to open already split. A mock that returned one shared
 * FcsFile for every file could not express this, and so could not see any of it.
 */
function fcsForSeed(seed: number): FcsFile {
  // All fluorescence: both default axes then carry a logicle transform and a W slider.
  const names = ["BV711-A", "APC-A", "PE-A"];
  const tail = seed === 70 ? 40 : 5000;
  return {
    version: "FCS3.1",
    nEvents: N_EVENTS,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: names.map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: names.map((_, ci) =>
      Float32Array.from({ length: N_EVENTS }, (_, i) =>
        i < N_EVENTS / 4
          ? -tail * (1 + ((i + ci) % 7))
          : 400 * (1 + ((i + ci) % 90)))),
  };
}

vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: (ab: ArrayBuffer) => fcsForSeed(new Uint8Array(ab)[0]) };
});

import App from "./App";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", {
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  });
  plotHarness.props = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  plotHarness.props = null;
  uuid = 0;
});

function testFile(name: string, seed: number): File {
  const bytes = Uint8Array.from([seed, 67, 83]);
  const file = new File([bytes], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  return file;
}

function ranges(): { x: [number, number]; y: [number, number] } {
  if (!plotHarness.props) throw new Error("Gating plot was not rendered");
  return {
    x: [...plotHarness.props.payload.x_range] as [number, number],
    y: [...plotHarness.props.payload.y_range] as [number, number],
  };
}

function plotted(axis: "x" | "y"): Float32Array {
  const b64 = axis === "x" ? plotHarness.props!.payload.x_b64 : plotHarness.props!.payload.y_b64;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function wSliders(): HTMLInputElement[] {
  return [...host.querySelectorAll<HTMLInputElement>('.gl-scales input[type="range"]')];
}

function wReadouts(): string[] {
  return [...host.querySelectorAll<HTMLElement>(".gl-scales .gl-scale-val")]
    .map((el) => el.textContent?.trim() ?? "");
}

/** The slider commits on a trailing debounce, so let it fire. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

async function setSlider(input: HTMLInputElement, value: number): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

async function loadFiles(files: File[]): Promise<void> {
  const fcsInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
    .find((input) => !input.hasAttribute("webkitdirectory"))!;
  Object.defineProperty(fcsInput, "files", { configurable: true, value: files });
  await act(async () => {
    fcsInput.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function mount(files: File[]): Promise<void> {
  act(() => root.render(<App />));
  await loadFiles(files);
}

describe("logicle W is a property of the channel, not of one file", () => {
  it("re-fits the axis when the W slider moves", async () => {
    await mount([testFile("solo.fcs", 70)]);
    const sliders = wSliders();
    expect(sliders.length).toBeGreaterThan(0);

    const before = ranges();
    await setSlider(sliders[0], 1.9);
    const after = ranges();
    expect(after.x).not.toEqual(before.x);

    await setSlider(wSliders()[0], 0.3);
    expect(ranges().x).not.toEqual(after.x);
  });

  // The defect: the combined cloud transforms each file's events with that file's own Sample,
  // so a control that reached only the active file left the rest frozen at the old transform.
  // Measured on two real FCS files, exactly 50% of the cloud stayed put; with four, 75%.
  it("moves every plotted point, not only the active file's", async () => {
    await mount([testFile("sample-a.fcs", 70), testFile("sample-b.fcs", 71)]);

    const before = Float32Array.from(plotted("x"));
    expect(before.length).toBeGreaterThan(N_EVENTS); // both files contribute

    await setSlider(wSliders()[0], 1.85);
    const after = plotted("x");
    expect(after.length).toBe(before.length);

    // Per block, not in aggregate: an aggregate count cannot tell "file B followed the slider"
    // from "file B was re-emitted as a copy of file A".
    const half = before.length / 2;
    const movedIn = (from: number, to: number) => {
      let moved = 0;
      for (let i = from; i < to; i++) if (before[i] !== after[i]) moved++;
      return (100 * moved) / (to - from);
    };
    expect(movedIn(0, half), "first file did not follow the slider").toBeGreaterThan(99);
    expect(movedIn(half, before.length), "second file did not follow the slider").toBeGreaterThan(99);
  });

  // Each file estimates W from its own data, so a pooled workspace used to open under several
  // different transforms before the user touched anything at all.
  it("opens two differing files under one shared transform", async () => {
    await mount([testFile("sample-a.fcs", 70), testFile("sample-b.fcs", 71)]);
    const readouts = wReadouts();
    expect(readouts.length).toBeGreaterThan(0);

    // Both axes report a W; switching the active file must not change what is reported,
    // because the setting belongs to the channel.
    const rows = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    const rowB = rows.find((row) => row.textContent?.includes("sample-b"));
    expect(rowB).toBeTruthy();
    act(() => rowB!.click());
    expect(rowB!.getAttribute("aria-selected"), "row B did not become active").toBe("true");
    expect(wReadouts()).toEqual(readouts);
  });

  // The reset button reverts to the SHARED estimate. Reverting each file to its own estimate
  // is what made "reset to auto" deterministically re-split a pooled cloud.
  it("keeps files unified after resetting W to auto", async () => {
    await mount([testFile("sample-a.fcs", 70), testFile("sample-b.fcs", 71)]);
    await setSlider(wSliders()[0], 1.75);

    const resetButton = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.getAttribute("aria-label")?.startsWith("Reset X logicle W"));
    expect(resetButton).toBeTruthy();

    const before = Float32Array.from(plotted("x"));
    act(() => resetButton!.click());
    await settle();
    const after = plotted("x");

    const half = before.length / 2;
    const movedIn = (from: number, to: number) => {
      let moved = 0;
      for (let i = from; i < to; i++) if (before[i] !== after[i]) moved++;
      return (100 * moved) / (to - from);
    };
    // Both blocks return together; neither is left behind on the other's estimate.
    expect(movedIn(0, half)).toBeGreaterThan(99);
    expect(movedIn(half, before.length)).toBeGreaterThan(99);
  });

  // A fan-out over the samples that exist cannot reach a file that does not exist yet.
  it("gives a file loaded after the change the current W", async () => {
    await mount([testFile("sample-a.fcs", 70)]);
    await setSlider(wSliders()[0], 1.65);
    const readoutBefore = wReadouts()[0];

    await loadFiles([testFile("sample-b.fcs", 71)]);
    expect(wReadouts()[0]).toBe(readoutBefore);
  });
});
