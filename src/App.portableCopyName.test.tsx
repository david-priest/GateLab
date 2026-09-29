// @vitest-environment jsdom
// Save Portable Copy suggests "<workspace>-bundle.gatelab" in the save dialog, and the user can
// save under any name there. The status line said the suggested name whatever was chosen (the
// release candidate's browser verifier; master the same), so it named a file that did not exist.
// Synthetic file D1.fcs throughout.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => null,
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

describe("Save Portable Copy", () => {
  it("names the file the user chose in the save dialog, not the name it suggested", async () => {
    const written: unknown[] = [];
    const suggested: string[] = [];
    const handle = {
      kind: "file",
      name: "chosen copy.gatelab",
      createWritable: async () => ({ write: async (chunk: unknown) => { written.push(chunk); }, close: async () => undefined }),
      getFile: async () => new File([], "chosen copy.gatelab"),
    } as unknown as FileSystemFileHandle;
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn() });
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: vi.fn(async (options: { suggestedName: string }) => { suggested.push(options.suggestedName); return handle; }),
    });
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find((i) => !i.hasAttribute("webkitdirectory"))!;
    const bytes = Uint8Array.from([1]);
    const file = new File([bytes], "D1.fcs");
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    for (let i = 0; i < 3; i++) await settle();

    const save = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Save Portable Copy…")!;
    expect(save).toBeTruthy();
    await act(async () => { save.click(); });
    for (let i = 0; i < 4; i++) await settle();
    expect(suggested).toEqual(["D1-bundle.gatelab"]);
    expect(written.length).toBeGreaterThan(0);
    expect(host.textContent).toContain("Saved portable bundle · chosen copy.gatelab");
    expect(host.textContent).not.toContain("D1-bundle.gatelab");
  });
});
