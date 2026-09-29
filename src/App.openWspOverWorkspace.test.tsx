// @vitest-environment jsdom
// A FlowJo workspace opened with Open Workspace… while another workspace is open: a CyTOF file
// with a tree of its own. The .wsp's file is added beside it, and the import dialog asks how the
// FlowJo tree is applied to "All 2 files". Its structure differs from the workspace's tree, so it
// can only replace the tree for every file, and the dialog defaulted to Merge, marked recommended
// (David, 2026-09-29: "Replace should be the default here"). Then: a rectangle drawn after the
// import, before any save, is in the Gating-ML export. Synthetic files, gates and populations.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import type { NewGate } from "./plots/GatingPlot";

const plotHarness = vi.hoisted(() => ({ props: null as { onNewGate: (gate: NewGate) => void } | null }));
vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: { onNewGate: (gate: NewGate) => void }) => { plotHarness.props = props; return <div data-testid="gating-plot" />; },
}));
/** Byte 1: a CyTOF file. Any other: a flow file with scatter channels. */
function syntheticFcs(seed: number): FcsFile {
  if (seed === 1) {
    return {
      version: "FCS3.0", nEvents: 4, instrument: "cytof", keywords: {},
      channels: [
        { index: 0, name: "Ir191Di", marker: null, bits: 32, range: 65536 },
        { index: 1, name: "Pt195Di", marker: null, bits: 32, range: 65536 },
      ],
      columns: [Float32Array.from([1, 5, 50, 500]), Float32Array.from([2, 6, 60, 600])],
      spillover: null,
    };
  }
  return {
    version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from([10000, 20000, 30000]), Float32Array.from([10000, 20000, 30000])],
    spillover: null,
  };
}
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: (buffer: ArrayBuffer) => syntheticFcs(new Uint8Array(buffer)[0]) };
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
const polygon = (id: string, far = 40000) => `<gating:PolygonGate xmlns:gating="${G}" xmlns:data-type="${D}" quadId="-1" gateResolution="256" gating:id="${id}">
  <gating:dimension><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
  <gating:dimension><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
  <gating:vertex><gating:coordinate data-type:value="5000"/><gating:coordinate data-type:value="5000"/></gating:vertex>
  <gating:vertex><gating:coordinate data-type:value="${far}"/><gating:coordinate data-type:value="5000"/></gating:vertex>
  <gating:vertex><gating:coordinate data-type:value="${far}"/><gating:coordinate data-type:value="${far}"/></gating:vertex>
</gating:PolygonGate>`;
const transforms = `<Transformations>
  <transforms:linear xmlns:transforms="${T}" xmlns:data-type="${D}" transforms:minRange="0" transforms:maxRange="262144" transforms:gain="1"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
  <transforms:linear xmlns:transforms="${T}" xmlns:data-type="${D}" transforms:minRange="0" transforms:maxRange="262144" transforms:gain="1"><data-type:parameter data-type:name="SSC-A"/></transforms:linear>
</Transformations>`;
const sampleOf = (file: string, far = 40000) =>
  `<Sample><DataSet uri="file:${file}"/>${transforms}<SampleNode name="${file}" count="3"><Subpopulations>` +
  `<Population name="Cells" count="2"><Gate>${polygon("g1", far)}</Gate></Population></Subpopulations></SampleNode></Sample>`;
/** One sample, D2.fcs, on a flow file's scatter channels. */
const WSP = `<?xml version="1.0"?><Workspace><SampleList>${sampleOf("D2.fcs")}</SampleList></Workspace>`;
/** Two samples, each its own coordinates: one tree, tailored per file. */
const PER_FILE = `<?xml version="1.0"?><Workspace><SampleList>${sampleOf("D2.fcs")}${sampleOf("D3.fcs", 45000)}</SampleList></Workspace>`;

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  window.localStorage.clear();
  plotHarness.props = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
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
async function feed(selector: string, file: File | File[]): Promise<void> {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  Object.defineProperty(input, "files", { configurable: true, value: Array.isArray(file) ? file : [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle(); await settle(); await settle();
}
const button = (label: string, within: ParentNode = host) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
const openDialog = () => host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]');
const popRows = () => [...host.querySelectorAll(".pop-row")].map((r) => r.textContent?.replace(/\s+/g, " ").trim() ?? "");
const fileRow = (name: string) => [...host.querySelectorAll<HTMLElement>(".gl-sample-row")].find((row) => row.textContent?.includes(name))!;
const mode = (value: string) => host.querySelector<HTMLInputElement>(`input[name="gatingml-import-mode"][value="${value}"]`);
const target = (value: string) => host.querySelector<HTMLInputElement>(`input[name="gatingml-import-target"][value="${value}"]`);
const modalTitle = () => host.querySelector(".gl-modal-title")?.textContent ?? "";

async function view(name: string): Promise<void> {
  act(() => fileRow(name).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
  await settle();
}
async function loadFcs(name: string, byte: number): Promise<void> {
  const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find((c) => !c.hasAttribute("webkitdirectory"))!;
  Object.defineProperty(input, "files", { configurable: true, value: [fileOf(name, Uint8Array.from([byte]))] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle(); await settle();
}
/**
 * Draw a rectangle as the canvas reports one, and name it in the dialog it opens, with a
 * population; beneath `parent`, by its name in the dialog's list, where one is given.
 */
async function drawRectangle(name: string, vertices: [number, number][], x: string, y: string, parent?: string): Promise<void> {
  act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices, x_channel: x, y_channel: y }));
  const modal = host.querySelector<HTMLElement>(".gl-modal")!;
  const input = modal.querySelector<HTMLInputElement>("input:not([type])")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => modal.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  if (parent) {
    const select = modal.querySelector<HTMLSelectElement>("select")!;
    const option = [...select.options].find((o) => o.textContent === parent)!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, option.value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  act(() => button("Create", modal)!.click());
  await settle();
}
/** Open a .wsp with Open Workspace…, supply its FCS, and press the open dialog's Import. */
async function openWsp(wsp: string, fcs: [string, number][]): Promise<void> {
  await feed('input[accept=".gatelab,.wsp,.cef"]', fileOf("strategy.wsp", wsp));
  expect(openDialog()).not.toBeNull();
  await feed('input[data-role="flowjo-workspace-fcs"]', fcs.map(([name, byte]) => fileOf(name, Uint8Array.from([byte]))));
  await act(async () => { button("Import", openDialog()!)!.click(); });
  for (let i = 0; i < 6; i++) await settle();
}
async function confirmImport(): Promise<void> {
  const modal = host.querySelector<HTMLElement>(".gl-modal")!;
  await act(async () => { button("Import", modal)!.click(); });
  for (let i = 0; i < 6; i++) await settle();
}
/** Export GatingML… and its dialog's Export, as clicked, in the format given; the file it downloads. */
async function exportGatingMl(format: "standard" | "cytobank" = "standard"): Promise<string> {
  let saved: Blob | null = null;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (blob: Blob) => { saved = blob; return "blob:gatingml"; } });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
  act(() => button("Export GatingML…")!.click());
  await settle();
  expect(modalTitle()).toBe("Export GatingML");
  const select = host.querySelector(".gl-modal")!.querySelector<HTMLSelectElement>("select")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, format);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => button("Export", host.querySelector(".gl-modal")!)!.click());
  await settle();
  expect(saved).not.toBeNull();
  return await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result as string); r.readAsText(saved!); });
}
/** The names the export writes into each gate's custom_info: gates and populations. */
const namesIn = (xml: string) => [...xml.matchAll(/<name>([^<]*)<\/name>/g)].map((m) => m[1]);
const count = (xml: string, element: string) => (xml.match(new RegExp(`<gating:${element}\\b`, "g")) ?? []).length;

describe("opening a FlowJo workspace over a workspace whose tree differs", () => {
  it("defaults the import to Replace, marked recommended; a tree of the same structure keeps Merge", async () => {
    act(() => root.render(<App />));
    await loadFcs("C1.fcs", 1);
    await drawRectangle("DNA", [[0, 0], [3, 3]], "Ir191Di", "Pt195Di");
    expect(popRows().map((row) => row.slice(0, 3))).toEqual(["▾Al", "DNA"]);

    await openWsp(WSP, [["D2.fcs", 2]]);
    expect(modalTitle()).toBe("Import FlowJo workspace");
    expect(host.textContent).toContain("Which files should be gated with it?");
    expect(host.textContent).toContain("All 2 files");
    expect(target("viewed")!.disabled).toBe(true);
    expect(target("selected")!.disabled).toBe(true);
    expect(host.textContent).toContain("Its structure differs from this workspace's tree");
    // The default was Merge, marked recommended, which hangs the FlowJo tree beneath the CyTOF one.
    expect(mode("replace")!.checked).toBe(true);
    expect(mode("merge")!.checked).toBe(false);
    expect(host.textContent).toContain("Replace current strategy (recommended)");
    expect(host.textContent).not.toContain("Merge with current strategy (recommended)");
    await confirmImport();
    expect(host.querySelector(".gl-modal")).toBeNull();
    expect(host.textContent).toContain("current strategy replaced");
    expect(popRows().map((row) => row.slice(0, 5))).toEqual(["▾All ", "Cells"]);

    // The same FlowJo tree again, from the Import menu onto the loaded files: its structure is the
    // workspace's now, and Merge stays the default and the recommendation.
    await feed('input[accept=".xml,.wsp,.cef"]', fileOf("strategy.wsp", WSP));
    expect(modalTitle()).toBe("Import FlowJo workspace");
    expect(target("viewed")!.disabled).toBe(false);
    expect(mode("merge")!.checked).toBe(true);
    expect(host.textContent).toContain("Merge with current strategy (recommended)");
    expect(host.textContent).not.toContain("Replace current strategy (recommended)");
  });
});

// David's Gating-ML exports at 12:00 lacked a rectangle his saves at 12:02 held. The export writes
// the tree the viewed file follows as it is when Export is clicked, drawn gates included.
describe("Gating-ML export of a gate drawn after an import, before any save", () => {
  it("writes the rectangle, whichever file is viewed, after a Replace over a CyTOF workspace", async () => {
    act(() => root.render(<App />));
    await loadFcs("C1.fcs", 1);
    await drawRectangle("DNA", [[0, 0], [3, 3]], "Ir191Di", "Pt195Di");
    await openWsp(WSP, [["D2.fcs", 2]]);
    act(() => mode("replace")!.click());
    await confirmImport();
    await drawRectangle("Lymph", [[4.9, 4.9], [5.9, 5.9]], "FSC-A", "SSC-A");
    expect(popRows().some((row) => row.startsWith("Lymph"))).toBe(true);
    for (const viewed of ["D2.fcs", "C1.fcs"]) {
      await view(viewed);
      const xml = await exportGatingMl();
      expect(count(xml, "PolygonGate")).toBe(1);
      expect(count(xml, "RectangleGate")).toBe(1);
      expect(namesIn(xml)).toEqual(expect.arrayContaining(["Cells", "Lymph gate", "Lymph"]));
    }
  });

  it("writes the rectangle drawn on a file's own copy after a per-file import", async () => {
    act(() => root.render(<App />));
    await openWsp(PER_FILE, [["D2.fcs", 2], ["D3.fcs", 3]]);
    if (host.querySelector(".gl-modal")) await confirmImport();
    expect(host.querySelector(".population-tree-hierarchy-count")?.textContent).toBe("2 files · 1 tailored");
    await view("D3.fcs");
    act(() => host.querySelector<HTMLButtonElement>(".population-tree-edit-file")!.click());
    await settle();
    expect(host.querySelector(".population-tree-edit-file")!.getAttribute("aria-pressed")).toBe("true");
    await drawRectangle("Lymph", [[4.9, 4.9], [5.9, 5.9]], "FSC-A", "SSC-A");
    for (const viewed of ["D3.fcs", "D2.fcs"]) {
      await view(viewed);
      const xml = await exportGatingMl();
      expect(count(xml, "RectangleGate")).toBe(1);
      expect(namesIn(xml)).toEqual(expect.arrayContaining(["Cells", "Lymph gate", "Lymph"]));
    }
  });

  // A GateLab quadrant gate has no Gating-ML element, and the export leaves out every population
  // that references one, with everything beneath it (its dialog names them "dependent
  // populations"). A gate drawn beneath such a population is still written; only its population
  // is left out. So a quadrant above the rectangle explains a missing population, not a missing
  // RectangleGate.
  it("writes a rectangle drawn beneath a quadrant population, and leaves out only its population", async () => {
    act(() => root.render(<App />));
    await openWsp(WSP, [["D2.fcs", 2]]);
    if (host.querySelector(".gl-modal")) await confirmImport();
    act(() => plotHarness.props!.onNewGate({ gate_type: "quadrant", vertices: [[4.3, 4.3]], x_channel: "FSC-A", y_channel: "SSC-A" }));
    act(() => button("Create 4 populations", host.querySelector(".gl-modal")!)!.click());
    await settle();
    await drawRectangle("Lymph", [[4.1, 4.1], [4.6, 4.6]], "FSC-A", "SSC-A", "DP");
    expect(popRows().some((row) => row.startsWith("Lymph"))).toBe(true);
    for (const format of ["standard", "cytobank"] as const) {
      const xml = await exportGatingMl(format);
      expect(count(xml, "PolygonGate")).toBe(1);
      expect(count(xml, "RectangleGate")).toBe(1);
      expect(namesIn(xml)).toEqual(expect.arrayContaining(["Cells", "Lymph gate"]));
      expect(namesIn(xml)).not.toContain("Lymph");
      expect(namesIn(xml)).not.toContain("DP");
    }
  });
});
