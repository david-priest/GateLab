// @vitest-environment jsdom
//
// A Cytobank file's gate names its compensation by compensation_id, and the file carries that
// matrix as a spectrumMatrix only when it was exported with it. Without it, the gates' dimensions
// still say FCS, and they were evaluated with the FCS file's own matrix, with nothing said. The
// import now names the gates and waits: the user supplies the matrix, or chooses the FCS file's.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));

function syntheticFcs(): FcsFile {
  const n = 6;
  return {
    version: "FCS3.1",
    nEvents: n,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      { index: 2, name: "FITC-A", marker: "CD4_positive", bits: 32, range: 262144 },
      { index: 3, name: "PE-A", marker: "CD8_positive", bits: 32, range: 262144 },
    ],
    columns: [
      Float32Array.from({ length: n }, (_, i) => 1000 * (i + 1)),
      Float32Array.from({ length: n }, (_, i) => 500 * (i + 1)),
      Float32Array.from([100, 5000, 20000, 300, 10000, 40000]),
      Float32Array.from([200, 400, 9000, 15000, 2500, 30000]),
    ],
    spillover: { channels: ["FITC-A", "PE-A"], matrix: [[1, 0.1], [0.02, 1]] },
  };
}
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => syntheticFcs() };
});

import App from "./App";

/** Cytobank's shape: FCS on the dimensions, compensation 5 by id, and no spectrumMatrix. */
const CYTOBANK = `<?xml version="1.0"?>
<gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
  xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <gating:RectangleGate gating:id="g1">
    <data-type:custom_info><cytobank><name>Double positive</name><compensation_id>5</compensation_id></cytobank></data-type:custom_info>
    <gating:dimension gating:compensation-ref="FCS" gating:min="1000" gating:max="100000"><data-type:fcs-dimension data-type:name="FITC-A"/></gating:dimension>
    <gating:dimension gating:compensation-ref="FCS" gating:min="1000" gating:max="100000"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
  </gating:RectangleGate>
</gating:Gating-ML>`;

const MATRIX_CSV = ",FITC-A,PE-A\nFITC-A,1,0.3\nPE-A,0.05,1\n";

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

function textFile(name: string, text: string, type: string): File {
  const file = new File([text], name, { type });
  Object.defineProperty(file, "text", { value: async () => text });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(text).buffer });
  return file;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

const popRow = (name: string) =>
  [...host.querySelectorAll(".pop-row")].map((r) => r.textContent ?? "").find((t) => t.includes(name)) ?? "";
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!;

async function loadAndImport(): Promise<void> {
  act(() => root.render(<App />));
  const fcs = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
    .find((candidate) => !candidate.hasAttribute("webkitdirectory"))!;
  const bytes = Uint8Array.from([1]);
  const fcsFile = new File([bytes], "D1.fcs", { type: "application/octet-stream" });
  Object.defineProperty(fcsFile, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  Object.defineProperty(fcs, "files", { configurable: true, value: [fcsFile] });
  await act(async () => { fcs.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  const xml = host.querySelector<HTMLInputElement>('input[accept=".xml,.wsp,.cef"]')!;
  Object.defineProperty(xml, "files", { configurable: true, value: [textFile("gates.xml", CYTOBANK, "text/xml")] });
  await act(async () => { xml.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  await settle();
}

describe("a Cytobank compensation the file names and does not carry", () => {
  it("names the gates and waits for the matrix, then evaluates them with the one supplied", async () => {
    await loadAndImport();
    expect(host.textContent).toContain('("Double positive") was drawn under Cytobank compensation 5, which this file names but does not carry');
    expect(button("Import").disabled).toBe(true);

    const matrixInput = host.querySelector<HTMLInputElement>('.gl-modal-field input[type="file"]')!;
    Object.defineProperty(matrixInput, "files", { configurable: true, value: [textFile("B1-matrix.csv", MATRIX_CSV, "text/csv")] });
    await act(async () => { matrixInput.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(host.textContent).toContain("The gates will be evaluated with the matrix from B1-matrix.csv.");
    expect(button("Import").disabled).toBe(false);
    act(() => button("Import").click());
    await settle();
    await settle();
    expect(host.textContent).toContain("compensation enabled with the matrix from B1-matrix.csv");
    // Three events are in the gate under the FCS file's matrix and two under the one supplied.
    expect(popRow("Double positive")).toMatch(/\+2\(/);
  });

  it("uses the FCS file's own matrix only when that is chosen, and says so", async () => {
    await loadAndImport();
    expect(button("Import").disabled).toBe(true);
    const box = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((b) => b.parentElement?.textContent?.includes("Use this FCS file's own matrix instead"))!;
    act(() => box.click());
    expect(button("Import").disabled).toBe(false);
    act(() => button("Import").click());
    await settle();
    await settle();
    expect(host.textContent).toContain("compensation enabled with this FCS file's own matrix, chosen in place of the one the gates were drawn under");
    expect(popRow("Double positive")).toMatch(/\+3\(/);
  });
});
