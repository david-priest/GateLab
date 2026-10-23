// @vitest-environment jsdom
//
// The FlowJo 11 workbench export, through the app: File ▸ Export ▸ "Export FlowJo 11 workbench
// (.flowjo)…" asks for the folder FlowJo 11 will find the FCS files in, lists the export's notes
// from a dry run, and downloads a .flowjo that GateLab's FlowJo 11 reader opens at the counts
// GateLab showed. Synthetic files D1.fcs, D2.fcs and D3.fcs, each with its own FSC-A range R1.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const remembered = vi.hoisted(() => new Map<string, FileSystemFileHandle>());

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));
vi.mock("./engine/workspaceHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/workspaceHistory")>();
  return {
    ...actual,
    listWorkspaceCheckpoints: vi.fn(async () => []),
    saveWorkspaceCheckpoint: vi.fn(async () => "saved"),
    requestPersistentWorkspaceHistory: vi.fn(async () => null),
  };
});
// jsdom has no IndexedDB, so the handle memory is kept in a map.
vi.mock("./engine/fsAccess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fsAccess")>();
  return {
    ...actual,
    rememberHandle: vi.fn(async (key: string, handle: FileSystemFileHandle) => { remembered.set(key, handle); }),
    recallHandle: vi.fn(async (key: string) => remembered.get(key) ?? null),
  };
});

import App from "./App";
import { resetPickerLocation } from "./engine/fsAccess";
import { flowJo11WorkbenchToWorkspace, readFlowJo11Workbench } from "./engine/flowjo11Workbench";
import { importGatingOnto, memberships, openFcs, treePopulations } from "./headless/headless";
import { MemoryFileHandle } from "./testDirectory";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
const downloads: { name: string; blob: Blob }[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  downloads.length = 0;
  URL.createObjectURL = (blob: Blob) => { downloads.push({ name: "", blob }); return "blob:export"; };
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads[downloads.length - 1].name = this.download;
  });
  try { localStorage.removeItem("gatelab.flowjo11Export.fcsFolder"); } catch { /* none */ }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  remembered.clear();
  resetPickerLocation();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  uuid = 0;
  for (const picker of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"]) {
    delete (window as unknown as Record<string, unknown>)[picker];
  }
});

/** One FCS 3.1 data set of FSC-A and SSC-A as float32, with the keywords given. */
function fcs(events: readonly (readonly [number, number])[], keywords: Record<string, string>): Uint8Array {
  const data = new Uint8Array(events.length * 8);
  const dv = new DataView(data.buffer);
  events.forEach((row, e) => row.forEach((v, c) => dv.setFloat32(e * 8 + c * 4, v, true)));
  const extra = Object.entries(keywords).map(([k, v]) => `/${k}/${v}`).join("");
  const textStart = 64;
  let begin = 0;
  let text = new Uint8Array(0);
  for (let i = 0; i < 4; i++) {
    text = new TextEncoder().encode(
      `/$BYTEORD/1,2,3,4/$DATATYPE/F/$MODE/L/$NEXTDATA/0/$PAR/2/$TOT/${events.length}` +
      "/$P1N/FSC-A/$P1B/32/$P1E/0,0/$P1R/262144/$P2N/SSC-A/$P2B/32/$P2E/0,0/$P2R/262144" +
      `${extra}/$BEGINDATA/${begin}/$ENDDATA/${begin + data.length - 1}/`);
    begin = textStart + text.length;
  }
  const out = new Uint8Array(begin + data.length);
  const head = "FCS3.1    " + [textStart, textStart + text.length - 1, begin, begin + data.length - 1, 0, 0]
    .map((n) => String(n).padStart(8)).join("");
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
  out.set(text, textStart);
  out.set(data, begin);
  return out;
}

const SOURCES = [
  { name: "D1.fcs", events: [[100, 110], [101, 111]] as const },
  { name: "D2.fcs", events: [[200, 210], [201, 211], [202, 212]] as const },
  { name: "D3.fcs", events: [[50, 60], [160, 170], [240, 250], [300, 310]] as const },
].map((s, i) => {
  const identity = { $FIL: s.name, $DATE: `0${i + 1}-JAN-2024`, $BTIM: "10:00:00", $ETIM: "10:01:00", GUID: `aaaaaaaa-0000-4000-8000-00000000000${i + 1}` };
  return { ...s, identity, bytes: fcs(s.events, identity) };
});
// Each sample's own R1: 50-150 holds D1's two events, 150-250 D2's three, 100-200 one of D3's four.
const R1 = [[50, 150], [150, 250], [100, 200]] as const;
const EXPECTED: Record<string, number> = { "D1.fcs": 2, "D2.fcs": 3, "D3.fcs": 1 };

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const DT = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const SOURCE_WSP = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0"><SampleList>${SOURCES.map((s, i) => `
  <Sample><DataSet uri="file:/data/run${i + 1}/${s.name}" sampleID="${i + 1}"/>
    <Keywords>${Object.entries({ ...s.identity, $TOT: String(s.events.length) }).map(([k, v]) => `<Keyword name="${k}" value="${v}"/>`).join("")}</Keywords>
    <SampleNode name="${s.name}" count="${s.events.length}" sampleID="${i + 1}"><Subpopulations>
      <Population name="R1" count="0"><Gate>
        <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${DT}" gating:id="ID${i + 1}">
          <gating:dimension gating:min="${R1[i][0]}" gating:max="${R1[i][1]}"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
          <gating:dimension gating:min="0" gating:max="1000"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
        </gating:RectangleGate></Gate></Population>
    </Subpopulations></SampleNode>
  </Sample>`).join("")}
</SampleList></Workspace>`;

function stubPickers(open: () => unknown[]): void {
  Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn(async () => open()) });
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn(async () => { throw new DOMException("", "AbortError"); }) });
  Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: undefined });
}
async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
const button = (label: string, within: ParentNode = host) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
async function click(label: string, within: ParentNode = host): Promise<void> {
  const target = button(label, within);
  if (!target) throw new Error(`No button "${label}"`);
  await act(async () => { target.click(); });
  await settle();
  await settle();
}
const text = () => host.textContent?.replace(/\s+/g, " ") ?? "";
const handleOf = (name: string, bytes: Uint8Array) => {
  const file = new MemoryFileHandle(name, [], name);
  file.bytes = bytes.slice();
  return file;
};

/** The three files open, each gated with its own sample's R1 from a FlowJo workspace. */
async function openSources(): Promise<void> {
  act(() => root.render(<App />));
  stubPickers(() => [handleOf("source.wsp", new TextEncoder().encode(SOURCE_WSP))]);
  await click("Open Workspace…");
  stubPickers(() => SOURCES.map((s) => handleOf(s.name, s.bytes)));
  await click("Choose FCS files…");
  expect(text()).toMatch(/3\/3\s*found/);
  // Within the dialog: the menu bar has an "Import" menu of its own.
  await click("Import", host.querySelector(".gl-modal")!);
  if (host.querySelector(".gl-modal") && button("Import", host.querySelector(".gl-modal")!)) await click("Import", host.querySelector(".gl-modal")!);
}

/** Set a text input as React sees a typed value. */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openDialog(): Promise<HTMLElement> {
  const trigger = [...host.querySelectorAll<HTMLButtonElement>(".gl-menu-trigger")].find((b) => b.textContent?.includes("Export"))!;
  act(() => trigger.click());
  const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.trim() === "Export FlowJo 11 workbench (.flowjo)…");
  expect(item).toBeTruthy();
  act(() => item!.click());
  await settle();
  return host.querySelector<HTMLElement>(".gl-modal")!;
}

describe("Export FlowJo 11 workbench (.flowjo)…", () => {
  it("downloads a workbench naming each file in the folder given, which the FlowJo 11 reader opens at GateLab's counts", async () => {
    await openSources();
    const modal = await openDialog();
    expect(modal.textContent).toContain("Export FlowJo 11 workbench");
    const radio = [...modal.querySelectorAll<HTMLInputElement>('input[name="flowjo11-export-scope"]')][1];
    act(() => radio.click());
    await settle();
    expect(modal.textContent).toMatch(/3 population\(s\) across 3 sample\(s\)/);
    const exportButton = button("Export", modal)!;
    // No folder yet, then a relative one: nothing to export.
    expect(exportButton.disabled).toBe(true);
    const folder = modal.querySelector<HTMLInputElement>('input[name="flowjo11-export-folder"]')!;
    type(folder, "data/fcs");
    expect(modal.textContent).toContain("The folder must be an absolute path");
    expect(button("Export", modal)!.disabled).toBe(true);
    type(folder, "/Users/D1/fcs");
    expect(button("Export", modal)!.disabled).toBe(false);
    await click("Export", modal);

    expect(downloads).toHaveLength(1);
    const { name, blob } = downloads[0];
    expect(name).toMatch(/\.flowjo$/);
    expect(blob.type).toBe("application/zip");
    expect(text()).toContain(`Saved ${name}: 3 samples, naming the FCS files in /Users/D1/fcs`);

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const workbench = readFlowJo11Workbench(bytes);
    const xml = flowJo11WorkbenchToWorkspace(workbench);
    expect(xml).toContain("file:/Users/D1/fcs/D1.fcs");
    const counts: Record<string, number> = {};
    for (const s of SOURCES) {
      const g = importGatingOnto(openFcs(s.bytes, s.name), s.name, xml, name);
      const m = memberships(g);
      const r1 = treePopulations(g.tree).find((p) => p.path[p.path.length - 1] === "R1")!;
      counts[s.name] = m[r1.id].reduce((a, b) => a + b, 0);
      expect(g.flowJoCounts?.R1).toBe(EXPECTED[s.name]);
    }
    expect(counts).toEqual(EXPECTED);

    // The folder is offered again next time.
    const again = await openDialog();
    expect(again.querySelector<HTMLInputElement>('input[name="flowjo11-export-folder"]')!.value).toBe("/Users/D1/fcs");
  });
});
