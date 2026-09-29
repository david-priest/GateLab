// @vitest-environment jsdom
// A spillover matrix GateLab took from a FlowJo workspace or a Gating-ML file, for a file that
// carries none of its own (a FACSDiva export, as a rule), was not saved with the workspace. Reopened,
// the file had no matrix, compensation stayed off, and the counts were the uncompensated ones: on a
// FlowRepository FACSDiva workspace VD2+ went from 246 to 1,043, IFNy+ from 0 to 484. The workspace
// was marked unsaved at once, so the autosave then wrote compensation off into the user's file. The
// matrix is now saved with the sample and installed again on opening; a workspace saved without it
// says which files lost their compensation, and keeps compensation on for them when it is saved.
// Synthetic file, channels and matrix throughout.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFile } from "./engine/workspace";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));
vi.mock("./engine/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/workspace")>();
  return { ...actual, readWorkspaceEnvelopeFromFile: vi.fn() };
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

/** FSC-A, FL1-A, FL2-A, no $SPILLOVER: four events, two of them FL2-A positive once compensated. */
function flowFile(): Uint8Array {
  const rows = [[1000, 1000, 600], [1100, 0, 600], [1200, 100, 100], [1300, 100, 500]];
  const data = new Uint8Array(rows.length * 12);
  const dv = new DataView(data.buffer);
  rows.forEach((row, e) => row.forEach((v, c) => dv.setFloat32(e * 12 + c * 4, v, true)));
  const textStart = 64;
  let begin = 0;
  let text = new Uint8Array(0);
  for (let i = 0; i < 4; i++) {
    text = new TextEncoder().encode(
      `/$BYTEORD/1,2,3,4/$DATATYPE/F/$MODE/L/$NEXTDATA/0/$PAR/3/$TOT/${rows.length}/$CYT/FACSCanto` +
      "/$P1N/FSC-A/$P1B/32/$P1E/0,0/$P1R/262144" +
      "/$P2N/FL1-A/$P2B/32/$P2E/0,0/$P2R/262144" +
      "/$P3N/FL2-A/$P3B/32/$P3E/0,0/$P3R/262144" +
      `/$BEGINDATA/${begin}/$ENDDATA/${begin + data.length - 1}/`);
    begin = textStart + text.length;
  }
  const out = new Uint8Array(begin + data.length);
  const head = "FCS3.1    " + [textStart, textStart + text.length - 1, begin, begin + data.length - 1, 0, 0]
    .map((n) => String(n).padStart(8)).join("");
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
  out.set(text, textStart);
  out.set(data, begin);
  return out;
}

const MATRIX = { label: "the FlowJo workspace", channels: ["FL1-A", "FL2-A"], matrix: [[1, 0.5], [0, 1]] };

/** A raw rectangle holding FL2-A above 300: 3 events uncompensated, 2 compensated. */
function workspace(extra: Record<string, unknown>): WorkspaceFile {
  return {
    format: "gatelab-workspace",
    version: 2,
    workspaceId: "workspace-external-spillover",
    savedAt: "2026-09-25T00:00:00.000Z",
    app: "GateLab",
    samples: [{ fileName: "D1.fcs", dataPath: "data/0_D1.fcs", logicleW: {}, compensationOn: true, ...extra }],
    activeSample: 0,
    gating: {
      gates: {
        g1: { gate_id: "g1", name: "FL2_positive", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "FL2-A", vertices: [[0, 300], [100000, 100000]], space: "raw", color: "#000000", label_offset: null },
      },
      gate_order: ["g1"],
      populations: {
        root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: ["p1"], event_count: null, percent_of_parent: 100 },
        p1: { population_id: "p1", name: "FL2_positive", gate_refs: [{ gate_id: "g1", include: true }], gate_logic: "and", parent_id: "root", children: [], event_count: null, percent_of_parent: null },
      },
      root_population_id: "root",
      active_population_id: "root",
      selected_gate_id: null,
    },
    scales: { globalScales: {} },
    display: { xChannel: "FSC-A", yChannel: "FL2-A", mode: "pseudocolor", maxEvents: 50000, contourThreshold: 5 },
  } as WorkspaceFile;
}

async function openWorkspace(ws: WorkspaceFile): Promise<void> {
  const file = new File([Uint8Array.from([80, 75])], "analysis.gatelab");
  const handle = { kind: "file", name: "analysis.gatelab", getFile: vi.fn().mockResolvedValue(file) } as unknown as FileSystemFileHandle;
  Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn().mockResolvedValue([handle]) });
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: vi.fn() });
  vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
    raw: ws, fcsByPath: { "data/0_D1.fcs": flowFile() }, storage: "bundle", portableAssays: null,
  });
  act(() => root.render(<App />));
  const open = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Open Workspace…")!;
  await act(async () => { open.click(); await new Promise((r) => setTimeout(r, 20)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

/** The workspace as GateLab would save it once opened (its after-open checkpoint). */
function savedAfterOpen(): WorkspaceFile {
  const call = vi.mocked(saveWorkspaceCheckpoint).mock.calls.find((c) => c[2] === "after-workspace-open");
  expect(call).toBeDefined();
  return call![1] as WorkspaceFile;
}

describe("a spillover matrix the FCS file does not carry, through a saved workspace", () => {
  it("is saved with the sample, installed again on opening, and compensates the counts", async () => {
    await openWorkspace(workspace({ externalSpillover: MATRIX }));
    expect(host.textContent).toContain("Opened analysis.gatelab · 1 sample");
    expect(host.textContent).toMatch(/FL2_positive[\s\S]{0,60}?2 \(50%\)/);
    const saved = savedAfterOpen();
    expect(saved.samples[0].compensationOn).toBe(true);
    expect(saved.samples[0].externalSpillover).toEqual(MATRIX);
  });

  it("from a workspace saved without it, says which files lost their compensation, and keeps it on when saved", async () => {
    await openWorkspace(workspace({}));
    expect(host.textContent).toMatch(/FL2_positive[\s\S]{0,60}?3 \(75%\)/);
    expect(host.textContent).toContain("Compensation was on for 1 sample when the workspace was saved, but no spillover matrix is available for it now: D1.fcs");
    expect(savedAfterOpen().samples[0].compensationOn).toBe(true);
  });
});
