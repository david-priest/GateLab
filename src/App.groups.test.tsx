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
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!;
const summary = () => host.querySelector(".population-tree-hierarchy-count")?.textContent;
const pressed = () => ["tree", "group", "file"].find((m) => host.querySelector(`.population-tree-edit-${m}`)?.getAttribute("aria-pressed") === "true");
const gate = () => plotHarness.props!.payload.gates[0];
async function view(name: string) { act(() => fileRow(name).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }))); await settle(); }
async function edit(mode: "tree" | "group" | "file") { act(() => host.querySelector<HTMLButtonElement>(`.population-tree-edit-${mode}`)!.click()); await settle(); }
function toggle(name: string) { act(() => fileRow(name).dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }))); }

describe("groups", () => {
  it("makes a group of the selected files, tailors gates for the group, and lets a file tailor against it", async () => {
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find((i) => !i.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(input, "files", { configurable: true, value: [fcsFile("D1.fcs", 1), fcsFile("D2.fcs", 2), fcsFile("D3.fcs", 2)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
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
    expect(fileRow("D1.fcs").querySelector(".gl-sample-group")?.textContent).toBe("Treated");
    expect(fileRow("D2.fcs").querySelector(".gl-sample-group")?.textContent).toBe("Treated");
    expect(fileRow("D3.fcs").querySelector(".gl-sample-group")).toBeNull();
    expect(host.querySelector('select[aria-label="Hierarchy"]')).toBeNull();

    // Viewing a grouped file offers the group as an edit target; the tree stays live until chosen.
    await view("D1.fcs");
    expect(host.querySelector(".population-tree-edit-group")?.textContent).toBe("Treated · 2 files");
    expect(pressed()).toBe("tree");
    await edit("group");
    expect(pressed()).toBe("group");
    expect(host.textContent).toContain("Editing Treated");
    act(() => plotHarness.props!.onGateEdit({ gate_id: gate().gate_id, vertices: [[0.3, 0.3], [0.8, 0.8]] }));
    await settle();
    const groupGate = structuredClone(gate().vertices);
    expect(groupGate).not.toEqual(treeGate);
    // The group's files follow the group; the tree and D3 keep the tree's gate.
    await view("D2.fcs"); expect(pressed()).toBe("group"); expect(gate().vertices).toEqual(groupGate);
    await view("D3.fcs"); expect(pressed()).toBe("tree"); expect(gate().vertices).toEqual(treeGate);
    expect(host.querySelector(".population-tree-edit-group")).toBeNull();
    await edit("tree");
    expect(host.querySelector(".gate-tailored-in")?.textContent).toBe("tailored in 1 files");
    expect(host.querySelector(".gate-tailored-in")?.getAttribute("title")).toBe("Treated");
    // Nothing is tailored per file: the group carries it.
    expect(summary()).toBe("3 files · all following");
    expect(fileRow("D1.fcs").querySelector(".gl-sample-tailored")).toBeNull();

    // A file of the group tailors against the group, and its buttons name the group.
    await view("D1.fcs");
    await edit("file");
    expect(pressed()).toBe("file");
    act(() => plotHarness.props!.onGateEdit({ gate_id: gate().gate_id, vertices: [[0.4, 0.4], [0.9, 0.9]] }));
    await settle();
    expect(summary()).toBe("3 files · 1 tailored");
    expect(fileRow("D1.fcs").querySelector(".gl-sample-tailored")?.textContent).toBe("1");
    expect(host.querySelector(".population-tree-promote")?.textContent).toBe("Use for Treated…");
    expect(host.querySelector(".gate-apply-group")?.textContent).toBe("Apply to Treated");
    expect(host.querySelector(".population-tree-revert-group")?.textContent).toBe("Revert D1.fcs to Treated");
    // Reverting the file lands on the group's gate, not the tree's.
    act(() => host.querySelector<HTMLButtonElement>(".population-tree-revert-group")!.click()); await settle();
    expect(summary()).toBe("3 files · all following");
    expect(gate().vertices).toEqual(groupGate);
    expect(host.textContent).toContain('D1.fcs follows "Treated" again');

    // The group itself can be reverted to the tree, and deleted; its files then follow the tree.
    await edit("group");
    act(() => host.querySelector<HTMLButtonElement>(".population-tree-revert-groupcopy")!.click()); await settle();
    expect(gate().vertices).toEqual(treeGate);
    expect(host.textContent).toContain('"Treated" follows the tree again');
    act(() => host.querySelector<HTMLButtonElement>(".gl-sample-group-delete")!.click()); await settle();
    expect(host.textContent).toContain("Delete group");
    act(() => button("Delete").click()); await settle();
    expect(host.querySelector(".gl-sample-group")).toBeNull();
    expect(host.querySelector(".population-tree-edit-group")).toBeNull();
    expect(pressed()).toBe("tree");
    expect(host.textContent).toContain('Group "Treated" deleted');
  });
});
