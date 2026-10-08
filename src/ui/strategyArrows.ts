// strategyArrows.ts — arrows on the multi-population strategy grid, from the gate on a panel to
// the panel of the population that gate makes. The grid places a population's panel right of
// (or below right of) the panel its parent was gated on, so the arrows read the tree as a
// figure does: one per gate whose child is drawn, leaving the parent's panel level with that
// gate's label and arriving at the child's panel. They run through the gutters between the
// cells, never across a panel, so no plot is drawn over. Drawn as an SVG over the grid, so the
// export carries them (gridExport).

import type { MultiStrategyNode } from "../engine/multiStrategy";

/**
 * How an arrow gets from its gate's panel to the child's:
 * - "across": the child is right next to the parent in its row; straight across the gutter;
 * - "down": the child is right below in the parent's column; straight down the gutter;
 * - "side": down the gutter right of the parent's column and in at the child's left edge;
 * - "over": as "side", but a panel of the child's row lies between (or the child is not to the
 *   right of the parent): along the gutter above the child's row and down into its top;
 * - "under": the child is further along the parent's own row: under the row, and up the gutter
 *   left of the child into its left edge.
 */
export type ArrowRoute = "across" | "down" | "side" | "over" | "under";

export interface StrategyArrow {
  /** The node (panel) carrying the gate. */
  fromNodeId: string;
  gateId: string;
  /** The node drawing the population the gate makes. */
  toNodeId: string;
  /** The gate's colour, which the arrow takes outside publication style. */
  color: string;
  /** The two panels' places in the grid. */
  from: { row: number; col: number };
  to: { row: number; col: number };
  route: ArrowRoute;
  /**
   * The lane the arrow's line takes in each gutter it runs along, counted from the gutter's near
   * edge: `v` in the gutter right of the parent's column, `h` in the horizontal gutter it runs
   * along, `v2` in the gutter left of the child ("under" only). Lines of different gates never
   * share a lane in one gutter, so two that run side by side are told apart; the lines of one
   * gate to several children share theirs, as the trunk of a tree does.
   */
  lanes: { v: number; h: number; v2: number };
}

interface PopulationLike {
  parent_id: string | null;
  gate_refs: { gate_id: string }[];
}

/** The first lane's distance from a gutter's near edge, and the distance between lanes, px. */
export const ARROW_LANE_START = 6;
export const ARROW_LANE_STEP = 7;
/** The room a line's last run into a panel needs for its head, px. */
const ARROW_HEAD_ROOM = 16;

/** How an arrow between two places runs, given every taken cell ("row|col"). */
export function arrowRouteKind(
  from: { row: number; col: number },
  to: { row: number; col: number },
  occupied: ReadonlySet<string>,
): ArrowRoute {
  if (to.row === from.row && to.col === from.col + 1) return "across";
  if (to.col === from.col && to.row === from.row + 1) return "down";
  if (to.row === from.row) return "under";
  // A child in the parent's own column or before it (the grid wraps) cannot be entered from its
  // left along a clear row.
  let between = to.col <= from.col;
  for (let c = from.col + 1; c < to.col && !between; c++) if (occupied.has(`${to.row}|${c}`)) between = true;
  return between ? "over" : "side";
}

/**
 * The arrows a set of drawn nodes calls for: for every gate on a panel, every panel drawing a
 * population that gate makes under the panel's population. A population drawn on several
 * channel pairs gets an arrow to each of its panels. Each arrow is given its route and its
 * lanes here, where every panel's place is known.
 */
export function strategyArrows(
  nodes: readonly MultiStrategyNode[],
  populations: Record<string, PopulationLike>,
): StrategyArrow[] {
  const panelsOf = new Map<string, MultiStrategyNode[]>();
  for (const node of nodes) panelsOf.set(node.parent_pop_id, [...(panelsOf.get(node.parent_pop_id) ?? []), node]);
  const childrenOf = new Map<string, { popId: string; pop: PopulationLike }[]>();
  for (const [popId, pop] of Object.entries(populations)) {
    if (!pop.parent_id) continue;
    childrenOf.set(pop.parent_id, [...(childrenOf.get(pop.parent_id) ?? []), { popId, pop }]);
  }
  const occupied = new Set(nodes.map((node) => `${node.row}|${node.col}`));
  // A lane per line in each gutter: gutter "v<k>" is right of column k, "h<r>" above row r.
  const gutters = new Map<string, Map<string, number>>();
  const lane = (gutter: string, line: string): number => {
    let lines = gutters.get(gutter);
    if (!lines) gutters.set(gutter, (lines = new Map()));
    let index = lines.get(line);
    if (index === undefined) lines.set(line, (index = lines.size));
    return index;
  };
  const out: StrategyArrow[] = [];
  for (const parent of nodes) {
    const children = childrenOf.get(parent.parent_pop_id) ?? [];
    for (const gate of parent.gates) {
      for (const { popId, pop } of children) {
        if (!pop.gate_refs.some((ref) => ref.gate_id === gate.gate_id)) continue;
        for (const child of panelsOf.get(popId) ?? []) {
          if (child.node_id === parent.node_id) continue;
          const from = { row: parent.row, col: parent.col }, to = { row: child.row, col: child.col };
          const route = arrowRouteKind(from, to, occupied);
          const line = `${parent.node_id}|${gate.gate_id}`;
          const lanes = { v: 0, h: 0, v2: 0 };
          if (route === "side" || route === "over" || route === "under") lanes.v = lane(`v${from.col}`, line);
          if (route === "over") lanes.h = lane(`h${to.row}`, line);
          if (route === "under") {
            lanes.h = lane(`h${from.row + 1}`, line);
            lanes.v2 = lane(`v${to.col - 1}`, `to|${child.node_id}`);
          }
          out.push({ fromNodeId: parent.node_id, gateId: gate.gate_id, toNodeId: child.node_id, color: gate.color, from, to, route, lanes });
        }
      }
    }
  }
  return out;
}

/**
 * The gap the grid needs between its cells for these arrows: room for the busiest gutter's lanes
 * and for a head on the last run into a panel; 28 px at the least.
 */
export function strategyArrowGap(arrows: readonly StrategyArrow[]): number {
  let most = 0;
  for (const arrow of arrows) most = Math.max(most, arrow.lanes.v, arrow.lanes.h, arrow.lanes.v2);
  return Math.max(28, ARROW_LANE_START + ARROW_LANE_STEP * most + ARROW_HEAD_ROOM);
}

export interface Box { left: number; top: number; right: number; bottom: number }

/** Where the grid's columns and rows lie. */
export interface GridPlaces {
  /** The x extent of each column that has a cell, by column index. */
  cols: ReadonlyMap<number, { left: number; right: number }>;
  /** The y extent of each row that has a cell, by row index. */
  rows: ReadonlyMap<number, { top: number; bottom: number }>;
  /** The gap between cells, px. */
  gap: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The corners of an arrow from the parent's panel to the child's, through the gutters, by its
 * route (ArrowRoute) and in its lanes. It leaves the parent level with the gate's label. Null
 * when the two share a cell.
 */
export function routeArrow(
  from: Box,
  to: Box,
  arrow: Pick<StrategyArrow, "from" | "to" | "route" | "lanes">,
  places: GridPlaces,
  labelY: number,
): [number, number][] | null {
  const { gap } = places;
  const pr = arrow.from.row, pc = arrow.from.col, cr = arrow.to.row, cc = arrow.to.col;
  if (pr === cr && pc === cc) return null;
  const y0 = clamp(labelY, from.top + 10, from.bottom - 10);
  const entryY = to.top + 0.35 * (to.bottom - to.top);
  const midX = (to.left + to.right) / 2;
  /** A lane's x in the gutter right of column k. */
  const vx = (k: number, index: number, fallback: number) =>
    (places.cols.get(k)?.right ?? fallback) + ARROW_LANE_START + ARROW_LANE_STEP * index;
  /** A lane's y in the gutter above row r. */
  const hy = (r: number, index: number, fallback: number) =>
    (places.rows.get(r - 1)?.bottom ?? ((places.rows.get(r)?.top ?? fallback) - gap)) + ARROW_LANE_START + ARROW_LANE_STEP * index;
  switch (arrow.route) {
    case "across":
      return [[from.right, y0], [to.left, y0]];
    case "down": {
      const x0 = clamp(midX, from.left + 10, from.right - 10);
      return [[x0, from.bottom], [x0, to.top]];
    }
    case "side": {
      const gx = vx(pc, arrow.lanes.v, from.right);
      return [[from.right, y0], [gx, y0], [gx, entryY], [to.left, entryY]];
    }
    case "over": {
      const gx = vx(pc, arrow.lanes.v, from.right);
      const gy = hy(cr, arrow.lanes.h, to.top);
      return [[from.right, y0], [gx, y0], [gx, gy], [midX, gy], [midX, to.top]];
    }
    case "under": {
      const gx = vx(pc, arrow.lanes.v, from.right);
      const gy = hy(pr + 1, arrow.lanes.h, from.bottom + gap);
      const lx = vx(cc - 1, arrow.lanes.v2, to.left - gap);
      return [[from.right, y0], [gx, y0], [gx, gy], [lx, gy], [lx, entryY], [to.left, entryY]];
    }
  }
}

/**
 * The SVG path of a polyline with its corners rounded, and its head. The head's tip sits `gap`
 * short of the last point, just off the panel's edge, and the line ends inside the head's base.
 */
export function arrowPathFromPoints(points: readonly [number, number][], gap = 3, radius = 7, width = 1.5): { path: string; head: string } | null {
  if (points.length < 2) return null;
  const r = (v: number) => Math.round(v * 10) / 10;
  const pts = points.map(([x, y]) => [x, y] as [number, number]);
  // Shorten the last segment by the gap.
  const last = pts[pts.length - 1], prev = pts[pts.length - 2];
  const ldx = last[0] - prev[0], ldy = last[1] - prev[1];
  const llen = Math.hypot(ldx, ldy) || 1;
  const end: [number, number] = [last[0] - (ldx / llen) * gap, last[1] - (ldy / llen) * gap];
  pts[pts.length - 1] = end;
  let path = `M${r(pts[0][0])},${r(pts[0][1])}`;
  /** Where the last straight run starts: the first point, or the last corner's far side. */
  let runStart: [number, number] = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const inLen = Math.hypot(b[0] - a[0], b[1] - a[1]), outLen = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const rr = Math.min(radius, inLen / 2, outLen / 2);
    if (!(rr > 0) || !(inLen > 0) || !(outLen > 0)) { path += ` L${r(b[0])},${r(b[1])}`; runStart = b; continue; }
    const p1: [number, number] = [b[0] - ((b[0] - a[0]) / inLen) * rr, b[1] - ((b[1] - a[1]) / inLen) * rr];
    const p2: [number, number] = [b[0] + ((c[0] - b[0]) / outLen) * rr, b[1] + ((c[1] - b[1]) / outLen) * rr];
    path += ` L${r(p1[0])},${r(p1[1])} Q${r(b[0])},${r(b[1])} ${r(p2[0])},${r(p2[1])}`;
    runStart = p2;
  }
  const tx = ldx / llen, ty = ldy / llen;
  // The head grows with the line, and is large enough to read beside a panel.
  const L = 7 + 2 * width, W = 3.5 + width;
  // The line stops a pixel inside the head's base rather than at its tip: run to the tip, it
  // showed through the head as a darker stripe and its round end poked out past the point.
  const run = Math.hypot(end[0] - runStart[0], end[1] - runStart[1]);
  const back = Math.min(L - 1, Math.max(0, run));
  path += ` L${r(end[0] - tx * back)},${r(end[1] - ty * back)}`;
  const bx = end[0] - tx * L, by = end[1] - ty * L;
  const head = `M${r(end[0])},${r(end[1])} L${r(bx - ty * W)},${r(by + tx * W)} L${r(bx + ty * W)},${r(by - tx * W)} Z`;
  return { path, head };
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Where an arrow leaves its panel: level with the gate's label, or with the gate's own centre. */
export type ArrowAnchor = "label" | "gate";

/**
 * The centroid of a closed polygon by area (the shoelace sums); the mean of its points where
 * it encloses no area. Null for no points.
 */
export function polygonCentroid(points: readonly (readonly [number, number])[]): [number, number] | null {
  const pts = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return null;
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    const cross = x1 * y2 - x2 * y1;
    area += cross; cx += (x1 + x2) * cross; cy += (y1 + y2) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    return [pts.reduce((sum, p) => sum + p[0], 0) / pts.length, pts.reduce((sum, p) => sum + p[1], 0) / pts.length];
  }
  return [cx / (3 * area), cy / (3 * area)];
}

/** The points of a path the renderer wrote as "Mx,yLx,y…Z". */
function pathPoints(d: string): [number, number][] {
  return d.replace(/^M/, "").replace(/Z$/, "").split("L").map((pair) => {
    const [x, y] = pair.split(",").map(Number);
    return [x, y] as [number, number];
  }).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

/**
 * A gutter on the grid's right and below it, as wide as the gap between its cells: a line that
 * leaves the last column, or runs under the last row, has somewhere to go inside the grid's own
 * box (outside it, the grid's scrolling container cut it off). Applied before the grid is
 * measured for a frame, and again whenever the arrows are drawn.
 */
export function reserveArrowGutters(container: HTMLElement): void {
  const grid = container.querySelector<HTMLElement>(".multi-strategy-grid");
  if (!grid) return;
  const gap = parseFloat(getComputedStyle(grid).columnGap) || parseFloat(grid.style.gap) || 8;
  grid.style.paddingRight = `${gap}px`;
  grid.style.paddingBottom = `${gap}px`;
}

/**
 * Draw the arrows over the multi-strategy grid in `container` (the renderer's grid element,
 * `.multi-strategy-grid`): one SVG, positioned over the grid and part of it, so it scrolls and
 * exports with the panels. Each arrow runs from the gate's label on its panel (the panel itself
 * when the label is not drawn) to the child's panel. Returns how many were drawn.
 */
export function drawStrategyArrows(
  container: HTMLElement,
  arrows: readonly StrategyArrow[],
  style: { color: string | null; width: number; anchor?: ArrowAnchor },
): number {
  const grid = container.querySelector<HTMLElement>(".multi-strategy-grid");
  if (!grid) return 0;
  grid.querySelectorAll("svg.gl-strategy-arrows").forEach((old) => old.remove());
  if (!arrows.length) return 0;
  reserveArrowGutters(container);
  const cells = new Map<string, HTMLElement>();
  grid.querySelectorAll<HTMLElement>(".mini-plot-cell").forEach((cell) => {
    const key = cell.getAttribute("data-plot-key");
    if (key) cells.set(key, cell);
  });
  const gridRect = grid.getBoundingClientRect();
  // The grid may be drawn under a zoom or a scaled page (the Layout tab): the rectangles read
  // back are the scaled ones, and the overlay lives inside the grid, in its own unscaled pixels.
  const scale = grid.offsetWidth > 0 && gridRect.width > 0 ? gridRect.width / grid.offsetWidth : 1;
  const box = (el: Element): Box => {
    const r = el.getBoundingClientRect();
    return { left: (r.left - gridRect.left) / scale, top: (r.top - gridRect.top) / scale, right: (r.right - gridRect.left) / scale, bottom: (r.bottom - gridRect.top) / scale };
  };
  // Where the columns and rows lie, from the cells the arrows name (each knows its place).
  const cols = new Map<number, { left: number; right: number }>();
  const rows = new Map<number, { top: number; bottom: number }>();
  const place = (nodeId: string, at: { row: number; col: number }) => {
    const cell = cells.get(nodeId);
    if (!cell) return;
    const b = box(cell);
    if (b.right - b.left <= 0) return;
    const col = cols.get(at.col);
    cols.set(at.col, col ? { left: Math.min(col.left, b.left), right: Math.max(col.right, b.right) } : { left: b.left, right: b.right });
    const row = rows.get(at.row);
    rows.set(at.row, row ? { top: Math.min(row.top, b.top), bottom: Math.max(row.bottom, b.bottom) } : { top: b.top, bottom: b.bottom });
  };
  for (const arrow of arrows) { place(arrow.fromNodeId, arrow.from); place(arrow.toNodeId, arrow.to); }
  const gapOf = () => {
    const numbered = [...cols.entries()].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < numbered.length; i++) {
      if (numbered[i][0] === numbered[i - 1][0] + 1) return Math.max(2, numbered[i][1].left - numbered[i - 1][1].right);
    }
    return 8;
  };
  const places: GridPlaces = { cols, rows, gap: gapOf() };
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "gl-strategy-arrows");
  svg.setAttribute("width", String(Math.ceil(gridRect.width / scale)));
  svg.setAttribute("height", String(Math.ceil(gridRect.height / scale)));
  svg.setAttribute("aria-hidden", "true");
  Object.assign(svg.style, { position: "absolute", left: "0", top: "0", pointerEvents: "none", overflow: "visible" });
  let drawn = 0;
  for (const arrow of arrows) {
    const fromCell = cells.get(arrow.fromNodeId);
    const toCell = cells.get(arrow.toNodeId);
    if (!fromCell || !toCell) continue;
    const label = Array.from(fromCell.querySelectorAll<SVGElement>("[data-gate-id]")).find((el) => el.getAttribute("data-gate-id") === arrow.gateId);
    const from = box(fromCell);
    const to = box(toCell);
    if (from.right - from.left <= 0 || to.right - to.left <= 0) continue;
    const labelBox = label ? box(label) : null;
    let startY = labelBox && labelBox.bottom > labelBox.top ? (labelBox.top + labelBox.bottom) / 2 : (from.top + from.bottom) / 2;
    if (style.anchor === "gate") {
      // Level with the gate's centroid: read from the shape's own points, placed by its box on
      // screen. A gate with no shape of its own here (a quadrant) keeps its label's level.
      const shape = Array.from(fromCell.querySelectorAll<SVGElement>("[data-gate-shape]")).find((el) => el.getAttribute("data-gate-shape") === arrow.gateId);
      const shapeBox = shape ? box(shape) : null;
      const pts = shape ? pathPoints(shape.getAttribute("d") ?? "") : [];
      const centre = polygonCentroid(pts);
      if (shapeBox && centre && shapeBox.bottom > shapeBox.top) {
        const ys = pts.map((p) => p[1]);
        const lo = Math.min(...ys), hi = Math.max(...ys);
        startY = hi > lo ? shapeBox.top + ((centre[1] - lo) / (hi - lo)) * (shapeBox.bottom - shapeBox.top) : (shapeBox.top + shapeBox.bottom) / 2;
      }
    }
    const points = routeArrow(from, to, arrow, places, startY);
    const geometry = points ? arrowPathFromPoints(points, 3, 7, style.width) : null;
    if (!geometry) continue;
    const colour = style.color ?? arrow.color;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", geometry.path);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", colour);
    path.setAttribute("stroke-width", String(style.width));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("opacity", "0.85");
    // The head is solid; the line keeps its slight transparency, so a plot's edge reads through it.
    const head = document.createElementNS(SVG_NS, "path");
    head.setAttribute("d", geometry.head);
    head.setAttribute("fill", colour);
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-arrow-gate", arrow.gateId);
    g.appendChild(path);
    g.appendChild(head);
    svg.appendChild(g);
    drawn++;
  }
  if (!drawn) return 0;
  if (getComputedStyle(grid).position === "static") grid.style.position = "relative";
  grid.appendChild(svg);
  return drawn;
}
