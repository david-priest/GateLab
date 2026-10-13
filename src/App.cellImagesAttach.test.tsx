// @vitest-environment jsdom

// Attaching a FACSDiscover S8 waveform file (.cvw) to a sample: picked together with its FCS,
// refused when it is not that file's recording, attached and detached by hand from the Import
// menu, and recorded in a saved workspace by name and identity only.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { FcsFile } from "./engine/fcs";
import { buildSyntheticCvw } from "./imaging/cvwFixture";
import { memoryFile } from "./testDirectory";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));

const syntheticFcs: FcsFile = {
  version: "FCS3.1",
  nEvents: 3,
  instrument: "flow",
  keywords: {
    BD_IMAGEWALL_SETTINGS: JSON.stringify({ ChannelSettings: [{ ChannelNumber: 2, Enabled: true, Color: 12434877 }] }),
  },
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
  ],
  columns: [Float32Array.from([100, 200, 300]), Float32Array.from([150, 250, 350])],
  spillover: null,
};

vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => syntheticFcs };
});

const remembered = vi.hoisted(() => ({ calls: [] as [string, FileSystemFileHandle][] }));
vi.mock("./engine/fsAccess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fsAccess")>();
  return {
    ...actual,
    rememberHandle: vi.fn(async (key: string, handle: FileSystemFileHandle) => { remembered.calls.push([key, handle]); }),
    recallHandle: vi.fn(async () => null),
  };
});

import App from "./App";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  remembered.calls.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  uuid = 0;
  for (const key of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"]) {
    delete (window as unknown as Record<string, unknown>)[key];
  }
});

const cvwBytes = (events: number, recordingId = "rec-a") =>
  buildSyntheticCvw(Array.from({ length: events }, (_, i) => (i === 1 ? { noWaveform: true } : { samples: 256 })), { recordingId });

function handleOf(name: string, bytes: Uint8Array): FileSystemFileHandle {
  return {
    kind: "file",
    name,
    getFile: vi.fn(async () => memoryFile(name, bytes)),
    queryPermission: vi.fn(async () => "granted"),
    requestPermission: vi.fn(async () => "granted"),
  } as unknown as FileSystemFileHandle;
}

const fcsHandle = (name: string) => handleOf(name, Uint8Array.from([70, 67, 83]));

function installPickers(open: FileSystemFileHandle[][]) {
  const showOpenFilePicker = vi.fn();
  for (const batch of open) showOpenFilePicker.mockResolvedValueOnce(batch);
  Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: showOpenFilePicker });
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn() });
  return showOpenFilePicker;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

async function click(label: string): Promise<void> {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
  expect(button, label).toBeTruthy();
  await act(async () => { button!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  for (let i = 0; i < 3; i++) await settle();
}

const rows = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')];
const badgeIn = (row: HTMLElement) => row.querySelector<HTMLElement>(".gl-sample-images");

describe("attaching cell images", () => {
  it("attaches the .cvw picked with its FCS and refuses one of another length, keeping that FCS", async () => {
    const aCvw = handleOf("D1.cvw", cvwBytes(3));
    installPickers([[fcsHandle("D1.fcs"), aCvw, fcsHandle("D2.fcs"), handleOf("D2.cvw", cvwBytes(5))]]);
    act(() => root.render(<App />));
    await click("+ Files…");
    expect(rows().map((r) => r.textContent?.includes("D1.fcs") || r.textContent?.includes("D2.fcs"))).toEqual([true, true]);
    const [d1, d2] = rows();
    expect(badgeIn(d1)).toBeTruthy();
    expect(badgeIn(d1)!.title).toBe("Cell images attached: D1.cvw");
    expect(badgeIn(d2)).toBeNull();
    expect(host.textContent).toContain("Cell images attached to 1.");
    expect(host.textContent).toContain("D2.cvw holds 5 events but the FCS has 3");
    // The first images in the workspace show themselves: dots, coloured by whether an event has one.
    expect(host.textContent).toContain("Display · Dots");
    expect(host.querySelector('button[aria-label="Colour by"]')?.textContent).toContain("Has an image");
    expect(remembered.calls.some(([key, handle]) => key === "cvw:D1.fcs" && handle === aCvw)).toBe(true);
  });

  it("attaches and detaches from the Import menu for the viewed sample", async () => {
    const picker = installPickers([[fcsHandle("D1.fcs")], [handleOf("D1.cvw", cvwBytes(3))]]);
    act(() => root.render(<App />));
    await click("+ Files…");
    expect(badgeIn(rows()[0])).toBeNull();
    expect(host.textContent).toContain("Display · Pseudocolor");
    // Choosing any colouring under pseudocolour shows dots, where the colouring can be seen.
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Colour by"]')!.click(); });
    const list = host.querySelector<HTMLSelectElement>(".gl-searchable-select-panel select")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(list, "population");
      list.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await settle();
    expect(host.textContent).toContain("Display · Dots");
    const detachBefore = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Detach cell images");
    expect(detachBefore).toBeUndefined();
    await click("Attach cell images (.cvw)…");
    expect(picker).toHaveBeenCalledTimes(2);
    expect(badgeIn(rows()[0])).toBeTruthy();
    expect(host.textContent).toContain("Cell images attached to D1.fcs: D1.cvw, 3 events.");
    expect(host.textContent).toContain("Display · Dots");
    expect(host.querySelector('button[aria-label="Colour by"]')?.textContent).toContain("Has an image");
    const replace = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Replace cell images (.cvw)…");
    expect(replace).toBeTruthy();
    await click("Detach cell images");
    expect(badgeIn(rows()[0])).toBeNull();
    expect(host.textContent).toContain("Cell images detached from D1.fcs.");
  });

  it("takes a .cvw chosen through Open Workspace to the loaded file of its name, or says where it goes", async () => {
    installPickers([[handleOf("D1.cvw", cvwBytes(3))], [fcsHandle("D1.fcs")], [handleOf("D1.cvw", cvwBytes(3))]]);
    act(() => root.render(<App />));
    await click("Open Workspace…");
    expect(host.textContent).toContain("D1.cvw holds a file's cell images, not a workspace");
    expect(rows()).toHaveLength(0);
    await click("+ Files…");
    expect(badgeIn(rows()[0])).toBeNull();
    await click("Open Workspace…");
    expect(badgeIn(rows()[0])).toBeTruthy();
    expect(host.textContent).toContain("Cell images attached to D1.fcs: D1.cvw");
  });

  it("refuses a file that is not a waveform file, by name", async () => {
    installPickers([[fcsHandle("D1.fcs")], [handleOf("notes.cvw", new TextEncoder().encode("nothing here"))]]);
    act(() => root.render(<App />));
    await click("+ Files…");
    await click("Attach cell images (.cvw)…");
    expect(badgeIn(rows()[0])).toBeNull();
    expect(host.textContent).toContain("Cell images not attached: notes.cvw: ");
  });

  it("records the attachment in a saved workspace by name and identity, never the file", async () => {
    const written: Uint8Array[] = [];
    const saveHandle = {
      kind: "file",
      name: "D1-bundle.gatelab",
      createWritable: async () => ({
        write: async (chunk: unknown) => { written.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer)); },
        close: async () => undefined,
      }),
      getFile: async () => new File([], "D1-bundle.gatelab"),
    } as unknown as FileSystemFileHandle;
    installPickers([[fcsHandle("D1.fcs"), handleOf("D1.cvw", cvwBytes(3, "rec-xyz"))]]);
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn(async () => saveHandle) });
    act(() => root.render(<App />));
    await click("+ Files…");
    expect(badgeIn(rows()[0])).toBeTruthy();
    await click("Save Portable Copy…");
    for (let i = 0; i < 4; i++) await settle();
    const bytes = new Uint8Array(written.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const chunk of written) { bytes.set(chunk, at); at += chunk.byteLength; }
    const files = unzipSync(bytes);
    const workspace = JSON.parse(strFromU8(files["workspace.json"])) as { samples: { images?: unknown }[] };
    expect(workspace.samples[0].images).toEqual([{ kind: "cvw", fileName: "D1.cvw", eventCount: 3, recordingId: "rec-xyz" }]);
    expect(Object.keys(files).some((name) => name.endsWith(".cvw"))).toBe(false);
  });
});
