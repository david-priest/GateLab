// @vitest-environment jsdom
//
// Every FCS file gets the gating tree of the workspace sample that IS that file. A name only
// nominates a sample; the acquisition keywords FlowJo recorded for it ($TOT, $DATE, $BTIM, $ETIM,
// GUID) decide. These are the App-level paths the audit of 2026-09-24 found giving a file another
// sample's tree: the open dialog listing one sample's trees and importing another's, a same-named
// sample of another experiment imported silently, the first of two same-named samples taken, and a
// gated twin taking the file of an ungated sample. Synthetic names, identities and gates only.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
// The first byte of a file picks the acquisition it is, so two files of one name can differ.
const IDENTITY: Record<number, Record<string, string>> = {
  1: { $TOT: "3", $BTIM: "10:00:00", $ETIM: "10:01:00", $DATE: "01-JAN-2024", GUID: "aaaaaaaa-0000-0000-0000-000000000001", $FIL: "Specimen_001_Tube_001.fcs" },
  2: { $TOT: "3", $BTIM: "15:30:00", $ETIM: "15:31:00", $DATE: "02-FEB-2024", GUID: "bbbbbbbb-0000-0000-0000-000000000002", $FIL: "Specimen_001_Tube_001.fcs" },
  3: { $TOT: "3", $BTIM: "08:00:00", $ETIM: "08:01:00", $DATE: "03-MAR-2024" },
  // Seed 1's acquisition, renamed on disk and carrying no $FIL.
  4: { $TOT: "3", $BTIM: "10:00:00", $ETIM: "10:01:00", $DATE: "01-JAN-2024" },
  // Seed 2's acquisition, saved under another sample's name; its $FIL is the one it was recorded as.
  5: { $TOT: "3", $BTIM: "15:30:00", $ETIM: "15:31:00", $DATE: "02-FEB-2024", GUID: "bbbbbbbb-0000-0000-0000-000000000002", $FIL: "18447.fcs" },
  // A FACSChorus recording of experiment E1, made during its first sort under that sort's gates.
  7: {
    BDCHORUSDATARECORD: JSON.stringify({
      RecordingInfo: { Name: "D1", AssociationId: "E1" },
      RecordingConfiguration: {
        StartRecordingTime: "2024-01-01T09:10:00", StopRecordingTime: "2024-01-01T09:12:00",
        AnalysisModel: { Gates: [chorusGate(350)] },
      },
    }),
  },
  // Seed 1's acquisition, recorded as D1.fcs.
  12: { $TOT: "3", $BTIM: "10:00:00", $ETIM: "10:01:00", $DATE: "01-JAN-2024", GUID: "aaaaaaaa-0000-0000-0000-000000000001", $FIL: "D1.fcs" },
  // Seed 1's acquisition, whose event data cannot be read.
  11: { $TOT: "3", $BTIM: "10:00:00", $ETIM: "10:01:00", $DATE: "01-JAN-2024", GUID: "aaaaaaaa-0000-0000-0000-000000000001", $FIL: "Specimen_001_Tube_001.fcs" },
};
const UNREADABLE = 11;
function syntheticFcs(seed: number): FcsFile {
  return {
    version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: { ...(IDENTITY[seed] ?? {}) },
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from([10, 20, 30]), Float32Array.from([100, 200, 300])],
    spillover: null,
  };
}
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return {
    ...actual,
    parseFcs: (buffer: ArrayBuffer) => {
      const seed = new Uint8Array(buffer)[0];
      if (seed === UNREADABLE) throw new Error("synthetic data segment cannot be read");
      return syntheticFcs(seed);
    },
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
const rect = (id: string, fscMax: number) => `<gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="${id}">
  <gating:dimension gating:min="0" gating:max="${fscMax}"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
  <gating:dimension gating:min="0" gating:max="1000"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
</gating:RectangleGate>`;
const pop = (name: string, id: string, max: number, inner = "") =>
  `<Population name="${name}" count="2"><Gate>${rect(id, max)}</Gate>${inner ? `<Subpopulations>${inner}</Subpopulations>` : ""}</Population>`;
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
async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
async function feed(selector: string, files: File[]): Promise<void> {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  for (let i = 0; i < 4; i++) await settle();
}
const dialog = () => host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]');
const treeSelect = () => dialog()?.querySelector<HTMLSelectElement>('select[aria-label="Tree to import"]') ?? null;
const importButton = () => [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Import")!;
async function importNow(): Promise<void> {
  await act(async () => { importButton().click(); });
  for (let i = 0; i < 8; i++) await settle();
  const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
  if (confirm) { await act(async () => { confirm.click(); }); for (let i = 0; i < 4; i++) await settle(); }
}
async function pick(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
}
const rows = () => [...dialog()!.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")];
const radioRow = () => [...dialog()!.querySelectorAll(".gl-wsp-row.is-strategy .gl-wsp-name")].map((e) => e.textContent);
const hint = () => [...host.querySelectorAll(".gl-hint")].map((el) => el.textContent).join(" | ");
const errorText = () => host.querySelector(".gl-error")?.textContent ?? "";
const page = () => host.textContent ?? "";
async function openWorkspace(text: string, fcs: File[]): Promise<void> {
  act(() => root.render(<App />));
  await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", text)]);
  expect(dialog()).not.toBeNull();
  if (fcs.length) await feed('input[data-role="flowjo-workspace-fcs"]', fcs);
}

describe("the open dialog lists, compares and imports one sample: the file's own", () => {
  // D1 carries more gates, the old default; only D2's file is supplied. D1's trees are the ones
  // the dialog used to list, and D2's second tree was imported for a user who chose "D1_beads".
  const W = wsp(
    sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("D1_lymphocytes", "a1", 25, pop("D1_CD4_positive", "a2", 22)) + pop("D1_beads", "a3", 15)),
    sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("D2_lymphocytes", "b1", 25) + pop("D2_monocytes", "b2", 12)),
  );

  it("selects the supplied file's sample and imports the tree chosen from its own list", async () => {
    await openWorkspace(W, [fileOf("D2.fcs", Uint8Array.from([2]))]);
    expect(radioRow()).toEqual(["D2.fcs"]);
    expect([...treeSelect()!.options].map((o) => o.textContent)).toEqual(["D2_lymphocytes — 1 gates", "D2_monocytes — 1 gates"]);
    await pick(treeSelect()!, "1");
    await importNow();
    expect(hint()).toContain('tree "D2_monocytes", 2 of 2');
    expect(page()).not.toContain("D1_beads");
  });

  it("imports another sample's tree onto the file only when chosen, and says so", async () => {
    await openWorkspace(W, [fileOf("D2.fcs", Uint8Array.from([2]))]);
    // The user chooses D1's row: its FCS is not there, so nothing can be imported yet.
    await act(async () => { rows()[0].click(); });
    await settle();
    expect(radioRow()).toEqual(["D1.fcs"]);
    expect([...treeSelect()!.options].map((o) => o.textContent)).toEqual(["D1_lymphocytes — 2 gates", "D1_beads — 1 gates"]);
    await pick(treeSelect()!, "1");
    expect(importButton().disabled).toBe(true);
    // Choosing, by name, to apply D1's tree to D2.fcs.
    const cross = dialog()!.querySelector<HTMLSelectElement>('select[aria-label="Apply this sample\'s tree to another file"]')!;
    await pick(cross, [...cross.options].find((o) => o.textContent === "D2.fcs")!.value);
    expect(dialog()!.textContent).toContain("\"D1.fcs\"'s tree will be imported onto D2.fcs, which is not that sample.");
    expect(importButton().disabled).toBe(false);
    await importNow();
    expect(hint()).toContain('tree "D1_beads", 2 of 2');
    expect(hint()).toContain("D1.fcs's tree \"D1_beads\" applied to D2.fcs by choice");
  });
});

describe("the open dialog, two samples of one name", () => {
  const twoExperiments = (second = pop("D2_lymphocytes", "b1", 12)) => wsp(
    sample("Specimen_001_Tube_001.fcs", "Specimen_001_Tube_001.fcs", IDENTITY[1], pop("D1_lymphocytes", "a1", 25), "Experiment 1"),
    sample("Specimen_001_Tube_001.fcs", "Specimen_001_Tube_001.fcs", IDENTITY[2], second, "Experiment 2"),
  );

  it("gives the file to the sample its keywords confirm, not the first in document order", async () => {
    // The file is experiment 2's acquisition.
    await openWorkspace(twoExperiments(), [fileOf("Specimen_001_Tube_001.fcs", Uint8Array.from([2]))]);
    const [first, second] = rows().map((r) => r.textContent ?? "");
    expect(first).toMatch(/Specimen_001_Tube_001\.fcs is named like it but is another acquisition \(the sample records \$DATE 01-JAN-2024, \$BTIM 10:00:00.*\), so it is not paired/);
    expect(second).toContain("found: Specimen_001_Tube_001.fcs · confirmed by");
    expect(radioRow()).toEqual(["Specimen_001_Tube_001.fcsposition 2"]);
    await importNow();
    expect(page()).toContain("D2_lymphocytes");
    expect(page()).not.toContain("D1_lymphocytes");
  });

  it("asks which sample the file is when one acquisition was added twice, and imports the one chosen", async () => {
    const W = wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("D1_lymphocytes", "a1", 25), "Group 1"),
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("D1_CD4_positive", "a2", 12), "Group 2"),
    );
    await openWorkspace(W, [fileOf("D1.fcs", Uint8Array.from([1]))]);
    expect(radioRow()).toEqual([]);
    expect(importButton().disabled).toBe(true);
    // The other sample of that name is named by its position, as its row is.
    expect(rows()[0].textContent).toContain("could be this sample or D1.fcs (position 2), and the keywords cannot tell");
    await act(async () => { rows()[1].click(); });
    await settle();
    expect(rows()[1].textContent).toContain("chosen as this sample");
    expect(importButton().disabled).toBe(false);
    await importNow();
    expect(page()).toContain("D1_CD4_positive");
    expect(page()).not.toContain("D1_lymphocytes");
  });

  it("gives each of two samples of one acquisition the file its row names, the file and then its copy", async () => {
    // Both samples record one acquisition, and D1.fcs and copy.fcs (found by its $FIL) are two
    // files of it. With D1.fcs chosen as sample 1, sample 2's row named copy.fcs, and choosing it
    // moved D1.fcs to sample 2: sample 1's tree went onto no file, and the copy was never given one.
    const W = wsp(
      sample("D1.fcs", "D1.fcs", { ...IDENTITY[1], $FIL: "D1.fcs" }, pop("D1_lymphocytes", "a1", 25), "Group 1"),
      sample("D1.fcs", "D1.fcs", { ...IDENTITY[1], $FIL: "D1.fcs" }, pop("D1_CD4_positive", "a2", 12), "Group 2"),
    );
    act(() => root.render(<App />));
    await feed('input[accept=".gatelab,.wsp,.cef"]', [fileOf("strategy.wsp", W)]);
    // Seed 12 is seed 1's acquisition with the $FIL the samples record.
    await feed('input[data-role="flowjo-workspace-fcs"]', [fileOf("D1.fcs", Uint8Array.from([12])), fileOf("copy.fcs", Uint8Array.from([12]))]);
    expect(rows()[0].textContent).toContain("choosing this row says D1.fcs is this one");
    await act(async () => { rows()[0].click(); });
    await settle();
    expect(rows()[0].textContent).toContain("found: D1.fcs · chosen as this sample");
    // The row names the copy, and choosing it answers the copy.
    expect(rows()[1].textContent).toMatch(/copy\.fcs could be this sample or D1\.fcs \(position 1\)/);
    await act(async () => { rows()[1].click(); });
    await settle();
    expect(rows()[0].textContent).toContain("found: D1.fcs · chosen as this sample");
    expect(rows()[1].textContent).toContain("found: copy.fcs · chosen as this sample");
    // Choosing a row again keeps its file, and chooses its tree.
    for (const i of [1, 0, 1]) {
      await act(async () => { rows()[i].click(); });
      await settle();
      expect(rows()[0].textContent).toContain("found: D1.fcs · chosen as this sample");
      expect(rows()[1].textContent).toContain("found: copy.fcs · chosen as this sample");
    }
  });
});

describe("the open dialog, a file that cannot be loaded", () => {
  // Two files of one name, each its own sample's acquisition; the first cannot be loaded. The
  // loaded entries were bound back to the files by name, in order, so the second file took the
  // first's sample: it got experiment 1's tree, and its own was dropped.
  it("gives a file that did load its own sample's tree, never the tree of a file that failed", async () => {
    await openWorkspace(wsp(
      sample("Specimen_001_Tube_001.fcs", "Specimen_001_Tube_001.fcs", IDENTITY[1], pop("D1_lymphocytes", "a1", 25), "Experiment 1"),
      sample("Specimen_001_Tube_001.fcs", "Specimen_001_Tube_001.fcs", IDENTITY[2], pop("D2_lymphocytes", "b1", 12), "Experiment 2"),
    ), [fileOf("Specimen_001_Tube_001.fcs", Uint8Array.from([UNREADABLE])), fileOf("Specimen_001_Tube_001.fcs", Uint8Array.from([2]))]);
    await importNow();
    expect(page()).toContain("D2_lymphocytes");
    expect(page()).not.toContain("D1_lymphocytes");
    // The file that could not be loaded is said with the import; the load error used to be cleared
    // as soon as the import was staged.
    expect(errorText()).toContain("Specimen_001_Tube_001.fcs could not be loaded, so no tree was imported onto it: synthetic data segment cannot be read");
    expect(hint()).toContain("1 note(s)");
  });
});

describe("the open dialog with \"One hierarchy per file\" cleared", () => {
  // Each file is its own sample. Clearing the option chooses one shared tree, and the other file
  // follows it: the result said only "applied to all 2 files", and now names it.
  it("names a file that is another sample and follows the chosen tree", async () => {
    await openWorkspace(wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
    ), [fileOf("D1.fcs", Uint8Array.from([1])), fileOf("D2.fcs", Uint8Array.from([2]))]);
    const perFileLabel = [...dialog()!.querySelectorAll<HTMLLabelElement>("label")]
      .find((l) => l.textContent?.includes("One hierarchy per file"))!;
    // What the option does: one tree for the workspace, each file keeping its own sample's gates.
    // It said each file's strategy went "into its own hierarchy", which no import has done since
    // the one-tree rule.
    expect(perFileLabel.textContent).not.toContain("into its own hierarchy");
    expect(perFileLabel.textContent).toContain("The workspace keeps one tree");
    const perFile = perFileLabel.querySelector<HTMLInputElement>("input")!;
    await act(async () => { perFile.click(); });
    await settle();
    expect(perFile.checked).toBe(false);
    await importNow();
    expect(hint()).toContain('following this tree by choice, though each is its own sample: D2.fcs (sample 2 "D2.fcs")');
  });
});

describe("a .wsp imported onto the viewed file, with other files of the workspace loaded", () => {
  /** Resolves to what the import dialog said, when it was shown. */
  async function loadAll(files: File[], viewed: string, text: string): Promise<string> {
    act(() => root.render(<App />));
    await feed('input[type=file][accept=".fcs"][multiple]', files);
    const row = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find((r) => r.textContent?.includes(viewed))!;
    await act(async () => { row.click(); });
    await settle();
    await feed('input[accept=".xml,.wsp,.cef"]', [fileOf("experiment.wsp", text)]);
    const said = [...host.querySelectorAll(".gl-modal")].map((m) => m.textContent ?? "").join(" | ");
    const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
    if (confirm) { await act(async () => { confirm.click(); }); for (let i = 0; i < 4; i++) await settle(); }
    return said;
  }

  // Three files loaded, two of them each their own sample; the viewed file is D2.fcs. The other
  // files used to follow D2's tree under "All 3 files", with nothing said.
  it("gives every other loaded file its own sample's tree, and names a file that has none", async () => {
    const said = await loadAll(
      [fileOf("D1.fcs", Uint8Array.from([1])), fileOf("D2.fcs", Uint8Array.from([2])), fileOf("D3.fcs", Uint8Array.from([3]))],
      "D2.fcs",
      wsp(
        sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("lymphocytes", "a1", 25)),
        sample("D2.fcs", "D2.fcs", IDENTITY[2], pop("lymphocytes", "a1", 12)),
        // Named like the third file, but another acquisition.
        sample("D3.fcs", "D3.fcs", IDENTITY[1], pop("lymphocytes", "a1", 20)),
      ),
    );
    // The dialog says what happens to each file, and does not offer "All 3 files" following one tree.
    expect(said).toContain("Each of these 2 files gets its own sample's tree: one tree for the workspace, tailored per file where they differ: D2.fcs, D1.fcs.");
    expect(said).not.toContain("Which files should be gated with it?");
    expect(hint()).toMatch(/Imported one tree, "[^"]*", from D2\.fcs for 3 files: 2 follow it, 1 tailored/);
    expect(hint()).toContain('following the tree without a tree of their own: D3.fcs (sample 3 "D3.fcs" records $DATE 01-JAN-2024');
    expect(hint()).not.toContain("applied to all 3 files");
  });

  // D2's acquisition saved as D1.fcs: the sample named D1.fcs records another acquisition, and the
  // file's $FIL is D2's. It was "No sample in this workspace is D1.fcs".
  it("finds a renamed file's sample by its $FIL when the sample of its name is another acquisition", async () => {
    await loadAll([fileOf("D1.fcs", Uint8Array.from([5]))], "D1.fcs", wsp(
      sample("D1.fcs", "D1.fcs", { ...IDENTITY[1], $FIL: "18445.fcs" }, pop("D1_lymphocytes", "a1", 25)),
      sample("D2.fcs", "D2.fcs", { ...IDENTITY[2], $FIL: "18447.fcs" }, pop("D2_lymphocytes", "b1", 12)),
    ));
    expect(host.querySelector('[aria-label="Choose a FlowJo sample"]')).toBeNull();
    expect(page()).toContain("D2_lymphocytes");
    expect(page()).not.toContain("D1_lymphocytes");
    expect(hint()).toContain('(matched on $FIL) · sample 1 "D1.fcs", named like the file, records another acquisition; the file\'s $FIL and keywords are sample 2 "D2.fcs"\'s');
  });
});

describe("a .wsp imported onto the loaded FCS", () => {
  async function loadThenImport(text: string, seed: number, name = "Specimen_001_Tube_001.fcs"): Promise<void> {
    act(() => root.render(<App />));
    await feed('input[type=file][accept=".fcs"][multiple]', [fileOf(name, Uint8Array.from([seed]))]);
    await feed('input[accept=".xml,.wsp,.cef"]', [fileOf("experiment.wsp", text)]);
  }
  const picker = () => host.querySelector<HTMLElement>('[aria-label="Choose a FlowJo sample"]');

  it("does not import a same-named sample whose keywords record another acquisition; it says why and asks", async () => {
    await loadThenImport(wsp(sample("Specimen_001_Tube_001.fcs", "Specimen_001_Tube_001.fcs", IDENTITY[1], pop("D1_lymphocytes", "a1", 25))), 2);
    expect(picker()).not.toBeNull();
    expect(picker()!.textContent).toContain('No sample in this workspace is "Specimen_001_Tube_001.fcs": sample 1 "Specimen_001_Tube_001.fcs" records $DATE 01-JAN-2024, $BTIM 10:00:00');
    expect(page()).not.toContain("D1_lymphocytes");
    // Chosen anyway, the row says whose tree goes onto which file, and so does the result.
    const row = picker()!.querySelector<HTMLButtonElement>(".gl-wsp-row")!;
    expect(row.textContent).toContain("Import Specimen_001_Tube_001.fcs's tree onto Specimen_001_Tube_001.fcs");
    await act(async () => { row.click(); });
    for (let i = 0; i < 6; i++) await settle();
    const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
    if (confirm) { await act(async () => { confirm.click(); }); for (let i = 0; i < 4; i++) await settle(); }
    expect(hint()).toContain("applied to Specimen_001_Tube_001.fcs by choice");
  });

  it("does not give the file a gated twin's tree when its own sample carries no gates", async () => {
    await loadThenImport(wsp(
      sample("Specimen_001_Tube_001.fcs", "Specimen_001_Tube_001.fcs", IDENTITY[1], pop("D1_lymphocytes", "a1", 25), "Experiment 1"),
      sample("Specimen_001_Tube_001.fcs", "Specimen_001_Tube_001.fcs", IDENTITY[2], "", "Experiment 2"),
    ), 2);
    expect(picker()).not.toBeNull();
    expect(picker()!.textContent).toContain('is sample 2 "Specimen_001_Tube_001.fcs" of this workspace, which carries no gates');
    expect(page()).not.toContain("D1_lymphocytes");
  });

  it("offers only the samples the file could be when two share its name, with what each records", async () => {
    await loadThenImport(wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("D1_lymphocytes", "a1", 25), "Group 1"),
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("D1_CD4_positive", "b1", 12), "Group 2"),
      sample("D3.fcs", "D3.fcs", IDENTITY[3], pop("D3_lymphocytes", "c1", 12)),
    ), 1, "D1.fcs");
    const offered = [...picker()!.querySelectorAll(".gl-wsp-row")].map((r) => r.textContent ?? "");
    expect(offered).toHaveLength(2);
    expect(offered.every((r) => r.includes("confirmed by $TOT, $DATE, $BTIM, $ETIM, GUID against D1.fcs"))).toBe(true);
    expect(picker()!.textContent).toContain("2 samples in this workspace could be \"D1.fcs\"");
  });

  // Choosing which of two samples the file is answers a question; it is not applying another
  // sample's tree to the file, which is what every row and the result used to say.
  it("says the file is the sample chosen among those it could be, not another sample's tree by choice", async () => {
    await loadThenImport(wsp(
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("D1_lymphocytes", "a1", 25), "Group 1"),
      sample("D1.fcs", "D1.fcs", IDENTITY[1], pop("D1_CD4_positive", "b1", 12), "Group 2"),
    ), 1, "D1.fcs");
    const rowsNow = [...picker()!.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")];
    expect(rowsNow[1].textContent).toContain("D1.fcs is D1.fcs: import its tree");
    expect(rowsNow[1].textContent).not.toContain("Import D1.fcs's tree onto");
    await act(async () => { rowsNow[1].click(); });
    for (let i = 0; i < 6; i++) await settle();
    const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
    if (confirm) { await act(async () => { confirm.click(); }); for (let i = 0; i < 4; i++) await settle(); }
    expect(page()).toContain("D1_CD4_positive");
    expect(hint()).toContain('D1.fcs chosen as sample 2 "D1.fcs"');
    expect(hint()).not.toContain("by choice");
  });

  it("still imports the file's own sample in one click", async () => {
    await loadThenImport(wsp(
      sample("Specimen_001_Tube_001.fcs", "Specimen_001_Tube_001.fcs", IDENTITY[1], pop("D1_lymphocytes", "a1", 25), "Experiment 1"),
      sample("Specimen_001_Tube_001.fcs", "Specimen_001_Tube_001.fcs", IDENTITY[2], pop("D2_lymphocytes", "b1", 12), "Experiment 2"),
    ), 2);
    for (let i = 0; i < 4; i++) await settle();
    const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
    if (confirm) { await act(async () => { confirm.click(); }); for (let i = 0; i < 4; i++) await settle(); }
    expect(picker()).toBeNull();
    expect(page()).toContain("D2_lymphocytes");
    expect(page()).not.toContain("D1_lymphocytes");
    expect(errorText()).toBe("");
  });
});

describe("a FACSDiva experiment imported onto the loaded FCS", () => {
  // Two tubes, each with its own tree; Tube_002's is the larger, which the old fallback took.
  const gate = (name: string) => `<gate fullname="All Events\\${name}" type="Region_Classifier">
    <name>${name}</name><parent>All Events</parent><num_events>2</num_events>
    <is_x_parameter_log>false</is_x_parameter_log><is_y_parameter_log>false</is_y_parameter_log>
    <is_x_parameter_scaled>false</is_x_parameter_scaled><is_y_parameter_scaled>false</is_y_parameter_scaled>
    <x_parameter_scale_value>0</x_parameter_scale_value><y_parameter_scale_value>0</y_parameter_scale_value>
    <region name="r" xparm="FSC-A" yparm="SSC-A" type="POLYGON_REGION"><points>
      <point x="5" y="50" /><point x="350" y="50" /><point x="350" y="400" /></points></region></gate>`;
  const all = `<gate fullname="All Events" type="EventSource_Classifier"><name>All Events</name><num_events>3</num_events></gate>`;
  const tube = (name: string, file: string, begin: string, end: string, gates: string) =>
    `<tube name="${name}"><data_filename>${file}</data_filename><data_begin_date>${begin}</data_begin_date>` +
    `<data_end_date>${end}</data_end_date><gates>${all}${gates}</gates></tube>`;
  const XML = `<bdfacs version="Version 9.1.2"><experiment name="Experiment 1"><specimen name="Specimen_001">
    ${tube("Tube_001", "Specimen_001_Tube_001.fcs", "2024-01-01T10:00:00", "2024-01-01T10:01:00", gate("D1_lymphocytes"))}
    ${tube("Tube_002", "Specimen_001_Tube_002.fcs", "2024-03-03T08:00:00", "2024-03-03T08:01:00", gate("D3_lymphocytes") + gate("D3_CD4_positive"))}
  </specimen></experiment></bdfacs>`;
  async function loadThenImport(name: string, seed: number): Promise<void> {
    act(() => root.render(<App />));
    await feed('input[type=file][accept=".fcs"][multiple]', [fileOf(name, Uint8Array.from([seed]))]);
    await feed('input[accept=".xml,.wsp,.cef"]', [fileOf("experiment.xml", XML)]);
    const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
    if (confirm) { await act(async () => { confirm.click(); }); for (let i = 0; i < 4; i++) await settle(); }
  }
  const picker = () => host.querySelector<HTMLElement>('[aria-label="Choose a FACSDiva gate tree"]');

  it("imports the tube the file IS", async () => {
    await loadThenImport("Specimen_001_Tube_001.fcs", 1);
    expect(picker()).toBeNull();
    expect(page()).toContain("D1_lymphocytes");
  });

  it("does not import another experiment's same-named tube; it says why and asks", async () => {
    // The loaded file is experiment 2's Specimen_001_Tube_001.fcs.
    await loadThenImport("Specimen_001_Tube_001.fcs", 2);
    expect(picker()).not.toBeNull();
    expect(picker()!.textContent).toContain('No tube of this experiment is "Specimen_001_Tube_001.fcs": tube "Tube_001" (Specimen_001_Tube_001.fcs) records $DATE');
    expect(page()).not.toContain("D1_lymphocytes");
    const row = [...picker()!.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")].find((b) => b.textContent?.includes("Tube_001"))!;
    expect(row.textContent).toContain("Import Tube_001's gates onto Specimen_001_Tube_001.fcs");
    // The tube's date and times as a file records them, not an ISO date-time printed twice.
    expect(row.textContent).toContain("the tube records $DATE 2024-01-01, $BTIM 10:00:00 and $ETIM 10:01:00; Specimen_001_Tube_001.fcs has 02-FEB-2024, 15:30:00 and 15:31:00");
    expect(picker()!.textContent).not.toMatch(/\d{4}-\d\d-\d\dT\d/);
    await act(async () => { row.click(); });
    for (let i = 0; i < 6; i++) await settle();
    const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
    if (confirm) { await act(async () => { confirm.click(); }); for (let i = 0; i < 4; i++) await settle(); }
    expect(hint()).toContain('tube "Tube_001" applied to Specimen_001_Tube_001.fcs by choice');
  });

  // Diva names tubes Tube_001 in every specimen; the picker labelled them identically.
  it("tells tubes of one name apart by their specimen", async () => {
    const two = XML.replace("</specimen>", `</specimen><specimen name="Specimen_002">${tube("Tube_001", "Specimen_002_Tube_001.fcs", "2024-05-05T09:00:00", "2024-05-05T09:01:00", gate("D5_lymphocytes"))}</specimen>`);
    act(() => root.render(<App />));
    await feed('input[type=file][accept=".fcs"][multiple]', [fileOf("Specimen_001_Tube_001.fcs", Uint8Array.from([2]))]);
    await feed('input[accept=".xml,.wsp,.cef"]', [fileOf("experiment.xml", two)]);
    const names = [...picker()!.querySelectorAll(".gl-wsp-name")].map((el) => el.textContent ?? "");
    expect(names).toEqual(["Specimen_001 / Tube_001tube", "Tube_002tube", "Specimen_002 / Tube_001tube"]);
  });

  it("finds a renamed file's tube by its acquisition times, not the largest tree", async () => {
    // D1.fcs carries Tube_001's times (seed 4), and no $FIL. The larger tree is Tube_002's.
    await loadThenImport("D1.fcs", 4);
    expect(picker()).toBeNull();
    expect(page()).toContain("D1_lymphocytes");
    expect(page()).not.toContain("D3_CD4_positive");
    expect(errorText()).toContain('"D1.fcs" is tube "Tube_001" (Specimen_001_Tube_001.fcs): its acquisition times are the tube\'s.');
    // The pairing note is shown, so it is counted with the converter's.
    expect(hint()).toContain("from FACSDiva experiment · Experiment 1 · Tube_001 · 1 note(s)");
  });
});

describe("a FACSChorus experiment imported onto the loaded FCS", () => {
  const parameter = (name: string) => ({ measurementId: name, fluorochrome: name, measurement: "A", scatter: name, scale: "Linear", numerator: null, denominator: null, parameterKind: "Scatter" });
  const gate = { gateId: "gate-1", gateKind: "Polygon", name: "CD4_positive", parentPopulationId: "0-1",
    parameters: [parameter("FSC"), parameter("SSC")], vertices: [{ x: 5, y: 50 }, { x: 350, y: 50 }, { x: 350, y: 400 }],
    children: [{ name: "CD4_positive", color: "0,0,255", populationId: "gate-1-1" }] };
  it("applies nothing to a file that is not a recording of the experiment until a tree is chosen for it", async () => {
    const { strToU8, zipSync } = await import("fflate");
    const cef = zipSync({
      "manifest.json": strToU8(JSON.stringify({ chorusVersion: "5.4.0" })),
      "experiment.json": strToU8(JSON.stringify({ experiment: { id: "E1", name: "experiment E1", panels: [{ id: "P1", name: "Panel 1", analysis: { gates: [gate], visualizationSettings: { analysisRValueMap: [] } } }] }, sortRecords: [] })),
    });
    act(() => root.render(<App />));
    await feed('input[type=file][accept=".fcs"][multiple]', [fileOf("D2.fcs", Uint8Array.from([2]))]);
    await feed('input[accept=".xml,.wsp,.cef"]', [fileOf("strategy.cef", cef as Uint8Array<ArrayBuffer>)]);
    // It used to be imported at once: "from FACSChorus experiment · experiment E1 · Current gates".
    expect(page()).not.toContain("Imported 1 gates");
    expect(page()).toContain("D2.fcs carries no FACSChorus record, so nothing shows these gates are its own.");
    const apply = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Apply the current gates to D2.fcs…")!;
    await act(async () => { apply.click(); });
    for (let i = 0; i < 6; i++) await settle();
    const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
    if (confirm) { await act(async () => { confirm.click(); }); for (let i = 0; i < 4; i++) await settle(); }
    expect(hint()).toContain("from FACSChorus experiment · experiment E1 · Current gates · applied to D2.fcs by choice: it is not a recording of this experiment");
  });
});

describe("a FACSChorus experiment imported onto one of its own recordings", () => {
  // The recording was made during Sort 1, under Sort 1's gates. Sort 2's snapshot, like the
  // current gates, is another tree; importing it onto the file used to read "Import snapshot…",
  // and the result "experiment E1 · Sort 2", as though it were the file's own gating.
  it("says a snapshot is not the tree the file was recorded under, and the result says it was a choice", async () => {
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
    act(() => root.render(<App />));
    await feed('input[type=file][accept=".fcs"][multiple]', [fileOf("D1.fcs", Uint8Array.from([7]))]);
    await feed('input[accept=".xml,.wsp,.cef"]', [fileOf("strategy.cef", cef as Uint8Array<ArrayBuffer>)]);
    expect(page()).toContain("D1.fcs was recorded under the same tree as Sort 1. It was recorded during Sort 1.");
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".gl-chorus-timeline-row button")].map((b) => b.textContent);
    expect(buttons).toContain("Import snapshot…");
    expect(buttons).toContain("Apply this snapshot to D1.fcs, recorded under another tree…");
    expect(buttons).toContain("Apply the current gates to D1.fcs, recorded under another tree…");
    const sort2 = [...host.querySelectorAll<HTMLButtonElement>(".gl-chorus-timeline-row button")]
      .find((b) => b.textContent === "Apply this snapshot to D1.fcs, recorded under another tree…")!;
    await act(async () => { sort2.click(); });
    for (let i = 0; i < 6; i++) await settle();
    const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
    if (confirm) { await act(async () => { confirm.click(); }); for (let i = 0; i < 4; i++) await settle(); }
    expect(hint()).toContain("· applied to D1.fcs by choice: it was recorded under another tree, during Sort 1 (the same as Sort 1)");
  });
});

describe("a Cytobank file with gates tailored per FCS file", () => {
  it("applies each file's tailored gates to that file only, and never as another gate of the tree", async () => {
    const { CYTOBANK_TAILORED } = await import("./engine/cytobankTailoring.fixture");
    act(() => root.render(<App />));
    await feed('input[type=file][accept=".fcs"][multiple]', [fileOf("D1.fcs", Uint8Array.from([1])), fileOf("D2.fcs", Uint8Array.from([2]))]);
    await feed('input[accept=".xml,.wsp,.cef"]', [fileOf("cytobank.xml", CYTOBANK_TAILORED)]);
    const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
    if (confirm) { await act(async () => { confirm.click(); }); for (let i = 0; i < 4; i++) await settle(); }
    // One gate: D2's tailored copy used to come in as a second "CD4_positive".
    expect(hint()).toMatch(/Imported 1 gates, 1 populations/);
    expect(hint()).toContain("Cytobank's tailored gates applied to the file they were tailored for: D2.fcs");
  });
});

describe("gathering a workspace's files from a folder", () => {
  // A file renamed on disk keeps the $FIL it was recorded as. The folder paths held only files
  // named like a sample ("0/2 found", "No FCS in ... matches"), though choosing the same file by
  // hand paired it with its sample by $FIL.
  const W = wsp(
    sample("D1.fcs", "D1.fcs", { ...IDENTITY[1], $FIL: "18445.fcs" }, pop("D1_lymphocytes", "a1", 25)),
    sample("D2.fcs", "D2.fcs", { ...IDENTITY[2], $FIL: "18447.fcs" }, pop("D2_lymphocytes", "b1", 12)),
  );
  const handle = (name: string, content: string | Uint8Array<ArrayBuffer>) =>
    ({ kind: "file", name, getFile: async () => fileOf(name, content) }) as unknown as FileSystemFileHandle;
  const folder = (entries: FileSystemFileHandle[]) => ({
    kind: "directory", name: "flow-data",
    async *values() { for (const e of entries) yield e; },
  }) as unknown as FileSystemDirectoryHandle;
  afterEach(async () => {
    (await import("./engine/fsAccess")).resetPickerLocation();
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  it("holds a renamed file from the chosen folder by its $FIL", async () => {
    const picked = folder([handle("renamed.fcs", Uint8Array.from([5])), handle("unrelated.fcs", Uint8Array.from([3]))]);
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: vi.fn(async () => picked) });
    await openWorkspace(W, []);
    const button = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Use the workspace's folder…")!;
    await act(async () => { button.click(); });
    for (let i = 0; i < 4; i++) await settle();
    expect(errorText()).not.toContain("No FCS in");
    expect(rows()[1].textContent).toContain("found: renamed.fcs");
    expect(dialog()!.textContent).not.toContain("unrelated.fcs");
  });

  it("holds it from the folder remembered for the workspace, too", async () => {
    const { rememberDirectory } = await import("./engine/fsAccess");
    rememberDirectory(folder([handle("strategy.wsp", W), handle("renamed.fcs", Uint8Array.from([5]))]));
    await openWorkspace(W, []);
    for (let i = 0; i < 4; i++) await settle();
    expect(rows()[1].textContent).toContain("found: renamed.fcs");
  });
});
