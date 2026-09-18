// @vitest-environment jsdom
// Revert workspace…: the app lists the browser's checkpoints of the open workspace and goes
// back to the one chosen, keeping the current state as a checkpoint first. Synthetic files
// and gates throughout.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import type { WorkspaceFile } from "./engine/workspace";
import type { WorkspaceCheckpoint } from "./engine/workspaceHistory";

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
  return { ...actual, parseFcs: () => syntheticFcs };
});
vi.mock("./engine/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/workspace")>();
  return { ...actual, readWorkspaceEnvelopeFromFile: vi.fn() };
});
const history = vi.hoisted(() => ({ checkpoints: [] as unknown[] }));
vi.mock("./engine/workspaceHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/workspaceHistory")>();
  return {
    ...actual,
    listWorkspaceCheckpoints: vi.fn(async () => history.checkpoints),
    saveWorkspaceCheckpoint: vi.fn(async () => "saved"),
    requestPersistentWorkspaceHistory: vi.fn(async () => null),
  };
});

import App from "./App";
import { readWorkspaceEnvelopeFromFile } from "./engine/workspace";
import { saveWorkspaceCheckpoint } from "./engine/workspaceHistory";

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
});

function workspaceWith(gated: boolean): WorkspaceFile {
  return {
    format: "gatelab-workspace",
    version: 2,
    workspaceId: "workspace-revert-test",
    savedAt: "2026-09-18T00:00:00.000Z",
    app: "GateLab",
    samples: [{ fileName: "D1.fcs", dataPath: "data/0_D1.fcs", logicleW: {}, compensationOn: false }],
    activeSample: 0,
    gating: {
      gates: gated ? {
        g1: { gate_id: "g1", name: "CD4_positive", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A", vertices: [[0, 0], [1000, 1000]], color: "#000000", label_offset: null },
      } : {},
      gate_order: gated ? ["g1"] : [],
      populations: {
        root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: gated ? ["p1"] : [], event_count: null, percent_of_parent: 100 },
        ...(gated ? { p1: { population_id: "p1", name: "CD4_positive", gate_refs: [{ gate_id: "g1", include: true }], gate_logic: "and", parent_id: "root", children: [], event_count: null, percent_of_parent: null } } : {}),
      },
      root_population_id: "root",
      active_population_id: "root",
      selected_gate_id: null,
    },
    scales: { globalScales: {} },
    display: { xChannel: "FSC-A", yChannel: "SSC-A", mode: "pseudocolor", maxEvents: 50000, contourThreshold: 5 },
  } as WorkspaceFile;
}

function testFile(name: string): File {
  const bytes = Uint8Array.from([70, 67, 83]);
  const file = new File([bytes], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", { configurable: true, value: async () => bytes.slice().buffer });
  return file;
}

async function clickButton(text: string): Promise<void> {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === text)!;
  expect(button, text).toBeTruthy();
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("Revert workspace", () => {
  it("lists the checkpoints, reverts to the chosen one, and keeps the current state first", async () => {
    const workspaceHandle = { kind: "file", name: "analysis.gatelab", getFile: vi.fn().mockResolvedValue(testFile("analysis.gatelab")) } as unknown as FileSystemFileHandle;
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn().mockResolvedValue([workspaceHandle]) });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn() });
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: vi.fn() });
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspaceWith(true), fcsByPath: { "data/0_D1.fcs": new Uint8Array([70, 67, 83]) }, storage: "reference", portableAssays: null,
    });
    const asOpened: WorkspaceCheckpoint = {
      id: "cp-opened", workspaceId: "workspace-revert-test", createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      reason: "after-workspace-open", workspace: workspaceWith(false), summary: { samples: 1, gates: 0, populations: 1, bytes: 500 },
    };
    history.checkpoints = [asOpened];

    act(() => root.render(<App />));
    await clickButton("Open Workspace…");
    expect(host.textContent).toContain("Opened analysis.gatelab");
    expect(host.textContent).toContain("CD4_positive");

    await clickButton("Revert workspace…");
    expect(host.textContent).toContain("Revert workspace");
    const row = host.querySelector<HTMLElement>(".gl-modal-history-list label")!;
    expect(row.textContent).toContain("5 min ago");
    expect(row.textContent).toContain("As opened · the workspace as it was opened");
    act(() => { row.querySelector("input")!.click(); });
    await clickButton("Revert to this checkpoint");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    expect(host.querySelector(".gl-modal-history-list")).toBeNull();
    expect(host.textContent).not.toContain("CD4_positive");
    expect(host.textContent).toContain("Reverted to As opened · 5 min ago · analysis.gatelab is written over at the next autosave");
    const reasons = vi.mocked(saveWorkspaceCheckpoint).mock.calls.map((call) => call[2]);
    expect(reasons).toContain("before-revert");
    // The checkpoint taken first holds the gate that the revert removed.
    const before = vi.mocked(saveWorkspaceCheckpoint).mock.calls.find((call) => call[2] === "before-revert")!;
    expect(Object.keys((before[1] as WorkspaceFile).gating.gates)).toEqual(["g1"]);
  });
});
