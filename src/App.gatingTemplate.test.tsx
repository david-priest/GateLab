// @vitest-environment jsdom
//
// Gating template in the app: Import ▸ Apply gating template… shows each channel the template's
// gates read beside the viewed file's channel before anything changes, marks one found other than
// by name, and on Continue the tree arrives as every gating import does, a spider quadrant as a
// spider quadrant; Export ▸ Export gating template… writes the tree every file follows (David,
// 2026-11-10). The events each population holds are compared in src/gatingTemplate.test.ts.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));

function syntheticFcs(): FcsFile {
  const xs = [50, 150, 150, 50, 100, 300];
  const ys = [150, 150, 50, 50, 100, 300];
  return {
    version: "FCS3.1",
    nEvents: xs.length,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from(xs), Float32Array.from(ys)],
    spillover: null,
  };
}
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => syntheticFcs() };
});

import App from "./App";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
const downloads: { name: string; blob: Blob }[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  downloads.length = 0;
  URL.createObjectURL = (blob: Blob) => { downloads.push({ name: "", blob }); return "blob:export"; };
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads[downloads.length - 1].name = this.download;
  });
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

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

function file(name: string, text: string): File {
  const bytes = new TextEncoder().encode(text);
  const f = new File([bytes], name);
  Object.defineProperty(f, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  return f;
}

async function loadFcs(): Promise<void> {
  const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
    .find((candidate) => !candidate.hasAttribute("webkitdirectory"))!;
  const fcs = new File([Uint8Array.from([1])], "D1.fcs");
  Object.defineProperty(fcs, "arrayBuffer", { value: async () => Uint8Array.from([1]).buffer });
  Object.defineProperty(input, "files", { configurable: true, value: [fcs] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
}

/** A template whose spider quadrant reads "Forward" -- this file's FSC-A by its $PnN -- and SSC-A. */
const TEMPLATE = {
  format: "gatelab-gating-template", version: 1, app: "GateLab test", savedAt: "2026-11-10T00:00:00Z",
  source: { workspaceId: null, fileName: "old.fcs", files: 1, instrument: "flow" },
  tree: {
    name: "Panel A",
    gates: {
      sp: {
        gate_id: "sp", name: "Spider", gate_type: "quadrant", x_channel: "Forward", y_channel: "SSC-A", space: "raw",
        center: [100, 100], arms: { down: [100, 0], right: [200, 100], up: [100, 200], left: [0, 100] },
        color: "#000", label_offset: null,
      },
    },
    gate_order: ["sp"],
    populations: {
      root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: ["q1", "q2"], event_count: null, percent_of_parent: 100 },
      q1: { population_id: "q1", name: "Spider Q1", gate_refs: [{ gate_id: "sp", include: true, quadrant: 1 }], gate_logic: "and", parent_id: "root", children: [], event_count: null, percent_of_parent: null },
      q2: { population_id: "q2", name: "Spider Q2", gate_refs: [{ gate_id: "sp", include: true, quadrant: 2 }], gate_logic: "and", parent_id: "root", children: [], event_count: null, percent_of_parent: null },
    },
    root_population_id: "root",
  },
  channels: [{ key: "Forward", pnn: "FSC-A", marker: null }, { key: "SSC-A", pnn: "SSC-A", marker: null }],
  scales: null, cytof_cofactor: null, compensation: null, fixed_transforms: [], notes: [],
};

describe("gating template in the app (David, 2026-11-10)", () => {
  it("shows the channels before anything changes, then applies the tree with its spider quadrant", async () => {
    act(() => root.render(<App />));
    await loadFcs();
    const input = host.querySelector<HTMLInputElement>('input[accept=".gatelabtree,.gatelab,.json,application/json,application/zip"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file("panel.gatelabtree", JSON.stringify(TEMPLATE))] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();

    const dialog = host.querySelector<HTMLElement>('[role="dialog"][aria-label="Apply gating template"]')!;
    expect(dialog).toBeTruthy();
    const rows = [...dialog.querySelectorAll("tbody tr")];
    expect(rows.map((r) => r.querySelector("select")!.value)).toEqual(["FSC-A", "SSC-A"]);
    expect(rows.map((r) => r.getAttribute("data-marked"))).toEqual(["true", null]);
    expect(rows[0].textContent).toContain("same detector ($PnN)");
    // Nothing has changed yet.
    expect(host.textContent).not.toContain("Spider Q1");

    // Choosing none for a channel holds Continue.
    const select = rows[0].querySelector("select")!;
    await act(async () => { select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(rows[0].textContent).toContain("same detector ($PnN)");
    const cont = () => [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Apply gating template"] button')].find((b) => b.textContent === "Continue")!;
    await act(async () => { select.value = "FSC-A"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.querySelector('[aria-label="Apply gating template"] tbody tr')!.textContent).toContain("chosen");
    expect(cont().disabled).toBe(false);
    await act(async () => { cont().click(); });
    await settle();
    await settle();

    expect(host.querySelector('[aria-label="Apply gating template"]')).toBeNull();
    expect(host.textContent).toContain("Spider Q1");
    expect(host.textContent).toContain("Spider Q2");
    expect(host.textContent).toContain("from the gating template panel.gatelabtree");

    // Exported again, the tree comes back with its spider quadrant on this file's channels.
    const trigger = [...host.querySelectorAll<HTMLButtonElement>(".gl-menu-trigger")].find((b) => b.textContent?.includes("Export"))!;
    act(() => trigger.click());
    const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.trim() === "Export gating template…")!;
    act(() => item.click());
    await settle();
    expect(downloads.map((d) => d.name)).toEqual([expect.stringMatching(/\.gatelabtree$/)]);
    const written = JSON.parse(await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(downloads[0].blob);
    }));
    expect(written.format).toBe("gatelab-gating-template");
    const gates = Object.values(written.tree.gates) as { gate_type: string; x_channel: string; arms?: unknown }[];
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ gate_type: "quadrant", x_channel: "FSC-A", arms: TEMPLATE.tree.gates.sp.arms });
    expect(written.channels).toEqual([{ key: "FSC-A", pnn: "FSC-A", marker: null }, { key: "SSC-A", pnn: "SSC-A", marker: null }]);
  });

  it("refuses a file that is neither a template nor a workspace, and changes nothing", async () => {
    act(() => root.render(<App />));
    await loadFcs();
    const input = host.querySelector<HTMLInputElement>('input[accept=".gatelabtree,.gatelab,.json,application/json,application/zip"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file("notes.json", "{\"a\":1}")] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(host.querySelector('[aria-label="Apply gating template"]')).toBeNull();
    expect(host.textContent).toContain("Not a GateLab workspace.");
  });
});
