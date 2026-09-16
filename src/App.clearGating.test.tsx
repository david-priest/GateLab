// @vitest-environment jsdom
//
// "Clear gates and populations" starts gating again on the same files: every gate, population
// and hierarchy goes after a confirmation, the files stay, and Undo brings the gating back.

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

describe("Clear gates and populations", () => {
  it("removes every gate, population and hierarchy, keeps the files, and Undo restores them", async () => {
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((candidate) => !candidate.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(input, "files", { configurable: true, value: [testFile("D1.fcs", 1), testFile("D2.fcs", 2)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(host.querySelectorAll(".gl-sample-row")).toHaveLength(2);
    expect(button("Clear gates and populations…")!.disabled).toBe(true);

    act(() => plotHarness.props!.onNewGate({ gate_type: "rectangle", vertices: [[0, 0], [1000, 1000]], x_channel: "FSC-A", y_channel: "SSC-A" }));
    const createPopulation = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((candidate) => candidate.parentElement?.textContent?.includes("Also create a population"))!;
    act(() => createPopulation.click());
    act(() => button("Create")!.click());
    await settle();
    expect(host.querySelectorAll(".pop-row")).toHaveLength(2);
    expect(button("Clear gates and populations…")!.disabled).toBe(false);

    act(() => button("Clear gates and populations…")!.click());
    expect(host.textContent).toContain("Clear gates and populations?");
    act(() => button("Clear")!.click());
    await settle();
    expect(host.querySelectorAll(".pop-row")).toHaveLength(1);
    expect(host.querySelector(".pop-row")?.textContent).toContain("All Events");
    expect(plotHarness.props!.payload.gates).toHaveLength(0);
    expect(host.querySelectorAll(".gl-sample-row")).toHaveLength(2);
    expect(host.textContent).toContain("cleared");
    // The one tree is back to its empty self, both files following it.
    expect(host.querySelector(".population-tree-name-menu")?.textContent).toContain("Main");
    expect(host.querySelector(".population-tree-hierarchy-count")?.textContent).toBe("2 files · all following");

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); });
    await settle();
    expect(host.querySelectorAll(".pop-row")).toHaveLength(2);
    expect(plotHarness.props!.payload.gates).toHaveLength(1);
  });
});
