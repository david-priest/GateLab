// @vitest-environment jsdom

// The Compensation tab's Matrices list: importing a flow matrix, naming it, and using it for the
// whole workspace through the confirmation, which a file the matrix cannot compensate refuses.

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

import App from "./App";

const otherMatrix = [
  "channel,FL1-A,FL2-A",
  "FL1-A,1,0.2",
  "FL2-A,0.03,1",
].join("\n");

function testFcsFile(name: string): File {
  const file = new File([Uint8Array.from([70, 67, 83])], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => Uint8Array.from([70, 67, 83]).buffer });
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

function captureApply() {
  const requests: Parameters<CompensationManager["apply"]>[0][] = [];
  vi.spyOn(CompensationManager.prototype, "apply").mockImplementation(async (request) => {
    requests.push(request);
    return { jobId: "workspace-switch", profile: request.profile, targets: [] };
  });
  return requests;
}

describe("Compensation Matrices list", () => {
  it("lists the files' identical embedded matrix once, and adds an imported matrix without using it", async () => {
    await openWorkspace([testFcsFile("D1.fcs"), testFcsFile("D2.fcs")]);

    expect(rows().map((row) => row.querySelector(".gl-comp-lib-name")?.textContent)).toEqual(["D1 spillover"]);
    expect(rows()[0].querySelector(".gl-comp-lib-meta")?.textContent).toBe("Embedded · D1.fcs · 2 channels");

    await importMatrix(otherMatrix, "treated.csv");

    expect(host.textContent).toContain("Added treated, not in use.");
    const imported = rowNamed("treated")!;
    expect(imported.querySelector(".gl-comp-lib-meta")?.textContent).toBe("Imported · treated.csv · 2 channels");
    expect(imported.classList.contains("is-active")).toBe(false);

    // The same table again is not a second matrix.
    await importMatrix(otherMatrix, "treated-again.csv");
    expect(host.textContent).toContain("treated-again.csv holds the same matrix as treated, which is already in the list.");
    expect(rows()).toHaveLength(2);
  });

  it("renames a stored matrix, and offers no rename or delete for an embedded one", async () => {
    await openWorkspace([testFcsFile("D1.fcs")]);
    await importMatrix(otherMatrix, "treated.csv");

    expect(rowNamed("D1 spillover")!.querySelector(".gl-comp-lib-rename")).toBeNull();
    expect(rowNamed("D1 spillover")!.querySelector(".gl-comp-lib-delete")).toBeNull();

    act(() => rowNamed("treated")!.querySelector<HTMLButtonElement>(".gl-comp-lib-rename")!.click());
    const field = host.querySelector<HTMLInputElement>(".gl-comp-lib-name-input")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, "Panel B1");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));

    expect(rowNamed("Panel B1")).toBeDefined();
    expect(rowNamed("treated")).toBeUndefined();
    // Not in use and not active: it can go.
    expect(rowNamed("Panel B1")!.querySelector(".gl-comp-lib-delete")).not.toBeNull();
  });

  it("uses a matrix for every file only after the user agrees that membership may change", async () => {
    const requests = captureApply();
    await openWorkspace([testFcsFile("D1.fcs"), testFcsFile("D2.fcs")]);
    await importMatrix(otherMatrix, "treated.csv");

    act(() => rowNamed("treated")!.querySelector<HTMLButtonElement>(".gl-comp-lib-use")!.click());
    const open = dialog()!;
    expect(open.textContent).toContain("Use treated for the workspace");
    expect(open.textContent).toContain("Every file in the workspace (2) is compensated with treated.");
    expect(open.querySelector('[role="alert"]')).toBeNull();
    const use = button(open, "Use for the workspace")!;
    expect(use.disabled).toBe(true);

    act(() => open.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(use.disabled).toBe(false);
    await act(async () => {
      use.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // One Apply, one undo entry, on every file.
    expect(requests).toHaveLength(1);
    expect(requests[0].targets).toHaveLength(2);
    expect(new Set(requests[0].targets.map(({ sample }) => sample)).size).toBe(2);
    expect(requests[0].targets.every(({ activeLayer }) => activeLayer === "compensated")).toBe(true);
    expect(requests[0].profile.name).toBe("treated");
    expect(dialog()).toBeNull();
    expect(host.textContent).not.toContain("Added treated, not in use.");
    expect(rowNamed("treated")!.classList.contains("is-active")).toBe(true);
    expect(rowNamed("treated")!.querySelector(".gl-comp-lib-active")?.textContent).toBe("Active");
    // The active matrix cannot be deleted.
    expect(rowNamed("treated")!.querySelector(".gl-comp-lib-delete")).toBeNull();
  });

  it("refuses the switch by name when a file lacks a channel the matrix compensates", async () => {
    const requests = captureApply();
    parsedQueue = [flowFcs(), flowFcs("FL3-A")];
    await openWorkspace([testFcsFile("D1.fcs"), testFcsFile("D2.fcs")]);
    await importMatrix(otherMatrix, "treated.csv");

    act(() => rowNamed("treated")!.querySelector<HTMLButtonElement>(".gl-comp-lib-use")!.click());
    const open = dialog()!;
    const alert = open.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("These files cannot be compensated with this matrix, so it cannot be used for the workspace:");
    expect(alert?.textContent).toContain("D2.fcs: lacks FL2-A");
    expect(open.querySelector('input[type="checkbox"]')).toBeNull();
    expect(button(open, "Use for the workspace")!.disabled).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it("names the files that leave their own embedded matrix, and switches them though that state cannot be saved", async () => {
    const requests = captureApply();
    await openWorkspace([testFcsFile("D1.fcs"), testFcsFile("D2.fcs")]);
    // The viewed file (the last opened, D2) on its own embedded matrix: the header's Compensated.
    const compensated = host.querySelectorAll<HTMLButtonElement>(
      '[role="radiogroup"][aria-label="Active assay layer for all tabs"] [role="radio"]',
    )[1];
    await act(async () => {
      compensated.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await settle(10);
    expect(rowNamed("D1 spillover")!.classList.contains("is-active")).toBe(true);
    expect(rowNamed("D1 spillover")!.querySelector(".gl-comp-lib-meta")?.textContent).toContain("1 of 2 files");

    await importMatrix(otherMatrix, "treated.csv");
    act(() => rowNamed("treated")!.querySelector<HTMLButtonElement>(".gl-comp-lib-use")!.click());
    expect(dialog()!.querySelector(".gl-comp-lib-leaving")?.textContent).toBe("Leaving their own embedded matrix: D2.fcs.");
    // A stored matrix beside a file on its own embedded matrix: no format writes the two together.
    expect(host.querySelector(".gl-comp-lib-unsaved")?.textContent).toContain("D2.fcs");
    expect(dialog()!.querySelector(".gl-comp-lib-irreversible")).not.toBeNull();

    act(() => dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => {
      button(dialog()!, "Use for the workspace")!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    // The unwritable state before the switch does not stop it.
    expect(requests).toHaveLength(1);
    expect(requests[0].targets).toHaveLength(2);
    expect(dialog()).toBeNull();
  });
});
