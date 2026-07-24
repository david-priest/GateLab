// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import type { WorkspaceFile } from "./engine/workspace";

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

vi.mock("./engine/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/workspace")>();
  return {
    ...actual,
    readWorkspaceEnvelopeFromFile: vi.fn(),
  };
});

import App from "./App";
import { readWorkspaceEnvelopeFromFile } from "./engine/workspace";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", {
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  });
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
});

function referenceWorkspace(): WorkspaceFile {
  return {
    format: "gatelab-workspace",
    version: 2,
    workspaceId: "workspace-relink-test",
    savedAt: "2026-07-24T00:00:00.000Z",
    app: "GateLab",
    samples: [
      {
        fileName: "donor-a.fcs",
        dataPath: "data/0_donor-a.fcs",
        logicleW: {},
        compensationOn: false,
      },
      {
        fileName: "donor-b.fcs",
        dataPath: "data/1_donor-b.fcs",
        logicleW: {},
        compensationOn: false,
      },
    ],
    activeSample: 0,
    gating: {
      gates: {},
      gate_order: [],
      populations: {
        root: {
          population_id: "root",
          name: "All Events",
          gate_refs: [],
          gate_logic: "and",
          parent_id: null,
          children: [],
          event_count: null,
          percent_of_parent: 100,
        },
      },
      root_population_id: "root",
      active_population_id: "root",
      selected_gate_id: null,
    },
    scales: { globalScales: {} },
    display: {
      xChannel: "FSC-A",
      yChannel: "SSC-A",
      mode: "pseudocolor",
      maxEvents: 50000,
      contourThreshold: 5,
    },
  };
}

function testFile(name: string): File {
  const bytes = Uint8Array.from([70, 67, 83]);
  const file = new File([bytes], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: async () => bytes.slice().buffer,
  });
  return file;
}

function fileHandle(name: string): FileSystemFileHandle {
  return {
    kind: "file",
    name,
    getFile: vi.fn().mockResolvedValue(testFile(name)),
  } as unknown as FileSystemFileHandle;
}

function installPickers(folderFiles: readonly FileSystemFileHandle[]) {
  const workspaceHandle = fileHandle("analysis.gatelab");
  const showOpenFilePicker = vi.fn().mockResolvedValue([workspaceHandle]);
  const showSaveFilePicker = vi.fn();
  const folderHandle = {
    kind: "directory",
    name: "flow-data",
    async *values() {
      for (const handle of folderFiles) yield handle;
    },
  } as unknown as FileSystemDirectoryHandle;
  const showDirectoryPicker = vi.fn().mockResolvedValue(folderHandle);

  Object.defineProperty(window, "showOpenFilePicker", {
    configurable: true,
    value: showOpenFilePicker,
  });
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: showSaveFilePicker,
  });
  Object.defineProperty(window, "showDirectoryPicker", {
    configurable: true,
    value: showDirectoryPicker,
  });
  return { showOpenFilePicker, showDirectoryPicker, workspaceHandle };
}

async function clickOpenWorkspace(): Promise<void> {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent === "Open Workspace…")!;
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function clickChooseFcsFolder(): Promise<void> {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent === "Choose FCS folder…")!;
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("App reference workspace relinking", () => {
  it("selects one folder and auto-matches every required FCS in workspace order", async () => {
    const workspace = referenceWorkspace();
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspace,
      fcsByPath: null,
      storage: "reference",
      portableAssays: null,
    });
    const donorA = fileHandle("donor-a.fcs");
    const donorB = fileHandle("donor-b.fcs");
    const unrelated = fileHandle("unrelated.fcs");
    const { showOpenFilePicker, showDirectoryPicker, workspaceHandle } = installPickers([
      donorB,
      unrelated,
      donorA,
    ]);

    act(() => root.render(<App />));
    await clickOpenWorkspace();

    expect(showOpenFilePicker).toHaveBeenCalledTimes(1);
    expect(showDirectoryPicker).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Locate linked FCS files");
    expect(host.textContent).toContain("donor-a.fcs");
    expect(host.textContent).toContain("donor-b.fcs");

    await clickChooseFcsFolder();

    expect(showDirectoryPicker).toHaveBeenCalledTimes(1);
    expect(showDirectoryPicker).toHaveBeenCalledWith({
      mode: "read",
      id: "gatelab-relink-fcs-folder",
      startIn: workspaceHandle,
    });
    const sampleRows = host.querySelectorAll<HTMLElement>('[role="option"]');
    expect(sampleRows).toHaveLength(2);
    expect(sampleRows[0].textContent).toContain("donor-a.fcs");
    expect(sampleRows[1].textContent).toContain("donor-b.fcs");
    expect(host.textContent).toContain("Opened analysis.gatelab · 2 samples · linked FCS");
  });

  it("reports all unmatched files together without partially opening the workspace", async () => {
    const workspace = referenceWorkspace();
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspace,
      fcsByPath: null,
      storage: "reference",
      portableAssays: null,
    });
    const { showDirectoryPicker } = installPickers([fileHandle("donor-a.fcs")]);

    act(() => root.render(<App />));
    await clickOpenWorkspace();
    expect(showDirectoryPicker).not.toHaveBeenCalled();
    await clickChooseFcsFolder();

    expect(showDirectoryPicker).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll<HTMLElement>('[role="option"]')).toHaveLength(0);
    expect(host.textContent).toContain("Missing: donor-b.fcs");
    expect(host.textContent).toContain("No workspace data were changed");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Cancel workspace open")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
