// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { tidyLayout, type MultiStrategyNode } from "../engine/multiStrategy";
import {
  arrowPathFromPoints,
  arrowRouteKind,
  drawStrategyArrows,
  polygonCentroid,
  routeArrow,
  strategyArrowGap,
  strategyArrowRowGap,
  strategyArrows,
  type GridPlaces,
  type StrategyArrow,
} from "./strategyArrows";

const node = (id: string, parentPop: string, gates: { gate_id: string; color: string }[], row = 0, col = 0): MultiStrategyNode => ({
  node_id: id,
  parent_pop_id: parentPop,
  parent_pop_name: parentPop,
  x_channel: "CD3",
  y_channel: "CD19",
  row,
  col,
  n_events: 10,
  x_range: [0, 1],
  y_range: [0, 1],
  x: [],
  y: [],
  gates: gates.map((g) => ({ gate_id: g.gate_id, name: g.gate_id, gate_type: "polygon", vertices: [], color: g.color, label_offset: null, percent_of_parent: 50, include: true })),
  x_is_logicle: false,
  x_logicle_ticks: null,
  y_is_logicle: false,
  y_logicle_ticks: null,
});

const populations = {
  root: { parent_id: null, gate_refs: [] },
  lymph: { parent_id: "root", gate_refs: [{ gate_id: "g-lymph" }] },
  b: { parent_id: "lymph", gate_refs: [{ gate_id: "g-b" }] },
  t: { parent_id: "lymph", gate_refs: [{ gate_id: "g-t" }] },
  naive: { parent_id: "t", gate_refs: [{ gate_id: "g-naive" }] },
};

const none = { v: 0, h: 0, v2: 0 };

describe("strategyArrows", () => {
  it("links each gate to the panel of the population it makes, with its route, and only that", () => {
    const nodes = [
      node("root|a|b", "root", [{ gate_id: "g-lymph", color: "#111" }], 0, 0),
      node("lymph|a|b", "lymph", [{ gate_id: "g-b", color: "#222" }, { gate_id: "g-t", color: "#333" }], 0, 1),
      node("t|a|b", "t", [{ gate_id: "g-naive", color: "#444" }], 0, 2),
      node("t|c|d", "t", [], 1, 2), // the same population on other channels: its own arrow
    ];
    const arrows = strategyArrows(nodes, populations);
    expect(arrows).toEqual([
      { fromNodeId: "root|a|b", gateId: "g-lymph", toNodeId: "lymph|a|b", color: "#111", from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, route: "across", lanes: none },
      { fromNodeId: "lymph|a|b", gateId: "g-t", toNodeId: "t|a|b", color: "#333", from: { row: 0, col: 1 }, to: { row: 0, col: 2 }, route: "across", lanes: none },
      { fromNodeId: "lymph|a|b", gateId: "g-t", toNodeId: "t|c|d", color: "#333", from: { row: 0, col: 1 }, to: { row: 1, col: 2 }, route: "side", lanes: none },
    ]);
    // B cells are gated but not drawn: no arrow for g-b.
    expect(arrows.some((a) => a.gateId === "g-b")).toBe(false);
  });

  // Two lines down one gutter ran on top of one another, or a hair apart, and could not be told
  // apart. Each gate's line has a lane of its own; one gate's lines to several panels share theirs.
  it("gives the lines of different gates their own lanes in a gutter, and widens the gutter to hold them", () => {
    const pops = {
      root: { parent_id: null, gate_refs: [] },
      a: { parent_id: "root", gate_refs: [{ gate_id: "gA" }] },
      b: { parent_id: "root", gate_refs: [{ gate_id: "gB" }] },
      c: { parent_id: "root", gate_refs: [{ gate_id: "gC" }] },
    };
    const nodes = [
      node("root|x|y", "root", [{ gate_id: "gA", color: "#111" }, { gate_id: "gB", color: "#222" }, { gate_id: "gC", color: "#333" }], 0, 0),
      node("a|x|y", "a", [], 1, 1),
      node("a|u|v", "a", [], 2, 1),
      node("b|x|y", "b", [], 3, 1),
      node("c|x|y", "c", [], 4, 1),
    ];
    const arrows = strategyArrows(nodes, pops);
    expect(arrows.map((a) => [a.gateId, a.route, a.lanes.v])).toEqual([
      ["gA", "side", 0], ["gA", "side", 0], ["gB", "side", 1], ["gC", "side", 2],
    ]);
    // Three lanes: the first 6 px in, 7 px apart, and 16 px for the head on the last run.
    expect(strategyArrowGap(arrows)).toBe(6 + 7 * 2 + 16);
    expect(strategyArrowGap(arrows.slice(0, 2))).toBe(28);
    expect(strategyArrowGap([])).toBe(28);
    // None of these lines runs between two rows, so the rows keep the plain gap.
    expect(strategyArrowRowGap(arrows)).toBe(8);
    expect(strategyArrowRowGap([])).toBe(8);
  });

  it("keeps room between the rows only where a line runs there", () => {
    const pops = {
      root: { parent_id: null, gate_refs: [] },
      a: { parent_id: "root", gate_refs: [{ gate_id: "gA" }] },
      b: { parent_id: "root", gate_refs: [{ gate_id: "gB" }] },
    };
    // A wrapped grid: one child straight below its parent, the other two columns along its row.
    const nodes = [
      node("root|x|y", "root", [{ gate_id: "gA", color: "#111" }, { gate_id: "gB", color: "#222" }], 0, 0),
      node("a|x|y", "a", [], 1, 0),
      node("b|x|y", "b", [], 0, 2),
    ];
    const arrows = strategyArrows(nodes, pops);
    expect(arrows.map((a) => a.route)).toEqual(["down", "under"]);
    expect(strategyArrowRowGap(arrows)).toBe(28);
    expect(strategyArrowRowGap(arrows.slice(0, 1))).toBe(28);
  });

  // Reported on a strategy to T and B cell populations: two branches were given the same cells,
  // the renderer moved one of them along its row, and the arrows, routed for the places the
  // layout had named, ran across the panels.
  it("routes a tree layout's arrows across a gutter or down one, never between two rows", () => {
    const pops = {
      root: { parent_id: null, gate_refs: [] },
      t: { parent_id: "root", gate_refs: [{ gate_id: "gT" }] },
      b: { parent_id: "root", gate_refs: [{ gate_id: "gB" }] },
      t1: { parent_id: "t", gate_refs: [{ gate_id: "gT1" }] },
      t2: { parent_id: "t", gate_refs: [{ gate_id: "gT2" }] },
      b1: { parent_id: "b", gate_refs: [{ gate_id: "gB1" }] },
    };
    const laid = tidyLayout([
      node("root|x|y", "root", [{ gate_id: "gT", color: "#111" }, { gate_id: "gB", color: "#222" }]),
      node("t|x|y", "t", [{ gate_id: "gT1", color: "#111" }, { gate_id: "gT2", color: "#111" }]),
      node("b|x|y", "b", [{ gate_id: "gB1", color: "#222" }]),
      node("t1|x|y", "t1", []),
      node("t2|x|y", "t2", []),
      node("b1|x|y", "b1", []),
    ], pops);
    const arrows = strategyArrows(laid, pops);
    expect(arrows).toHaveLength(5);
    expect(arrows.every((a) => a.route === "across" || a.route === "side")).toBe(true);
    expect(arrows.every((a) => a.to.col === a.from.col + 1)).toBe(true);
    expect(strategyArrowRowGap(arrows)).toBe(8);
  });
});

describe("arrowRouteKind", () => {
  it("names the way from a panel to its child's", () => {
    const occupied = new Set(["0|0", "0|1", "1|1", "2|1", "2|2", "0|3"]);
    expect(arrowRouteKind({ row: 0, col: 0 }, { row: 0, col: 1 }, occupied)).toBe("across");
    expect(arrowRouteKind({ row: 0, col: 1 }, { row: 1, col: 1 }, occupied)).toBe("down");
    expect(arrowRouteKind({ row: 0, col: 0 }, { row: 1, col: 1 }, occupied)).toBe("side");
    // A panel of the child's row lies between; or the child is in the parent's column or before it.
    expect(arrowRouteKind({ row: 0, col: 0 }, { row: 2, col: 2 }, occupied)).toBe("over");
    expect(arrowRouteKind({ row: 0, col: 1 }, { row: 2, col: 1 }, occupied)).toBe("over");
    expect(arrowRouteKind({ row: 0, col: 3 }, { row: 1, col: 1 }, occupied)).toBe("over");
    expect(arrowRouteKind({ row: 0, col: 1 }, { row: 0, col: 3 }, occupied)).toBe("under");
  });
});

// A grid of 100 px cells with 30 px gutters: column c spans [130c, 130c + 100], row r the same.
const cell = (row: number, col: number) => ({ left: 130 * col, top: 130 * row, right: 130 * col + 100, bottom: 130 * row + 100 });
const places = (taken: [number, number][]): GridPlaces => ({
  cols: new Map(taken.map(([, c]) => [c, { left: 130 * c, right: 130 * c + 100 }])),
  rows: new Map(taken.map(([r]) => [r, { top: 130 * r, bottom: 130 * r + 100 }])),
  gap: 30,
});
const way = (from: [number, number], to: [number, number], route: StrategyArrow["route"], lanes: Partial<StrategyArrow["lanes"]> = {}) =>
  ({ from: { row: from[0], col: from[1] }, to: { row: to[0], col: to[1] }, route, lanes: { ...none, ...lanes } });

describe("routeArrow", () => {
  it("crosses the gutter straight to a child beside the parent, level with the label", () => {
    const grid = places([[0, 0], [0, 1]]);
    expect(routeArrow(cell(0, 0), cell(0, 1), way([0, 0], [0, 1], "across"), grid, 30)).toEqual([[100, 30], [130, 30]]);
    // The label's level is kept inside the panel.
    expect(routeArrow(cell(0, 0), cell(0, 1), way([0, 0], [0, 1], "across"), grid, 2)![0][1]).toBe(10);
  });

  it("goes straight down to a child right below", () => {
    expect(routeArrow(cell(0, 1), cell(1, 1), way([0, 1], [1, 1], "down"), places([[0, 1], [1, 1]]), 40)).toEqual([[180, 100], [180, 130]]);
  });

  it("goes down the gutter right of the parent, in its lane, and in at the child's left", () => {
    const grid = places([[0, 2], [0, 3], [1, 3]]);
    // Out at the right edge (x = 360), the first lane 6 px into the gutter, down to the child's entry, in.
    expect(routeArrow(cell(0, 2), cell(1, 3), way([0, 2], [1, 3], "side"), grid, 40)).toEqual([[360, 40], [366, 40], [366, 165], [390, 165]]);
    // The next lane runs 7 px further in: two lines down one gutter stay apart.
    expect(routeArrow(cell(0, 2), cell(1, 3), way([0, 2], [1, 3], "side", { v: 1 }), grid, 40)![1]).toEqual([373, 40]);
  });

  it("takes the gutter above the child's row, in its lane, and drops into the child's top", () => {
    const grid = places([[0, 2], [0, 3], [1, 3], [2, 3], [2, 4]]);
    expect(routeArrow(cell(0, 2), cell(2, 4), way([0, 2], [2, 4], "over"), grid, 40)).toEqual([[360, 40], [366, 40], [366, 236], [570, 236], [570, 260]]);
    expect(routeArrow(cell(0, 2), cell(2, 4), way([0, 2], [2, 4], "over", { h: 1 }), grid, 40)![2]).toEqual([366, 243]);
    // A child in the parent's own column: never across the child's own panel.
    expect(routeArrow(cell(0, 3), cell(2, 3), way([0, 3], [2, 3], "over"), places([[0, 3], [1, 3], [2, 3]]), 40))
      .toEqual([[490, 40], [496, 40], [496, 236], [440, 236], [440, 260]]);
  });

  it("goes under the row and up to a child further along the parent's own row", () => {
    const grid = places([[0, 1], [0, 2], [0, 3], [1, 1]]);
    expect(routeArrow(cell(0, 1), cell(0, 3), way([0, 1], [0, 3], "under"), grid, 50))
      .toEqual([[230, 50], [236, 50], [236, 106], [366, 106], [366, 35], [390, 35]]);
  });

  it("is null for a child in the parent's own cell", () => {
    expect(routeArrow(cell(0, 0), cell(0, 0), way([0, 0], [0, 0], "side"), places([[0, 0]]), 10)).toBeNull();
  });
});

describe("arrowPathFromPoints", () => {
  it("rounds the corners, stops short of the last point, and heads along the last segment", () => {
    const g = arrowPathFromPoints([[0, 0], [50, 0], [50, 100], [100, 100]])!;
    expect(g.path.startsWith("M0,0 L43,0 Q50,0 50,7")).toBe(true);
    // The head is 10 px long and 10 wide at the default line, its tip 3 px short of the last
    // point; the line stops a pixel inside the head's base (x = 88), not at the tip.
    expect(g.head).toBe("M97,100 L87,105 L87,95 Z");
    expect(g.path.endsWith("L88,100")).toBe(true);
    // A last run shorter than the head: the line ends where the run begins, never backwards.
    expect(arrowPathFromPoints([[0, 0], [50, 0], [50, 12]])!.path).toBe("M0,0 L45.5,0 Q50,0 50,4.5 L50,4.5");
    expect(arrowPathFromPoints([[0, 0], [100, 0]], 3, 7, 3)!.head).toBe("M97,0 L84,6.5 L84,-6.5 Z");
    expect(arrowPathFromPoints([[0, 0]])).toBeNull();
  });
});

describe("polygonCentroid", () => {
  it("is the centre of area, not the mean of the corners", () => {
    expect(polygonCentroid([[0, 0], [2, 0], [2, 2], [0, 2]])).toEqual([1, 1]);
    expect(polygonCentroid([[0, 0], [3, 0], [0, 3]])).toEqual([1, 1]);
    // Extra points along one edge pull a mean of the points toward it; the centre of area stays.
    const crowded = polygonCentroid([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 4], [0, 4]])!;
    expect(crowded[0]).toBeCloseTo(2, 9);
    expect(crowded[1]).toBeCloseTo(2, 9);
    // No area: the mean of the points. No points: nothing.
    expect(polygonCentroid([[0, 0], [2, 2], [4, 4]])).toEqual([2, 2]);
    expect(polygonCentroid([])).toBeNull();
  });
});

describe("drawStrategyArrows", () => {
  it("draws one group per arrow over the grid, level with the gate's label, and replaces itself", () => {
    document.body.innerHTML = `
      <div id="c"><div class="multi-strategy-grid">
        <div class="mini-plot-cell" data-plot-key="root|a|b"><svg><path data-gate-shape="g-lymph" d="M10,10L30,10L30,90L10,90Z"></path><g data-gate-id="g-lymph"></g></svg></div>
        <div class="mini-plot-cell" data-plot-key="lymph|a|b"></div>
      </div></div>`;
    const rects: Record<string, DOMRect> = {
      grid: new DOMRect(0, 0, 500, 200),
      "root|a|b": new DOMRect(0, 0, 200, 200),
      "lymph|a|b": new DOMRect(300, 0, 200, 200),
      label: new DOMRect(60, 20, 50, 16),
    };
    const grid = document.querySelector<HTMLElement>(".multi-strategy-grid")!;
    grid.getBoundingClientRect = () => rects.grid;
    grid.querySelectorAll<HTMLElement>(".mini-plot-cell").forEach((cell) => { cell.getBoundingClientRect = () => rects[cell.getAttribute("data-plot-key")!]; });
    (grid.querySelector("[data-gate-id]") as SVGElement).getBoundingClientRect = () => rects.label;
    // The gate's shape, a rectangle whose centre is at y = 140 on screen (its points span 10 … 90).
    (grid.querySelector("[data-gate-shape]") as SVGElement).getBoundingClientRect = () => new DOMRect(50, 100, 40, 80);
    const container = document.getElementById("c") as HTMLElement;
    const arrows: StrategyArrow[] = [{ fromNodeId: "root|a|b", gateId: "g-lymph", toNodeId: "lymph|a|b", color: "#e41a1c", from: { row: 0, col: 0 }, to: { row: 0, col: 1 }, route: "across", lanes: none }];
    expect(drawStrategyArrows(container, arrows, { color: null, width: 1.5 })).toBe(1);
    const overlay = grid.querySelector("svg.gl-strategy-arrows")!;
    expect(overlay.querySelectorAll("g[data-arrow-gate]")).toHaveLength(1);
    expect(overlay.querySelector("path")!.getAttribute("stroke")).toBe("#e41a1c");
    expect(overlay.querySelector("path")!.getAttribute("stroke-width")).toBe("1.5");
    // Out of the panel's right edge (x = 200), level with the label (y = 28), straight across.
    expect(overlay.querySelector("path")!.getAttribute("d")).toBe("M200,28 L288,28");
    // The line is slightly transparent; the head over its end is solid.
    const [line, head] = [...overlay.querySelectorAll("g[data-arrow-gate] path")];
    expect(line.getAttribute("opacity")).toBe("0.85");
    expect(head.getAttribute("opacity")).toBeNull();
    expect(head.getAttribute("d")).toBe("M297,28 L287,33 L287,23 Z");
    // Asked to start from the gate rather than its label: level with the shape's centroid.
    expect(drawStrategyArrows(container, arrows, { color: null, width: 1.5, anchor: "gate" })).toBe(1);
    expect(grid.querySelector("svg.gl-strategy-arrows path")!.getAttribute("d")).toBe("M200,140 L288,140");
    // A gate with no shape drawn here keeps its label's level.
    expect(drawStrategyArrows(container, [{ ...arrows[0], gateId: "other" }], { color: null, width: 1.5, anchor: "gate" })).toBe(1);
    expect(grid.querySelector("svg.gl-strategy-arrows path")!.getAttribute("d")).toBe("M200,100 L288,100");
    expect(drawStrategyArrows(container, arrows, { color: null, width: 1.5 })).toBe(1);
    // A gutter is kept on the grid's right and below it, so a line past the last column or under
    // the last row is inside the grid's own box rather than cut off by what scrolls it.
    expect(grid.style.paddingRight).toBe("8px");
    expect(grid.style.paddingBottom).toBe("8px");
    // Publication style: the arrows go dark, whatever the gate's colour; a heavier line is asked for.
    expect(drawStrategyArrows(container, arrows, { color: "#444444", width: 3 })).toBe(1);
    expect(grid.querySelectorAll("svg.gl-strategy-arrows")).toHaveLength(1);
    expect(grid.querySelector("svg.gl-strategy-arrows path")!.getAttribute("stroke")).toBe("#444444");
    expect(grid.querySelector("svg.gl-strategy-arrows path")!.getAttribute("stroke-width")).toBe("3");
    // None asked for: the overlay goes.
    expect(drawStrategyArrows(container, [], { color: null, width: 1 })).toBe(0);
    expect(grid.querySelector("svg.gl-strategy-arrows")).toBeNull();
  });
});
