// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BarcodeSchemeImportModal, type BarcodeImportDraft } from "./BarcodeSchemeImportModal";
import { I18nProvider } from "./i18n";
import { parseBarcodeTable, previewQcChain, resolveBarcodeScheme, type BarcodeChannelLike, type BarcodePlane } from "../engine/barcodeScheme";
import { DEFAULT_BARCODE_TEMPLATE } from "../engine/barcodeTemplate";
import type { CoreState } from "../store";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const CHANNELS: BarcodeChannelLike[] = [
  { key: "Event_length", pnn: "Event_length", marker: null },
  { key: "103Rh_DNA", pnn: "103Rh_DNA", marker: null },
  { key: "89Y_CD45", pnn: "89Y_CD45", marker: null },
  { key: "194Pt_CD45", pnn: "194Pt_CD45", marker: null },
  { key: "195Pt_CD45", pnn: "195Pt_CD45", marker: null },
];

function stateWith(): CoreState {
  return {
    gates: {},
    gate_order: [],
    populations: {
      root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: ["cells"], event_count: null, percent_of_parent: 100 },
      cells: { population_id: "cells", name: "CellsB", gate_refs: [], gate_logic: "and", parent_id: "root", children: [], event_count: null, percent_of_parent: null },
    },
    root_population_id: "root",
    active_population_id: "cells",
  } as unknown as CoreState;
}

function draftFor(text: string, planes: BarcodePlane[] | null = null): BarcodeImportDraft {
  return {
    fileName: "scheme.csv",
    table: parseBarcodeTable(text),
    planes,
    template: DEFAULT_BARCODE_TEMPLATE,
    templateLabel: "GateLab default",
    parentId: "cells",
    sampleId: "s1",
    qc: true,
    reuse: true,
    newHierarchyName: null,
  };
}

function mount(draft: BarcodeImportDraft, handlers: Partial<Parameters<typeof BarcodeSchemeImportModal>[0]> = {}) {
  const scheme = resolveBarcodeScheme(draft.table, CHANNELS, draft.planes ?? undefined);
  const props = {
    draft,
    scheme,
    channels: CHANNELS,
    state: stateWith(),
    canLearn: false,
    qcPreview: previewQcChain(draft.template.qc, CHANNELS),
    reusePreview: { reused: 4, created: 6 },
    suggestedHierarchyName: "Hierarchy 2",
    onPlanesChange: vi.fn(),
    onParentChange: vi.fn(),
    onNewHierarchyChange: vi.fn(),
    onQcChange: vi.fn(),
    onReuseChange: vi.fn(),
    onTemplateDefault: vi.fn(),
    onTemplateLearn: vi.fn(),
    onTemplateFile: vi.fn(),
    onDownloadTemplateCsv: vi.fn(),
    onCancel: vi.fn(),
    onImport: vi.fn(),
    ...handlers,
  };
  act(() => {
    root.render(<I18nProvider><BarcodeSchemeImportModal {...props} /></I18nProvider>);
  });
  return props;
}

const importButton = () => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Import")!;

describe("BarcodeSchemeImportModal", () => {
  it("summarises a clean scheme, lists the populations, and enables Import", () => {
    const props = mount(draftFor("name,89Y,194Pt,195Pt\n01,1,0,0\n02,0,1,0\n"));
    expect(host.textContent).toContain("2 sample(s), 3 barcode channel(s), 2 plane(s)");
    expect(host.textContent).toContain("Populations to create: 01, 02");
    expect(host.textContent).toContain("drawn against 103Rh_DNA");
    expect(importButton().disabled).toBe(false);
    act(() => importButton().click());
    expect(props.onImport).toHaveBeenCalledTimes(1);
    const select = host.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("cells");
  });

  it("shows the table's problems and keeps Import disabled", () => {
    mount(draftFor("name,89Y,194Pt,195Pt\n01,1,0,0\n02,1,0,0\n"));
    expect(host.textContent).toContain("share the same barcode combination");
    expect(importButton().disabled).toBe(true);
  });

  it("offers the template's QC chain, names what it cannot place, and reports the toggle", () => {
    const props = mount(draftFor("name,89Y,194Pt,195Pt\n01,1,0,0\n02,0,1,0\n"));
    // The test channel list has event length and DNA, so only the singlets gate can be placed.
    expect(host.textContent).toContain("Create the QC populations above the samples: Cells (1)");
    expect(host.textContent).toContain("Cells / CenterGate: no channel matches Time.");
    expect(host.textContent).toContain("Live / Live: no channel matches Live.");
    const box = Array.from(host.querySelectorAll("input[type=checkbox]")).find((b) => (b as HTMLInputElement).checked) as HTMLInputElement;
    expect(box).toBeTruthy();
    act(() => box.click());
    expect(props.onQcChange).toHaveBeenCalledWith(false);
  });

  it("offers to reuse existing gates and shows the count", () => {
    const props = mount(draftFor("name,89Y,194Pt,195Pt\n01,1,0,0\n02,0,1,0\n"));
    expect(host.textContent).toContain("Reuse gates this workspace already has, matched by name and channels: 4 reused, 6 to create");
    const box = Array.from(host.querySelectorAll<HTMLInputElement>("input[type=checkbox]")).find((b) =>
      b.parentElement?.textContent?.includes("Reuse gates"),
    )!;
    expect(box.checked).toBe(true);
    act(() => box.click());
    expect(props.onReuseChange).toHaveBeenCalledWith(false);
  });

  it("can send the strategy into a new hierarchy, named in the dialog", () => {
    const props = mount(draftFor("name,89Y,194Pt,195Pt\n01,1,0,0\n02,0,1,0\n"));
    const select = host.querySelector("select") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toContain("__new-hierarchy");
    act(() => {
      select.value = "__new-hierarchy";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(props.onNewHierarchyChange).toHaveBeenCalledWith("Hierarchy 2");
    // With the name set, the dialog shows the field and Import stays enabled; blank disables it.
    mount({ ...draftFor("name,89Y,194Pt,195Pt\n01,1,0,0\n02,0,1,0\n"), newHierarchyName: "Scheme B" });
    expect((host.querySelector('input[aria-label="New hierarchy name"]') as HTMLInputElement).value).toBe("Scheme B");
    expect(importButton().disabled).toBe(false);
    mount({ ...draftFor("name,89Y,194Pt,195Pt\n01,1,0,0\n02,0,1,0\n"), newHierarchyName: "  " });
    expect(importButton().disabled).toBe(true);
  });

  it("edits the plane layout through the callbacks", () => {
    const props = mount(draftFor("name,89Y,194Pt,195Pt\n01,1,0,0\n02,0,1,0\n"));
    const remove = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Remove")!;
    act(() => remove.click());
    expect(props.onPlanesChange).toHaveBeenCalledWith([
      { x: "103Rh_DNA", y: "195Pt_CD45", xIsBarcode: false, yIsBarcode: true },
    ]);
    const reset = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Reset to proposed")!;
    expect(reset.disabled).toBe(true);
  });
});
