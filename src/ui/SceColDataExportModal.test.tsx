// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "../store";
import { bcrxlAvailable, bcrxlTree } from "../host/bcrxlSceFixture";
import { quadrantPopulationNames } from "../engine/quadrantNames";
import { SceColDataExportModal, type ScePopulationColumnSpec } from "./SceColDataExportModal";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
let renders = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", {
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  uuid = 0;
});

function button(text: string): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent === text || candidate.textContent?.startsWith(`${text} `))!;
}

/** A population gated under `parentId`, and its id. */
function addPopulation(state: CoreState, name: string, parentId: string): [CoreState, string] {
  const before = new Set(Object.keys(state.populations));
  const next = coreReducer(state, {
    type: "addGate",
    gateType: "rectangle",
    xChannel: "X",
    yChannel: "Y",
    vertices: [[0, 0], [1, 1]],
    name: `${name} gate`,
    createPop: { name, parentId },
  });
  return [next, Object.keys(next.populations).find((id) => !before.has(id))!];
}

/** Opens the dialog, chooses All and exports with the default column names. */
function exportAll(state: CoreState): ScePopulationColumnSpec[] {
  const onExport = vi.fn();
  // A fresh key per call: the defaults are set when the dialog mounts.
  act(() => root.render(
    <SceColDataExportModal
      key={++renders}
      state={state}
      existingColumns={[]}
      initialPopulationIds={[]}
      busy={false}
      onCancel={vi.fn()}
      onExport={onExport}
    />,
  ));
  act(() => button("All").click());
  expect(host.textContent).not.toContain("needs a unique colData column name");
  expect(button("Export").disabled).toBe(false);
  act(() => button("Export").click());
  return onExport.mock.calls[0][0];
}

describe("SceColDataExportModal", () => {
  it("surfaces collisions and exports explicit population/column mappings", () => {
    const [state, popId] = addPopulation(
      coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 }),
      "CD3+ cells",
      coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 }).root_population_id!,
    );
    const onExport = vi.fn();
    act(() => root.render(
      <SceColDataExportModal
        state={state}
        existingColumns={["CD3+ cells"]}
        initialPopulationIds={[popId]}
        busy={false}
        onCancel={vi.fn()}
        onExport={onExport}
      />,
    ));

    expect(host.textContent).toContain("Overwrite existing colData column");
    const exportButton = button("Export 1 population");
    expect(exportButton.disabled).toBe(true);

    const overwrite = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.parentElement?.textContent?.includes("Overwrite existing"))!;
    act(() => overwrite.click());
    expect(exportButton.disabled).toBe(false);
    act(() => exportButton.click());

    expect(onExport).toHaveBeenCalledWith([{
      populationId: popId,
      populationName: "CD3+ cells",
      columnName: "CD3+ cells",
      inLabel: "TRUE",
      outLabel: "FALSE",
    }], true);
  });

  it("exports a typed name exactly as typed", () => {
    const loaded = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
    const [state, popId] = addPopulation(loaded, "CD3+ cells", loaded.root_population_id!);
    const onExport = vi.fn();
    act(() => root.render(
      <SceColDataExportModal
        state={state}
        existingColumns={["T_cells"]}
        initialPopulationIds={[popId]}
        busy={false}
        onCancel={vi.fn()}
        onExport={onExport}
      />,
    ));
    const input = host.querySelector<HTMLInputElement>('input[aria-label="colData column for CD3+ cells"]')!;
    for (const typed of [" T_cells", "cd3.T-cells / typed "]) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, typed);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      // " T_cells" is not the existing column T_cells, so it needs no overwrite.
      expect(host.textContent).not.toContain("Overwrite existing");
      act(() => button("Export 1 population").click());
    }
    expect(onExport.mock.calls.map(([columns]) => columns[0].columnName))
      .toEqual([" T_cells", "cd3.T-cells / typed "]);

    // A name of white space alone is no name.
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Export 1 population").disabled).toBe(true);
  });
});

describe("SceColDataExportModal default column names", () => {
  // Names a sign-reading default got wrong: it invented a sign (PD-L1 read as PD- L1), lost one
  // (CD25+/-, CD4(-)) or read one into a detector, dye or TCR name (FJComp-PE-A-, CD3-gdTCR+).
  const reviewed: readonly string[] = [
    "PD-L1+", "PD-L1+ macrophages", "PD-L2+", "PD-L1-", "CD8+PD-L1+", "B7-H3+", "B7-H4+",
    "Foxp3-GFP+", "CD19-CAR+", "OX40-L+", "CD14++CD16-", "CD14++CD16+", "CD14+CD16++", "CD14+CD16+",
    "CD4(-)", "CD4(+)", "CD25+/-", "CD4lo/-", "Eomes-T-bet+", "Eomes-Tbet+", "Helios-Foxp3+",
    "Kappa-Lambda+", "Lambda-Kappa+", "κ-λ+", "Igκ-Igλ+", "IgK-IgL+", "Lineage-CD34+",
    "Tetramer-CD8+", "Zombie-CD3+", "PNA-Fas+", "GzmB-Perforin+", "Perforin-GzmB+", "AnnexinV-PI-",
    "Annexin V-PI-", "AnnexinV-PI+", "Lin-c-kit+", "Lin-cKit+Sca1+", "Lin-c-kit+Sca-1+",
    "FJComp-PE-A+", "FJComp-BV421-A-", "CD4-FITC+", "CD4-high", "CD4-Hi", "Th1-Th17",
    "FJComp-PE-A- FJComp-APC-A+", "FJComp-BV421-A- FJComp-PE-Cy7-A+", "PD-L1- HLA-DR+",
    "PD-L1+ CD8+", "B7-H3- CD45+", "CD3-BUV395- CD19-BV421+", "FITC-CD4- PE-CD8+", "CD4 SP",
    "CD3-gdTCR+", "CD3-γδTCR+", "CD4-cKit+", "CD34-c-kit+", "CD19-mIgD+", "CD45-iNKT+",
    "CD3-αβTCR+", "Viability-CD45+", "Tetramer- CD8+", "ECD-A+", "PC5.5-A+", "APC-A750-A+",
    "KO525-A-", "SSC-B-A+", "VioBlue-A+", "PE-Alexa Fluor 610-A+", "YG1-A-", "UV7-A+", "Nd142Di-",
    "142Nd_CD19-", "tdTomato-A+", "GFP-A-", "IL-17A-IFN-γ+", "TNF-α-IFN-γ+", "GM-CSF+",
    "GM-CSF-IL-2+", "CD4-8-", "HLA-DR-CD14+", "Ly-6G-Ly-6C+", "PNA+GL7+", "IgD-IgM-", "H-2Kb-",
    "Siglec-F-CD11c+", "CD11c-Siglec-F+", "CD64-MerTK+", "MerTK-CD64+", "XCR1-SIRPα+",
    "SIRPα-XCR1+", "CCR2-CX3CR1+", "CX3CR1-CCR2+", "NKG2A-KIR+", "KIR-NKG2A+", "TIGIT-PD-1+",
    "TIM-3-LAG-3+", "LAG-3-TIM-3+", "TCF1-TOX+", "TOX-TCF1+",
  ];
  // Names the sign-reading default was written against, and GateLab's own quadrant names.
  const common: readonly string[] = [
    "CD4-CD8+ T cells", "CD4+CD8- T cells", "CD4+CD8+ T cells", "CD4-CD8- T cells", "CD45RA-CCR7+",
    "CD45RA+CCR7+", "HLA-DR+ monocytes", "HLA-DR- monocytes", "IFN-γ+", "TCR-gd+ T cells",
    "CD3- CD19+", "Lymphocytes - singlets", "IgM- B cells", "IgD-CD27+", "Lin-HLA-DR+",
    "IFN-γ-TNF-α+", "Ki-67+", "OX40+4-1BB+", "CD1d-tet+", "CD4-pS6+", "Non-classical monocytes",
    "CD8− T cells", "CD4 -", "CD4 +", "CD4 - CD8 +", "IgM - IgD +", "CD19 - CD27+",
    "Singlets - CD3+", "P1 - Lymphocytes", "Lin-Sca-1+c-Kit+", "Lin-c-Kit+", "NK1.1-TCRb+",
    "RORγt-T-bet+", "IFNγ-TNFα+", "Dump-B220+", "MHCII-F4/80+", "TCRgd-TCRab+", "F4/80-CD11b+",
    "CD45.1-CD45.2+", "PD-1-CTLA-4+", "Gr-1-CD11b+", "7-AAD-CD45+", "T-bet-RORγt+", "IL-2-IFN-γ+",
    "MHC-II-CD11c+", "Vα24-Jα18+", "TRAV1-2+", "HLA-A2+", "Siglec-F+", "TCR-Vβ8+", "BV421-A+",
    "PE-Cy7-A+", "APC-Cy7-A+", "AF488-A+", "FL1-H+", "Comp-FITC-A+", "Comp-PE-Cy7-A-",
    "PerCP-Cy5.5-A+", "Q1: Comp-FITC-A- , Comp-PE-A+",
    ...quadrantPopulationNames("signs", "B2-A", "R1-A"),
    ...quadrantPopulationNames("signs", "BV421-A", "PE-Cy7-A"),
    ...quadrantPopulationNames("signs", "CD4", "CD8"),
    // White space at either end is part of a name loaded from another tool.
    " Lymphocytes", "Singlets ",
  ];

  it("is each population's own name, verbatim, and distinct for every population", () => {
    const names = [...new Set([...reviewed, ...common])];
    expect(names.length).toBe(reviewed.length + common.length); // No name is listed twice.
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
    for (const name of names) [state] = addPopulation(state, name, state.root_population_id!);

    const columns = exportAll(state);
    expect(columns.map(({ populationName }) => populationName)).toEqual(names);
    for (const { populationName, columnName } of columns) expect(columnName).toBe(populationName);
    expect(new Set(columns.map(({ columnName }) => columnName)).size).toBe(names.length);
  });

  it("tells populations that share a name apart by their nearest ancestors' names", () => {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
    const rootId = state.root_population_id!;
    let tCells: string, cd4: string, cd8: string, treated: string, control: string, x: string;
    [state, tCells] = addPopulation(state, "T cells", rootId);
    [state, cd4] = addPopulation(state, "CD4 T cells", tCells);
    [state, cd8] = addPopulation(state, "CD8 T cells", tCells);
    [state] = addPopulation(state, "Activated", cd4);
    [state] = addPopulation(state, "Activated", cd8);
    [state] = addPopulation(state, "Activated", rootId);
    // Two parents with one name: the prefix runs up to the first ancestor whose name differs.
    [state, treated] = addPopulation(state, "treated", rootId);
    [state, control] = addPopulation(state, "control", rootId);
    [state, x] = addPopulation(state, "CD4_positive", treated);
    [state] = addPopulation(state, "Ki-67+", x);
    [state, x] = addPopulation(state, "CD4_positive", control);
    [state] = addPopulation(state, "Ki-67+", x);
    // Quadrant gates named DN/DP/SP under two parents.
    for (const parent of [cd4, cd8]) {
      for (const name of quadrantPopulationNames("dndp", "CD69", "CD25")) [state] = addPopulation(state, name, parent);
    }

    const columns = exportAll(state);
    expect(columns.map(({ populationName, columnName }) => [populationName, columnName])).toEqual([
      ["T cells", "T cells"],
      ["CD4 T cells", "CD4 T cells"],
      ["Activated", "CD4 T cells / Activated"],
      ["CD25 SP", "CD4 T cells / CD25 SP"],
      ["DP", "CD4 T cells / DP"],
      ["CD69 SP", "CD4 T cells / CD69 SP"],
      ["DN", "CD4 T cells / DN"],
      ["CD8 T cells", "CD8 T cells"],
      ["Activated", "CD8 T cells / Activated"],
      ["CD25 SP", "CD8 T cells / CD25 SP"],
      ["DP", "CD8 T cells / DP"],
      ["CD69 SP", "CD8 T cells / CD69 SP"],
      ["DN", "CD8 T cells / DN"],
      ["Activated", "Activated"],
      ["treated", "treated"],
      ["CD4_positive", "treated / CD4_positive"],
      ["Ki-67+", "treated / CD4_positive / Ki-67+"],
      ["control", "control"],
      ["CD4_positive", "control / CD4_positive"],
      ["Ki-67+", "control / CD4_positive / Ki-67+"],
    ]);
  });

  it("numbers populations whose ancestors carry the same names, and never repeats another's name", () => {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
    const rootId = state.root_population_id!;
    let cd4: string, cd8: string;
    [state, cd4] = addPopulation(state, "CD4 T cells", rootId);
    [state, cd8] = addPopulation(state, "CD8 T cells", rootId);
    [state] = addPopulation(state, "Activated", cd4);
    [state] = addPopulation(state, "Activated", cd4);
    [state] = addPopulation(state, "Activated", cd8);
    // A population whose own name is another's prefixed default keeps it.
    [state] = addPopulation(state, "CD8 T cells / Activated", rootId);

    const columns = exportAll(state);
    expect(columns.map(({ columnName }) => columnName)).toEqual([
      "CD4 T cells",
      "CD4 T cells / Activated",
      "CD4 T cells / Activated (2)",
      "CD8 T cells",
      "CD8 T cells / Activated (2)",
      "CD8 T cells / Activated",
    ]);
  });
});

describe.runIf(bcrxlAvailable())("SceColDataExportModal default column names (public BCR-XL tree)", () => {
  it("gives every population its own name, and exports a typed name as typed", () => {
    const tree = bcrxlTree();
    const state = { ...initialCoreState(), ...tree } as CoreState;
    const onExport = vi.fn();
    act(() => root.render(
      <SceColDataExportModal
        state={state}
        existingColumns={[]}
        initialPopulationIds={[]}
        busy={false}
        onCancel={vi.fn()}
        onExport={onExport}
      />,
    ));
    act(() => button("All").click());
    const exportButton = button("Export");
    // IgM+ and IgM- B cells once shared a default, which disabled Export until one was renamed.
    expect(host.textContent).not.toContain("needs a unique colData column name");
    expect(exportButton.disabled).toBe(false);

    const input = host.querySelector<HTMLInputElement>('input[aria-label="colData column for CD8 T cells"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "cd8.T-cells");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => exportButton.click());
    const names = Object.fromEntries(onExport.mock.calls[0][0].map((c: { populationName: string; columnName: string }) => [c.populationName, c.columnName]));
    expect(names).toEqual({
      "B cells": "B cells",
      "IgM+ B cells": "IgM+ B cells",
      "IgM- B cells": "IgM- B cells",
      "pS6+ B cells": "pS6+ B cells",
      "T cells": "T cells",
      "CD4 T cells": "CD4 T cells",
      "CD8 T cells": "cd8.T-cells",
      "NK cells": "NK cells",
      "Monocytes": "Monocytes",
      "Dendritic cells": "Dendritic cells",
    });
  });

  it("keeps two populations that share a name and a parent apart", () => {
    const tree = bcrxlTree();
    const cd4 = Object.keys(tree.populations).find((id) => tree.populations[id].name === "CD4 T cells")!;
    const cd8 = Object.keys(tree.populations).find((id) => tree.populations[id].name === "CD8 T cells")!;
    tree.populations[cd8] = { ...tree.populations[cd8], name: "CD4 T cells" };
    const onExport = vi.fn();
    act(() => root.render(
      <SceColDataExportModal
        state={{ ...initialCoreState(), ...tree } as CoreState}
        existingColumns={[]}
        initialPopulationIds={[cd4, cd8]}
        busy={false}
        onCancel={vi.fn()}
        onExport={onExport}
      />,
    ));
    act(() => button("Export").click());
    expect(onExport.mock.calls[0][0].map((c: { columnName: string }) => c.columnName)).toEqual(["CD4 T cells", "CD4 T cells (2)"]);
  });
});
