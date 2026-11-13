// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import { decodeFloat32Base64 } from "./engine/encode";
import type { NewGate } from "./plots/GatingPlot";

interface CapturedPlotProps {
  payload: {
    x_range: [number, number];
    y_range: [number, number];
    x_b64: string;
    y_b64: string;
    x_label: string;
    y_label: string;
    gates: Array<{ percent_of_parent?: number | null }>;
  };
  onNewGate: (gate: NewGate) => void;
  onAxisLabelClick: (event: { axis: "x" | "y"; selected: string }) => void;
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
    spillover: null,
    channels: ["FSC-A", "SSC-A"].map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: [
      Float32Array.from({ length: 10 }, (_, i) => (i + 1) * 100),
      Float32Array.from({ length: 10 }, (_, i) => (i + 1) * 1000),
    ],
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
  const file = new File([bytes], "scatter.fcs");
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
}

async function tab(name: string): Promise<void> {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((candidate) => candidate.textContent?.trim() === name)!;
  expect(button).toBeTruthy();
  act(() => button.click());
  await settle();
}

function scaleRow(channel: string): HTMLTableRowElement {
  const row = [...host.querySelectorAll<HTMLTableRowElement>(".gl-scales-table tbody tr")]
    .find((candidate) => candidate.cells[0].textContent === channel);
  if (!row) throw new Error(`No Scales row for ${channel}`);
  return row;
}

async function setRange(channel: string, range: [number, number]): Promise<void> {
  for (const [index, value] of range.entries()) {
    const input = scaleRow(channel).querySelectorAll<HTMLInputElement>('input[type="number"]')[index];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, String(value));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
  }
}

async function transform(select: HTMLSelectElement, value: "linear" | "arcsinh"): Promise<void> {
  expect(select).toBeTruthy();
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

function range(axis: "x" | "y"): [number, number] {
  if (!plotHarness.props) throw new Error("No plot payload");
  return plotHarness.props.payload[`${axis}_range`];
}

function expectArcsinhFit(axis: "x" | "y", step: number): void {
  const values = decodeFloat32Base64(plotHarness.props!.payload[`${axis}_b64`]);
  expect(values).toHaveLength(10);
  // Check the actual plotted coordinates, independently of the App's fit implementation.
  values.forEach((value, i) => expect(value).toBeCloseTo(Math.asinh(((i + 1) * step) / 150), 5));
  expect(range(axis)[0]).toBeLessThan(values[0]);
  expect(range(axis)[1]).toBeGreaterThan(values[values.length - 1]);
  expect(range(axis)[1]).toBeLessThan(10); // transformed units, not the old raw frame
}

function expectKnownGateCount(): void {
  expect([...host.querySelectorAll(".pop-row")][1]?.textContent).toContain("5(50% pnt");
  expect(plotHarness.props!.payload.gates[0].percent_of_parent).toBe(50);
}

async function createKnownGate(): Promise<void> {
  // Five known events (300 to 700 on FSC) stay inside this raw-space rectangle after a
  // transform change. The plot's percentage must follow the same population count.
  act(() => plotHarness.props!.onNewGate({
    gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A",
    vertices: [[250, 2500], [750, 7500]],
  }));
  const population = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .find((input) => input.parentElement?.textContent?.includes("Also create a population"))!;
  if (!population.checked) act(() => population.click());
  const create = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Create")!;
  act(() => create.click());
  await settle();
  act(() => [...host.querySelectorAll<HTMLElement>(".pop-row")]
    .find((row) => row.textContent?.includes("All Events"))!.click());
  await settle();
  expectKnownGateCount();
}

describe("transform refits preserve the other channel's range", () => {
  it("keeps a typed FSC range when SSC changes on Scales, including after another repaint", async () => {
    await loadFile();
    await createKnownGate();
    await tab("Scales");
    await setRange("FSC-A", [-750, 4250]);
    await setRange("SSC-A", [-400, 22000]);
    await transform(scaleRow("SSC-A").querySelector("select")!, "arcsinh");
    expect([...scaleRow("FSC-A").querySelectorAll<HTMLInputElement>('input[type="number"]')].map((input) => +input.value))
      .toEqual([-750, 4250]);
    await tab("Gating");
    expect(range("x")).toEqual([-750, 4250]);
    expectArcsinhFit("y", 1000);
    expectKnownGateCount();
    await tab("Scales");
    await tab("Gating");
    expect(range("x")).toEqual([-750, 4250]);
    expectArcsinhFit("y", 1000);
    expectKnownGateCount();
  });

  it("keeps a typed SSC range when the X transform changes on Gating", async () => {
    await loadFile();
    await createKnownGate();
    await tab("Scales");
    await setRange("FSC-A", [-750, 4250]);
    await setRange("SSC-A", [-400, 22000]);
    await tab("Gating");
    await transform(host.querySelector<HTMLSelectElement>('select[aria-label="X scatter scale"]')!, "arcsinh");
    expect(range("y")).toEqual([-400, 22000]);
    expectArcsinhFit("x", 100);
    expectKnownGateCount();
    await tab("Scales");
    await tab("Gating");
    expect(range("y")).toEqual([-400, 22000]);
    expectArcsinhFit("x", 100);
    expectKnownGateCount();
  });

  it("keeps the other channel's range after swapping axes and changing Y", async () => {
    await loadFile();
    await tab("Scales");
    await setRange("FSC-A", [-750, 4250]);
    await setRange("SSC-A", [-400, 22000]);
    await tab("Gating");
    act(() => host.querySelector<HTMLElement>(".gl-plot-area")!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
    ));
    const swap = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === "Swap X and Y")!;
    act(() => swap.click());
    expect([plotHarness.props!.payload.x_label, plotHarness.props!.payload.y_label]).toEqual(["SSC-A", "FSC-A"]);
    await transform(host.querySelector<HTMLSelectElement>('select[aria-label="Y scatter scale"]')!, "arcsinh");
    expect(range("x")).toEqual([-400, 22000]);
    expectArcsinhFit("y", 100);
    await tab("Scales");
    await tab("Gating");
    expect(range("x")).toEqual([-400, 22000]);
    expectArcsinhFit("y", 100);
  });

  it("refits both axes when they show the same channel whose transform changes", async () => {
    await loadFile();
    act(() => plotHarness.props!.onAxisLabelClick({ axis: "y", selected: "FSC-A" }));
    await settle();
    expect([plotHarness.props!.payload.x_label, plotHarness.props!.payload.y_label]).toEqual(["FSC-A", "FSC-A"]);
    await tab("Scales");
    await setRange("FSC-A", [-750, 4250]);
    await tab("Gating");
    expect(range("x")).toEqual([-750, 4250]);
    expect(range("y")).toEqual([-750, 4250]);
    await transform(host.querySelector<HTMLSelectElement>('select[aria-label="X scatter scale"]')!, "arcsinh");
    expectArcsinhFit("x", 100);
    expectArcsinhFit("y", 100);
    expect(range("y")).toEqual(range("x"));
  });

  it("still fits both axes when Fit data + gates is requested explicitly", async () => {
    await loadFile();
    await tab("Scales");
    await setRange("FSC-A", [-750, 4250]);
    await setRange("SSC-A", [-400, 22000]);
    await tab("Gating");
    const fit = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Fit data + gates")!;
    expect(fit).toBeTruthy();
    act(() => fit.click());
    await settle();
    expect(range("x")).not.toEqual([-750, 4250]);
    expect(range("y")).not.toEqual([-400, 22000]);
    expect(range("x")[0]).toBeLessThan(100);
    expect(range("x")[1]).toBeGreaterThan(1000);
    expect(range("y")[0]).toBeLessThan(1000);
    expect(range("y")[1]).toBeGreaterThan(10000);
  });
});
