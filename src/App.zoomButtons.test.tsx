// @vitest-environment jsdom
//
// The zoom buttons beside "Fit data + gates": each press magnifies (or shrinks) the view by one
// step with the bottom-left corner held, the anchoring of the Shift-drag stretch. On the scatter
// plot both axes move; on the histogram only X does, and the Y channel's scale is left as it was.
// A gate drawn before the zoom keeps its coordinates and its count: the zoom is a view change.
//
// Synthetic file D1: FSC-A 100..1000 and SSC-A 150..1050 in steps of 100, linear.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import type { NewGate } from "./plots/GatingPlot";
import { ZOOM_BUTTON_STEP } from "./plots/panGesture";

interface CapturedPlotProps {
  payload: {
    x_range: [number, number];
    y_range: [number, number];
    gates: Array<{ gate_id: string; gate_type: string; vertices?: [number, number][] }>;
  };
  onNewGate: (gate: NewGate) => void;
}
const plotHarness = vi.hoisted(() => ({ props: null as CapturedPlotProps | null }));
vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: CapturedPlotProps) => {
    plotHarness.props = props;
    return <div data-testid="gating-plot" />;
  },
}));

function syntheticFcs(): FcsFile {
  return {
    version: "FCS3.1",
    nEvents: 10,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [
      Float32Array.from({ length: 10 }, (_, i) => (i + 1) * 100),
      Float32Array.from({ length: 10 }, (_, i) => (i + 1) * 100 + 50),
    ],
    spillover: null,
  };
}
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => syntheticFcs() };
});

import App from "./App";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
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

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

async function loadFile(): Promise<void> {
  act(() => root.render(<App />));
  const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
    .find((candidate) => !candidate.hasAttribute("webkitdirectory"))!;
  const bytes = Uint8Array.from([1]);
  const fcs = new File([bytes], "D1.fcs");
  Object.defineProperty(fcs, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  Object.defineProperty(input, "files", { configurable: true, value: [fcs] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
}

const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
const zoom = (direction: "in" | "out") =>
  host.querySelector<HTMLButtonElement>(`.gl-pool-toolbar-right button[data-zoom="${direction}"]`)!;
const popRow = (name: string) =>
  [...host.querySelectorAll(".pop-row")].map((r) => r.textContent?.replace(/\s+/g, " ").trim()).find((t) => t?.includes(name));
const ranges = () => ({
  x: [...plotHarness.props!.payload.x_range] as [number, number],
  y: [...plotHarness.props!.payload.y_range] as [number, number],
});
const span = (r: [number, number]) => r[1] - r[0];

describe("the plot's zoom buttons", () => {
  it("zoom the scatter plot on both axes with the bottom-left corner held, and leave a gate and its count alone", async () => {
    await loadFile();
    expect(zoom("in").getAttribute("aria-label")).toBe("Zoom in");
    expect(zoom("out").getAttribute("aria-label")).toBe("Zoom out");

    // A rectangle around the four events from FSC 450 to 850: 500, 600, 700 and 800.
    act(() => plotHarness.props!.onNewGate({
      gate_type: "rectangle", vertices: [[450, 0], [850, 2000]], x_channel: "FSC-A", y_channel: "SSC-A",
    }));
    const createPopulation = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((candidate) => candidate.parentElement?.textContent?.includes("Also create a population"))!;
    if (!createPopulation.checked) act(() => createPopulation.click());
    act(() => button("Create")!.click());
    await settle();
    expect(popRow("Gate_1")).toContain("4(40% pnt");
    act(() => [...host.querySelectorAll<HTMLElement>(".pop-row")].find((r) => r.textContent?.includes("All Events"))!.click());
    await settle();
    const gateVertices = () => plotHarness.props!.payload.gates.find((g) => g.gate_type === "rectangle")!.vertices;
    const vertices = gateVertices();

    const start = ranges();
    act(() => zoom("in").click());
    await settle();
    const zoomedIn = ranges();
    expect(zoomedIn.x[0]).toBeCloseTo(start.x[0], 9);
    expect(zoomedIn.y[0]).toBeCloseTo(start.y[0], 9);
    expect(span(zoomedIn.x)).toBeCloseTo(span(start.x) / ZOOM_BUTTON_STEP, 6);
    expect(span(zoomedIn.y)).toBeCloseTo(span(start.y) / ZOOM_BUTTON_STEP, 6);

    act(() => zoom("in").click());
    await settle();
    expect(span(ranges().x)).toBeCloseTo(span(start.x) / ZOOM_BUTTON_STEP ** 2, 6);
    expect(gateVertices()).toEqual(vertices);
    expect(popRow("Gate_1")).toContain("4(40% pnt");

    // Two presses out undo two presses in.
    act(() => zoom("out").click());
    act(() => zoom("out").click());
    await settle();
    const back = ranges();
    expect(back.x[0]).toBeCloseTo(start.x[0], 9);
    expect(back.x[1]).toBeCloseTo(start.x[1], 6);
    expect(back.y[1]).toBeCloseTo(start.y[1], 6);
    expect(gateVertices()).toEqual(vertices);

    // The Fit beside the buttons brings back the fitted view from a zoomed one.
    act(() => button("Fit data + gates")!.click());
    await settle();
    const fitted = ranges();
    act(() => zoom("in").click());
    await settle();
    expect(span(ranges().x)).toBeCloseTo(span(fitted.x) / ZOOM_BUTTON_STEP, 6);
    act(() => button("Fit data + gates")!.click());
    await settle();
    expect(ranges()).toEqual(fitted);
  });

  it("zoom the histogram along X only, its low end held, and leave the Y channel's scale alone", async () => {
    await loadFile();
    act(() => host.querySelector<HTMLButtonElement>('button[data-tool="histogram"]')!.click());
    await settle();
    expect(host.querySelector('[data-testid="histogram-plot"]')).not.toBeNull();

    const start = ranges();
    const axisTicks = () => [...host.querySelectorAll('[data-testid="histogram-plot"] svg text')].map((el) => el.textContent).join("|");
    const ticksBefore = axisTicks();
    act(() => zoom("in").click());
    await settle();
    const zoomedIn = ranges();
    expect(zoomedIn.x[0]).toBeCloseTo(start.x[0], 9);
    expect(span(zoomedIn.x)).toBeCloseTo(span(start.x) / ZOOM_BUTTON_STEP, 6);
    expect(zoomedIn.y).toEqual(start.y);
    // The histogram draws the new range.
    expect(axisTicks()).not.toBe(ticksBefore);

    act(() => zoom("out").click());
    await settle();
    expect(ranges().x[1]).toBeCloseTo(start.x[1], 6);
    expect(ranges().y).toEqual(start.y);

    // Back on the scatter plot, Y is where it was before the histogram was zoomed.
    act(() => host.querySelector<HTMLButtonElement>('button[data-tool="histogram"]')!.click());
    await settle();
    expect(host.querySelector('[data-testid="histogram-plot"]')).toBeNull();
    expect(ranges().y).toEqual(start.y);
  });
});
