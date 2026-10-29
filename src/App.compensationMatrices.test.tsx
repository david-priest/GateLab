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
import { readWorkspaceEnvelopeFromFile, type WorkspaceFile } from "./engine/workspace";
import { saveWorkspaceCheckpoint } from "./engine/workspaceHistory";

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
    expect(rows()[0].querySelector(".gl-comp-lib-meta")?.textContent).toBe("Primary · Embedded · D1.fcs · 2 channels");

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
    expect(open.textContent).toContain("Use M2 treated for the workspace");
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

  it("downloads the matrix in use from beside Import, once one is in use", async () => {
    captureApply();
    await openWorkspace([testFcsFile("D1.fcs"), testFcsFile("D2.fcs")]);
    await importMatrix(otherMatrix, "treated.csv");
    const exportActive = () => host.querySelector<HTMLButtonElement>(".gl-comp-lib-export-active")!;
    expect(exportActive().textContent).toBe("Export CSV…");
    expect(exportActive().disabled).toBe(true);

    act(() => rowNamed("treated")!.querySelector<HTMLButtonElement>(".gl-comp-lib-use")!.click());
    act(() => dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => {
      button(dialog()!, "Use for the workspace")!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(exportActive().disabled).toBe(false);
    act(() => exportActive().click());
    const exportDialog = host.querySelector<HTMLElement>('[aria-labelledby="comp-export-title"]')!;
    expect(exportDialog.textContent).toContain("treated_spill_matrix.csv");
  });

  it("duplicates a matrix and edits the copy, used for every file once the user agrees; the original stays", async () => {
    const requests = captureApply();
    await openWorkspace([testFcsFile("D1.fcs"), testFcsFile("D2.fcs")]);
    await importMatrix(otherMatrix, "treated.csv");

    act(() => rowNamed("treated")!.querySelector<HTMLButtonElement>(".gl-comp-lib-edit")!.click());
    const open = dialog()!;
    expect(open.textContent).toContain("Duplicate and edit M2 treated");
    expect(open.querySelector(".gl-comp-lib-copy")?.textContent).toContain(
      "GateLab stores a copy, treated copy, and compensates every file in the workspace (2) with it",
    );
    expect(open.textContent).toContain("Edited coefficients change no file until you choose Apply revised matrix, which asks again.");
    const make = button(open, "Make the copy and edit")!;
    expect(make.disabled).toBe(true);
    act(() => open.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => {
      make.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].targets).toHaveLength(2);
    expect(requests[0].profile.name).toBe("treated copy");
    expect(requests[0].profile.recordType).toBe("baseline");
    expect(requests[0].profile.scientific.matrix.matrix).toEqual([[1, 0.2], [0.03, 1]]);
    expect(dialog()).toBeNull();
    expect(rowNamed("treated copy")!.classList.contains("is-active")).toBe(true);
    expect(rowNamed("treated")!.classList.contains("is-active")).toBe(false);
    expect(host.textContent).toContain("Editing treated copy");
  });

  it("offers Duplicate and edit for a file's matrix that carries single-precision noise", async () => {
    const noisy = (): FcsFile => ({
      ...flowFcs(),
      keywords: { $SPILLOVER: "2,FL1-A,FL2-A,1.000002,0.1,-5e-9,1" },
      spillover: { channels: ["FL1-A", "FL2-A"], matrix: [[1.000002, 0.1], [-5e-9, 1]] },
    });
    parsedQueue = [noisy()];
    await openWorkspace([testFcsFile("D1.fcs")]);

    const row = rowNamed("D1 spillover")!;
    expect(row.querySelector(".gl-comp-lib-unusable")).toBeNull();
    expect(row.querySelector<HTMLButtonElement>(".gl-comp-lib-edit")!.disabled).toBe(false);
    expect(row.querySelector<HTMLButtonElement>(".gl-comp-lib-duplicate")!.disabled).toBe(false);
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

describe("matrix numbers", () => {
  const tagOf = (name: string) => rowNamed(name)?.querySelector(".gl-comp-lib-tag");
  const otherMatrix2 = ["channel,FL1-A,FL2-A", "FL1-A,1,0.3", "FL2-A,0.04,1"].join("\n");

  it("gives each matrix the next number once, marks the files' own as primary, and keeps them through a saved workspace", async () => {
    vi.mocked(saveWorkspaceCheckpoint).mockClear();
    captureApply();
    await openWorkspace([testFcsFile("D1.fcs"), testFcsFile("D2.fcs")]);
    // The files came in on their own matrix: it is M1 and the primary one.
    expect(tagOf("D1 spillover")?.textContent).toBe("M1");
    expect(tagOf("D1 spillover")?.classList.contains("is-primary")).toBe(true);

    await importMatrix(otherMatrix, "treated.csv");
    expect(tagOf("treated")?.textContent).toBe("M2");
    expect(tagOf("treated")?.classList.contains("is-primary")).toBe(false);

    // Deleted, its number is not given again.
    act(() => rowNamed("treated")!.querySelector<HTMLButtonElement>(".gl-comp-lib-delete")!.click());
    act(() => button(host.querySelector('[aria-labelledby="comp-matrix-delete-title"]')!, "Delete")!.click());
    await importMatrix(otherMatrix2, "control.csv");
    expect(tagOf("control")?.textContent).toBe("M3");

    // Saved with the workspace: the checkpoint taken before Use for the workspace carries them.
    act(() => rowNamed("control")!.querySelector<HTMLButtonElement>(".gl-comp-lib-use")!.click());
    expect(dialog()!.textContent).toContain("Use M3 control for the workspace");
    act(() => dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => {
      button(dialog()!, "Use for the workspace")!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const call = vi.mocked(saveWorkspaceCheckpoint).mock.calls.find((c) => c[2] === "before-compensation-apply");
    expect(call).toBeDefined();
    const saved = call![1] as WorkspaceFile;
    const numbers = (saved.display as { matrixNumbers?: { next: number; byKey: Record<string, number>; primary?: string | null } }).matrixNumbers!;
    expect(numbers.next).toBe(4);
    expect(Object.values(numbers.byKey).sort()).toEqual([1, 2, 3]);
    expect(numbers.byKey[numbers.primary!]).toBe(1);

    // Reopened, the numbers are the saved ones, not given afresh (which would make control M2).
    vi.mocked(readWorkspaceEnvelopeFromFile).mockResolvedValue({
      raw: saved,
      fcsByPath: Object.fromEntries(saved.samples.map(({ dataPath }) => [dataPath, Uint8Array.from([70, 67, 83])])),
      storage: "bundle",
      portableAssays: null,
    } as never);
    const file = new File([Uint8Array.from([80, 75])], "analysis.gatelab");
    const handle = { kind: "file", name: "analysis.gatelab", getFile: vi.fn().mockResolvedValue(file) } as unknown as FileSystemFileHandle;
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn().mockResolvedValue([handle]) });
    const open = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Open Workspace…")!;
    await act(async () => { open.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "Compensation")!;
    act(() => tab.click());
    await settle(20);
    expect(tagOf("control")?.textContent).toBe("M3");
    expect(tagOf("D1 spillover")?.textContent).toBe("M1");
    expect(tagOf("D1 spillover")?.classList.contains("is-primary")).toBe(true);
  });

  it("makes the matrix in use when the data came in the primary one", async () => {
    const requests = captureApply();
    await openWorkspace([testFcsFile("D1.fcs")]);
    // Decided once: using another matrix later does not move it.
    await importMatrix(otherMatrix, "treated.csv");
    act(() => rowNamed("treated")!.querySelector<HTMLButtonElement>(".gl-comp-lib-use")!.click());
    act(() => dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => {
      button(dialog()!, "Use for the workspace")!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(requests).toHaveLength(1);
    expect(rowNamed("treated")!.classList.contains("is-active")).toBe(true);
    expect(tagOf("treated")?.classList.contains("is-primary")).toBe(false);
    expect(tagOf("D1 spillover")?.classList.contains("is-primary")).toBe(true);
    expect(rowNamed("D1 spillover")!.querySelector(".gl-comp-lib-meta")?.textContent).toMatch(/^Primary · /);
  });
});
