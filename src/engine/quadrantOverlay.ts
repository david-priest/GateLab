// quadrantOverlay.ts — a quadrant gate as a small plot draws it. Kept apart from the Illustration
// and Strategy modules, which both draw one and import one another's helpers.

import type { Sample } from "./sample";
import type { QuadrantGate } from "./models";
import { quadrantArmPoints } from "./gates";

/**
 * A quadrant's drawn dividers, in a cell's display units: a curly quadrant's two bent arms, `h`
 * to the right of the crosshair and `v` above it; or a spider quadrant's four arms from its
 * centre, `h` right, `v` up, `l` left and `d` down on the cell, with `spider` set.
 */
export interface QuadrantArms {
  h: [number, number][];
  v: [number, number][];
  l?: [number, number][];
  d?: [number, number][];
  spider?: true;
}

type Pt = [number, number];

/**
 * A spider quadrant's arms as a cell draws them, each sampled from the centre to its end in the
 * gate's own space and then mapped to the cell, so an arm is the line the mask tests even where the
 * cell's display is not the gate's. With them, a place for each quadrant's label inside its
 * polygon, in the cell's screen order: upper left, upper right, lower right, lower left, and inside
 * the part of it the cell shows when its ranges are given, so a label can be seen and dragged where
 * its quadrant reaches far past the plotted range. Drawn for arms on their axes too, so a spider
 * just drawn has its handles. Null for a quadrant without arms.
 */
export function spiderOverlayShape(
  sample: Sample,
  gate: QuadrantGate,
  xCh: string,
  yCh: string,
  flipped: boolean,
  view?: { x: [number, number]; y: [number, number] },
): { arms: QuadrantArms; anchors: Pt[] } | null {
  if (!gate.arms) return null;
  const toCellDisplay = ([vx, vy]: Pt): Pt => {
    const cellX = flipped ? vy : vx;
    const cellY = flipped ? vx : vy;
    return [sample.gateToDisplay(gate, xCh, cellX), sample.gateToDisplay(gate, yCh, cellY)];
  };
  const [cx, cy] = gate.center;
  const STEPS = 32;
  const arm = (end: Pt): Pt[] => {
    const pts: Pt[] = [];
    for (let i = 0; i <= STEPS; i++) pts.push(toCellDisplay([cx + ((end[0] - cx) * i) / STEPS, cy + ((end[1] - cy) * i) / STEPS]));
    return pts;
  };
  const { down, right, up, left } = gate.arms;
  // A quadrant's label sits at the centroid of the larger of the two triangles the diagonal from
  // the centre to its corner cuts it into. Only the centre's angle can exceed a half-turn (the
  // corner's is a right angle and each end's lies inside the box), so that diagonal lies inside the
  // polygon and so do both triangles, whatever the arms do; the polygon's mean need not, and the
  // diagonal's midpoint lies on an arm whose end is at the corner.
  // With the cell's ranges, the larger of the two triangles' parts inside them (each convex, so its
  // centroid lies inside it). The cut is made in the gate's own space, where the triangles are
  // straight, on the ranges carried there (each axis maps on its own and monotonically).
  const shown = view
    ? {
      x: (flipped ? view.y : view.x).map((v) => sample.displayToGate(gate, gate.x_channel, v)) as [number, number],
      y: (flipped ? view.x : view.y).map((v) => sample.displayToGate(gate, gate.y_channel, v)) as [number, number],
    }
    : null;
  const anchor = (side: Pt, vertical: Pt): Pt => {
    const corner: Pt = [side[0], vertical[1]];
    const area = (a: Pt, b: Pt) => Math.abs((a[0] - cx) * (b[1] - cy) - (a[1] - cy) * (b[0] - cx));
    const other = area(side, corner) >= area(corner, vertical) ? side : vertical;
    const whole: Pt = [(cx + corner[0] + other[0]) / 3, (cy + corner[1] + other[1]) / 3];
    const seen = shown && shown.x.every(Number.isFinite) && shown.y.every(Number.isFinite)
      ? [[gate.center, side, corner], [gate.center, corner, vertical]]
        .map((tri) => polygonCentroid(clipToBox(tri as Pt[], shown)))
        .filter((c): c is { at: Pt; area: number } => c !== null && c.area > 0)
        .sort((a, b) => b.area - a.area)
      : [];
    return toCellDisplay(seen.length ? seen[0].at : whole);
  };
  // GateLab's quadrants Q1 to Q4, and where each lands on the cell: on a flipped cell the gate's
  // x−/y+ quadrant is the lower right, its x+/y− the upper left.
  const byQuadrant = [anchor(left, up), anchor(right, up), anchor(right, down), anchor(left, down)];
  const anchors = flipped ? [byQuadrant[2], byQuadrant[1], byQuadrant[0], byQuadrant[3]] : byQuadrant;
  // On a flipped cell the gate's up arm runs right, its right arm up, and so on.
  const cell = flipped
    ? { right: arm(up), up: arm(right), left: arm(down), down: arm(left) }
    : { right: arm(right), up: arm(up), left: arm(left), down: arm(down) };
  return { arms: { h: cell.right, v: cell.up, l: cell.left, d: cell.down, spider: true }, anchors };
}

/** A polygon cut to a box (Sutherland-Hodgman), in the box's coordinates. */
function clipToBox(poly: Pt[], box: { x: [number, number]; y: [number, number] }): Pt[] {
  const [x0, x1] = [Math.min(...box.x), Math.max(...box.x)];
  const [y0, y1] = [Math.min(...box.y), Math.max(...box.y)];
  const edges: Array<[(p: Pt) => boolean, (a: Pt, b: Pt) => Pt]> = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  let out = poly.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  for (const [inside, cut] of edges) {
    const prev = out;
    out = [];
    for (let i = 0; i < prev.length; i++) {
      const a = prev[(i + prev.length - 1) % prev.length];
      const b = prev[i];
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) {
        out.push(cut(a, b));
      }
    }
  }
  return out;
}

/** A polygon's centroid and area, or null for fewer than three vertices. */
function polygonCentroid(poly: Pt[]): { at: Pt; area: number } | null {
  if (poly.length < 3) return null;
  let a = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    const c = x0 * y1 - x1 * y0;
    a += c;
    x += (x0 + x1) * c;
    y += (y0 + y1) * c;
  }
  if (a === 0) return null;
  return { at: [x / (3 * a), y / (3 * a)], area: Math.abs(a) / 2 };
}

/**
 * A quadrant gate as a cell draws it: the crosshair's centre in the cell's display units and,
 * for a curly quadrant, the two bent arms out to the ends of the cell's ranges. `flipped` says
 * the cell shows the gate's y channel on x. Shared by the Illustration cells and the Strategy
 * panels, so a quadrant is the same shape on both.
 */
export function quadrantOverlayShape(
  sample: Sample,
  gate: QuadrantGate,
  xCh: string,
  yCh: string,
  xRange: [number, number],
  yRange: [number, number] | null,
  flipped: boolean,
): { center: [number, number]; arms?: QuadrantArms; anchors?: [number, number][] } {
  const toCellDisplay = ([vx, vy]: [number, number]): [number, number] => {
    const cellX = flipped ? vy : vx;
    const cellY = flipped ? vx : vy;
    return [sample.gateToDisplay(gate, xCh, cellX), sample.gateToDisplay(gate, yCh, cellY)];
  };
  let arms: QuadrantArms | undefined;
  const spider = spiderOverlayShape(sample, gate, xCh, yCh, flipped, yRange ? { x: xRange, y: yRange } : undefined);
  if (spider) return { center: toCellDisplay(gate.center), arms: spider.arms, anchors: spider.anchors };
  if (gate.curl && yRange) {
    const originalXDisplayEnd = flipped ? yRange[1] : xRange[1];
    const originalYDisplayEnd = flipped ? xRange[1] : yRange[1];
    const originalXEnd = sample.displayToGate(gate, gate.x_channel, originalXDisplayEnd);
    const originalYEnd = sample.displayToGate(gate, gate.y_channel, originalYDisplayEnd);
    const originalH = quadrantArmPoints(gate.center, gate.curl, "h", originalXEnd).map(toCellDisplay);
    const originalV = quadrantArmPoints(gate.center, gate.curl, "v", originalYEnd).map(toCellDisplay);
    if (originalH.length > 1 && originalV.length > 1) {
      arms = flipped ? { h: originalV, v: originalH } : { h: originalH, v: originalV };
    }
  }
  return { center: toCellDisplay(gate.center), ...(arms ? { arms } : {}) };
}
