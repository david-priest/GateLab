// @vitest-environment jsdom
// The checkpoint taken after a gating import holds the imported gates, not the state before,
// also when the import switches compensation on. In a browser that mutation forced a render
// that committed before the gating dispatch, and a checkpoint queued in a ref was taken there
// with no gates; React under act() flushes both together, so this guards the content, and the
// ordering was checked headlessly on a FlowJo import. Synthetic file and gate names.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import type { WorkspaceFile } from "./engine/workspace";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));
// A flow file with a spillover matrix, so a gate declared in FCS-compensated space switches
// compensation on as it is imported: the sample mutation that made the old checkpoint early.
const syntheticFcs: FcsFile = {
  version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {},
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "FL1-A", marker: "CD3", bits: 32, range: 262144 },
    { index: 2, name: "FL2-A", marker: "CD19", bits: 32, range: 262144 },
  ],
  columns: [Float32Array.from([10, 20, 30]), Float32Array.from([100, 200, 300]), Float32Array.from([25, 45, 65])],
  spillover: { channels: ["FL1-A", "FL2-A"], matrix: [[1, 0.1], [0.05, 1]] },
};
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => syntheticFcs };
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
import { saveWorkspaceCheckpoint } from "./engine/workspaceHistory";

const GATING_ML = `<?xml version="1.0"?>
<gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
  xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <gating:RectangleGate gating:id="g1" gating:name="CD4_positive">
    <gating:dimension gating:compensation-ref="FCS" gating:min="0" gating:max="100000"><data-type:fcs-dimension data-type:name="FL1-A"/></gating:dimension>
    <gating:dimension gating:compensation-ref="FCS" gating:min="0" gating:max="100000"><data-type:fcs-dimension data-type:name="FL2-A"/></gating:dimension>
  </gating:RectangleGate>
</gating:Gating-ML>`;

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
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
async function feed(selector: string, file: File): Promise<void> {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle(); await settle(); await settle();
}

describe("the checkpoint after a gating import", () => {
  it("holds the imported gates", async () => {
    act(() => root.render(<App />));
    await feed('input[type=file][accept=".fcs"][multiple]', fileOf("D1.fcs", Uint8Array.from([1])));
    expect(host.textContent).toContain("D1.fcs");
    await feed('input[accept=".xml,.wsp,.cef"]', fileOf("gates.xml", GATING_ML));
    const importButton = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
    if (importButton) { await act(async () => { importButton.click(); }); await settle(); await settle(); }
    expect(host.textContent).toContain("CD4_positive");
    expect(host.textContent).toContain("FCS compensation enabled");
    const calls = vi.mocked(saveWorkspaceCheckpoint).mock.calls.map((call) => [call[2], Object.keys((call[1] as WorkspaceFile).gating.gates).length] as const);
    expect(calls).toContainEqual(["after-gatingml-import", 1]);
    expect(calls.find(([reason]) => reason === "before-gatingml-replace")?.[1]).toBe(0);
  });
});
