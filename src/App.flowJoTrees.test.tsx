// @vitest-environment jsdom
// Opening a FlowJo workspace whose sample holds several top-level trees. A workspace holds one
// tree, so the dialog asks which to import, imports that one, and names the rest in the result.
// It used to default to "every strategy, one hierarchy each", convert and parse every tree, and
// import only the first; a tree the converter could not read then failed the whole open, from a
// call nobody awaited, so the user saw nothing. Synthetic file, gate and population names.

import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
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

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const rect = (id: string, fscMax: number) => `<gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="${id}">
  <gating:dimension gating:min="0" gating:max="${fscMax}"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
  <gating:dimension gating:min="0" gating:max="1000"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
</gating:RectangleGate>`;
// Three trees: a gate, the complement of that gate carrying a stale copy of it, and a tree whose
// only gate is a kind the converter cannot read, so converting it alone throws.
const WSP = `<?xml version="1.0"?>
<Workspace><SampleList><Sample><DataSet uri="file:D1.fcs"/>
  <SampleNode name="D1.fcs" count="3"><Subpopulations>
    <Population name="CD4_positive" count="2"><Gate>${rect("g1", 25)}</Gate></Population>
    <NotNode name="CD4_negative" count="1"><Gate>${rect("stale", 15)}</Gate>
      <Dependents><Dependent name="CD4_positive"/></Dependents></NotNode>
    <Population name="Unreadable" count="1"><Gate><gating:FancyGate xmlns:gating="${G}"/></Gate></Population>
  </Subpopulations></SampleNode>
</Sample></SampleList></Workspace>`;

// The third tree converts to nothing -- a complement naming no population -- though it counts a
// gate: it can be chosen, and fails. A tree with no gate the importer can read is not offered.
const BROKEN = WSP.replace(/<Population name="Unreadable"[\s\S]*?<\/Population>/, `<NotNode name="Broken" count="1"><Dependents/></NotNode>`);

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
async function feed(selector: string, file: File | File[]): Promise<void> {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  Object.defineProperty(input, "files", { configurable: true, value: Array.isArray(file) ? file : [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle(); await settle(); await settle();
}
const dialog = () => host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]');
const treeSelect = () => dialog()!.querySelector<HTMLSelectElement>('select[aria-label="Tree to import"]');
async function openWorkspace(wsp = WSP, fcs: string[] = ["D1.fcs"]): Promise<void> {
  act(() => root.render(<App />));
  await feed('input[accept=".gatelab,.wsp,.cef"]', fileOf("strategy.wsp", wsp));
  expect(dialog()).not.toBeNull();
  await feed('input[data-role="flowjo-workspace-fcs"]', fcs.map((name) => fileOf(name, Uint8Array.from([1]))));
}
async function chooseTree(index: number): Promise<void> {
  const select = treeSelect()!;
  await act(async () => {
    select.value = String(index);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function importNow(): Promise<void> {
  const button = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Import")!;
  await act(async () => { button.click(); });
  for (let i = 0; i < 6; i++) await settle();
  // A confirmation, where the import still needs a decision.
  const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
  if (confirm) { await act(async () => { confirm.click(); }); await settle(); await settle(); }
}
const errorText = () => host.querySelector(".gl-error")?.textContent ?? "";
const treePicker = () => host.querySelector<HTMLElement>('[aria-label="Choose a gating tree"]');

describe("opening a FlowJo workspace whose sample holds several trees", () => {
  it("offers the trees, one to import, and no option that imports them all", async () => {
    await openWorkspace();
    const options = [...treeSelect()!.options].map((o) => o.textContent ?? "");
    expect(options).toHaveLength(3);
    expect(options[0]).toMatch(/^CD4_positive/);
    expect(treeSelect()!.value).toBe("0");
    expect(dialog()!.textContent).not.toMatch(/Every strategy/);
    expect(dialog()!.textContent).toMatch(/holds 3 trees, and a workspace holds one/);
  });

  it("imports the chosen tree, names the others, and shows what the conversion said", async () => {
    await openWorkspace();
    await chooseTree(1);
    await importNow();
    expect(dialog()).toBeNull();
    expect(host.textContent).toContain("CD4_negative");
    expect(host.textContent).toContain('tree "CD4_negative", 2 of 3; not imported, one tree per workspace: "CD4_positive", "Unreadable"');
    // The complement reads the current gate, and the stale copy it carries is reported. The
    // warning used to be cleared as soon as the import was staged.
    expect(errorText()).toMatch(/"CD4_negative" is the complement of "CD4_positive".*differs from the current one/);
  });

  it("imports the first tree by default, and a tree it cannot read does not fail the open", async () => {
    await openWorkspace();
    await importNow();
    expect(host.textContent).toContain('tree "CD4_positive", 1 of 3; not imported, one tree per workspace: "CD4_negative", "Unreadable"');
    expect(errorText()).toBe("");
  });

  it("shows why a chosen tree cannot be imported, instead of failing silently", async () => {
    await openWorkspace(BROKEN);
    await chooseTree(2);
    await importNow();
    expect(errorText()).toMatch(/The tree "Broken" could not be imported: .*names no population.*Choose another of the sample's 3 trees/);
    expect(host.textContent).not.toContain("not imported, one tree per workspace");
  });

  // The error said to choose another tree, but the open dialog had closed and the workspace was
  // left with All Events only: choosing again meant opening the workspace again. The sample's
  // trees are offered at once instead, the one that failed marked, and the files stay loaded.
  it("offers the other trees at once when the chosen one cannot be imported", async () => {
    await openWorkspace(BROKEN);
    await chooseTree(2);
    await importNow();
    const picker = treePicker();
    expect(picker).not.toBeNull();
    expect(picker!.textContent).toMatch(/The tree "Broken" could not be imported: .*names no population/);
    const rows = [...picker!.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")];
    expect(rows.map((row) => row.querySelector(".gl-wsp-name")!.textContent)).toEqual(["CD4_positive", "CD4_negative", "Broken"]);
    expect(rows.map((row) => row.disabled)).toEqual([false, false, true]);
    await act(async () => { rows[1].click(); });
    for (let i = 0; i < 6; i++) await settle();
    expect(treePicker()).toBeNull();
    // The tree that failed is said to have failed, not listed with the trees left out by the rule.
    expect(host.textContent).toContain('tree "CD4_negative", 2 of 3; not imported, one tree per workspace: "CD4_positive"; could not be imported: "Broken"');
    expect(errorText()).toMatch(/"CD4_negative" is the complement of "CD4_positive"/);
    expect(host.textContent).toContain("D1.fcs");
  });

  it("offers them too when the chosen tree converts but cannot be parsed against the file", async () => {
    // A gate on a channel the loaded file does not have: converted, then refused by the parser.
    const offChannel = rect("z1", 25).replace(/FSC-A/, "Z-A");
    await openWorkspace(WSP.replace(/<Population name="Unreadable"[\s\S]*?<\/Population>/, `<Population name="Elsewhere" count="1"><Gate>${offChannel}</Gate></Population>`));
    await chooseTree(2);
    await importNow();
    const picker = treePicker();
    expect(picker).not.toBeNull();
    expect(picker!.textContent).toMatch(/The tree "Elsewhere" could not be imported: [\s\S]*"Z-A"/);
    expect([...picker!.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")].map((row) => row.disabled)).toEqual([false, false, true]);
    // Cut short, the reason is offered in full in the picker, not in a header it hides.
    expect(picker!.textContent).not.toContain("in the header");
    expect(picker!.querySelector(".gl-modal-reason-full .gl-modal-reason-text")!.textContent).toContain('references channel(s) not present in the loaded data: "Z-A"');
  });

  // A reason naming every gate on a missing channel ran to thousands of characters, repeated in
  // full in the picker, which had no height limit: the other trees and Cancel went off screen.
  it("says a long reason briefly in the picker, which is bounded and scrolls", async () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      `<Population name="Elsewhere_${i}" count="1"><Gate>${rect(`z${i}`, 25).replace(/FSC-A/, `Missing_channel_${i}-A`)}</Gate></Population>`).join("");
    await openWorkspace(WSP.replace(/<Population name="Unreadable"[\s\S]*?<\/Population>/, `<Population name="Elsewhere" count="1"><Gate>${rect("zp", 25).replace(/FSC-A/, "Z-A")}</Gate><Subpopulations>${many}</Subpopulations></Population>`));
    await chooseTree(2);
    await importNow();
    const picker = treePicker()!;
    const reason = picker.querySelector<HTMLElement>(".gl-modal-reason")!;
    expect(errorText().length).toBeGreaterThan(1000);
    expect(reason.textContent!.length).toBeLessThan(400);
    expect(reason.getAttribute("title")!.length).toBeGreaterThan(1000);
    // The full reason is in the picker, folded: the header it pointed to cannot be read while the
    // picker is open, and clicking past the picker cancels it and clears the header.
    expect(picker.textContent).not.toContain("in the header");
    const full = picker.querySelector<HTMLDetailsElement>("details.gl-modal-reason-full")!;
    expect(full).not.toBeNull();
    expect(full.open).toBe(false);
    expect(full.querySelector(".gl-modal-reason-text")!.textContent).toBe(reason.getAttribute("title"));
    // The picker and its reason are bounded by the viewport, and scroll.
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.gl-wsp-picker \{[^}]*max-height: calc\(100vh - 32px\);[^}]*overflow-y: auto;/);
    expect(css).toMatch(/\.gl-modal-reason \{[^}]*max-height: 96px;[^}]*overflow-y: auto;/);
    expect(css).toMatch(/\.gl-modal-reason-text \{[^}]*max-height: 30vh;[^}]*overflow-y: auto;/);
    expect(picker.classList.contains("gl-wsp-picker")).toBe(true);
    expect([...picker.querySelectorAll("button")].some((b) => b.textContent === "Cancel")).toBe(true);
  });

  // A tree with no gate the importer can read is not offered at all: it used to be, and had to
  // fail once before it was disabled.
  it("keeps every tree that failed, and every tree with no readable gate, out of the choice", async () => {
    const fancy = (name: string) => `<Population name="${name}" count="1"><Gate><gating:FancyGate xmlns:gating="${G}"/></Gate></Population>`;
    await openWorkspace(BROKEN.replace(/<NotNode name="Broken"[\s\S]*?<\/NotNode>/, (m) => m + fancy("Unreadable_too")));
    await chooseTree(2);
    await importNow();
    const rowsOf = () => [...treePicker()!.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")];
    expect(treePicker()!.textContent).toMatch(/The tree "Broken" could not be imported/);
    expect(rowsOf().map((row) => row.disabled)).toEqual([false, false, true, true]);
    expect(rowsOf()[3].textContent).toContain("no gate GateLab can read");
    // A tree that can be imported still can, from the same picker.
    await act(async () => { rowsOf()[1].click(); });
    for (let i = 0; i < 6; i++) await settle();
    expect(treePicker()).toBeNull();
    expect(host.textContent).toContain('tree "CD4_negative", 2 of 4');
  });

  it("cancelling that choice cancels the open, as cancelling its import does", async () => {
    await openWorkspace(BROKEN);
    await chooseTree(2);
    await importNow();
    const cancel = [...treePicker()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Cancel")!;
    await act(async () => { cancel.click(); });
    await settle(); await settle();
    expect(treePicker()).toBeNull();
    expect(host.textContent).toContain("Workspace open cancelled; the file it loaded was removed again");
    // The error that asked for another tree is answered; it no longer stands beside the result.
    expect(errorText()).toBe("");
  });

  // Every tree failing leaves nothing to choose: the open ends as cancelling it would, and the
  // file it loaded no longer stays behind with All Events only.
  it("removes the file the open loaded when every tree fails", async () => {
    // One tree the converter converts to nothing, and one it reads on a channel the file does not have.
    const broken = `<NotNode name="Broken" count="1"><Dependents/></NotNode>`;
    const elsewhere = `<Population name="Elsewhere" count="1"><Gate>${rect("z1", 25).replace(/FSC-A/, "Z-A")}</Gate></Population>`;
    await openWorkspace(WSP.replace(/<Subpopulations>[\s\S]*<\/Subpopulations>/, `<Subpopulations>${broken + elsewhere}</Subpopulations>`));
    await importNow();
    const rowsOf = () => [...treePicker()!.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")];
    await act(async () => { rowsOf()[1].click(); });
    for (let i = 0; i < 6; i++) await settle();
    expect(treePicker()).toBeNull();
    expect(errorText()).toMatch(/None of the sample's 2 trees could be imported, so the workspace open was cancelled: the file it loaded was removed again\./);
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0);
  });

  // A tree chosen after the first failed was imported without the note naming the file the open
  // held that no sample is: the retry passed on only who the tree was applied to.
  it("keeps naming the files that follow the tree when another tree is chosen", async () => {
    await openWorkspace(BROKEN, ["D1.fcs", "D9.fcs"]);
    await chooseTree(2);
    await importNow();
    const rows = [...treePicker()!.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")];
    await act(async () => { rows[0].click(); });
    for (let i = 0; i < 6; i++) await settle();
    const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
    if (confirm) { await act(async () => { confirm.click(); }); for (let i = 0; i < 4; i++) await settle(); }
    expect(host.textContent).toContain('tree "CD4_positive", 1 of 3');
    expect(host.textContent).toContain("following the tree without a tree of their own: D9.fcs (no sample is named like it)");
  });

  // The dialog offered a tree with no gate the importer can read, and made it the default when it
  // came first: the import could only fail, once, before the retry picker disabled it.
  it("neither offers nor defaults to a tree with no readable gate", async () => {
    const fancy = `<Population name="Unreadable" count="1"><Gate><gating:FancyGate xmlns:gating="${G}"/></Gate></Population>`;
    const plain = `<Population name="CD4_positive" count="2"><Gate>${rect("g1", 25)}</Gate></Population>`;
    await openWorkspace(WSP.replace(/<Subpopulations>[\s\S]*<\/Subpopulations>/, `<Subpopulations>${fancy + plain}</Subpopulations>`));
    const options = [...treeSelect()!.options];
    expect(options.map((o) => o.disabled)).toEqual([true, false]);
    expect(options[0].textContent).toBe("Unreadable — no gate GateLab can read");
    expect(treeSelect()!.value).toBe("1");
    await importNow();
    expect(treePicker()).toBeNull();
    expect(host.textContent).toContain('tree "CD4_positive", 2 of 2; not imported, one tree per workspace: "Unreadable"');
  });

  // FR-FCM-Z2TL holds 71 trees, and the result line named all 70 not imported: 2,225 characters.
  it("names a few of the trees not imported and counts the rest", async () => {
    const trees = Array.from({ length: 9 }, (_, i) => `<Population name="Tree_${i + 1}" count="2"><Gate>${rect(`t${i}`, 25)}</Gate></Population>`).join("");
    await openWorkspace(WSP.replace(/<Subpopulations>[\s\S]*<\/Subpopulations>/, `<Subpopulations>${trees}</Subpopulations>`));
    await importNow();
    expect(host.textContent).toContain('tree "Tree_1", 1 of 9; not imported, one tree per workspace: "Tree_2", "Tree_3", "Tree_4", "Tree_5", "Tree_6" and 3 more');
    expect(host.textContent).not.toContain('"Tree_7"');
  });

  // A workspace imported onto a loaded file it does not name goes through the sample picker. A
  // sample with several trees then merged them into one strategy, with a warning to choose one
  // and no way to; it now asks which tree, as a sample matched by name does.
  it("asks which tree when the sample is picked by hand", async () => {
    act(() => root.render(<App />));
    await feed('input[type=file][accept=".fcs"][multiple]', fileOf("D2.fcs", Uint8Array.from([1])));
    await feed('input[accept=".xml,.wsp,.cef"]', fileOf("strategy.wsp", WSP));
    const picker = host.querySelector<HTMLElement>('[aria-label="Choose a FlowJo sample"]')!;
    await act(async () => { picker.querySelector<HTMLButtonElement>(".gl-wsp-row")!.click(); });
    await settle();
    const trees = host.querySelector<HTMLElement>('[aria-label="Choose a gating tree"]');
    expect(trees).not.toBeNull();
    expect([...trees!.querySelectorAll(".gl-wsp-name")].map((el) => el.textContent)).toEqual(["CD4_positive", "CD4_negative", "Unreadable"]);
  });
});

// A sample holding a small tree of bead gates first and the analysis beside it (FR-FCM-Z6L9:
// "beads", 2 gates, and "Lymphocytes", 23): the open imported the first, and the choice sat below
// the grid option's notes, where the release candidate's browser verifier did not find it.
const QC_FIRST = `<?xml version="1.0"?>
<Workspace><SampleList><Sample><DataSet uri="file:D1.fcs"/>
  <SampleNode name="D1.fcs" count="3"><Subpopulations>
    <Population name="beads" count="1"><Gate>${rect("b1", 15)}</Gate></Population>
    <Population name="Lymphocytes" count="2"><Gate>${rect("l1", 25)}</Gate><Subpopulations>
      <Population name="Single Cells" count="2"><Gate>${rect("l2", 25)}</Gate></Population>
    </Subpopulations></Population>
  </Subpopulations></SampleNode>
</Sample></SampleList></Workspace>`;

describe("opening a FlowJo workspace whose sample holds a small tree before its analysis", () => {
  it("defaults to the tree with the most gates, and offers the choice beside the sample list", async () => {
    await openWorkspace(QC_FIRST);
    const select = treeSelect()!;
    expect([...select.options].map((o) => o.textContent)).toEqual(["beads — 1 gates", "Lymphocytes — 2 gates"]);
    expect(select.value).toBe("1");
    // Next to the sample it belongs to, before the grid option and its notes.
    const list = dialog()!.querySelector(".gl-wsp-list")!;
    const grid = [...dialog()!.querySelectorAll("label")].find((l) => l.textContent?.includes("Evaluate gates as FlowJo does"))!;
    expect(grid).toBeTruthy();
    expect(list.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(select.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await importNow();
    expect(host.textContent).toContain('tree "Lymphocytes", 2 of 2; not imported, one tree per workspace: "beads"');
  });
});

// "One hierarchy per file", three files found: D1 the tree, D2 the same gates with one tailored
// and a gate the converter skips, D3 a strategy the converter cannot read. Each file holds two
// top-level trees, which go in together per file. Synthetic file and population names.
describe("opening a FlowJo workspace one hierarchy per file", () => {
  const sampleOf = (file: string, populations: string) =>
    `<Sample><DataSet uri="file:${file}"/><SampleNode name="${file}" count="3"><Subpopulations>${populations}</Subpopulations></SampleNode></Sample>`;
  const pop = (name: string, id: string, fscMax: number) =>
    `<Population name="${name}" count="2"><Gate>${rect(id, fscMax)}</Gate></Population>`;
  const PER_FILE = `<?xml version="1.0"?>
<Workspace><SampleList>
  ${sampleOf("D1.fcs", pop("CD4_positive", "g1", 25) + pop("CD8_positive", "g2", 15))}
  ${sampleOf("D2.fcs", pop("CD4_positive", "g1", 22) + pop("CD8_positive", "g2", 15) +
    `<Population name="Unreadable" count="1"><Gate><gating:FancyGate xmlns:gating="${G}"/></Gate></Population>`)}
  ${sampleOf("D3.fcs", `<NotNode name="Nothing_negative" count="1"><Dependents/></NotNode>`)}
</SampleList></Workspace>`;

  it("counts the file it could not read with the files that follow the tree, as the tree does", async () => {
    await openWorkspace(PER_FILE, ["D1.fcs", "D2.fcs", "D3.fcs"]);
    await importNow();
    expect(host.textContent).toMatch(/Imported one tree, "[^"]*", from D1\.fcs for 3 files: 2 follow it, 1 tailored\. D3\.fcs follows it without tailoring: its strategy could not be read\./);
    expect(host.textContent).toContain("3 files · 1 tailored");
  });

  it("shows every file's notes under its name, and says what can be done about the merged trees", async () => {
    await openWorkspace(PER_FILE, ["D1.fcs", "D2.fcs", "D3.fcs"]);
    await importNow();
    const said = errorText();
    expect(said).toContain('D1.fcs: "D1.fcs" holds 2 independent gating trees and all were imported together, which merges strategies that FlowJo kept apart. To import one of them alone, open the workspace again with "One hierarchy per file" cleared and choose that tree.');
    expect(said).toMatch(/D2\.fcs: "Unreadable" uses FancyGate, which this importer does not read yet; .* "D2\.fcs" holds 2 independent gating trees/);
    expect(said).toMatch(/D3\.fcs: its strategy could not be read, so it follows the imported tree without tailoring\. .*has no gates this importer can read/);
    // No choice exists under a per-file import, so the warning no longer asks for one.
    expect(said).not.toContain("Choose one to import it alone");
    // Every note shown is counted: D1's one, D2's two, and the note that D3 could not be read.
    // The files are counted once, in the result: "for 3 files" beside "one hierarchy per file, 3
    // files" disagreed whenever a file followed with no tree of its own.
    expect(host.textContent).toMatch(/one hierarchy per file · 4 note\(s\)/);
    // One line per file's notes, in a box of its own, not one run of text.
    const lines = [...host.querySelectorAll(".gl-error .gl-error-line")].map((l) => l.textContent ?? "");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^⚠ D1\.fcs: /);
    expect(lines[1]).toMatch(/D2\.fcs: /);
    expect(lines[2]).toMatch(/D3\.fcs: its strategy could not be read/);
  });
});

// A workspace refused when it is opened leaves no progress line behind: the FlowJo 7 refusal
// (d63b36f) showed its error while the status line still said "Opening T7.wsp · reading workspace",
// in English and Japanese, ten seconds on (the release candidate's browser verifier).
describe("a workspace refused when it is opened", () => {
  const FLOWJO_7 = `<?xml version="1.0"?>
<Workspace flowJoVersion="7.6.2" xmlns:gating="http://www.isac-net.org/std/Gating-ML/v1.5/gating" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v1.5/datatypes"><SampleList><Sample><DataSet uri="file:D1.fcs"/>
  <SampleNode name="D1.fcs" count="3"><Subpopulations>
    <Population name="CD4_positive" count="2"><Gate><gating:RectangleGate gating:id="g1">
      <gating:dimension gating:min="0" gating:max="25"><data-type:parameter data-type:name="FSC-A"/></gating:dimension>
    </gating:RectangleGate></Gate></Population>
  </Subpopulations></SampleNode>
</Sample></SampleList></Workspace>`;

  it("says why, and clears the line that said it was being read", async () => {
    act(() => root.render(<App />));
    await feed('input[accept=".gatelab,.wsp,.cef"]', fileOf("T7.wsp", FLOWJO_7));
    expect(dialog()).toBeNull();
    expect(errorText()).toContain("This workspace was saved by FlowJo 7.6.2");
    expect(host.textContent).not.toContain("reading workspace");
  });

  it("clears it for a file that is no workspace at all", async () => {
    act(() => root.render(<App />));
    await feed('input[accept=".gatelab,.wsp,.cef"]', fileOf("empty.wsp", "<Workspace/>"));
    expect(errorText()).toContain('"empty.wsp" is not a FlowJo workspace GateLab can read.');
    expect(host.textContent).not.toContain("reading workspace");
  });
});
