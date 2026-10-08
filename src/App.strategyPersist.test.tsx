// @vitest-environment jsdom
//
// The Strategy tab's settings go into the workspace file and come back with it: before 2026-10-09
// a saved workspace held nothing of the strategy, and the tab opened on its defaults.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import { readWorkspaceBytes } from "./engine/workspace";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => null,
}));
// The strategy renderer stands in for mini_plot; this test is about what the file holds.
vi.mock("./plots/loadPlots", () => ({
  loadMiniPlots: () => ({ renderStrategyGrid: vi.fn(), renderMultiStrategyGrid: vi.fn(), renderIllustrationGrid: vi.fn() }),
  loadPlots: () => ({ CytofD3: {}, bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }),
}));
const syntheticFcs: FcsFile = {
  version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {},
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
  ],
  columns: [Float32Array.from([10, 20, 30]), Float32Array.from([100, 200, 300])],
  spillover: null,
};
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => syntheticFcs };
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

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  uuid = 0;
  for (const key of ["showOpenFilePicker", "showSaveFilePicker"]) delete (window as unknown as Record<string, unknown>)[key];
});

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!;
const labelled = (text: string) => [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.trim().startsWith(text))!;

describe("the Strategy tab's settings in the workspace file", () => {
  it("saves the mode, the layout and the appearance, and the tab reads them back", async () => {
    const written: unknown[] = [];
    const handle = {
      kind: "file",
      name: "analysis.gatelab",
      createWritable: async () => ({ write: async (chunk: unknown) => { written.push(chunk); }, close: async () => undefined }),
      getFile: async () => new File([], "analysis.gatelab"),
    } as unknown as FileSystemFileHandle;
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn() });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn(async () => handle) });
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find((i) => !i.hasAttribute("webkitdirectory"))!;
    const bytes = Uint8Array.from([1]);
    const file = new File([bytes], "D1.fcs");
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    for (let i = 0; i < 3; i++) await settle();

    // Strategy tab: Multiple pops, Wrapped, bold labels.
    await act(async () => { button("Strategy").click(); });
    await settle();
    await act(async () => { labelled("Multiple pops").querySelector("input")!.click(); });
    const layout = labelled("Layout").querySelector("select")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(layout, "flow");
      layout.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { labelled("Bold gate labels").querySelector("input")!.click(); });
    await settle();

    await act(async () => { button("Save As…").click(); });
    for (let i = 0; i < 4; i++) await settle();
    expect(written.length).toBeGreaterThan(0);
    const chunk = written[0] as Uint8Array | string;
    const saved = readWorkspaceBytes(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk as Uint8Array));
    const strategy = (saved.ws as { strategy?: Record<string, unknown> }).strategy;
    expect(strategy).toBeTruthy();
    expect(strategy).toMatchObject({ mode: "multi", layout: "flow", gateLabelBold: true, showArrows: true, pointSize: 1.2 });
  });
});
