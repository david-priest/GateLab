// @vitest-environment jsdom
// The open dialog compares the workspace's spillover matrix with the file's for the tree it will
// import, and asks which to use when they differ. For a tree the converter cannot read it cannot
// compare, and asked nothing; the tree chosen instead after that tree failed was then imported
// with the dialog's default answer as though the user had given it, and the file's matrix was
// replaced by the workspace's without the question being put. Synthetic names and matrices.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));
// The file's own matrix: APC into BV786 at 0.30, where the workspace's says 0.25.
const syntheticFcs: FcsFile = {
  version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {},
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    { index: 2, name: "BV786-A", marker: "CD4", bits: 32, range: 262144 },
    { index: 3, name: "APC-A", marker: "CD8", bits: 32, range: 262144 },
  ],
  columns: [Float32Array.from([10, 20, 30]), Float32Array.from([100, 200, 300]), Float32Array.from([5, 6, 7]), Float32Array.from([8, 9, 10])],
  spillover: { channels: ["BV786-A", "APC-A"], matrix: [[1, 0.3], [0.05, 1]] },
};
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => syntheticFcs };
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

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";
// Two trees: the first a complement naming no population, which converts to nothing, the second a
// plain rectangle.
const WSP = `<?xml version="1.0"?>
<Workspace xmlns:gating="${G}" xmlns:transforms="${T}" xmlns:data-type="${D}"><SampleList><Sample><DataSet uri="file:D1.fcs"/>
  <transforms:spilloverMatrix spectral="0" prefix="Comp-" suffix="" name="Matrix_A">
    <data-type:parameters><data-type:parameter data-type:name="BV786-A"/><data-type:parameter data-type:name="APC-A"/></data-type:parameters>
    <transforms:spillover data-type:parameter="BV786-A">
      <transforms:coefficient data-type:parameter="BV786-A" transforms:value="1"/>
      <transforms:coefficient data-type:parameter="APC-A" transforms:value="0.25"/>
    </transforms:spillover>
    <transforms:spillover data-type:parameter="APC-A">
      <transforms:coefficient data-type:parameter="BV786-A" transforms:value="0.05"/>
      <transforms:coefficient data-type:parameter="APC-A" transforms:value="1"/>
    </transforms:spillover>
  </transforms:spilloverMatrix>
  <SampleNode name="D1.fcs" count="3"><Subpopulations>
    <NotNode name="Broken" count="1"><Dependents/></NotNode>
    <Population name="CD4_positive" count="2"><Gate><gating:RectangleGate gating:id="g1">
      <gating:dimension gating:min="0" gating:max="25"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
      <gating:dimension gating:min="0" gating:max="1000"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
    </gating:RectangleGate></Gate></Population>
  </Subpopulations></SampleNode>
</Sample></SampleList></Workspace>`;

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

function fileOf(name: string, content: string | Uint8Array<ArrayBuffer>): File {
  const bytes: Uint8Array<ArrayBuffer> = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const file = new File([bytes], name);
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.slice().buffer });
  if (typeof content === "string") Object.defineProperty(file, "text", { value: async () => content });
  return file;
}
async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
async function feed(selector: string, files: File[]): Promise<void> {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  for (let i = 0; i < 4; i++) await settle();
}
const dialog = () => host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]');
const treePicker = () => host.querySelector<HTMLElement>('[aria-label="Choose a gating tree"]');

describe("choosing another tree after the chosen one failed", () => {
  it("asks which spillover matrix to use, since the open dialog could not compare them", async () => {
    act(() => root.render(<App />));
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", WSP)]);
    await feed('input[data-role="flowjo-workspace-fcs"]', [fileOf("D1.fcs", Uint8Array.from([1]))]);
    // The first tree, the default, cannot be converted: the dialog has nothing to compare.
    expect(dialog()!.textContent).not.toContain("each carry a spillover matrix");
    const importButton = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Import")!;
    await act(async () => { importButton.click(); });
    for (let i = 0; i < 6; i++) await settle();
    const rows = [...treePicker()!.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")];
    expect(rows.map((r) => r.disabled)).toEqual([true, false]);
    await act(async () => { rows[1].click(); });
    for (let i = 0; i < 6; i++) await settle();
    // The question, not the workspace's matrix applied as though it had been answered.
    expect(host.textContent).toContain("This FCS and the workspace each carry a spillover matrix, and they differ by up to 0.0500");
    expect(host.textContent).not.toContain('tree "CD4_positive", 2 of 2');
  });
});
