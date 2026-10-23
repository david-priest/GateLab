// @vitest-environment jsdom
// Per-gate tailoring scope: each gate, on the viewed file, uses the tree's version, its group's or
// the file's own, and a drag changes the version in scope. "Tailor for {file}" or "Tailor for
// {group}", then a drag, is the only way to start tailoring; Revert and Use for restore and share.
// Synthetic FCS files; nothing here is a real experiment. Scatter opens linear, so coordinates are
// raw values: a file of seed 1 holds three events at 100 to 112, one of seed 2 four at 200 to 213.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import { paletteColors } from "./engine/palettes";
import { hierarchyColour } from "./engine/hierarchies";

const plotHarness: { props: Record<string, any> | null } = { props: null };
vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: Record<string, any>) => { plotHarness.props = props; return null; },
}));
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
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: (buffer: ArrayBuffer) => syntheticFcs(new Uint8Array(buffer)[0]) };
});
import App from "./App";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  plotHarness.props = null;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); plotHarness.props = null; uuid = 0; });

function fcsFile(name: string, seed: number): File {
  const bytes = Uint8Array.from([seed]);
  const file = new File([bytes], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  return file;
}
async function settle(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}
const fileRow = (name: string) => [...host.querySelectorAll<HTMLElement>(".gl-sample-row")].find((r) => r.textContent?.includes(name))!;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button:not(.gl-menu-trigger)")].find((b) => b.textContent?.trim() === label);
const summary = () => host.querySelector(".gl-sample-tree-summary")?.getAttribute("title") ?? undefined;
const payload = () => plotHarness.props!.payload;
const cells = () => payload().gates.find((g: { name: string }) => g.name.startsWith("Cells"));
const chip = () => host.querySelector(".gate-scope-chip")?.textContent ?? null;
/** Cells' tailoring switch for the viewed file, and its label. */
const cellsSwitch = () => host.querySelector<HTMLInputElement>(".gate-card .gate-tailor-switch input")!;
const switchLabel = () => host.querySelector(".gate-card .gate-tailor-switch-label")?.textContent ?? null;
/** Cells tailored for the viewed file: a click unless it is the file's own already (a group's version reads on too). */
async function switchOn() { if (switchLabel() !== "this file") act(() => cellsSwitch().click()); await settle(); }
const references = (): { vertices: [number, number][]; color: string }[] => payload().gate_references ?? [];
const badge = (name: string) => fileRow(name).querySelector(".gl-sample-tailored")?.textContent ?? null;
async function view(name: string) { act(() => fileRow(name).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }))); await settle(); }
async function drag(vertices: [number, number][]) { act(() => plotHarness.props!.onGateEdit({ gate_id: cells().gate_id, vertices })); await settle(); }
async function undo() { act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); }); await settle(); }
/** Cells' menu, opened by a right-click on its row in the gate list, and one item of it. */
async function menu(item: string) {
  act(() => host.querySelector<HTMLElement>(".gate-card")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
  await settle();
  const entry = host.querySelector<HTMLButtonElement>(`.${item}`);
  if (!entry) throw new Error(`No ${item} in the gate's menu`);
  act(() => entry.click());
  await settle();
}
/** The Cells population's count for a file, viewed: its own gate's, whichever version that is. */
async function countOf(name: string): Promise<number> {
  await view(name);
  const row = [...host.querySelectorAll(".pop-row")].find((r) => r.textContent?.includes("Cells"))!;
  return Number(/\+([\d,]+)\(/.exec(row.textContent!.replace(/\s+/g, ""))![1].replace(/,/g, ""));
}
async function counts(names: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of names) out[name] = await countOf(name);
  return out;
}
/** The file list's Select all box set to `on`: a click toggles all and none, and from some it selects all. */
function selectAll(on: boolean): void {
  const box = () => host.querySelector<HTMLInputElement>(".gl-sample-select-all input")!;
  if (box().checked !== on || box().indeterminate) act(() => box().click());
  if (!on && box().checked) act(() => box().click());
}
/** Exactly these files selected, then a group of them named `name`. */
async function groupOf(name: string, files: string[]) {
  selectAll(false); await settle();
  for (const file of files) act(() => fileRow(file).dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })));
  await settle();
  act(() => host.querySelector<HTMLButtonElement>(".gl-sample-group-new")!.click()); await settle();
  const input = host.querySelector<HTMLInputElement>(".gl-modal input")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name); input.dispatchEvent(new Event("input", { bubbles: true })); });
  act(() => button("Create")!.click()); await settle();
  selectAll(true); await settle();
}

async function load(files: [string, number][]) {
  act(() => root.render(<App />));
  const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find((i) => !i.hasAttribute("webkitdirectory"))!;
  Object.defineProperty(input, "files", { configurable: true, value: files.map(([name, seed]) => fcsFile(name, seed)) });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  for (let i = 0; i < 200 && host.querySelectorAll(".gl-sample-row").length < files.length; i++) await settle();
  // Gates open black; the versions' colours are part of what this checks, so Coloured gates on.
  act(() => host.querySelector<HTMLInputElement>(".gl-coloured-gates")!.click());
  act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices: [[0, 0], [188.08, 188.08]], x_channel: "FSC-A", y_channel: "SSC-A" }));
  const name = [...host.querySelectorAll("label")].find((l) => l.textContent?.includes("Gate name:"))!.querySelector("input")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Cells"); name.dispatchEvent(new Event("input", { bubbles: true })); });
  const createPop = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((i) => i.parentElement?.textContent?.includes("Also create a population"))!;
  if (!createPop.checked) act(() => createPop.click());
  act(() => button("Create")!.click());
  await settle();
}

describe("per-gate tailoring scope", () => {
  it("drags the version in scope: the tree's for every file following it, a group's for its files, a file's for itself", async () => {
    const files = ["D1.fcs", "D2.fcs", "D3.fcs", "D4.fcs"];
    await load([["D1.fcs", 1], ["D2.fcs", 1], ["D3.fcs", 2], ["D4.fcs", 2]]);
    await groupOf("Treated", ["D3.fcs", "D4.fcs"]);
    expect(await counts(files)).toEqual({ "D1.fcs": 3, "D2.fcs": 3, "D3.fcs": 0, "D4.fcs": 0 });

    // The tree's scope: a drag on D1 changes every file.
    await view("D1.fcs");
    await drag([[0, 0], [250, 250]]);
    expect(await counts(files)).toEqual({ "D1.fcs": 3, "D2.fcs": 3, "D3.fcs": 4, "D4.fcs": 4 });
    await undo();
    expect(await counts(files)).toEqual({ "D1.fcs": 3, "D2.fcs": 3, "D3.fcs": 0, "D4.fcs": 0 });

    // The group's scope: Tailor for Treated on D3, then a drag, changes D3 and D4 only.
    await view("D3.fcs");
    await menu("scope-menu-tailor-group");
    await drag([[150, 150], [250, 250]]);
    expect(await counts(files)).toEqual({ "D1.fcs": 3, "D2.fcs": 3, "D3.fcs": 4, "D4.fcs": 4 });
    expect(summary()).toBe("4 files · 2 tailored by groups");
    // A drag on a file that follows the tree still changes the tree, not the group.
    await view("D2.fcs");
    await drag([[0, 0], [105, 105]]);
    expect(await counts(files)).toEqual({ "D1.fcs": 0, "D2.fcs": 0, "D3.fcs": 4, "D4.fcs": 4 });

    // The file's scope: Tailor for D4, then a drag, tailors exactly one gate of one file.
    await view("D4.fcs");
    // The group's version is in use: the switch is on, in the group's colour. A click on it still
    // means this file: it tailors D4 alone.
    expect(switchLabel()).toBe("Treated");
    expect(cellsSwitch().checked).toBe(true);
    await switchOn();
    await drag([[0, 0], [1, 1]]);
    expect(await counts(files)).toEqual({ "D1.fcs": 0, "D2.fcs": 0, "D3.fcs": 4, "D4.fcs": 0 });
    expect(summary()).toBe("4 files · 1 tailored, 1 by groups");
    expect([badge("D1.fcs"), badge("D2.fcs"), badge("D3.fcs"), badge("D4.fcs")]).toEqual([null, null, null, "1"]);
    // Its dashed outline is what it reverts to: the group's, not the tree's.
    await view("D4.fcs");
    expect(switchLabel()).toBe("this file");
    expect(references()[0].vertices[0]).toEqual([150, 150]);

    // Revert puts D4 back on its group's version.
    await menu("tailored-menu-revert");
    expect(await counts(files)).toEqual({ "D1.fcs": 0, "D2.fcs": 0, "D3.fcs": 4, "D4.fcs": 4 });
    expect(badge("D4.fcs")).toBeNull();
    // Use for the tree, on the group's version: the tree takes it, and every file follows.
    await view("D3.fcs");
    await menu("tailored-menu-use");
    act(() => button("Use for the tree")!.click()); await settle();
    expect(await counts(files)).toEqual({ "D1.fcs": 0, "D2.fcs": 0, "D3.fcs": 4, "D4.fcs": 4 });
    await view("D1.fcs");
    expect(cells().vertices[0]).toEqual([150, 150]);
    expect(summary()).toBe("4 files · all following");
  });

  it("ten files, none on the tree's Cells: one tailors on its own, two groups tailor theirs; single and pooled views", async () => {
    const groupA = ["A1.fcs", "A2.fcs", "A3.fcs", "A4.fcs", "A5.fcs"];
    const groupB = ["B1.fcs", "B2.fcs", "B3.fcs", "B4.fcs"];
    const all = ["D1.fcs", ...groupA, ...groupB];
    await load(all.map((name) => [name, 1] as [string, number]));
    await groupOf("Group A", groupA);
    await groupOf("Group B", groupB);
    // Group A and group B each tailor Cells from one of their files; D1 on its own.
    await view("A1.fcs"); await menu("scope-menu-tailor-group"); await drag([[10, 10], [150, 150]]);
    await view("B1.fcs"); await menu("scope-menu-tailor-group"); await drag([[20, 20], [150, 150]]);
    await view("D1.fcs"); await switchOn(); await drag([[30, 30], [150, 150]]);
    expect(summary()).toBe("10 files · 1 tailored, 9 by groups");
    // Each switch names the version in scope on that file, and agrees with the file badge.
    await view("A3.fcs"); expect(switchLabel()).toBe("Group A"); expect(badge("A3.fcs")).toBeNull();
    await view("B2.fcs"); expect(switchLabel()).toBe("Group B");
    await view("D1.fcs"); expect(switchLabel()).toBe("this file"); expect(cellsSwitch().checked).toBe(true); expect(badge("D1.fcs")).toBe("1");

    // Pooled, viewed from D1: its own Cells solid; every other version dashed, one outline each,
    // the tree's grey since no pooled file follows it.
    act(() => host.querySelector<HTMLButtonElement>(".gl-pool-toggle [aria-checked=false]")!.click());
    await settle(8);
    expect(cells().vertices[0]).toEqual([30, 30]);
    expect(references()).toHaveLength(3);
    const colours = references().map((ref) => ref.color);
    expect(colours).toContain(hierarchyColour(0));
    expect(colours).toContain(hierarchyColour(1));
    expect(colours).toContain("#9aa1ab");
    const note = host.querySelector(".gl-plot-note-pool")?.textContent ?? "";
    expect(note).toContain("Solid: D1.fcs's version, which a drag edits; dashed: Group A (5 files), Group B (4 files), the tree.");
    expect(note).toContain("No pooled file follows the tree's Cells gate (grey).");
    expect(chip()).toBe("+3 versions");
    // A click on A2, in the pool: group A's version solid, D1's dashed in its pool colour.
    act(() => fileRow("A2.fcs").click()); await settle(3);
    expect(cells().vertices[0]).toEqual([10, 10]);
    expect(references().map((ref) => ref.color)).toContain(paletteColors("default", 10)[0]);
    expect(switchLabel()).toBe("Group A");
  });
});
