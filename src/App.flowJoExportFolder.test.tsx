// @vitest-environment jsdom
//
// The FlowJo export written as a self-contained folder, through the app: the .wsp beside the FCS
// files it names, each the bytes GateLab loaded, and the folder opened again through "Use the
// workspace's folder…" with every file paired with its own sample by its keywords. Where the
// browser cannot write a folder, the same folder as one stored .zip. Synthetic files: two
// acquisitions both named D1.fcs, and "D2 #1 & 2.fcs", each with its own FSC-A range gate; three
// whose names Chrome will not write to disk; and two whose names APFS takes to be one.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unzipSync } from "fflate";

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
import { lastGrantedDirectory, lastPickerLocation, resetPickerLocation } from "./engine/fsAccess";
import { GateLabHostProvider } from "./host/HostContext";
import { GATELAB_DATASET_CONTRACT_VERSION, type GateLabHostDatasetDescriptor } from "./host/datasetContract";
import { GATELAB_HOST_CONTRACT_VERSION, type GateLabHostAdapter } from "./host/contracts";
import { apfsFold, MemoryDirectoryHandle, MemoryFileHandle, memoryFile } from "./testDirectory";

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

interface SourceFile {
  name: string;
  identity: Record<string, string>;
  events: readonly (readonly [number, number])[];
  bytes: Uint8Array;
}

const D2_NAME = "D2 #1 & 2.fcs";
/** Two acquisitions both named D1.fcs, told apart only by their keywords, and D2. */
const SOURCES: SourceFile[] = [
  {
    name: "D1.fcs",
    identity: { $FIL: "D1.fcs", $DATE: "01-JAN-2024", $BTIM: "10:00:00", $ETIM: "10:01:00", GUID: "aaaaaaaa-0000-4000-8000-000000000001" },
    events: [[100, 110], [101, 111]] as const,
  },
  {
    name: "D1.fcs",
    identity: { $FIL: "D1.fcs", $DATE: "02-JAN-2024", $BTIM: "11:00:00", $ETIM: "11:01:00", GUID: "aaaaaaaa-0000-4000-8000-000000000002" },
    events: [[200, 210], [201, 211], [202, 212]] as const,
  },
  {
    name: D2_NAME,
    identity: { $FIL: D2_NAME, $DATE: "03-JAN-2024", $BTIM: "12:00:00", $ETIM: "12:01:00", GUID: "aaaaaaaa-0000-4000-8000-000000000003" },
    events: [[50, 60], [160, 170], [240, 250], [300, 310]] as const,
  },
].map((s) => ({ ...s, bytes: fcs(s.events, s.identity) }));

// Each sample's own R1: 50-150 holds both of the first D1's events, 150-250 the second D1's
// three, 100-200 one of D2's four. A D1 given the other D1's tree holds none.
const R1 = [[50, 150], [150, 250], [100, 200]] as const;
const EXPECTED = { "D1.fcs": ["2", "3"], [D2_NAME]: ["1"] };

/**
 * Three files whose names Chrome will not write to disk: a ":" (a "/" in a Finder name), a
 * reserved device name, and a trailing ".". The same events and gates as SOURCES, in order.
 */
const REFUSED: SourceFile[] = ["D1 1:2.fcs", "aux.fcs", "D3.fcs."].map((name, i) => {
  const identity = { $FIL: name, $DATE: `0${i + 4}-JAN-2024`, $BTIM: "09:00:00", $ETIM: "09:01:00", GUID: `aaaaaaaa-0000-4000-8000-00000000001${i}` };
  return { name, identity, events: SOURCES[i].events, bytes: fcs(SOURCES[i].events, identity) };
});
/**
 * Two files whose names APFS takes to be one, the first with the micro sign and the second with
 * Greek mu, and a third. The same events and gates as SOURCES, in order.
 */
const FOLDED: SourceFile[] = ["D1 1\u00b5g.fcs", "D1 1\u03bcg.fcs", "D2.fcs"].map((name, i) => {
  const identity = { $FIL: name, $DATE: `0${i + 7}-JAN-2024`, $BTIM: "08:00:00", $ETIM: "08:01:00", GUID: `aaaaaaaa-0000-4000-8000-00000000002${i}` };
  return { name, identity, events: SOURCES[i].events, bytes: fcs(SOURCES[i].events, identity) };
});
/** A folder refusing names as Chrome does, for the names these tests use. */
const chromeRefuses = (name: string): boolean =>
  /[":*?<>|]/.test(name) || /[ .~]$/.test(name) || /^(con|prn|aux|nul)(\.|$)/i.test(name);

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const DT = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const xmlAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
/** A workspace FlowJo wrote on another machine over the three files, one R1 per sample. */
const sourceWsp = (sources: readonly SourceFile[]) => `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0"><SampleList>${sources.map((s, i) => `
  <Sample><DataSet uri="${xmlAttr(`file:/data/run${i + 1}/${encodeURI(s.name)}`)}" sampleID="${i + 1}"/>
    <Keywords>${Object.entries({ ...s.identity, $TOT: String(s.events.length) }).map(([k, v]) => `<Keyword name="${k}" value="${xmlAttr(v)}"/>`).join("")}</Keywords>
    <SampleNode name="${xmlAttr(s.name)}" count="${s.events.length}" sampleID="${i + 1}"><Subpopulations>
      <Population name="R1" count="0"><Gate>
        <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${DT}" gating:id="ID${i + 1}">
          <gating:dimension gating:min="${R1[i][0]}" gating:max="${R1[i][1]}"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
          <gating:dimension gating:min="0" gating:max="1000"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
        </gating:RectangleGate></Gate></Population>
    </Subpopulations></SampleNode>
  </Sample>`).join("")}
</SampleList></Workspace>`;
const SOURCE_WSP = sourceWsp(SOURCES);

function stubPickers(open: () => unknown[], directory?: () => unknown): void {
  Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn(async () => open()) });
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn(async () => { throw new DOMException("", "AbortError"); }) });
  Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: directory ? vi.fn(async () => directory()) : undefined });
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

/** R1's count on every file, by file name, each list sorted, under the tree that file follows. */
async function countsByName(names: readonly string[] = SOURCES.map((s) => s.name)): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const rows = () => [...host.querySelectorAll<HTMLElement>(".gl-sample-row")];
  // The longest first: "D3.fcs" is inside "D3.fcs.", "aux.fcs" inside "_aux.fcs".
  const byLength = [...names].sort((a, b) => b.length - a.length);
  for (let i = 0; i < rows().length; i++) {
    const row = rows()[i];
    const name = byLength.find((n) => row.textContent?.includes(n));
    if (!name) throw new Error(`No known file in row ${row.textContent}`);
    await act(async () => { row.click(); });
    await settle();
    const own = host.querySelector<HTMLButtonElement>(".population-tree-edit-file");
    if (own && !own.disabled && own.getAttribute("aria-pressed") !== "true") {
      await act(async () => { own.click(); });
      await settle();
    }
    const r1 = [...host.querySelectorAll(".pop-row")].map((r) => r.textContent?.replace(/\s+/g, " ").trim()).find((t) => t?.startsWith("R1"));
    (out[name] ??= []).push(/R1\+(\d+)\(/.exec(r1 ?? "")?.[1] ?? "none");
  }
  for (const list of Object.values(out)) list.sort();
  return out;
}

/** Open a workspace from its handle, gather its files with `gather`, and import every file's own tree. */
async function openWorkspace(wsp: unknown, gather: () => Promise<void>): Promise<void> {
  stubPickers(() => [wsp], undefined);
  await click("Open Workspace…");
  expect(text()).toContain("Open FlowJo workspace");
  await gather();
  expect(text()).toMatch(/3\/3\s*found/);
  expect(text()).not.toContain("not paired");
  await click("Import");
  expect(text()).toContain("Each of these 3 files gets its own sample's tree");
  await click("Import");
}

const handleOf = (name: string, bytes: Uint8Array) => {
  const file = new MemoryFileHandle(name, [], name);
  file.bytes = bytes.slice();
  return file;
};

/** The three files open, each gated with its own sample's R1 from a FlowJo workspace. */
async function openSources(): Promise<void> {
  act(() => root.render(<App />));
  await openWorkspace(handleOf("source.wsp", new TextEncoder().encode(SOURCE_WSP)), async () => {
    stubPickers(() => SOURCES.map((s) => handleOf(s.name, s.bytes)));
    await click("Choose FCS files…");
  });
  expect(await countsByName()).toEqual(EXPECTED);
}

/** Export every file as a FlowJo workspace, with the folder option as given; the dialog's text before exporting. */
async function exportFlowJo(
  asFolder: boolean,
  scope: "checked" | "all" = "all",
  inDialog: readonly string[] = asFolder && scope === "all" ? ["2/D1.fcs"] : [],
): Promise<string> {
  const trigger = [...host.querySelectorAll<HTMLButtonElement>(".gl-menu-trigger")].find((b) => b.textContent?.includes("Export"))!;
  act(() => trigger.click());
  const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.trim() === "Export FlowJo workspace…")!;
  act(() => item.click());
  await settle();
  const modal = host.querySelector<HTMLElement>(".gl-modal")!;
  const radio = [...modal.querySelectorAll<HTMLInputElement>('input[name="flowjo-export-scope"]')][scope === "all" ? 1 : 0];
  act(() => radio.click());
  const box = modal.querySelector<HTMLInputElement>('input[name="flowjo-export-folder"]')!;
  expect(box.checked).toBe(false);
  if (asFolder) act(() => box.click());
  await settle();
  if (asFolder) {
    for (const expected of inDialog) expect(modal.textContent).toContain(expected);
    expect(modal.textContent).not.toContain("GateLab does not hold the bytes");
  }
  const said = modal.textContent?.replace(/\s+/g, " ") ?? "";
  await click("Export", modal);
  for (let i = 0; i < 4; i++) await settle();
  return said;
}

/** Each sample's DataSet uri and SampleNode name in a written workspace. */
function dataSets(xml: string): [string | null, string | null][] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  return [...doc.getElementsByTagName("Sample")].map((s) => [
    s.getElementsByTagName("DataSet")[0].getAttribute("uri"),
    s.getElementsByTagName("SampleNode")[0].getAttribute("name"),
  ]);
}

// Named after the viewed file, the last opened.
const STEM = "D2__1___2_and_2_more";
const FOLDER_URIS = [["file:D1.fcs", "D1.fcs"], ["file:2/D1.fcs", "D1.fcs"], ["file:D2%20%231%20%26%202.fcs", D2_NAME]];

describe("a FlowJo workspace exported with its FCS files, as a folder", () => {
  it("writes each file's bytes unchanged beside the workspace, which opens again from the folder with the same counts", async () => {
    await openSources();
    const parent = new MemoryDirectoryHandle("Exports");
    stubPickers(() => [], () => parent);
    await exportFlowJo(true);
    expect(text()).toContain(`Wrote ${STEM} in Exports: ${STEM}.wsp and 3 FCS files`);

    const files = parent.files();
    expect([...files.keys()].sort()).toEqual([`${STEM}/2/D1.fcs`, `${STEM}/D1.fcs`, `${STEM}/${D2_NAME}`, `${STEM}/${STEM}.wsp`].sort());
    // Byte for byte the files loaded: every keyword, $TOT, $DATE, $BTIM, $ETIM and GUID as recorded.
    expect(files.get(`${STEM}/D1.fcs`)).toEqual(SOURCES[0].bytes);
    expect(files.get(`${STEM}/2/D1.fcs`)).toEqual(SOURCES[1].bytes);
    expect(files.get(`${STEM}/${D2_NAME}`)).toEqual(SOURCES[2].bytes);
    const xml = new TextDecoder().decode(files.get(`${STEM}/${STEM}.wsp`));
    expect(dataSets(xml)).toEqual(FOLDER_URIS);
    // The workspace is written last.
    expect(parent.log[parent.log.length - 1]).toBe(`${STEM}/${STEM}.wsp`);

    // A fresh session, remembering no folder: the workspace's folder is chosen once.
    act(() => root.unmount());
    root = createRoot(host);
    remembered.clear();
    resetPickerLocation();
    act(() => root.render(<App />));
    const folder = parent.entries.get(STEM) as MemoryDirectoryHandle;
    await openWorkspace(folder.entries.get(`${STEM}.wsp`), async () => {
      stubPickers(() => [], () => folder);
      await click("Use the workspace's folder…");
    });
    expect(await countsByName()).toEqual(EXPECTED);
  });

  it("leaves the data folder GateLab remembers as it was, and starts the next picker in the new folder", async () => {
    // The data: the workspace, D1 and D2 at the top, the second D1 in a folder of its own.
    const data = new MemoryDirectoryHandle("Data");
    const sourceWsp = data.put("source.wsp", new TextEncoder().encode(SOURCE_WSP));
    data.put("D1.fcs", SOURCES[0].bytes);
    data.put(D2_NAME, SOURCES[2].bytes);
    (await data.getDirectoryHandle("run2", { create: true })).put("D1.fcs", SOURCES[1].bytes);
    act(() => root.render(<App />));
    await openWorkspace(sourceWsp, async () => {
      stubPickers(() => [], () => data);
      await click("Use the workspace's folder…");
    });
    expect(await countsByName()).toEqual(EXPECTED);
    expect(lastGrantedDirectory()).toBe(data);

    const parent = new MemoryDirectoryHandle("Exports");
    stubPickers(() => [], () => parent);
    await exportFlowJo(true);
    const [stem] = [...parent.entries.keys()];
    expect(text()).toContain(`Wrote ${stem} in Exports: ${stem}.wsp and 3 FCS files`);
    expect(lastGrantedDirectory()).toBe(data);
    expect(lastPickerLocation()).toBe(parent.entries.get(stem));

    // Later in the session, a workspace from the data folder still finds its files there without
    // asking: the two at the top, as GateLab reads a remembered folder.
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<App />));
    const directoryPicker = vi.fn(async () => { throw new Error("The folder was asked for."); });
    stubPickers(() => [sourceWsp], undefined);
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: directoryPicker });
    await click("Open Workspace…");
    for (let i = 0; i < 4; i++) await settle();
    expect(text()).toMatch(/2\/3\s*found/);
    expect(directoryPicker).not.toHaveBeenCalled();
  });

  it("writes the workspace alone, as before, with the option left off", async () => {
    await openSources();
    await exportFlowJo(false);
    expect(downloads.map((d) => d.name)).toEqual([`${STEM}.wsp`]);
    const xml = await downloads[0].blob.text();
    expect(dataSets(xml)).toEqual([["file:D1.fcs", "D1.fcs"], ["file:D1.fcs", "D1.fcs"], ["file:D2%20#1%20&%202.fcs", D2_NAME]]);
  });
});

describe("a FlowJo workspace exported with its FCS files, where the browser cannot write a folder", () => {
  it("downloads one stored .zip of the folder, which opens again with the same counts", async () => {
    await openSources();
    stubPickers(() => []);
    const said = await exportFlowJo(true);
    expect(downloads.map((d) => d.name)).toEqual([`${STEM}.zip`]);
    const zip = new Uint8Array(await downloads[0].blob.arrayBuffer());
    // The size stated before writing counts the workspace, and is not less than what was written.
    const stated = /3 FCS files, (?:at most )?([\d.]+) (bytes|kB)/.exec(said);
    expect(stated).not.toBeNull();
    expect(stated![2] === "kB" ? Number(stated![1]) * 1000 + 50 : Number(stated![1])).toBeGreaterThanOrEqual(zip.byteLength);
    expect(said).toContain("in all.");
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual([`${STEM}/2/D1.fcs`, `${STEM}/D1.fcs`, `${STEM}/${D2_NAME}`, `${STEM}/${STEM}.wsp`].sort());
    expect(entries[`${STEM}/D1.fcs`]).toEqual(SOURCES[0].bytes);
    expect(entries[`${STEM}/2/D1.fcs`]).toEqual(SOURCES[1].bytes);
    expect(entries[`${STEM}/${D2_NAME}`]).toEqual(SOURCES[2].bytes);
    expect(dataSets(new TextDecoder().decode(entries[`${STEM}/${STEM}.wsp`]))).toEqual(FOLDER_URIS);
    expect(text()).toContain(`Saved ${STEM}.zip, stored uncompressed: ${STEM}.wsp and 3 FCS files`);

    // Unzipped, the folder opens as the written one does.
    const unzipped = new MemoryDirectoryHandle(STEM);
    for (const [path, bytes] of Object.entries(entries)) {
      const parts = path.split("/").slice(1);
      let dir = unzipped;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      dir.put(parts[parts.length - 1], bytes);
    }
    act(() => root.unmount());
    root = createRoot(host);
    remembered.clear();
    act(() => root.render(<App />));
    await openWorkspace(unzipped.entries.get(`${STEM}.wsp`), async () => {
      stubPickers(() => [], () => unzipped);
      await click("Use the workspace's folder…");
    });
    expect(await countsByName()).toEqual(EXPECTED);
  });
});

describe("a FlowJo folder export of files whose names Chrome will not write", () => {
  const WRITTEN = ["D1 1_2.fcs", "_aux.fcs", "D3.fcs"];

  it("lists them first, writes each under a name Chrome writes, and the folder opens again with every file paired", async () => {
    act(() => root.render(<App />));
    await openWorkspace(handleOf("source.wsp", new TextEncoder().encode(sourceWsp(REFUSED))), async () => {
      stubPickers(() => REFUSED.map((s) => handleOf(s.name, s.bytes)));
      await click("Choose FCS files…");
    });
    const expected = { "D1 1:2.fcs": ["2"], "aux.fcs": ["3"], "D3.fcs.": ["1"] };
    expect(await countsByName(REFUSED.map((s) => s.name))).toEqual(expected);

    // A folder that refuses these names, as Chrome does.
    const parent = new MemoryDirectoryHandle("Exports", [], "", { refuse: chromeRefuses });
    stubPickers(() => [], () => parent);
    const said = await exportFlowJo(true, "all", ["D1 1:2.fcs → D1 1_2.fcs", "aux.fcs → _aux.fcs", "D3.fcs. → D3.fcs"]);
    expect(said).toContain("Chrome will not write these names as they are");
    expect(host.querySelector('[role="alert"]')?.textContent ?? "").not.toContain("Stopped");
    const [stem] = [...parent.entries.keys()];
    expect(text()).toContain(`Wrote ${stem} in Exports`);
    expect(text()).toContain("3 written under another name");

    const files = parent.files();
    expect([...files.keys()].sort()).toEqual([...WRITTEN.map((n) => `${stem}/${n}`), `${stem}/${stem}.wsp`].sort());
    WRITTEN.forEach((name, i) => expect(files.get(`${stem}/${name}`)).toEqual(REFUSED[i].bytes));
    // The uri and the sample name the file written; its keywords are the file's own.
    const xml = new TextDecoder().decode(files.get(`${stem}/${stem}.wsp`));
    expect(dataSets(xml)).toEqual([["file:D1%201_2.fcs", "D1 1_2.fcs"], ["file:_aux.fcs", "_aux.fcs"], ["file:D3.fcs", "D3.fcs"]]);
    for (const s of REFUSED) expect(xml).toContain(`<Keyword name="$FIL" value="${s.name}" />`);

    // A fresh session: the folder opens with each file paired with its own sample.
    act(() => root.unmount());
    root = createRoot(host);
    remembered.clear();
    resetPickerLocation();
    act(() => root.render(<App />));
    const folder = parent.entries.get(stem) as MemoryDirectoryHandle;
    await openWorkspace(folder.entries.get(`${stem}.wsp`), async () => {
      stubPickers(() => [], () => folder);
      await click("Use the workspace's folder…");
    });
    expect(await countsByName(WRITTEN)).toEqual({ "D1 1_2.fcs": ["2"], "_aux.fcs": ["3"], "D3.fcs": ["1"] });
  });
});

describe("a FlowJo folder export of files whose names APFS takes to be one", () => {
  it("writes both, the second in a subfolder, and the folder opens again with every file paired", async () => {
    act(() => root.render(<App />));
    await openWorkspace(handleOf("source.wsp", new TextEncoder().encode(sourceWsp(FOLDED))), async () => {
      stubPickers(() => FOLDED.map((s) => handleOf(s.name, s.bytes)));
      await click("Choose FCS files…");
    });
    const names = FOLDED.map((s) => s.name);
    const expected = { [names[0]]: ["2"], [names[1]]: ["3"], [names[2]]: ["1"] };
    expect(await countsByName(names)).toEqual(expected);

    // A folder comparing names as APFS does.
    const parent = new MemoryDirectoryHandle("Exports", [], "", { fold: apfsFold });
    stubPickers(() => [], () => parent);
    await exportFlowJo(true, "all", [`2/${names[1]}`]);
    const [stem] = [...parent.entries.keys()];
    expect(text()).toContain(`Wrote ${stem} in Exports: ${stem}.wsp and 3 FCS files`);

    const files = parent.files();
    expect([...files.keys()].sort()).toEqual([`${stem}/${names[0]}`, `${stem}/2/${names[1]}`, `${stem}/${names[2]}`, `${stem}/${stem}.wsp`].sort());
    expect(files.get(`${stem}/${names[0]}`)).toEqual(FOLDED[0].bytes);
    expect(files.get(`${stem}/2/${names[1]}`)).toEqual(FOLDED[1].bytes);
    expect(files.get(`${stem}/${names[2]}`)).toEqual(FOLDED[2].bytes);
    const xml = new TextDecoder().decode(files.get(`${stem}/${stem}.wsp`));
    expect(dataSets(xml)).toEqual([["file:D1%201%C2%B5g.fcs", names[0]], ["file:2/D1%201%CE%BCg.fcs", names[1]], ["file:D2.fcs", names[2]]]);

    // A fresh session: the folder opens with each file paired with its own sample.
    act(() => root.unmount());
    root = createRoot(host);
    remembered.clear();
    resetPickerLocation();
    act(() => root.render(<App />));
    const folder = parent.entries.get(stem) as MemoryDirectoryHandle;
    await openWorkspace(folder.entries.get(`${stem}.wsp`), async () => {
      stubPickers(() => [], () => folder);
      await click("Use the workspace's folder…");
    });
    expect(await countsByName(names)).toEqual(expected);
  });
});

describe("a FlowJo folder export that fails part way", () => {
  it("says which file it stopped at and that the folder is incomplete, and leaves no workspace in it", async () => {
    await openSources();
    const parent = new MemoryDirectoryHandle("Exports", [], "", {
      fail: (path, step) => path === `${STEM}/2/D1.fcs` && step === "write",
    });
    stubPickers(() => [], () => parent);
    await exportFlowJo(true);
    expect(text()).toContain(
      `Stopped at 2/D1.fcs: The disk is full. The folder ${STEM} in Exports is incomplete: it holds 1 of the 3 FCS files and no workspace. Export again.`,
    );
    expect(text()).not.toContain(`Writing ${STEM}`);
    expect([...parent.files().keys()].some((path) => path.endsWith(".wsp"))).toBe(false);
  });
});

describe("a FlowJo folder export of files whose bytes GateLab does not hold", () => {
  const dataset: GateLabHostDatasetDescriptor = {
    contractVersion: GATELAB_DATASET_CONTRACT_VERSION,
    id: "sce", label: "Hosted SCE", instrument: "cytof", eventCount: 3,
    channels: [{ id: "CD3", label: "CD3", pnn: "Nd142Di", pns: "CD3" }, { id: "CD19", label: "CD19", pnn: "Eu151Di", pns: "CD19" }],
    assays: [{ id: "counts", label: "counts", role: "counts", coordinateSpace: "linear", revision: 0, encoding: "channel-major-float32-le" }],
    defaultAssayId: "counts",
    samples: [
      { id: "s1", label: "D1", eventCount: 2, metadata: {}, assayByteLength: 16, eventIndexEncoding: "uint32-le", eventIndexByteLength: 8 },
      { id: "s2", label: "D2", eventCount: 1, metadata: {}, assayByteLength: 8, eventIndexEncoding: "uint32-le", eventIndexByteLength: 4 },
    ],
  };
  const f32 = (values: number[]) => new Float32Array(values).buffer as ArrayBuffer;
  const u32 = (values: number[]) => new Uint32Array(values).buffer as ArrayBuffer;
  const sceHost: GateLabHostAdapter = {
    contractVersion: GATELAB_HOST_CONTRACT_VERSION, id: "test-r-host", kind: "r-sce", label: "Test R host",
    capabilities: {
      dataSources: { fcsFiles: false, singleCellExperiment: true },
      dataModel: { multipleAssays: true, sampleMetadata: true, writeBackColumns: true },
      persistence: { workspaceFiles: false, hostObject: true, fileSystemAccess: false, directoryAccess: false },
      compute: { location: "host" },
    },
    datasets: {
      async listDatasets() { return [dataset]; },
      async readAssay(_d, sampleId) { return sampleId === "s1" ? f32([5, 10, 20, 25]) : f32([15, 30]); },
      async readEventIndex(_d, sampleId) { return sampleId === "s1" ? u32([0, 2]) : u32([1]); },
    },
  };

  it("names them in the dialog and in the result, and writes the workspace that still names them", async () => {
    await act(async () => {
      root.render(<GateLabHostProvider host={sceHost}><App /></GateLabHostProvider>);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // A gate on CD3, imported as Gating-ML.
    const input = host.querySelector<HTMLInputElement>('input[accept=".xml,.wsp,.cef"]')!;
    const gatingMl = `<?xml version="1.0" encoding="UTF-8"?>
<gating:Gating-ML xmlns:gating="${G}" xmlns:data-type="${DT}">
  <gating:RectangleGate gating:id="R1" gating:name="R1">
    <gating:dimension gating:min="0" gating:max="12"><data-type:fcs-dimension data-type:name="Nd142Di"/></gating:dimension>
  </gating:RectangleGate>
</gating:Gating-ML>`;
    Object.defineProperty(input, "files", { configurable: true, value: [memoryFile("gates.xml", new TextEncoder().encode(gatingMl))] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    await settle();
    if (button("Import")) await click("Import");

    const trigger = [...host.querySelectorAll<HTMLButtonElement>(".gl-menu-trigger")].find((b) => b.textContent?.includes("Export"))!;
    act(() => trigger.click());
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.trim() === "Export FlowJo workspace…")!.click());
    await settle();
    const modal = host.querySelector<HTMLElement>(".gl-modal")!;
    act(() => [...modal.querySelectorAll<HTMLInputElement>('input[name="flowjo-export-scope"]')][1].click());
    act(() => modal.querySelector<HTMLInputElement>('input[name="flowjo-export-folder"]')!.click());
    await settle();
    const alert = modal.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("GateLab does not hold the bytes of these files");
    expect([...alert.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["D1", "D2"]);
    expect(modal.textContent).toContain("0 FCS files");

    await click("Export", modal);
    for (let i = 0; i < 4; i++) await settle();
    expect(downloads.map((d) => d.name)).toEqual(["D2_and_1_more.zip"]);
    const entries = unzipSync(new Uint8Array(await downloads[0].blob.arrayBuffer()));
    expect(Object.keys(entries)).toEqual(["D2_and_1_more/D2_and_1_more.wsp"]);
    expect(dataSets(new TextDecoder().decode(entries["D2_and_1_more/D2_and_1_more.wsp"]))).toEqual([["file:D1", "D1"], ["file:D2", "D2"]]);
    expect(text()).toContain("not in it, GateLab holding no bytes for them: D1, D2");
  });
});
