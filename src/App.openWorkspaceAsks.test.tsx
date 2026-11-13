// @vitest-environment jsdom

// A .gatelab workspace chosen while the open one has unsaved changes replaced it without a word,
// from Open Workspace, the recent list and "Open the demo workspace" (2026-11-12). The reader of
// the chosen file is a stand-in that only records that it was reached.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));

const syntheticFcs: FcsFile = {
  version: "FCS3.1",
  nEvents: 3,
  instrument: "flow",
  keywords: {},
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
  ],
  columns: [
    Float32Array.from([100, 200, 300]),
    Float32Array.from([150, 250, 350]),
  ],
  spillover: null,
};

vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => syntheticFcs };
});

const READ_REACHED = "stand-in reader reached";
const readChosen = vi.fn(async (_file: File) => { throw new Error(READ_REACHED); });
vi.mock("./engine/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/workspace")>();
  return { ...actual, readWorkspaceEnvelopeFromFile: (file: File) => readChosen(file) };
});

import App from "./App";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" });
  readChosen.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
});
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);

async function feed(selector: string, file: File) {
  const input = [...host.querySelectorAll<HTMLInputElement>(selector)].find((el) => !el.hasAttribute("webkitdirectory"))!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle();
}

/** One synthetic file added to an empty workspace: a workspace with changes no file holds. */
async function loadFcs() {
  const file = new File([Uint8Array.from([70, 67, 83])], "test.fcs", { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => Uint8Array.from([70, 67, 83]).buffer });
  await feed('input[type="file"][accept=".fcs"]', file);
  expect(host.textContent).toContain("test.fcs");
}

const chooseWorkspace = () => feed('input[accept=".gatelab,.wsp,.flowjo,.cef"]', new File(["{}"], "other.gatelab"));

describe("opening a workspace over unsaved changes", () => {
  it("reads the chosen workspace at once when nothing is open", async () => {
    act(() => root.render(<App />));
    await chooseWorkspace();

    expect(host.textContent).not.toContain("Open another workspace?");
    expect(readChosen).toHaveBeenCalledTimes(1);
  });

  // A workspace opened straight after another, with nothing done between, is the second open of
  // App.workspaceRelink.test.tsx: restoring the axes marks it changed, and it is not asked about.
  it("does not ask once the open workspace has been saved", async () => {
    act(() => root.render(<App />));
    await loadFcs();
    vi.stubGlobal("showOpenFilePicker", vi.fn());
    vi.stubGlobal("showSaveFilePicker", vi.fn(async () => ({
      kind: "file",
      name: "kept.gatelab",
      getFile: async () => new File([], "kept.gatelab"),
      createWritable: async () => ({ write: async () => undefined, close: async () => undefined, abort: async () => undefined }),
      queryPermission: async () => "granted",
      requestPermission: async () => "granted",
      isSameEntry: async () => false,
    })));
    await act(async () => button("Save…")!.click());
    await settle();
    expect(host.textContent).toContain("Saved · kept.gatelab");

    await chooseWorkspace();
    expect(host.textContent).not.toContain("Open another workspace?");
    expect(readChosen).toHaveBeenCalledTimes(1);
  });

  it("asks first, and Cancel leaves the open workspace as it was", async () => {
    act(() => root.render(<App />));
    await loadFcs();
    await chooseWorkspace();

    expect(host.textContent).toContain("Open another workspace?");
    expect(host.textContent).toContain("Opening other.gatelab closes the current samples");
    expect(readChosen).not.toHaveBeenCalled();

    await act(async () => button("Cancel")!.click());
    await settle();

    expect(host.textContent).not.toContain("Open another workspace?");
    expect(host.textContent).toContain("test.fcs");
    expect(readChosen).not.toHaveBeenCalled();
  });

  it("reads the chosen workspace on Open Without Saving", async () => {
    act(() => root.render(<App />));
    await loadFcs();
    await chooseWorkspace();

    await act(async () => button("Open Without Saving")!.click());
    await settle();

    expect(host.textContent).not.toContain("Open another workspace?");
    expect(readChosen).toHaveBeenCalledTimes(1);
    expect(readChosen.mock.calls[0][0].name).toBe("other.gatelab");
    expect(host.textContent).toContain(READ_REACHED);
  });

  it("on Save first, reads the chosen workspace once the open one is written", async () => {
    const written: unknown[] = [];
    vi.stubGlobal("showOpenFilePicker", vi.fn());
    vi.stubGlobal("showSaveFilePicker", vi.fn(async () => ({
      kind: "file",
      name: "kept.gatelab",
      getFile: async () => new File([], "kept.gatelab"),
      createWritable: async () => ({ write: async (chunk: unknown) => { written.push(chunk); }, close: async () => undefined, abort: async () => undefined }),
      queryPermission: async () => "granted",
      requestPermission: async () => "granted",
      isSameEntry: async () => false,
    })));
    act(() => root.render(<App />));
    await loadFcs();
    await chooseWorkspace();

    await act(async () => button("Save first")!.click());
    await settle();

    expect(written.length).toBeGreaterThan(0);
    expect(readChosen).toHaveBeenCalledTimes(1);
  });

  it("on Save first, keeps the open workspace when the save dialog is cancelled", async () => {
    vi.stubGlobal("showOpenFilePicker", vi.fn());
    vi.stubGlobal("showSaveFilePicker", vi.fn(async () => { throw new DOMException("cancelled", "AbortError"); }));
    act(() => root.render(<App />));
    await loadFcs();
    await chooseWorkspace();

    await act(async () => button("Save first")!.click());
    await settle();

    expect(host.textContent).not.toContain("Open another workspace?");
    expect(host.textContent).toContain("test.fcs");
    expect(readChosen).not.toHaveBeenCalled();
  });
});
