// @vitest-environment jsdom
// FCS export follows each file's own tree: a file tailored against the tree is written under its
// tailored gate, whichever tree is being viewed. Synthetic FCS files D1 and D2; nothing here is
// a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unzipSync } from "fflate";
import type { FcsFile } from "./engine/fcs";

const plotHarness: { props: Record<string, any> | null } = { props: null };
vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: Record<string, any>) => { plotHarness.props = props; return null; },
}));
// D1 holds 3 events at FSC-A 100..102, D2 4 events at 200..203; SSC-A is FSC-A + 10.
function syntheticFcs(seed: number): FcsFile {
  const count = seed === 1 ? 3 : 4;
  return {
    version: "FCS3.1",
    nEvents: count,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [
      Float32Array.from({ length: count }, (_, index) => seed * 100 + index),
      Float32Array.from({ length: count }, (_, index) => seed * 100 + index + 10),
    ],
    spillover: null,
  };
}
// One-byte "files" are the synthetic inputs; anything longer is a file the app wrote, parsed for real.
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return {
    ...actual,
    parseFcs: (buffer: ArrayBuffer) => buffer.byteLength === 1 ? syntheticFcs(new Uint8Array(buffer)[0]) : actual.parseFcs(buffer),
  };
});
import App from "./App";
import { parseFcs } from "./engine/fcs";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
const downloads: { name: string; blob: Blob }[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  downloads.length = 0;
  // The app hands each export to an anchor download; capture the blob instead of navigating.
  URL.createObjectURL = (blob: Blob) => { downloads.push({ name: "", blob }); return "blob:export"; };
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads[downloads.length - 1].name = this.download;
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); uuid = 0; });

function fcsFile(name: string, seed: number): File {
  const bytes = Uint8Array.from([seed]);
  const file = new File([bytes], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  return file;
}
async function settle(): Promise<void> { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); }
const fileRow = (name: string) => [...host.querySelectorAll<HTMLElement>(".gl-sample-row")].find((r) => r.textContent?.includes(name))!;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!;
const summary = () => host.querySelector(".population-tree-hierarchy-count")?.textContent;
const gate = () => plotHarness.props!.payload.gates[0];
async function view(name: string) { act(() => fileRow(name).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }))); await settle(); }
async function edit(mode: "tree" | "group" | "file") { act(() => host.querySelector<HTMLButtonElement>(`.population-tree-edit-${mode}`)!.click()); await settle(); }
function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Export the one population to separate files for every checked file; events per file name. */
async function exportSplit(): Promise<Record<string, number>> {
  const trigger = [...host.querySelectorAll<HTMLButtonElement>(".gl-menu-trigger")].find((b) => b.textContent?.includes("Export"))!;
  act(() => trigger.click());
  const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.trim() === "Export FCS…")!;
  act(() => item.click());
  await settle();
  const modal = host.querySelector(".gl-modal")!;
  // Only the drawn population is exported.
  const boxes = [...modal.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(boxes.length).toBeGreaterThan(0);
  boxes.forEach((box, index) => { if (box.checked !== (index === boxes.length - 1)) act(() => box.click()); });
  act(() => modal.querySelector<HTMLInputElement>('input[name="fcs-export-scope"][value="split"]')!.click());
  await settle();
  expect(modal.textContent).not.toContain("Calculating");
  act(() => button("Review export").click());
  await settle();
  const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Export \d+ FCS$/.test(b.textContent?.trim() ?? ""))!;
  const before = downloads.length;
  act(() => confirm.click());
  await settle();
  expect(downloads.length).toBe(before + 1);
  const { name, blob } = downloads[downloads.length - 1];
  expect(name).toMatch(/_by_sample\.zip$/);
  const files = unzipSync(await blobBytes(blob));
  const counts: Record<string, number> = {};
  for (const [fileName, bytes] of Object.entries(files)) {
    counts[fileName] = parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).nEvents;
  }
  return counts;
}
const countFor = (counts: Record<string, number>, stem: string) => counts[Object.keys(counts).find((k) => k.startsWith(stem))!];

describe("FCS export under tailored trees", () => {
  it("writes each file under the tree it follows, whichever tree is viewed", async () => {
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find((i) => !i.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(input, "files", { configurable: true, value: [fcsFile("D1.fcs", 1), fcsFile("D2.fcs", 2)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    // Vertices arrive in display space (scatter shows arcsinh at cofactor 150): the tree's gate
    // holds every event of both files.
    act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices: [[0, 0], [300, 300]], x_channel: "FSC-A", y_channel: "SSC-A" }));
    // The gate dialog makes a population only when asked.
    act(() => host.querySelector<HTMLInputElement>('.gl-modal input[type="checkbox"]')!.click());
    act(() => button("Create").click());
    await settle();
    const treeGate = structuredClone(gate().vertices);

    // D2 tailors the gate to end between its second and third event (asinh(201/150) = 1.1024,
    // asinh(202/150) = 1.1068); D1 keeps following the tree.
    await view("D2.fcs");
    await edit("file");
    act(() => plotHarness.props!.onGateEdit({ gate_id: gate().gate_id, vertices: [[0, 0], [1.1046, 300]] }));
    await settle();
    expect(summary()).toBe("2 files · 1 tailored");
    expect(gate().vertices).not.toEqual(treeGate);

    // Viewing D1 (the tree is live): D2, which follows its own copy, is written under that copy.
    await view("D1.fcs");
    expect(gate().vertices).toEqual(treeGate);
    const fromTree = await exportSplit();
    expect(Object.keys(fromTree).length).toBe(2);
    expect(countFor(fromTree, "D1")).toBe(3);
    expect(countFor(fromTree, "D2")).toBe(2);

    // Viewing D2 (its copy is live): D1 is written under the tree, not the copy.
    await view("D2.fcs");
    expect(gate().vertices).not.toEqual(treeGate);
    const fromCopy = await exportSplit();
    expect(countFor(fromCopy, "D1")).toBe(3);
    expect(countFor(fromCopy, "D2")).toBe(2);
  });
});
