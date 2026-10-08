// @vitest-environment jsdom
// Counts against FlowJo: a FlowJo workspace records an event count on every population, and once
// its strategy is imported the result line says how many of the populations count exactly as
// FlowJo recorded, with a dialog that sets the two counts side by side for each file and says
// whether a difference arises at a population's own gate or is inherited from one above it.
// Synthetic file, gate and population names.

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

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";
/** A square polygon gate on FSC-A / SSC-A, its corners well clear of every event and of FlowJo's grid lines. */
const square = (id: string, lo: number, hi: number) => `<gating:PolygonGate xmlns:gating="${G}" xmlns:data-type="${D}" quadId="-1" gateResolution="256" gating:id="${id}">
  <gating:dimension><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
  <gating:dimension><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
  <gating:vertex><gating:coordinate data-type:value="${lo}"/><gating:coordinate data-type:value="${lo}"/></gating:vertex>
  <gating:vertex><gating:coordinate data-type:value="${hi}"/><gating:coordinate data-type:value="${lo}"/></gating:vertex>
  <gating:vertex><gating:coordinate data-type:value="${hi}"/><gating:coordinate data-type:value="${hi}"/></gating:vertex>
  <gating:vertex><gating:coordinate data-type:value="${lo}"/><gating:coordinate data-type:value="${hi}"/></gating:vertex>
</gating:PolygonGate>`;
const transforms = `<Transformations>
  <transforms:linear xmlns:transforms="${T}" xmlns:data-type="${D}" transforms:minRange="0" transforms:maxRange="262144" transforms:gain="1"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
  <transforms:linear xmlns:transforms="${T}" xmlns:data-type="${D}" transforms:minRange="0" transforms:maxRange="262144" transforms:gain="1"><data-type:parameter data-type:name="SSC-A"/></transforms:linear>
</Transformations>`;
const sampleOf = (file: string, populations: string) =>
  `<Sample><DataSet uri="file:${file}"/>${transforms}<SampleNode name="${file}" count="3"><Subpopulations>${populations}</Subpopulations></SampleNode></Sample>`;
/** A population with the count FlowJo is said to have recorded for it, and what is gated beneath it. */
const pop = (name: string, recorded: number, gate: string, below = "") =>
  `<Population name="${name}" count="${recorded}"><Gate>${gate}</Gate>${below ? `<Subpopulations>${below}</Subpopulations>` : ""}</Population>`;

// The file's three events lie at 10,000, 20,000 and 30,000 on both axes. The outer square holds
// the first two and the inner one the second alone. FlowJo's record agrees on the outer (2), and
// is written here as 2 for the inner as well, which is one more than the gate holds.
const tree = (innerRecorded: number) =>
  pop("CD4_positive", 2, square("g1", 5000, 25000), pop("Naive", innerRecorded, square("g2", 15000, 25000)));
const wspOf = (...samples: string[]) => `<?xml version="1.0"?><Workspace><SampleList>${samples.join("")}</SampleList></Workspace>`;

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
const openDialog = () => host.querySelector<HTMLElement>('[aria-label="Open a FlowJo workspace"]');
async function importWorkspace(wsp: string, fcs: string[]): Promise<void> {
  act(() => root.render(<App />));
  await feed('input[accept=".gatelab,.wsp,.cef"]', fileOf("strategy.wsp", wsp));
  expect(openDialog()).not.toBeNull();
  await feed('input[data-role="flowjo-workspace-fcs"]', fcs.map((name) => fileOf(name, Uint8Array.from([1]))));
  const button = [...openDialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Import")!;
  await act(async () => { button.click(); });
  for (let i = 0; i < 6; i++) await settle();
  const confirm = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
  if (confirm) { await act(async () => { confirm.click(); }); await settle(); await settle(); }
  // The check is made just after the render that holds the imported tree.
  for (let i = 0; i < 6; i++) await settle();
}
const line = () => host.querySelector<HTMLElement>(".gl-flowjo-check-line");
const report = () => host.querySelector<HTMLElement>('[aria-label="Counts against FlowJo"]');
async function showCounts(): Promise<void> {
  await act(async () => { line()!.querySelector("button")!.click(); });
}
const rowsOf = () => [...report()!.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));

describe("Counts against FlowJo, after a FlowJo workspace is imported", () => {
  it("says every population counts as FlowJo recorded where it does", async () => {
    await importWorkspace(wspOf(sampleOf("D1.fcs", tree(1))), ["D1.fcs"]);
    expect(line()!.textContent).toContain("At import, all 2 populations compared counted exactly as FlowJo recorded.");
    await showCounts();
    expect(report()!.textContent).toContain("All 2 populations compared count exactly as FlowJo recorded.");
    expect(rowsOf().map((cells) => cells.slice(0, 4))).toEqual([
      ["CD4_positive", "2", "2", "0"],
      ["Naive", "1", "1", "0"],
    ]);
  });

  it("counts the populations that differ, and says a difference is the gate's own where everything above is exact", async () => {
    await importWorkspace(wspOf(sampleOf("D1.fcs", tree(2))), ["D1.fcs"]);
    expect(line()!.textContent).toContain("At import, 1 of 2 populations compared counted exactly as FlowJo recorded.");
    await showCounts();
    expect(report()!.textContent).toContain("1 of 2 populations compared count exactly as FlowJo recorded.");
    expect(report()!.textContent).toContain("The largest difference is −1 events (−50.00%) on Naive.");
    const rows = rowsOf();
    expect(rows[0].slice(0, 5)).toEqual(["CD4_positive", "2", "2", "0", "0"]);
    expect(rows[1].slice(0, 5)).toEqual(["Naive", "2", "1", "−1", "−50.00%"]);
    expect(rows[1][7]).toBe("at its own gate");
    expect(rows[0][7]).toBe("");
    // FlowJo's share of the parent is worked out from its own counts: 2 of the file's 3, then 2 of 2.
    expect(rows[0][5]).toBe("66.67%");
    expect(rows[1][5]).toBe("100.00%");
    // Differences only.
    await act(async () => { report()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    expect(rowsOf().map((cells) => cells[0])).toEqual(["Naive"]);
    await act(async () => { [...report()!.querySelectorAll("button")].find((b) => b.textContent === "Close")!.click(); });
    expect(report()).toBeNull();
  });

  it("compares each file of a per-file import with its own sample's counts", async () => {
    await importWorkspace(wspOf(sampleOf("D1.fcs", tree(1)), sampleOf("D2.fcs", tree(2))), ["D1.fcs", "D2.fcs"]);
    expect(line()!.textContent).toContain("At import, 3 of 4 populations compared counted exactly as FlowJo recorded.");
    await showCounts();
    const files = [...report()!.querySelectorAll<HTMLButtonElement>(".gl-chorus-stats-files button")];
    // A file with a population that differs carries how many beside its name.
    expect(files.map((b) => b.textContent)).toEqual(["D1.fcs", "D2.fcs · 1"]);
    expect(report()!.textContent).toContain("on Naive, D2.fcs.");
    await act(async () => { files[1].click(); });
    expect(rowsOf().map((cells) => cells.slice(0, 4))).toEqual([
      ["CD4_positive", "2", "2", "0"],
      ["Naive", "2", "1", "−1"],
    ]);
  });
});
