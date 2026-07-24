// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import { decodeFloat32Base64 } from "./engine/encode";
import type { NewGate } from "./plots/GatingPlot";

interface CapturedPlotProps {
  payload: {
    n_events: number;
    x_b64: string;
    y_b64: string;
    x_range: [number, number];
    y_range: [number, number];
  };
  onNewGate: (gate: NewGate) => void;
}

const plotHarness = vi.hoisted(() => ({
  props: null as CapturedPlotProps | null,
}));

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: CapturedPlotProps) => {
    plotHarness.props = props;
    return <div data-testid="gating-plot" />;
  },
}));

function syntheticFcs(seed: number): FcsFile {
  const count = seed === 1 ? 3 : 4;
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
  return {
    ...actual,
    parseFcs: (buffer: ArrayBuffer) => syntheticFcs(new Uint8Array(buffer)[0]),
  };
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
  const bytes = Uint8Array.from([seed]);
  const file = new File([bytes], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => bytes.buffer.slice(0),
  });
  return file;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function plottedCount(): number {
  if (!plotHarness.props) throw new Error("Gating plot was not rendered");
  expect(decodeFloat32Base64(plotHarness.props.payload.x_b64)).toHaveLength(
    decodeFloat32Base64(plotHarness.props.payload.y_b64).length,
  );
  return plotHarness.props.payload.n_events;
}

function plottedX(): number[] {
  if (!plotHarness.props) throw new Error("Gating plot was not rendered");
  return [...decodeFloat32Base64(plotHarness.props.payload.x_b64)];
}

describe("App checked-sample gating display", () => {
  it("uses checkboxes for plotted files while the blue row only controls the active file", async () => {
    act(() => root.render(<App />));
    const directInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(directInput, "files", {
      configurable: true,
      value: [testFile("sample-a.fcs", 1), testFile("sample-b.fcs", 2)],
    });
    await act(async () => {
      directInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();

    expect(plottedCount()).toBe(7);
    expect(plottedX().slice(0, 3).every((value) => value < 0.7)).toBe(true);
    expect(plottedX().slice(3).every((value) => value > 1)).toBe(true);
    expect(host.textContent).toContain("2 checked FCS");
    expect(host.textContent).toContain("Pooled display");
    const sharedRange = [...plotHarness.props!.payload.x_range] as [number, number];

    act(() => plotHarness.props!.onNewGate({
      gate_type: "rectangle",
      vertices: [[0, 0], [1.05, 1.05]],
      x_channel: "FSC-A",
      y_channel: "SSC-A",
    }));
    const createPopulation = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.parentElement?.textContent?.includes("Also create a population"))!;
    act(() => createPopulation.click());
    const create = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Create")!;
    act(() => create.click());
    await settle();
    expect(plottedCount()).toBe(3);

    const allEvents = [...host.querySelectorAll<HTMLElement>(".pop-row")]
      .find((row) => row.textContent?.includes("All Events"))!;
    act(() => allEvents.click());
    expect(plottedCount()).toBe(7);

    const showA = host.querySelector<HTMLInputElement>(
      'input[aria-label="Show sample-a.fcs in plots and analyses"]',
    )!;
    act(() => showA.click());
    expect(plottedCount()).toBe(4);
    expect(plottedX().every((value) => value > 1)).toBe(true);

    const rowA = [...host.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((row) => row.textContent?.includes("sample-a.fcs"))!;
    act(() => rowA.click());
    await settle();
    expect(rowA.getAttribute("aria-selected")).toBe("true");
    expect(showA.checked).toBe(false);
    expect(plottedCount()).toBe(4);
    expect(plottedX().every((value) => value > 1)).toBe(true);
    expect(plotHarness.props!.payload.x_range).toEqual(sharedRange);

    const showB = host.querySelector<HTMLInputElement>(
      'input[aria-label="Show sample-b.fcs in plots and analyses"]',
    )!;
    act(() => showB.click());
    expect(plottedCount()).toBe(0);
    expect(host.textContent).toContain("No checked files");

    act(() => showA.click());
    expect(plottedCount()).toBe(3);
  });
});
