// @vitest-environment jsdom
// A workspace saved while GateLab read a file differently names its channels by the keys of that
// reading. The MACSQuant FCS 3.1 export was taken for a spectral file until 2026-09, which keyed
// FL2-A as "V2-A (FL2-A)" and Time by its $PnN; it is now keyed as a conventional file, "V2-A" and
// "HDR-T". A gate on an old key matched no events and the workspace reopened with every such
// population at 0 and no message. Synthetic file and names throughout.

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

/** FSC-A with no $PnS, FL2-A with $PnS V2-A, Time with $PnS HDR-T: four events. */
function macsQuantLike(): Uint8Array {
  const rows = [[100, 10, 1], [200, 500, 2], [300, 600, 3], [400, 700, 4]];
  const data = new Uint8Array(rows.length * 12);
  const dv = new DataView(data.buffer);
  rows.forEach((row, e) => row.forEach((v, c) => dv.setFloat32(e * 12 + c * 4, v, true)));
  const textStart = 64;
  let begin = 0;
  let text = new Uint8Array(0);
  for (let i = 0; i < 4; i++) {
    text = new TextEncoder().encode(
      `/$BYTEORD/1,2,3,4/$DATATYPE/F/$MODE/L/$NEXTDATA/0/$PAR/3/$TOT/${rows.length}` +
      "/$P1N/FSC-A/$P1B/32/$P1E/0,0/$P1R/1024" +
      "/$P2N/FL2-A/$P2S/V2-A/$P2B/32/$P2E/0,0/$P2R/1024" +
      "/$P3N/Time/$P3S/HDR-T/$P3B/32/$P3E/0,0/$P3R/1024" +
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

const population = (id: string, name: string, gate: string) => ({
  population_id: id, name, gate_refs: [{ gate_id: gate, include: true }], gate_logic: "and",
  parent_id: "root", children: [], event_count: null, percent_of_parent: null,
});

/** Saved under the old keys: a gate on "V2-A (FL2-A)" × "Time", one on a channel no file has. */
function workspace(): WorkspaceFile {
  return {
    format: "gatelab-workspace",
    version: 2,
    workspaceId: "workspace-channel-keys",
    savedAt: "2026-09-18T00:00:00.000Z",
    app: "GateLab",
    samples: [{
      fileName: "D1.fcs", dataPath: "data/0_D1.fcs", logicleW: {}, compensationOn: false,
      labels: { "V2-A (FL2-A)": "M1" },
    }],
    activeSample: 0,
    gating: {
      gates: {
        g1: { gate_id: "g1", name: "M1_positive", gate_type: "rectangle", x_channel: "V2-A (FL2-A)", y_channel: "Time", vertices: [[400, 0], [1000, 3.5]], color: "#000000", label_offset: null },
        g2: { gate_id: "g2", name: "Unmatched", gate_type: "rectangle", x_channel: "FL9-A", y_channel: "FSC-A", vertices: [[0, 0], [1000, 1000]], color: "#000000", label_offset: null },
      },
      gate_order: ["g1", "g2"],
      populations: {
        root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: ["p1", "p2"], event_count: null, percent_of_parent: 100 },
        p1: population("p1", "M1_positive", "g1"),
        p2: population("p2", "Unmatched", "g2"),
      },
      root_population_id: "root",
      active_population_id: "root",
      selected_gate_id: null,
    },
    scales: { globalScales: {} },
    display: { xChannel: "V2-A (FL2-A)", yChannel: "Time", mode: "pseudocolor", maxEvents: 50000, contourThreshold: 5 },
  } as WorkspaceFile;
}

async function openWorkspace(): Promise<void> {
  const file = new File([Uint8Array.from([80, 75])], "analysis.gatelab");
  const handle = { kind: "file", name: "analysis.gatelab", getFile: vi.fn().mockResolvedValue(file) } as unknown as FileSystemFileHandle;
  Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn().mockResolvedValue([handle]) });
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: vi.fn() });
  vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
    raw: workspace(), fcsByPath: { "data/0_D1.fcs": macsQuantLike() }, storage: "bundle", portableAssays: null,
  });
  act(() => root.render(<App />));
  const open = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Open Workspace…")!;
  await act(async () => { open.click(); await new Promise((r) => setTimeout(r, 20)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

describe("a workspace saved under channel keys the file no longer has", () => {
  it("restates each key as the same parameter's key now, and says so", async () => {
    await openWorkspace();
    expect(host.textContent).toContain("Opened analysis.gatelab · 1 sample");
    expect(host.textContent).toContain('"V2-A (FL2-A)" is now "V2-A"');
    expect(host.textContent).toContain('"Time" is now "HDR-T"');
    // The gate follows the parameter and counts its events; the Panel-tab name "M1" follows too.
    expect(host.textContent).toMatch(/M1_positive\S*M1 \/ HDR-T\s*2 \(50%\)/);
  });

  it("warns about a gate whose channel no file has, as adding a file does", async () => {
    await openWorkspace();
    expect(host.textContent).toContain("1 sample is missing channels used by existing gates: D1.fcs: Unmatched.");
    expect(host.textContent).not.toMatch(/D1\.fcs: [^.]*M1_positive/);
  });
});
