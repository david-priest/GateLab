// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import { decodeFloat32Base64 } from "./engine/encode";
import type { NewGate } from "./plots/GatingPlot";

interface CapturedPlotProps {
  payload: {
    n_events: number;
    x_b64: string;
    y_b64: string;
    x_range: [number, number];
    y_range: [number, number];
    x_logicle_ticks: unknown;
    y_logicle_ticks: unknown;
    gates: { gate_id: string; name: string; vertices?: [number, number][]; percent_of_parent?: number | null; percent_scope?: string }[];
  };
  onNewGate: (gate: NewGate) => void;
  onGateEdit: (gate: { gate_id: string; vertices: [number, number][] }) => void;
}

const plotHarness = vi.hoisted(() => ({
  props: null as CapturedPlotProps | null,
}));

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: CapturedPlotProps) => {
    plotHarness.props = props;
    return <div data-testid="gating-plot" />;
  },
}));

function syntheticFcs(seed: number): FcsFile {
  // Seed 6 is a stained file with a spillover matrix, so it has a compensated view as well.
  if (seed === 6) {
    return {
      version: "FCS3.1",
      nEvents: 4,
      instrument: "flow",
      keywords: {},
      channels: [
        { index: 0, name: "FL1-A", marker: "CD3", bits: 32, range: 262144 },
        { index: 1, name: "FL2-A", marker: "CD19", bits: 32, range: 262144 },
      ],
      columns: [
        Float32Array.from([500, 4000, 30000, 200000]),
        Float32Array.from([300, 6000, 20000, 150000]),
      ],
      spillover: { channels: ["FL1-A", "FL2-A"], matrix: [[1, 0.5], [0.4, 1]] },
    };
  }
  const count = seed === 1 ? 3 : 4;
  // Seed 3 stands for a DIFFERENT panel: same detectors, a different stain on the second one.
  // That is the case that must not pool — a shared channel name is not a shared measurement.
  const secondMarker = seed === 3 ? "CD4" : null;
  return {
    version: "FCS3.1",
    nEvents: count,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: seed >= 4 ? "CD4-A" : "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: seed >= 4 ? "CD8-A" : "SSC-A", marker: secondMarker, bits: 32, range: 262144 },
    ],
    columns: [
      Float32Array.from({ length: count }, (_, index) => seed >= 4 ? (index + 1) * (seed === 4 ? 10000 : 1000000) : seed * 100 + index),
      Float32Array.from({ length: count }, (_, index) => seed >= 4 ? (index + 1) * (seed === 4 ? 20000 : 2000000) : seed * 100 + index + 10),
    ],
    spillover: null,
  };
}

vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return {
    ...actual,
    parseFcs: (buffer: ArrayBuffer) => syntheticFcs(new Uint8Array(buffer)[0]),
  };
});

import App from "./App";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", {
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  });
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
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => bytes.buffer.slice(0),
  });
  return file;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function plottedCount(): number {
  if (!plotHarness.props) throw new Error("Gating plot was not rendered");
  expect(decodeFloat32Base64(plotHarness.props.payload.x_b64)).toHaveLength(
    decodeFloat32Base64(plotHarness.props.payload.y_b64).length,
  );
  return plotHarness.props.payload.n_events;
}

function plottedX(): number[] {
  if (!plotHarness.props) throw new Error("Gating plot was not rendered");
  return [...decodeFloat32Base64(plotHarness.props.payload.x_b64)];
}

function plottedY(): number[] {
  if (!plotHarness.props) throw new Error("Gating plot was not rendered");
  return [...decodeFloat32Base64(plotHarness.props.payload.y_b64)];
}

function fileRow(name: string): HTMLElement {
  return [...host.querySelectorAll<HTMLElement>('.gl-sample-row')].find(row => row.textContent?.includes(name))!;
}
function clickButton(text: string): void {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  act(() => button.click());
}
async function poolFiles(edit = false): Promise<void> {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('Pool selected files'))!;
  act(() => button.click());
  await settle();
  if (edit) { clickButton('Edit the tree'); await settle(); }
}
function toggleFile(name: string): void {
  act(() => fileRow(name).dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })));
}
/** Enter inspects a file: it becomes the viewed one, a pool is left, the selection is untouched. */
async function view(name: string): Promise<void> {
  act(() => fileRow(name).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
  await settle();
}
async function editFile(): Promise<void> { act(() => host.querySelector<HTMLButtonElement>(".population-tree-edit-file")!.click()); await settle(); }
async function editTree(): Promise<void> { act(() => host.querySelector<HTMLButtonElement>(".population-tree-edit-tree")!.click()); await settle(); }
const editTarget = () => host.querySelector<HTMLButtonElement>(".population-tree-edit-file")!.getAttribute("aria-pressed") === "true" ? "file" : "tree";
const summary = () => host.querySelector(".population-tree-hierarchy-count")?.textContent;
const tailoredBadge = (name: string) => fileRow(name).querySelector(".gl-sample-tailored")?.textContent ?? null;
async function undo(): Promise<void> {
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); });
  await settle();
}

describe("App file selection and plot scope", () => {
  it("makes one file's gates the tree's: every file follows it, nothing is tailored, one Undo", async () => {
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find(i => !i.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(input, "files", { configurable: true, value: [testFile("D1.fcs", 1), testFile("D2.fcs", 2), testFile("D3.fcs", 2)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices: [[0, 0], [1.05, 1.05]], x_channel: "FSC-A", y_channel: "SSC-A" }));
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Create")!.click());
    await settle();
    const gate = () => plotHarness.props!.payload.gates[0];
    expect(summary()).toBe("3 files · all following");
    // Viewing a file leaves the tree live; tailoring is asked for.
    await view("D2.fcs");
    expect(editTarget()).toBe("tree");
    expect(host.textContent).toContain("Editing the tree");
    await editFile();
    expect(host.textContent).toContain("Editing D2.fcs only");
    act(() => plotHarness.props!.onGateEdit({ gate_id: gate().gate_id, vertices: [[0.3, 0.3], [0.8, 0.8]] }));
    await settle();
    const tailored = structuredClone(gate().vertices);
    expect(summary()).toBe("3 files · 1 tailored");
    expect(tailoredBadge("D2.fcs")).toBe("1");
    expect(tailoredBadge("D1.fcs")).toBeNull();
    // The tree's gate list says which file tailored the gate.
    await editTree();
    expect(host.querySelector(".gate-tailored-in")?.textContent).toBe("tailored in 1 files");
    expect(host.querySelector(".gate-tailored-in")?.getAttribute("title")).toBe("D2.fcs");
    await editFile();

    act(() => host.querySelector<HTMLButtonElement>(".population-tree-promote")!.click());
    await settle();
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Use for the tree")!.click());
    await settle();
    expect(summary()).toBe("3 files · all following");
    expect(host.textContent).toContain("now has D2.fcs's gate coordinates");
    // The mode holds: still D2 only, now on a copy with nothing tailored, carrying the tree's geometry.
    expect(editTarget()).toBe("file");
    expect(gate().vertices).toEqual(tailored);
    expect(tailoredBadge("D2.fcs")).toBeNull();
    await editTree();
    expect(gate().vertices).toEqual(tailored); // the tree carries D2's geometry
    expect(host.querySelector(".gate-tailored-in")).toBeNull();
    // Every file follows: D1 shows the tree's geometry, and no copy is made to show it.
    await view("D1.fcs");
    expect(gate().vertices).toEqual(tailored);
    expect(editTarget()).toBe("tree");
    expect(summary()).toBe("3 files · all following");
    await undo();
    expect(summary()).toBe("3 files · 1 tailored");
    expect(tailoredBadge("D2.fcs")).toBe("1");
    expect(editTarget()).toBe("tree"); // the mode is the user's, not the undo's
  });

  it("offers bulk revert, confirms the checked files, leaves unchecked tailoring intact, and one Undo brings it back", async () => {
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find(i => !i.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(input, "files", { configurable: true, value: [testFile("D1.fcs", 1), testFile("D2.fcs", 2), testFile("D3.fcs", 2)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices: [[0, 0], [1.05, 1.05]], x_channel: "FSC-A", y_channel: "SSC-A" }));
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Create")!.click());
    await settle();
    const gate = () => plotHarness.props!.payload.gates[0];
    const baseline = structuredClone(gate().vertices);
    const ids: string[] = [];
    const tailoredOf: Record<string, unknown> = {};
    await editFile(); // once: the mode holds from file to file
    for (const [i, name] of ["D1.fcs", "D2.fcs", "D3.fcs"].entries()) {
      await view(name);
      expect(editTarget()).toBe("file");
      ids.push(gate().gate_id);
      act(() => plotHarness.props!.onGateEdit({ gate_id: gate().gate_id, vertices: [[0.3 + i * 0.05, 0.3], [0.8, 0.8]] }));
      await settle();
      tailoredOf[name] = structuredClone(gate().vertices);
    }
    const tailored = tailoredOf["D3.fcs"];
    expect(summary()).toBe("3 files · 3 tailored");
    await editTree();
    toggleFile("D3.fcs");
    await settle();
    const revert = () => host.querySelector<HTMLButtonElement>(".population-tree-revert-checked")!;
    expect(revert().textContent).toBe("Revert 2 selected files…");
    act(() => revert().click()); await settle();
    const dialog = () => host.querySelector('[role="dialog"][aria-label="Revert files to the tree"]')!;
    expect([...dialog().querySelectorAll("li")].map(li => li.textContent)).toEqual(["D1.fcs", "D2.fcs"]);
    act(() => [...dialog().querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Cancel")!.click());
    await settle();
    // On the tree, a tailored file still shows the tree's gates; its own appear in file mode.
    await view("D1.fcs"); expect(editTarget()).toBe("tree"); expect(gate().vertices).toEqual(baseline);
    await editFile(); expect(gate().vertices).toEqual(tailoredOf["D1.fcs"]);
    await editTree();
    act(() => revert().click()); await settle();
    act(() => [...dialog().querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Revert listed files")!.click());
    await settle();
    expect(host.textContent).toContain("2 files follow the tree again");
    expect(gate().vertices).toEqual(baseline); // the tree unchanged
    expect(summary()).toBe("3 files · 1 tailored");
    expect(tailoredBadge("D1.fcs")).toBeNull();
    expect(tailoredBadge("D3.fcs")).toBe("1");
    // D1 and D2 follow the tree; D3 keeps its own, seen in file mode, where a following file
    // gets a quiet copy that carries the tree's geometry.
    await editFile();
    await view("D1.fcs"); expect(editTarget()).toBe("file"); expect(gate().vertices).toEqual(baseline); expect(gate().gate_id).not.toBe(ids[0]);
    await view("D2.fcs"); expect(editTarget()).toBe("file"); expect(gate().vertices).toEqual(baseline);
    await view("D3.fcs"); expect(editTarget()).toBe("file"); expect(gate().gate_id).toBe(ids[2]); expect(gate().vertices).toEqual(tailored);
    expect(summary()).toBe("3 files · 1 tailored");
    // Viewing files recorded nothing, so one Undo is the revert itself.
    await undo();
    expect(summary()).toBe("3 files · 3 tailored");
    await view("D1.fcs"); expect(gate().gate_id).toBe(ids[0]); expect(gate().vertices).toEqual(tailoredOf["D1.fcs"]);
    // Revert all files: every tailored file, after confirmation.
    act(() => host.querySelector<HTMLButtonElement>(".population-tree-revert-all")!.click()); await settle();
    expect([...dialog().querySelectorAll("li")].map(li => li.textContent)).toEqual(["D1.fcs", "D2.fcs", "D3.fcs"]);
    act(() => [...dialog().querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Revert listed files")!.click());
    await settle();
    expect(summary()).toBe("3 files · all following");
    expect(editTarget()).toBe("file"); // still the user's mode, on a copy with nothing tailored
  });

  it("applies one file's gate to the tree, and reverts one gate on a file", async () => {
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find(i => !i.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(input, "files", { configurable: true, value: [testFile("D1.fcs", 1), testFile("D2.fcs", 2), testFile("D3.fcs", 2)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices: [[0, 0], [1.05, 1.05]], x_channel: "FSC-A", y_channel: "SSC-A" }));
    const createPop = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(i => i.parentElement?.textContent?.includes("Also create a population"))!;
    if (!createPop.checked) act(() => createPop.click());
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Create")!.click());
    await settle();
    const gate = () => plotHarness.props!.payload.gates[0];
    const original = structuredClone(gate().vertices);
    await view("D1.fcs");
    await editFile();
    act(() => plotHarness.props!.onGateEdit({ gate_id: gate().gate_id, vertices: [[0.3, 0.3], [0.8, 0.8]] }));
    await settle();
    const first = structuredClone(gate().vertices);
    expect(summary()).toBe("3 files · 1 tailored");
    // Apply to tree: the tree takes D1's gate, every file follows, D1 is no longer tailored.
    act(() => host.querySelector<HTMLButtonElement>(".gate-apply-group")!.click());
    await settle();
    expect(summary()).toBe("3 files · all following");
    expect(host.querySelector(".gate-tailored-badge")).toBeNull();
    await view("D2.fcs"); expect(gate().vertices).toEqual(first); expect(editTarget()).toBe("file");
    await view("D3.fcs"); expect(gate().vertices).toEqual(first);
    // Tailor again and revert the one gate: back on the tree's coordinates, nothing tailored.
    await view("D1.fcs");
    act(() => plotHarness.props!.onGateEdit({ gate_id: gate().gate_id, vertices: [[0.4, 0.4], [0.9, 0.9]] }));
    await settle();
    expect(gate().vertices).not.toEqual(first);
    expect(summary()).toBe("3 files · 1 tailored");
    act(() => host.querySelector<HTMLButtonElement>(".gate-revert-group")!.click());
    await settle();
    expect(gate().vertices).toEqual(first);
    expect(host.querySelector(".gate-revert-group")).toBeNull();
    expect(summary()).toBe("3 files · all following");
    // Still D1 only, on a copy with nothing tailored; the mode holds from file to file, and
    // back on the tree D1 shows the tree's gate.
    expect(editTarget()).toBe("file");
    await view("D2.fcs");
    expect(editTarget()).toBe("file");
    await editTree();
    await view("D1.fcs");
    expect(editTarget()).toBe("tree");
    expect(gate().vertices).toEqual(first);
    expect(gate().vertices).not.toEqual(original);
    expect(summary()).toBe("3 files · all following");
  });

  it("locks fluorescence signal limits and tick positions, including after Reset", async () => {
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find(i => !i.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(input, "files", { configurable: true, value: [testFile("D1.fcs", 4), testFile("D2.fcs", 5)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    const row = (name: string) => [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(r => r.textContent?.includes(name))!;
    const frame = () => {
      const p = plotHarness.props!.payload;
      return structuredClone({ x: p.x_range, y: p.y_range, xt: p.x_logicle_ticks, yt: p.y_logicle_ticks });
    };
    act(() => row("D1.fcs").click());
    await settle();
    const first = frame();
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === "Lock scales between files")!.click());
    await settle();
    act(() => row("D2.fcs").click());
    await settle();
    expect(frame()).toEqual(first);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Reset X and Y ranges to auto"]')!.click());
    await settle();
    const resetFrame = frame();
    expect(resetFrame.x).not.toEqual(first.x);
    act(() => row("D1.fcs").click());
    await settle();
    expect(frame()).toEqual(resetFrame);
  });

  it("applies linear scatter scales to a sister FCS added after the scale change", async () => {
    act(() => root.render(<App />));
    const directInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(directInput, "files", {
      configurable: true,
      value: [testFile("sample-a.fcs", 1)],
    });
    await act(async () => {
      directInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();

    const xScale = host.querySelector<HTMLSelectElement>('select[aria-label="X scatter scale"]')!;
    const yScale = host.querySelector<HTMLSelectElement>('select[aria-label="Y scatter scale"]')!;
    await act(async () => {
      xScale.value = "linear";
      xScale.dispatchEvent(new Event("change", { bubbles: true }));
      yScale.value = "linear";
      yScale.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(plottedX()).toEqual([100, 101, 102]);
    expect(plottedY()).toEqual([110, 111, 112]);

    Object.defineProperty(directInput, "files", {
      configurable: true,
      value: [testFile("sample-b.fcs", 2)],
    });
    await act(async () => {
      directInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();

    await poolFiles();
    expect(plottedCount()).toBe(7);
    expect(plottedX()).toEqual([100, 101, 102, 200, 201, 202, 203]);
    expect(plottedY()).toEqual([110, 111, 112, 210, 211, 212, 213]);
  });

  // Refusing to pool across panels, rather than narrowing to the channels they share. Two panels
  // can put a different marker on the same detector, so pooling on a shared NAME draws one cloud
  // from two different stains and any gate on it means nothing in either.
  it("refuses to pool a checked file whose panel differs, and says so", async () => {
    act(() => root.render(<App />));
    const directInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(directInput, "files", {
      configurable: true,
      value: [testFile("panel-1.fcs", 1), testFile("panel-2.fcs", 3)],
    });
    await act(async () => {
      directInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();

    // Both checked, but only the primary contributes: the other panel is refused, not narrowed
    // to the channels the two happen to share. The primary is the most recently added file, so
    // panel-2's 4 events are drawn and panel-1's 3 are not — never the pooled 7.
    await poolFiles();
    expect(host.textContent).toContain("2 of 2 selected");
    expect(plottedCount()).toBe(4);
    expect(host.textContent).toContain("different panel");

    // Unchecking the primary leaves the mismatched file alone, which is fine — it simply becomes
    // the primary itself, and there is nothing left to refuse.
    act(() => fileRow("panel-1.fcs").click());
    await settle();
    expect(plottedCount()).toBe(3);
    expect(host.querySelector(".gl-pool-toolbar")?.textContent).toContain("Viewing: panel-1.fcs");
  });


  // The label on a gate sits on the pooled cloud, so its count pools the same files. Here the
  // blue file (sample-b, added last) has nothing inside the gate and sample-a has all three of
  // its events there: per file that is 0.0% under a cloud that is plainly not empty.
  it("pools the gate label and gate list counts across the checked files, and says so", async () => {
    act(() => root.render(<App />));
    const directInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(directInput, "files", {
      configurable: true,
      value: [testFile("sample-a.fcs", 1), testFile("sample-b.fcs", 2)],
    });
    await act(async () => {
      directInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();
    await poolFiles(true);
    expect(plottedCount()).toBe(7);

    act(() => plotHarness.props!.onNewGate({
      gate_type: "rectangle",
      vertices: [[0, 0], [1.05, 1.05]],
      x_channel: "FSC-A",
      y_channel: "SSC-A",
    }));
    const create = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Create")!;
    act(() => create.click());
    await settle();

    const plotGate = plotHarness.props!.payload.gates[0];
    expect(plotGate.percent_scope).toBe("pooled");
    expect(plotGate.percent_of_parent).toBe(42.86);
    expect(host.textContent).toContain("3 (42.86%) · pooled · 2 FCS");

    // Alone, the blue file's own count is exact and needs no qualifier.
    clickButton("Return to single file");
    await settle();
    expect(plottedCount()).toBe(4);
    expect(plotHarness.props!.payload.gates[0].percent_scope).toBeUndefined();
    expect(plotHarness.props!.payload.gates[0].percent_of_parent).toBe(0);
    expect(host.textContent).toContain("0 (0%)");
    expect(host.textContent).not.toContain("· pooled");
  });

  it("views a file on the tree, tailors it only on request, and pools every file under the tree", async () => {
    act(() => root.render(<App />));
    const directInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(directInput, "files", {
      configurable: true,
      value: [testFile("D1.fcs", 1), testFile("D2.fcs", 2)],
    });
    await act(async () => {
      directInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();

    act(() => plotHarness.props!.onNewGate({
      gate_type: "rectangle",
      vertices: [[0, 0], [1.05, 1.05]],
      x_channel: "FSC-A",
      y_channel: "SSC-A",
    }));
    const create = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Create")!;
    act(() => create.click());
    await settle();

    // One tree, both files following, nothing copied.
    expect(summary()).toBe("2 files · all following");
    expect(host.querySelector(".population-tree-promote")).toBeNull();
    await poolFiles(true);
    expect(plottedCount()).toBe(7);

    // Viewing D2 shows it on the tree: no copy, tools open, nothing tailored.
    await view("D2.fcs");
    expect(editTarget()).toBe("tree");
    expect(host.textContent).toContain("Editing the tree");
    expect(host.textContent).not.toContain("Editing D2.fcs only");
    expect(plottedCount()).toBe(4);
    expect([...host.querySelectorAll<HTMLButtonElement>(".gl-draw-tools button")].slice(1).some((button) => !button.disabled)).toBe(true);
    // Editing this file only locks the structure; the tree's gates are still where they were. The
    // draw tools stay on: a gate drawn here goes into the tree for every file.
    await editFile();
    expect(host.textContent).toContain("Editing D2.fcs only");
    expect([...host.querySelectorAll<HTMLButtonElement>(".gl-draw-tools button")].slice(1).every((button) => !button.disabled)).toBe(true);
    expect(host.querySelector<HTMLButtonElement>(".gl-draw-tools button:nth-child(2)")?.title).toContain("goes into the tree for every file");
    expect(host.querySelector(".gate-tailored-badge")).toBeNull();
    expect(summary()).toBe("2 files · all following");

    // Tailoring the gate marks the file and does not move the tree's gate.
    const copiedGate = plotHarness.props!.payload.gates[0];
    act(() => plotHarness.props!.onGateEdit({
      gate_id: copiedGate.gate_id,
      vertices: [[1.2, 1.2], [1.4, 1.4]],
    }));
    await settle();
    const movedVertices = plotHarness.props!.payload.gates[0].vertices;
    expect(host.querySelector(".gate-tailored-badge")).not.toBeNull();
    expect(summary()).toBe("2 files · 1 tailored");
    expect(tailoredBadge("D2.fcs")).toBe("1");

    await editTree();
    await poolFiles(true);
    expect(plottedCount()).toBe(7);
    expect(plotHarness.props!.payload.gates[0].vertices).not.toEqual(movedVertices);

    // An edit to the tree reaches D1 (no copy: it simply follows) and not D2's tailored gate.
    const templateGate = plotHarness.props!.payload.gates[0];
    act(() => plotHarness.props!.onGateEdit({ gate_id: templateGate.gate_id, vertices: [[0.1, 0.1], [1.0, 1.0]] }));
    await settle();
    const treeEdited = structuredClone(plotHarness.props!.payload.gates[0].vertices);
    // On the tree, the tailored file still shows the tree's gate; file mode shows its own.
    await view("D2.fcs");
    expect(editTarget()).toBe("tree");
    expect(plotHarness.props!.payload.gates[0].vertices).toEqual(treeEdited);
    await editFile();
    expect(plotHarness.props!.payload.gates[0].vertices).toEqual(movedVertices);
    // The mode holds from file to file: D1 gets a quiet copy that follows the tree.
    await view("D1.fcs");
    expect(editTarget()).toBe("file");
    expect(plotHarness.props!.payload.gates[0].vertices).toEqual(treeEdited);
    expect(plotHarness.props!.payload.gates[0].vertices).not.toEqual(movedVertices);

    // Viewing recorded nothing: one Undo takes back the tree edit, the next the tailoring.
    await undo();
    await view("D2.fcs");
    expect(plotHarness.props!.payload.gates[0].vertices).toEqual(movedVertices);
    await undo();
    expect(summary()).toBe("2 files · all following");
    expect(tailoredBadge("D2.fcs")).toBeNull();
    expect(editTarget()).toBe("file"); // the mode is the user's
    await editTree();
    expect(editTarget()).toBe("tree");
    await view("D1.fcs");
    await view("D2.fcs");
    expect(editTarget()).toBe("tree");

    // Tailor once more and revert the file: it follows the tree again, and pooling still works.
    await editFile();
    act(() => plotHarness.props!.onGateEdit({ gate_id: plotHarness.props!.payload.gates[0].gate_id, vertices: [[1.2, 1.2], [1.4, 1.4]] }));
    await settle();
    expect(summary()).toBe("2 files · 1 tailored");
    act(() => host.querySelector<HTMLButtonElement>(".population-tree-revert-group")!.click());
    await settle();
    expect(summary()).toBe("2 files · all following");
    expect(editTarget()).toBe("file");
    await editTree();
    expect(host.textContent).toContain("D2.fcs follows the tree again");
    await poolFiles(true);
    expect(plottedCount()).toBe(7);
    expect(host.textContent).not.toContain("Cannot pool");
  });

  it("keeps a captured pool through file import and closes it explicitly if a member is removed", async () => {
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find(i => !i.hasAttribute("webkitdirectory"))!;
    const load = async (files: File[]) => {
      Object.defineProperty(input, "files", { configurable: true, value: files });
      await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
      await settle();
    };
    await load([testFile("D1.fcs", 1), testFile("D2.fcs", 2)]);
    await poolFiles();
    const frame = structuredClone(plotHarness.props!.payload.x_range);
    await load([testFile("D3.fcs", 2)]);
    expect(plottedCount()).toBe(7);
    expect(plotHarness.props!.payload.x_range).toEqual(frame);
    expect(host.textContent).toContain("Pooled view · 2 files");
    expect(host.textContent).toContain("3 of 3 selected");
    clickButton("Manage…");
    act(() => host.querySelector<HTMLInputElement>('input[aria-label="Select D1.fcs for management"]')!.click());
    clickButton("Remove selected…");
    clickButton("Remove");
    await settle();
    expect(host.querySelector('.gl-pool-toolbar')?.textContent).not.toContain("Pooled view");
    expect(host.textContent).toContain("The pool was closed because a referenced file or hierarchy changed");
    expect(plottedCount()).toBe(4);
  });

  it("keeps action selection, inspection and captured pool independent, with guarded template editing", async () => {
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find(i => !i.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(input, "files", { configurable: true, value: [testFile("D1.fcs", 1), testFile("D2.fcs", 2), testFile("D3.fcs", 2)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(plottedCount()).toBe(4);
    expect(host.textContent).toContain("3 of 3 selected");
    expect(host.querySelector('.gl-sample-row input')).toBeNull();
    // Removing the viewed row from the action selection does not move the plot or its counts.
    const unchangedPayload = plotHarness.props!.payload;
    toggleFile("D3.fcs"); await settle();
    expect(plotHarness.props!.payload).toBe(unchangedPayload);
    expect(plottedCount()).toBe(4);
    expect(fileRow("D3.fcs").getAttribute("aria-current")).toBe("true");
    expect(fileRow("D3.fcs").getAttribute("aria-selected")).toBe("false");
    // Create a template gate before entering the read-only preview.
    act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices: [[0, 0], [1.05, 1.05]], x_channel: "FSC-A", y_channel: "SSC-A" }));
    clickButton("Create"); await settle();
    const original = structuredClone(plotHarness.props!.payload.gates[0].vertices);
    await poolFiles();
    expect(plottedCount()).toBe(7);
    expect(host.textContent).toContain("Pooled view · 2 files");
    expect(host.textContent).toContain("Read-only tree preview");
    expect(plotHarness.props!.payload.gates[0].percent_of_parent).toBe(42.86);
    act(() => plotHarness.props!.onGateEdit({ gate_id: plotHarness.props!.payload.gates[0].gate_id, vertices: [[2, 2], [3, 3]] }));
    act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices: [[2, 2], [3, 3]], x_channel: "FSC-A", y_channel: "SSC-A" }));
    await settle();
    expect(plotHarness.props!.payload.gates[0].vertices).toEqual(original);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    // A plain row click now changes only the action selection, not this explicit pool.
    act(() => fileRow("D3.fcs").click()); await settle();
    expect(plottedCount()).toBe(7);
    expect(host.textContent).toContain("1 of 3 selected");
    toggleFile("D2.fcs");
    clickButton("Change files…");
    expect(host.querySelector(".gl-pool-members")?.textContent).toContain("D1.fcs");
    clickButton("Use current selection (2)"); await settle();
    expect(plottedCount()).toBe(8);
    clickButton("Edit the tree"); await settle();
    act(() => plotHarness.props!.onGateEdit({ gate_id: plotHarness.props!.payload.gates[0].gate_id, vertices: [[0.2, 0.2], [0.9, 0.9]] }));
    await settle();
    expect(plotHarness.props!.payload.gates[0].vertices).not.toEqual(original);
    clickButton("Stop editing the tree"); await settle();
    // Enter is an explicit inspection, so it exits the pool without changing the selected set.
    act(() => fileRow("D1.fcs").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
    await settle();
    expect(plottedCount()).toBe(3);
    expect(host.textContent).toContain("2 of 3 selected");
    expect(fileRow("D1.fcs").getAttribute("aria-selected")).toBe("false");
    expect(fileRow("D1.fcs").getAttribute("aria-current")).toBe("true");
    const selection = host.querySelector('.gl-sample-inclusion-actions')!;
    act(() => [...selection.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "None")!.click());
    await settle();
    expect(plottedCount()).toBe(3);
    expect(host.textContent).toContain("0 of 3 selected");
  });

  it("holds a locked frame across the original and compensated views of a file", async () => {
    act(() => root.render(<App />));
    const directInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(directInput, "files", { configurable: true, value: [testFile("D6.fcs", 6)] });
    await act(async () => {
      directInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();
    const range = () => [...plotHarness.props!.payload.x_range] as [number, number];
    const assay = () => host.querySelector<HTMLSelectElement>('select[aria-label="Active assay layer for all tabs"]')!;
    const view = async (layer: "original" | "compensated") => {
      await act(async () => {
        assay().value = layer;
        assay().dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
    };
    expect(assay().querySelector<HTMLOptionElement>('option[value="compensated"]')?.disabled).toBe(false);
    const original = range();
    // Unlocked, each view is fitted to its own values.
    await view("compensated");
    const compensated = range();
    expect(compensated).not.toEqual(original);
    await view("original");
    expect(range()).toEqual(original);
    // Locked, the frame on screen holds across the views too.
    const lock = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Lock scales between files")!;
    act(() => lock.click());
    await settle();
    await view("compensated");
    expect(range()).toEqual(original);
    await view("original");
    expect(range()).toEqual(original);
    // Unlocked again, the compensated view goes back to its own frame.
    act(() => lock.click());
    await settle();
    await view("compensated");
    expect(range()).toEqual(compensated);
  });

  it("fits each file independently and freezes the current frame when scale locking is enabled", async () => {
    act(() => root.render(<App />));
    const directInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(directInput, "files", {
      configurable: true,
      value: [testFile("D1.fcs", 1), testFile("D2.fcs", 2)],
    });
    await act(async () => {
      directInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();

    const row = (name: string) => [...host.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((candidate) => candidate.textContent?.includes(name))!;
    const range = () => [...plotHarness.props!.payload.x_range] as [number, number];

    act(() => row("D1.fcs").click());
    await settle();
    const d1Range = range();
    const lockButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Lock scales between files")!;
    expect(lockButton().getAttribute("aria-pressed")).toBe("false");

    act(() => row("D2.fcs").click());
    await settle();
    const d2Range = range();
    expect(d2Range).not.toEqual(d1Range);

    act(() => row("D1.fcs").click());
    await settle();
    expect(range()).toEqual(d1Range);

    const lock = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Lock scales between files")!;
    act(() => lock.click());
    await settle();
    expect(lock.getAttribute("aria-pressed")).toBe("true");
    expect(lock.title).toContain("Scales locked");

    act(() => row("D2.fcs").click());
    await settle();
    expect(range()).toEqual(d1Range);

    act(() => lock.click());
    await settle();
    expect(lock.getAttribute("aria-pressed")).toBe("false");
    expect(range()).toEqual(d2Range);
  });

  it("keeps the files on one frame after a reset while the scale lock is on", async () => {
    act(() => root.render(<App />));
    const directInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(directInput, "files", {
      configurable: true,
      value: [testFile("D1.fcs", 1), testFile("D2.fcs", 2)],
    });
    await act(async () => {
      directInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();
    const row = (name: string) => [...host.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((candidate) => candidate.textContent?.includes(name))!;
    const range = () => [...plotHarness.props!.payload.x_range] as [number, number];

    act(() => row("D2.fcs").click());
    await settle();
    const d2Own = range();
    act(() => row("D1.fcs").click());
    await settle();
    const lock = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Lock scales between files")!;
    act(() => lock.click());
    await settle();

    // Reset refits the frame from the active file, into the shared scope.
    const reset = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.getAttribute("aria-label") === "Reset X and Y ranges to auto")!;
    act(() => reset.click());
    await settle();
    const shared = range();
    expect(shared.every(Number.isFinite)).toBe(true);

    // The other file shows the same frame, not its own automatic one.
    act(() => row("D2.fcs").click());
    await settle();
    expect(range()).toEqual(shared);
    expect(range()).not.toEqual(d2Own);
  });
});
