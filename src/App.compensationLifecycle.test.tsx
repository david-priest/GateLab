// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompensationManager } from "./engine/compensationManager";
import type { FcsFile } from "./engine/fcs";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));

const syntheticCytofFcs: FcsFile = {
  version: "FCS3.1",
  nEvents: 3,
  instrument: "cytof",
  keywords: {},
  channels: [
    { index: 0, name: "Time", marker: null, bits: 32, range: 1000 },
    { index: 1, name: "Y89Di", marker: "CD45", bits: 32, range: 1000 },
    { index: 2, name: "In113Di", marker: "Barcode", bits: 32, range: 1000 },
  ],
  columns: [
    Float32Array.from([1, 2, 3]),
    Float32Array.from([10, 20, 30]),
    Float32Array.from([100, 200, 300]),
  ],
  spillover: null,
};

const syntheticFlowFcs: FcsFile = {
  version: "FCS3.1",
  nEvents: 3,
  instrument: "flow",
  keywords: {},
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "FL1-A", marker: "CD3", bits: 32, range: 262144 },
    { index: 2, name: "FL2-A", marker: "CD19", bits: 32, range: 262144 },
  ],
  columns: [
    Float32Array.from([10, 20, 30]),
    Float32Array.from([100, 200, 300]),
    Float32Array.from([25, 45, 65]),
  ],
  spillover: {
    channels: ["FL1-A", "FL2-A"],
    matrix: [[1, 0.1], [0.05, 1]],
  },
};

let parsedFcs: FcsFile = syntheticCytofFcs;

vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => parsedFcs };
});

import App from "./App";

const matrixText = [
  "channel,Y89Di,In113Di",
  "Y89Di,1,0.1",
  "In113Di,0.05,1",
].join("\n");

function testFcsFile(name: string): File {
  const file = new File([Uint8Array.from([70, 67, 83])], name, {
    type: "application/octet-stream",
  });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => Uint8Array.from([70, 67, 83]).buffer,
  });
  return file;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  parsedFcs = syntheticCytofFcs;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("App compensation lifecycle", () => {
  it("uses one global assay selector across every analysis tab", async () => {
    parsedFcs = syntheticFlowFcs;
    act(() => root.render(<App />));

    const fcsInput = host.querySelector<HTMLInputElement>('input[type="file"][accept=".fcs"]')!;
    const fcsFile = new File([Uint8Array.from([70, 67, 83])], "flow.fcs", {
      type: "application/octet-stream",
    });
    Object.defineProperty(fcsFile, "arrayBuffer", {
      value: async () => Uint8Array.from([70, 67, 83]).buffer,
    });
    Object.defineProperty(fcsInput, "files", { configurable: true, value: [fcsFile] });
    await act(async () => {
      fcsInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect([...host.querySelectorAll<HTMLButtonElement>("button")]
      .some((button) => button.textContent?.trim() === "Fit data + gates")).toBe(true);

    const selector = host.querySelector<HTMLSelectElement>('select[aria-label="Active assay layer for all tabs"]')!;
    expect(selector.value).toBe("original");
    expect(selector.querySelector<HTMLOptionElement>('option[value="compensated"]')?.disabled).toBe(false);
    await act(async () => {
      selector.value = "compensated";
      selector.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(selector.value).toBe("compensated");

    const statisticsTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === "Statistics")!;
    act(() => statisticsTab.click());
    expect(selector.value).toBe("compensated");
    expect(host.querySelectorAll('select[aria-label="Active assay layer for all tabs"]')).toHaveLength(1);
  });

  it("keeps an imported matrix mounted across analysis-tab changes", async () => {
    act(() => root.render(<App />));

    const fcsInput = host.querySelector<HTMLInputElement>('input[type="file"][accept=".fcs"]')!;
    const fcsFile = new File([Uint8Array.from([70, 67, 83])], "cytof.fcs", {
      type: "application/octet-stream",
    });
    Object.defineProperty(fcsFile, "arrayBuffer", {
      value: async () => Uint8Array.from([70, 67, 83]).buffer,
    });
    Object.defineProperty(fcsInput, "files", { configurable: true, value: [fcsFile] });
    await act(async () => {
      fcsInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const tab = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === name)!;
    expect(host.querySelector(".gl-compensation-tab")).toBeNull();
    act(() => tab("Compensation").click());
    await act(async () => {
      await vi.dynamicImportSettled();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const matrixInput = host.querySelector<HTMLInputElement>(
      'input[aria-label="Choose CyTOF spillover matrix"]',
    );
    expect(matrixInput, host.textContent ?? "").not.toBeNull();
    const matrixFile = new File([matrixText], "wing-lab.csv", { type: "text/csv" });
    if (typeof matrixFile.text !== "function") {
      Object.defineProperty(matrixFile, "text", { value: async () => matrixText });
    }
    Object.defineProperty(matrixInput!, "files", { configurable: true, value: [matrixFile] });
    await act(async () => {
      matrixInput!.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain("wing-lab.csv");
    expect(host.querySelectorAll<HTMLInputElement>('.gl-comp-channel-grid input:checked')).toHaveLength(2);

    act(() => tab("Gating").click());
    expect(host.querySelector<HTMLElement>(".gl-compensation-tab")?.style.display).toBe("none");
    expect(host.querySelector("[data-compensation-dormant='true']")).not.toBeNull();
    expect(host.querySelector(".gl-comp-channel-grid")).toBeNull();

    act(() => tab("Compensation").click());
    await act(async () => {
      await vi.dynamicImportSettled();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain("wing-lab.csv");
    expect(host.querySelectorAll<HTMLInputElement>('.gl-comp-channel-grid input:checked')).toHaveLength(2);
  });

  it("applies CyTOF compensation atomically to every checked FCS file by default", async () => {
    let uuid = 0;
    vi.stubGlobal("crypto", {
      randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
      subtle: {
        digest: async (_algorithm: string, input: ArrayBuffer) => {
          const bytes = new Uint8Array(input);
          const output = new Uint8Array(32);
          for (let index = 0; index < bytes.length; index++) {
            output[index % output.length] = (output[index % output.length] * 31 + bytes[index] + index) & 0xff;
          }
          return output.buffer;
        },
      },
    });
    let capturedRequest: Parameters<CompensationManager["apply"]>[0] | null = null;
    vi.spyOn(CompensationManager.prototype, "apply").mockImplementation(async (request) => {
      capturedRequest = request;
      request.onProgress?.({
        jobId: "multi-file-apply",
        sampleIndex: request.targets.length - 1,
        sampleCount: request.targets.length,
        sampleProcessedEvents: 3,
        sampleTotalEvents: 3,
        processedEvents: 6,
        totalEvents: 6,
        fraction: 1,
      });
      return {
        jobId: "multi-file-apply",
        profile: request.profile,
        targets: [],
      };
    });
    act(() => root.render(<App />));

    const fcsInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(fcsInput, "files", {
      configurable: true,
      value: [testFcsFile("donor-a.fcs"), testFcsFile("donor-b.fcs")],
    });
    await act(async () => {
      fcsInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const compensationTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === "Compensation")!;
    act(() => compensationTab.click());
    await act(async () => {
      await vi.dynamicImportSettled();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const matrixInput = host.querySelector<HTMLInputElement>(
      'input[aria-label="Choose CyTOF spillover matrix"]',
    )!;
    const matrixFile = new File([matrixText], "wing-lab.csv", { type: "text/csv" });
    if (typeof matrixFile.text !== "function") {
      Object.defineProperty(matrixFile, "text", { value: async () => matrixText });
    }
    Object.defineProperty(matrixInput, "files", { configurable: true, value: [matrixFile] });
    await act(async () => {
      matrixInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain("Applies atomically to 2 checked FCS files · 6 total events");
    const apply = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Apply NNLS compensation")!;
    await act(async () => {
      apply.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.targets).toHaveLength(2);
    expect(new Set(capturedRequest!.targets.map(({ sample }) => sample)).size).toBe(2);
    expect(capturedRequest!.targets.every(({ activeLayer }) => activeLayer === "compensated")).toBe(true);
  });
});
