// @vitest-environment jsdom
// A tailored gate in the Gating tab: the plot draws the version the viewed file is gated with,
// tags it, draws the tree's dashed beside it and edits that version, whatever the edit target;
// pooled, the tree's gate is drawn and edited and each file's own is dashed in its colour.
// Synthetic FCS files D1 to D3; nothing here is a real experiment. Scatter opens linear, so the
// coordinates below are raw values: D1 and D3 hold events at 100 to 112, D2 at 200 to 213.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import { paletteColors } from "./engine/palettes";

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
/** A gate on the plot by the name it was drawn with (the dialog names it "<name> gate"). */
const gate = (name: string) => payload().gates.find((g: { name: string }) => g.name.startsWith(name));
const references = (): { vertices: [number, number][]; color: string }[] => payload().gate_references ?? [];
const status = () => host.querySelector(".gl-gate-status")?.textContent;
const chip = () => host.querySelector(".gate-scope-chip")?.textContent ?? null;
const badge = (name: string) => fileRow(name).querySelector(".gl-sample-tailored")?.textContent ?? null;
/** Selects a gate as a click on its card in the gate list does. */
function selectGate(name: string) { act(() => [...host.querySelectorAll<HTMLElement>(".gate-card")].find((c) => c.textContent?.startsWith(name))!.click()); }
const popCount = (name: string) => [...host.querySelectorAll(".pop-row")].find((r) => r.textContent?.includes(name))?.querySelector(".pop-row-count")?.textContent;
async function view(name: string) { act(() => fileRow(name).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }))); await settle(); }
const card = (name: string) => [...host.querySelectorAll<HTMLElement>(".gate-card")].find((c) => c.textContent?.startsWith(name))!;
/** A gate's tailoring switch for the viewed file, by the gate's name. */
const tailorSwitch = (name: string) => card(name).querySelector<HTMLInputElement>(".gate-tailor-switch input")!;
const switchLabel = (name: string) => card(name).querySelector(".gate-tailor-switch-label")?.textContent ?? null;
/** The gate's menu, opened by a right-click on its row. */
async function gateMenu(name: string) {
  act(() => card(name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))); await settle();
}
/** Tailoring for the viewed file (the row's switch on), or "Tailor for {group}" from the gate's menu. */
async function tailor(name: string, scope: "file" | "group" = "file") {
  if (scope === "file") { act(() => tailorSwitch(name).click()); await settle(); return; }
  await gateMenu(name);
  act(() => host.querySelector<HTMLButtonElement>(".scope-menu-tailor-group")!.click()); await settle();
}
async function undo() { act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); }); await settle(); }
async function drag(name: string, vertices: [number, number][]) {
  act(() => plotHarness.props!.onGateEdit({ gate_id: gate(name).gate_id, vertices }));
  await settle();
}

const TREE: [number, number][] = [[0, 0], [188.08, 188.08]];
const D2_OWN: [number, number][] = [[150, 150], [250, 250]];

/** D1 to D3 loaded, a gate "Cells" with its population drawn for the tree, and D2 tailoring it. */
async function workspaceWithD2Tailored(extraGate = false) {
  act(() => root.render(<App />));
  const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find((i) => !i.hasAttribute("webkitdirectory"))!;
  Object.defineProperty(input, "files", { configurable: true, value: [fcsFile("D1.fcs", 1), fcsFile("D2.fcs", 2), fcsFile("D3.fcs", 1)] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  for (let i = 0; i < 100 && host.querySelectorAll(".gl-sample-row").length < 3; i++) await settle();
  // Gates open black; the versions' colours are part of what this checks, so Coloured gates on.
  act(() => host.querySelector<HTMLInputElement>(".gl-coloured-gates")!.click());
  const draw = async (name: string, vertices: [number, number][]) => {
    act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices, x_channel: "FSC-A", y_channel: "SSC-A" }));
    const nameInput = [...host.querySelectorAll("label")].find((l) => l.textContent?.includes("Gate name:"))!.querySelector("input")!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput, name); nameInput.dispatchEvent(new Event("input", { bubbles: true })); });
    const createPop = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((i) => i.parentElement?.textContent?.includes("Also create a population"))!;
    if (!createPop.checked) act(() => createPop.click());
    act(() => button("Create")!.click());
    await settle();
  };
  await draw("Cells", TREE);
  if (extraGate) await draw("Other", [[0, 0], [300, 300]]);
  // All Events, so the plot draws both gates rather than the branch of the last one drawn.
  act(() => [...host.querySelectorAll<HTMLElement>(".pop-row")].find((r) => r.textContent?.includes("All Events"))!.click()); await settle();
  await view("D2.fcs");
  await tailor("Cells");
  await drag("Cells", D2_OWN);
  expect(summary()).toBe("3 files · 1 tailored");
  return { tree: structuredClone(gate("Cells").vertices), own: null as unknown };
}

/** The selected files (all, unless toggled) become a group named `name`. */
async function makeGroup(name: string) {
  act(() => host.querySelector<HTMLButtonElement>(".gl-sample-group-new")!.click()); await settle();
  const nameInput = host.querySelector<HTMLInputElement>(".gl-modal input")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput, name); nameInput.dispatchEvent(new Event("input", { bubbles: true })); });
  act(() => button("Create")!.click()); await settle();
}
function toggle(name: string) { act(() => fileRow(name).dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }))); }

describe("tailored gates in the Gating tab", () => {
  it("draws the file's own version on the tree, tagged, with the tree's dashed beside it, and counts the file's own gate", async () => {
    await workspaceWithD2Tailored();
    // The edit target is gone: each gate has its own scope.
    expect(host.querySelector(".population-tree-edit-target")).toBeNull();
    // D2: its own gate is drawn, holding its four events.
    const d2 = structuredClone(gate("Cells").vertices);
    expect(d2[0]).toEqual([150, 150]);
    expect(d2[2]).toEqual([250, 250]);
    expect(gate("Cells").percent_of_parent).toBe(100);
    expect(popCount("Cells")).toContain("4");
    expect(gate("Cells").tailored_tag).toBe("this file");
    expect(tailorSwitch("Cells").checked).toBe(true);
    expect(switchLabel("Cells")).toBe("this file");
    expect(chip()).toBeNull();
    expect(references()).toHaveLength(1);
    expect(references()[0].vertices[0]).toEqual([0, 0]);
    expect(references()[0].vertices[2]).toEqual([188.08, 188.08]);
    // Said in a few words in the top strip, for the selected gate only.
    selectGate("Cells"); await settle();
    expect(status()).toBe("Cells gate · this file's version · a drag changes this file");
    expect(host.querySelector(".gl-pool-toolbar .gl-gate-status")).not.toBeNull();
    act(() => plotHarness.props!.onGateSelect(null)); await settle();
    expect(status()).toBeUndefined();
    selectGate("Cells"); await settle();
    // D1 follows the tree: the tree's gate, no tag, nothing dashed.
    await view("D1.fcs");
    expect(gate("Cells").vertices[2]).toEqual([188.08, 188.08]);
    expect(gate("Cells").tailored_tag).toBeUndefined();
    // D1 follows the tree's Cells, which one other file tailors: said in the switch's tooltip, not a chip.
    expect(chip()).toBeNull();
    expect(card("Cells").querySelector(".gate-tailor-switch")?.getAttribute("title")).toMatch(/\nTailored in [^\n]+\.$/);
    expect(references()).toEqual([]);
    expect(gate("Cells").percent_of_parent).toBe(100);
    expect(status()).toBe("Cells gate · the tree's version · a drag changes every file following it");
    // The switch on for D1, then off again with no drag: D1 is tailored at once, then not, and
    // nothing asks first, since its coordinates never left the tree's.
    expect(tailorSwitch("Cells").checked).toBe(false);
    await tailor("Cells");
    expect(tailorSwitch("Cells").checked).toBe(true);
    expect(status()).toBe("Cells gate · this file's version · a drag changes this file");
    expect(summary()).toBe("3 files · 2 tailored");
    expect(badge("D1.fcs")).toBe("1");
    act(() => tailorSwitch("Cells").click()); await settle();
    expect(host.querySelector(".gl-modal")).toBeNull();
    expect(tailorSwitch("Cells").checked).toBe(false);
    expect(status()).toBe("Cells gate · the tree's version · a drag changes every file following it");
    expect(summary()).toBe("3 files · 1 tailored");
    expect(badge("D1.fcs")).toBeNull();
    // Flipping back shows D2's own again.
    await view("D2.fcs");
    expect(gate("Cells").vertices).toEqual(d2);
  });

  it("drags a tailored gate in the file's own version and sends any other gate to the tree", async () => {
    await workspaceWithD2Tailored(true);
    await drag("Cells", [[160, 160], [260, 260]]);
    expect(gate("Cells").vertices[0]).toEqual([160, 160]);
    expect(references()[0].vertices[2]).toEqual([188.08, 188.08]);
    expect(summary()).toBe("3 files · 1 tailored");
    // The tree's gate did not move.
    await view("D1.fcs");
    expect(gate("Cells").vertices[2]).toEqual([188.08, 188.08]);
    // A gate D2 does not tailor goes where the edit target sends edits: the tree, for every file.
    await view("D2.fcs");
    await drag("Other", [[0, 0], [290, 290]]);
    expect(gate("Other").tailored_tag).toBeUndefined();
    expect(gate("Other").vertices[2]).toEqual([290, 290]);
    await view("D1.fcs");
    expect(gate("Other").vertices[2]).toEqual([290, 290]);
    expect(summary()).toBe("3 files · 1 tailored");
    // One Undo per edit: the tree's gate first, then D2's own.
    await undo();
    expect(gate("Other").vertices[2]).toEqual([300, 300]);
    await view("D2.fcs");
    expect(gate("Cells").vertices[0]).toEqual([160, 160]);
    await undo();
    expect(gate("Cells").vertices[0]).toEqual([150, 150]);
  });

  it("pooled: draws the clicked file's version solid and edits it, dashes the others, and pools each file's own count", async () => {
    await workspaceWithD2Tailored();
    const button = host.querySelector<HTMLButtonElement>(".gl-pool-toggle [aria-checked=false]")!;
    act(() => button.click());
    await settle(6);
    // Pooled from D2: its own Cells solid, which a drag edits; the tree's, which D1 and D3 use, dashed.
    expect(gate("Cells").vertices[0]).toEqual([150, 150]);
    expect(gate("Cells").tailored_tag).toBe("this file");
    expect(tailorSwitch("Cells").checked).toBe(true);
    expect(references()).toHaveLength(1);
    expect(references()[0].vertices[2]).toEqual([188.08, 188.08]);
    expect(host.querySelector(".gl-plot-note-pool")?.textContent).toBe("Solid: D2.fcs's version, which a drag edits; dashed: the tree.");
    expect(chip()).toBe("+1 version");
    // Pooled over each file's own gate: D1 and D3 by the tree's (3 + 3), D2 by its own (4).
    expect(gate("Cells").percent_scope).toBe("pooled");
    expect(gate("Cells").percent_of_parent).toBe(100);
    expect(popCount("Cells")).toContain("10");
    // A drag edits D2's version; the tree's stays.
    await drag("Cells", [[160, 160], [260, 260]]);
    expect(gate("Cells").vertices[0]).toEqual([160, 160]);
    expect(references()[0].vertices[2]).toEqual([188.08, 188.08]);
    // A click on D1, in the pool: the tree's version solid, D2's dashed in its pool colour.
    act(() => fileRow("D1.fcs").click()); await settle(3);
    expect(host.textContent).toContain("Pooled view · 3 files");
    expect(gate("Cells").vertices[2]).toEqual([188.08, 188.08]);
    expect(references()).toHaveLength(1);
    expect(references()[0].vertices[0]).toEqual([160, 160]);
    expect(references()[0].color).toBe(paletteColors("default", 3)[1]);
    expect(host.querySelector(".gl-plot-note-pool")?.textContent).toBe("Solid: D1.fcs's version, which a drag edits; dashed: D2.fcs.");
    expect(tailorSwitch("Cells").checked).toBe(false);
    // A drag now edits the tree's version; D2's own is left as it is.
    await drag("Cells", [[0, 0], [120, 120]]);
    expect(gate("Cells").vertices[2]).toEqual([120, 120]);
    expect(references()[0].vertices[0]).toEqual([160, 160]);
  });

  it("offers Revert to the tree and Use for the tree from the tag, not per-row buttons, and holds the edit target", async () => {
    await workspaceWithD2Tailored();
    expect(host.querySelector(".gate-revert-group")).toBeNull();
    expect(host.querySelector(".gate-apply-group")).toBeNull();
    expect(button("Revert gate")).toBeUndefined();
    // The plot label's tag opens the menu.
    act(() => plotHarness.props!.onTailoredTag({ gate_id: gate("Cells").gate_id, client: [20, 20] }));
    await settle();
    expect(host.querySelector(".tailored-menu-revert")?.textContent).toBe("Revert to the tree");
    expect(host.querySelector(".tailored-menu-use")?.textContent).toBe("Use for the tree…");
    act(() => host.querySelector<HTMLButtonElement>(".tailored-menu-use")!.click());
    await settle();
    expect(host.textContent).toContain("Use these coordinates for the tree?");
    expect(summary()).toBe("3 files · 1 tailored");
    act(() => button("Use for the tree")!.click());
    await settle();
    expect(summary()).toBe("3 files · all following");
    await view("D1.fcs");
    expect(gate("Cells").vertices[0]).toEqual([150, 150]);
    await undo();
    expect(summary()).toBe("3 files · 1 tailored");
    // The gate list's tag opens the same menu; Revert puts D2 back on the tree's gate.
    await view("D2.fcs");
    await gateMenu("Cells");
    act(() => host.querySelector<HTMLButtonElement>(".tailored-menu-revert")!.click());
    await settle();
    expect(summary()).toBe("3 files · all following");
    expect(gate("Cells").vertices[2]).toEqual([188.08, 188.08]);
    expect(references()).toEqual([]);
    expect(host.textContent).toContain("on D2.fcs follows the tree again");
  });

  it("pooled: one dashed outline per version other than the clicked file's, coloured by its group or file, the tree's grey when no pooled file follows it", async () => {
    await workspaceWithD2Tailored();
    // D1 and D3 become a group that tailors Cells: then no file follows the tree's Cells.
    toggle("D2.fcs"); await settle();
    await makeGroup("Treated");
    await view("D1.fcs");
    await tailor("Cells", "group");
    await drag("Cells", [[50, 50], [180, 180]]);
    toggle("D2.fcs"); await settle();
    const pool = host.querySelector<HTMLButtonElement>(".gl-pool-toggle [aria-checked=false]")!;
    act(() => pool.click());
    await settle(6);
    // Viewed from D1: the group's version solid, which a drag edits; D2's and the tree's dashed.
    expect(gate("Cells").vertices[0]).toEqual([50, 50]);
    expect(switchLabel("Cells")).toBe("Treated");
    expect(references()).toHaveLength(2);
    const colours = references().map((ref) => ref.color);
    expect(colours).toContain(paletteColors("default", 3)[1]);
    expect(colours).toContain("#9aa1ab");
    const note = host.querySelector(".gl-plot-note-pool")?.textContent ?? "";
    expect(note).toContain("Solid: D1.fcs's version, which a drag edits; dashed: D2.fcs, the tree.");
    expect(note).toContain("No pooled file follows the tree's Cells gate (grey).");
    expect(chip()).toBe("+2 versions");
    // A drag edits the group's version: D3 follows it, D2 and the tree do not.
    await drag("Cells", [[40, 40], [180, 180]]);
    expect(gate("Cells").vertices[0]).toEqual([40, 40]);
    expect(references()).toHaveLength(2);
    act(() => fileRow("D3.fcs").click()); await settle(3);
    expect(gate("Cells").vertices[0]).toEqual([40, 40]);
  });

  it("has no tree row: its summary heads the file list, its actions are in the Populations menu, and plot labels carry no space badge", async () => {
    await workspaceWithD2Tailored();
    expect(host.querySelector(".population-tree-hierarchy, .gl-hierarchy-section")).toBeNull();
    expect(host.querySelector(".gl-sample-tree-summary")?.getAttribute("title") ?? undefined).toBe("3 files · 1 tailored");
    const menu = host.querySelector(".gl-pane-menu-populations")!;
    for (const cls of ["population-tree-rename", "population-tree-revert-group", "population-tree-revert-checked", "population-tree-revert-all"]) {
      expect(menu.querySelector(`.${cls}`), cls).not.toBeNull();
    }
    const gates = plotHarness.props!.payload.gates as { space_badge?: string; space_hint?: string }[];
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.every((g) => g.space_badge === undefined)).toBe(true);
  });

  it("hides the tailoring view on the plot and remembers it, leaving what is drawn, counted and edited as it was", async () => {
    await workspaceWithD2Tailored();
    const own = structuredClone(gate("Cells").vertices);
    expect(references()).toHaveLength(1);
    const show = () => host.querySelector<HTMLInputElement>(".gl-show-tailoring")!;
    // One control, in the Gates header, not among the plot's controls.
    expect(host.querySelectorAll(".gl-show-tailoring")).toHaveLength(1);
    expect(show().closest(".gl-pane-gates .gl-side-head")).not.toBeNull();
    expect(show().checked).toBe(true);
    act(() => show().click()); await settle();
    expect(window.localStorage.getItem("gatelab.showTailoring")).toBe("0");
    expect(references()).toEqual([]);
    expect(gate("Cells").tailored_tag).toBeUndefined();
    expect(gate("Cells").vertices).toEqual(own);
    expect(gate("Cells").percent_of_parent).toBe(100);
    // A drag still edits D2's own version, and the tree's stays.
    await drag("Cells", [[160, 160], [260, 260]]);
    expect(gate("Cells").vertices[0]).toEqual([160, 160]);
    await view("D1.fcs");
    expect(gate("Cells").vertices[2]).toEqual([188.08, 188.08]);
    // Remembered for this viewer: a fresh app opens with it hidden.
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find((i) => !i.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(input, "files", { configurable: true, value: [fcsFile("D1.fcs", 1)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    for (let i = 0; i < 100 && !host.querySelector(".gl-show-tailoring"); i++) await settle();
    expect(host.querySelector<HTMLInputElement>(".gl-show-tailoring")!.checked).toBe(false);
    window.localStorage.removeItem("gatelab.showTailoring");
  });
});

