// @vitest-environment jsdom
// What a FACSDiva or FACSChorus conversion skipped is shown beside the import's result. Both
// imports set their converter's notes as the error and then staged the import, which clears the
// error, so no note from either was ever shown -- the defect the FlowJo import had. Synthetic
// file and population names.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
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
  columns: [Float32Array.from([100, 200, 300]), Float32Array.from([150, 250, 350])],
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

function fileOf(name: string, content: string | Uint8Array): File {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : Uint8Array.from(content);
  const file = new File([bytes], name);
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.slice().buffer });
  if (typeof content === "string") Object.defineProperty(file, "text", { value: async () => content });
  return file;
}
async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
async function feed(selector: string, file: File): Promise<void> {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  for (let i = 0; i < 6; i++) await settle();
}
/** A loaded file, then a gating file imported onto it through Import gating. */
async function importOntoLoadedFile(gating: File): Promise<void> {
  act(() => root.render(<App />));
  await feed('input[type=file][accept=".fcs"][multiple]', fileOf("D1.fcs", Uint8Array.from([1])));
  await feed('input[accept=".xml,.wsp,.cef"]', gating);
}
const errorText = () => host.querySelector(".gl-error")?.textContent ?? "";

describe("converter notes from other formats", () => {
  it("shows what a FACSDiva conversion skipped", async () => {
    const gate = (name: string, type: string, region: string) => `<gate fullname="All Events\\${name}" type="${type}">
      <name>${name}</name><parent>All Events</parent><num_events>2</num_events>
      <is_x_parameter_log>false</is_x_parameter_log><is_y_parameter_log>false</is_y_parameter_log>
      <is_x_parameter_scaled>false</is_x_parameter_scaled><is_y_parameter_scaled>false</is_y_parameter_scaled>
      <x_parameter_scale_value>0</x_parameter_scale_value><y_parameter_scale_value>0</y_parameter_scale_value>
      ${region}</gate>`;
    const polygon = `<region name="r" xparm="FSC-A" yparm="SSC-A" type="POLYGON_REGION"><points>
      <point x="50" y="50" /><point x="350" y="50" /><point x="350" y="400" /></points></region>`;
    const diva = `<bdfacs version="Version 9.1.2"><experiment name="Synthetic">
      <acquisition_worksheets name="Global Worksheets"><worksheet_template name="Sheet1"><gates>
        <gate fullname="All Events" type="EventSource_Classifier"><name>All Events</name><num_events>3</num_events></gate>
        ${gate("CD4_positive", "Region_Classifier", polygon)}
        ${gate("CD8_positive", "Interval_Classifier", "")}
      </gates></worksheet_template></acquisition_worksheets>
      <specimen name="Specimen_001"></specimen>
    </experiment></bdfacs>`;
    await importOntoLoadedFile(fileOf("experiment.xml", diva));
    // Both notes shown are counted: the worksheet's pairing note and the converter's.
    expect(host.textContent).toMatch(/Imported 1 gates, 1 populations.*from FACSDiva experiment.*· 2 note\(s\)/);
    expect(errorText()).toMatch(/The worksheet's gates apply to any tube, but no tube of this experiment is named "D1\.fcs"/);
    expect(errorText()).toMatch(/"CD8_positive" is an Interval_Classifier, which this importer does not read; it and anything below it were skipped\./);
  });

  it("shows what a FACSChorus conversion skipped", async () => {
    const parameter = (name: string) => ({
      measurementId: name, fluorochrome: name, measurement: "A", scatter: name, scale: "Linear",
      numerator: null, denominator: null, parameterKind: "Scatter",
    });
    const gate = (id: string, kind: string, name: string) => ({
      gateId: id, gateKind: kind, name, parentPopulationId: "0-1",
      parameters: [parameter("FSC"), parameter("SSC")],
      vertices: [{ x: 50, y: 50 }, { x: 350, y: 50 }, { x: 350, y: 400 }],
      children: [{ name, color: "0,0,255", populationId: `${id}-1` }],
    });
    const cef = zipSync({
      "manifest.json": strToU8(JSON.stringify({ chorusVersion: "5.4.0" })),
      "experiment.json": strToU8(JSON.stringify({
        experiment: {
          name: "synthetic experiment",
          panels: [{
            name: "Panel 1",
            analysis: {
              gates: [gate("gate-1", "Polygon", "CD4_positive"), gate("gate-2", "Spiral", "CD8_positive")],
              visualizationSettings: { analysisRValueMap: [] },
            },
          }],
        },
        sortRecords: [],
      })),
    });
    await importOntoLoadedFile(fileOf("strategy.cef", cef));
    // D1.fcs carries no FACSChorus record, so the gates go onto it only when that is chosen.
    const apply = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Apply the current gates to D1.fcs…")!;
    await act(async () => { apply.click(); });
    for (let i = 0; i < 6; i++) await settle();
    expect(host.textContent).toMatch(/Imported 1 gates, 1 populations.*from FACSChorus experiment · synthetic experiment.*· 1 note\(s\)/);
    expect(errorText()).toMatch(/1 gate\(s\) of a kind this importer does not read were skipped with everything beneath them: "CD8_positive" \(Spiral\)\./);
  });
});
