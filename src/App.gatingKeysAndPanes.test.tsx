// @vitest-environment jsdom
//
// Keyboard and layout details of the Gating tab: Escape closes a dialog, Delete or Backspace
// deletes the selected gate (Undo restores it), each message also shows at the top of the centre
// pane, and the Panel and Metadata tabs give their tables the width the gate pane took.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import type { NewGate } from "./plots/GatingPlot";

interface CapturedPlotProps {
  payload: { gates: { gate_id: string; name: string }[] };
  onNewGate: (gate: NewGate) => void;
}
const plotHarness = vi.hoisted(() => ({ props: null as CapturedPlotProps | null }));
vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: CapturedPlotProps) => {
    plotHarness.props = props;
    return <div data-testid="gating-plot" />;
  },
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
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  plotHarness.props = null;
  uuid = 0;
});

function testFile(name: string, seed: number): File {
  const bytes = Uint8Array.from([seed]);
  const file = new File([bytes], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  return file;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);

const tab = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>(".gl-tabs button")].find((b) => b.textContent?.trim() === label)!;

function key(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}

async function openTwoFiles(): Promise<void> {
  act(() => root.render(<App />));
  const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
    .find((candidate) => !candidate.hasAttribute("webkitdirectory"))!;
  Object.defineProperty(input, "files", { configurable: true, value: [testFile("D1.fcs", 1), testFile("D2.fcs", 2)] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  expect(host.querySelectorAll(".gl-sample-row")).toHaveLength(2);
}

const drawRectangle = () =>
  act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices: [[0, 0], [1000, 1000]], x_channel: "FSC-A", y_channel: "SSC-A" }));

describe("Gating tab keyboard and layout", () => {
  it("closes the gate-naming dialog on Escape without making the gate", async () => {
    await openTwoFiles();
    drawRectangle();
    expect(host.textContent).toContain("Name this gate");
    expect(key({ key: "Escape" }).defaultPrevented).toBe(true);
    await settle();
    expect(host.textContent).not.toContain("Name this gate");
    expect(plotHarness.props!.payload.gates).toHaveLength(0);
  });

  it("deletes the selected gate on Delete or Backspace, not while typing, and Undo restores it", async () => {
    await openTwoFiles();
    drawRectangle();
    act(() => button("Create")!.click());
    await settle();
    expect(plotHarness.props!.payload.gates).toHaveLength(1);
    if (!host.querySelector(".gate-card.selected")) act(() => host.querySelector<HTMLElement>(".gate-card")!.click());
    expect(host.querySelector(".gate-card.selected")).not.toBeNull();

    // Typed into a field, the key edits the field and the gate stays.
    const field = document.createElement("input");
    host.appendChild(field);
    expect(key({ key: "Backspace" }, field).defaultPrevented).toBe(false);
    field.remove();
    await settle();
    expect(plotHarness.props!.payload.gates).toHaveLength(1);

    expect(key({ key: "Delete" }).defaultPrevented).toBe(true);
    await settle();
    expect(plotHarness.props!.payload.gates).toHaveLength(0);
    expect(host.querySelector(".gl-action-note")?.textContent).toContain("Deleted gate");

    key({ key: "z", metaKey: true });
    await settle();
    expect(plotHarness.props!.payload.gates).toHaveLength(1);

    // Backspace is the same key; a held key repeating does not reach the gate.
    if (!host.querySelector(".gate-card.selected")) act(() => host.querySelector<HTMLElement>(".gate-card")!.click());
    key({ key: "Backspace", repeat: true });
    await settle();
    expect(plotHarness.props!.payload.gates).toHaveLength(1);
    key({ key: "Backspace" });
    await settle();
    expect(plotHarness.props!.payload.gates).toHaveLength(0);
  });

  it("opens each list's right-click menu, and Delete in the tree deletes populations, not the gate", async () => {
    await openTwoFiles();
    drawRectangle();
    act(() => button("Create")!.click());
    await settle();
    const rightClick = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); });
    const item = (cls: string) => host.querySelector<HTMLButtonElement>(`.gl-context-menu .${cls}`)!;
    const rows = () => [...host.querySelectorAll<HTMLElement>(".pop-row")];
    const dialogButton = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => b.textContent?.trim() === label)!;

    // The gate's menu: New population from it opens the dialog with the gate ticked.
    const gateName = plotHarness.props!.payload.gates[0].name;
    const before = rows().length;
    rightClick(host.querySelector(".gate-card")!);
    expect(item("gate-row-delete")).not.toBeNull();
    act(() => item("gate-row-new-population").click());
    await settle();
    const ticked = [...host.querySelectorAll<HTMLInputElement>(".gl-modal input[type=checkbox]")].filter((box) => box.checked);
    expect(ticked).toHaveLength(1);
    expect(ticked[0].closest("div")?.textContent).toContain(gateName);
    act(() => dialogButton("Create").click());
    await settle();
    expect(rows()).toHaveLength(before + 1);
    const added = rows()[rows().length - 1];

    // A population's menu: Delete asks first.
    rightClick(added);
    act(() => item("pop-row-delete").click());
    await settle();
    expect(host.textContent).toContain("Delete populations?");
    act(() => dialogButton("Cancel").click());
    await settle();

    // Delete in the focused tree deletes the highlighted row at once; the gate stays; Undo restores.
    act(() => rows()[rows().length - 1].click());
    const tree = host.querySelector<HTMLElement>("#population_tree_container")!;
    expect(key({ key: "Delete" }, tree).defaultPrevented).toBe(true);
    await settle();
    expect(rows()).toHaveLength(before);
    expect(plotHarness.props!.payload.gates).toHaveLength(1);
    expect(host.querySelector(".gl-action-note")?.textContent).toContain("Deleted population");
    key({ key: "z", metaKey: true });
    await settle();
    expect(rows()).toHaveLength(before + 1);
  });

  it("hides the Gates and Populations pane on the Panel and Metadata tabs", async () => {
    await openTwoFiles();
    const side = () => host.querySelector<HTMLElement>("aside.gl-side")!;
    expect(side().style.display).toBe("");
    act(() => tab("Panel").click());
    expect(side().style.display).toBe("none");
    act(() => tab("Metadata").click());
    expect(side().style.display).toBe("none");
    act(() => tab("Gating").click());
    expect(side().style.display).toBe("");
  });
});
