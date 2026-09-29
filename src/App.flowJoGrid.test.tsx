// @vitest-environment jsdom
// "Evaluate gates as FlowJo does" in the dialog that opens a FlowJo workspace: on at every open,
// and the answer holds for the whole import -- every file of a per-file import, and a tree chosen
// again after the first could not be imported. A workspace imported onto the loaded files from the
// Import menu is asked it in its import dialog, on by default, and changing it there reads the
// workspace again. The result line says which way the gates were evaluated. Synthetic file, gate
// and population names.

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
  columns: [Float32Array.from([10000, 20000, 30000]), Float32Array.from([10000, 20000, 30000])],
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
import { I18nProvider, hasUiTranslation, translateUi } from "./ui/i18n";
import { FLOWJO_GRID_GATELAB_POLYGONS, FLOWJO_GRID_NOT_COVERED, FLOWJO_GRID_OFF_NOTE } from "./ui/FlowJoGridOption";
import { Sample } from "./engine/sample";
import { exportFlowJoWorkspace } from "./engine/flowjoExport";
import { linkChildToParent, newGate, newGateRef, newPopulation, newRootPopulation } from "./engine/models";

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";
const polygon = (id: string) => `<gating:PolygonGate xmlns:gating="${G}" xmlns:data-type="${D}" quadId="-1" gateResolution="256" gating:id="${id}">
  <gating:dimension><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
  <gating:dimension><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
  <gating:vertex><gating:coordinate data-type:value="5000"/><gating:coordinate data-type:value="5000"/></gating:vertex>
  <gating:vertex><gating:coordinate data-type:value="40000"/><gating:coordinate data-type:value="5000"/></gating:vertex>
  <gating:vertex><gating:coordinate data-type:value="40000"/><gating:coordinate data-type:value="40000"/></gating:vertex>
</gating:PolygonGate>`;
const transforms = `<Transformations>
  <transforms:linear xmlns:transforms="${T}" xmlns:data-type="${D}" transforms:minRange="0" transforms:maxRange="262144" transforms:gain="1"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
  <transforms:linear xmlns:transforms="${T}" xmlns:data-type="${D}" transforms:minRange="0" transforms:maxRange="262144" transforms:gain="1"><data-type:parameter data-type:name="SSC-A"/></transforms:linear>
</Transformations>`;
const sampleOf = (file: string, populations: string) =>
  `<Sample><DataSet uri="file:${file}"/>${transforms}<SampleNode name="${file}" count="3"><Subpopulations>${populations}</Subpopulations></SampleNode></Sample>`;
const pop = (name: string, id: string) => `<Population name="${name}" count="2"><Gate>${polygon(id)}</Gate></Population>`;
// A tree the sample list offers (it names a population to negate) whose import fails: it names none.
const unreadable = `<NotNode name="Broken" count="1"><Dependents/></NotNode>`;

// One file, three trees: two polygons and one the import cannot build.
const WSP = `<?xml version="1.0"?><Workspace><SampleList>${sampleOf("D1.fcs", pop("CD4_positive", "g1") + pop("CD8_positive", "g2") + unreadable)}</SampleList></Workspace>`;
// Two files, each its own tree.
const PER_FILE = `<?xml version="1.0"?><Workspace><SampleList>
  ${sampleOf("D1.fcs", pop("CD4_positive", "g1"))}
  ${sampleOf("D2.fcs", pop("CD4_positive", "g1").replace('value="40000"/><gating:coordinate data-type:value="40000"', 'value="45000"/><gating:coordinate data-type:value="45000"'))}
</SampleList></Workspace>`;

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
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
const option = () => dialog()!.querySelector<HTMLInputElement>('input[aria-label="Evaluate gates as FlowJo does"]');
async function openWorkspace(wsp = WSP, fcs: string[] = ["D1.fcs"]): Promise<void> {
  act(() => root.render(<App />));
  await feed('input[accept=".gatelab,.wsp,.cef"]', fileOf("strategy.wsp", wsp));
  expect(dialog()).not.toBeNull();
  await feed('input[data-role="flowjo-workspace-fcs"]', fcs.map((name) => fileOf(name, Uint8Array.from([1]))));
}
async function setOption(on: boolean): Promise<void> {
  const box = option()!;
  if (box.checked === on) return;
  await act(async () => { box.click(); });
}
async function chooseTree(index: number): Promise<void> {
  const select = dialog()!.querySelector<HTMLSelectElement>('select[aria-label="Tree to import"]')!;
  await act(async () => {
    select.value = String(index);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function importNow(): Promise<void> {
  const button = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Import")!;
  await act(async () => { button.click(); });
  for (let i = 0; i < 6; i++) await settle();
  const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
  if (confirm) { await act(async () => { confirm.click(); }); await settle(); await settle(); }
}
const treePicker = () => host.querySelector<HTMLElement>('[aria-label="Choose a gating tree"]');

describe("Evaluate gates as FlowJo does, in the FlowJo workspace dialog", () => {
  it("is offered on by default, and says what it does, what off means and what it does not cover", async () => {
    await openWorkspace();
    expect(option()).not.toBeNull();
    expect(option()!.checked).toBe(true);
    const text = dialog()!.textContent ?? "";
    expect(text).toContain("(polygons on FlowJo's 256-channel grid, rectangles clamped to the axis)");
    expect(text).toContain("Off: every gate is evaluated continuously on the geometry it was drawn with, as FlowKit and Cytobank evaluate gates. Biex axes are read on FlowJo's own table either way; FlowKit's differs from it where the width basis lies between −1 and −3.16.");
    expect(text).toContain("Either way, FlowJo's rule is not established for these, which are evaluated continuously: ellipses, curly quadrants, and polygons with no gate resolution or on a Time, FlowJo ArcSinh, Logicle or gained linear axis.");
    expect(text).toContain("A rectangle is not clamped on a Time, gained or compensated linear axis, and one lying wholly beyond where FlowJo clamps is counted as drawn.");
    expect(text).toContain("A polygon with a gate resolution other than 256 is put on a grid of that many channels, which has not been measured.");
  });

  // The notes are text to read: inside the checkbox's label, a click anywhere on six lines of them
  // toggled the option. The list of what either way leaves continuous is folded away, since it
  // pushed the Import button below the fold on a screen 700 pixels tall.
  it("toggles only on the checkbox and its name, and folds the list of what it leaves continuous", async () => {
    await openWorkspace();
    const label = option()!.closest("label")!;
    expect(label.textContent).not.toContain("Off:");
    expect(label.textContent).not.toContain("Either way");
    const note = [...dialog()!.querySelectorAll<HTMLElement>(".gl-modal-note")].find((el) => el.textContent?.startsWith("Off:"))!;
    await act(async () => { note.click(); });
    expect(option()!.checked).toBe(true);
    const details = dialog()!.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("What either way leaves continuous");
    expect(details.textContent).toContain(FLOWJO_GRID_NOT_COVERED);
    expect(details.textContent).toContain(FLOWJO_GRID_GATELAB_POLYGONS);
  });

  it("says which way the gates were read in Japanese too", async () => {
    window.localStorage.setItem("gatelab.uiLanguage", "ja");
    act(() => root.render(<I18nProvider><App /></I18nProvider>));
    await feed('input[accept=".gatelab,.wsp,.cef"]', fileOf("strategy.wsp", WSP));
    await feed('input[data-role="flowjo-workspace-fcs"]', fileOf("D1.fcs", Uint8Array.from([1])));
    const ja = (text: string) => translateUi("ja", text);
    const opened = host.querySelector<HTMLElement>(`[aria-label="${ja("Open a FlowJo workspace")}"]`)!;
    expect(opened.querySelector<HTMLInputElement>(`input[aria-label="${ja("Evaluate gates as FlowJo does")}"]`)!.checked).toBe(true);
    const button = [...opened.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === ja("Import"))!;
    await act(async () => { button.click(); });
    for (let i = 0; i < 6; i++) await settle();
    expect(host.textContent).toContain("FlowJoと同じ方法で評価（1個のポリゴンをFlowJoのグリッド上で評価）");
    expect(host.textContent).not.toContain("evaluated as FlowJo does");
  });

  // The importer's notes this option brings were written in English whatever the language: a
  // polygon it leaves continuous, and one whose resolution is not 256, are named in Japanese.
  it("gives the importer's notes on FlowJo's grid in Japanese too", async () => {
    window.localStorage.setItem("gatelab.uiLanguage", "ja");
    const unresolved = pop("CD4_positive", "g1").replace(' gateResolution="256"', "");
    const coarse = pop("CD8_positive", "g2").replace('gateResolution="256"', 'gateResolution="128"');
    act(() => root.render(<I18nProvider><App /></I18nProvider>));
    // One tree: the second polygon beneath the first.
    const tree = unresolved.replace(/<\/Population>$/, `<Subpopulations>${coarse}</Subpopulations></Population>`);
    await feed('input[accept=".gatelab,.wsp,.cef"]', fileOf("strategy.wsp", `<?xml version="1.0"?><Workspace><SampleList>${sampleOf("D1.fcs", tree)}</SampleList></Workspace>`));
    await feed('input[data-role="flowjo-workspace-fcs"]', fileOf("D1.fcs", Uint8Array.from([1])));
    const ja = (text: string) => translateUi("ja", text);
    const opened = host.querySelector<HTMLElement>(`[aria-label="${ja("Open a FlowJo workspace")}"]`)!;
    // The off note names FlowJo's width basis in Japanese as well.
    expect(opened.textContent).toContain("幅の基準値が−1から−3.16の間にある場合");
    expect(opened.textContent).not.toContain("width basis");
    const button = [...opened.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === ja("Import"))!;
    await act(async () => { button.click(); });
    for (let i = 0; i < 6; i++) await settle();
    const text = host.textContent ?? "";
    expect(text).toContain("1個のポリゴンは、FlowJoの規則が確立されていないため、FlowJoのグリッドではなく連続的に評価されます。そのため、境界付近のイベントの分だけFlowJoの数と異なることがあります：「CD4_positive」はゲート解像度を宣言していません。");
    expect(text).toContain("1個のポリゴンが256以外のゲート解像度を宣言しており、そのチャンネル数のグリッドに置かれます。測定したFlowJoのポリゴンはすべて256を宣言しているため、他の解像度での数はFlowJoの数と比較されていません：「CD8_positive」（128）。");
    expect(text).not.toContain("evaluated continuously rather than on FlowJo's grid");
    expect(text).not.toContain("declare a gate resolution other than 256");
  });

  // A polygon GateLab wrote comes back as GateLab held it whichever way the option is set, and the
  // result line says how many did, so an "on" import that grids none of them is not a surprise.
  it("says how many polygons GateLab wrote came back as GateLab held them", async () => {
    const sample = new Sample(syntheticFcs);
    const gate = newGate("CD4_positive", "polygon", "FSC-A", "SSC-A", [[5000, 5000], [40000, 5000], [40000, 40000]]);
    const rootPop = newRootPopulation();
    const child = newPopulation("CD4_positive", [newGateRef(gate.gate_id, true)], rootPop.population_id, "and");
    const populations = linkChildToParent({ [rootPop.population_id]: rootPop, [child.population_id]: child }, child.population_id, rootPop.population_id);
    const { xml } = exportFlowJoWorkspace({
      samples: [{ sample, fileName: "D1.fcs", gates: { [gate.gate_id]: gate }, gate_order: [gate.gate_id], populations, root_population_id: rootPop.population_id }],
      now: new Date("2026-09-25T00:00:00Z"),
    });
    await openWorkspace(xml);
    expect(option()!.checked).toBe(true);
    await importNow();
    expect(host.textContent).toContain("evaluated as FlowJo does (0 polygon(s) on FlowJo's grid) · 1 polygon(s) GateLab wrote read as GateLab held them");
  });

  it("imports the polygons onto FlowJo's grid when on, and says so", async () => {
    await openWorkspace();
    await importNow();
    expect(host.textContent).toContain("evaluated as FlowJo does (1 polygon(s) on FlowJo's grid)");
  });

  it("imports them continuously when off, and says so", async () => {
    await openWorkspace();
    await setOption(false);
    await importNow();
    expect(host.textContent).toContain("evaluated continuously, not on FlowJo's grid");
    expect(host.textContent).not.toContain("on FlowJo's grid)");
  });

  it("keeps the answer for a tree chosen again after the first could not be imported", async () => {
    await openWorkspace();
    await setOption(false);
    await chooseTree(2);
    await importNow();
    const rows = [...treePicker()!.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")];
    await act(async () => { rows[1].click(); });
    for (let i = 0; i < 6; i++) await settle();
    expect(treePicker()).toBeNull();
    expect(host.textContent).toContain('tree "CD8_positive", 2 of 3');
    expect(host.textContent).toContain("evaluated continuously, not on FlowJo's grid");
  });

  it("applies it to every file of a per-file import", async () => {
    await openWorkspace(PER_FILE, ["D1.fcs", "D2.fcs"]);
    expect(option()!.checked).toBe(true);
    await importNow();
    // D1's polygon and D2's, each on FlowJo's grid.
    expect(host.textContent).toContain("evaluated as FlowJo does (2 polygon(s) on FlowJo's grid)");
  });

  it("applies it off to every file of a per-file import too", async () => {
    await openWorkspace(PER_FILE, ["D1.fcs", "D2.fcs"]);
    await setOption(false);
    await importNow();
    expect(host.textContent).toContain("evaluated continuously, not on FlowJo's grid");
  });

  it("has its text in Japanese too", () => {
    for (const text of [
      "Evaluate gates as FlowJo does",
      "(polygons on FlowJo's 256-channel grid, rectangles clamped to the axis)",
      FLOWJO_GRID_OFF_NOTE,
      FLOWJO_GRID_NOT_COVERED,
      FLOWJO_GRID_GATELAB_POLYGONS,
      "What either way leaves continuous",
      "evaluated as FlowJo does ({count} polygon(s) on FlowJo's grid)",
      "evaluated continuously, not on FlowJo's grid",
      "{count} polygon(s) GateLab wrote read as GateLab held them",
      // The importer's notes (flowjoWorkspace.ts), each template and each part it is built from.
      "\"{name}\" lies wholly below {where} on {channel} ({bound}). FlowJo places every event below it there, so by FlowJo's rule this gate holds none; GateLab tests the recorded values, and counts the events that fall inside its drawn bounds.",
      "\"{name}\" lies wholly beyond the {channel} axis range ({min} to {max}). FlowJo places every event beyond the range on the axis edge, so it counts none inside this gate; GateLab tests the recorded values, and counts the events that fall inside its drawn bounds.",
      "the bottom of FlowJo's biex table",
      "the log axis's offset",
      "{count} polygon(s) declare a gate resolution other than 256 and are put on a grid of that many channels; every FlowJo polygon measured declares 256, so no count at another resolution has been compared with FlowJo's: {list}",
      "\"{name}\" ({channels})",
      "{count} polygon(s) are evaluated continuously rather than on FlowJo's grid, because FlowJo's rule for them is not established, so their counts can differ from FlowJo's by the events near their edges: {list}",
      "\"{name}\" {why}",
      "declares no gate resolution",
      "is a panel of a quadrant gate",
      "is on a Time axis",
      "is on {channel}, whose axis FlowJo's grid is not established for",
      "; ",
      "; and {count} more.",
      ".",
    ]) expect(hasUiTranslation("ja", text), text).toBe(true);
    expect(translateUi("ja", FLOWJO_GRID_OFF_NOTE)).not.toContain("width basis");
  });

  // Off is a choice for one import. Carried to the next it would read another workspace's gates,
  // or one imported onto a loaded file with no dialog at all, another way without a word.
  it("starts on again at the next open, whatever the last one chose", async () => {
    await openWorkspace();
    await setOption(false);
    const cancel = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Cancel")!;
    await act(async () => { cancel.click(); });
    await feed('input[accept=".gatelab,.wsp,.cef"]', fileOf("strategy.wsp", WSP));
    expect(option()!.checked).toBe(true);
  });

  // From the Import menu no dialog asked it before the workspace was read, so the import dialog
  // asks it. It used to be read by FlowJo's rule with no way to choose, and merged into a tree
  // imported with the option off, it added each polygon again beside its continuous twin.
  const importModal = () => host.querySelector<HTMLElement>(".gl-modal");
  const modalOption = () => importModal()?.querySelector<HTMLInputElement>('input[aria-label="Evaluate gates as FlowJo does"]') ?? null;
  async function importMenu(wsp: string, fcs: string[] = ["D1.fcs"]): Promise<void> {
    act(() => root.render(<App />));
    await feed('input[type=file][accept=".fcs"][multiple]', fcs.map((name) => fileOf(name, Uint8Array.from([1]))));
    await feed('input[accept=".xml,.wsp,.cef"]', fileOf("strategy.wsp", wsp));
    for (let i = 0; i < 6; i++) await settle();
  }
  async function confirmImport(): Promise<void> {
    const confirm = [...importModal()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => /^Import/.test(b.textContent ?? ""))!;
    await act(async () => { confirm.click(); });
    await settle(); await settle();
  }
  async function clearModalOption(): Promise<void> {
    await act(async () => { modalOption()!.click(); });
    for (let i = 0; i < 6; i++) await settle();
  }

  it("asks it in the import dialog of a workspace imported onto a loaded file, on by default", async () => {
    await importMenu(PER_FILE);
    expect(modalOption()).not.toBeNull();
    expect(modalOption()!.checked).toBe(true);
    expect(importModal()!.textContent).toContain("Off: every gate is evaluated continuously on the geometry it was drawn with, as FlowKit and Cytobank evaluate gates. Biex axes are read on FlowJo's own table either way; FlowKit's differs from it where the width basis lies between −1 and −3.16.");
    await confirmImport();
    expect(host.textContent).toContain("evaluated as FlowJo does (1 polygon(s) on FlowJo's grid)");
  });

  it("reads the workspace again, continuously, when it is cleared in that dialog", async () => {
    await importMenu(PER_FILE);
    await clearModalOption();
    expect(modalOption()!.checked).toBe(false);
    await confirmImport();
    expect(host.textContent).toContain("evaluated continuously, not on FlowJo's grid");
    expect(host.textContent).not.toContain("on FlowJo's grid)");
  });

  it("asks it after a tree chosen by hand on a loaded file, and keeps the answer", async () => {
    await importMenu(WSP);
    const rows = [...treePicker()!.querySelectorAll<HTMLButtonElement>(".gl-wsp-row")];
    await act(async () => { rows[1].click(); });
    for (let i = 0; i < 6; i++) await settle();
    expect(modalOption()!.checked).toBe(true);
    await clearModalOption();
    await confirmImport();
    expect(host.textContent).toContain('tree "CD8_positive", 2 of 3');
    expect(host.textContent).toContain("evaluated continuously, not on FlowJo's grid");
  });

  it("applies the answer given there to every file of a per-file import from the Import menu", async () => {
    await importMenu(PER_FILE, ["D1.fcs", "D2.fcs"]);
    expect(modalOption()!.checked).toBe(true);
    await clearModalOption();
    await confirmImport();
    expect(host.textContent).toContain("evaluated continuously, not on FlowJo's grid");
  });
});
