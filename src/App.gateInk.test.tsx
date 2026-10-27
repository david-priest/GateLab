// @vitest-environment jsdom
// The Display popover's "Coloured gates" and "Gate line width": the plot's payload carries the ink
// and the width while the gates keep their colours, and both survive a saved workspace. Synthetic
// FCS files D1 to D3; nothing here is a real experiment. Scatter opens linear, so the coordinates
// below are raw values.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
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
  plotHarness.props = null;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); plotHarness.props = null; uuid = 0; });

function fileOf(name: string, content: Uint8Array<ArrayBuffer>): File {
  const file = new File([content], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => content.slice().buffer });
  // A bundle is read as a stream, which jsdom's File does not have.
  Object.defineProperty(file, "stream", { value: () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(content.slice()); c.close(); } }) });
  return file;
}
async function settle(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}
async function feed(selector: string, files: File[]): Promise<void> {
  const input = [...host.querySelectorAll<HTMLInputElement>(selector)].find((i) => !i.hasAttribute("webkitdirectory"))!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle(4);
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
const fileRow = (name: string) => [...host.querySelectorAll<HTMLElement>(".gl-sample-row")].find((r) => r.textContent?.includes(name))!;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button:not(.gl-menu-trigger)")].find((b) => b.textContent?.trim() === label);
const payload = () => plotHarness.props!.payload;
const gateColours = (): string[] => payload().gates.map((g: { color: string }) => g.color);
const referenceColours = (): string[] => (payload().gate_references ?? []).map((g: { color: string }) => g.color);
const swatches = () => [...host.querySelectorAll<HTMLElement>(".gate-color-swatch")].map((s) => s.style.background);
const colouredSwitch = () => host.querySelector<HTMLInputElement>(".gl-coloured-gates")!;
const widthSlider = () => host.querySelector<HTMLInputElement>(".gl-gate-line-width input[type=range]")!;
function setRange(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function view(name: string) { act(() => fileRow(name).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }))); await settle(); }

/** D1 to D3 loaded, gates "Cells" and "Other" drawn for the tree, and D2 tailoring "Cells". */
async function workspace() {
  act(() => root.render(<App />));
  await feed('input[type="file"][accept=".fcs"]', [fileOf("D1.fcs", Uint8Array.from([1])), fileOf("D2.fcs", Uint8Array.from([2])), fileOf("D3.fcs", Uint8Array.from([1]))]);
  for (let i = 0; i < 100 && host.querySelectorAll(".gl-sample-row").length < 3; i++) await settle();
  const draw = async (name: string, vertices: [number, number][]) => {
    act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices, x_channel: "FSC-A", y_channel: "SSC-A" }));
    const nameInput = [...host.querySelectorAll("label")].find((l) => l.textContent?.includes("Gate name:"))!.querySelector("input")!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput, name); nameInput.dispatchEvent(new Event("input", { bubbles: true })); });
    const createPop = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((i) => i.parentElement?.textContent?.includes("Also create a population"))!;
    if (!createPop.checked) act(() => createPop.click());
    act(() => button("Create")!.click());
    await settle();
  };
  await draw("Cells", [[0, 0], [188, 188]]);
  await draw("Other", [[0, 0], [300, 300]]);
  act(() => [...host.querySelectorAll<HTMLElement>(".pop-row")].find((r) => r.textContent?.includes("All Events"))!.click()); await settle();
  await view("D2.fcs");
  const card = [...host.querySelectorAll<HTMLElement>(".gate-card")].find((c) => c.textContent?.startsWith("Cells"))!;
  act(() => card.querySelector<HTMLInputElement>(".gate-tailor-switch input")!.click()); await settle();
  const cells = payload().gates.find((g: { name: string }) => g.name.startsWith("Cells"));
  act(() => plotHarness.props!.onGateEdit({ gate_id: cells.gate_id, vertices: [[150, 150], [250, 250]] })); await settle();
}

const pills = () => [...host.querySelectorAll<HTMLElement>(".pop-tree-gate-badge")].map((p) => p.style.getPropertyValue("--gate-colour"));
const backingSlider = () => host.querySelector<HTMLInputElement>(".gl-gate-label-background input[type=range]");
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

describe("coloured gates, gate line width and label background", () => {
  it("opens black everywhere: the plot's gates and dashed versions in black, no swatches in the gate list, neutral pills; coloured on shows the gates' own colours", async () => {
    await workspace();
    expect(colouredSwitch().checked).toBe(false);
    expect(colouredSwitch().getAttribute("role")).toBe("switch");
    expect(gateColours()).toEqual(["#000000", "#000000"]);
    expect(referenceColours()).toEqual(["#555555"]);
    expect(payload().gate_style).toEqual({ pub_style: true, label_background: 0.85 });
    // No swatch in the gate list at all; the pills stay, neutral.
    expect(swatches()).toEqual([]);
    expect(host.querySelectorAll(".gate-card").length).toBeGreaterThan(0);
    expect(pills().length).toBeGreaterThan(0);
    expect(new Set(pills())).toEqual(new Set(["#4a5361"]));
    // Off, the pills are the neutral tint; on, each is solid in its gate's colour.
    const pillClasses = () => [...host.querySelectorAll<HTMLElement>(".pop-tree-gate-badge")].map((p) => p.classList.contains("is-coloured"));
    expect(pillClasses().every((c) => !c)).toBe(true);

    act(() => colouredSwitch().click()); await settle();
    const own = gateColours();
    expect(own).toHaveLength(2);
    expect(own.every((c) => c !== "#000000")).toBe(true);
    expect(referenceColours()[0]).not.toBe("#555555");
    expect(payload().gate_style.pub_style).toBe(false);
    // The list and the pills show the same colours the plot does.
    expect(new Set(swatches())).toEqual(new Set(own.map(rgb)));
    expect(new Set(pills()).has("#4a5361")).toBe(false);
    expect(pillClasses().every(Boolean)).toBe(true);
    // Off again: the gates kept their colours throughout.
    act(() => colouredSwitch().click()); await settle();
    act(() => colouredSwitch().click()); await settle();
    expect(gateColours()).toEqual(own);
  });

  it("hands the renderer the chosen width, 1.2 among them, and the reset returns it to 1.2", async () => {
    await workspace();
    const reset = host.querySelector<HTMLButtonElement>(".gl-gate-line-width-reset")!;
    expect(reset.disabled).toBe(true);
    setRange(widthSlider(), "3"); await settle();
    expect(payload().gate_line_width).toBe(3);
    expect(host.querySelector(".gl-gate-line-width output")?.textContent).toBe("3.0");
    expect(reset.disabled).toBe(false);
    setRange(widthSlider(), "1.4"); await settle();
    expect(payload().gate_line_width).toBe(1.4);
    act(() => reset.click()); await settle();
    expect(payload().gate_line_width).toBe(1.2);
    expect(widthSlider().value).toBe("1.2");
  });

  it("offers the label background only for black gates, and hands it to the renderer", async () => {
    await workspace();
    expect(backingSlider()!.value).toBe("85");
    setRange(backingSlider()!, "40"); await settle();
    expect(payload().gate_style).toEqual({ pub_style: true, label_background: 0.4 });
    expect(host.querySelector(".gl-gate-label-background output")?.textContent).toBe("40%");
    act(() => host.querySelector<HTMLButtonElement>(".gl-gate-label-background-reset")!.click()); await settle();
    expect(payload().gate_style.label_background).toBe(0.85);
    act(() => colouredSwitch().click()); await settle();
    expect(backingSlider()).toBeNull();
  });

  it("is one setting for every tab: the Strategy and Illustration boxes show it and switch it", async () => {
    // jsdom has no canvas; the figures' points are not what this reads.
    const noop = new Proxy({}, { get: (_t, key) => (key === "getImageData" || key === "createImageData" ? () => ({ data: new Uint8ClampedArray(4) }) : key === "measureText" ? () => ({ width: 10 }) : () => undefined), set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => noop) as never);
    await workspace();
    const mirror = () => host.querySelector<HTMLInputElement>(".gl-coloured-gates-mirror");
    for (const tab of ["Strategy", "Illustration"]) {
      const tabButton = [...host.querySelectorAll<HTMLButtonElement>(".gl-tabs button, [role=tab]")].find((b) => b.textContent?.trim() === tab);
      expect(tabButton, tab).toBeTruthy();
      if (!tabButton) continue;
      act(() => tabButton.click()); await settle(2);
      // Illustration keeps it with the gates' other settings, under Style.
      const style = host.querySelector<HTMLButtonElement>("#figure-tab-style");
      if (style) { act(() => style.click()); await settle(); }
      expect(mirror(), tab).not.toBeNull();
      expect(mirror()!.checked, tab).toBe(colouredSwitch().checked);
      act(() => mirror()!.click()); await settle();
      expect(mirror()!.checked, tab).toBe(colouredSwitch().checked);
    }
    // Two flips from black: black again, as the Gating tab's switch says.
    expect(colouredSwitch().checked).toBe(false);
  });

  it("saves all three with the workspace's display settings and opens them again; an older workspace opens black at 1.2 and 85%", async () => {
    await workspace();
    act(() => colouredSwitch().click());
    setRange(widthSlider(), "2.4"); await settle();
    act(() => button("Save Portable Copy…")!.click()); await settle(6);
    expect(saved).not.toBeNull();
    const bundle = await bytesOf(saved!);
    const entries = unzipSync(bundle);
    const ws = JSON.parse(strFromU8(entries["workspace.json"]));
    expect(ws.display.colouredGates).toBe(true);
    expect(ws.display.gateLineWidth).toBe(2.4);
    expect(ws.display.gateLabelBackground).toBe(0.85);

    // Back to black and another width, then the saved copy opened over them.
    act(() => colouredSwitch().click());
    setRange(widthSlider(), "1"); await settle();
    await feed('input[accept=".gatelab,.wsp,.flowjo,.cef"]', [fileOf("copy.gatelab", bundle)]);
    await settle(4);
    expect(colouredSwitch().checked).toBe(true);
    expect(widthSlider().value).toBe("2.4");
    expect(payload().gate_line_width).toBe(2.4);
    expect(gateColours().every((c) => c !== "#000000")).toBe(true);

    // The same copy without the fields, as a workspace saved before them; and out-of-range values.
    delete ws.display.colouredGates;
    delete ws.display.gateLineWidth;
    delete ws.display.gateLabelBackground;
    const older = zipSync({ ...entries, "workspace.json": strToU8(JSON.stringify(ws)) }) as Uint8Array<ArrayBuffer>;
    await feed('input[accept=".gatelab,.wsp,.flowjo,.cef"]', [fileOf("older.gatelab", older)]);
    await settle(4);
    expect(colouredSwitch().checked).toBe(false);
    expect(payload().gate_line_width).toBe(1.2);
    expect(payload().gate_style).toEqual({ pub_style: true, label_background: 0.85 });
    ws.display.gateLineWidth = 12;
    ws.display.gateLabelBackground = 4;
    const wide = zipSync({ ...entries, "workspace.json": strToU8(JSON.stringify(ws)) }) as Uint8Array<ArrayBuffer>;
    await feed('input[accept=".gatelab,.wsp,.flowjo,.cef"]', [fileOf("wide.gatelab", wide)]);
    await settle(4);
    expect(payload().gate_line_width).toBe(4);
    expect(payload().gate_style.label_background).toBe(1);
  });

  it("deselects the gate when the plot reports a click on its empty area, and the gate list's highlight clears", async () => {
    await workspace();
    const cells = payload().gates.find((g: { name: string }) => g.name.startsWith("Cells"));
    act(() => plotHarness.props!.onGateSelect(cells.gate_id)); await settle();
    expect(payload().selected_gate_id).toBe(cells.gate_id);
    expect(host.querySelector(".gate-card.selected, .gate-card[aria-selected=true], .gate-card.is-selected")).not.toBeNull();
    act(() => plotHarness.props!.onGateDeselect()); await settle();
    expect(payload().selected_gate_id ?? null).toBeNull();
    expect(host.querySelector(".gate-card.selected, .gate-card[aria-selected=true], .gate-card.is-selected")).toBeNull();
  });
});

describe("the plot toolbar's \"?\"", () => {
  it("opens the pan and stretch hint on a click", async () => {
    await workspace();
    const help = host.querySelector<HTMLButtonElement>('button[aria-label="Help: Plot hints"]')!;
    expect(help).not.toBeNull();
    act(() => help.click());
    const items = [...document.querySelectorAll(".gl-help-hint-popover li")].map((li) => li.textContent);
    expect(items).toContain("drag the margin to pan");
    expect(items).toContain("shift-drag it to stretch");
  });
});
