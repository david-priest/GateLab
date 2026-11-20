// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));

vi.mock("./engine/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/workspace")>();
  return { ...actual, readWorkspaceEnvelopeFromFile: vi.fn(actual.readWorkspaceEnvelopeFromFile) };
});

import App from "./App";
import { readWorkspaceEnvelopeFromFile, type WorkspaceFile } from "./engine/workspace";

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

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("App New Workspace", () => {
  it("clears the complete loaded workspace after explicit confirmation", async () => {
    act(() => root.render(<App />));
    const newWorkspaceButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "New Workspace…")!;
    expect(newWorkspaceButton().disabled).toBe(true);

    const input = host.querySelector<HTMLInputElement>('input[type="file"][accept=".fcs"]')!;
    const file = new File([Uint8Array.from([70, 67, 83])], "test.fcs", {
      type: "application/octet-stream",
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => Uint8Array.from([70, 67, 83]).buffer,
    });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain("test.fcs");
    expect(newWorkspaceButton().disabled).toBe(false);
    act(() => newWorkspaceButton().click());
    expect(host.textContent).toContain("Start a new workspace?");
    expect(host.textContent).toContain("local recovery checkpoint");

    const confirm = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Start New Workspace")!;
    await act(async () => {
      confirm.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // An empty file list offers the one thing to do.
    expect(host.querySelector(".gl-sample-empty")?.textContent).toContain("+ Add files…");
    expect(host.textContent).toContain("Open an FCS file or a workspace to begin.");
    expect(host.textContent).toContain("New workspace ready · add an FCS file to begin.");
    expect(host.textContent).not.toContain("test.fcs");
    expect(newWorkspaceButton().disabled).toBe(true);
  });

  /** The app with one synthetic file loaded and New Workspace's question open. */
  async function openNewWorkspaceQuestion() {
    act(() => root.render(<App />));
    const input = host.querySelector<HTMLInputElement>('input[type="file"][accept=".fcs"]')!;
    const file = new File([Uint8Array.from([70, 67, 83])], "test.fcs", { type: "application/octet-stream" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => Uint8Array.from([70, 67, 83]).buffer });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain("test.fcs");
    const newWorkspace = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "New Workspace…")!;
    act(() => newWorkspace.click());
    expect(host.textContent).toContain("Start a new workspace?");
  }
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
  const settle = () => act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("offers Save first, and starts the new workspace once the old one is written", async () => {
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
    await openNewWorkspaceQuestion();
    expect(button("Save first")).toBeDefined();

    await act(async () => button("Save first")!.click());
    await settle();

    expect(written.length).toBeGreaterThan(0);
    expect(host.textContent).not.toContain("test.fcs");
    expect(host.textContent).toContain("Open an FCS file or a workspace to begin.");
  });

  it("keeps the workspace open, and says so, when Save first can only download it", async () => {
    // No save dialog, as in a browser without the File System Access API: the workspace downloads.
    const downloads: string[] = [];
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: () => "blob:test", revokeObjectURL: () => undefined }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    try {
      await openNewWorkspaceQuestion();
      await act(async () => button("Save first")!.click());
      await settle();
    } finally {
      click.mockRestore();
    }

    expect(downloads).toEqual(["test.gatelab"]);
    expect(host.textContent).toContain("test.fcs");
    expect(host.textContent).toContain("Downloaded test.gatelab. The workspace is not marked saved.");
  });

  it("names the download after the workspace file it was opened from", async () => {
    const workspace = {
      format: "gatelab-workspace",
      version: 2,
      workspaceId: "workspace-download-name",
      savedAt: "2026-10-13T00:00:00.000Z",
      app: "GateLab",
      samples: [{ fileName: "Sample 1.fcs", dataPath: "data/0_Sample 1.fcs", logicleW: {}, compensationOn: false }],
      activeSample: 0,
      gating: {
        gates: {},
        gate_order: [],
        populations: {
          root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: [], event_count: null, percent_of_parent: 100 },
        },
        root_population_id: "root",
        active_population_id: "root",
        selected_gate_id: null,
      },
      scales: { globalScales: {} },
      display: { xChannel: "FSC-A", yChannel: "SSC-A", mode: "pseudocolor", maxEvents: 50000, contourThreshold: 5 },
    } as WorkspaceFile;
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValueOnce({
      raw: workspace, fcsByPath: { "data/0_Sample 1.fcs": Uint8Array.from([70, 67, 83]) }, storage: "bundle", portableAssays: null,
    });
    const downloads: string[] = [];
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: () => "blob:test", revokeObjectURL: () => undefined }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    try {
      act(() => root.render(<App />));
      const input = host.querySelector<HTMLInputElement>('input[type="file"][accept^=".gatelab"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [new File([], "Study workspace.gatelab")] });
      await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
      expect(host.textContent).toContain("Sample 1.fcs");
      act(() => button("New Workspace…")!.click());
      await act(async () => button("Save first")!.click());
      await settle();
    } finally {
      click.mockRestore();
    }

    expect(downloads).toEqual(["Study_workspace.gatelab"]);
  });

  it("keeps the workspace open when Save first's dialog is cancelled", async () => {
    vi.stubGlobal("showOpenFilePicker", vi.fn());
    vi.stubGlobal("showSaveFilePicker", vi.fn(async () => { throw new DOMException("cancelled", "AbortError"); }));
    await openNewWorkspaceQuestion();

    await act(async () => button("Save first")!.click());
    await settle();

    expect(host.textContent).not.toContain("Start a new workspace?");
    expect(host.textContent).toContain("test.fcs");
    expect(host.textContent).not.toContain("Open an FCS file or a workspace to begin.");
  });
});
