// @vitest-environment jsdom
// The gating tree a Strategy export carries: the rows (the populations drawn and their
// ancestors, in tree order, with the glyphs of that tree, the counts and the % of parent), and
// the page they are drawn on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Population, PopulationMap } from "../engine/models";
import { composeStrategyTree, strategyTreeRows } from "./strategyTree";
import { TREE_LINE_COLOR, treeConnectorLines } from "./TreeConnectors";

function pop(id: string, name: string, parent: string | null, children: string[] = []): Population {
  return { population_id: id, name, gate_refs: [], gate_logic: "and", parent_id: parent, children } as unknown as Population;
}

/** All Events › Lymphocytes › (CD4_positive, CD8_positive); All Events › Debris. Ten events. */
function tree(): PopulationMap {
  return {
    root: pop("root", "All Events", null, ["lymph", "debris"]),
    lymph: pop("lymph", "Lymphocytes", "root", ["cd4", "cd8"]),
    cd4: pop("cd4", "CD4_positive", "lymph"),
    cd8: pop("cd8", "CD8_positive", "lymph"),
    debris: pop("debris", "Debris", "root"),
  };
}

const mask = (...members: number[]) => {
  const out = new Uint8Array(10);
  for (const i of members) out[i] = 1;
  return out;
};
const masks = {
  root: mask(0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
  lymph: mask(1, 2, 3, 4, 5, 6, 7),
  cd4: mask(1, 2, 3),
  cd8: mask(4, 5),
  debris: mask(0, 8, 9),
};

describe("the gating tree's rows", () => {
  it("are the populations drawn and their ancestors, in tree order, with that tree's glyphs", () => {
    const rows = strategyTreeRows(tree(), "root", ["cd8", "cd4"], masks, 10);
    expect(rows.map((row) => row.name)).toEqual(["All Events", "Lymphocytes", "CD4_positive", "CD8_positive"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 2]);
    // Lymphocytes is the root's last child in this tree, though Debris follows it in the whole one.
    expect(rows.map((row) => row.isLastPath)).toEqual([[], [true], [true, false], [true, true]]);
  });

  it("count each population from its mask, the root from the file, and give the % of parent to one decimal", () => {
    const rows = strategyTreeRows(tree(), "root", ["cd4", "cd8"], masks, 10);
    expect(rows.map((row) => [row.count, row.percentOfParent])).toEqual([
      [10, null],
      [7, 70],
      [3, 42.9],
      [2, 28.6],
    ]);
  });

  it("follow a single population's path only", () => {
    const rows = strategyTreeRows(tree(), "root", ["cd4"], masks, 10);
    expect(rows.map((row) => row.name)).toEqual(["All Events", "Lymphocytes", "CD4_positive"]);
    expect(rows[2].isLastPath).toEqual([true, true]);
  });

  it("give no number where there is none to give", () => {
    const noCd8: Record<string, Uint8Array> = { ...masks, lymph: mask(), cd4: mask() };
    delete noCd8.cd8;
    const rows = strategyTreeRows(tree(), "root", ["cd4", "cd8"], noCd8, 10);
    // An empty parent leaves its children no share; a population without a mask has no count.
    expect(rows.map((row) => [row.count, row.percentOfParent])).toEqual([
      [10, null],
      [0, 0],
      [0, null],
      [null, null],
    ]);
  });
});

describe("the gating tree's page", () => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  beforeEach(() => {
    // A canvas that measures every character 6 px wide, so the page's widths are known.
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => ({ font: "", measureText: (text: string) => ({ width: text.length * 6 }) }),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).getContext;
  });

  it("draws a titled table, one named group per population, with the tree panel's glyphs", () => {
    const rows = strategyTreeRows(tree(), "root", ["cd4", "cd8"], masks, 10);
    const page = composeStrategyTree(rows, { title: "Gating tree · D1.fcs", fontSize: 12 });
    const root = page.root;
    expect(root.namespaceURI).toBe(SVG_NS);
    expect(root.getAttribute("viewBox")).toBe(`0 0 ${page.width} ${page.height}`);
    expect(root.getAttribute("width")).toMatch(/mm$/);
    expect(root.querySelector("#gating-tree-title")!.textContent).toBe("Gating tree · D1.fcs");
    expect([...root.querySelectorAll("#gating-tree-header text")].map((text) => text.textContent)).toEqual(["Population", "Events", "% of parent"]);

    const groups = [...root.querySelectorAll("#gating-tree > g[id^='row-']")];
    expect(groups.map((group) => group.getAttribute("id"))).toEqual(["row-1-All-Events", "row-2-Lymphocytes", "row-3-CD4_positive", "row-4-CD8_positive"]);
    const texts = groups.map((group) => [...group.querySelectorAll(":scope > text")].map((text) => text.textContent));
    expect(texts).toEqual([
      ["All Events", "10"],
      ["Lymphocytes", "7", "70.0%"],
      ["CD4_positive", "3", "42.9%"],
      ["CD8_positive", "2", "28.6%"],
    ]);
    // The numbers are set right, in the export font.
    const numbers = groups[1].querySelectorAll(":scope > text");
    expect(numbers[1].getAttribute("text-anchor")).toBe("end");
    expect(numbers[1].getAttribute("font-family")).toBe("Arial, Helvetica, sans-serif");

    // Each row's glyphs are the tree panel's lines for that row, at the row's height.
    const rowHeight = 21;
    rows.forEach((row, index) => {
      const drawn = [...groups[index].querySelectorAll("line")].map((line) => ["x1", "y1", "x2", "y2"].map((key) => Number(line.getAttribute(key))));
      const expected = treeConnectorLines(row.depth, row.isLastPath, rowHeight / 2, rowHeight).map((line) => [line.x1, line.y1, line.x2, line.y2].map(Number));
      expect(drawn).toEqual(expected);
      for (const line of groups[index].querySelectorAll("line")) expect(line.getAttribute("stroke")).toBe(TREE_LINE_COLOR);
    });
    // CD4_positive: │ under Lymphocytes is not carried (it is the last child), ├ at its own level.
    expect(groups[2].querySelectorAll("line")).toHaveLength(2);
  });

  it("sizes the page to its longest name and numbers", () => {
    const rows = strategyTreeRows(tree(), "root", ["cd4", "cd8"], masks, 10);
    const page = composeStrategyTree(rows, { title: "T", fontSize: 12 });
    // Name column: CD4_positive at depth 2, 2 × 16 + 4 + 12 × 6 = 108; then 24, "Events" 36, 24, "% of parent" 66; 12 either side.
    expect(page.width).toBe(12 + 108 + 24 + 36 + 24 + 66 + 12);
    // Title 23 px, a header row and its rule (21 + 2), four rows of 21, 12 below.
    expect(page.height).toBe(12 + 23 + 21 + 2 + 4 * 21 + 12);
  });
});
