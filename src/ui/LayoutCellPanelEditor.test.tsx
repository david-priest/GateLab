// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCellPanel, type LayoutCellPanelRecipe } from "../engine/cellPanelBlock";
import type { ChannelDisplay } from "../imaging/imageWallSettings";
import { LayoutCellPanelEditor } from "./LayoutCellPanelEditor";

const d = (slot: number, name: string, enabled: boolean, colour: string): ChannelDisplay => ({ slot, name, enabled, colour, threshold: 0, saturation: 0.8, gamma: 1, smoothing: 1 });
const display = [d(2, "LightLoss (Imaging)", true, "#bdbdbd"), d(4, "SSC (Imaging)", false, "#00ffff"), d(5, "CD4", true, "#00ff00"), d(6, "CD8", true, "#ff0000")];

let root: Root;
let host: HTMLDivElement;
let current: LayoutCellPanelRecipe;

function mount(recipe: LayoutCellPanelRecipe) {
  current = recipe;
  const onChange = (next: LayoutCellPanelRecipe) => { current = next; act(() => root.render(<LayoutCellPanelEditor recipe={current} onChange={onChange} />)); };
  act(() => root.render(<LayoutCellPanelEditor recipe={current} onChange={onChange} />));
}

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

const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string, type: "input" | "change" = "input") => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event(type, { bubbles: true })); });
};

describe("LayoutCellPanelEditor", () => {
  it("edits the columns: header, grey, gain, order, removal, a new channel and the merge's channels", () => {
    mount(defaultCellPanel({ sampleId: "D1", fileName: "D1.fcs", cells: [{ event: 3, label: "Event 3" }, { event: 9, label: "Event 9" }], display, exposure: 1 }));
    expect(current.columns.map((c) => c.header)).toEqual(["LightLoss (Imaging)", "SSC (Imaging)", "CD4", "CD8", "Merge"]);
    const columns = () => [...host.querySelectorAll<HTMLLIElement>('ol[aria-label="Channels shown"] li')];
    // Rename the first column and draw CD4 in grey, with twice the brightness.
    setValue(columns()[0].querySelector<HTMLInputElement>('input[aria-label="Column name"]')!, "Brightfield");
    expect(current.columns[0].header).toBe("Brightfield");
    act(() => { columns()[2].querySelector<HTMLInputElement>('label.gl-check input[type="checkbox"]')!.click(); });
    expect(current.columns[2]).toMatchObject({ slot: 5, grey: true });
    setValue(columns()[2].querySelector<HTMLInputElement>('input[type="range"]')!, "1");
    expect(current.gain?.[5]).toBeCloseTo(2, 9);
    // Switch SSC off and on again: its row and settings stay.
    const ssc = () => columns()[1].querySelector<HTMLInputElement>('input[aria-label="Show SSC (Imaging)"]')!;
    act(() => { ssc().click(); });
    expect(current.columns[1]).toMatchObject({ slot: 4, hidden: true });
    expect(current.columns).toHaveLength(5);
    act(() => { ssc().click(); });
    expect(current.columns[1].hidden).toBe(false);
    // Move CD8 above CD4.
    act(() => { columns()[3].querySelector<HTMLButtonElement>('button[aria-label="Move up"]')!.click(); });
    expect(current.columns.map((c) => c.header)).toEqual(["Brightfield", "SSC (Imaging)", "CD8", "CD4", "Merge"]);
    // Take CD8 out of the merge (the merge's boxes come after its show box); remove the merge and add it back.
    const merge = columns()[4];
    const mergeBoxes = [...merge.querySelectorAll<HTMLInputElement>('.gl-cellpanel-merge input[type="checkbox"]')];
    act(() => { mergeBoxes[3].click(); });
    expect(current.columns[4]).toMatchObject({ kind: "merge", slots: [5] });
    act(() => { merge.querySelector<HTMLButtonElement>('button[aria-label="Remove"]')!.click(); });
    expect(current.columns.some((c) => c.kind === "merge")).toBe(false);
    setValue(host.querySelector<HTMLSelectElement>('select[aria-label="Add a column"]')!, "merge", "change");
    expect(current.columns[4]).toMatchObject({ kind: "merge", slots: [2, 5, 6] });
  });

  it("edits the cells and the panel: labels, order, removal, transpose, headers, outline, title", () => {
    mount(defaultCellPanel({ sampleId: "D1", fileName: "D1.fcs", cells: [{ event: 3, label: "Event 3" }, { event: 9, label: "Event 9" }], display, exposure: 1 }));
    const cells = () => [...host.querySelectorAll<HTMLLIElement>('ol[aria-label="Cells shown"] li')];
    setValue(cells()[1].querySelector<HTMLInputElement>("input")!, "Doublet");
    expect(current.cells[1]).toEqual({ event: 9, label: "Doublet" });
    act(() => { cells()[1].querySelector<HTMLButtonElement>('button[aria-label="Move up"]')!.click(); });
    expect(current.cells.map((c) => c.event)).toEqual([9, 3]);
    act(() => { cells()[1].querySelector<HTMLButtonElement>('button[aria-label="Remove"]')!.click(); });
    expect(current.cells.map((c) => c.event)).toEqual([9]);
    expect(cells()[0].querySelector<HTMLButtonElement>('button[aria-label="Remove"]')!.disabled).toBe(true);
    const check = (text: string) => [...host.querySelectorAll<HTMLLabelElement>("label.gl-check")].find((l) => l.textContent?.trim() === text)!.querySelector("input")!;
    act(() => { check("Cells as columns").click(); });
    act(() => { check("Channel names").click(); });
    act(() => { check("Mask outline").click(); });
    expect(current).toMatchObject({ transpose: true, showHeaders: false, outline: true });
    setValue(host.querySelector<HTMLInputElement>(".gl-layout-title-field input")!, "Exemplar cells");
    expect(current.title).toBe("Exemplar cells");
  });
});
