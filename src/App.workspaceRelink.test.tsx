// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import type { WorkspaceFile } from "./engine/workspace";

const plotCapture = vi.hoisted(() => ({ payload: null as any }));
vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: ({ payload }: { payload: unknown }) => {
    plotCapture.payload = payload;
    return <div data-testid="gating-plot" />;
  },
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

// What each folder file records about its acquisition, by name; none unless a test sets it.
const folderKeywords = vi.hoisted(() => ({
  byName: {} as Record<string, Record<string, string>>,
  byFile: new Map<File, Record<string, string>>(),
}));
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return {
    ...actual,
    parseFcs: () => syntheticFcs,
    readFcsFileKeywords: async (file: File) => folderKeywords.byFile.get(file) ?? folderKeywords.byName[file.name] ?? null,
  };
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
  it("restores linear coordinates together with their saved limits, including on a second open", async () => {
    const workspace = referenceWorkspace();
    workspace.samples = workspace.samples.slice(0, 1).map((sample) => ({
      ...sample, sampleId: "D1", fileName: "D1.fcs", dataPath: "data/D1.fcs",
      scatterLinear: ["FSC-A", "SSC-A"],
    }));
    workspace.scales.globalScales = { "FSC-A": [0, 400], "SSC-A": [0, 400] };
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspace, fcsByPath: { "data/D1.fcs": new Uint8Array([70, 67, 83]) },
      storage: "bundle", portableAssays: null,
    });
    installPickers([]);
    act(() => root.render(<App />));
    await clickOpenWorkspace();
    const plottedX = () => {
      const bytes = Uint8Array.from(atob(plotCapture.payload.x_b64), c => c.charCodeAt(0));
      return [...new Float32Array(bytes.buffer)];
    };
    expect(plottedX()).toEqual([100, 200, 300]);
    expect(plotCapture.payload.x_range).toEqual([0, 400]);

    workspace.samples[0].scatterLinear = [];
    workspace.scales.globalScales = { "FSC-A": [0, 3], "SSC-A": [0, 3] };
    await clickOpenWorkspace();
    expect(plottedX()[0]).toBeCloseTo(Math.asinh(100 / 150));
    expect(plotCapture.payload.x_range).toEqual([0, 3]);
  });

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
      id: "gatelab",
      startIn: workspaceHandle,
    });
    const sampleRows = host.querySelectorAll<HTMLElement>('[role="option"]');
    expect(sampleRows).toHaveLength(2);
    expect(sampleRows[0].textContent).toContain("donor-a.fcs");
    expect(sampleRows[1].textContent).toContain("donor-b.fcs");
    expect(host.textContent).toContain("Opened analysis.gatelab · 2 samples · linked FCS");
    expect([...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Lock scales between files")
      ?.getAttribute("aria-pressed")).toBe("true");
  });

  it("restores saved per-file ranges and the unlocked mode", async () => {
    const workspace = referenceWorkspace();
    workspace.samples[0].sampleId = "D1";
    workspace.samples[0].fileName = "D1.fcs";
    workspace.samples[0].dataPath = "data/D1.fcs";
    workspace.samples[1].sampleId = "D2";
    workspace.samples[1].fileName = "D2.fcs";
    workspace.samples[1].dataPath = "data/D2.fcs";
    workspace.scales = {
      globalScales: { "FSC-A": [1, 2] },
      lockBetweenFiles: false,
      perSampleGlobalScales: {
        D1: { "FSC-A": [1, 2] },
        D2: { "FSC-A": [3, 4] },
      },
    };
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspace,
      fcsByPath: null,
      storage: "reference",
      portableAssays: null,
    });
    installPickers([fileHandle("D1.fcs"), fileHandle("D2.fcs")]);

    act(() => root.render(<App />));
    await clickOpenWorkspace();
    await clickChooseFcsFolder();

    // The range the plot is drawn with; the header no longer carries range inputs (they live
    // in the Scales tab, and the plot honours the same map).
    const xRange = () => (plotCapture.payload.x_range as [number, number]).map((v: number) => Math.round(v * 1000) / 1000);
    const lock = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Lock scales between files")!;
    expect(lock.getAttribute("aria-pressed")).toBe("false");
    expect(xRange()).toEqual([1, 2]);

    const rowB = [...host.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((row) => row.textContent?.includes("D2.fcs"))!;
    await act(async () => {
      rowB.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(xRange()).toEqual([3, 4]);
  });

  it("never relinks a same-named file that records another acquisition than the one saved", async () => {
    // Saved against experiment A's donor-b.fcs; the folder chosen holds experiment B's.
    const workspace = referenceWorkspace();
    workspace.samples[1].identity = { $TOT: "3", $BTIM: "10:00:00" };
    folderKeywords.byName = { "donor-b.fcs": { $TOT: "3", $BTIM: "15:30:00" } };
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspace, fcsByPath: null, storage: "reference", portableAssays: null,
    });
    installPickers([fileHandle("donor-a.fcs"), fileHandle("donor-b.fcs")]);
    act(() => root.render(<App />));
    await clickOpenWorkspace();
    await clickChooseFcsFolder();
    folderKeywords.byName = {};
    expect(host.querySelectorAll<HTMLElement>('[role="option"]')).toHaveLength(0);
    expect(host.textContent).toContain("Another acquisition: the workspace's donor-b.fcs records $BTIM 10:00:00; donor-b.fcs has 15:30:00");
    expect(host.textContent).toContain("No workspace data were changed");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Cancel workspace open")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  // A saved workspace holding two files of one name (Specimen_001_Tube_001.fcs from two
  // experiments), each saved with its own acquisition identity. It was refused outright, "multiple
  // FCS files with the same filename"; the identities tell the two apart.
  it("relinks two files of one name, each saved with its own identity", async () => {
    const workspace = referenceWorkspace();
    workspace.samples[0] = { ...workspace.samples[0], fileName: "Specimen_001_Tube_001.fcs", dataPath: "data/0_Specimen_001_Tube_001.fcs", identity: { $TOT: "3", $BTIM: "10:00:00" } };
    workspace.samples[1] = { ...workspace.samples[1], fileName: "Specimen_001_Tube_001.fcs", dataPath: "data/1_Specimen_001_Tube_001.fcs", identity: { $TOT: "3", $BTIM: "15:30:00" } };
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspace, fcsByPath: null, storage: "reference", portableAssays: null,
    });
    const inFolder = (folder: string, keywords: Record<string, string>) => {
      const handle = fileHandle("Specimen_001_Tube_001.fcs");
      return {
        kind: "directory", name: folder,
        async *values() {
          const file = await handle.getFile();
          folderKeywords.byFile.set(file, keywords);
          yield handle;
        },
      } as unknown as FileSystemFileHandle;
    };
    installPickers([inFolder("experiment B", { $TOT: "3", $BTIM: "15:30:00" }), inFolder("experiment A", { $TOT: "3", $BTIM: "10:00:00" })]);
    act(() => root.render(<App />));
    await clickOpenWorkspace();
    expect(host.textContent).not.toContain("multiple FCS files with the same filename");
    await clickChooseFcsFolder();
    folderKeywords.byFile.clear();
    expect(host.querySelectorAll<HTMLElement>('[role="option"]')).toHaveLength(2);
    expect(host.textContent).toContain("Opened analysis.gatelab · 2 samples · linked FCS");
  });

  // The only file of the name records another acquisition. It is never relinked unasked, and it
  // could not be relinked at all: the workspace would not open until the right file was found.
  it("relinks a file of another acquisition only when chosen by name, and says so", async () => {
    const workspace = referenceWorkspace();
    workspace.samples[1].identity = { $TOT: "3", $BTIM: "10:00:00" };
    folderKeywords.byName = { "donor-b.fcs": { $TOT: "3", $BTIM: "15:30:00" } };
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspace, fcsByPath: null, storage: "reference", portableAssays: null,
    });
    installPickers([fileHandle("donor-a.fcs"), fileHandle("donor-b.fcs")]);
    act(() => root.render(<App />));
    await clickOpenWorkspace();
    await clickChooseFcsFolder();
    folderKeywords.byName = {};
    expect(host.querySelectorAll<HTMLElement>('[role="option"]')).toHaveLength(0);
    expect(host.textContent).toContain("flow-data/donor-b.fcs as donor-b.fcs");
    const anyway = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Relink to these files anyway")!;
    await act(async () => {
      anyway.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.querySelectorAll<HTMLElement>('[role="option"]')).toHaveLength(2);
    expect(host.textContent).toContain("relinked by choice to files that record another acquisition: flow-data/donor-b.fcs as donor-b.fcs");
  });

  // The files of a workspace spread over two folders: the first choice keeps what it found, the
  // dialog says what is still to find, and the second folder completes the open. The old dialog
  // refused the first folder outright and forgot it.
  it("opens a workspace whose files are in two folders, chosen one after the other", async () => {
    const workspace = referenceWorkspace();
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspace,
      fcsByPath: null,
      storage: "reference",
      portableAssays: null,
    });
    const { showDirectoryPicker } = installPickers([fileHandle("donor-a.fcs")]);
    const secondFolder = {
      kind: "directory",
      name: "flow-data-2",
      async *values() { yield fileHandle("donor-b.fcs"); },
    } as unknown as FileSystemDirectoryHandle;
    showDirectoryPicker.mockResolvedValueOnce({
      kind: "directory",
      name: "flow-data",
      async *values() { yield fileHandle("donor-a.fcs"); },
    } as unknown as FileSystemDirectoryHandle).mockResolvedValueOnce(secondFolder);

    act(() => root.render(<App />));
    await clickOpenWorkspace();
    await clickChooseFcsFolder();

    // Kept, and said: one found, one to find; nothing opened yet.
    expect(host.querySelectorAll<HTMLElement>('[role="option"]')).toHaveLength(0);
    expect(host.textContent).toContain("1 of 2 FCS files found · 1 to find");
    expect(host.textContent).toContain("1 of 2 found in \"flow-data\"; 1 still to find: donor-b.fcs");
    expect(host.textContent).not.toContain("No workspace data were changed");
    const rows = [...host.querySelectorAll<HTMLElement>(".gl-workspace-relink-files > div")];
    expect(rows.map((row) => row.classList.contains("is-found"))).toEqual([true, false]);

    const another = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Choose another folder…")!;
    await act(async () => {
      another.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(showDirectoryPicker).toHaveBeenCalledTimes(2);
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
    expect(host.textContent).toContain("1 still to find: donor-b.fcs");
    expect(host.textContent).toContain("Choose another folder");
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Cancel workspace open")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});

describe("App reference workspace relinking, by identity and without one", () => {
  // The saved file is in the folder under a lower-cased name, and another acquisition carries the
  // exact name. The folder was refused, and "Relink to these files anyway" put that acquisition in
  // the saved file's place.
  it("relinks the case-changed file the saved identity confirms, not the exact-named other acquisition", async () => {
    const workspace = referenceWorkspace();
    workspace.samples[1] = { ...workspace.samples[1], fileName: "Specimen_001_Tube_001.fcs", dataPath: "data/1_Specimen_001_Tube_001.fcs", identity: { $TOT: "3", $BTIM: "10:00:00" } };
    workspace.samples[0].identity = { $TOT: "3", $BTIM: "09:00:00" };
    folderKeywords.byName = {
      "donor-a.fcs": { $TOT: "3", $BTIM: "09:00:00" },
      "specimen_001_tube_001.fcs": { $TOT: "3", $BTIM: "10:00:00" },
      "Specimen_001_Tube_001.fcs": { $TOT: "3", $BTIM: "15:30:00" },
    };
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspace, fcsByPath: null, storage: "reference", portableAssays: null,
    });
    installPickers([fileHandle("Specimen_001_Tube_001.fcs"), fileHandle("specimen_001_tube_001.fcs"), fileHandle("donor-a.fcs")]);
    act(() => root.render(<App />));
    await clickOpenWorkspace();
    await clickChooseFcsFolder();
    folderKeywords.byName = {};
    expect(host.textContent).not.toContain("Another acquisition");
    expect(host.textContent).not.toContain("Relink to these files anyway");
    expect(host.querySelectorAll<HTMLElement>('[role="option"]')).toHaveLength(2);
    expect(host.textContent).toContain("Opened analysis.gatelab · 2 samples · linked FCS");
    // Both declarations carried their identity, so nothing is said to be unconfirmed.
    expect(host.textContent).not.toContain("unconfirmed");
  });

  // As above, but the lower-cased file agrees with what it was saved with on $TOT alone. It is the
  // right file, and it was relinked with nothing said.
  it("says a case-changed file taken over another acquisition of the exact name is unconfirmed, where only $TOT agrees", async () => {
    const workspace = referenceWorkspace();
    workspace.samples[1] = { ...workspace.samples[1], fileName: "Specimen_001_Tube_001.fcs", dataPath: "data/1_Specimen_001_Tube_001.fcs", identity: { $TOT: "3", $BTIM: "10:00:00" } };
    workspace.samples[0].identity = { $TOT: "3", $BTIM: "09:00:00" };
    folderKeywords.byName = {
      "donor-a.fcs": { $TOT: "3", $BTIM: "09:00:00" },
      "specimen_001_tube_001.fcs": { $TOT: "3" },
      "Specimen_001_Tube_001.fcs": { $TOT: "3", $BTIM: "15:30:00" },
    };
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspace, fcsByPath: null, storage: "reference", portableAssays: null,
    });
    installPickers([fileHandle("Specimen_001_Tube_001.fcs"), fileHandle("specimen_001_tube_001.fcs"), fileHandle("donor-a.fcs")]);
    act(() => root.render(<App />));
    await clickOpenWorkspace();
    await clickChooseFcsFolder();
    folderKeywords.byName = {};
    expect(host.textContent).toContain("Opened analysis.gatelab · 2 samples · linked FCS");
    expect(host.textContent).toContain(
      "relinked without confirmation: flow-data/specimen_001_tube_001.fcs as Specimen_001_Tube_001.fcs, chosen over " +
      "flow-data/Specimen_001_Tube_001.fcs: it agrees with what it was saved with on $TOT only, which does not confirm it");
  });

  // One declaration saved without identity, and a case-variant of its name saved with one: the
  // workspace was refused as holding two files nothing tells apart, though the identity decides.
  it("relinks a case-variant declaration saved with its identity beside one saved without", async () => {
    const workspace = referenceWorkspace();
    workspace.samples[0] = { ...workspace.samples[0], fileName: "D1.fcs", dataPath: "data/0_D1.fcs" };
    workspace.samples[1] = { ...workspace.samples[1], fileName: "d1.fcs", dataPath: "data/1_d1.fcs", identity: { $TOT: "3", $BTIM: "10:00:00" } };
    folderKeywords.byName = { "D1.fcs": { $TOT: "3", $BTIM: "10:00:00" }, "d1.fcs": { $TOT: "3", $BTIM: "15:30:00" } };
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspace, fcsByPath: null, storage: "reference", portableAssays: null,
    });
    installPickers([fileHandle("D1.fcs"), fileHandle("d1.fcs")]);
    act(() => root.render(<App />));
    await clickOpenWorkspace();
    await clickChooseFcsFolder();
    folderKeywords.byName = {};
    expect(host.textContent).not.toContain("multiple FCS files with the same filename");
    expect(host.textContent).toContain("Opened analysis.gatelab · 2 samples · linked FCS");
    expect(host.textContent).toContain('so nothing confirms it is the file it was saved with: "D1.fcs"');
  });

  // A workspace saved before identities were recorded relinks by name, as before, and says that
  // nothing confirms the files are the ones it was saved with. It said only "Opened …".
  it("says a workspace saved without identities was relinked by name alone, unconfirmed", async () => {
    const workspace = referenceWorkspace();
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspace, fcsByPath: null, storage: "reference", portableAssays: null,
    });
    installPickers([fileHandle("donor-a.fcs"), fileHandle("donor-b.fcs")]);
    act(() => root.render(<App />));
    await clickOpenWorkspace();
    await clickChooseFcsFolder();
    expect(host.querySelectorAll<HTMLElement>('[role="option"]')).toHaveLength(2);
    expect(host.textContent).toContain(
      'relinked by name alone, unconfirmed: the workspace was saved without the acquisition keywords of these 2 files, so nothing confirms they are the files it was saved with: "donor-a.fcs", "donor-b.fcs"');
  });
});
