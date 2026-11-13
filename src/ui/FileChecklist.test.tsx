// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileChecklist, type FileChecklistFile } from "./FileChecklist";

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

const FILES: FileChecklistFile[] = [
  { id: "D1", name: "D1.fcs", metadata: { group: "control", batch: "B1" } },
  { id: "D2", name: "D2.fcs", metadata: { group: "treated", batch: "B1" } },
  { id: "D3", name: "D3.fcs", metadata: { group: "control", batch: "B2" } },
];

function Harness({ initial, onSelection, checkedIds, columns, levels }: {
  initial: string[];
  onSelection: (ids: string[]) => void;
  checkedIds?: string[];
  columns?: string[];
  levels?: Record<string, string[]>;
}) {
  const [selected, setSelected] = useState(initial);
  return (
    <FileChecklist
      files={FILES}
      selected={selected}
      onChange={(ids) => { setSelected(ids); onSelection(ids); }}
      checkedIds={checkedIds}
      columns={columns}
      levels={levels}
    />
  );
}

const rows = () => [...host.querySelectorAll<HTMLLabelElement>(".gl-figure-list label")];
const rowNames = () => rows().map((row) => row.querySelector(".gl-figure-row-name")!.textContent);
const box = (name: string) => rows().find((row) => row.querySelector(".gl-figure-row-name")!.textContent === name)!.querySelector("input")!;
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);

describe("FileChecklist", () => {
  it("lists the files in the order given and adds a ticked file at the end of the selection", () => {
    const onSelection = vi.fn();
    act(() => root.render(<Harness initial={["D3"]} onSelection={onSelection} />));
    expect(rowNames()).toEqual(["D1.fcs", "D2.fcs", "D3.fcs"]);
    expect(rows().map((row) => row.querySelector("input")!.checked)).toEqual([false, false, true]);
    act(() => box("D1.fcs").click());
    expect(onSelection).toHaveBeenLastCalledWith(["D3", "D1"]);
    act(() => box("D3.fcs").click());
    expect(onSelection).toHaveBeenLastCalledWith(["D1"]);
  });

  it("takes every file, none, or the checked files", () => {
    const onSelection = vi.fn();
    act(() => root.render(<Harness initial={[]} onSelection={onSelection} checkedIds={["D2"]} />));
    act(() => button("All")!.click());
    expect(onSelection).toHaveBeenLastCalledWith(["D1", "D2", "D3"]);
    act(() => button("None")!.click());
    expect(onSelection).toHaveBeenLastCalledWith([]);
    act(() => button("Use checked files")!.click());
    expect(onSelection).toHaveBeenLastCalledWith(["D2"]);
  });

  it("offers Use checked files only when the tab gives the checked files", () => {
    act(() => root.render(<Harness initial={[]} onSelection={vi.fn()} />));
    expect(button("Use checked files")).toBeUndefined();
  });

  it("filters the rows by name without changing the selection", () => {
    const onSelection = vi.fn();
    act(() => root.render(<Harness initial={["D1"]} onSelection={onSelection} />));
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "d2");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rowNames()).toEqual(["D2.fcs"]);
    expect(onSelection).not.toHaveBeenCalled();
  });

  it("shows each file's values in the columns in use", () => {
    act(() => root.render(<Harness initial={[]} onSelection={vi.fn()} columns={["group", "batch"]} />));
    expect(rows().map((row) => row.querySelector(".gl-figure-row-meta")?.textContent)).toEqual(["control · B1", "treated · B1", "control · B2"]);
    act(() => root.render(<Harness initial={[]} onSelection={vi.fn()} />));
    expect(host.querySelector(".gl-figure-list .gl-figure-row-meta")).toBeNull();
  });

  it("selects by metadata with the file list's chips, in the column's order of its values", () => {
    const onSelection = vi.fn();
    act(() => root.render(<Harness initial={[]} onSelection={onSelection} levels={{ group: ["treated", "control"] }} />));
    const chips = (column: string) => [...host.querySelectorAll<HTMLElement>(".gl-sample-facet-row")]
      .find((row) => row.querySelector(".gl-sample-facet-name")!.textContent === column)!
      .querySelectorAll<HTMLButtonElement>(".gl-sample-facet-chip");
    expect([...chips("group")].map((chip) => chip.querySelector(".gl-sample-facet-label")!.textContent)).toEqual(["treated", "control"]);
    act(() => [...chips("group")].find((chip) => chip.textContent?.startsWith("control"))!.click());
    expect(onSelection).toHaveBeenLastCalledWith(["D1", "D3"]);
    act(() => [...chips("batch")].find((chip) => chip.textContent?.startsWith("B1"))!.click());
    expect(onSelection).toHaveBeenLastCalledWith(["D1", "D2", "D3"]);
  });
});
