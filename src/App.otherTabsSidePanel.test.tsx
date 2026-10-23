// @vitest-environment jsdom
//
// The tabs other than Gating (David, 2026-10-23): the Gates and Populations panel is hidden where
// it serves nothing: Division, Scales and Strategy, which chooses its populations and files itself.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import type { NewGate } from "./plots/GatingPlot";

const plotHarness = vi.hoisted(() => ({
  props: null as { onNewGate: (gate: NewGate) => void } | null,
}));

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: { onNewGate: (gate: NewGate) => void }) => {
    plotHarness.props = props;
    return <div data-testid="gating-plot" />;
  },
}));

function syntheticFcs(seed: number): FcsFile {
  const count = 4;
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
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  return file;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === text);
}

describe("the side panel on the other tabs", () => {
  it("is hidden on Division, Scales and Strategy, and Strategy has the file list in its own tab", async () => {
    act(() => root.render(<App />));
    const directInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(directInput, "files", { configurable: true, value: [testFile("D1.fcs", 1)] });
    await act(async () => {
      directInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();
    const side = () => host.querySelector<HTMLElement>("aside.gl-side")!;
    expect(side().style.display).toBe("");
    const gatingWidth = side().style.width;

    const left = () => host.querySelector<HTMLElement>("aside.gl-left")!;
    for (const tab of ["Division", "Scales"]) {
      act(() => buttonWithText(tab)!.click());
      await settle();
      expect(side().style.display, tab).toBe("none");
      // Division has its own left pane, with the file in its Data side tab; Scales keeps the file list.
      expect(left().style.display, tab).toBe(tab === "Division" ? "none" : "");
    }
    // Strategy chooses its populations and its files in its own Data side tab, as Illustration
    // does: neither pane is shown, and the file list is in the tab.
    act(() => buttonWithText("Strategy")!.click());
    await settle();
    expect(side().style.display).toBe("none");
    expect(left().style.display).toBe("none");
    const strategyFiles = host.querySelector<HTMLElement>(".gl-strategy-inspector .gl-strategy-files")!;
    expect([...strategyFiles.querySelectorAll("label")].map((row) => row.textContent)).toEqual(["D1.fcs"]);
    expect(strategyFiles.querySelector<HTMLInputElement>('input[type="radio"]')!.checked).toBe(true);

    act(() => buttonWithText("Gating")!.click());
    await settle();
    expect(side().style.display).toBe("");
    expect(left().style.display).toBe("");
    expect(side().style.width).toBe(gatingWidth);
  });
});
