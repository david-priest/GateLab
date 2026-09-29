// @vitest-environment jsdom
// A file holding several FCS data sets ($NEXTDATA): a workspace saved before GateLab read every
// data set holds it as one sample, which was its first data set. It reopens as it was saved and
// says so, rather than refusing the workspace or dropping the other data sets silently.
// Synthetic file, wells A01 and A02.

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

/** Two FCS data sets chained by $NEXTDATA: 2 events in A01, 3 in A02. */
function twoDataSets(): Uint8Array {
  const dataSet = (rows: number[][], well: string, next: number): Uint8Array => {
    const data = new Uint8Array(rows.length * 8);
    const dv = new DataView(data.buffer);
    rows.forEach((row, e) => row.forEach((v, c) => dv.setFloat32(e * 8 + c * 4, v, true)));
    const textStart = 64;
    let begin = 0;
    let text = new Uint8Array(0);
    for (let i = 0; i < 4; i++) {
      text = new TextEncoder().encode(
        `/$BYTEORD/1,2,3,4/$DATATYPE/F/$MODE/L/$NEXTDATA/${String(next).padStart(8, "0")}/$PAR/2/$TOT/${rows.length}` +
        `/$P1N/FSC-A/$P1B/32/$P1E/0,0/$P1R/262144/$P2N/SSC-A/$P2B/32/$P2E/0,0/$P2R/262144/$WELLID/${well}` +
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
  };
  const rows = [[100, 110], [101, 111]];
  const first = dataSet(rows, "A01", dataSet(rows, "A01", 0).length);
  const second = dataSet([[200, 210], [201, 211], [202, 212]], "A02", 0);
  const bytes = new Uint8Array(first.length + second.length);
  bytes.set(first, 0);
  bytes.set(second, first.length);
  return bytes;
}

function workspace(): WorkspaceFile {
  return {
    format: "gatelab-workspace",
    version: 2,
    workspaceId: "workspace-data-sets",
    savedAt: "2026-09-18T00:00:00.000Z",
    app: "GateLab",
    samples: [{ fileName: "plate.fcs", dataPath: "data/0_plate.fcs", logicleW: {}, compensationOn: false }],
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
}

describe("a workspace holding a multi-data-set file as one sample", () => {
  it("reopens on the first data set, as saved, and names the others", async () => {
    const file = new File([Uint8Array.from([80, 75])], "analysis.gatelab");
    const handle = { kind: "file", name: "analysis.gatelab", getFile: vi.fn().mockResolvedValue(file) } as unknown as FileSystemFileHandle;
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn().mockResolvedValue([handle]) });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn() });
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: vi.fn() });
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: workspace(), fcsByPath: { "data/0_plate.fcs": twoDataSets() }, storage: "bundle", portableAssays: null,
    });
    act(() => root.render(<App />));
    const open = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Open Workspace…")!;
    await act(async () => { open.click(); await new Promise((r) => setTimeout(r, 20)); });
    expect(host.textContent).toContain("Opened analysis.gatelab · 1 sample");
    expect(host.textContent).toContain("plate.fcs holds 2 data sets and this workspace uses the first, as it was saved");
    expect(host.textContent).toContain("plate.fcs — 2 events · 2 channels");
  });
});
