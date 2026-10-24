// @vitest-environment jsdom
//
// The Transforms row offers FlowJo's biexponential on every flow fluorescence channel. A channel
// nothing recorded one for takes FlowJo 10's top and decades for its $PnR with the width basis
// estimated from its negative values (Sample.defaultBiex), and its control names that default
// axis, not a recording. Synthetic channels and events.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import { estimateBiexWidthBasis, defaultBiexParams } from "./engine/biex";
import { formatBiexSummary, formatBiexWidth } from "./ui/BiexAxisControl";

interface CapturedPlotProps {
  payload: {
    x_range: [number, number];
    y_range: [number, number];
    x_b64: string;
    gates: Array<{ gate_id: string; gate_type: string; vertices?: [number, number][] }>;
  };
  onRangeChange: (event: { x_range: [number, number]; y_range: [number, number] }) => void;
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

/** Three fluorescence channels at $PnR 262,144, with no biexponential recorded for any of them. */
function fcs(): FcsFile {
  const names = ["FL1-A", "FL2-A", "FL3-A"];
  return {
    version: "FCS3.1",
    nEvents: N_EVENTS,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: names.map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: names.map((_, ci) =>
      Float32Array.from({ length: N_EVENTS }, (_, i) => (i < N_EVENTS / 4 ? -300 * (1 + ((i + ci) % 7)) : 400 * (1 + ((i + ci) % 90))))),
  };
}

vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => fcs() };
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

function testFile(name: string): File {
  const bytes = Uint8Array.from([1, 67, 83]);
  const file = new File([bytes], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  return file;
}

async function mount(): Promise<void> {
  act(() => root.render(<App />));
  const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find((el) => !el.hasAttribute("webkitdirectory"))!;
  Object.defineProperty(input, "files", { configurable: true, value: [testFile("D1.fcs")] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function plottedX(): Float32Array {
  const bin = atob(plotHarness.props!.payload.x_b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

describe("FlowJo biexponential in the Transforms row", () => {
  it("is offered on a channel with nothing recorded, and opens the biex control on the default axis", async () => {
    await mount();
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="X signal scale"]')!;
    expect(select).not.toBeNull();
    expect([...select.options].map((o) => o.value)).toEqual(["logicle", "arcsinh", "biex"]);
    expect(select.options[2].textContent).toBe("Biexponential");
    expect(host.querySelector('input[aria-label="X biex widthBasis"]')).toBeNull();
    const before = Float32Array.from(plottedX());

    await act(async () => {
      select.value = "biex";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(host.querySelector<HTMLSelectElement>('select[aria-label="X signal scale"]')!.value).toBe("biex");
    // The width basis on the row at the estimate from FL1-A's own negative values, the rest behind
    // the menu: FlowJo's top at $PnR and log10($PnR) − 1 decades.
    const auto = { ...defaultBiexParams(262144)!, widthBasis: estimateBiexWidthBasis(fcs().columns[0], defaultBiexParams(262144)!) };
    expect(auto.widthBasis).not.toBe(-100);
    expect(host.querySelector('input[aria-label="X biex widthBasis"]')).not.toBeNull();
    expect(host.querySelector(".gl-biex-width")!.textContent).toBe(formatBiexWidth(auto.widthBasis));
    expect(host.querySelector(".gl-biex-summary")!.textContent).toBe(formatBiexSummary(auto));
    expect(formatBiexSummary(auto).startsWith("4.42 · 0 · ")).toBe(true);
    // Nothing was recorded, so Reset names the default axis, and there is nothing yet to reset.
    expect(host.querySelector('button[aria-label="Reset X biex to recorded"]')).toBeNull();
    const reset = host.querySelector<HTMLButtonElement>('button[aria-label="Reset X biex to default"]')!;
    expect(reset.textContent).toBe("Reset to default");
    expect(reset.disabled).toBe(true);
    // The plotted axis is the biexponential's 0–256 display, not the logicle's.
    const after = plottedX();
    expect(after.length).toBe(before.length);
    expect(Math.max(...after)).toBeLessThanOrEqual(256);
    expect(after.some((v, i) => v !== before[i])).toBe(true);
  });
});

describe("moving and stretching a biex axis", () => {
  async function onBiexX(): Promise<void> {
    await mount();
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="X signal scale"]')!;
    await act(async () => {
      select.value = "biex";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  const view = (): { x: [number, number]; y: [number, number] } => {
    const { x_range, y_range } = plotHarness.props!.payload;
    return { x: [x_range[0], x_range[1]], y: [y_range[0], y_range[1]] };
  };
  /** The renderer reporting where a pan or stretch of its own ended, as it does on release. */
  const commit = (x: [number, number], y: [number, number]) => act(() => plotHarness.props!.onRangeChange({ x_range: x, y_range: y }));
  const gateRow = () => [...host.querySelectorAll(".pop-row")][1]?.textContent ?? "";

  it("goes past either end of the table as a logicle axis does, and no gate or count moves", async () => {
    await onBiexX();
    // A rectangle around the 384 events with a positive FL1-A (events 128 onward): on X, between
    // the highest negative event and the lowest positive one, up to above the highest; on Y, well
    // beyond the data both ways.
    const x = plottedX();
    const negTop = Math.max(...x.slice(0, N_EVENTS / 4));
    const posBottom = Math.min(...x.slice(N_EVENTS / 4));
    expect(negTop).toBeLessThan(posBottom);
    const { y } = view();
    const ySpan = y[1] - y[0];
    act(() => plotHarness.props!.onNewGate({
      gate_type: "rectangle", x_channel: "FL1-A", y_channel: "FL2-A",
      vertices: [[(negTop + posBottom) / 2, y[0] - ySpan], [Math.max(...x) + 1, y[1] + ySpan]],
    }));
    const also = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((c) => c.parentElement?.textContent?.includes("Also create a population"));
    if (also && !also.checked) act(() => also.click());
    const create = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Create")!;
    await act(async () => {
      create.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const counted = /(?:^|\D)384\s*\(/;
    expect(gateRow()).toMatch(counted);
    const gateBefore = JSON.stringify(plotHarness.props!.payload.gates.map((g) => g.vertices));
    const rowsBefore = [...host.querySelectorAll(".pop-row")].map((r) => r.textContent);

    // Panned right past channel 0 and left past the table's top: the view is where it was put.
    commit([-40, 200], y);
    expect(view().x).toEqual([-40, 200]);
    commit([100, 300], y);
    expect(view().x).toEqual([100, 300]);
    // A stretch out keeps its minimum, beyond the top as anywhere else.
    commit([100, 420], y);
    expect(view().x).toEqual([100, 420]);
    // The zoom buttons, likewise: the minimum held, the span divided or multiplied.
    const zoom = (label: string) => act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
    zoom("Zoom out");
    expect(view().x[0]).toBe(100);
    expect(view().x[1]).toBeCloseTo(100 + 320 * Math.sqrt(1.5), 9);
    zoom("Zoom in");
    expect(view().x[0]).toBe(100);
    expect(view().x[1]).toBeCloseTo(420, 9);

    // Display only: the gate's vertices and every count are as they were.
    expect(JSON.stringify(plotHarness.props!.payload.gates.map((g) => g.vertices))).toBe(gateBefore);
    expect([...host.querySelectorAll(".pop-row")].map((r) => r.textContent)).toEqual(rowsBefore);
    expect(gateRow()).toMatch(counted);
  });
});
