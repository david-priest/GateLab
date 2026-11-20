// @vitest-environment jsdom
//
// The Gating tab with more than one plot: a plot is added and removed from the tab, a click on a
// plot selects it, the tree and the axis pickers change the selected plot alone, and a gate drawn
// on one plot is on every plot that shows its channels.
// Synthetic file D1 with channels FSC-A, SSC-A and B1-A.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import type { NewGate } from "./plots/GatingPlot";

interface CapturedPlotProps {
  instance?: number;
  passive?: boolean;
  payload: { gates: { gate_id: string; name: string }[]; x_label: string; y_label: string; n_events: number; selected_gate_id?: string | null } | null;
  onNewGate?: (gate: NewGate) => void;
  onGateSelect?: (gateId: string) => void;
  onGateDeselect?: () => void;
  onAxisLabelClick?: (event: { axis: "x" | "y"; selected: string }) => void;
}
const plotHarness = vi.hoisted(() => ({ props: new Map<number, CapturedPlotProps>() }));
vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: CapturedPlotProps) => {
    plotHarness.props.set(props.instance ?? 0, props);
    return <div data-testid="gating-plot" data-instance={props.instance ?? 0} />;
  },
}));

const EVENTS = 8;
function syntheticFcs(): FcsFile {
  return {
    version: "FCS3.1",
    nEvents: EVENTS,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      { index: 2, name: "B1-A", marker: null, bits: 32, range: 262144 },
    ],
    // FSC-A 100, 200, ... 800: a gate up to 450 holds four events.
    columns: [
      Float32Array.from({ length: EVENTS }, (_, index) => 100 * (index + 1)),
      Float32Array.from({ length: EVENTS }, (_, index) => 100 * (index + 1) + 10),
      Float32Array.from({ length: EVENTS }, (_, index) => 1000 + index),
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
  plotHarness.props.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  plotHarness.props.clear();
  uuid = 0;
});

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

async function openFile(): Promise<void> {
  act(() => root.render(<App />));
  const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
    .find((candidate) => !candidate.hasAttribute("webkitdirectory"))!;
  const bytes = Uint8Array.from([1]);
  const file = new File([bytes], "D1.fcs", { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(host.querySelectorAll(".gl-sample-row")).toHaveLength(1);
}

const selected = () => plotHarness.props.get(0)!;
const other = (instance: number) => plotHarness.props.get(instance)!;
const addButton = () => host.querySelector<HTMLButtonElement>("button[data-plot-add]")!;
const plotCount = () => host.querySelectorAll('[data-testid="gating-plot"]').length;
const selectedNumber = () => host.querySelector(".gl-plot-area")!.getAttribute("data-plot-number");
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!;

async function addPlot(): Promise<void> {
  act(() => addButton().click());
  await settle();
}

/** A rectangle on FSC-A and SSC-A holding the four events with FSC-A up to 450, as a gate and its population. */
async function drawGateWithPopulation(): Promise<void> {
  act(() => selected().onNewGate!({ gate_type: "rectangle", vertices: [[0, 0], [450, 100000]], x_channel: "FSC-A", y_channel: "SSC-A" }));
  const createPopulation = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .find((candidate) => candidate.parentElement?.textContent?.includes("Also create a population"))!;
  if (!createPopulation.checked) act(() => createPopulation.click());
  act(() => button("Create").click());
  await settle();
}
const populationRow = (root: boolean) =>
  [...host.querySelectorAll<HTMLElement>(".pop-row")].find((candidate) => candidate.textContent!.includes("All Events") === root)!;

describe("Gating tab with one plot", () => {
  it("is as it was: one plot, nothing to remove, and a button to add another", async () => {
    await openFile();
    expect(plotCount()).toBe(1);
    expect(host.querySelector(".gl-plot-grid")!.classList.contains("is-multi")).toBe(false);
    expect(host.querySelector(".gl-plot-remove")).toBeNull();
    expect(host.querySelector(".gl-plot-peer")).toBeNull();
    expect(selectedNumber()).toBeNull();
    expect(addButton().disabled).toBe(false);
    expect(addButton().getAttribute("aria-label")).toBe("Add a plot");
  });
});

describe("Gating tab with several plots", () => {
  it("adds a plot showing what the selected one shows, and selects the new one", async () => {
    await openFile();
    await addPlot();
    expect(plotCount()).toBe(2);
    expect(host.querySelector(".gl-plot-grid")!.classList.contains("is-multi")).toBe(true);
    expect(selectedNumber()).toBe("2");
    expect(other(1).passive).toBe(true);
    expect(other(1).payload!.x_label).toBe(selected().payload!.x_label);
    expect(other(1).payload!.y_label).toBe(selected().payload!.y_label);
    expect(other(1).payload!.n_events).toBe(EVENTS);
    expect(host.querySelectorAll(".gl-plot-remove")).toHaveLength(2);
  });

  it("stops at four plots", async () => {
    await openFile();
    await addPlot();
    await addPlot();
    await addPlot();
    expect(plotCount()).toBe(4);
    expect(addButton().disabled).toBe(true);
    expect([0, 1, 2, 3].every((instance) => plotHarness.props.has(instance))).toBe(true);
  });

  it("changes the channels of the selected plot alone", async () => {
    await openFile();
    await addPlot();
    act(() => selected().onAxisLabelClick!({ axis: "x", selected: "B1-A" }));
    await settle();
    expect(selected().payload!.x_label).toBe("B1-A");
    expect(other(1).payload!.x_label).toBe("FSC-A");
  });

  it("selects a plot on a click, and each plot keeps what it showed", async () => {
    await openFile();
    await addPlot();
    act(() => selected().onAxisLabelClick!({ axis: "x", selected: "B1-A" }));
    await settle();
    // Plot 1 is the other plot; a click on it makes it the selected plot.
    act(() => host.querySelector<HTMLButtonElement>(".gl-plot-peer-select")!.click());
    await settle();
    expect(selectedNumber()).toBe("1");
    expect(selected().payload!.x_label).toBe("FSC-A");
    // Plot 2 draws with the engine instance it was made with.
    expect(other(2).payload!.x_label).toBe("B1-A");
    expect(host.querySelector(".gl-plot-peer")!.getAttribute("data-plot-number")).toBe("2");
  });

  it("does not build or draw again a plot that a change of selection leaves as it was", async () => {
    await openFile();
    await addPlot();
    await addPlot();
    // Plots 1 and 2 are the others (instances 1 and 2); plot 3 is selected.
    const untouched = other(1).payload;
    expect(untouched).not.toBeNull();
    const peers = [...host.querySelectorAll<HTMLElement>(".gl-plot-peer")];
    const plot2 = peers.find((peer) => peer.getAttribute("data-plot-number") === "2")!;
    act(() => plot2.querySelector<HTMLButtonElement>(".gl-plot-peer-select")!.click());
    await settle();
    expect(selectedNumber()).toBe("2");
    // Plot 1 keeps its engine instance and the very object it drew; plot 3 takes the instance it was made with.
    expect(other(1).payload).toBe(untouched);
    expect(other(3).passive).toBe(true);
    expect(other(3).payload!.x_label).toBe("FSC-A");
  });

  it("draws every gate on the other plots' channels by default, and their branch's alone when that is unchecked", async () => {
    await openFile();
    // Two sibling gates under All Events, each with its population.
    await drawGateWithPopulation();
    act(() => populationRow(true).click());
    await settle();
    act(() => selected().onNewGate!({ gate_type: "rectangle", vertices: [[500, 0], [900, 100000]], x_channel: "FSC-A", y_channel: "SSC-A" }));
    const createPopulation = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((candidate) => candidate.parentElement?.textContent?.includes("Also create a population"))!;
    if (!createPopulation.checked) act(() => createPopulation.click());
    act(() => button("Create").click());
    await settle();
    const firstPopulation = [...host.querySelectorAll<HTMLElement>(".pop-row")].filter((row) => !row.textContent!.includes("All Events"))[0];
    act(() => firstPopulation.click());
    await settle();
    await addPlot();
    // Checked (the default), the other plot draws both gates on its channels.
    const option = host.querySelector<HTMLInputElement>("input.gl-plot-shows-others")!;
    expect(option.checked).toBe(true);
    expect(other(1).payload!.gates).toHaveLength(2);
    // Unchecked, it draws what the selected plot draws for the same view, under the branch rule.
    act(() => option.click());
    await settle();
    expect(other(1).payload!.gates.map((gate) => gate.gate_id)).toEqual(selected().payload!.gates.map((gate) => gate.gate_id));
  });

  it("keeps each plot's selected gate when another plot is selected", async () => {
    await openFile();
    await drawGateWithPopulation();
    act(() => populationRow(true).click());
    await settle();
    act(() => selected().onGateDeselect!());
    await settle();
    expect(selected().payload!.selected_gate_id ?? null).toBeNull();
    await addPlot();
    const gateId = selected().payload!.gates[0].gate_id;
    // Plot 2, selected, selects the gate; plot 1 has none selected.
    act(() => selected().onGateSelect!(gateId));
    await settle();
    expect(selected().payload!.selected_gate_id).toBe(gateId);
    act(() => host.querySelector<HTMLButtonElement>(".gl-plot-peer-select")!.click());
    await settle();
    expect(selectedNumber()).toBe("1");
    expect(selected().payload!.selected_gate_id ?? null).toBeNull();
    // Plot 2 still draws its gate selected, and has it selected again when it is selected.
    expect(other(2).payload!.selected_gate_id).toBe(gateId);
    act(() => host.querySelector<HTMLButtonElement>(".gl-plot-peer-select")!.click());
    await settle();
    expect(selectedNumber()).toBe("2");
    expect(selected().payload!.selected_gate_id).toBe(gateId);
  });

  it("shows a gate drawn on one plot on every plot with its channels, and its population where one shows it", async () => {
    await openFile();
    await addPlot();
    await drawGateWithPopulation();
    // The selected plot went to the new population, as one plot always has; the other stays on all events.
    expect(selected().payload!.n_events).toBe(4);
    expect(selected().payload!.gates).toHaveLength(1);
    expect(other(1).payload!.n_events).toBe(EVENTS);
    expect(other(1).payload!.gates.map((gate) => gate.gate_id)).toEqual(selected().payload!.gates.map((gate) => gate.gate_id));
    // Each plot carries the name of the population it shows.
    expect(host.querySelector(".gl-plot-peer .gl-plot-peer-name")!.textContent).toBe("All Events");
    expect(host.querySelector(".gl-plot-area > .gl-plot-peer-name")!.textContent).toBe(populationRow(false).querySelector(".pop-row-name")!.textContent);
  });

  it("gives a click in the population tree to the selected plot alone", async () => {
    await openFile();
    await addPlot();
    await drawGateWithPopulation();
    act(() => populationRow(true).click());
    await settle();
    expect(selected().payload!.n_events).toBe(EVENTS);
    // Plot 1, selected next, still shows all events; plot 2 keeps all events too, as it was left.
    act(() => host.querySelector<HTMLButtonElement>(".gl-plot-peer-select")!.click());
    await settle();
    act(() => populationRow(false).click());
    await settle();
    expect(selectedNumber()).toBe("1");
    expect(selected().payload!.n_events).toBe(4);
    expect(other(1).payload!.n_events).toBe(EVENTS);
  });

  it("removes a plot, the selected one included, down to the one plot there always is", async () => {
    await openFile();
    await addPlot();
    act(() => selected().onAxisLabelClick!({ axis: "x", selected: "B1-A" }));
    await settle();
    // The selected plot (2) removed: plot 1 is selected, with its own channels.
    act(() => host.querySelector<HTMLButtonElement>(".gl-plot-area > .gl-plot-remove")!.click());
    await settle();
    expect(plotCount()).toBe(1);
    expect(host.querySelector(".gl-plot-grid")!.classList.contains("is-multi")).toBe(false);
    expect(host.querySelector(".gl-plot-remove")).toBeNull();
    expect(selected().payload!.x_label).toBe("FSC-A");

    await addPlot();
    act(() => host.querySelector<HTMLButtonElement>(".gl-plot-peer .gl-plot-remove")!.click());
    await settle();
    expect(plotCount()).toBe(1);
    expect(selected().payload!.x_label).toBe("FSC-A");
  });
});
