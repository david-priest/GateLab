// @vitest-environment jsdom
// A FlowJo import compensates a file with the workspace's spillover matrix where the two differ,
// and the gates were drawn under that matrix. A portable copy of the import reopened with the
// file's own matrix, since nothing in the saved workspace said which matrix it was: every
// fluorescence gate was evaluated on other values (on a public FlowJo workspace, 51,715 events in
// a gate became 51,860). The copy now carries the matrix, and reopening installs it again.
// Synthetic names and matrices.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { FcsFile } from "./engine/fcs";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));
// The file's own matrix: BV786 into APC at 0.30, where the workspace's says 0.25. Compensated with
// the workspace's, APC-A is about 50.6, 354 and 0 for the three events; with the file's, 0, 305 and
// -51. A gate from 25 up holds two events under the workspace's matrix and one under the file's.
// The workspace's matrix names PE-A too, which spills into BV786-A alone; uncompensated, APC-A
// holds three events there.
const syntheticFcs: FcsFile = {
  version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {},
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    { index: 2, name: "BV786-A", marker: null, bits: 32, range: 262144 },
    { index: 3, name: "APC-A", marker: null, bits: 32, range: 262144 },
    { index: 4, name: "PE-A", marker: null, bits: 32, range: 262144 },
  ],
  columns: [Float32Array.from([10, 20, 30]), Float32Array.from([100, 200, 300]), Float32Array.from([1000, 1000, 1000]), Float32Array.from([300, 600, 250]), Float32Array.from([50, 50, 50])],
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
const WSP = `<?xml version="1.0"?>
<Workspace xmlns:gating="${G}" xmlns:transforms="${T}" xmlns:data-type="${D}"><SampleList><Sample><DataSet uri="file:D1.fcs"/>
  <transforms:spilloverMatrix spectral="0" prefix="Comp-" suffix="" name="Matrix_A">
    <data-type:parameters><data-type:parameter data-type:name="BV786-A"/><data-type:parameter data-type:name="APC-A"/><data-type:parameter data-type:name="PE-A"/></data-type:parameters>
    <transforms:spillover data-type:parameter="BV786-A">
      <transforms:coefficient data-type:parameter="BV786-A" transforms:value="1"/>
      <transforms:coefficient data-type:parameter="APC-A" transforms:value="0.25"/>
      <transforms:coefficient data-type:parameter="PE-A" transforms:value="0"/>
    </transforms:spillover>
    <transforms:spillover data-type:parameter="APC-A">
      <transforms:coefficient data-type:parameter="BV786-A" transforms:value="0.05"/>
      <transforms:coefficient data-type:parameter="APC-A" transforms:value="1"/>
      <transforms:coefficient data-type:parameter="PE-A" transforms:value="0"/>
    </transforms:spillover>
    <transforms:spillover data-type:parameter="PE-A">
      <transforms:coefficient data-type:parameter="BV786-A" transforms:value="0.1"/>
      <transforms:coefficient data-type:parameter="APC-A" transforms:value="0"/>
      <transforms:coefficient data-type:parameter="PE-A" transforms:value="1"/>
    </transforms:spillover>
  </transforms:spilloverMatrix>
  <SampleNode name="D1.fcs" count="3"><Subpopulations>
    <Population name="CD8_positive" count="2"><Gate><gating:RectangleGate gating:id="g1">
      <gating:dimension gating:min="0" gating:max="1000"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
      <gating:dimension gating:min="25" gating:max="100000"><data-type:fcs-dimension data-type:name="Comp-APC-A"/></gating:dimension>
    </gating:RectangleGate></Gate></Population>
  </Subpopulations></SampleNode>
</Sample></SampleList></Workspace>`;

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
let saved: Blob | null = null;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  // No File System Access in jsdom: a portable copy is downloaded, and the download is kept here.
  saved = null;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (blob: Blob) => { saved = blob; return "blob:saved"; } });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
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
  // A bundle is read as a stream, which jsdom's File does not have.
  Object.defineProperty(file, "stream", { value: () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice()); c.close(); } }) });
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
async function clickButton(text: string, within: ParentNode = host): Promise<void> {
  const button = [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
  expect(button, text).toBeTruthy();
  await act(async () => { button.click(); });
  for (let i = 0; i < 6; i++) await settle();
}
/** The count the population tree shows for a population. */
function countOf(name: string): string | null {
  const row = [...host.querySelectorAll<HTMLElement>(".pop-row-count")]
    .map((el) => el.parentElement!)
    .find((r) => r.textContent?.includes(name));
  return row?.querySelector(".pop-row-count")?.textContent ?? null;
}
async function bytesOf(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
  return new Uint8Array(buffer);
}

describe("a portable copy of a compensated FlowJo import", () => {
  it("reopens with the workspace's matrix the gates were drawn under, not the file's own", async () => {
    act(() => root.render(<App />));
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", WSP)]);
    await feed('input[data-role="flowjo-workspace-fcs"]', [fileOf("D1.fcs", Uint8Array.from([1, 2, 3]))]);
    const dialog = host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]')!;
    // The two matrices differ; the answer defaults to the workspace's.
    expect(dialog.textContent).toContain("each carry a spillover matrix");
    await clickButton("Import", dialog);
    expect(countOf("CD8_positive")).toBe("2");

    await clickButton("Save Portable Copy…");
    expect(saved).not.toBeNull();
    const bundle = await bytesOf(saved!);
    // The copy carries the matrix as the workspace supplied it, and says a GateLab needs it.
    const workspace = JSON.parse(strFromU8(unzipSync(bundle)["workspace.json"]));
    expect(workspace.version).toBe(4);
    expect(workspace.requiredFeatures).toContain("external-spillover");
    expect(workspace.samples[0].externalSpillover).toEqual({ label: "Matrix_A", channels: ["BV786-A", "APC-A", "PE-A"], matrix: [[1, 0.25, 0], [0.05, 1, 0], [0.1, 0, 1]] });
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy-bundle.gatelab", bundle)]);
    expect(host.textContent).toContain("Opened strategy-bundle.gatelab");
    // Under the file's own matrix the gate holds one event.
    expect(countOf("CD8_positive")).toBe("2");
  });

  // A saved matrix naming a parameter the file lacks (here a hand edit renames APC-A) was installed
  // without it, and the file reopened compensated otherwise, with no word. The record says what it
  // left out on its file, so the open is refused and says why.
  it("is refused on reopening where the saved matrix would leave out a parameter it compensated", async () => {
    act(() => root.render(<App />));
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", WSP)]);
    await feed('input[data-role="flowjo-workspace-fcs"]', [fileOf("D1.fcs", Uint8Array.from([1, 2, 3]))]);
    await clickButton("Import", host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]')!);
    await clickButton("Save Portable Copy…");
    const entries = unzipSync(await bytesOf(saved!));
    const workspace = JSON.parse(strFromU8(entries["workspace.json"]));
    workspace.samples[0].externalSpillover.channels = ["BV786-A", "APC-X", "PE-A"];
    const edited = zipSync({ ...entries, "workspace.json": strToU8(JSON.stringify(workspace)) });
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("edited-bundle.gatelab", edited as Uint8Array<ArrayBuffer>)]);
    expect(host.textContent).toContain(`was compensated with the spillover matrix "Matrix_A", saved with the workspace, which cannot be applied to it: "Matrix_A" no longer applies to this file as it did when the workspace was saved: APC-X is not a fluorescence parameter of this file.`);
    expect(host.textContent).toContain("The current workspace was not changed.");
    expect(host.textContent).not.toContain("Opened edited-bundle.gatelab");
    expect(countOf("CD8_positive")).toBe("2");
  });
});
