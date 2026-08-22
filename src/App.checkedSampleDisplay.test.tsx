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
  // Seed 3 stands for a DIFFERENT panel: same detectors, a different stain on the second one.
  // That is the case that must not pool — a shared channel name is not a shared measurement.
  const secondMarker = seed === 3 ? "CD4" : null;
  return {
    version: "FCS3.1",
    nEvents: count,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: secondMarker, bits: 32, range: 262144 },
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
  // Refusing to pool across panels, rather than narrowing to the channels they share. Two panels
  // can put a different marker on the same detector, so pooling on a shared NAME draws one cloud
  // from two different stains and any gate on it means nothing in either.
  it("refuses to pool a checked file whose panel differs, and says so", async () => {
    act(() => root.render(<App />));
    const directInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(directInput, "files", {
      configurable: true,
      value: [testFile("panel-1.fcs", 1), testFile("panel-2.fcs", 3)],
    });
    await act(async () => {
      directInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();

    // Both checked, but only the primary contributes: the other panel is refused, not narrowed
    // to the channels the two happen to share. The primary is the most recently added file, so
    // panel-2's 4 events are drawn and panel-1's 3 are not — never the pooled 7.
    expect(host.textContent).toContain("2 checked FCS");
    expect(plottedCount()).toBe(4);
    expect(host.textContent).toContain("different panel");

    // Unchecking the primary leaves the mismatched file alone, which is fine — it simply becomes
    // the primary itself, and there is nothing left to refuse.
    const show2 = host.querySelector<HTMLInputElement>(
      'input[aria-label="Show panel-2.fcs in plots and analyses"]',
    )!;
    act(() => show2.click());
    await settle();
    expect(plottedCount()).toBe(3);
    expect(host.textContent).not.toContain("different panel");
  });


  it("makes the checkboxes the whole selection, with no separate active row", async () => {
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
    expect(host.textContent).toContain("1 of 2 files contribute");
    expect(host.textContent).toContain("Pooled counts: 2 FCS · selected display: 1 contribute");

    const openFcsExport = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Export FCS…")!;
    act(() => openFcsExport.click());
    await settle();
    expect(host.textContent).toContain("FCS outputs to write: 1 · skipped: 1 (≤ 0 events)");
    const cancelFcsExport = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Cancel")!;
    act(() => cancelFcsExport.click());

    const allEvents = [...host.querySelectorAll<HTMLElement>(".pop-row")]
      .find((row) => row.textContent?.includes("All Events"))!;
    act(() => allEvents.click());
    expect(plottedCount()).toBe(7);
    expect(host.textContent).toContain("2 of 2 files contribute");

    const showA = host.querySelector<HTMLInputElement>(
      'input[aria-label="Show sample-a.fcs in plots and analyses"]',
    )!;
    act(() => showA.click());
    expect(plottedCount()).toBe(4);
    expect(plottedX().every((value) => value > 1)).toBe(true);

    // Clicking a row now CHECKS that file and unchecks the rest, rather than setting a separate
    // active row alongside the checkboxes. Two selections to keep in step is what let the header,
    // the plot and the population counts each describe a different file at the same time.
    const rowA = [...host.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((row) => row.textContent?.includes("sample-a.fcs"))!;
    act(() => rowA.click());
    await settle();
    expect(rowA.getAttribute("aria-selected")).toBe("true");
    expect(showA.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>(
      'input[aria-label="Show sample-b.fcs in plots and analyses"]',
    )!.checked).toBe(false);
    expect(plottedCount()).toBe(3);
    expect(plottedX().every((value) => value < 0.7)).toBe(true);
    expect(plotHarness.props!.payload.x_range).toEqual(sharedRange);

    // Unchecking the last file keeps the plot on screen at zero events rather than removing the
    // gating view, so the state is legible and recoverable.
    act(() => showA.click());
    expect(plottedCount()).toBe(0);
    expect(host.textContent).toContain("No checked files");

    act(() => showA.click());
    expect(plottedCount()).toBe(3);
  });
});
