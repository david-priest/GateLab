// The Plotting tab's Panels control, its pure parts: the sentence that sums an arrangement up, and
// what a move carried along besides what was asked. No events are drawn; the dimensions are named
// as a synthetic chart would name them (population, file, condition, channel).

import { describe, expect, it } from "vitest";
import { movedAlong, panelLayoutSummary, panelPlacements } from "./PanelLayoutControl";
import type { ChartDimension, ChartShelves } from "./plottingShelves";

const t = (text: string, values: Record<string, string> = {}) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);
const noun = (dimension: ChartDimension) => ({ populations: "population", groups: "condition", facet: "file", channels: "channel" })[dimension];
const shelves = (over: Partial<ChartShelves>): ChartShelves => ({ x: ["populations"], columns: [], rows: [], pages: [], wrap: [], stack: false, ...over });

describe("Panels control: the sentence under it", () => {
  it("says one panel when nothing makes panels, and what each panel draws", () => {
    expect(panelLayoutSummary(shelves({}), noun, "a ridge", 5, t)).toBe("One panel; in each panel, a ridge per population.");
  });

  it("names columns, rows, wrapped panels and pages in that order", () => {
    expect(panelLayoutSummary(shelves({ columns: ["channels"], rows: ["groups"] }), noun, "a ridge", 5, t)).toBe("A column per channel and a row per condition; in each panel, a ridge per population.");
    expect(panelLayoutSummary(shelves({ wrap: ["channels", "facet"] }), noun, "a violin", 4, t)).toBe("A panel per channel and file, 4 to a row; in each panel, a violin per population.");
    expect(panelLayoutSummary(shelves({ rows: ["channels"], wrap: ["facet"] }), noun, "a box", 5, t)).toBe("A row per channel and the panels for each file across the columns; in each panel, a box per population.");
    expect(panelLayoutSummary(shelves({ x: ["groups"], columns: ["populations"], pages: ["channels"] }), noun, "a box", 5, t)).toBe("A column per population and a page per channel, one shown at a time; in each panel, a box per condition.");
  });

  it("says a stacked bar's populations are stacked, and populations side by side at each group", () => {
    expect(panelLayoutSummary(shelves({ x: ["groups"], stack: true }), noun, "a box", 5, t)).toBe("One panel; in each panel, a bar per condition, its populations stacked.");
    expect(panelLayoutSummary(shelves({ x: ["groups"] }), noun, "a box", 5, t, true)).toBe("One panel; in each panel, a box per population at each condition.");
  });
});

describe("Panels control: what moved along", () => {
  it("lists the dimensions a move displaced, never the one moved", () => {
    const before = shelves({ columns: ["facet"], wrap: ["groups"] });
    const after = shelves({ columns: ["groups"], wrap: ["facet"] });
    expect(movedAlong(before, after, "groups")).toEqual([{ dimension: "facet", place: "wrap" }]);
    expect(movedAlong(before, before, "groups")).toEqual([]);
  });

  it("counts a swap inside each panel: the dimension leaving takes a panel place", () => {
    const before = shelves({ x: ["populations"], wrap: ["groups"] });
    const after = shelves({ x: ["groups"], wrap: ["populations"] });
    expect(movedAlong(before, after, "groups")).toEqual([{ dimension: "populations", place: "wrap" }]);
    expect(panelPlacements(after)).toEqual([{ dimension: "populations", place: "wrap" }]);
  });
});
