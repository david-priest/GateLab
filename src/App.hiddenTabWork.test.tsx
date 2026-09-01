// @vitest-environment jsdom
//
// The performance invariant: a tab that is not showing may not rebuild an analysis dataset in
// response to a gating-only update. The Illustration tab's per-sample views are the expensive
// case -- each one runs derivePopulationView, which counts every gate over every event of that
// sample -- and they used to be built on every gate edit no matter which tab was open. On a
// four-file, 6M-event workspace that was about 465ms of each ~790ms gate commit, thrown away
// unread. The counter here is computeGateCounts, which those views call once per sample.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import type { NewGate } from "./plots/GatingPlot";

const plotHarness = vi.hoisted(() => ({
  props: null as { onNewGate: (gate: NewGate) => void } | null,
}));

const gateCountCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: { onNewGate: (gate: NewGate) => void }) => {
    plotHarness.props = props;
    return <div data-testid="gating-plot" />;
  },
}));

vi.mock("./engine/populations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/populations")>();
  return {
    ...actual,
    computeGateCounts: (...args: Parameters<typeof actual.computeGateCounts>) => {
      gateCountCalls.count += 1;
      return actual.computeGateCounts(...args);
    },
  };
});

function syntheticFcs(seed: number): FcsFile {
  const count = 4;
  return {
    version: "FCS3.1",
    nEvents: count,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [
      Float32Array.from({ length: count }, (_, index) => seed * 100 + index),
      Float32Array.from({ length: count }, (_, index) => seed * 100 + index + 10),
    ],
    spillover: null,
  };
}

vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: (buffer: ArrayBuffer) => syntheticFcs(new Uint8Array(buffer)[0]) };
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
  gateCountCalls.count = 0;
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
  const bytes = Uint8Array.from([seed]);
  const file = new File([bytes], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  return file;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === text);
}

describe("hidden tabs and gating-only updates", () => {
  it("does not build the Illustration tab's per-sample views while another tab is showing", async () => {
    act(() => root.render(<App />));
    const directInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(directInput, "files", {
      configurable: true,
      value: [testFile("sample-a.fcs", 1), testFile("sample-b.fcs", 2), testFile("sample-c.fcs", 3)],
    });
    await act(async () => {
      directInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();
    expect(host.textContent).toContain("3 checked FCS");

    // A gating-only update: draw a gate and make a population of it, with both files checked.
    gateCountCalls.count = 0;
    act(() => plotHarness.props!.onNewGate({
      gate_type: "rectangle",
      vertices: [[0, 0], [1000, 1000]],
      x_channel: "FSC-A",
      y_channel: "SSC-A",
    }));
    const createPopulation = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.parentElement?.textContent?.includes("Also create a population"))!;
    act(() => createPopulation.click());
    act(() => buttonWithText("Create")!.click());
    await settle();

    const onGatingTab = gateCountCalls.count;
    // Exactly one: the active sample's own counts, which feed the gates panel and are
    // legitimate. Anything more is a pass per checked file for a tab nobody is looking at --
    // the growth with workspace size that this guards against. Three files are loaded so a
    // regression reads as 3 rather than as an off-by-one.
    expect(onGatingTab).toBe(1);

    // Switching to Illustration is where those views are actually read, so the work belongs here.
    act(() => buttonWithText("Illustration")!.click());
    await settle();
    expect(gateCountCalls.count).toBeGreaterThan(onGatingTab);
  });
});
