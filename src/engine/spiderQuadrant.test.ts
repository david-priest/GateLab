// Spider quadrants: a quadrant gate whose four arms lean independently (QuadrantArms).
import { describe, it, expect } from "vitest";
import { gateMaskPolygon, gateMaskQuadrant, getGateMask, type AssayData } from "./gates";
import { computeGateCounts } from "./populations";
import { armsLean, newQuadrantGate, validArms, validateGate, type QuadrantArms, type QuadrantGate } from "./models";

function assay(cols: Record<string, number[]>): AssayData {
  const map: Record<string, Float32Array> = {};
  let n = 0;
  for (const k of Object.keys(cols)) {
    map[k] = Float32Array.from(cols[k]);
    n = cols[k].length;
  }
  return { n, column: (c) => map[c] };
}

/** A spider quadrant on D1's two channels. */
function spider(center: [number, number], arms: QuadrantArms): QuadrantGate {
  return { ...newQuadrantGate("D1 spider", "FL1", "FL2", center), arms };
}

// FlowJo 11's own example, in its 0-256 display: [centre, down, right, up, left].
const FJ11_X = [148.53, 124.07, 256, 99.97, 0];
const FJ11_Y = [125.82, 0, 121.45, 256, 79.15];
const fj11Arms: QuadrantArms = {
  down: [FJ11_X[1], FJ11_Y[1]],
  right: [FJ11_X[2], FJ11_Y[2]],
  up: [FJ11_X[3], FJ11_Y[3]],
  left: [FJ11_X[4], FJ11_Y[4]],
};
const fj11Centre: [number, number] = [FJ11_X[0], FJ11_Y[0]];

describe("spider quadrant: drawn around known events and counted", () => {
  // Events placed by hand on either side of each leaning arm of FlowJo 11's example. The down
  // arm leans left (centre x 148.53 to 124.07 at y 0), the up arm leans left further (to 99.97
  // at y 256), the left arm drops (to 79.15 at x 0) and the right arm drops a little (to 121.45).
  // Under a plain crosshair at the same centre, each "near" event below is in the other quadrant.
  // q 0: in no quadrant.
  const events: Array<{ x: number; y: number; q: 0 | 1 | 2 | 3 | 4; why: string }> = [
    // Down arm at y = 20 sits at x = 148.53 - 24.46 * (105.82 / 125.82) = 127.96.
    { x: 135, y: 20, q: 3, why: "right of the down arm, left of the crosshair's x" },
    { x: 120, y: 20, q: 4, why: "left of the down arm" },
    // Up arm at y = 240 sits at x = 148.53 - 48.56 * (114.18 / 130.18) = 105.94.
    { x: 110, y: 240, q: 2, why: "right of the up arm, left of the crosshair's x" },
    { x: 100, y: 240, q: 1, why: "left of the up arm" },
    // Left arm at x = 10 sits at y = 125.82 - 46.67 * (138.53 / 148.53) = 82.29.
    { x: 10, y: 90, q: 1, why: "above the left arm, below the crosshair's y" },
    { x: 10, y: 75, q: 4, why: "below the left arm" },
    // Right arm at x = 250 sits at y = 125.82 - 4.37 * (101.47 / 107.47) = 121.70.
    { x: 250, y: 123, q: 2, why: "above the right arm, below the crosshair's y" },
    { x: 250, y: 120, q: 3, why: "below the right arm" },
    // Well inside each quadrant.
    { x: 30, y: 200, q: 1, why: "far upper left" },
    { x: 220, y: 220, q: 2, why: "far upper right" },
    { x: 220, y: 30, q: 3, why: "far lower right" },
    { x: 30, y: 30, q: 4, why: "far lower left" },
    // On the box the ends span, which is in it, and beyond it, which is in no quadrant.
    { x: 256, y: 200, q: 2, why: "on the right edge, above the right arm's end" },
    { x: 0, y: 0, q: 4, why: "on the lower left corner" },
    { x: 300, y: 121, q: 0, why: "past the right edge" },
    { x: 80, y: 300, q: 0, why: "past the top edge" },
  ];
  const data = assay({ FL1: events.map((e) => e.x), FL2: events.map((e) => e.y) });
  const gate = spider(fj11Centre, fj11Arms);

  it("validates as a spider quadrant whose arms lean", () => {
    expect(validArms(gate.center, gate.arms)).toBe(true);
    expect(armsLean(gate.center, gate.arms)).toBe(true);
    expect(validateGate(gate)).toBe(true);
  });

  it("puts every event in the quadrant its sector says", () => {
    for (let q = 1; q <= 4; q++) {
      const mask = getGateMask(gate, data, q);
      events.forEach((e, i) => expect([e.why, mask[i]]).toEqual([e.why, e.q === q ? 1 : 0]));
    }
  });

  it("counts all four quadrants, each against the parent", () => {
    const counts = computeGateCounts({ [gate.gate_id]: gate }, null, data)[gate.gate_id].quadrants!;
    const expected = [1, 2, 3, 4].map((q) => events.filter((e) => e.q === q).length);
    expect(expected).toEqual([3, 4, 3, 4]);
    expect(counts.map((c) => c.event_count)).toEqual(expected);
    // The two events past the box are in no quadrant, so the four hold 14 of the 16.
    expect(counts.reduce((s, c) => s + (c.percent_of_parent ?? 0), 0)).toBeCloseTo((14 / 16) * 100, 6);
  });

  it("differs from the plain crosshair at the same centre on exactly the events beside a leaning arm and past the box", () => {
    const plain = newQuadrantGate("D2 crosshair", "FL1", "FL2", fj11Centre);
    const moved = events.filter((e, i) => [1, 2, 3, 4].some((q) => getGateMask(plain, data, q)[i] === 1 && e.q !== q));
    expect(moved.map((e) => e.why)).toEqual([
      "right of the down arm, left of the crosshair's x",
      "right of the up arm, left of the crosshair's x",
      "above the left arm, below the crosshair's y",
      "above the right arm, below the crosshair's y",
      "past the right edge",
      "past the top edge",
    ]);
  });

  it("holds what FlowJo's four polygons hold", () => {
    // FlowJo 10's panels: [horizontal end, corner, vertical end, centre].
    const [c, a] = [fj11Centre, fj11Arms];
    const rings = [
      [a.left, [a.left[0], a.up[1]], a.up, c],
      [a.right, [a.right[0], a.up[1]], a.up, c],
      [a.right, [a.right[0], a.down[1]], a.down, c],
      [a.left, [a.left[0], a.down[1]], a.down, c],
    ] as [number, number][][];
    const xs = events.map((e) => e.x);
    const ys = events.map((e) => e.y);
    // The events on an edge of the box are on a polygon's edge too, where the closed polygon test holds them.
    rings.forEach((ring, k) => expect(Array.from(gateMaskPolygon(xs, ys, ring))).toEqual(Array.from(getGateMask(gate, data, k + 1))));
  });
});

describe("spider quadrant: membership is the sector between consecutive arms", () => {
  // A seeded generator, so a failure names the same case every run.
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const angle = (dx: number, dy: number) => {
    const a = Math.atan2(dy, dx);
    return a < 0 ? a + 2 * Math.PI : a;
  };
  /** Which sector the point is in, by angle alone: x−/y− between left and down, and so on. */
  const sectorOf = (c: [number, number], arms: QuadrantArms, x: number, y: number): number => {
    const a = angle(x - c[0], y - c[1]);
    const ray = (p: [number, number]) => angle(p[0] - c[0], p[1] - c[1]);
    const between = (from: number, to: number) => {
      const span = (to - from + 2 * Math.PI) % (2 * Math.PI);
      const at = (a - from + 2 * Math.PI) % (2 * Math.PI);
      return at < span;
    };
    if (between(ray(arms.down), ray(arms.right))) return 3;
    if (between(ray(arms.right), ray(arms.up))) return 2;
    if (between(ray(arms.up), ray(arms.left))) return 1;
    return 4;
  };

  it("agrees with the sector test inside the box, and holds nothing outside it, for random spiders", () => {
    let spiders = 0;
    let disagreements = 0;
    while (spiders < 200) {
      const c: [number, number] = [rand() * 100, rand() * 100];
      // Ends on the four edges of a 0-100 box, as FlowJo places them.
      const arms: QuadrantArms = {
        down: [rand() * 100, 0],
        right: [100, rand() * 100],
        up: [rand() * 100, 100],
        left: [0, rand() * 100],
      };
      if (!validArms(c, arms)) continue;
      spiders++;
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < 400; i++) {
        xs.push(rand() * 140 - 20);
        ys.push(rand() * 140 - 20);
      }
      const masks = [1, 2, 3, 4].map((q) => gateMaskQuadrant(xs, ys, c, q, undefined, arms));
      for (let i = 0; i < xs.length; i++) {
        // Points within a hair of a ray are left out: there the two tests may round apart.
        const d = Math.min(...(["down", "right", "up", "left"] as const).map((k) => {
          const [ex, ey] = [arms[k][0] - c[0], arms[k][1] - c[1]];
          const len = Math.hypot(ex, ey);
          const along = ((xs[i] - c[0]) * ex + (ys[i] - c[1]) * ey) / len;
          return along > 0 ? Math.abs(((xs[i] - c[0]) * ey - (ys[i] - c[1]) * ex) / len) : Infinity;
        }));
        if (d < 1e-9) continue;
        const inQ = masks.map((m) => m[i]);
        const inBox = xs[i] >= 0 && xs[i] <= 100 && ys[i] >= 0 && ys[i] <= 100;
        expect(inQ.reduce((s, v) => s + v, 0)).toBe(inBox ? 1 : 0);
        if (!inBox) continue;
        if (inQ.indexOf(1) + 1 !== sectorOf(c, arms, xs[i], ys[i])) disagreements++;
      }
    }
    expect(disagreements).toBe(0);
  });

  it("is the plain crosshair within its box when no arm leans, ties included", () => {
    const c: [number, number] = [10, 20];
    const arms: QuadrantArms = { down: [10, -5], right: [40, 20], up: [10, 60], left: [-30, 20] };
    expect(armsLean(c, arms)).toBe(false);
    const xs = [10, 10, 9, 11, 10, 0, 30, -30, 40, 10, NaN];
    const ys = [20, 0, 20, 20, 50, 20, 20, -5, 60, 5, 5];
    for (let q = 1; q <= 4; q++) {
      expect(Array.from(gateMaskQuadrant(xs, ys, c, q, undefined, arms))).toEqual(Array.from(gateMaskQuadrant(xs, ys, c, q)));
    }
  });

  it("places an event on a leaning arm on the arm's upper or right side, as on a crosshair", () => {
    // On the up arm (x = 0 + y / 2 above the centre) and on the right arm (y = x / 4).
    const arms: QuadrantArms = { down: [0, -10], right: [40, 10], up: [5, 10], left: [-10, 0] };
    const xs = [2, 8];
    const ys = [4, 2];
    expect(Array.from(gateMaskQuadrant(xs, ys, [0, 0], 2, undefined, arms))).toEqual([1, 1]);
  });

  it("puts an infinite or undefined coordinate in no quadrant", () => {
    const arms: QuadrantArms = { down: [0, -10], right: [10, 5], up: [0, 10], left: [-10, 0] };
    const xs = [Infinity, -Infinity, 1, NaN];
    const ys = [1, 1, -Infinity, 1];
    for (let q = 1; q <= 4; q++) expect(Array.from(gateMaskQuadrant(xs, ys, [0, 0], q, undefined, arms))).toEqual([0, 0, 0, 0]);
  });
});

describe("spider quadrant: which arms are valid", () => {
  const c: [number, number] = [0, 0];
  const ok: QuadrantArms = { down: [0, -1], right: [1, 0], up: [0, 1], left: [-1, 0] };
  it("accepts a crosshair's arms", () => expect(validArms(c, ok)).toBe(true));
  it.each([
    ["down above the centre", { ...ok, down: [0, 1] }],
    ["right left of the centre", { ...ok, right: [-1, 0] }],
    ["up on the centre's level", { ...ok, up: [1, 0] }],
    ["left right of the centre", { ...ok, left: [0.5, 0] }],
    ["the down end past the box's right edge", { ...ok, down: [2, -1] }],
    ["the right end above the box's top", { ...ok, right: [1, 2] }],
    ["a non-finite end", { ...ok, up: [0, Infinity] }],
    ["a missing arm", { down: [0, -1], right: [1, 0], up: [0, 1] }],
  ])("refuses %s", (_why, arms) => {
    expect(validArms(c, arms)).toBe(false);
    expect(() => validateGate({ ...newQuadrantGate("D1", "FL1", "FL2", c), arms: arms as QuadrantArms })).toThrow();
  });
  it("refuses curled and leaning arms together", () => {
    const g = { ...newQuadrantGate("D1", "FL1", "FL2", c), arms: ok, curl: { power: 1.5, kx: 0.01, ky: 0.01 } };
    expect(() => validateGate(g)).toThrow(/both/);
  });
});
