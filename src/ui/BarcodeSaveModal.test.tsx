// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BarcodeSaveModal } from "./BarcodeSaveModal";
import { I18nProvider } from "./i18n";

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

const button = (label: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label)!;

describe("BarcodeSaveModal", () => {
  it("offers both files, summarises the strategy, and reports the choice", () => {
    const onSave = vi.fn();
    act(() => {
      root.render(
        <I18nProvider>
          <BarcodeSaveModal
            summary={{ mode: "scheme", planeLabels: ["195Pt x 194Pt", "103Rh(display) x 89Y"], qcNames: ["CellsB 1nolive", "CellsB"], nSamples: 33, nGates: 0, nPopulations: 0, hasTemplate: true, notes: [] }}
            onSave={onSave}
            onCancel={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    expect(host.textContent).toContain("2 plane(s): 195Pt x 194Pt; 103Rh(display) x 89Y.");
    expect(host.textContent).toContain("QC chain: CellsB 1nolive → CellsB.");
    expect(host.textContent).toContain("33 sample population(s)");
    const boxes = Array.from(host.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    expect(boxes.map((b) => b.checked)).toEqual([true, true]);
    act(() => boxes[1].click());
    act(() => button("Save").click());
    expect(onSave).toHaveBeenCalledWith({ scheme: true, template: false });
  });

  it("disables the table when no sample population exists, and Save when nothing is chosen", () => {
    act(() => {
      root.render(
        <I18nProvider>
          <BarcodeSaveModal
            summary={{ mode: "scheme", planeLabels: ["195Pt x 194Pt"], qcNames: [], nSamples: 0, nGates: 0, nPopulations: 0, hasTemplate: true, notes: ["Left out 2 population(s) that use some but not all planes: a, b."] }}
            onSave={vi.fn()}
            onCancel={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    expect(host.textContent).toContain("No QC chain above the sample populations.");
    expect(host.textContent).toContain("Left out 2 population(s)");
    const boxes = Array.from(host.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    expect(boxes[0].disabled).toBe(true);
    expect(boxes[0].checked).toBe(false);
    act(() => boxes[1].click());
    expect(button("Save").disabled).toBe(true);
  });
});

describe("BarcodeSaveModal for a plain hierarchy", () => {
  it("offers the hierarchy file and no template when the workspace has no barcode plane", () => {
    const onSave = vi.fn();
    act(() => {
      root.render(
        <I18nProvider>
          <BarcodeSaveModal
            summary={{ mode: "hierarchy", planeLabels: [], qcNames: [], nSamples: 0, nGates: 5, nPopulations: 4, hasTemplate: false, notes: ["Blob: a ellipse gate cannot be written as a \"# gate:\" line."] }}
            onSave={onSave}
            onCancel={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    expect(host.textContent).toContain("No barcode plane in this workspace, so the file holds the plain hierarchy: 5 gate(s) and 4 population(s).");
    expect(host.textContent).toContain("Hierarchy (CSV)");
    expect(host.textContent).toContain("Blob: a ellipse gate");
    const boxes = Array.from(host.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([[true, false], [false, true]]);
    act(() => button("Save").click());
    expect(onSave).toHaveBeenCalledWith({ scheme: true, template: false });
  });
});
