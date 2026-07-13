// gates.ts — per-event boolean masks for polygon / rectangle / quadrant gates.
// Ported from GateLabR inst/app/R/gate_engine.R (gate_mask_* + get_gate_mask).
// Masks are Uint8Array (1 = in-gate, 0 = out) over display-space channel columns.

import type { Gate, Vertex } from "./models";

/** Column accessor for the currently-displayed (transformed) assay data. */
export interface AssayData {
  n: number;
  column(channel: string): ArrayLike<number> | undefined;
}

// ---------------------------------------------------------------------------
// Point-in-polygon (inside OR on boundary, matching sp::point.in.polygon >= 1)
// ---------------------------------------------------------------------------

function onSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): boolean {
  const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const segLen = Math.hypot(bx - ax, by - ay) || 1;
  if (Math.abs(cross) > 1e-9 * segLen) return false;
  const dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay);
  const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
  return dot >= -1e-12 && dot <= len2 + 1e-12;
}

/** Boundary-inclusive point-in-polygon (crossing number + edge test). */
export function pointInPolygon(px: number, py: number, vx: number[], vy: number[]): boolean {
  const n = vx.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (onSegment(px, py, vx[j], vy[j], vx[i], vy[i])) return true;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = vy[i];
    const yj = vy[j];
    if (yi > py !== yj > py) {
      const xCross = ((vx[j] - vx[i]) * (py - yi)) / (yj - yi) + vx[i];
      if (px < xCross) inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

export function gateMaskPolygon(
  xVals: ArrayLike<number>,
  yVals: ArrayLike<number>,
  vertices: Vertex[],
): Uint8Array {
  const n = xVals.length;
  const out = new Uint8Array(n);
  if (vertices.length === 0) return out;

  // Compile polygon geometry once. The previous implementation called pointInPolygon
  // for every event, which recalculated edge lengths with Math.hypot and traversed all
  // edges twice. On multi-million-event FCS files that dominated GatingML import time.
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  const edges = vertices.map(([bx, by], i) => {
    const [ax, ay] = vertices[(i + vertices.length - 1) % vertices.length];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (ax < xMin) xMin = ax;
    if (ax > xMax) xMax = ax;
    if (ay < yMin) yMin = ay;
    if (ay > yMax) yMax = ay;
    return {
      ax, ay, bx, by, dx, dy, len2,
      boundaryTolerance: 1e-9 * (Math.sqrt(len2) || 1),
    };
  });

  for (let i = 0; i < n; i++) {
    const px = xVals[i];
    const py = yVals[i];
    if (px < xMin || px > xMax || py < yMin || py > yMax) continue;

    let inside = false;
    for (const edge of edges) {
      const cross = edge.dx * (py - edge.ay) - edge.dy * (px - edge.ax);
      if (Math.abs(cross) <= edge.boundaryTolerance) {
        const dot = (px - edge.ax) * edge.dx + (py - edge.ay) * edge.dy;
        if (dot >= -1e-12 && dot <= edge.len2 + 1e-12) {
          inside = true;
          break;
        }
      }

      if ((edge.ay > py) !== (edge.by > py)) {
        const xCross = edge.ax + ((py - edge.ay) * edge.dx) / edge.dy;
        if (px < xCross) inside = !inside;
      }
    }
    out[i] = inside ? 1 : 0;
  }
  return out;
}

export function gateMaskRectangle(
  xVals: ArrayLike<number>,
  yVals: ArrayLike<number>,
  vertices: Vertex[],
): Uint8Array {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const [vx, vy] of vertices) {
    if (vx < xMin) xMin = vx;
    if (vx > xMax) xMax = vx;
    if (vy < yMin) yMin = vy;
    if (vy > yMax) yMax = vy;
  }
  const n = xVals.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = xVals[i];
    const y = yVals[i];
    out[i] = x >= xMin && x <= xMax && y >= yMin && y <= yMax ? 1 : 0;
  }
  return out;
}

/**
 * One quadrant of a quadrant gate. Numbering (matching gate_engine.R):
 *   1 = x-/y+, 2 = x+/y+, 3 = x+/y-, 4 = x-/y-  (>= on the positive side;
 *   a point exactly on the crosshair falls in quadrant 2).
 */
export function gateMaskQuadrant(
  xVals: ArrayLike<number>,
  yVals: ArrayLike<number>,
  center: [number, number],
  quadrant: number,
): Uint8Array {
  const cx = center[0];
  const cy = center[1];
  let q = Math.trunc(quadrant);
  if (!Number.isFinite(q)) q = 1;
  const n = xVals.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = xVals[i];
    const y = yVals[i];
    let inq: boolean;
    switch (q) {
      case 1: inq = x < cx && y >= cy; break;
      case 2: inq = x >= cx && y >= cy; break;
      case 3: inq = x >= cx && y < cy; break;
      case 4: inq = x < cx && y < cy; break;
      default: inq = false;
    }
    out[i] = inq ? 1 : 0;
  }
  return out;
}

/** Mask for any gate type against display-space assay data. */
export function getGateMask(gate: Gate, data: AssayData, quadrant?: number): Uint8Array {
  const x = data.column(gate.x_channel);
  const y = data.column(gate.y_channel);
  if (!x || !y) return new Uint8Array(data.n); // missing channel → all-false

  if (gate.gate_type === "polygon") return gateMaskPolygon(x, y, gate.vertices);
  if (gate.gate_type === "rectangle") return gateMaskRectangle(x, y, gate.vertices);
  if (gate.gate_type === "quadrant") return gateMaskQuadrant(x, y, gate.center, quadrant ?? 1);
  return new Uint8Array(data.n);
}
