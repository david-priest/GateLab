import { describe, expect, it } from "vitest";
import { polygonOutline } from "./gatePayload";
import { Logicle } from "../engine/transforms";

type Point = [number, number];

// Distance to a rendered segment in units of the gate's two axis spans. The oracle samples
// analytical transforms on a uniform grid, independently of the adaptive subdivision rule.
function segmentDistance(p: Point, a: Point, b: Point, spans: Point): number {
  const dx = (b[0] - a[0]) / spans[0], dy = (b[1] - a[1]) / spans[1];
  const px = (p[0] - a[0]) / spans[0], py = (p[1] - a[1]) / spans[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, (px * dx + py * dy) / length)) : 0;
  return Math.hypot(px - t * dx, py - t * dy);
}

function maximumError(vertices: Point[], drawn: Point[], map: (p: Point) => Point): number {
  const mapped = vertices.map(map);
  const spans: Point = [0, 1].map((axis) =>
    Math.max(...mapped.map((p) => p[axis])) - Math.min(...mapped.map((p) => p[axis]))) as Point;
  let worst = 0;
  for (let edge = 0; edge < vertices.length; edge++) {
    const a = vertices[edge], b = vertices[(edge + 1) % vertices.length];
    // 8191 intervals keep the audit samples off the dyadic subdivision points.
    for (let i = 0; i <= 8191; i++) {
      const t = i / 8191;
      const p = map([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      let nearest = Infinity;
      for (let j = 0; j < drawn.length; j++)
        nearest = Math.min(nearest, segmentDistance(p, drawn[j], drawn[(j + 1) % drawn.length], spans));
      worst = Math.max(worst, nearest);
    }
  }
  return worst;
}

describe("nonlinear outlines across an inflection", () => {
  const triangle: Point[] = [[-2, 0], [2, 2], [-2, 2]];
  it("does not accept a symmetric arcsinh inverse edge from its midpoint alone", () => {
    const map = ([x, y]: Point): Point => [5 * Math.sinh(x), y];
    const mapped = triangle.map(map);
    const outline = polygonOutline(triangle, map, mapped) ?? mapped;
    // The midpoint agrees exactly with the chord, but its quarter-point does not.
    expect(map([0, 1])).toEqual([0, 1]);
    expect(segmentDistance(map([-1, 0.5]), mapped[0], mapped[1], [10 * Math.sinh(2), 2])).toBeGreaterThan(0.05);
    expect(maximumError(triangle, outline, map)).toBeLessThanOrEqual(0.002);
  });

  const cases: { name: string; vertices: Point[]; map: (p: Point) => Point }[] = [
    { name: "inverse arcsinh on Y", vertices: triangle.map(([x, y]) => [y, x]), map: ([x, y]) => [x, 150 * Math.sinh(y)] },
    { name: "arcsinh on X across zero", vertices: [[-1000, 0], [1000, 100000], [-1000, 100000]], map: ([x, y]) => [Math.asinh(x / 5), y] },
    { name: "arcsinh on Y across zero", vertices: [[0, -1000], [100000, 1000], [100000, -1000]], map: ([x, y]) => [x, Math.asinh(y / 5)] },
    { name: "both axes nonlinear with unequal units", vertices: [[-2, -1], [2, 3], [-2, 3]], map: ([x, y]) => [150 * Math.sinh(x), 5 * Math.sinh(y)] },
    { name: "log and inverse log", vertices: [[1, -2], [10000, 2], [1, 2]], map: ([x, y]) => [Math.log10(x), 10 ** y] },
    { name: "a narrow arcsinh transition", vertices: [[-1e6, 0], [1e6, 2], [-1e6, 2]], map: ([x, y]) => [Math.asinh(x / 5), y] },
  ];
  for (const { name, vertices, map } of cases) it(name, () => {
    const mapped = vertices.map(map);
    const outline = polygonOutline(vertices, map, mapped) ?? mapped;
    expect(maximumError(vertices, outline, map)).toBeLessThanOrEqual(0.002);
  });

  it("honours the exporter's smaller requested tolerance", () => {
    const map = ([x, y]: Point): Point => [5 * Math.sinh(x), y];
    const outline = polygonOutline(triangle, map, triangle.map(map), { tol: 0.001 }) ?? triangle.map(map);
    expect(maximumError(triangle, outline, map)).toBeLessThanOrEqual(0.001);
  });
});

// The rule as c3ae17c wrote it, every point transformed afresh at every step, at the current depth
// cap. subdivideEdge now passes each half the ends and midpoint its parent already transformed; it
// must still draw the very same outline, bit for bit, while transforming fewer points.
function freshOutline(vertices: Point[], map: (p: Point) => Point, mapped: Point[], tol: number): Point[] | undefined {
  const xs = mapped.map((v) => v[0]).filter(Number.isFinite);
  const ys = mapped.map((v) => v[1]).filter(Number.isFinite);
  if (xs.length < 3 || ys.length < 3) return undefined;
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  if (!(spanX > 0) && !(spanY > 0)) return undefined;
  const span: Point = [spanX > 0 ? spanX : Infinity, spanY > 0 ? spanY : Infinity];
  const out: Point[] = [map(vertices[0])];
  const edge = (a: Point, b: Point, t0 = 0, t1 = 1, depth = 0): void => {
    const at = (t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const p0 = map(at(t0));
    const p1 = map(at(t1));
    const tm = (t0 + t1) / 2;
    const off = Math.max(...[0.25, 0.5, 0.75].map((fraction) => {
      const point = map(at(t0 + (t1 - t0) * fraction));
      return Math.hypot(
        (point[0] - (p0[0] + (p1[0] - p0[0]) * fraction)) / span[0],
        (point[1] - (p0[1] + (p1[1] - p0[1]) * fraction)) / span[1],
      );
    }));
    if (depth >= 15 || !Number.isFinite(off) || off <= tol) {
      out.push(p1);
      return;
    }
    edge(a, b, t0, tm, depth + 1);
    edge(a, b, tm, t1, depth + 1);
  };
  for (let i = 0; i < vertices.length; i++) edge(vertices[i], vertices[(i + 1) % vertices.length]);
  return out.length > vertices.length + 1 ? out : undefined;
}

// Long edges whose bend is narrow beside their length: an edge spanning raw values to R on
// arcsinh(x / c) bends within about c / R of it, which takes about log2(R / c) + 3 halvings to
// trace. With 9 the mass cytometry triangle here was drawn 27 times the tolerance off, 5.5% of the
// gate's extent. Sampled evenly along the edge, a check can step right over such a bend, so this one
// also samples where each display coordinate is evenly spaced: both are monotone along a raw edge.
describe("nonlinear outlines of long edges with a narrow bend", () => {
  const asinh = (c: number) => ({ forward: (v: number) => Math.asinh(v / c), inverse: (d: number) => c * Math.sinh(d) });
  const cases: { name: string; vertices: Point[]; cofactor: number }[] = [
    { name: "a mass cytometry triangle on arcsinh/5", vertices: [[8034, 9834], [-1.1, -15.7], [1.8, -36.7]], cofactor: 5 },
    { name: "a spectral flow triangle to 3.6 million on arcsinh/150", vertices: [[-68.4, 2.9], [1912654.4, 3646391.2], [-190.1, 24.3]], cofactor: 150 },
  ];
  for (const { name, vertices, cofactor } of cases) it(name, () => {
    const axis = asinh(cofactor);
    const map = ([x, y]: Point): Point => [axis.forward(x), axis.forward(y)];
    const mapped = vertices.map(map);
    const outline = polygonOutline(vertices, map, mapped) ?? mapped;
    const spans: Point = [0, 1].map((k) => Math.max(...mapped.map((p) => p[k])) - Math.min(...mapped.map((p) => p[k]))) as Point;
    let worst = 0;
    for (let edge = 0; edge < vertices.length; edge++) {
      const a = vertices[edge], b = vertices[(edge + 1) % vertices.length];
      const ts = Array.from({ length: 8192 }, (_, i) => i / 8191);
      for (const k of [0, 1]) {
        if (a[k] === b[k]) continue;
        const [d0, d1] = [axis.forward(a[k]), axis.forward(b[k])];
        for (let i = 0; i <= 4096; i++) ts.push((axis.inverse(d0 + ((d1 - d0) * i) / 4096) - a[k]) / (b[k] - a[k]));
      }
      for (const t of ts) {
        if (!(t >= 0 && t <= 1)) continue;
        const p = map([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        let nearest = Infinity;
        for (let j = 0; j < outline.length; j++)
          nearest = Math.min(nearest, segmentDistance(p, outline[j], outline[(j + 1) % outline.length], spans));
        worst = Math.max(worst, nearest);
      }
    }
    expect(worst).toBeLessThanOrEqual(0.002);
  });
});

describe("nonlinear outlines from points carried down the subdivision", () => {
  const logicle = new Logicle(262144, 0.5, 4.5, 0);
  const axes: Record<string, (v: number) => number> = {
    linear: (v) => 2 * v + 3,
    asinh5: (v) => Math.asinh(v / 5),
    asinh150: (v) => Math.asinh(v / 150),
    logicle: (v) => logicle.scale(v),
    sinh5: (v) => 5 * Math.sinh(v),
    log10: (v) => Math.log10(v),
  };
  // Raw values each axis is drawn over, signed and spread over decades where the axis compresses.
  const ranges: Record<string, [number, number]> = {
    linear: [-1000, 262144], asinh5: [-100, 20000], asinh150: [-2000, 262144], logicle: [-2000, 262144],
    sinh5: [-4, 12], log10: [1, 262144],
  };
  let seed = 20261016;
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const value = ([lo, hi]: [number, number]): number => {
    const r = random();
    if (hi / Math.max(1, Math.abs(lo)) < 100) return lo + (hi - lo) * r;
    const negative = lo < 0 && random() < 0.3;
    const magnitude = 10 ** (Math.log10(negative ? -lo : hi) * r);
    return negative ? -magnitude : Math.max(lo, magnitude);
  };
  const names = Object.keys(axes);
  const { asinh5, asinh150 } = axes;
  const polygons: { vertices: Point[]; map: (p: Point) => Point }[] = [
    { vertices: [[-2, 0], [2, 2], [-2, 2]], map: ([x, y]) => [5 * Math.sinh(x), y] },
    { vertices: [[-40, -80], [40, 80], [-40, 80]], map: ([x, y]) => [asinh5(x), asinh5(y)] },
    { vertices: [[-500, -500], [262000, 1000], [1000, 262000]], map: ([x, y]) => [asinh150(x), asinh150(y)] },
    { vertices: [[-50, -30], [3000, -40], [3500, 2500], [-40, 2000]], map: ([x, y]) => [asinh5(x), asinh5(y)] },
    { vertices: [[20000, -800], [250000, -600], [240000, 200000], [30000, 150000]], map: ([x, y]) => [x, asinh150(y)] },
    { vertices: [[8034, 9834], [-1.1, -15.7], [1.8, -36.7]], map: ([x, y]) => [asinh5(x), asinh5(y)] },
    { vertices: [[0, 0], [100, 5], [30, 90]], map: ([x, y]) => [2 * x + 3, 0.5 * y - 1] },
    {
      vertices: Array.from({ length: 12 }, (_, i): Point => [20000 + 30000 * Math.cos(i * Math.PI / 6), 15000 + 25000 * Math.sin(i * Math.PI / 6)]),
      map: ([x, y]) => [asinh150(x), asinh150(y)],
    },
  ];
  for (let k = 0; k < 400; k++) {
    const [nx, ny] = [names[Math.floor(random() * names.length)], names[Math.floor(random() * names.length)]];
    const size = 3 + Math.floor(random() * 4);
    polygons.push({
      vertices: Array.from({ length: size }, (): Point => [value(ranges[nx]), value(ranges[ny])]),
      map: ([x, y]) => [axes[nx](x), axes[ny](y)],
    });
  }

  it("draws c3ae17c's outline bit for bit, at both tolerances, with fewer transforms", () => {
    let carried = 0, fresh = 0, outlined = 0;
    for (const { vertices, map } of polygons) {
      for (const tol of [0.002, 0.001]) {
        let n = 0;
        const counted = (p: Point): Point => { n++; return map(p); };
        const got = polygonOutline(vertices, counted, vertices.map(map), { tol });
        carried += n;
        n = 0;
        const want = freshOutline(vertices, counted, vertices.map(map), tol);
        fresh += n;
        // toEqual compares numbers with Object.is: -0 and +0 differ, NaN equals NaN.
        expect(got).toEqual(want);
        if (got) outlined++;
      }
    }
    expect(outlined).toBeGreaterThan(400);
    // Two transforms per step where c3ae17c made five, plus three to start each edge.
    expect(carried).toBeLessThan(0.45 * fresh);
  });
});
