// @vitest-environment jsdom
// Samples taken from a multi-data-set FCS file ("plate (data set k of N, well).fcs") through a
// saved workspace: a self-contained bundle, a linked workspace found again through the remembered
// handle of the file they came from and through a chosen folder, and a FlowJo .wsp strategy.
// Synthetic file: wells A01 (2 events) and A02 (3 events) of one plate.

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
// jsdom has no IndexedDB, so the handle memory a linked workspace relies on is kept in a map.
vi.mock("./engine/fsAccess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fsAccess")>();
  return {
    ...actual,
    rememberHandle: vi.fn(async (key: string, handle: FileSystemFileHandle) => { remembered.set(key, handle); }),
    recallHandle: vi.fn(async (key: string) => remembered.get(key) ?? null),
  };
});

import App from "./App";
import { I18nProvider } from "./ui/i18n";
import { extractFcsDataSet, parseFcs } from "./engine/fcs";
import { exportFlowJoWorkspace } from "./engine/flowjoExport";
import { linkChildToParent, newGateRef, newPopulation, newRootPopulation, type Gate, type PopulationMap } from "./engine/models";
import { Sample } from "./engine/sample";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  remembered.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  uuid = 0;
});

/** Two FCS data sets chained by $NEXTDATA: FSC-A 100 and 101 in A01, 200 to 202 in A02, unless
 *  given other events or wells (a null well writes no $WELLID). */
function plateBytes(
  a01: number[][] = [[100, 110], [101, 111]],
  a02: number[][] = [[200, 210], [201, 211], [202, 212]],
  wells: readonly [string | null, string | null] = ["A01", "A02"],
): Uint8Array {
  return chainedDataSets([[a01, wells[0]], [a02, wells[1]]]);
}

/** FCS data sets chained by $NEXTDATA, each with its events and well (null writes no $WELLID),
 *  every one carrying the same $FIL. */
function chainedDataSets(sets: readonly (readonly [number[][], string | null])[], fil = "plate.fcs"): Uint8Array {
  const dataSet = (rows: number[][], well: string | null, next: number): Uint8Array => {
    const data = new Uint8Array(rows.length * 8);
    const dv = new DataView(data.buffer);
    rows.forEach((row, e) => row.forEach((v, c) => dv.setFloat32(e * 8 + c * 4, v, true)));
    const textStart = 64;
    let begin = 0;
    let text = new Uint8Array(0);
    for (let i = 0; i < 4; i++) {
      text = new TextEncoder().encode(
        `/$BYTEORD/1,2,3,4/$DATATYPE/F/$MODE/L/$NEXTDATA/${String(next).padStart(8, "0")}/$PAR/2/$TOT/${rows.length}` +
        `/$P1N/FSC-A/$P1B/32/$P1E/0,0/$P1R/262144/$P2N/SSC-A/$P2B/32/$P2E/0,0/$P2R/262144` +
        `${well === null ? "" : `/$WELLID/${well}`}/$FIL/${fil}` +
        `/$BEGINDATA/${begin}/$ENDDATA/${begin + data.length - 1}/`);
      begin = textStart + text.length;
    }
    const out = new Uint8Array(begin + data.length);
    const head = "FCS3.1    " + [textStart, textStart + text.length - 1, begin, begin + data.length - 1, 0, 0]
      .map((n) => String(n).padStart(8)).join("");
    for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
    out.set(text, textStart);
    out.set(data, begin);
    return out;
  };
  // $NEXTDATA is written at a fixed width, so a data set is as long whatever it points to.
  const parts = sets.map(([rows, well], i) => dataSet(rows, well, i === sets.length - 1 ? 0 : dataSet(rows, well, 0).length));
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function fileOf(name: string, bytes: Uint8Array | string): File {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const file = new File([data as BlobPart], name);
  Object.defineProperty(file, "arrayBuffer", { value: async () => data.slice().buffer });
  Object.defineProperty(file, "text", { value: async () => new TextDecoder().decode(data) });
  Object.defineProperty(file, "stream", {
    value: () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data.slice()); controller.close(); } }),
  });
  return file;
}

/** A file handle for the pickers, readable without asking. */
function fileHandle(name: string, bytes: Uint8Array): FileSystemFileHandle {
  return {
    kind: "file",
    name,
    getFile: vi.fn(async () => fileOf(name, bytes)),
    queryPermission: vi.fn(async () => "granted"),
    requestPermission: vi.fn(async () => "granted"),
  } as unknown as FileSystemFileHandle;
}

/** The save picker: every file saved is kept, by name. */
const saved = new Map<string, Uint8Array>();
function stubPickers(open: () => FileSystemFileHandle[], directory?: () => unknown): void {
  Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn(async () => open()) });
  Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: vi.fn(async () => directory?.()) });
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: vi.fn(async ({ suggestedName }: { suggestedName: string }) => {
      const chunks: Uint8Array[] = [];
      const bytes = () => {
        const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        return out;
      };
      return {
        kind: "file",
        name: suggestedName,
        queryPermission: vi.fn(async () => "granted"),
        requestPermission: vi.fn(async () => "granted"),
        getFile: vi.fn(async () => fileOf(suggestedName, bytes())),
        createWritable: vi.fn(async () => ({
          write: vi.fn(async (data: BlobPart) => {
            if (ArrayBuffer.isView(data)) chunks.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
            else if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") chunks.push(new Uint8Array((data as ArrayBuffer).slice(0)));
            else if (typeof data === "string") chunks.push(new TextEncoder().encode(data));
            else chunks.push(new Uint8Array(await (data as Blob).arrayBuffer()));
          }),
          close: vi.fn(async () => { saved.set(suggestedName, bytes()); }),
        })),
      };
    }),
  });
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
async function click(label: string): Promise<void> {
  const target = button(label);
  if (!target) throw new Error(`No button "${label}"`);
  await act(async () => { target.click(); });
  await settle();
  await settle();
}
const gateRow = () => [...host.querySelectorAll(".pop-row")]
  .map((r) => r.textContent?.replace(/\s+/g, " ").trim()).find((t) => t?.startsWith("R1"));

/** R1's count on each plate sample, viewing each in turn, under the gates that file follows (its
 *  own tailoring where it has one: the population panel shows the file's copy when "only this
 *  file" is the edit target). */
async function countsBySample(names: readonly string[] = PLATE_SAMPLES): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const row = [...host.querySelectorAll<HTMLElement>(".gl-sample-row")].find((r) => r.textContent?.includes(name));
    if (!row) throw new Error(`No sample row for ${name}`);
    await act(async () => { row.click(); });
    await settle();
    const own = host.querySelector<HTMLButtonElement>(".population-tree-edit-file");
    if (own && !own.disabled && own.getAttribute("aria-pressed") !== "true") {
      await act(async () => { own.click(); });
      await settle();
    }
    out[name] = /R1\+(\d+)\(/.exec(gateRow() ?? "")?.[1] ?? "none";
  }
  return out;
}
/** A01's two events lie outside 150-250 and A02's three inside. */
const EXPECTED = { "plate (data set 1 of 2, A01).fcs": "0", "plate (data set 2 of 2, A02).fcs": "3" };

const GATES = `<?xml version="1.0" encoding="UTF-8"?>
<gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
  xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <gating:RectangleGate gating:id="R1" gating:name="R1">
    <gating:dimension gating:min="150" gating:max="250"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
    <gating:dimension gating:min="0" gating:max="1000"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
  </gating:RectangleGate>
</gating:Gating-ML>`;

async function importXml(name: string, text: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[accept=".xml,.wsp,.cef"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [fileOf(name, text)] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  await settle();
  if (button("Import")) await click("Import");
}

/** Open the plate through the file picker (so its handle is remembered) and gate it. */
async function openPlateAndGate(): Promise<void> {
  const plate = fileHandle("plate.fcs", plateBytes());
  stubPickers(() => [plate]);
  act(() => root.render(<App />));
  await click("+ Files…");
  expect(host.textContent).toContain("plate.fcs holds 2 data sets and opened as 2 samples");
  await importXml("gates.xml", GATES);
  expect(await countsBySample()).toEqual(EXPECTED);
}

function rerender(): void {
  act(() => root.unmount());
  root = createRoot(host);
  act(() => root.render(<App />));
}

async function openSaved(name: string, directory?: () => unknown): Promise<void> {
  const bytes = saved.get(name);
  if (!bytes) throw new Error(`Nothing was saved as ${name}: ${[...saved.keys()].join(", ")}`);
  stubPickers(() => [fileHandle(name, bytes)], directory);
  await click("Open Workspace…");
}

const PLATE_SAMPLES = ["plate (data set 1 of 2, A01).fcs", "plate (data set 2 of 2, A02).fcs"];

describe("data-set samples through a saved workspace", () => {
  beforeEach(() => saved.clear());

  it("reopen from a self-contained bundle, gates and all", async () => {
    await openPlateAndGate();
    await click("Save Portable Copy…");
    const bundle = [...saved.keys()].find((k) => k.endsWith("-bundle.gatelab"))!;
    expect(bundle).toBeDefined();

    rerender();
    remembered.clear();
    await openSaved(bundle);
    expect(host.textContent).toContain("2 samples");
    for (const name of PLATE_SAMPLES) expect(host.textContent).toContain(name);
    expect(await countsBySample()).toEqual(EXPECTED);
  });

  it("reopen from a linked workspace through the remembered handle of the plate file", async () => {
    await openPlateAndGate();
    await click("Save As…");
    const linked = [...saved.keys()].find((k) => k.endsWith(".gatelab"))!;
    expect(linked).toBeDefined();
    expect(remembered.has("fcs:plate.fcs")).toBe(true);

    rerender();
    await openSaved(linked);
    expect(host.textContent).not.toContain("Linked FCS files unavailable");
    for (const name of PLATE_SAMPLES) expect(host.textContent).toContain(name);
    expect(await countsBySample()).toEqual(EXPECTED);
  });

  it("reopen from a linked workspace through a chosen folder holding the plate file", async () => {
    await openPlateAndGate();
    await click("Save As…");
    const linked = [...saved.keys()].find((k) => k.endsWith(".gatelab"))!;

    rerender();
    remembered.clear();
    const plate = fileHandle("plate.fcs", plateBytes());
    const folder = {
      kind: "directory",
      name: "run",
      async *values() { yield plate; },
    };
    await openSaved(linked, () => folder);
    expect(host.textContent).toContain("Linked FCS files unavailable");
    await click("Choose FCS folder…");
    for (const name of PLATE_SAMPLES) expect(host.textContent).toContain(name);
    expect(await countsBySample()).toEqual(EXPECTED);
  });
});

// ── A FlowJo .wsp strategy on data-set samples ─────────────────────────────────────

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const rectPop = (min: number, max: number, count: number) => `<Population name="R1" count="${count}"><Gate>
  <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="ID${min}">
    <gating:dimension gating:min="${min}" gating:max="${max}"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
    <gating:dimension gating:min="0" gating:max="1000"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
  </gating:RectangleGate></Gate></Population>`;

/**
 * A workspace FlowJo wrote over the plate: one sample per data set, each recorded under the
 * plate's file name, told apart by the data set's own keywords ($WELLID, $TOT). Each well carries
 * its own R1: 50-150 on A01 (both its events) and 150-250 on A02 (all three).
 */
const FLOWJO_WSP = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0"><SampleList>
  <Sample><DataSet uri="file:/data/run/plate.fcs" sampleID="1"/>
    <Keywords><Keyword name="$FIL" value="plate.fcs"/><Keyword name="$WELLID" value="A01"/><Keyword name="$TOT" value="2"/></Keywords>
    <SampleNode name="plate.fcs" count="2" sampleID="1"><Subpopulations>${rectPop(50, 150, 2)}</Subpopulations></SampleNode>
  </Sample>
  <Sample><DataSet uri="file:/data/run/plate.fcs" sampleID="2"/>
    <Keywords><Keyword name="$FIL" value="plate.fcs"/><Keyword name="$WELLID" value="A02"/><Keyword name="$TOT" value="3"/></Keywords>
    <SampleNode name="plate.fcs" count="3" sampleID="2"><Subpopulations>${rectPop(150, 250, 3)}</Subpopulations></SampleNode>
  </Sample>
</SampleList></Workspace>`;

/** Open the plate through the file picker, ungated. */
async function openPlate(): Promise<void> {
  const plate = fileHandle("plate.fcs", plateBytes());
  stubPickers(() => [plate]);
  act(() => root.render(<App />));
  await click("+ Files…");
  expect(host.textContent).toContain("plate.fcs holds 2 data sets and opened as 2 samples");
}

describe("a FlowJo .wsp strategy on data-set samples", () => {
  it("imports onto the viewed data set the workspace sample of that well, without asking which", async () => {
    await openPlate();
    // Opened last, A02 is the viewed sample.
    await importXml("plate.wsp", FLOWJO_WSP);
    expect(host.textContent).not.toContain("Choose a sample from the workspace");
    // A02's strategy, 150-250, and, since the other loaded data set is the workspace's A01 sample,
    // A01 gets its own sample's tree (fix/multitree-import: every other loaded file that is a gated
    // sample gets its own), 50-150, which holds both its events.
    expect(await countsBySample()).toEqual({ "plate (data set 1 of 2, A01).fcs": "2", "plate (data set 2 of 2, A02).fcs": "3" });
  });

  it("imports GateLab's own .wsp export, which names each data set's sample after it", async () => {
    // The tree R1 150-250, written by exportFlowJoWorkspace for both data-set samples.
    const bytes = plateBytes();
    const gates: Record<string, Gate> = {
      g1: {
        gate_id: "g1", name: "R1", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A",
        vertices: [[150, 0], [250, 0], [250, 1000], [150, 1000]], space: "raw", color: "#000000", label_offset: null,
      },
    };
    const root0 = newRootPopulation();
    let populations: PopulationMap = { [root0.population_id]: root0 };
    const r1 = newPopulation("R1", [newGateRef("g1", true)], root0.population_id, "and");
    populations[r1.population_id] = r1;
    populations = linkChildToParent(populations, r1.population_id, root0.population_id);
    const { xml } = exportFlowJoWorkspace({
      samples: PLATE_SAMPLES.map((fileName, i) => ({
        sample: new Sample(parseFcs(extractFcsDataSet(bytes.buffer as ArrayBuffer, i).buffer as ArrayBuffer)),
        fileName, gates, gate_order: ["g1"], populations, root_population_id: root0.population_id,
      })),
      producer: "GateLab",
    });
    await openPlate();
    await importXml("plate.wsp", xml);
    expect(host.textContent).not.toContain("Choose a sample from the workspace");
    expect(await countsBySample()).toEqual(EXPECTED);
  });

  it("opens the workspace from its file, loading the plate's data sets, each with its own well's gates", async () => {
    const plate = fileHandle("plate.fcs", plateBytes());
    stubPickers(() => [fileHandle("plate.wsp", new TextEncoder().encode(FLOWJO_WSP))]);
    act(() => root.render(<App />));
    await click("Open Workspace…");
    expect(host.textContent).toContain("Open FlowJo workspace");
    stubPickers(() => [plate]);
    await click("Choose FCS files…");
    expect(host.textContent).toMatch(/2\/2\s*found/);
    await click("Import");
    expect(host.textContent).not.toContain("Waiting for the FCS this workspace gates");
    // The import question follows, naming the files of the per-file import (fix/multitree-import);
    // its default takes the workspace as it is.
    expect(host.textContent).toContain("Each of these 2 files gets its own sample's tree");
    await click("Import");
    for (const name of PLATE_SAMPLES) expect(host.textContent).toContain(name);
    expect(await countsBySample()).toEqual({ "plate (data set 1 of 2, A01).fcs": "2", "plate (data set 2 of 2, A02).fcs": "3" });
  });

  // Three events in each data set and no $WELLID or $SMNO. The workspace records both samples
  // under plate.fcs with three events, so nothing says which is which; its first sample's R1
  // (150-250) holds the second data set's events and its second sample's R1 (50-150) the first's.
  const TIED = ["plate (data set 1 of 2).fcs", "plate (data set 2 of 2).fcs"];
  const wspSample = (id: number, count: number, pop: string, fil = "plate.fcs") =>
    `<Sample><DataSet uri="file:/data/run/plate.fcs" sampleID="${id}"/>
    <Keywords><Keyword name="$FIL" value="${fil}"/><Keyword name="$TOT" value="${count}"/></Keywords>
    <SampleNode name="plate.fcs" count="${count}" sampleID="${id}">${pop ? `<Subpopulations>${pop}</Subpopulations>` : ""}</SampleNode>
  </Sample>`;
  const wspOf = (...samples: string[]) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<Workspace version="20.0"><SampleList>${samples.join("")}</SampleList></Workspace>`;
  const tiedWsp = wspOf(wspSample(1, 3, rectPop(150, 250, 3)), wspSample(2, 3, rectPop(50, 150, 3)));
  const tiedPlate = () => fileHandle("plate.fcs", plateBytes([[100, 110], [101, 111], [102, 112]], undefined, [null, null]));
  const pickRow = async (label: string) => {
    const row = [...host.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")].find((b) => b.textContent?.includes(label))!;
    await act(async () => { row.click(); });
    await settle();
  };
  const importWsp = async (wsp: string) => {
    const input = host.querySelector<HTMLInputElement>('input[accept=".xml,.wsp,.cef"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [fileOf("plate.wsp", wsp)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
  };
  const openWspWith = async (wsp: string, plate: FileSystemFileHandle, perFile = true) => {
    stubPickers(() => [fileHandle("plate.wsp", new TextEncoder().encode(wsp))]);
    act(() => root.render(<App />));
    await click("Open Workspace…");
    stubPickers(() => [plate]);
    await click("Choose FCS files…");
    if (!perFile) {
      const box = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
        .find((b) => b.parentElement?.textContent?.includes("One hierarchy per file"))!;
      await act(async () => { box.click(); });
      await settle();
    }
    await click("Import");
  };

  it("asks which sample a data set is when nothing says which data set the strategy's sample was drawn on", async () => {
    await openWspWith(tiedWsp, tiedPlate());
    // Neither data set is taken for the strategy on a guess, and nothing is imported unasked.
    expect(host.textContent).not.toContain("Which files should be gated with it?");
    expect(host.textContent).toContain("Choose a sample from the workspace");
    expect(host.textContent).toContain(
      `Nothing says which data set "plate.fcs", the strategy's sample, was drawn on: it could be ${TIED[0]} or ${TIED[1]}, ` +
      `each holding 3 events`);
    expect(host.textContent).toContain(`Choose which sample ${TIED[0]} is`);
    // The first data set is the second sample's: its gates become the tree.
    await pickRow("position 2");
    expect(host.textContent).toContain("Which files should be gated with it?");
    await click("Import");
    expect(await countsBySample(TIED)).toEqual({ [TIED[0]]: "3", [TIED[1]]: "0" });

    // Importing the workspace onto the other data set asks which of its samples that one is.
    await importWsp(tiedWsp);
    expect(host.textContent).toContain("Choose a sample from the workspace");
    expect(host.textContent).toContain(`2 samples in this workspace could be ${TIED[1]}: recorded under plate.fcs with its 3 events, as ${TIED[0]} has`);
    await pickRow("position 1");
    // As this data set's tailoring of the tree the first import made.
    const viewedOnly = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
      .find((r) => r.parentElement?.textContent?.includes("Only the viewed file"))!;
    await act(async () => { viewedOnly.click(); });
    await click("Import");
    expect(await countsBySample(TIED)).toEqual({ [TIED[0]]: "3", [TIED[1]]: "3" });
  });

  it("asks the same with one shared hierarchy", async () => {
    await openWspWith(tiedWsp, tiedPlate(), false);
    expect(host.textContent).not.toContain("Which files should be gated with it?");
    expect(host.textContent).toContain(`Choose which sample ${TIED[0]} is`);
  });

  it("leads with a sample that is paired, and says the tied data sets get the tree as drawn", async () => {
    // Three data sets: 3, 3 and 2 events. The two samples of 3 cannot be told apart; the sample
    // of 2 is the third data set's, and its R1 (250-350) holds that data set's two events.
    const three = ["plate (data set 1 of 3).fcs", "plate (data set 2 of 3).fcs", "plate (data set 3 of 3).fcs"];
    const plate = fileHandle("plate.fcs", chainedDataSets([
      [[[100, 110], [101, 111], [102, 112]], null],
      [[[200, 210], [201, 211], [202, 212]], null],
      [[[300, 310], [301, 311]], null],
    ]));
    // The strategy is left on the first sample, which is one of the tied two.
    await openWspWith(wspOf(
      wspSample(1, 3, rectPop(150, 250, 3)), wspSample(2, 3, rectPop(50, 150, 3)), wspSample(3, 2, rectPop(250, 350, 2)),
    ), plate);
    expect(host.textContent).not.toContain("Choose a sample from the workspace");
    expect(host.textContent).toContain(
      `${three[0]} and ${three[1]} were not paired with a workspace sample: each holds 3 events, a count another data set ` +
      "or workspace sample shares or may share, and no $WELLID or $SMNO says which sample each is. They get the imported tree as drawn, " +
      "without their samples' own coordinates");
    expect(host.textContent).toContain("Which files should be gated with it?");
    await click("Import");
    // The third sample's tree, as drawn, for every file: no sample's gates on a data set they may not be.
    expect(await countsBySample(three)).toEqual({ [three[0]]: "0", [three[1]]: "0", [three[2]]: "2" });
  });

  it("does not pair a data set on a count a sample without gates shares", async () => {
    // One data set of 3 events and one of 2. The workspace holds a gated sample of each count and
    // a sample of 3 with no gates, such as a control: the data set of 3 could be either sample.
    const plate = fileHandle("plate.fcs", plateBytes([[100, 110], [101, 111], [102, 112]], [[300, 310], [301, 311]], [null, null]));
    await openWspWith(wspOf(
      wspSample(1, 2, rectPop(250, 350, 2)), wspSample(2, 3, rectPop(50, 150, 3)), wspSample(3, 3, ""),
    ), plate);
    expect(host.textContent).toContain(`${TIED[0]} was not paired with a workspace sample: it holds 3 events`);
  });

  it("asks rather than taking the one sample of a count on a $FIL every data set carries", async () => {
    // $FIL names the acquisition, not the file on disk, and both data sets of 3 events carry it.
    const plate = fileHandle("plate.fcs", chainedDataSets([
      [[[100, 110], [101, 111], [102, 112]], null],
      [[[200, 210], [201, 211], [202, 212]], null],
    ], "acq_run1.fcs"));
    stubPickers(() => [plate]);
    act(() => root.render(<App />));
    await click("+ Files…");
    await importWsp(wspOf(wspSample(1, 3, rectPop(50, 150, 3), "acq_run1.fcs")));
    expect(host.textContent).toContain("Choose a sample from the workspace");
    expect(host.textContent).toMatch(/1 sample in this workspace could be plate \(data set \d of 2\)\.fcs: recorded under plate\.fcs with its 3 events, as plate \(data set \d of 2\)\.fcs has/);
  });

  // Cancelling the question an open raises cancels the open, as cancelling its strategy question does.
  for (const [how, cancel] of [
    ["Cancel", async () => click("Cancel")],
    ["a click outside it", async () => {
      const backdrop = host.querySelector<HTMLElement>(".gl-wsp-picker")!.parentElement!;
      await act(async () => { backdrop.click(); });
      await settle();
    }],
  ] as const) {
    it(`unloads the data sets the open loaded when its sample picker is cancelled with ${how}`, async () => {
      await openWspWith(tiedWsp, tiedPlate());
      expect(host.textContent).toContain("Choose a sample from the workspace");
      for (const name of TIED) expect(host.textContent).toContain(name);
      await cancel();
      expect(host.textContent).not.toContain("Choose a sample from the workspace");
      expect(host.textContent).toContain(
        "Workspace open cancelled; the 2 files it loaded were removed again and the current strategy was not changed.");
      for (const name of TIED) expect(host.textContent).not.toContain(name);
      expect(host.querySelectorAll(".gl-sample-row")).toHaveLength(0);
    });
  }

  // $SMNO or $WELLID can name the tube, the same on every data set of a plate: "tube1" says
  // nothing about which data set a sample is, and each data set's count does.
  const TUBE = ["plate (data set 1 of 2, tube1).fcs", "plate (data set 2 of 2, tube1).fcs"];
  const tubeSample = (id: number, count: number, pop: string) =>
    `<Sample><DataSet uri="file:/data/run/plate.fcs" sampleID="${id}"/>
    <Keywords><Keyword name="$FIL" value="plate.fcs"/><Keyword name="$WELLID" value="tube1"/><Keyword name="$TOT" value="${count}"/></Keywords>
    <SampleNode name="plate.fcs" count="${count}" sampleID="${id}"><Subpopulations>${pop}</Subpopulations></SampleNode>
  </Sample>`;
  // Listed with the second data set's sample first: its R1 (150-250) holds that data set's three
  // events, and the other sample's R1 (50-150) the first data set's two.
  const tubeWsp = wspOf(tubeSample(1, 3, rectPop(150, 250, 3)), tubeSample(2, 2, rectPop(50, 150, 2)));
  const tubePlate = () => fileHandle("plate.fcs", plateBytes(undefined, undefined, ["tube1", "tube1"]));

  it("pairs data sets that share a well label by their counts, not in list order", async () => {
    await openWspWith(tubeWsp, tubePlate());
    expect(host.textContent).not.toContain("Choose a sample from the workspace");
    expect(host.textContent).not.toContain("were not paired with a workspace sample");
    await click("Import");
    expect(await countsBySample(TUBE)).toEqual({ [TUBE[0]]: "2", [TUBE[1]]: "3" });
  });

  it("imports onto a data set the sample of its count, where every data set carries its well label", async () => {
    stubPickers(() => [tubePlate()]);
    act(() => root.render(<App />));
    await click("+ Files…");
    // Opened last, the second data set is viewed; the sample of its three events is its own.
    await importWsp(tubeWsp);
    expect(host.textContent).not.toContain("Choose a sample from the workspace");
    await click("Import");
    // The first data set is the other sample's, and gets that sample's own tree, 50-150, holding
    // both its events (fix/multitree-import: every other loaded file that is a gated sample gets its
    // own tree).
    expect(await countsBySample(TUBE)).toEqual({ [TUBE[0]]: "2", [TUBE[1]]: "3" });
  });

  it("asks rather than taking the one sample of a count a data set that is not open could hold", async () => {
    // Three data sets of 3, 4 and 3 events; the workspace gates the third, whose R1 (250-350)
    // holds its own events and none of the first's.
    const three = ["plate (data set 1 of 3).fcs", "plate (data set 2 of 3).fcs", "plate (data set 3 of 3).fcs"];
    stubPickers(() => [fileHandle("plate.fcs", chainedDataSets([
      [[[100, 110], [101, 111], [102, 112]], null],
      [[[200, 210], [201, 211], [202, 212], [203, 213]], null],
      [[[300, 310], [301, 311], [302, 312]], null],
    ]))]);
    act(() => root.render(<App />));
    await click("+ Files…");
    // The third data set is removed; the first, with its count, is viewed.
    await click("Manage…");
    await act(async () => { host.querySelector<HTMLInputElement>(`input[aria-label="Select ${three[2]} for management"]`)!.click(); });
    await click("Remove selected…");
    await click("Remove");
    expect(host.querySelectorAll(".gl-sample-row")).toHaveLength(2);
    await countsBySample([three[0]]);
    await importWsp(wspOf(wspSample(1, 3, rectPop(250, 350, 3))));
    expect(host.textContent).toContain("Choose a sample from the workspace");
    expect(host.textContent).toContain(
      `1 sample in this workspace could be ${three[0]}: recorded under plate.fcs with its 3 events; another data set of ` +
      "plate.fcs, not open, could be it too, and no $WELLID or $SMNO says which. Choose which one to import.");
  });

  it("says so in the open dialog when those data sets are already open, in the viewer's language", async () => {
    const plate = tiedPlate();
    stubPickers(() => [plate]);
    act(() => root.render(<I18nProvider><App /></I18nProvider>));
    await click("+ Files…");
    stubPickers(() => [fileHandle("plate.wsp", new TextEncoder().encode(tiedWsp))]);
    await click("Open Workspace…");
    expect(host.textContent).toContain("Open FlowJo workspace");
    expect(host.textContent).toMatch(/0\/2\s*found/);
    expect(host.textContent).toContain(`${TIED[0]} and ${TIED[1]} were not paired with a workspace sample`);
    expect(host.textContent).toContain(`could be: ${TIED[0]} / ${TIED[1]}`);
    // The strategy's sample could be either, so Import is offered: it asks which after.
    expect(button("Import")?.disabled).toBe(false);

    const language = host.querySelector<HTMLSelectElement>("select.gl-header-language, .gl-header-language select")!;
    await act(async () => {
      language.value = "ja";
      language.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain(`${TIED[0]}、${TIED[1]} はワークスペースのどのサンプルとも対応付けられていません`);
    expect(host.textContent).toContain(`候補: ${TIED[0]} / ${TIED[1]}`);
  });
});
