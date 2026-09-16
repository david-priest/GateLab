// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { FcsFile } from "./engine/fcs";
import { resetPickerLocation } from "./engine/fsAccess";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));

const syntheticFcs: FcsFile = {
  version: "FCS3.1",
  nEvents: 3,
  instrument: "flow",
  keywords: {},
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
  ],
  columns: [
    Float32Array.from([100, 200, 300]),
    Float32Array.from([150, 250, 350]),
  ],
  spillover: null,
};

vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => syntheticFcs };
});

import App from "./App";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;

const parameter = (name: string) => ({
  measurementId: name,
  fluorochrome: name,
  measurement: "A",
  scatter: name,
  scale: "Linear",
  numerator: null,
  denominator: null,
  parameterKind: "Scatter",
});

function cefBytes(): Uint8Array {
  const gate = {
    gateId: "gate-1",
    gateKind: "Polygon",
    name: "CD4_positive",
    parentPopulationId: "0-1",
    parameters: [parameter("FSC"), parameter("SSC")],
    vertices: [
      { x: 50, y: 50 },
      { x: 350, y: 50 },
      { x: 350, y: 400 },
    ],
    children: [{ name: "CD4_positive", color: "0,0,255", populationId: "gate-1-1" }],
  };
  return zipSync({
    "manifest.json": strToU8(JSON.stringify({ chorusVersion: "5.4.0" })),
    "experiment.json": strToU8(JSON.stringify({
      experiment: {
        name: "synthetic experiment",
        panels: [{
          name: "Panel 1",
          analysis: {
            gates: [gate],
            visualizationSettings: { analysisRValueMap: [] },
          },
        }],
      },
      sortRecords: [],
    })),
  });
}

function testFile(name: string, bytes: Uint8Array): File {
  const owned = Uint8Array.from(bytes).buffer;
  const file = new File([owned], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: async () => bytes.slice().buffer,
  });
  return file;
}

function fileHandle(file: File): FileSystemFileHandle {
  return {
    kind: "file",
    name: file.name,
    getFile: vi.fn().mockResolvedValue(file),
  } as unknown as FileSystemFileHandle;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", {
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  });
  resetPickerLocation();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetPickerLocation();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  uuid = 0;
});

describe("opening a FACSChorus experiment before its FCS", () => {
  it("chooses a tree, requests the FCS in the shared folder, then imports the gates", async () => {
    const cefHandle = fileHandle(testFile("strategy.cef", cefBytes()));
    const fcsHandle = fileHandle(testFile("D1.fcs", Uint8Array.from([70, 67, 83])));
    const showOpenFilePicker = vi.fn()
      .mockResolvedValueOnce([cefHandle])
      .mockResolvedValueOnce([fcsHandle]);
    Object.defineProperty(window, "showOpenFilePicker", {
      configurable: true,
      value: showOpenFilePicker,
    });
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: vi.fn(),
    });

    act(() => root.render(<App />));
    const openWorkspace = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Open Workspace…")!;
    await act(async () => {
      openWorkspace.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(host.textContent).toContain("FACSChorus experiment · synthetic experiment");
    expect(host.textContent).toContain("choose the FCS file containing its event data");
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0);

    const currentGates = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Import current gates…")!;
    await act(async () => {
      currentGates.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(showOpenFilePicker).toHaveBeenCalledTimes(2);
    expect(showOpenFilePicker.mock.calls[1][0]).toMatchObject({
      id: "gatelab",
      startIn: cefHandle,
      multiple: false,
    });
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(host.textContent).toContain("D1.fcs");
    expect(host.textContent).toContain("CD4_positive");
    expect(host.textContent).toContain("Imported 1 gates, 1 populations");
    expect(host.textContent).toContain("from FACSChorus experiment · synthetic experiment · Current gates");
  });
});
