// @vitest-environment jsdom
//
// Workspace > Gating states…: the gating is saved under a name, restored later as one undo step,
// and the saved states go into the workspace file and come back with it.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import { readWorkspaceBytes } from "./engine/workspace";
import { GATING_STATES_FIELD, readGatingStates } from "./gatingStates";
import type { NewGate } from "./plots/GatingPlot";

interface CapturedPlotProps {
  payload: { gates: { gate_id: string; name: string }[] };
  onNewGate: (gate: NewGate) => void;
  onGateEdit: (gate: { gate_id: string; vertices: [number, number][] }) => void;
}
const plotHarness = vi.hoisted(() => ({ props: null as CapturedPlotProps | null }));
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
  return { ...actual, parseFcs: (buffer: ArrayBuffer) => syntheticFcs(new Uint8Array(buffer)[0]) };
});
vi.mock("./engine/workspaceHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/workspaceHistory")>();
  return {
    ...actual,
    listWorkspaceCheckpoints: vi.fn(async () => []),
    saveWorkspaceCheckpoint: vi.fn(async () => "saved"),
    requestPersistentWorkspaceHistory: vi.fn(async () => null),
  };
});

import App from "./App";
import { saveWorkspaceCheckpoint } from "./engine/workspaceHistory";

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
  for (const key of ["showOpenFilePicker", "showSaveFilePicker"]) delete (window as unknown as Record<string, unknown>)[key];
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
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button:not(.gl-menu-trigger)")].find((b) => b.textContent?.trim() === label)!;
const dialog = () => host.querySelector<HTMLElement>(".gl-modal-gating-states");
const stateRows = () => [...host.querySelectorAll<HTMLLabelElement>(".gl-modal-gating-states .gl-modal-history-list label")];
const stateNames = () => stateRows().map((row) => row.querySelector("strong")!.textContent);

/** A rectangle drawn on the plot, made a population of its own under the one shown. */
async function drawGate(vertices: [number, number][]): Promise<void> {
  act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices, x_channel: "FSC-A", y_channel: "SSC-A" }));
  const createPopulation = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .find((candidate) => candidate.parentElement?.textContent?.includes("Also create a population"))!;
  act(() => createPopulation.click());
  act(() => button("Create").click());
  await settle();
}
async function saveState(name: string): Promise<void> {
  const field = dialog()!.querySelector<HTMLInputElement>(".gl-gating-state-save input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, name);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => button("Save the current gating").click());
  await settle();
}

describe("Workspace > Gating states…", () => {
  it("saves the gating by name, restores it as one undo step, and writes the states into the workspace file", async () => {
    const written: unknown[] = [];
    const handle = {
      kind: "file",
      name: "analysis.gatelab",
      createWritable: async () => ({ write: async (chunk: unknown) => { written.push(chunk); }, close: async () => undefined }),
      getFile: async () => new File([], "analysis.gatelab"),
    } as unknown as FileSystemFileHandle;
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn() });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn(async () => handle) });
    const savedFile = () => {
      const chunk = written.at(-1) as Uint8Array | string;
      const { ws } = readWorkspaceBytes(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk as Uint8Array));
      return ws as unknown as { gating: { gates: Record<string, { vertices: [number, number][] }> } } & Record<string, unknown>;
    };

    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((candidate) => !candidate.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(input, "files", { configurable: true, value: [testFile("D1.fcs", 1), testFile("D2.fcs", 2)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();

    // One gate with its population, saved as "Tight gates".
    await drawGate([[0, 0], [1000, 1000]]);
    expect(host.querySelectorAll(".pop-row")).toHaveLength(2);
    const gateId = plotHarness.props!.payload.gates[0].gate_id;
    act(() => button("Gating states…").click());
    expect(dialog()!.textContent).toContain("No gating states saved yet in this workspace.");
    await saveState("Tight gates");
    expect(stateNames()).toEqual(["Tight gates · the gating as it is now"]);
    expect(stateRows()[0].querySelector("small")!.textContent).toBe("1 gates · 1 populations");
    act(() => button("Close").click());
    expect(dialog()).toBeNull();

    // The gate is moved and a second one drawn: the saved state is no longer the gating as it is.
    act(() => plotHarness.props!.onGateEdit({ gate_id: gateId, vertices: [[50, 50], [600, 600]] }));
    await settle();
    await drawGate([[10, 10], [400, 400]]);
    expect(host.querySelectorAll(".pop-row")).toHaveLength(3);
    act(() => button("Gating states…").click());
    expect(stateNames()).toEqual(["Tight gates"]);
    await saveState("");
    expect(stateNames()).toEqual(["Tight gates", "State 2 · the gating as it is now"]);

    // Restoring "Tight gates": the dialog closes, the gating is as it was saved, a checkpoint was kept.
    const checkpointsBefore = vi.mocked(saveWorkspaceCheckpoint).mock.calls.length;
    act(() => stateRows()[0].querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    act(() => button("Restore this state").click());
    await settle();
    expect(dialog()).toBeNull();
    expect(host.querySelectorAll(".pop-row")).toHaveLength(2);
    expect(plotHarness.props!.payload.gates.map((gate) => gate.gate_id)).toEqual([gateId]);
    expect(host.textContent).toContain('Gating state "Tight gates" restored.');
    expect(vi.mocked(saveWorkspaceCheckpoint).mock.calls.slice(checkpointsBefore).map((call) => call[2])).toContain("before-revert");

    // The file written now holds the restored gating and both saved states.
    await act(async () => { button("Save As…").click(); });
    for (let i = 0; i < 4; i++) await settle();
    let ws = savedFile();
    const states = readGatingStates(ws);
    expect(states.map((saved) => saved.name)).toEqual(["Tight gates", "State 2"]);
    expect((ws[GATING_STATES_FIELD] as unknown[]).length).toBe(2);
    expect(ws.gating.gates[gateId].vertices).toEqual((states[0].gating.gates[gateId] as unknown as { vertices: unknown }).vertices);
    expect(Object.keys(ws.gating.gates)).toEqual([gateId]);
    expect(Object.keys(states[1].gating.gates)).toHaveLength(2);
    expect(states[0].files).toHaveLength(2);

    // One Undo is the gating as it was before the restore: both gates, the first where it was moved to.
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); });
    await settle();
    expect(host.querySelectorAll(".pop-row")).toHaveLength(3);
    await act(async () => { button("Save As…").click(); });
    for (let i = 0; i < 4; i++) await settle();
    ws = savedFile();
    expect(ws.gating.gates).toEqual(states[1].gating.gates);
    expect(ws.gating.gates[gateId].vertices).not.toEqual((states[0].gating.gates[gateId] as unknown as { vertices: unknown }).vertices);
    // The saved states are not the gating's to undo.
    expect(readGatingStates(ws).map((saved) => saved.name)).toEqual(["Tight gates", "State 2"]);
  });

  it("starts a new workspace with no saved states", async () => {
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((candidate) => !candidate.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(input, "files", { configurable: true, value: [testFile("D1.fcs", 1)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    await drawGate([[0, 0], [1000, 1000]]);
    act(() => button("Gating states…").click());
    await saveState("Tight gates");
    expect(stateNames()).toHaveLength(1);
    act(() => button("Close").click());

    act(() => button("New Workspace…").click());
    await act(async () => { button("Start New Workspace").click(); });
    for (let i = 0; i < 3; i++) await settle();
    expect(host.querySelectorAll(".gl-sample-row")).toHaveLength(0);
    Object.defineProperty(input, "files", { configurable: true, value: [testFile("D2.fcs", 2)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    act(() => button("Gating states…").click());
    expect(stateRows()).toHaveLength(0);
  });

  it("opens a saved workspace with its states, and restores one of them", async () => {
    // No File System Access in jsdom: a portable copy is downloaded, and the download is kept here.
    let download: Blob | null = null;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (blob: Blob) => { download = blob; return "blob:saved"; } });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });

    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((candidate) => !candidate.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(input, "files", { configurable: true, value: [testFile("D1.fcs", 1)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    await drawGate([[0, 0], [1000, 1000]]);
    const gateId = plotHarness.props!.payload.gates[0].gate_id;
    act(() => button("Gating states…").click());
    await saveState("Tight gates");
    act(() => button("Close").click());
    await drawGate([[10, 10], [400, 400]]);
    expect(host.querySelectorAll(".pop-row")).toHaveLength(3);

    act(() => button("Save Portable Copy…").click());
    for (let i = 0; i < 6; i++) await settle();
    expect(download).not.toBeNull();
    const bundle = new Uint8Array(await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(download!);
    }));

    // The copy opened in a new workspace: the gating as it was saved, and the state with it.
    act(() => button("New Workspace…").click());
    await act(async () => { button("Start New Workspace").click(); });
    for (let i = 0; i < 3; i++) await settle();
    expect(host.querySelectorAll(".gl-sample-row")).toHaveLength(0);
    const copy = new File([bundle], "copy.gatelab", { type: "application/octet-stream" });
    Object.defineProperty(copy, "arrayBuffer", { value: async () => bundle.slice().buffer });
    // A bundle is read as a stream, which jsdom's File does not have.
    Object.defineProperty(copy, "stream", { value: () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bundle.slice()); c.close(); } }) });
    const open = host.querySelector<HTMLInputElement>('input[accept=".gatelab,.wsp,.flowjo,.cef"]')!;
    Object.defineProperty(open, "files", { configurable: true, value: [copy] });
    await act(async () => { open.dispatchEvent(new Event("change", { bubbles: true })); });
    for (let i = 0; i < 6; i++) await settle();
    expect(host.querySelectorAll(".gl-sample-row")).toHaveLength(1);
    expect(host.querySelectorAll(".pop-row")).toHaveLength(3);

    act(() => button("Gating states…").click());
    expect(stateNames()).toEqual(["Tight gates"]);
    act(() => stateRows()[0].querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    act(() => button("Restore this state").click());
    await settle();
    expect(host.querySelectorAll(".pop-row")).toHaveLength(2);
    expect(plotHarness.props!.payload.gates.map((gate) => gate.gate_id)).toEqual([gateId]);
    // The state is now the gating as it is, and one Undo is the gating the copy was opened with.
    act(() => button("Gating states…").click());
    expect(stateNames()).toEqual(["Tight gates · the gating as it is now"]);
    act(() => button("Close").click());
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); });
    await settle();
    expect(host.querySelectorAll(".pop-row")).toHaveLength(3);
  });
});
