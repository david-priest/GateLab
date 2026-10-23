// @vitest-environment jsdom
// Groups end to end: a named set of files with a tree of its own between the tree and the
// files. Synthetic FCS files D1 to D3; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";

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
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button:not(.gl-menu-trigger)")].find((b) => b.textContent?.trim() === label)!;
const summary = () => host.querySelector(".gl-sample-tree-summary")?.getAttribute("title") ?? undefined;
const chip = () => host.querySelector(".gate-scope-chip")?.textContent ?? null;
const gate = () => plotHarness.props!.payload.gates[0];
async function view(name: string) { act(() => fileRow(name).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }))); await settle(); }
/** The first gate's scope menu, opened by a right-click on its row. */
async function gateMenu() { act(() => host.querySelector<HTMLElement>(".gate-card")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))); await settle(); }
/** The first gate's tailoring switch on for the viewed file, or "Tailor for {group}" from its menu. */
async function tailor(scope: "file" | "group") {
  if (scope === "file") act(() => host.querySelector<HTMLInputElement>(".gate-card .gate-tailor-switch input")!.click());
  else { await gateMenu(); act(() => host.querySelector<HTMLButtonElement>(".scope-menu-tailor-group")!.click()); }
  await settle();
}
/** The first gate's switch label: "this file", the group's name ("Treated") when its version is used, or none. */
const switchLabel = () => host.querySelector(".gate-card .gate-tailor-switch-label")?.textContent ?? null;
function toggle(name: string) { act(() => fileRow(name).dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }))); }

describe("groups", () => {
  it("makes a group of the selected files, tailors gates for the group, and lets a file tailor against it", async () => {
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find((i) => !i.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(input, "files", { configurable: true, value: [fcsFile("D1.fcs", 1), fcsFile("D2.fcs", 2), fcsFile("D3.fcs", 2)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    // The files load one at a time, yielding between them: one settle was not always enough under
    // load, and the gate was then drawn before every file was in.
    for (let i = 0; i < 100 && host.querySelectorAll(".gl-sample-row").length < 3; i++) await settle();
    expect(host.querySelectorAll(".gl-sample-row")).toHaveLength(3);
    act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices: [[0, 0], [1.05, 1.05]], x_channel: "FSC-A", y_channel: "SSC-A" }));
    act(() => button("Create").click());
    await settle();
    const treeGate = structuredClone(gate().vertices);

    // D1 and D2 selected: a new group from them, named in the dialog.
    toggle("D3.fcs"); await settle();
    expect(host.textContent).toContain("2 of 3 selected");
    act(() => host.querySelector<HTMLButtonElement>(".gl-sample-group-new")!.click()); await settle();
    expect(host.textContent).toContain("New group");
    const nameInput = host.querySelector<HTMLInputElement>(".gl-modal input")!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput, "Treated"); nameInput.dispatchEvent(new Event("input", { bubbles: true })); });
    act(() => button("Create").click()); await settle();
    expect(host.textContent).toContain('Group "Treated" made with 2 files');
    const groupOf = (name: string) => fileRow(name).closest(".gl-sample-group-section")?.getAttribute("aria-label");
    expect([groupOf("D1.fcs"), groupOf("D2.fcs"), groupOf("D3.fcs")]).toEqual(["Treated", "Treated", "No group"]);
    expect(host.querySelector('select[aria-label="Hierarchy"]')).toBeNull();

    // A grouped file's gate menu offers the file and the group; the tree stays live.
    await view("D1.fcs");
    // The Gates header says the viewed file is in the group, in the group's colour.
    const viewedIn = host.querySelector<HTMLButtonElement>(".gl-pane-gates .gl-gates-viewed-group")!;
    expect(viewedIn.textContent).toBe("D1.fcs · in Treated");
    expect(viewedIn.style.getPropertyValue("--gl-group-colour")).toMatch(/^#[0-9a-f]{6}$/);
    // A click on it selects the group's files.
    const checkedRows = () => [...host.querySelectorAll(".gl-sample-row.included .gl-sample-name")].map((n) => n.textContent);
    toggle("D3.fcs"); await settle();
    expect(checkedRows()).toEqual(["D1.fcs", "D2.fcs", "D3.fcs"]);
    act(() => viewedIn.click()); await settle();
    expect(checkedRows()).toEqual(["D1.fcs", "D2.fcs"]);
    await gateMenu();
    expect([...host.querySelectorAll(".gl-context-menu [role='menuitem']")].map((b) => b.textContent)).toEqual(["Tailor for this file", "Tailor for Treated"]);
    // The row's ⋯ menu opens with the same choices, under Tailoring; the switch has no ▾ beside it.
    const rowMenu = host.querySelector(".gate-card .gate-row-menu")!;
    expect(rowMenu.querySelector(".gl-menu-section")?.textContent).toBe("Tailoring");
    expect([...rowMenu.querySelectorAll("[role='menuitem']")].slice(0, 2).map((b) => b.textContent)).toEqual(["Tailor for this file", "Tailor for Treated"]);
    expect(host.querySelector(".gate-tailor-choices-menu")).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>(".gl-context-menu .scope-menu-tailor-group")!.click()); await settle();
    // Asked for and not dragged: no chip; the switch in the group's colour, dashed, still off.
    expect(chip()).toBeNull();
    const sw = () => host.querySelector<HTMLElement>(".gate-card .gate-tailor-switch")!;
    expect(sw().classList.contains("is-pending")).toBe(true);
    expect(sw().querySelector("input")!.checked).toBe(false);
    expect(sw().style.getPropertyValue("--gl-switch-on")).toBe(viewedIn.style.getPropertyValue("--gl-group-colour"));
    expect(switchLabel()).toBe("Treated");
    expect(host.textContent).toContain("The next drag of");
    act(() => plotHarness.props!.onGateEdit({ gate_id: gate().gate_id, vertices: [[0.3, 0.3], [0.8, 0.8]] }));
    await settle();
    const groupGate = structuredClone(gate().vertices);
    expect(groupGate).not.toEqual(treeGate);
    // Tailored for the group: the switch is on, in the group's colour, named for the group.
    expect(chip()).toBeNull();
    expect(switchLabel()).toBe("Treated");
    expect(sw().classList.contains("is-pending")).toBe(false);
    expect(sw().querySelector("input")!.checked).toBe(true);
    expect(sw().style.getPropertyValue("--gl-switch-on")).toBe(viewedIn.style.getPropertyValue("--gl-group-colour"));
    // The group's files follow the group; D3 keeps the tree's gate, and its chip counts the group's files.
    await view("D2.fcs"); expect(gate().vertices).toEqual(groupGate); expect(switchLabel()).toBe("Treated");
    await view("D3.fcs"); expect(gate().vertices).toEqual(treeGate); expect(chip()).toBeNull();
    expect(host.querySelector(".gate-card .gate-tailor-switch")?.getAttribute("title")).toContain("Tailored in Treated (2 files).");
    // Nothing is tailored per file; the group carries it, and the summary says so.
    expect(summary()).toBe("3 files · 2 tailored by groups");
    expect(fileRow("D1.fcs").querySelector(".gl-sample-tailored")).toBeNull();

    // A file of the group tailors against the group, and its menus name the group.
    await view("D1.fcs");
    await tailor("file");
    act(() => plotHarness.props!.onGateEdit({ gate_id: gate().gate_id, vertices: [[0.4, 0.4], [0.9, 0.9]] }));
    await settle();
    expect(summary()).toBe("3 files · 1 tailored, 1 by groups");
    expect(fileRow("D1.fcs").querySelector(".gl-sample-tailored")?.textContent).toBe("1");
    expect(host.querySelector(".population-tree-promote")?.textContent).toBe("Use D1.fcs's gates for Treated…");
    // The gate's menu offers the group, not the tree, as what it reverts to and is used for.
    expect(switchLabel()).toBe("this file");
    await gateMenu();
    expect(host.querySelector(".gl-context-menu .tailored-menu-revert")?.textContent).toBe("Revert to Treated");
    expect(host.querySelector(".gl-context-menu .tailored-menu-use")?.textContent).toBe("Use for Treated\u2026");
    // The row's ⋯ menu offers the same entries.
    expect(host.querySelector(".gate-row-menu .tailored-menu-revert")?.textContent).toBe("Revert to Treated");
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); }); await settle();
    expect(host.querySelector(".gl-context-menu .tailored-menu-revert")).toBeNull();
    expect(host.querySelector(".population-tree-revert-group")?.textContent).toBe("Revert D1.fcs to Treated");
    // Reverting the file lands on the group's gate, not the tree's.
    act(() => host.querySelector<HTMLButtonElement>(".population-tree-revert-group")!.click()); await settle();
    expect(summary()).toBe("3 files · 2 tailored by groups");
    expect(gate().vertices).toEqual(groupGate);
    expect(host.textContent).toContain('D1.fcs follows "Treated" again');

    // The group itself can be reverted to the tree, and deleted; its files then follow the tree.
    act(() => host.querySelector<HTMLButtonElement>(".population-tree-revert-groupcopy")!.click()); await settle();
    expect(gate().vertices).toEqual(treeGate);
    expect(host.textContent).toContain('"Treated" follows the tree again');
    expect(summary()).toBe("3 files · all following");
    act(() => host.querySelector<HTMLButtonElement>(".gl-sample-group-delete")!.click()); await settle();
    expect(host.textContent).toContain("Delete group");
    act(() => button("Delete").click()); await settle();
    expect(host.querySelector(".gl-sample-group-section")).toBeNull();
    await gateMenu();
    expect(host.querySelector(".scope-menu-tailor-group")).toBeNull();
    expect(host.textContent).toContain('Group "Treated" deleted');
  });

  it("edits groups from the file list: right-click a file into a group and back, rename in place, revert, one Undo each", async () => {
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find((i) => !i.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(input, "files", { configurable: true, value: [fcsFile("D1.fcs", 1), fcsFile("D2.fcs", 2), fcsFile("D3.fcs", 2)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    for (let i = 0; i < 100 && host.querySelectorAll(".gl-sample-row").length < 3; i++) await settle();
    act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices: [[0, 0], [1.05, 1.05]], x_channel: "FSC-A", y_channel: "SSC-A" }));
    act(() => button("Create").click());
    await settle();
    const rowMenu = async (name: string) => {
      act(() => fileRow(name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
      await settle();
      return [...document.querySelectorAll<HTMLButtonElement>(".gl-context-menu [role='menuitem']")];
    };
    const groupOf = (name: string) => fileRow(name).closest(".gl-sample-group-section")?.getAttribute("aria-label") ?? null;

    // With every file checked, a checked row's menu is about all of them.
    let items = await rowMenu("D1.fcs");
    expect(items[0].textContent).toBe("New group from the 3 selected…");
    // A tab switch closes it, however it is made: here a click with no press before it, as the keyboard makes.
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.trim() === "Strategy")!.click()); await settle();
    expect(document.querySelector(".gl-context-menu")).toBeNull();
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.trim() === "Gating")!.click()); await settle();
    items = await rowMenu("D1.fcs");
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); }); await settle();
    // A plain click views D1 and checks it alone: "New group from this file…" makes a group of D1.
    act(() => fileRow("D1.fcs").click()); await settle();
    items = await rowMenu("D1.fcs");
    expect(items.map((b) => b.textContent)).toEqual(["New group from this file…"]);
    act(() => items[0].click()); await settle();
    const nameInput = host.querySelector<HTMLInputElement>(".gl-modal input")!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput, "Treated"); nameInput.dispatchEvent(new Event("input", { bubbles: true })); });
    act(() => button("Create").click()); await settle();
    expect([groupOf("D1.fcs"), groupOf("D2.fcs"), groupOf("D3.fcs")]).toEqual(["Treated", "No group", "No group"]);

    // D3 tailors its gate, then joins Treated from its right-click menu: its tailoring goes with it.
    await view("D3.fcs");
    await tailor("file");
    act(() => plotHarness.props!.onGateEdit({ gate_id: gate().gate_id, vertices: [[0.4, 0.4], [0.9, 0.9]] }));
    await settle();
    expect(fileRow("D3.fcs").querySelector(".gl-sample-tailored")?.textContent).toBe("1");
    items = await rowMenu("D3.fcs");
    expect(items.map((b) => b.textContent)).toEqual(["New group from this file…", "Add to Treated", "Remove from group", "Revert to the tree"]);
    expect(items[2].disabled).toBe(true);
    act(() => items[1].click()); await settle();
    expect(groupOf("D3.fcs")).toBe("Treated");
    expect(fileRow("D3.fcs").querySelector(".gl-sample-tailored")?.textContent).toBe("1");
    expect(host.textContent).toContain('D3.fcs now in "Treated"; it follows the group\'s gates; its own tailoring is kept. Undo is available.');
    // One Undo takes it back out.
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); }); await settle();
    expect(groupOf("D3.fcs")).toBe("No group");
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true, bubbles: true, cancelable: true })); }); await settle();
    expect(groupOf("D3.fcs")).toBe("Treated");

    // Renamed in place: double-click the header, type, Enter.
    act(() => host.querySelector<HTMLElement>('.gl-sample-group-section[aria-label="Treated"] .gl-sample-group-head')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))); await settle();
    const rename = host.querySelector<HTMLInputElement>(".gl-sample-group-name-input")!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(rename, "Treated B1"); });
    act(() => { rename.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }); await settle();
    expect(groupOf("D1.fcs")).toBe("Treated B1");
    expect(host.textContent).toContain('"Treated" is now "Treated B1". Undo is available.');

    // D3 reverts to what it follows, its group, from the same menu.
    items = await rowMenu("D3.fcs");
    const revert = items.find((b) => b.classList.contains("gl-file-menu-revert"))!;
    expect(revert.textContent).toBe("Revert to Treated B1");
    act(() => revert.click()); await settle();
    expect(fileRow("D3.fcs").querySelector(".gl-sample-tailored")).toBeNull();
    expect(groupOf("D3.fcs")).toBe("Treated B1");
  });
});
