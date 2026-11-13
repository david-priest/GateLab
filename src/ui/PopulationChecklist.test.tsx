// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastPaths, PopulationChecklist, type PopulationChecklistRow } from "./PopulationChecklist";

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

const ROWS: PopulationChecklistRow[] = [
  { key: "lymph", name: "Lymphocytes", depth: 1, isLastPath: [true], color: "#1f77b4" },
  { key: "cd4", name: "CD4_positive", depth: 2, isLastPath: [true, false], color: "#ff7f0e" },
  { key: "cd8", name: "CD8_positive", depth: 2, isLastPath: [true, true] },
];

const rows = () => [...host.querySelectorAll<HTMLElement>(".gl-strategy-pop-row")];
const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("lastPaths", () => {
  it("gives the connector flags of rows known only by their depths", () => {
    // The tree's own flags for a whole tree.
    expect(lastPaths([0, 1, 2, 2, 1])).toEqual([[], [false], [false, false], [false, true], [true]]);
    // A list that leaves a population out: the remaining rows close their branches.
    expect(lastPaths([1, 2, 1])).toEqual([[false], [false, true], [true]]);
    expect(lastPaths([])).toEqual([]);
  });
});

describe("PopulationChecklist", () => {
  it("ticks populations, each row with its colour, and finds one by name", () => {
    const onToggle = vi.fn();
    act(() => root.render(<PopulationChecklist compact rows={ROWS} selected={["cd4"]} onToggle={onToggle} label="Test populations" />));
    expect(host.querySelector('[role="group"]')!.getAttribute("aria-label")).toBe("Test populations");
    expect(host.querySelector(".gl-picker-summary")!.textContent).toBe("1 of 3 selected");
    expect(rows().map((row) => row.querySelector("input")!.checked)).toEqual([false, true, false]);
    expect(rows()[1].querySelector<HTMLElement>(".gl-strategy-pop-swatch")!.style.background).toBe("rgb(255, 127, 14)");
    // A population without a colour keeps the swatch's space.
    expect(rows()[2].querySelector<HTMLElement>(".gl-strategy-pop-swatch")!.style.visibility).toBe("hidden");
    act(() => rows()[2].querySelector("input")!.click());
    expect(onToggle).toHaveBeenLastCalledWith("cd8");
    type(host.querySelector<HTMLInputElement>('input[type="search"]')!, "cd8");
    expect(rows().map((row) => row.title)).toEqual(["CD8_positive"]);
  });

  it("matches the search on the text a row gives, and leaves the heading to the tab when asked", () => {
    const withTree = ROWS.map((row) => ({ ...row, searchText: `${row.name} Tree_B1` }));
    act(() => root.render(<PopulationChecklist compact heading={false} rows={withTree} selected={[]} onToggle={vi.fn()} />));
    expect(host.querySelector(".gl-picker-summary")).toBeNull();
    expect(host.querySelector(".gl-picker-collapse-toggle")).toBeNull();
    type(host.querySelector<HTMLInputElement>('input[type="search"]')!, "tree_b1");
    expect(rows()).toHaveLength(3);
  });

  it("picks one population when choosing, the current one pressed", () => {
    const onPick = vi.fn();
    const onToggle = vi.fn();
    act(() => root.render(
      <PopulationChecklist compact rows={ROWS} selected={[]} onToggle={onToggle} pick={{ current: "lymph", onPick, title: (name) => `Compose within ${name}` }} />,
    ));
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(rows().map((row) => [row.tagName, row.getAttribute("aria-pressed"), row.title])).toEqual([
      ["BUTTON", "true", "Compose within Lymphocytes"],
      ["BUTTON", "false", "Compose within CD4_positive"],
      ["BUTTON", "false", "Compose within CD8_positive"],
    ]);
    act(() => (rows()[1] as HTMLButtonElement).click());
    expect(onPick).toHaveBeenCalledWith("cd4");
    expect(onToggle).not.toHaveBeenCalled();
  });
});
