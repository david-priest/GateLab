// @vitest-environment jsdom

// Using a matrix again: a file's values for a matrix it was compensated with before are stored, and
// using that matrix again installs them instead of solving (David, 2026-11-20). Synthetic files.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompensationManager } from "./engine/compensationManager";
import type { FcsFile } from "./engine/fcs";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));

/** A flow file with FL1-A and a second detector, carrying the same embedded matrix. */
function flowFcs(second = "FL2-A"): FcsFile {
  return {
    version: "FCS3.1",
    nEvents: 3,
    instrument: "flow",
    keywords: { $SPILLOVER: "2,FL1-A,FL2-A,1,0.1,0.05,1" },
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL1-A", marker: null, bits: 32, range: 262144 },
      { index: 2, name: second, marker: null, bits: 32, range: 262144 },
    ],
    columns: [
      Float32Array.from([10, 20, 30]),
      Float32Array.from([100, 200, 300]),
      Float32Array.from([25, 45, 65]),
    ],
    spillover: second === "FL2-A"
      ? { channels: ["FL1-A", "FL2-A"], matrix: [[1, 0.1], [0.05, 1]] }
      : null,
  };
}

/** What each parsed file is, in the order the files are read. */
let parsedQueue: FcsFile[] = [];

vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => parsedQueue.shift() ?? flowFcs() };
});

vi.mock("./engine/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/workspace")>();
  return { ...actual, readWorkspaceEnvelopeFromFile: vi.fn() };
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

const otherMatrix = [
  "channel,FL1-A,FL2-A",
  "FL1-A,1,0.2",
  "FL2-A,0.03,1",
].join("\n");

function testFcsFile(name: string): File {
  // Different bytes per file, so each has its own SHA-256.
  const bytes = Uint8Array.from([70, 67, 83, ...new TextEncoder().encode(name)]);
  const file = new File([bytes], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
  return file;
}

function textFile(text: string, name: string): File {
  const file = new File([text], name, { type: "text/csv" });
  if (typeof file.text !== "function") Object.defineProperty(file, "text", { value: async () => text });
  return file;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  parsedQueue = [];
  let uuid = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.dynamicImportSettled();
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

async function openWorkspace(files: readonly File[]): Promise<void> {
  act(() => root.render(<App />));
  const fcsInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
    .find((input) => !input.hasAttribute("webkitdirectory"))!;
  Object.defineProperty(fcsInput, "files", { configurable: true, value: files });
  await act(async () => {
    fcsInput.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((button) => button.textContent === "Compensation")!;
  act(() => tab.click());
  await settle(10);
}

async function importMatrix(text: string, name: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Import a spillover matrix"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [textFile(text, name)] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await settle();
}

const rows = () => [...host.querySelectorAll<HTMLLIElement>(".gl-comp-lib-row")];
const rowNamed = (name: string) => rows().find((row) => row.querySelector(".gl-comp-lib-name")?.textContent === name);
const dialog = () => host.querySelector<HTMLElement>(".gl-comp-lib-switch");
const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === text);

/**
 * A stand-in for the solver: each file gets values that name the matrix (its FL1-A to FL2-A
 * coefficient times 1,000, plus the event's index), installed through the binding the manager makes.
 */
function solveByMarker() {
  const requests: Parameters<CompensationManager["apply"]>[0][] = [];
  vi.spyOn(CompensationManager.prototype, "apply").mockImplementation(async function (this: CompensationManager, request) {
    requests.push(request);
    let validated = request.profile;
    const targets = [];
    for (const { sample } of request.targets) {
      const { profile, binding } = await this.prepareExternalApplyBinding(request.profile, sample);
      validated = profile;
      const base = Math.round(profile.scientific.matrix.matrix[0][1] * 1000);
      sample.installCompensatedLayer({
        metadata: binding,
        columns: binding.channelBindings.filter(({ included }) => included).map(({ pnn, fcsColumnIndex }) => ({
          pnn,
          fcsColumnIndex,
          values: Float32Array.from({ length: sample.fcs.nEvents }, (_, index) => base + index),
        })),
      }, { activeLayer: "compensated" });
      targets.push({ sample, binding });
    }
    return { jobId: "solved", profile: validated, targets };
  });
  return requests;
}

async function useForWorkspace(name: string): Promise<void> {
  act(() => rowNamed(name)!.querySelector<HTMLButtonElement>(".gl-comp-lib-use")!.click());
  act(() => dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => {
    button(dialog()!, "Use for the workspace")!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await settle(20);
}

describe("using a matrix again", () => {
  it("installs each file's stored values instead of solving, and solves a matrix not used before", async () => {
    const requests = solveByMarker();
    await openWorkspace([testFcsFile("D1.fcs"), testFcsFile("D2.fcs")]);
    await importMatrix(otherMatrix, "treated.csv");
    await importMatrix(["channel,FL1-A,FL2-A", "FL1-A,1,0.3", "FL2-A,0.04,1"].join("\n"), "control.csv");

    await useForWorkspace("treated");
    expect(requests).toHaveLength(1);
    const files = requests[0].targets.map(({ sample }) => sample);
    expect(files).toHaveLength(2);
    const fl1 = (sample: (typeof files)[number]) => Array.from(sample.compensatedColumnData(sample.index("FL1-A")!)!);
    expect(files.map(fl1)).toEqual([[200, 201, 202], [200, 201, 202]]);

    await useForWorkspace("control");
    expect(requests).toHaveLength(2);
    expect(files.map(fl1)).toEqual([[300, 301, 302], [300, 301, 302]]);

    // Back to the first: its values come from the store; nothing is solved.
    await useForWorkspace("treated");
    expect(requests).toHaveLength(2);
    expect(files.map(fl1)).toEqual([[200, 201, 202], [200, 201, 202]]);
    expect(files.every((sample) => sample.activeLayer === "compensated")).toBe(true);
    expect(rowNamed("treated")!.classList.contains("is-active")).toBe(true);
    expect(rowNamed("control")!.classList.contains("is-active")).toBe(false);
  });
});
