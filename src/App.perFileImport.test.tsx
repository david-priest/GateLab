// @vitest-environment jsdom
//
// Every loaded FCS file gets the tree of the workspace sample that IS that file, in every importer,
// and a file with no tree of its own is named and follows the tree. These are the App paths the
// third verification round (2026-09-25) found giving a file another sample's tree, or none, or
// saying nothing: a file whose $PnS labels a detector differently from the tree's file losing its
// own gates, a same-named sample that records nothing taking the file from the sample its $FIL and
// keywords confirm, an unrelated loaded file following the tree unnamed, the tree choice of a
// multi-tree sample lost when other files are samples too, an unreadable primary stopping the
// whole import, a merge dropping per-file tailoring, and the FACSDiva, FACSChorus and Cytobank
// imports applying one tree to every loaded file. Synthetic names, identities and gates only.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { FcsFile } from "./engine/fcs";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));
// A FACSChorus polygon gate as a .cef and an S8 recording write it; `right` moves one edge.
function chorusGate(right: number) {
  const parameter = (name: string) => ({ measurementId: name, fluorochrome: name, measurement: "A", scatter: name, scale: "Linear", numerator: null, denominator: null, parameterKind: "Scatter" });
  return {
    gateId: "gate-1", gateKind: "Polygon", name: "CD4_positive", parentPopulationId: "0-1",
    parameters: [parameter("FSC"), parameter("SSC")], vertices: [{ x: 5, y: 50 }, { x: right, y: 50 }, { x: right, y: 400 }],
    children: [{ name: "CD4_positive", color: "0,0,255", populationId: "gate-1-1" }],
  };
}
const recording = (name: string, start: string, stop: string, right: number) => ({
  BDCHORUSDATARECORD: JSON.stringify({
    RecordingInfo: { Name: name, AssociationId: "E1" },
    RecordingConfiguration: { StartRecordingTime: start, StopRecordingTime: stop, AnalysisModel: { Gates: [chorusGate(right)] } },
  }),
});
// The first byte of a file picks the acquisition it is.
const IDENTITY: Record<number, Record<string, string>> = {
  1: { $TOT: "3", $BTIM: "10:00:00", $ETIM: "10:01:00", $DATE: "01-JAN-2024", GUID: "aaaaaaaa-0000-0000-0000-000000000001", $FIL: "18445.fcs" },
  2: { $TOT: "3", $BTIM: "15:30:00", $ETIM: "15:31:00", $DATE: "02-FEB-2024", GUID: "bbbbbbbb-0000-0000-0000-000000000002", $FIL: "18447.fcs" },
  // Tube_002's acquisition times in the FACSDiva experiment below, and no $FIL.
  3: { $TOT: "3", $BTIM: "08:00:00", $ETIM: "08:01:00", $DATE: "03-MAR-2024" },
  // An acquisition no workspace below records.
  4: { $TOT: "3", $BTIM: "12:00:00", $ETIM: "12:01:00", $DATE: "04-APR-2024", GUID: "dddddddd-0000-0000-0000-000000000004" },
  // Seed 2's acquisition saved as renamed.fcs: its $FIL is the name it was recorded as.
  5: { $TOT: "3", $BTIM: "15:30:00", $ETIM: "15:31:00", $DATE: "02-FEB-2024", GUID: "bbbbbbbb-0000-0000-0000-000000000002", $FIL: "18447.fcs" },
  // An acquisition saved under another name, whose $FIL is D1.fcs; it is not seed 4's acquisition.
  6: { $TOT: "3", $BTIM: "13:00:00", $ETIM: "13:01:00", $DATE: "05-MAY-2024", $FIL: "D1.fcs" },
  // FACSChorus recordings of experiment E1, made during Sort 1 and Sort 2 under each sort's gates.
  7: recording("rec1", "2024-01-01T09:10:00", "2024-01-01T09:12:00", 350),
  8: recording("rec2", "2024-01-01T10:10:00", "2024-01-01T10:12:00", 300),
  // Seed 1's acquisition, whose strategy in the workspace below cannot be read.
  9: { $TOT: "3", $BTIM: "10:00:00", $ETIM: "10:01:00", $DATE: "01-JAN-2024", GUID: "aaaaaaaa-0000-0000-0000-000000000001" },
  // Seed 6's acquisition under the name it was recorded as, carrying no $FIL: seed 6 is a copy of it.
  10: { $TOT: "3", $BTIM: "13:00:00", $ETIM: "13:01:00", $DATE: "05-MAY-2024" },
  // Seed 2's acquisition, carrying a spillover matrix of its own (SPILLOVER below).
  13: { $TOT: "3", $BTIM: "15:30:00", $ETIM: "15:31:00", $DATE: "02-FEB-2024", GUID: "bbbbbbbb-0000-0000-0000-000000000002", $FIL: "18447.fcs" },
};
// A file's own matrix: V450 into V525 at 0.30.
const SPILLOVER: Record<number, { channels: string[]; matrix: number[][] }> = {
  13: { channels: ["V525-A", "V450-A"], matrix: [[1, 0.3], [0.05, 1]] },
};
// The live/dead detector, labelled "aqua" in seed 1's $PnS and "Aqua" in seed 2's.
const MARKER: Record<number, string> = { 1: "aqua", 2: "Aqua" };
function syntheticFcs(seed: number): FcsFile {
  return {
    version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: { ...(IDENTITY[seed] ?? {}) },
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      { index: 2, name: "V525-A", marker: MARKER[seed] ?? "aqua", bits: 32, range: 262144 },
      ...(SPILLOVER[seed] ? [{ index: 3, name: "V450-A", marker: "CD4", bits: 32, range: 262144 }] : []),
    ],
    columns: [Float32Array.from([10, 20, 30]), Float32Array.from([100, 200, 300]), Float32Array.from([10, 20, 30]),
      ...(SPILLOVER[seed] ? [Float32Array.from([1, 2, 3])] : [])],
    spillover: SPILLOVER[seed] ?? null,
  };
}
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return {
    ...actual,
    parseFcs: (buffer: ArrayBuffer) => syntheticFcs(new Uint8Array(buffer)[0]),
    readFcsFileKeywords: async (file: File) => syntheticFcs(new Uint8Array(await file.arrayBuffer())[0]).keywords,
  };
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

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const rectOn = (id: string, x: string, xMax: number) => `<gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="${id}">
  <gating:dimension gating:min="0" gating:max="${xMax}"><data-type:fcs-dimension data-type:name="${x}"/></gating:dimension>
  <gating:dimension gating:min="0" gating:max="1000"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
</gating:RectangleGate>`;
const pop = (name: string, id: string, max: number, x = "FSC-A") =>
  `<Population name="${name}" count="2"><Gate>${rectOn(id, x, max)}</Gate></Population>`;
const keywords = (k: Record<string, string>) =>
  `<Keywords>${Object.entries(k).map(([n, v]) => `<Keyword name="${n}" value="${v}"/>`).join("")}</Keywords>`;
const sample = (uri: string, name: string, kw: Record<string, string>, trees: string, group = "") =>
  `<Sample><DataSet uri="file:${uri}"/>${keywords(kw)}<SampleNode name="${name}" count="3" owningGroup="${group}"><Subpopulations>${trees}</Subpopulations></SampleNode></Sample>`;
const wsp = (...samples: string[]) => `<?xml version="1.0"?><Workspace><SampleList>${samples.join("")}</SampleList></Workspace>`;

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
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
});

function fileOf(name: string, content: string | Uint8Array<ArrayBuffer>): File {
  const bytes: Uint8Array<ArrayBuffer> = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const file = new File([bytes], name);
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.slice().buffer });
  if (typeof content === "string") Object.defineProperty(file, "text", { value: async () => content });
  return file;
}
const fcs = (name: string, seed: number) => fileOf(name, Uint8Array.from([seed]));
async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
async function feed(selector: string, files: File[]): Promise<void> {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  for (let i = 0; i < 4; i++) await settle();
}
const hint = () => [...host.querySelectorAll(".gl-hint")].map((el) => el.textContent).join(" | ");
const errorText = () => host.querySelector(".gl-error")?.textContent ?? "";
const page = () => host.textContent ?? "";
const modals = () => [...host.querySelectorAll(".gl-modal")].map((m) => m.textContent ?? "").join(" | ");
async function confirmImport(): Promise<void> {
  const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
  if (confirm) { await act(async () => { confirm.click(); }); for (let i = 0; i < 4; i++) await settle(); }
}
/** Load FCS files, view one of them, and import a workspace or gating file onto it. */
async function loadAndImport(files: File[], viewed: string, strategy: File): Promise<void> {
  act(() => root.render(<App />));
  await feed('input[type=file][accept=".fcs"][multiple]', files);
  const row = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find((r) => r.textContent?.includes(viewed))!;
  await act(async () => { row.click(); });
  await settle();
  await feed('input[accept=".xml,.wsp,.cef"]', [strategy]);
}
/**
 * A loaded file's populations and their counts, as its own tree shows them: viewed, with the edit
 * target on the file, or on the tree (`target`), where a tailored file shows its own counts too.
 */
async function countsOf(name: string, target: "file" | "tree" = "file"): Promise<Record<string, number>> {
  const row = [...host.querySelectorAll<HTMLElement>(".gl-sample-row")].find((r) => r.textContent?.includes(name))!;
  await act(async () => { row.click(); });
  for (let i = 0; i < 3; i++) await settle();
  const targetButton = host.querySelector<HTMLButtonElement>(target === "file" ? ".population-tree-edit-file" : ".population-tree-edit-tree");
  if (targetButton && targetButton.getAttribute("aria-pressed") !== "true" && !targetButton.disabled) {
    await act(async () => { targetButton.click(); });
    for (let i = 0; i < 3; i++) await settle();
  }
  const out: Record<string, number> = {};
  for (const r of host.querySelectorAll(".pop-row")) {
    const m = /^(.*?)\1\+([\d,]+)\(/.exec((r.textContent ?? "").replace(/\s+/g, " ").trim());
    if (m) out[m[1]] = Number(m[2].replace(/,/g, ""));
  }
  return out;
}

describe("a per-file import where two files label a detector differently", () => {
  // D1.fcs labels the live/dead detector "aqua" and names its population "live cells"; D2.fcs's
  // sample labels it "Aqua" and names it "Live cells". D2 lost its own gate on that detector,
  // followed the tree's -- on a channel D2 does not have -- and counted no event.
  it("gives the second file its own gate on its own channel, and says the tree's edits do not reach it", async () => {
    await loadAndImport([fcs("D1.fcs", 1), fcs("D2.fcs", 2)], "D1.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("live cells", "a1", 25, "V525-A")),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("Live cells", "b1", 15, "V525-A")),
    )));
    await confirmImport();
    expect(hint()).not.toContain("carried a different tree");
    expect(hint()).toContain("D2.fcs labels a detector differently from D1.fcs, or draws a gate as another kind, and keeps its own there; edits to the tree do not reach that file.");
    expect((await countsOf("D2.fcs"))["live cells"]).toBe(1);
    expect((await countsOf("D1.fcs"))["live cells"]).toBe(2);
  });

  // Viewed with "the tree · all files", D2 was shown under the tree's gate, which is on a channel
  // D2 labels differently, and counted no event; it is shown under its own gate, as its own copy
  // and the FCS export count it. D1 follows the tree and is unchanged.
  it("shows the second file under its own gate when edits go to the tree", async () => {
    await loadAndImport([fcs("D1.fcs", 1), fcs("D2.fcs", 2)], "D1.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("live cells", "a1", 25, "V525-A")),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("Live cells", "b1", 15, "V525-A")),
    )));
    await confirmImport();
    expect((await countsOf("D2.fcs", "tree"))["live cells"]).toBe(1);
    expect(host.querySelector(".population-tree-edit-tree")!.getAttribute("aria-pressed")).toBe("true");
    expect((await countsOf("D1.fcs", "tree"))["live cells"]).toBe(2);
    // And the same after the file's own tree is live and the tree is chosen again.
    expect((await countsOf("D2.fcs", "file"))["live cells"]).toBe(1);
    expect((await countsOf("D2.fcs", "tree"))["live cells"]).toBe(1);
  });

  // "Revert D2.fcs to the tree" put D2 on the tree, whose gate names D1's channel for the detector:
  // D2 does not have it, and the gate held no event. D2 keeps its copy, which takes the tree's
  // coordinates (25 on the detector, so 2 events) on its own channel.
  it("reverts the second file to the tree's coordinates on its own channel", async () => {
    await loadAndImport([fcs("D1.fcs", 1), fcs("D2.fcs", 2)], "D1.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("live cells", "a1", 25, "V525-A")),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("Live cells", "b1", 15, "V525-A")),
    )));
    await confirmImport();
    expect((await countsOf("D2.fcs"))["live cells"]).toBe(1);
    await act(async () => { host.querySelector<HTMLButtonElement>(".population-tree-revert-group")!.click(); });
    for (let i = 0; i < 3; i++) await settle();
    const said = page();
    expect((await countsOf("D2.fcs"))["live cells"]).toBe(2);
    expect((await countsOf("D2.fcs", "tree"))["live cells"]).toBe(2);
    expect((await countsOf("D1.fcs", "tree"))["live cells"]).toBe(2);
    expect(said).toContain("D2.fcs takes the tree's gate coordinates again. D2.fcs labels a detector differently from the tree's file, so it keeps a copy of its own, with the tree's coordinates on its own channels; edits to the tree do not reach that file. Undo is available.");
  });

  // "Revert all files…" pointed every tailored file at the tree the same way.
  it("reverts every file, the second on its own channel", async () => {
    await loadAndImport([fcs("D1.fcs", 1), fcs("D2.fcs", 2)], "D1.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("live cells", "a1", 25, "V525-A")),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("Live cells", "b1", 15, "V525-A")),
    )));
    await confirmImport();
    expect((await countsOf("D2.fcs"))["live cells"]).toBe(1);
    await act(async () => { host.querySelector<HTMLButtonElement>(".population-tree-revert-all")!.click(); });
    await settle();
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => b.textContent === "Revert listed files")!.click(); });
    for (let i = 0; i < 3; i++) await settle();
    const said = page();
    expect((await countsOf("D2.fcs"))["live cells"]).toBe(2);
    expect((await countsOf("D1.fcs", "tree"))["live cells"]).toBe(2);
    expect(said).toContain("1 file follows the tree again; its tailoring is dropped. D2.fcs labels a detector differently from the tree's file, so it keeps a copy of its own, with the tree's coordinates on its own channels; edits to the tree do not reach that file. Undo is available.");
  });

  // "Use for the tree…" on D2 changed nothing -- D2's copy names its own channel, so it was never
  // in step with the tree -- and said the tree had D2's coordinates. The tree takes them (15 on
  // the detector), on its own channel, so D1 holds 1 event; D2 keeps its copy.
  it("gives the tree the second file's coordinates with Use for the tree", async () => {
    await loadAndImport([fcs("D1.fcs", 1), fcs("D2.fcs", 2)], "D1.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("live cells", "a1", 25, "V525-A")),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("Live cells", "b1", 15, "V525-A")),
    )));
    await confirmImport();
    expect((await countsOf("D2.fcs"))["live cells"]).toBe(1);
    await act(async () => { host.querySelector<HTMLButtonElement>(".population-tree-promote")!.click(); });
    await settle();
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => b.textContent === "Use for the tree")!.click(); });
    for (let i = 0; i < 3; i++) await settle();
    const said = page();
    expect((await countsOf("D1.fcs", "tree"))["live cells"]).toBe(1);
    expect((await countsOf("D2.fcs"))["live cells"]).toBe(1);
    expect(said).toContain(`now has D2.fcs's gate coordinates, and every file following it follows again. D2.fcs labels a detector differently from the tree's file, so it keeps a copy of its own, with the tree's coordinates on its own channels; edits to the tree do not reach that file. Undo is available.`);
  });

  // A copy whose gate is drawn as another kind is not the tree's structure, and its coordinates
  // cannot become the tree's whole; the success line was shown all the same.
  it("says Use for the tree left the tree as it is when the file draws a gate as another kind", async () => {
    const polygon = `<Population name="Live cells" count="1"><Gate><gating:PolygonGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="b1">
  <gating:dimension><data-type:fcs-dimension data-type:name="V525-A"/></gating:dimension>
  <gating:dimension><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
  <gating:vertex><gating:coordinate data-type:value="0"/><gating:coordinate data-type:value="0"/></gating:vertex>
  <gating:vertex><gating:coordinate data-type:value="15"/><gating:coordinate data-type:value="0"/></gating:vertex>
  <gating:vertex><gating:coordinate data-type:value="15"/><gating:coordinate data-type:value="1000"/></gating:vertex>
  <gating:vertex><gating:coordinate data-type:value="0"/><gating:coordinate data-type:value="1000"/></gating:vertex>
</gating:PolygonGate></Gate></Population>`;
    await loadAndImport([fcs("D1.fcs", 1), fcs("D2.fcs", 2)], "D1.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("live cells", "a1", 25, "V525-A")),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], polygon),
    )));
    await confirmImport();
    expect((await countsOf("D2.fcs"))["live cells"]).toBe(1);
    await act(async () => { host.querySelector<HTMLButtonElement>(".population-tree-promote")!.click(); });
    await settle();
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => b.textContent === "Use for the tree")!.click(); });
    for (let i = 0; i < 3; i++) await settle();
    expect(page()).not.toContain("now has D2.fcs's gate coordinates");
    expect(page()).toContain(`was left as it is: D2.fcs draws a gate as another kind or holds other populations, so its tree is not the same tree. Apply to the tree takes its gates one at a time.`);
    expect((await countsOf("D1.fcs", "tree"))["live cells"]).toBe(2);
  });
});

describe("a renamed file whose same-named sample records nothing", () => {
  // renamed.fcs is D2's acquisition: its $FIL and every keyword are sample 1's. Sample 2 is named
  // renamed.fcs and records nothing, and its tree was imported without a word.
  it("gets the tree of the sample its $FIL names and its keywords confirm, and the result says why", async () => {
    await loadAndImport([fcs("renamed.fcs", 5)], "renamed.fcs", fileOf("experiment.wsp", wsp(
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("D2_lymphocytes", "b1", 12)),
      sample("renamed.fcs", "renamed.fcs", {}, pop("Renamed_lymphocytes", "r1", 25)),
    )));
    await confirmImport();
    expect(page()).toContain("D2_lymphocytes");
    expect(page()).not.toContain("Renamed_lymphocytes");
    expect(hint()).toContain('(matched on $FIL) · sample 2 "renamed.fcs", named like the file, records nothing that confirms it is the file; the file\'s $FIL and keywords are sample 1 "D2.fcs"\'s');
  });
});

describe("a .wsp imported onto the viewed file, with a loaded file no sample is", () => {
  // X.fcs is loaded beside the workspace's two files, and no sample is named like it. It followed
  // the imported tree -- another sample's geometry -- unnamed, and the result counted 2 files.
  it("names the file, counts it with the files that follow the tree, and the dialog says so", async () => {
    act(() => root.render(<App />));
    await feed('input[type=file][accept=".fcs"][multiple]', [fcs("D1.fcs", 1), fcs("D2.fcs", 2), fcs("X.fcs", 4)]);
    const row = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find((r) => r.textContent?.includes("D1.fcs"))!;
    await act(async () => { row.click(); });
    await settle();
    await feed('input[accept=".xml,.wsp,.cef"]', [fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
    ))]);
    expect(modals()).toContain("These follow the tree without a tree of their own: X.fcs.");
    await confirmImport();
    expect(hint()).toMatch(/Imported one tree, "[^"]*", from D1\.fcs for 3 files: 2 follow it, 1 tailored/);
    // Named once, with why: it was also named in the result with another reason.
    expect(hint()).toContain("following the tree without a tree of their own: X.fcs (no sample is named like it)");
    expect(hint().match(/X\.fcs/g)).toHaveLength(1);
  });
});

describe("a .wsp whose viewed file's sample holds several trees, with other files of the workspace loaded", () => {
  const W = wsp(
    sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("D1_lymphocytes", "a1", 25) + pop("D1_beads", "a2", 15)),
    sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("D2_lymphocytes", "b1", 12)),
  );
  const picker = () => host.querySelector<HTMLElement>('[aria-label="Choose a gating tree"]');
  const rowsOf = () => [...picker()!.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")];

  // Every tree of every paired file was merged, with no way to choose one tree here.
  it("asks which tree, and imports one tree alone for every file to follow by that choice", async () => {
    await loadAndImport([fcs("D1.fcs", 1), fcs("D2.fcs", 2)], "D1.fcs", fileOf("experiment.wsp", W));
    expect(picker()).not.toBeNull();
    expect(rowsOf().map((r) => r.querySelector(".gl-wsp-name")?.textContent)).toEqual(["Every tree, each file its own sample's", "D1_lymphocytes", "D1_beads"]);
    await act(async () => { rowsOf()[2].click(); });
    for (let i = 0; i < 6; i++) await settle();
    // One tree, so the files are asked about again.
    expect(modals()).toContain("Which files should be gated with it?");
    await confirmImport();
    const populations = [...host.querySelectorAll(".pop-row")].map((r) => r.textContent ?? "");
    expect(populations.some((p0) => p0.includes("D1_beads"))).toBe(true);
    expect(populations.some((p0) => p0.includes("D1_lymphocytes") || p0.includes("D2_lymphocytes"))).toBe(false);
    expect(hint()).toContain('following this tree by choice, though each is its own sample: D2.fcs (sample 2 "D2.fcs")');
  });

  it("or every tree, each file getting its own sample's", async () => {
    await loadAndImport([fcs("D1.fcs", 1), fcs("D2.fcs", 2)], "D1.fcs", fileOf("experiment.wsp", W));
    await act(async () => { rowsOf()[0].click(); });
    for (let i = 0; i < 6; i++) await settle();
    await confirmImport();
    expect(hint()).toMatch(/Imported one tree, "[^"]*", from D1\.fcs for 2 files/);
    expect(errorText()).toContain("To import one of them alone, import the workspace onto the viewed file again and choose that tree.");
  });
});

describe("a per-file import whose primary file's strategy cannot be read", () => {
  // D1's only tree is on a channel D1 does not have, so it cannot be read. The whole import
  // stopped with an error, and D2 got nothing although its own tree reads.
  it("takes the next file's tree as the tree, and names the file that follows it without tailoring", async () => {
    await loadAndImport([fcs("D1.fcs", 1), fcs("D2.fcs", 2)], "D1.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("D1_elsewhere", "z1", 25, "Z-A")),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("D2_lymphocytes", "b1", 12)),
    )));
    for (let i = 0; i < 6; i++) await settle();
    await confirmImport();
    expect(page()).toContain("D2_lymphocytes");
    expect(hint()).toMatch(/Imported one tree, "[^"]*", from D2\.fcs for 2 files/);
    // D1's tree was read; it is D1's channels it cannot be applied to.
    expect(hint()).toContain("D1.fcs follows it without tailoring: its tree could not be applied to it.");
    expect(errorText()).toContain("D1.fcs: its tree could not be applied to it, so it follows the imported tree without tailoring.");
  });
});

describe("a merge after a per-file import", () => {
  // D2 had its own sample's geometry from the first import; the merge (then the recommended
  // answer) moved it back onto the tree, and it took D1's.
  it("keeps the tailoring each file already has", async () => {
    await loadAndImport([fcs("D1.fcs", 1), fcs("D2.fcs", 2)], "D1.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
    )));
    await confirmImport();
    expect(host.querySelector(".population-tree-hierarchy-count")?.textContent).toBe("2 files · 1 tailored");
    // A further tree, merged.
    const more = `<?xml version="1.0"?><gating:Gating-ML xmlns:gating="${G}" xmlns:data-type="${D}">
      <gating:RectangleGate gating:id="s1" gating:name="Singlets">
        <gating:dimension gating:min="0" gating:max="100000"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
        <gating:dimension gating:min="0" gating:max="100000"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
      </gating:RectangleGate></gating:Gating-ML>`;
    await feed('input[accept=".xml,.wsp,.cef"]', [fileOf("more.xml", more)]);
    // Its structure differs from the tree's, so Replace is the default (2026-09-29); merge, chosen.
    const merge = host.querySelector<HTMLInputElement>('input[name="gatingml-import-mode"][value="merge"]')!;
    expect(merge.checked).toBe(false);
    act(() => merge.click());
    expect(modals()).toContain("the one with tailored gates of its own keeps them");
    await confirmImport();
    expect(hint()).toContain("merged into the tree all 2 files follow; the file tailored to it keeps its tailoring");
    expect(host.querySelector(".population-tree-hierarchy-count")?.textContent).toBe("2 files · 1 tailored");
    expect((await countsOf("D2.fcs")).lymphocytes).toBe(1);
  });
});

describe("a FACSDiva experiment imported with several files loaded", () => {
  const gate = (name: string, right: number) => `<gate fullname="All Events\\${name}" type="Region_Classifier">
    <name>${name}</name><parent>All Events</parent><num_events>2</num_events>
    <is_x_parameter_log>false</is_x_parameter_log><is_y_parameter_log>false</is_y_parameter_log>
    <is_x_parameter_scaled>false</is_x_parameter_scaled><is_y_parameter_scaled>false</is_y_parameter_scaled>
    <x_parameter_scale_value>0</x_parameter_scale_value><y_parameter_scale_value>0</y_parameter_scale_value>
    <region name="r" xparm="FSC-A" yparm="SSC-A" type="POLYGON_REGION"><points>
      <point x="5" y="50" /><point x="${right}" y="50" /><point x="${right}" y="400" /><point x="5" y="400" /></points></region></gate>`;
  const all = `<gate fullname="All Events" type="EventSource_Classifier"><name>All Events</name><num_events>3</num_events></gate>`;
  const tube = (name: string, file: string, begin: string, end: string, gates: string) =>
    `<tube name="${name}"><data_filename>${file}</data_filename><data_begin_date>${begin}</data_begin_date>` +
    `<data_end_date>${end}</data_end_date><gates>${all}${gates}</gates></tube>`;
  const XML = `<bdfacs version="Version 9.1.2"><experiment name="Experiment 1"><specimen name="Specimen_001">
    ${tube("Tube_001", "Specimen_001_Tube_001.fcs", "2024-01-01T10:00:00", "2024-01-01T10:01:00", gate("lymphocytes", 350))}
    ${tube("Tube_002", "Specimen_001_Tube_002.fcs", "2024-03-03T08:00:00", "2024-03-03T08:01:00", gate("lymphocytes", 15))}
  </specimen></experiment></bdfacs>`;

  // D1.fcs is Tube_002 by its acquisition times. It followed Tube_001's tree under "applied to
  // all 2 files", unnamed; X.fcs is no tube of the experiment.
  it("gives every loaded file its own tube's tree, and names a file that is no tube", async () => {
    await loadAndImport([fcs("Specimen_001_Tube_001.fcs", 1), fcs("D1.fcs", 3), fcs("X.fcs", 4)], "Specimen_001_Tube_001.fcs",
      fileOf("experiment.xml", XML));
    await confirmImport();
    expect(hint()).toContain("one tree per file, each its own tube's");
    // Not a workspace, and not counted twice.
    expect(hint()).not.toContain("as in the workspace");
    expect(hint()).not.toMatch(/one tree per file, \d+ files/);
    expect(hint()).toContain("X.fcs (no tube of this experiment is named like it or records its acquisition times)");
    expect(hint()).not.toContain("applied to all 3 files");
    expect((await countsOf("D1.fcs")).lymphocytes).toBe(1);
    expect((await countsOf("Specimen_001_Tube_001.fcs")).lymphocytes).toBe(3);
  });

  // "1 follow it as in the workspace", of an experiment that is no workspace; and one file follows.
  it("says the files follow it as in the experiment", async () => {
    await loadAndImport([fcs("Specimen_001_Tube_001.fcs", 1), fcs("D1.fcs", 3)], "Specimen_001_Tube_001.fcs",
      fileOf("experiment.xml", XML));
    await confirmImport();
    expect(hint()).toMatch(/for 2 files: 1 follows it as in the experiment, 1 tailored\./);
    expect(hint()).not.toContain("as in the workspace");
  });
});

describe("a FACSChorus experiment imported with several files loaded", () => {
  // rec2.fcs was recorded during Sort 2 under Sort 2's gates, and plain.fcs carries no record.
  // Sort 1's snapshot, imported onto rec1.fcs, went onto both under "applied to all 3 files".
  it("gives every other recording the tree it was recorded under, and names a file that is none", async () => {
    const { strToU8, zipSync } = await import("fflate");
    const cef = zipSync({
      "manifest.json": strToU8(JSON.stringify({ chorusVersion: "5.4.0" })),
      "experiment.json": strToU8(JSON.stringify({
        experiment: { id: "E1", name: "experiment E1", panels: [{ id: "P1", name: "Panel 1", analysis: { gates: [chorusGate(300)], visualizationSettings: { analysisRValueMap: [] } } }] },
        sortRecords: [
          { name: "Sort 1", startSortTime: "2024-01-01T09:00:00", stopSortTime: "2024-01-01T09:30:00", gateHierarchy: [chorusGate(350)] },
          { name: "Sort 2", startSortTime: "2024-01-01T10:00:00", stopSortTime: "2024-01-01T10:30:00", gateHierarchy: [chorusGate(300)] },
        ],
      })),
    });
    await loadAndImport([fcs("rec1.fcs", 7), fcs("rec2.fcs", 8), fcs("plain.fcs", 4)], "rec1.fcs", fileOf("strategy.cef", cef as Uint8Array<ArrayBuffer>));
    const own = [...host.querySelectorAll<HTMLButtonElement>(".gl-chorus-timeline-row button")].find((b) => b.textContent === "Import snapshot…")!;
    await act(async () => { own.click(); });
    for (let i = 0; i < 6; i++) await settle();
    expect(modals()).toContain("These follow the tree without a tree of their own: plain.fcs.");
    await confirmImport();
    expect(hint()).toContain("one tree per file: each other recording gets the tree it was recorded under");
    expect(hint()).not.toContain("as in the workspace");
    expect(hint()).toContain("plain.fcs (it carries no FACSChorus record)");
    expect(hint()).not.toContain("applied to all 3 files");
    expect(hint()).toMatch(/for 3 files: 2 follow it, 1 tailored/);
  });

  // "1 follow it as recorded".
  it("says one recording follows the tree as recorded, when each file's own tree is imported", async () => {
    const { strToU8, zipSync } = await import("fflate");
    const cef = zipSync({
      "manifest.json": strToU8(JSON.stringify({ chorusVersion: "5.4.0" })),
      "experiment.json": strToU8(JSON.stringify({
        experiment: { id: "E1", name: "experiment E1", panels: [{ id: "P1", name: "Panel 1", analysis: { gates: [chorusGate(300)], visualizationSettings: { analysisRValueMap: [] } } }] },
        sortRecords: [
          { name: "Sort 1", startSortTime: "2024-01-01T09:00:00", stopSortTime: "2024-01-01T09:30:00", gateHierarchy: [chorusGate(350)] },
          { name: "Sort 2", startSortTime: "2024-01-01T10:00:00", stopSortTime: "2024-01-01T10:30:00", gateHierarchy: [chorusGate(300)] },
        ],
      })),
    });
    await loadAndImport([fcs("rec1.fcs", 7), fcs("rec2.fcs", 8)], "rec1.fcs", fileOf("strategy.cef", cef as Uint8Array<ArrayBuffer>));
    const each = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith("Import each file's own tree"))!;
    await act(async () => { each.click(); });
    for (let i = 0; i < 6; i++) await settle();
    expect(hint()).toMatch(/for 2 files: 1 follows it as recorded, 1 tailored\./);
  });
});

describe("a Cytobank file tailored for a name two loaded files carry", () => {
  // The tailoring was applied to neither file, and nobody was asked.
  it("asks which file it is, and applies the tailoring to the one chosen", async () => {
    const { CYTOBANK_TAILORED } = await import("./engine/cytobankTailoring.fixture");
    await loadAndImport([fcs("D1.fcs", 1), fileOf("D2.fcs", Uint8Array.from([2])), fileOf("D2.fcs", Uint8Array.from([4]))], "D1.fcs",
      fileOf("cytobank.xml", CYTOBANK_TAILORED));
    const ask = host.querySelector<HTMLElement>('[aria-label="Which file Cytobank tailored gates for"]');
    expect(ask).not.toBeNull();
    const select = ask!.querySelector<HTMLSelectElement>("select")!;
    const options = [...select.options].map((o) => o.textContent ?? "");
    expect(options[0]).toBe("None of them: they follow the tree");
    // The two files are told apart by what each recorded.
    expect(options.slice(1).map((o) => o.replace(/^D2\.fcs · 3 events · recorded /, ""))).toEqual(["02-FEB-2024 15:30:00", "04-APR-2024 12:00:00"]);
    await act(async () => { select.value = select.options[2].value; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const next = [...ask!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Continue")!;
    await act(async () => { next.click(); });
    for (let i = 0; i < 4; i++) await settle();
    await confirmImport();
    expect(hint()).toContain("Cytobank's tailored gates applied to the file they were tailored for: D2.fcs");
    expect(errorText()).toContain('applied to D2.fcs · 3 events · recorded 04-APR-2024 12:00:00, as chosen');
  });

  // The note named the files by Cytobank's spelling of the name, not theirs.
  it("names the loaded files by their own spelling", async () => {
    const { CYTOBANK_TAILORED } = await import("./engine/cytobankTailoring.fixture");
    await loadAndImport([fcs("D1.fcs", 1), fileOf("d2.FCS", Uint8Array.from([2])), fileOf("d2.FCS", Uint8Array.from([4]))], "D1.fcs",
      fileOf("cytobank.xml", CYTOBANK_TAILORED));
    const ask = host.querySelector<HTMLElement>('[aria-label="Which file Cytobank tailored gates for"]')!;
    const next = [...ask.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Continue")!;
    await act(async () => { next.click(); });
    for (let i = 0; i < 4; i++) await settle();
    await confirmImport();
    expect(errorText()).toContain('2 loaded files are named "d2.FCS" (Cytobank\'s "D2.fcs"); Cytobank\'s');
  });
});

describe("the open dialog, one file two samples of one name could be", () => {
  // The workspace holds D1.fcs twice. Choosing the second row, the first read "D1.fcs was chosen as
  // D1.fcs", which said nothing about which.
  it("says by position which of the two it was chosen as", async () => {
    act(() => root.render(<App />));
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("lymphocytes", "a1", 25)),
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("lymphocytes", "a1", 12)),
    ))]);
    await feed('input[data-role="flowjo-workspace-fcs"]', [fcs("D1.fcs", 1)]);
    const dialog = () => host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]')!;
    const rows = () => [...dialog().querySelectorAll<HTMLButtonElement>(".gl-wsp-row")];
    await act(async () => { rows()[1].click(); });
    await settle();
    expect(rows()[0].textContent).toContain("not found — D1.fcs was chosen as D1.fcs (position 2)");
  });
});

describe("two loaded files of one name, each its own sample", () => {
  // The staged dialog listed "Specimen_001_Tube_001.fcs, Specimen_001_Tube_001.fcs", and nothing
  // said which was which.
  it("tells them apart by the sample each is", async () => {
    act(() => root.render(<App />));
    await feed('input[type=file][accept=".fcs"][multiple]', [fcs("Specimen_001_Tube_001.fcs", 1), fcs("Specimen_001_Tube_001.fcs", 2)]);
    const row = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find((r) => r.textContent?.includes("Specimen_001_Tube_001.fcs"))!;
    await act(async () => { row.click(); });
    await settle();
    await feed('input[accept=".xml,.wsp,.cef"]', [fileOf("experiment.wsp", wsp(
      sample("Specimen_001_Tube_001.fcs", "Specimen_001_Tube_001.fcs", IDENTITY[1], pop("lymphocytes", "a1", 25), "Experiment 1"),
      sample("Specimen_001_Tube_001.fcs", "Specimen_001_Tube_001.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12), "Experiment 2"),
    ))]);
    expect(modals()).toContain("Specimen_001_Tube_001.fcs (sample 1), Specimen_001_Tube_001.fcs (sample 2)");
  });
});

describe("the open dialog, with a file already loaded that no sample is", () => {
  // X.fcs was loaded before the open. It followed the imported tree unnamed, as "none of this
  // workspace's business", while the result said "for 2 files" with 3 loaded.
  it("names that file too, and counts it", async () => {
    act(() => root.render(<App />));
    await feed('input[type=file][accept=".fcs"][multiple]', [fcs("X.fcs", 4)]);
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
    ))]);
    await feed('input[data-role="flowjo-workspace-fcs"]', [fcs("D1.fcs", 1), fcs("D2.fcs", 2)]);
    const dialog = host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]')!;
    const importButton = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Import")!;
    await act(async () => { importButton.click(); });
    for (let i = 0; i < 8; i++) await settle();
    await confirmImport();
    expect(hint()).toMatch(/for 3 files: 2 follow it, 1 tailored/);
    expect(hint()).toContain("X.fcs (no sample is named like it)");
  });
});

describe("the open dialog, a renamed file whose same-named sample records nothing that confirms it", () => {
  // Sample 2 is named renamed.fcs and records only the $TOT and $DATE the file carries; the file is
  // sample 1's acquisition by its $FIL and every keyword. The dialog showed sample 2 "found:
  // renamed.fcs · confirmed by $TOT, $DATE" and sample 1 "not found".
  it("pairs the file with the sample its keywords confirm, and says why the other is not it", async () => {
    act(() => root.render(<App />));
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", wsp(
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("D2_lymphocytes", "b1", 12)),
      sample("renamed.fcs", "renamed.fcs", { $TOT: "3", $DATE: "02-FEB-2024" }, pop("Renamed_lymphocytes", "r1", 25)),
    ))]);
    await feed('input[data-role="flowjo-workspace-fcs"]', [fcs("renamed.fcs", 5)]);
    const dialog = host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]')!;
    const rows = [...dialog.querySelectorAll<HTMLElement>(".gl-wsp-row")].map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("found: renamed.fcs · confirmed by $TOT, $DATE, $BTIM, $ETIM, GUID");
    expect(rows[1]).toContain("not found — renamed.fcs is named like it, but records nothing confirming it is this sample; its $FIL and keywords are D2.fcs's");
    expect(rows[1]).not.toContain("confirmed by");
  });
});

describe("another sample's tree chosen for the viewed file, with that sample's own file loaded", () => {
  // X.fcs is no sample; the user applies D1's tree to it. D1.fcs, loaded too, IS sample 1, and was
  // skipped as "the chosen sample": it got no tree of its own and was not counted.
  it("gives the chosen sample's own file that sample's tree too, and counts every file", async () => {
    await loadAndImport([fcs("D1.fcs", 1), fcs("D2.fcs", 2), fcs("X.fcs", 4)], "X.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
    )));
    const picker = host.querySelector<HTMLElement>('[aria-label="Choose a FlowJo sample"]')!;
    const row = [...picker.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")].find((r) => r.textContent?.includes("Import D1.fcs's tree onto X.fcs"))!;
    await act(async () => { row.click(); });
    for (let i = 0; i < 6; i++) await settle();
    // X.fcs gets D1's tree by choice, not its own sample's, and the dialog says so.
    expect(modals()).toContain("These 3 files get one tree for the workspace, tailored per file where they differ: X.fcs, D1.fcs, D2.fcs. X.fcs gets \"D1.fcs\"'s tree by choice; each of the others gets its own sample's.");
    expect(modals()).not.toContain("Each of these 3 files gets its own sample's tree");
    await confirmImport();
    expect(hint()).toMatch(/Imported one tree, "[^"]*", from X\.fcs for 3 files/);
    expect(hint()).toContain("D1.fcs's tree applied to X.fcs by choice");
    expect((await countsOf("D2.fcs")).lymphocytes).toBe(1);
    expect((await countsOf("D1.fcs")).lymphocytes).toBe(2);
  });
});

describe("the open dialog, a file and a copy of it under another name", () => {
  // D1.fcs is sample 1 by its name, and copy.fcs is the same acquisition, found by its $FIL. Two
  // files claiming one sample left it with neither: both followed D2's tree, the row read "could
  // be this sample or , and the keywords cannot tell", and clicking it only disabled Import.
  it("gives both files their own sample's tree, and says the copy is the same acquisition", async () => {
    act(() => root.render(<App />));
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
    ))]);
    await feed('input[data-role="flowjo-workspace-fcs"]', [fcs("D2.fcs", 2), fcs("D1.fcs", 1), fcs("copy.fcs", 1)]);
    const dialog = host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]')!;
    const rows = [...dialog.querySelectorAll<HTMLElement>(".gl-wsp-row")].map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("found: D1.fcs · confirmed by $TOT, $DATE, $BTIM, $ETIM, GUID · and copy.fcs, the same acquisition");
    expect(dialog.textContent).not.toContain("or , and");
    expect(dialog.textContent).toContain("2/2 found");
    const importButton = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Import")!;
    await act(async () => { importButton.click(); });
    for (let i = 0; i < 8; i++) await settle();
    expect(modals()).toContain("Each of these 3 files gets its own sample's tree");
    await confirmImport();
    expect(hint()).toMatch(/from D2\.fcs for 3 files/);
    expect((await countsOf("D1.fcs")).lymphocytes).toBe(2);
    expect((await countsOf("copy.fcs")).lymphocytes).toBe(2);
    expect((await countsOf("D2.fcs")).lymphocytes).toBe(1);
  });
});

describe("the open dialog, two files that could each be one sample", () => {
  // The sample records nothing, D1.fcs is named like it and other.fcs records it as its $FIL, and
  // the two are different acquisitions. Nothing tells which is the sample, so the user says, once.
  it("asks which file it is, and gives that file its tree", async () => {
    act(() => root.render(<App />));
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", wsp(
      sample("D1.fcs", "D1.fcs", {}, pop("lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
    ))]);
    await feed('input[data-role="flowjo-workspace-fcs"]', [fcs("D2.fcs", 2), fcs("D1.fcs", 4), fcs("other.fcs", 6)]);
    const dialog = () => host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]')!;
    const rows = () => [...dialog().querySelectorAll<HTMLElement>(".gl-wsp-row")].map((r) => r.textContent ?? "");
    expect(rows()[0]).toContain("D1.fcs and other.fcs could each be this sample, and the keywords cannot tell which: say which below");
    expect(dialog().textContent).not.toContain("or , and");
    expect(dialog().textContent).not.toContain("1 samples could be it");
    const ask = dialog().querySelector<HTMLSelectElement>('[data-role="flowjo-contested-sample"] select')!;
    expect(ask.closest("[data-role]")!.textContent).toContain('D1.fcs and other.fcs could each be "D1.fcs", and the keywords cannot tell which. Which is it?');
    const otherKey = [...ask.options].find((o) => o.textContent === "other.fcs")!.value;
    await act(async () => {
      ask.value = otherKey;
      ask.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(rows()[0]).toContain("found: other.fcs · chosen as this sample");
    expect(dialog().querySelector('[data-role="flowjo-unpaired-files"]')!.textContent).toContain('D1.fcs (other.fcs is "D1.fcs")');
    const importButton = [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Import")!;
    await act(async () => { importButton.click(); });
    for (let i = 0; i < 8; i++) await settle();
    await confirmImport();
    expect(hint()).toMatch(/from D2\.fcs for 3 files/);
    expect(hint()).toContain('following the tree without a tree of their own: D1.fcs (other.fcs is sample 1 "D1.fcs")');
    expect((await countsOf("other.fcs")).lymphocytes).toBe(2);
    expect((await countsOf("D2.fcs")).lymphocytes).toBe(1);
  });
});

describe("the open dialog, a file whose own sample carries no gates", () => {
  // control.fcs is the workspace's ungated control, loaded unselected for actions. It followed the
  // tree, and the result said "for 2 files" and never named it.
  it("counts and names that file with the files that follow the tree", async () => {
    act(() => root.render(<App />));
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
      sample("control.fcs", "control.fcs", IDENTITY[4], ""),
    ))]);
    await feed('input[data-role="flowjo-workspace-fcs"]', [fcs("D1.fcs", 1), fcs("D2.fcs", 2), fcs("control.fcs", 4)]);
    const dialog = host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]')!;
    const importButton = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Import")!;
    await act(async () => { importButton.click(); });
    for (let i = 0; i < 8; i++) await settle();
    await confirmImport();
    expect(hint()).toMatch(/from D1\.fcs for 3 files: 2 follow it, 1 tailored/);
    expect(hint()).toContain("control.fcs");
    expect(hint()).toContain('it is sample 3 "control.fcs", which carries no gates');
    expect(host.querySelector(".population-tree-hierarchy-count")?.textContent).toBe("3 files · 1 tailored");
  });
});

describe("a .wsp onto a loaded file whose sample's every tree fails alone, with other files samples too", () => {
  // Both of D1's trees are on a channel D1 lacks. Once both had failed, the picker's "Every tree,
  // each file its own sample's" was dropped with them, and the import ended with "None of the
  // sample's 2 trees could be imported", though that choice would have imported.
  it("still offers every tree, each file its own sample's", async () => {
    await loadAndImport([fcs("D1.fcs", 1), fcs("D2.fcs", 2)], "D1.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("D1_first", "z1", 25, "Z-A") + pop("D1_second", "z2", 15, "Z-A")),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("D2_lymphocytes", "b1", 12)),
    )));
    const picker = () => host.querySelector<HTMLElement>('[aria-label="Choose a gating tree"]');
    const rowsOf = () => [...picker()!.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")];
    await act(async () => { rowsOf()[1].click(); });
    for (let i = 0; i < 6; i++) await settle();
    await act(async () => { rowsOf()[2].click(); });
    for (let i = 0; i < 6; i++) await settle();
    expect(picker()).not.toBeNull();
    expect(rowsOf().map((r) => r.disabled)).toEqual([false, true, true]);
    expect(picker()!.textContent).toContain("None of this sample's trees can be imported alone; every tree, each file its own sample's, still can.");
    expect(errorText()).not.toContain("None of the sample's 2 trees could be imported");
    await act(async () => { rowsOf()[0].click(); });
    for (let i = 0; i < 6; i++) await settle();
    await confirmImport();
    expect(page()).toContain("D2_lymphocytes");
    expect(hint()).toMatch(/Imported one tree, "[^"]*", from D2\.fcs for 2 files/);
  });
});

describe("a per-file import where another file's tree cannot be applied to it", () => {
  // D2's gates are on channels D2 lacks, and the refusal lists them a line each. The header broke
  // the notes at every newline, so those lines named no file, and the group said D2's "strategy
  // could not be read" when it was read.
  it("keeps the reason on the file's own line, and says the tree could not be applied", async () => {
    await loadAndImport([fcs("D1.fcs", 1), fcs("D2.fcs", 2)], "D1.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("elsewhere_one", "z1", 25, "Z-A") + pop("elsewhere_two", "z2", 25, "Y-A")),
    )));
    await confirmImport();
    const lines = [...host.querySelectorAll(".gl-error .gl-error-line")].map((l) => l.textContent ?? "");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^(⚠ )?D[12]\.fcs: /);
    expect(lines.find((l) => l.includes("D2.fcs:"))).toContain("its tree could not be applied to it, so it follows the imported tree without tailoring.");
    expect(errorText()).not.toContain("D2.fcs: its strategy could not be read");
    expect(hint()).toContain("D2.fcs follows it without tailoring: its tree could not be applied to it.");
  });
});

describe("a .wsp onto the viewed file, with a copy of it and another sample's file loaded", () => {
  // copy.fcs is the viewed D1.fcs's acquisition under another name. It followed the tree without a
  // tree of its own: the result said "for 2 files" with 3 loaded, and it was not compensated.
  it("gives the copy its sample's tree as its own, and counts it", async () => {
    await loadAndImport([fcs("D1.fcs", 1), fcs("copy.fcs", 1), fcs("D2.fcs", 2)], "D1.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
    )));
    expect(modals()).toContain("Each of these 3 files gets its own sample's tree");
    await confirmImport();
    expect(hint()).toMatch(/from D1\.fcs for 3 files: 2 follow it as in the workspace, 1 tailored/);
    expect((await countsOf("copy.fcs")).lymphocytes).toBe(2);
    expect((await countsOf("D2.fcs")).lymphocytes).toBe(1);
  });
});

describe("the open dialog, a file, a copy of it, and another acquisition of the file's name", () => {
  // Sample 1 records nothing. D1.fcs (seed 10) and copy.fcs are one acquisition; the second D1.fcs
  // is another. The question offered the copy as a third rival, and with the first D1.fcs chosen
  // the copy followed D2's tree, uncompensated, as a file of no sample.
  it("asks once per acquisition, and gives the chosen file's copy its tree too", async () => {
    act(() => root.render(<App />));
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", wsp(
      sample("D1.fcs", "D1.fcs", {}, pop("lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
    ))]);
    await feed('input[data-role="flowjo-workspace-fcs"]', [fcs("D2.fcs", 2), fcs("D1.fcs", 10), fcs("copy.fcs", 6), fcs("D1.fcs", 4)]);
    const dialog = () => host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]')!;
    const ask = () => dialog().querySelector<HTMLSelectElement>('[data-role="flowjo-contested-sample"] select')!;
    expect([...ask().options].map((o) => o.value)).toEqual(["", "pending:1", "pending:3"]);
    const may = "D1.fcs (3 events · recorded 05-MAY-2024 13:00:00)";
    const april = "D1.fcs (3 events · recorded 04-APR-2024 12:00:00)";
    expect(ask().closest("[data-role]")!.textContent).toContain(`${may} (and copy.fcs, the same acquisition) and ${april} could each be`);
    expect(dialog().querySelector('[data-role="flowjo-unpaired-files"]')!.textContent).toContain(`copy.fcs (a copy of ${may}, which it goes with;`);
    await act(async () => {
      ask().value = "pending:1";
      ask().dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    const rows = [...dialog().querySelectorAll<HTMLElement>(".gl-wsp-row")].map((r) => r.textContent ?? "");
    expect(rows[0]).toContain(`found: ${may} · chosen as this sample · and copy.fcs, the same acquisition`);
    const importButton = [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Import")!;
    await act(async () => { importButton.click(); });
    for (let i = 0; i < 8; i++) await settle();
    await confirmImport();
    expect(hint()).toMatch(/from D2\.fcs for 4 files: 2 follow it, 2 tailored/);
    expect((await countsOf("copy.fcs")).lymphocytes).toBe(2);
    expect((await countsOf("D2.fcs")).lymphocytes).toBe(1);
  });
});

describe("the open dialog, two files of one name that could each be one sample", () => {
  // Sample 1 records nothing, and two chosen D1.fcs files are different acquisitions. The question
  // offered "D1.fcs (file 1)" and "D1.fcs (file 2)", the row read "D1.fcs and D1.fcs could each be
  // this sample", the staged dialog listed D1.fcs among the files that get their own tree and among
  // those that follow it, and the result read "D1.fcs (D1.fcs is sample 1 ...)".
  it("says which file each is, by its event count and when it was recorded, in the question, the row and the result", async () => {
    act(() => root.render(<App />));
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", wsp(
      sample("D1.fcs", "D1.fcs", {}, pop("lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
    ))]);
    await feed('input[data-role="flowjo-workspace-fcs"]', [fcs("D2.fcs", 2), fcs("D1.fcs", 10), fcs("D1.fcs", 4)]);
    const may = "D1.fcs (3 events · recorded 05-MAY-2024 13:00:00)";
    const april = "D1.fcs (3 events · recorded 04-APR-2024 12:00:00)";
    const dialog = () => host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]')!;
    const ask = () => dialog().querySelector<HTMLSelectElement>('[data-role="flowjo-contested-sample"] select')!;
    expect([...ask().options].map((o) => o.textContent)).toEqual(["not chosen", may, april]);
    const rows = () => [...dialog().querySelectorAll<HTMLElement>(".gl-wsp-row")].map((r) => r.textContent ?? "");
    expect(rows()[0]).toContain(`${may} and ${april} could each be this sample`);
    await act(async () => {
      ask().value = "pending:2";
      ask().dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(rows()[0]).toContain(`found: ${april} · chosen as this sample`);
    expect(dialog().querySelector('[data-role="flowjo-unpaired-files"]')!.textContent).toContain(`${may} (${april} is "D1.fcs")`);
    const importButton = [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Import")!;
    await act(async () => { importButton.click(); });
    for (let i = 0; i < 8; i++) await settle();
    expect(modals()).toContain("tailored per file where they differ: D2.fcs, D1.fcs (sample 1).");
    expect(modals()).toContain(`These follow the tree without a tree of their own: ${may}.`);
    await confirmImport();
    expect(hint()).toContain(`following the tree without a tree of their own: ${may} (${april} is sample 1 "D1.fcs")`);
  });
});

describe("the open dialog, a chosen file of the name of a file already open", () => {
  // d2.fcs is the open D2.fcs's acquisition. It was dropped without a word: neither loaded nor named.
  it("names the file it did not hold, in the dialog and in the result", async () => {
    act(() => root.render(<App />));
    await feed('input[type=file][accept=".fcs"][multiple]', [fcs("D2.fcs", 2)]);
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
    ))]);
    await feed('input[data-role="flowjo-workspace-fcs"]', [fcs("D1.fcs", 1), fcs("d2.fcs", 2)]);
    const dialog = host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]')!;
    expect(dialog.querySelector('[data-role="flowjo-not-held"]')?.textContent).toContain(
      "d2.fcs (as D2.fcs, already open; its keywords say it is the same acquisition)");
    const importButton = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Import")!;
    await act(async () => { importButton.click(); });
    for (let i = 0; i < 8; i++) await settle();
    await confirmImport();
    expect(errorText()).toContain("d2.fcs was not loaded: it has the name of D2.fcs, already open, and its keywords say it is the same acquisition");
  });
});

describe("a .wsp onto the viewed file, with another acquisition of its name loaded", () => {
  // Sample 1 records nothing. The viewed D1.fcs is it; the other D1.fcs is another acquisition. It
  // was taken for a copy of the viewed file without its keywords being compared, listed among the
  // files that get their own sample's tree, and asked the matrix question as sample 1's.
  it("gives that file no tree of its own, and says the viewed file is the sample", async () => {
    await loadAndImport([fcs("D1.fcs", 10), fcs("D1.fcs", 4), fcs("D2.fcs", 2)], "D1.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", {}, pop("lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
    )));
    const may = "D1.fcs (3 events · recorded 05-MAY-2024 13:00:00)";
    const april = "D1.fcs (3 events · recorded 04-APR-2024 12:00:00)";
    expect(modals()).toContain("Each of these 2 files gets its own sample's tree");
    expect(modals()).toContain(`These follow the tree without a tree of their own: ${april}.`);
    await confirmImport();
    // The tree's file is named as the other D1.fcs is, so the two are told apart here too.
    expect(hint()).toContain(`from ${may} for 3 files`);
    expect(hint()).toContain(`${april} (${may} is sample 1 "D1.fcs")`);
  });
});

describe("a .wsp onto the viewed file, with two loaded files that could each be another sample", () => {
  // Sample 1 records nothing, and two loaded D1.fcs files are different acquisitions. Nothing asked
  // which was sample 1: both followed D2's tree, and the result said "none was chosen".
  it("asks which is that sample, and gives the file chosen its tree", async () => {
    await loadAndImport([fcs("D2.fcs", 2), fcs("D1.fcs", 10), fcs("D1.fcs", 4)], "D2.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", {}, pop("lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
    )));
    const may = "D1.fcs (3 events · recorded 05-MAY-2024 13:00:00)";
    const april = "D1.fcs (3 events · recorded 04-APR-2024 12:00:00)";
    const ask = host.querySelector<HTMLElement>('[aria-label="Which loaded file is each sample"]');
    expect(ask).not.toBeNull();
    expect(ask!.textContent).toContain(`${may} and ${april} could each be "D1.fcs", and the keywords cannot tell which. Which is it?`);
    const select = ask!.querySelector<HTMLSelectElement>("select")!;
    const aprilKey = [...select.options].find((o) => o.textContent === april)!.value;
    await act(async () => {
      select.value = aprilKey;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const next = [...ask!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Continue")!;
    await act(async () => { next.click(); });
    for (let i = 0; i < 6; i++) await settle();
    expect(modals()).toContain("Each of these 2 files gets its own sample's tree");
    await confirmImport();
    expect(hint()).toMatch(/from D2\.fcs for 3 files: 2 follow it, 1 tailored/);
    expect(hint()).toContain(`${may} (${april} is sample 1 "D1.fcs")`);
  });
});

describe("a .wsp onto the viewed file, with a loaded file two samples could each be", () => {
  // Two samples record one acquisition, and the loaded D1.fcs is it. Nothing asked which sample it
  // is: it followed the viewed file's tree, and the result said "2 samples could be it, and none
  // was chosen" of a choice never offered.
  const W = wsp(
    sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("lymphocytes", "a1", 25), "Group 1"),
    sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("lymphocytes", "a1", 20), "Group 2"),
    sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
  );
  it("asks which sample it is, and gives it the tree of the sample chosen", async () => {
    await loadAndImport([fcs("D2.fcs", 2), fcs("D1.fcs", 1)], "D2.fcs", fileOf("experiment.wsp", W));
    const ask = host.querySelector<HTMLElement>('[aria-label="Which loaded file is each sample"]');
    expect(ask).not.toBeNull();
    expect(ask!.textContent).toContain('D1.fcs could be "D1.fcs (position 1)" or "D1.fcs (position 2)", and the keywords cannot tell which. Which is it?');
    const select = ask!.querySelector<HTMLSelectElement>('select[aria-label="Which sample is this file"]')!;
    await act(async () => {
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const next = [...ask!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Continue")!;
    await act(async () => { next.click(); });
    for (let i = 0; i < 6; i++) await settle();
    expect(modals()).toContain("Each of these 2 files gets its own sample's tree");
    await confirmImport();
    expect(hint()).toMatch(/from D2\.fcs for 2 files/);
    expect(hint()).not.toContain("none was chosen");
    // Sample 2's gate: 0 to 20 on FSC-A holds two of the file's three events.
    expect((await countsOf("D1.fcs")).lymphocytes).toBe(2);
  });

  it("says none was chosen only when the question was asked and left", async () => {
    await loadAndImport([fcs("D2.fcs", 2), fcs("D1.fcs", 1)], "D2.fcs", fileOf("experiment.wsp", W));
    const ask = host.querySelector<HTMLElement>('[aria-label="Which loaded file is each sample"]')!;
    const next = [...ask.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Continue")!;
    await act(async () => { next.click(); });
    for (let i = 0; i < 6; i++) await settle();
    await confirmImport();
    expect(hint()).toContain("D1.fcs (2 samples could be it, and none was chosen)");
  });
});

describe("a .wsp onto the viewed file, with a sample's file and a foreign file of one name loaded", () => {
  // D2.fcs is sample 2's file, and another D2.fcs is an acquisition the workspace does not record.
  // The tree picker, the notes of D2's conversion and the result named "D2.fcs" bare, and nothing
  // said which of the two it meant.
  it("names the sample's file so it is told from the other, in the picker, the notes and the result", async () => {
    const quadrant = `<Population name="Q" count="1"><Gate><gating:QuadrantGate xmlns:gating="${G}" gating:id="q1"/></Gate></Population>`;
    await loadAndImport([fcs("D1.fcs", 1), fcs("D2.fcs", 2), fcs("D2.fcs", 4)], "D1.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("live cells", "a1", 25, "V525-A") + pop("other", "a2", 20)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("Live cells", "b1", 15, "V525-A") + quadrant),
    )));
    const own = "D2.fcs (3 events · recorded 02-FEB-2024 15:30:00)";
    const picker = host.querySelector<HTMLElement>('[aria-label="Choose a gating tree"]')!;
    expect(picker.textContent).toContain(`Other loaded files are samples of this workspace too: ${own}.`);
    expect(picker.textContent).toContain(`One hierarchy per file: D1.fcs, ${own}`);
    const every = [...picker.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")].find((b) => b.textContent?.includes("Every tree"))!;
    await act(async () => { every.click(); });
    for (let i = 0; i < 6; i++) await settle();
    await confirmImport();
    expect(hint()).toContain(`${own} labels a detector differently from D1.fcs`);
    expect(errorText()).toContain(`${own}: "Q" uses QuadrantGate`);
  });
});

describe("a per-file import asking which matrix, with a sample's file and a foreign file of one name loaded", () => {
  // D2.fcs's own matrix differs from its sample's in the workspace, and another D2.fcs is loaded.
  // The question and the result named "D2.fcs" bare.
  it("names the file whose matrix differs so it is told from the other", async () => {
    const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";
    const matrix = `<transforms:spilloverMatrix xmlns:transforms="${T}" xmlns:data-type="${D}" spectral="0" prefix="Comp-" suffix="" name="Matrix_A">
      <data-type:parameters><data-type:parameter data-type:name="V525-A"/><data-type:parameter data-type:name="V450-A"/></data-type:parameters>
      <transforms:spillover data-type:parameter="V525-A">
        <transforms:coefficient data-type:parameter="V525-A" transforms:value="1"/><transforms:coefficient data-type:parameter="V450-A" transforms:value="0.25"/>
      </transforms:spillover>
      <transforms:spillover data-type:parameter="V450-A">
        <transforms:coefficient data-type:parameter="V525-A" transforms:value="0.05"/><transforms:coefficient data-type:parameter="V450-A" transforms:value="1"/>
      </transforms:spillover></transforms:spilloverMatrix>`;
    const d2 = `<Sample><DataSet uri="file:D2.fcs"/>${matrix}${keywords(IDENTITY[2])}<SampleNode name="D2.fcs" count="3"><Subpopulations>${pop("CD4_positive", "b1", 15, "Comp-V525-A")}</Subpopulations></SampleNode></Sample>`;
    await loadAndImport([fcs("D1.fcs", 1), fcs("D2.fcs", 13), fcs("D2.fcs", 4)], "D1.fcs", fileOf("experiment.wsp", wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("CD4_positive", "a1", 25)),
      d2,
    )));
    const own = "D2.fcs (3 events · recorded 02-FEB-2024 15:30:00)";
    expect(modals()).toContain(`each carry a spillover matrix, and they differ by up to 0.0500: ${own}. Which should`);
    await confirmImport();
    expect(hint()).toContain(`${own} carries a matrix that differs from its sample's in the workspace`);

    // The workspace's matrix, applied to that file, is saved with it: a tailored file's chosen
    // matrix did not survive a save and reopen. Its twin of one name, and D1, have none.
    let saved: Blob | null = null;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (blob: Blob) => { saved = blob; return "blob:saved"; } });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
    const save = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Save Portable Copy…")!;
    await act(async () => { save.click(); });
    for (let i = 0; i < 4; i++) await settle();
    expect(saved).not.toBeNull();
    const bytes = await new Promise<ArrayBuffer>((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result as ArrayBuffer); r.readAsArrayBuffer(saved!); });
    const workspace = JSON.parse(strFromU8(unzipSync(new Uint8Array(bytes))["workspace.json"])) as { samples: { fileName: string; externalSpillover?: unknown }[] };
    expect(workspace.samples.map((s0) => [s0.fileName, s0.externalSpillover ?? null])).toEqual([
      ["D1.fcs", null],
      ["D2.fcs", { label: "Matrix_A", channels: ["V525-A", "V450-A"], matrix: [[1, 0.25], [0.05, 1]] }],
      ["D2.fcs", null],
    ]);
  });
});

describe("one tree imported onto a file and a copy of it, the gates compensated", () => {
  // D2.fcs and copy.fcs are one acquisition (seed 13), which carries its own matrix; the workspace
  // compensates with the same one. "CD4_positive" is on Comp-V525-A up to 20.1: compensated it
  // holds 1 event, uncompensated 2. Only the viewed file was compensated: the copy stayed on the
  // original layer, 2 events against its sample's 1, while the result said "applied to all 2 files
  // · FCS compensation enabled" (#343's round-4 verifier, on FR-FCM-Z2V4 F_022 and its copy: CD3+/
  // dead 863 on the copy against 770 on the file and FlowJo's 771).
  const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";
  const matrix = `<transforms:spilloverMatrix xmlns:transforms="${T}" xmlns:data-type="${D}" spectral="0" prefix="Comp-" suffix="" name="Matrix_A">
      <data-type:parameters><data-type:parameter data-type:name="V525-A"/><data-type:parameter data-type:name="V450-A"/></data-type:parameters>
      <transforms:spillover data-type:parameter="V525-A">
        <transforms:coefficient data-type:parameter="V525-A" transforms:value="1"/><transforms:coefficient data-type:parameter="V450-A" transforms:value="0.3"/>
      </transforms:spillover>
      <transforms:spillover data-type:parameter="V450-A">
        <transforms:coefficient data-type:parameter="V525-A" transforms:value="0.05"/><transforms:coefficient data-type:parameter="V450-A" transforms:value="1"/>
      </transforms:spillover></transforms:spilloverMatrix>`;
  const d2 = `<Sample><DataSet uri="file:D2.fcs"/>${matrix}${keywords(IDENTITY[2])}<SampleNode name="D2.fcs" count="3"><Subpopulations>${pop("CD4_positive", "b1", 20.1, "Comp-V525-A")}</Subpopulations></SampleNode></Sample>`;
  const openDialog = () => host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]')!;
  async function importFromDialog(): Promise<void> {
    const importButton = [...openDialog().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Import")!;
    await act(async () => { importButton.click(); });
    for (let i = 0; i < 8; i++) await settle();
    await confirmImport();
  }

  it("compensates the copy too, imported onto the viewed file", async () => {
    await loadAndImport([fcs("D2.fcs", 13), fcs("copy.fcs", 13)], "D2.fcs", fileOf("experiment.wsp", wsp(d2)));
    await confirmImport();
    expect(hint()).toContain("FCS compensation enabled");
    expect(hint()).not.toMatch(/not compensated/);
    expect((await countsOf("D2.fcs")).CD4_positive).toBe(1);
    expect((await countsOf("copy.fcs")).CD4_positive).toBe(1);
  });

  it("compensates the copy too, from the open dialog with the file and its copy", async () => {
    act(() => root.render(<App />));
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", wsp(d2))]);
    await feed('input[data-role="flowjo-workspace-fcs"]', [fcs("D2.fcs", 13), fcs("copy.fcs", 13)]);
    await importFromDialog();
    expect(hint()).toContain("FCS compensation enabled");
    expect(hint()).not.toMatch(/not compensated/);
    expect((await countsOf("D2.fcs")).CD4_positive).toBe(1);
    expect((await countsOf("copy.fcs")).CD4_positive).toBe(1);
  });

  it("compensates the copy with \"One hierarchy per file\" cleared, and names a file that follows uncompensated", async () => {
    act(() => root.render(<App />));
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", wsp(
      d2,
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("CD4_positive", "a1", 25)),
    ))]);
    await feed('input[data-role="flowjo-workspace-fcs"]', [fcs("D2.fcs", 13), fcs("copy.fcs", 13), fcs("D1.fcs", 1)]);
    const strategyRow = [...openDialog().querySelectorAll<HTMLElement>(".gl-wsp-row")].find((r) => r.textContent?.includes("D2.fcs"))!;
    await act(async () => { strategyRow.click(); });
    await settle();
    const perFile = [...openDialog().querySelectorAll<HTMLLabelElement>("label")]
      .find((l) => l.textContent?.includes("One hierarchy per file"))!.querySelector<HTMLInputElement>("input")!;
    if (perFile.checked) { await act(async () => { perFile.click(); }); await settle(); }
    expect(perFile.checked).toBe(false);
    await importFromDialog();
    expect((await countsOf("D2.fcs")).CD4_positive).toBe(1);
    expect((await countsOf("copy.fcs")).CD4_positive).toBe(1);
    // D1.fcs follows D2's tree by choice and carries no matrix: it cannot be compensated, and the
    // result says so rather than "FCS compensation enabled" for all of them.
    expect(hint()).toMatch(/D1\.fcs[^|]*not compensated/);
  });
});
