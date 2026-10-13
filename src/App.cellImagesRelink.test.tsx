// @vitest-environment jsdom

// A workspace that linked cell images finds them again: beside the FCS in the folder chosen to
// relink it, or through the handle remembered when they were attached; and says so when it
// cannot, without losing the FCS.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import type { WorkspaceFile } from "./engine/workspace";
import { buildSyntheticCvw } from "./imaging/cvwFixture";
import { memoryFile } from "./testDirectory";

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
  columns: [Float32Array.from([100, 200, 300]), Float32Array.from([150, 250, 350])],
  spillover: null,
};

vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => syntheticFcs, readFcsFileKeywords: async () => null };
});

vi.mock("./engine/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/workspace")>();
  return { ...actual, readWorkspaceEnvelopeFromFile: vi.fn() };
});

const remembered = vi.hoisted(() => ({ handles: new Map<string, FileSystemFileHandle>() }));
vi.mock("./engine/fsAccess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fsAccess")>();
  return {
    ...actual,
    rememberHandle: vi.fn(async (key: string, handle: FileSystemFileHandle) => { remembered.handles.set(key, handle); }),
    recallHandle: vi.fn(async (key: string) => remembered.handles.get(key) ?? null),
    readFromHandleIfPermitted: vi.fn(async () => null),
  };
});

import App from "./App";
import { readWorkspaceEnvelopeFromFile } from "./engine/workspace";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  remembered.handles.clear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  uuid = 0;
  for (const key of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"]) {
    delete (window as unknown as Record<string, unknown>)[key];
  }
});

const cvwBytes = (events: number, recordingId: string) =>
  buildSyntheticCvw(Array.from({ length: events }, () => ({ samples: 256 })), { recordingId });

function fcsHandle(name: string): FileSystemFileHandle {
  const bytes = Uint8Array.from([70, 67, 83]);
  return {
    kind: "file",
    name,
    getFile: vi.fn(async () => memoryFile(name, bytes)),
    queryPermission: vi.fn(async () => "granted"),
    requestPermission: vi.fn(async () => "granted"),
  } as unknown as FileSystemFileHandle;
}

function cvwHandle(name: string, events = 3, recordingId = "rec-a"): FileSystemFileHandle {
  return {
    kind: "file",
    name,
    getFile: vi.fn(async () => memoryFile(name, cvwBytes(events, recordingId))),
    queryPermission: vi.fn(async () => "granted"),
    requestPermission: vi.fn(async () => "granted"),
  } as unknown as FileSystemFileHandle;
}

function workspaceLinkingImages(): WorkspaceFile {
  return {
    format: "gatelab-workspace",
    version: 2,
    workspaceId: "workspace-images-test",
    savedAt: "2026-10-13T00:00:00.000Z",
    app: "GateLab",
    samples: [{
      fileName: "D1.fcs",
      dataPath: "data/0_D1.fcs",
      logicleW: {},
      compensationOn: false,
      images: [{ kind: "cvw", fileName: "D1.cvw", eventCount: 3, recordingId: "rec-a" }],
    }],
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
  };
}

function installPickers(folderFiles: readonly FileSystemFileHandle[]) {
  const workspaceHandle = { kind: "file", name: "analysis.gatelab", getFile: vi.fn(async () => new File([], "analysis.gatelab")) } as unknown as FileSystemFileHandle;
  const folderHandle = {
    kind: "directory",
    name: "flow-data",
    async *values() { for (const handle of folderFiles) yield handle; },
  } as unknown as FileSystemDirectoryHandle;
  const showDirectoryPicker = vi.fn().mockResolvedValue(folderHandle);
  Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn().mockResolvedValue([workspaceHandle]) });
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: showDirectoryPicker });
  return { showDirectoryPicker };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

async function click(label: string): Promise<void> {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
  expect(button, label).toBeTruthy();
  await act(async () => { button!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  for (let i = 0; i < 3; i++) await settle();
}

const imagesBadge = () => host.querySelector<HTMLElement>(".gl-sample-images");

describe("cell images on reopening a workspace", () => {
  it("attaches the waveform file found beside the FCS in the folder chosen to relink it", async () => {
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspaceLinkingImages(), fcsByPath: null, storage: "reference", portableAssays: null,
    });
    const cvw = cvwHandle("D1.cvw");
    installPickers([fcsHandle("D1.fcs"), cvw, fcsHandle("other.fcs")]);
    act(() => root.render(<App />));
    await click("Open Workspace…");
    expect(host.textContent).toContain("Locate linked FCS files");
    await click("Choose FCS folder…");
    expect(imagesBadge()).toBeTruthy();
    expect(imagesBadge()!.title).toContain("D1.cvw");
    expect(remembered.handles.get("cvw:D1.fcs")).toBe(cvw);
    expect(host.textContent).not.toContain("cell images not attached");
  });

  it("finds the waveform file through the remembered handle when the FCS is in the bundle", async () => {
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspaceLinkingImages(), fcsByPath: { "data/0_D1.fcs": Uint8Array.from([70, 67, 83]) }, storage: "bundle", portableAssays: null,
    });
    remembered.handles.set("cvw:D1.fcs", cvwHandle("D1.cvw"));
    const { showDirectoryPicker } = installPickers([]);
    act(() => root.render(<App />));
    await click("Open Workspace…");
    expect(imagesBadge()).toBeTruthy();
    expect(showDirectoryPicker).not.toHaveBeenCalled();
  });

  it("refuses a remembered file of another recording, keeps the FCS, and says why", async () => {
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspaceLinkingImages(), fcsByPath: { "data/0_D1.fcs": Uint8Array.from([70, 67, 83]) }, storage: "bundle", portableAssays: null,
    });
    remembered.handles.set("cvw:D1.fcs", cvwHandle("D1.cvw", 3, "rec-b"));
    installPickers([]);
    act(() => root.render(<App />));
    await click("Open Workspace…");
    expect(imagesBadge()).toBeNull();
    expect(host.textContent).toContain("D1.fcs");
    expect(host.textContent).toContain("another recording");
  });

  it("notes a waveform file it cannot find and opens the FCS without it", async () => {
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspaceLinkingImages(), fcsByPath: null, storage: "reference", portableAssays: null,
    });
    installPickers([fcsHandle("D1.fcs")]);
    act(() => root.render(<App />));
    await click("Open Workspace…");
    await click("Choose FCS folder…");
    expect(imagesBadge()).toBeNull();
    expect(host.querySelectorAll('[role="option"]').length).toBe(1);
    expect(host.textContent).toContain("were not found");
  });
});
