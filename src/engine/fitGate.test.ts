import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import {
  FIT_GATE_DEFAULTS,
  FLOOR_SPILL,
  clampFitSettings,
  convexHull,
  densestEvents,
  fitEllipseParameters,
  fitGateToEvents,
  fitPolygonBoundary,
  fitRectangleBoundary,
  floorSpillPoints,
  simplifyConvex,
} from "./fitGate";
import { gateMaskEllipse, getGateMask } from "./gates";
import type { EllipseGate, PolyRectGate, Vertex } from "./models";
import { Sample } from "./sample";

/** A deterministic blob of n points around (cx, cy) with spread s, plus the given outliers. */
function blob(n: number, cx: number, cy: number, s: number, outliers: Vertex[] = []): { x: number[]; y: number[] } {
  const x: number[] = [], y: number[] = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < n; i++) {
    // Box–Muller for a round cloud.
    const u = Math.max(rnd(), 1e-9), v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    x.push(cx + s * r * Math.cos(2 * Math.PI * v));
    y.push(cy + s * r * Math.sin(2 * Math.PI * v));
  }
  for (const [ox, oy] of outliers) { x.push(ox); y.push(oy); }
  return { x, y };
}

const all = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("densestEvents", () => {
  it("keeps every event at keep = 1 and drops the far ones below it", () => {
    const { x, y } = blob(400, 0, 0, 1, [[12, 12], [-12, 9], [10, -11]]);
    expect(densestEvents(x, y, all(x.length), 1)).toHaveLength(403);
    const kept = densestEvents(x, y, all(x.length), 0.98);
    expect(kept.length).toBeGreaterThanOrEqual(392);
    expect(kept.length).toBeLessThan(403);
    for (const far of [400, 401, 402]) expect(kept).not.toContain(far);
  });

  it("is empty for no events and whole for one bin", () => {
    expect(densestEvents([], [], [], 0.9)).toEqual([]);
    expect(densestEvents([1, 1, 1], [2, 2, 2], [0, 1, 2], 0.5)).toEqual([0, 1, 2]);
  });
});

describe("convexHull and simplifyConvex", () => {
  it("wraps a square with interior points in its four corners, counter-clockwise", () => {
    const pts: Vertex[] = [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5], [0.2, 0.7], [0.5, 0], [0, 0.5]];
    expect(convexHull(pts)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
  });

  it("drops the vertex that loses the least area until the count fits", () => {
    const octagon: Vertex[] = [[2, 0], [4, 0], [6, 2], [6, 4], [4, 6], [2, 6], [0, 4], [0, 2]];
    const nicked: Vertex[] = [...octagon.slice(0, 2), [5, 0.9], ...octagon.slice(2)];
    const out = simplifyConvex(nicked, 8);
    expect(out).toHaveLength(8);
    expect(out).not.toContainEqual([5, 0.9]);
    expect(simplifyConvex(octagon, 3)).toHaveLength(3);
  });
});

describe("fitPolygonBoundary / fitRectangleBoundary / fitEllipseParameters", () => {
  it("fits a polygon that holds every kept event, with a margin that grows it", () => {
    const { x, y } = blob(300, 5, 5, 1);
    const kept = all(x.length);
    const tight = fitPolygonBoundary(x, y, kept, { keep: 1, margin: 0, maxVertices: 48 })!;
    const padded = fitPolygonBoundary(x, y, kept, { keep: 1, margin: 0.1, maxVertices: 48 })!;
    const area = (p: Vertex[]) => Math.abs(p.reduce((s, [ax, ay], i) => { const [bx, by] = p[(i + 1) % p.length]; return s + ax * by - bx * ay; }, 0)) / 2;
    expect(area(padded)).toBeCloseTo(area(tight) * 1.21, 6);
    const inside = (p: Vertex[], px: number, py: number) => {
      let c = false;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        if ((p[i][1] > py) !== (p[j][1] > py) && px < ((p[j][0] - p[i][0]) * (py - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
      }
      return c;
    };
    expect(kept.every((i) => inside(padded, x[i], y[i]))).toBe(true);
  });

  it("caps a polygon's vertices", () => {
    const { x, y } = blob(2000, 0, 0, 1);
    const out = fitPolygonBoundary(x, y, all(x.length), { keep: 1, margin: 0, maxVertices: 12 })!;
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps a rectangle's corners in the gate's own order", () => {
    const x = [1, 2, 3, 4], y = [10, 20, 30, 40];
    const template: Vertex[] = [[0, 50], [9, 50], [9, 0], [0, 0]]; // top-left, top-right, bottom-right, bottom-left
    const out = fitRectangleBoundary(x, y, all(4), { keep: 1, margin: 0, maxVertices: 24 }, template)!;
    expect(out).toEqual([[1, 40], [4, 40], [4, 10], [1, 10]]);
    const padded = fitRectangleBoundary(x, y, all(4), { keep: 1, margin: 0.5, maxVertices: 24 }, template)!;
    expect(padded[0]).toEqual([0.25, 47.5]);
    expect(padded[2]).toEqual([4.75, 2.5]);
  });

  it("fits an ellipse whose boundary at the gate's distance holds every kept event", () => {
    const { x, y } = blob(500, 3, 4, 1);
    for (let i = 0; i < x.length; i++) y[i] += 0.8 * (x[i] - 3); // tilt it
    const params = fitEllipseParameters(x, y, all(x.length), { keep: 1, margin: 0, maxVertices: 24 }, 2.5)!;
    const gate: EllipseGate = { gate_id: "e", name: "e", gate_type: "ellipse", x_channel: "a", y_channel: "b", mean: params.mean, covariance: params.covariance, distance_square: 2.5, color: "#000", label_offset: null };
    const mask = gateMaskEllipse(x, y, gate);
    expect(Array.from(mask).every((m) => m === 1)).toBe(true);
    // The tilt reaches the covariance.
    expect(params.covariance[0][1]).toBeGreaterThan(0);
    expect(fitEllipseParameters([1, 2, 3], [1, 2, 3], [0, 1, 2], FIT_GATE_DEFAULTS, 2.5)).toBeNull();
  });

  it("takes a pile on an axis's floor past it, and leaves a stray there alone", () => {
    const { x, y } = blob(300, 5, 5, 1);
    // A pile of 60 events on the x floor at 0, spread over y 3 … 7.
    for (let i = 0; i < 60; i++) { x.push(0); y.push(3 + (4 * i) / 59); }
    const kept = all(x.length);
    const pts = floorSpillPoints(x, y, kept, { x: 0, y: null }, { x: 0.5, y: 0.5 });
    expect(pts).toEqual([[-0.5, 3], [-0.5, 7]]);
    const hull = fitPolygonBoundary(x, y, kept, { keep: 1, margin: 0, maxVertices: 48 }, pts)!;
    expect(Math.min(...hull.map((v) => v[0]))).toBeCloseTo(-0.5, 6);
    const box = fitRectangleBoundary(x, y, kept, { keep: 1, margin: 0, maxVertices: 24 }, [[0, 9], [9, 9], [9, 0], [0, 0]], pts)!;
    expect(box[3][0]).toBeCloseTo(-0.5, 6);
    // Three strays at the floor are not a pile.
    const few = blob(300, 5, 5, 1, [[0, 4], [0, 5], [0, 6]]);
    expect(floorSpillPoints(few.x, few.y, all(few.x.length), { x: 0, y: 0 }, { x: 0.5, y: 0.5 })).toEqual([]);
  });

  it("clamps the settings", () => {
    expect(clampFitSettings({ keep: 2, margin: -1, maxVertices: 1000 })).toEqual({ keep: 1, margin: 0, maxVertices: 48 });
    expect(clampFitSettings({ keep: NaN, margin: NaN, maxVertices: NaN })).toEqual(FIT_GATE_DEFAULTS);
  });
});

/** A CyTOF file: two markers whose display is arcsinh(x/5), one cluster and a few stragglers. */
function cytofFile(): { fcs: FcsFile; n: number } {
  const names = ["Pd102Di", "Nd145Di"];
  const { x, y } = blob(600, 300, 400, 60, [[2000, 2000], [1800, 50], [40, 1900], [2500, 900]]);
  const n = x.length;
  return {
    fcs: {
      version: "FCS3.1",
      nEvents: n,
      instrument: "cytof",
      keywords: {},
      spillover: null,
      channels: names.map((name, index) => ({ index, name, marker: name === "Pd102Di" ? "CD3" : "CD19", bits: 32, range: 4096 })),
      columns: [Float32Array.from(x), Float32Array.from(y)],
    },
    n,
  };
}

describe("fitGateToEvents", () => {
  it("tightens a polygon to its cluster, and at keep = 1 holds every event it held", () => {
    const { fcs, n } = cytofFile();
    const sample = new Sample(fcs);
    const wide: PolyRectGate = {
      gate_id: "g1", name: "cluster", gate_type: "polygon", x_channel: "CD3", y_channel: "CD19",
      vertices: [[-1, -1], [9, -1], [9, 9], [-1, 9]], color: "#e41a1c", label_offset: null,
    };
    const before = getGateMask(wide, sample.gatingDataFor(wide));
    expect(Array.from(before).filter(Boolean)).toHaveLength(n);

    const loose = fitGateToEvents(wide, sample, null, { keep: 1, margin: 0, maxVertices: 48 })!;
    expect(loose.before).toBe(n);
    expect(loose.held).toBe(n);
    expect(loose.gate.gate_type).toBe("polygon");
    expect(loose.gate.gate_id).toBe("g1");

    const tight = fitGateToEvents(wide, sample, null, { keep: 0.98, margin: 0.02, maxVertices: 24 })!;
    expect(tight.held).toBeLessThan(n);
    expect(tight.held).toBeGreaterThanOrEqual(Math.floor(0.97 * n));
    // The stragglers are out.
    const after = getGateMask(tight.gate, sample.gatingDataFor(tight.gate));
    for (const i of [n - 4, n - 3, n - 2, n - 1]) expect(after[i]).toBe(0);
    // Vertices are in the gate's space: display, for a CyTOF gate, so within the arcsinh range.
    for (const [vx, vy] of (tight.gate as PolyRectGate).vertices) {
      expect(Math.abs(vx)).toBeLessThan(9);
      expect(Math.abs(vy)).toBeLessThan(9);
    }
  });

  it("fits within the population it is asked about, and refuses a quadrant or too few events", () => {
    const { fcs, n } = cytofFile();
    const sample = new Sample(fcs);
    const wide: PolyRectGate = {
      gate_id: "g1", name: "cluster", gate_type: "rectangle", x_channel: "CD3", y_channel: "CD19",
      vertices: [[-1, 9], [9, 9], [9, -1], [-1, -1]], color: "#e41a1c", label_offset: null,
    };
    const half = new Uint8Array(n);
    for (let i = 0; i < n; i += 2) half[i] = 1;
    const fit = fitGateToEvents(wide, sample, half, { keep: 1, margin: 0, maxVertices: 24 })!;
    expect(fit.population).toBe(Math.ceil(n / 2));
    expect(fit.before).toBe(Math.ceil(n / 2));
    expect(fit.held).toBe(Math.ceil(n / 2));
    expect((fit.gate as PolyRectGate).vertices).toHaveLength(4);

    const three = new Uint8Array(n);
    three[0] = three[1] = 1;
    expect(fitGateToEvents(wide, sample, three, FIT_GATE_DEFAULTS)).toBeNull();
    expect(fitGateToEvents({ gate_id: "q", name: "q", gate_type: "quadrant", x_channel: "CD3", y_channel: "CD19", center: [2, 2], color: "#000", label_offset: null }, sample, null, FIT_GATE_DEFAULTS)).toBeNull();
  });

  it("spills a CyTOF gate below zero where its events pile on the axis", () => {
    const { fcs, n } = cytofFile();
    // A third of the cluster's events read zero on the first channel: the pile on the axis.
    const col = fcs.columns[0] as Float32Array;
    for (let i = 0; i < n; i += 3) col[i] = 0;
    const sample = new Sample(fcs);
    const wide: PolyRectGate = {
      gate_id: "g1", name: "cluster", gate_type: "polygon", x_channel: "CD3", y_channel: "CD19",
      vertices: [[-1, -1], [9, -1], [9, 9], [-1, 9]], color: "#e41a1c", label_offset: null,
    };
    const fit = fitGateToEvents(wide, sample, null, { keep: 1, margin: 0, maxVertices: 48 })!;
    const xs = (fit.gate as PolyRectGate).vertices.map((v) => v[0]);
    const xIdx = sample.index("CD3")!;
    const [lo, hi] = sample.displayRange(xIdx);
    expect(Math.min(...xs)).toBeCloseTo(-FLOOR_SPILL * (hi - lo), 6);
    expect(fit.held).toBe(n);
  });

  it("refits an ellipse in the gate's own space", () => {
    const { fcs, n } = cytofFile();
    const sample = new Sample(fcs);
    const wide: EllipseGate = {
      gate_id: "e1", name: "e", gate_type: "ellipse", x_channel: "CD3", y_channel: "CD19",
      mean: [4, 4], covariance: [[16, 0], [0, 16]], distance_square: 1, color: "#000", label_offset: null,
    };
    const fit = fitGateToEvents(wide, sample, null, { keep: 1, margin: 0, maxVertices: 24 })!;
    expect(fit.gate.gate_type).toBe("ellipse");
    expect(fit.held).toBe(n);
    const g = fit.gate as EllipseGate;
    expect(g.distance_square).toBe(1);
    expect(g.covariance[0][0]).toBeLessThan(16);
  });
});
