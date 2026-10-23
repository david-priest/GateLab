// @vitest-environment jsdom
// Save in a browser that grants a file handle and then refuses to write it (the Claude desktop
// app's browser pane, 2026-10-22): createWritable rejected with NotAllowedError, the save dialog
// had already made the file, and the save left a 0-byte workspace with only the error line to
// say so. Now the same bytes are downloaded under the chosen name, the message says so, and the
// workspace is neither marked saved nor tied to the handle. Synthetic files D1.fcs and D2.fcs.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import { readWorkspaceEnvelope } from "./engine/workspace";
import { resetHandleWritesRefused } from "./saveFallback";
import { resetHandleReadsRefused, supportsFileSystemAccess } from "./engine/fsAccess";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => null,
}));
const syntheticFcs: FcsFile = {
  version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {},
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
  ],
  columns: [Float32Array.from([10, 20, 30]), Float32Array.from([100, 200, 300])],
  spillover: null,
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

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
const downloads: { name: string; blob: Blob }[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  downloads.length = 0;
  URL.createObjectURL = (blob: Blob) => { downloads.push({ name: "", blob }); return "blob:save"; };
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
  resetHandleWritesRefused();
  resetHandleReadsRefused();
  for (const key of ["showOpenFilePicker", "showSaveFilePicker"]) delete (window as unknown as Record<string, unknown>)[key];
});

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
const text = () => host.textContent?.replace(/\s+/g, " ") ?? "";
const sideSave = () => host.querySelector<HTMLButtonElement>(".gl-side-save")!;

async function addFcs(name: string): Promise<void> {
  const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find((i) => !i.hasAttribute("webkitdirectory"))!;
  const bytes = Uint8Array.from([1]);
  const file = new File([bytes], name);
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  for (let i = 0; i < 3; i++) await settle();
}

async function clickSave(): Promise<void> {
  await act(async () => { sideSave().click(); });
  for (let i = 0; i < 4; i++) await settle();
}

/** A handle that writes until `refuse.now` is set, then rejects createWritable as the pane did. */
function handle(name: string, refuse: { now: boolean }) {
  const file: { bytes: Uint8Array } = { bytes: new Uint8Array(0) };
  const h = {
    kind: "file",
    name,
    file,
    createWritable: vi.fn(async () => {
      if (refuse.now) {
        throw new DOMException(
          "Failed to execute 'createWritable' on 'FileSystemFileHandle': The request is not allowed by the user agent or the platform in the current context.",
          "NotAllowedError",
        );
      }
      const parts: Uint8Array[] = [];
      return {
        write: async (data: Uint8Array) => { parts.push(new Uint8Array(data)); },
        close: async () => { file.bytes = parts.length === 1 ? parts[0] : new Uint8Array(0); },
        abort: async () => undefined,
      };
    }),
    getFile: async () => new File([file.bytes as BlobPart], name),
    queryPermission: async () => "granted" as PermissionState,
    requestPermission: async () => "granted" as PermissionState,
    // As the pane: removing the empty file is refused too.
    remove: vi.fn(async () => { throw new DOMException("not allowed", "NotAllowedError"); }),
  };
  return h;
}

function stubPickers(next: () => unknown) {
  Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn() });
  const save = vi.fn(async () => next());
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: save });
  return save;
}

const sampleNames = async (blob: Blob): Promise<string[]> => {
  const { raw } = readWorkspaceEnvelope(new Uint8Array(await blob.arrayBuffer()));
  return JSON.stringify(raw).match(/D\d\.fcs/g)?.filter((n, i, all) => all.indexOf(n) === i) ?? [];
};

describe("Save where the browser refuses to write the file it chose", () => {
  it("downloads the workspace under the chosen name, says the chosen file is empty, and keeps nothing of it", async () => {
    const refused = handle("chosen.gatelab", { now: true });
    const save = stubPickers(() => refused);
    act(() => root.render(<App />));
    await addFcs("D1.fcs");
    expect(sideSave().textContent).toBe("Save…");

    await clickSave();

    expect(save).toHaveBeenCalledTimes(1);
    expect(downloads.map((d) => d.name)).toEqual(["chosen.gatelab"]);
    expect(await sampleNames(downloads[0].blob)).toEqual(["D1.fcs"]);
    expect(refused.remove).toHaveBeenCalledTimes(1);
    expect(text()).toContain(
      "This browser would not let GateLab write to the file you chose, so it was downloaded instead: chosen.gatelab. " +
        "The file chosen.gatelab where you chose is empty; the download holds what was saved. The workspace is not marked saved.",
    );
    // Not saved, and no handle kept: the button still asks where, and no workspace is named.
    expect(sideSave().textContent).toBe("Save…");
    expect(text()).toContain("No workspace file yet");
    expect(text()).not.toContain("Saved ·");

    // The next Save does not open another dialog (another empty file); it downloads directly.
    await clickSave();
    expect(save).toHaveBeenCalledTimes(1);
    expect(refused.createWritable).toHaveBeenCalledTimes(1);
    expect(downloads.map((d) => d.name)).toEqual(["chosen.gatelab", "D1.gatelab"]);
    expect(await sampleNames(downloads[1].blob)).toEqual(["D1.fcs"]);
    // It takes the ordinary download path, as a browser without file handles does.
    expect(supportsFileSystemAccess()).toBe(false);
  });

  it("in place: downloads under the open file's name, lets the handle go, and leaves the workspace unsaved", async () => {
    const refuse = { now: false };
    const opened = handle("D1.gatelab", refuse);
    const save = stubPickers(() => opened);
    act(() => root.render(<App />));
    await addFcs("D1.fcs");
    await clickSave();
    expect(text()).toContain("Saved · D1.gatelab");
    const firstSave = opened.file.bytes;
    expect(firstSave.byteLength).toBeGreaterThan(0);

    await addFcs("D2.fcs");
    expect(text()).toContain("D1.gatelab (unsaved)");
    expect(sideSave().textContent).toBe("Save ●");

    refuse.now = true;
    await clickSave();

    expect(downloads.map((d) => d.name)).toEqual(["D1.gatelab"]);
    expect(await sampleNames(downloads[0].blob)).toEqual(["D1.fcs", "D2.fcs"]);
    expect(opened.file.bytes).toBe(firstSave);
    expect(text()).toContain(
      "This browser would not let GateLab write to D1.gatelab, so it was downloaded instead: D1.gatelab. " +
        "The file you opened was not changed. The workspace is not marked saved.",
    );
    expect(text()).toContain("D1.gatelab (unsaved)");
    expect(sideSave().textContent).toBe("Save…");

    // The broken handle is not tried again, silently or otherwise.
    const writesBefore = opened.createWritable.mock.calls.length;
    await clickSave();
    expect(opened.createWritable).toHaveBeenCalledTimes(writesBefore);
    expect(save).toHaveBeenCalledTimes(1);
    expect(downloads).toHaveLength(2);
  });
});
