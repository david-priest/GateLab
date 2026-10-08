// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newGate, newPopulation, newRootPopulation, type PopulationMap } from "../engine/models";
import { I18nProvider } from "./i18n";
import { packColumns, StrategyPopulationPicker } from "./StrategyPopulationPicker";

describe("packColumns", () => {
  it("breaks at the shallowest point late in a column, and only there", () => {
    // Two branches of 8 and 7 rows: with 12 per column the break lands where the second starts.
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => ({ depth: i === 0 ? 1 : 2, id: `a${i}` })),
      ...Array.from({ length: 7 }, (_, i) => ({ depth: i === 0 ? 1 : 2, id: `b${i}` })),
    ];
    const cols = packColumns(rows, 12);
    expect(cols.map((c) => c.length)).toEqual([8, 7]);
    expect(cols[1][0].id).toBe("b0");
    // A branch longer than a column is split at the limit.
    const long = Array.from({ length: 30 }, (_, i) => ({ depth: i === 0 ? 1 : 3, id: `c${i}` }));
    expect(packColumns(long, 12).map((c) => c.length)).toEqual([12, 12, 6]);
    expect(packColumns([], 12)).toEqual([]);
  });
});

const gLymph = newGate("Lymphocytes", "polygon", "a", "b", [[0, 0], [1, 0], [1, 1]], "#111111");
const gB = newGate("B cells", "polygon", "a", "b", [[0, 0], [1, 0], [1, 1]], "#222222");
const gT = newGate("T cells", "polygon", "a", "b", [[0, 0], [1, 0], [1, 1]], "#333333");
const root = newRootPopulation(10);
const lymph = { ...newPopulation("Lymphocytes", [{ gate_id: gLymph.gate_id, include: true }], root.population_id), population_id: "lymph" };
const b = { ...newPopulation("B cells", [{ gate_id: gB.gate_id, include: true }], "lymph"), population_id: "b" };
const t = { ...newPopulation("T cells", [{ gate_id: gT.gate_id, include: true }], "lymph"), population_id: "t" };
const populations: PopulationMap = { [root.population_id]: root, lymph, b, t };
const rows = [
  { popId: "lymph", depth: 1, isLastPath: [true] },
  { popId: "b", depth: 2, isLastPath: [true, false] },
  { popId: "t", depth: 2, isLastPath: [true, true] },
];

let host: HTMLDivElement;
let reactRoot: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  reactRoot = createRoot(host);
});
afterEach(() => {
  act(() => reactRoot.unmount());
  host.remove();
});

const rowByTitle = (title: string) => host.querySelector<HTMLElement>(`.gl-strategy-pop-row[title="${title}"]`)!;
const button = (label: string) => Array.from(host.querySelectorAll("button")).find((el) => el.textContent?.trim() === label)!;
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("StrategyPopulationPicker", () => {
  it("lists the tree with the gate's colour and the count, selects, and offers the Gating tab's ticks and the leaves", () => {
    const onChange = vi.fn();
    act(() => {
      reactRoot.render(
        <I18nProvider>
          <StrategyPopulationPicker
            rows={rows}
            populations={populations}
            gates={{ [gLymph.gate_id]: gLymph, [gB.gate_id]: gB, [gT.gate_id]: gT }}
            counts={{ lymph: 1000, b: 300, t: 650 }}
            selected={["b"]}
            onChange={onChange}
            checkedIds={["t"]}
          />
        </I18nProvider>,
      );
    });
    expect(host.querySelector(".gl-picker-summary")?.textContent).toBe("1 of 3 selected");
    const bRow = rowByTitle("B cells");
    expect(bRow.className).toContain("is-selected");
    expect(bRow.querySelector(".gl-strategy-pop-count")?.textContent).toBe("300");
    // jsdom keeps the colour as written; the swatch is the B gate's.
    expect((bRow.querySelector(".gl-strategy-pop-swatch") as HTMLElement).getAttribute("style")).toContain("rgb(34, 34, 34)");
    // The tree: the leaves carry connectors, the top row none.
    expect(rowByTitle("Lymphocytes").querySelector("svg")).toBeNull();
    expect(rowByTitle("T cells").querySelectorAll("svg line").length).toBeGreaterThan(0);
    click(rowByTitle("T cells").querySelector("input")!);
    expect(onChange).toHaveBeenLastCalledWith(["b", "t"]);
    click(button("Use checked"));
    expect(onChange).toHaveBeenLastCalledWith(["t"]);
    click(button("Leaves"));
    expect(onChange).toHaveBeenLastCalledWith(["b", "t"]);
    click(button("All"));
    expect(onChange).toHaveBeenLastCalledWith(["lymph", "b", "t"]);
    click(button("None"));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("folds away to its heading, count and actions, and back", () => {
    act(() => {
      reactRoot.render(
        <I18nProvider>
          <StrategyPopulationPicker rows={rows} populations={populations} gates={{}} counts={{}} selected={["b"]} onChange={() => undefined} />
        </I18nProvider>,
      );
    });
    const toggle = host.querySelector<HTMLButtonElement>(".gl-picker-collapse-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll(".gl-strategy-pop-row")).toHaveLength(3);
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".gl-strategy-pops-body")).toBeNull();
    expect(host.querySelector(".gl-picker-summary")?.textContent).toBe("1 of 3 selected");
    expect(button("Leaves")).toBeTruthy();
    click(toggle);
    expect(host.querySelectorAll(".gl-strategy-pop-row")).toHaveLength(3);
  });

  it("finds populations by name, flat", () => {
    act(() => {
      reactRoot.render(
        <I18nProvider>
          <StrategyPopulationPicker rows={rows} populations={populations} gates={{}} counts={{}} selected={[]} onChange={() => undefined} />
        </I18nProvider>,
      );
    });
    const search = host.querySelector<HTMLInputElement>(".gl-strategy-pops-search")!;
    type(search, "cells");
    expect(Array.from(host.querySelectorAll(".gl-strategy-pop-name")).map((n) => n.textContent)).toEqual(["B cells", "T cells"]);
    expect(host.querySelector(".gl-strategy-pop-row svg")).toBeNull();
    type(search, "zzz");
    expect(host.querySelector(".gl-strategy-pops-empty")?.textContent).toBe("No population matches");
  });
});
