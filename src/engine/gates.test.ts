import { describe, it, expect } from "vitest";
import {
  pointInPolygon,
  gateMaskPolygon,
  gateMaskRectangle,
  gateMaskQuadrant,
  getGateMask,
  rangeForReader,
  upperBoundForReader,
  type AssayData,
} from "./gates";
import { fmtNum } from "./gatingmlExport";
import { applyGatingStrategy, computeGateCounts } from "./populations";
import {
  newGate,
  newQuadrantGate,
  newGateRef,
  newPopulation,
  newRootPopulation,
  linkChildToParent,
  sortPopulationTree,
  sortPopulationTreeAlpha,
  wouldCreateCycle,
  type Gate,
  type PopulationMap,
  type Vertex,
} from "./models";
import pip from "./__fixtures__/pip_oracle.json";

// A tiny AssayData backed by plain arrays.
function assay(cols: Record<string, number[]>): AssayData {
  const map: Record<string, Float32Array> = {};
  let n = 0;
  for (const k of Object.keys(cols)) {
    map[k] = Float32Array.from(cols[k]);
    n = cols[k].length;
  }
  return { n, column: (c) => map[c] };
}

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

describe("pointInPolygon vs matplotlib oracle", () => {
  it("matches interior/exterior on 400 points", () => {
    const vx = pip.polygon.map((v) => v[0]);
    const vy = pip.polygon.map((v) => v[1]);
    let mism = 0;
    for (let i = 0; i < pip.n; i++) {
      if (pointInPolygon(pip.x[i], pip.y[i], vx, vy) !== pip.inside[i]) mism++;
    }
    expect(mism).toBe(0);
  });

  it("uses the same results in the optimized bulk-mask path", () => {
    const vertices = pip.polygon as Vertex[];
    expect(Array.from(gateMaskPolygon(pip.x, pip.y, vertices))).toEqual(
      pip.inside.map((inside) => inside ? 1 : 0),
    );
  });
});

describe("gateMaskPolygon boundary semantics (sp >= 1)", () => {
  const square: Vertex[] = [
    [0, 0], [0, 2], [2, 2], [2, 0],
  ];
  it("inside → 1, outside → 0, on-edge and on-vertex → 1", () => {
    const x = [1, 3, 0, 2]; // inside, outside, on-edge(left), on-vertex
    const y = [1, 1, 1, 2];
    const m = gateMaskPolygon(x, y, square);
    expect(Array.from(m)).toEqual([1, 0, 1, 1]);
  });

  it("matches the point oracle for concave polygons, bounds, and boundary points", () => {
    const concave: Vertex[] = [
      [-2, -1], [2, -1], [2, 2], [0, 0.25], [-2, 2],
    ];
    const x = [-3, -2, -1.5, 0, 0, 1, 2, 2.5, Number.NaN];
    const y = [0, -1, 1, 0.25, 1.5, 0, 2, 0, 0];
    const vx = concave.map((v) => v[0]);
    const vy = concave.map((v) => v[1]);
    const expected = x.map((px, i) => pointInPolygon(px, y[i], vx, vy) ? 1 : 0);
    expect(Array.from(gateMaskPolygon(x, y, concave))).toEqual(expected);
  });
});

describe("gateMaskRectangle", () => {
  // Events are placed exactly on each edge and corner of the box x in [-1, 2], y in [-1, 3],
  // given by unordered opposite corners.
  const rect: Vertex[] = [[2, 3], [-1, -1]];
  const events: Record<string, [number, number]> = {
    interior: [0, 0],
    "left edge": [-1, 1], "bottom edge": [0.5, -1], "right edge": [2, 1], "top edge": [0.5, 3],
    "lower-left corner": [-1, -1], "lower-right corner": [2, -1],
    "upper-left corner": [-1, 3], "upper-right corner": [2, 3],
    "just below the right edge": [Math.fround(2 - 1e-6), 1],
    "beyond the right edge": [2.5, 1], "beyond the left edge": [-2, 1],
  };
  const names = Object.keys(events);
  const x = Float32Array.from(names.map((k) => events[k][0]));
  const y = Float32Array.from(names.map((k) => events[k][1]));
  const inside = (m: Uint8Array) => names.filter((_, i) => m[i] === 1);
  const CLOSED = [
    "interior", "left edge", "bottom edge", "right edge", "top edge", "lower-left corner",
    "lower-right corner", "upper-left corner", "upper-right corner", "just below the right edge",
  ];

  it("is closed without a rule, as every rectangle was before rules existed, whatever the corner order", () => {
    expect(inside(gateMaskRectangle(x, y, rect))).toEqual(CLOSED);
    expect(inside(gateMaskRectangle(x, y, rect, "closed"))).toEqual(CLOSED);
    expect(Array.from(gateMaskRectangle(x, y, [[-1, -1], [2, -1], [2, 3], [-1, 3]])))
      .toEqual(Array.from(gateMaskRectangle(x, y, rect)));
  });

  it("is half-open under Gating-ML's rule: lower edges in, upper edges out", () => {
    expect(inside(gateMaskRectangle(x, y, rect, "half-open"))).toEqual([
      "interior", "left edge", "bottom edge", "lower-left corner", "just below the right edge",
    ]);
  });

  it("reads the rule from the gate in getGateMask, absent being closed", () => {
    const data: AssayData = { n: names.length, column: (c) => (c === "X" ? x : c === "Y" ? y : undefined) };
    const legacy = newGate("Box", "rectangle", "X", "Y", rect);
    expect(legacy.bounds).toBeUndefined();
    expect(inside(getGateMask(legacy, data))).toEqual(CLOSED);
    expect(Array.from(getGateMask({ ...legacy, bounds: "half-open" }, data)))
      .toEqual(Array.from(gateMaskRectangle(x, y, rect, "half-open")));
  });

  it("lets half-open rectangles that share an edge split the events on it, none twice and none missed", () => {
    // The vertex snap puts neighbouring gates exactly on each other's edges; integer-valued
    // channels (mass cytometry counts, Time) then put events exactly on those edges.
    const gx = new Float32Array(121), gy = new Float32Array(121);
    for (let i = 0; i < 121; i++) { gx[i] = i % 11; gy[i] = Math.floor(i / 11); }
    const whole = gateMaskRectangle(gx, gy, [[2, 3], [8, 7]], "half-open");
    const left = gateMaskRectangle(gx, gy, [[2, 3], [5, 7]], "half-open");
    const right = gateMaskRectangle(gx, gy, [[5, 3], [8, 7]], "half-open");
    for (let i = 0; i < 121; i++) {
      expect(left[i] + right[i], `event (${gx[i]}, ${gy[i]})`).toBe(whole[i]);
    }
    expect(whole.reduce((s, v) => s + v, 0)).toBe(6 * 4);
    expect(gateMaskRectangle(gx, gy, [[2, 3], [8, 7]], "closed").reduce((s, v) => s + v, 0)).toBe(7 * 5);
  });

  it("treats a one-dimensional range, both axes on one channel, by the same rule", () => {
    const t = Float32Array.from([0, 1, 2, 3, 4, 5]);
    expect(Array.from(gateMaskRectangle(t, t, [[1, 1], [4, 4]], "half-open"))).toEqual([0, 1, 1, 1, 0, 0]);
    expect(Array.from(gateMaskRectangle(t, t, [[1, 1], [4, 4]]))).toEqual([0, 1, 1, 1, 1, 0]);
  });

  it("selects nothing when half-open and zero-width, and the events on it when closed", () => {
    const t = Float32Array.from([0, 1, 2]);
    expect(Array.from(gateMaskRectangle(t, t, [[1, 1], [1, 1]], "half-open"))).toEqual([0, 0, 0]);
    expect(Array.from(gateMaskRectangle(t, t, [[1, 1], [1, 1]], "closed"))).toEqual([0, 1, 0]);
  });
});

describe("upperBoundForReader", () => {
  // Writing a rectangle for a tool with the other edge rule moves only its upper bounds, and
  // only far enough that the tool's rule gives GateLab's answer on every float32 event.
  const v = Float32Array.from([-3, -1e-40, 0, 1e-40, 0.5, 1, Math.fround(1 + 1e-7), 1000, Math.fround(1000.0001), 262143, 262144, 262145]);
  const closedMask = (hi: number) => v.map((e) => (e >= -3 && e <= hi ? 1 : 0));
  const halfOpenMask = (hi: number) => v.map((e) => (e >= -3 && e < hi ? 1 : 0));

  it("writes a half-open gate for a closed reader just below the edge", () => {
    for (const max of [0, 1, 1000, 262144, -1]) {
      expect(Array.from(closedMask(upperBoundForReader(max, "half-open", "closed"))), `max ${max}`)
        .toEqual(Array.from(halfOpenMask(max)));
    }
  });

  it("writes a closed gate for a half-open reader just above the edge", () => {
    for (const max of [0, 1, 1000, 262144, -1]) {
      expect(Array.from(halfOpenMask(upperBoundForReader(max, "closed", "half-open"))), `max ${max}`)
        .toEqual(Array.from(closedMask(max)));
    }
  });

  it("leaves the bound alone when both sides use the same rule", () => {
    expect(upperBoundForReader(1000, "half-open", "half-open")).toBe(1000);
    expect(upperBoundForReader(1000, "closed", "closed")).toBe(1000);
  });

  it("leaves an edge with no bound, at or beyond the largest double or at the importer's 1e9, where it is", () => {
    // An edge Gating-ML states no bound for is held at ±1e9 by the importer (gatingml.ts), and at
    // the largest finite double on the Gating-ML hardening branch (its UNBOUNDED); an exporter
    // writes either as no bound. Moved, it would become a bound, or Infinity.
    for (const max of [Number.MAX_VALUE, -Number.MAX_VALUE, Infinity, -Infinity, 1e9, -1e9]) {
      expect(upperBoundForReader(max, "half-open", "closed")).toBe(max);
      expect(upperBoundForReader(max, "closed", "half-open")).toBe(max);
    }
    expect(rangeForReader(-Number.MAX_VALUE, Number.MAX_VALUE, "half-open", "closed")).toEqual([-Number.MAX_VALUE, Number.MAX_VALUE]);
    expect(rangeForReader(5, Number.MAX_VALUE, "half-open", "closed")).toEqual([5, Number.MAX_VALUE]);
    expect(rangeForReader(5, 1e9, "half-open", "closed")).toEqual([5, 1e9]);
    // A bound near the importer's open one is a bound, and moves.
    expect(upperBoundForReader(999999999, "half-open", "closed")).toBeLessThan(999999999);
  });

  it("keeps every float32 value on GateLab's side of a bound that lies within the shift of one", () => {
    // The shift is 1e-13 of the bound, and float32 values are 6e-8 of their size apart, so none
    // lies within it of a bound that is itself a float32 value. A bound a few doubles off one is
    // not: 4203.130371093751, one double above the float32 4203.13037109375, was moved below it,
    // and a closed reader dropped the events on it that the half-open gate holds.
    const DV = new DataView(new ArrayBuffer(8));
    const step = (x: number, k: number) => {
      DV.setFloat64(0, x);
      const b = DV.getBigUint64(0);
      DV.setBigUint64(0, (x >= 0) === (k > 0) ? b + BigInt(Math.abs(k)) : b - BigInt(Math.abs(k)));
      return DV.getFloat64(0);
    };
    const f32s = [4203.13037109375, 1, 0.5, 262143, 7.099999904632568, -60, -1e-3, 1e-30, 3.4e38].map(Math.fround);
    for (const f of f32s) {
      const nextUp = new Float32Array([f]);
      const bits = new Int32Array(nextUp.buffer);
      bits[0] += f > 0 ? 1 : -1;
      const g = nextUp[0]; // the float32 after f, away from zero
      for (const k of [1, 2, 3, 50, 1000]) {
        for (const max of [step(f, k), step(f, -k), f * (1 + 1e-14), f * (1 - 1e-14)]) {
          const top = upperBoundForReader(max, "half-open", "closed");
          const low = upperBoundForReader(max, "closed", "half-open");
          for (const e of [f, g].map(Math.fround)) {
            expect(e <= top, `half-open ${max} for a closed reader, event ${e}`).toBe(e < max);
            expect(e < low, `closed ${max} for a half-open reader, event ${e}`).toBe(e <= max);
          }
        }
      }
    }
  });

  it("keeps the shift through a file's fifteen significant digits", () => {
    const written = Number(fmtNum(upperBoundForReader(262144, "closed", "half-open")));
    expect(written).toBeGreaterThan(262144);
    expect(written).toBeLessThan(Math.fround(262144 + 0.03125));
  });
});

describe("polygon, ellipse and quadrant boundaries (Gating-ML 2.0 sections 5.2-5.4)", () => {
  it("counts an event on any polygon edge or vertex as inside", () => {
    // Horizontal, vertical and oblique edges, and a concave vertex. Section 5.2.1: "the boundary
    // is considered as inclusive". FlowKit drops the right and upper edges; GateLab does not.
    const poly: Vertex[] = [[0, 0], [8, 0], [8, 4], [4, 8], [0, 8], [2, 4]];
    const pts: [number, number][] = [
      [4, 0], [8, 2], [6, 6], [2, 8], [1, 6], [1, 2], // one on each edge
      ...poly, // every vertex
    ];
    const m = gateMaskPolygon(Float32Array.from(pts.map((p) => p[0])), Float32Array.from(pts.map((p) => p[1])), poly);
    expect(Array.from(m)).toEqual(pts.map(() => 1));
    // And just outside each edge, out.
    const out: [number, number][] = [[4, -0.01], [8.01, 2], [6.01, 6.01], [2, 8.01], [0.99, 6], [0.99, 2]];
    const o = gateMaskPolygon(out.map((p) => p[0]), out.map((p) => p[1]), poly);
    expect(Array.from(o)).toEqual(out.map(() => 0));
  });

  it("counts an event on an ellipse's boundary as inside", () => {
    // Section 5.3.1: (x - mu)' C^-1 (x - mu) <= D^2. A circle of radius 5 about (10, 10), with
    // boundary points whose quadratic form is exactly 25 in floating point.
    const gate = {
      gate_id: "e", name: "Round", gate_type: "ellipse" as const, x_channel: "X", y_channel: "Y",
      mean: [10, 10] as [number, number], covariance: [[1, 0], [0, 1]] as [[number, number], [number, number]],
      distance_square: 25, color: "#000", label_offset: null,
    };
    const px = [15, 10, 13, 7, 6, 15.001], py = [10, 15, 14, 6, 13, 10];
    const data: AssayData = { n: px.length, column: (c) => (c === "X" ? px : py) };
    expect(Array.from(getGateMask(gate, data))).toEqual([1, 1, 1, 1, 1, 0]);
  });

  it("puts an event on a quadrant divider on the divider's upper side", () => {
    // Section 5.4.1: 500 <= x < 1000 for the middle quadrant, so a value equal to a divider
    // belongs above it. The crosshair is at (0, 0).
    const px = [0, 0, 0, -1, 1];
    const py = [1, -1, 0, 0, 0];
    const quad = (q: number) => Array.from(gateMaskQuadrant(px, py, [0, 0], q));
    expect(quad(1)).toEqual([0, 0, 0, 1, 0]); // x-/y+: the left arm of the horizontal divider
    expect(quad(2)).toEqual([1, 0, 1, 0, 1]); // x+/y+: the upper vertical arm, the crosshair, the right arm
    expect(quad(3)).toEqual([0, 1, 0, 0, 0]); // x+/y-: the lower vertical arm
    expect(quad(4)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("gateMaskQuadrant", () => {
  const center: [number, number] = [0, 0];
  const x = [-1, 1, 1, -1, 0]; // Q1, Q2, Q3, Q4, crosshair
  const y = [1, 1, -1, -1, 0];
  it("numbers quadrants 1=x-/y+ … 4=x-/y-, ties → Q2", () => {
    expect(Array.from(gateMaskQuadrant(x, y, center, 1))).toEqual([1, 0, 0, 0, 0]);
    expect(Array.from(gateMaskQuadrant(x, y, center, 2))).toEqual([0, 1, 0, 0, 1]);
    expect(Array.from(gateMaskQuadrant(x, y, center, 3))).toEqual([0, 0, 1, 0, 0]);
    expect(Array.from(gateMaskQuadrant(x, y, center, 4))).toEqual([0, 0, 0, 1, 0]);
  });
});

describe("getGateMask", () => {
  it("returns all-false for a missing channel", () => {
    const g = newGate("g", "rectangle", "CDx", "CDy", [[0, 0], [1, 1]]);
    const m = getGateMask(g, assay({ CDx: [0.5], CDz: [0.5] }));
    expect(Array.from(m)).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// Strategy BFS
// ---------------------------------------------------------------------------

describe("applyGatingStrategy", () => {
  // 6 events on a CD3/CD19 grid.
  const data = assay({
    CD3: [1, 1, 1, -1, -1, -1],
    CD19: [1, 1, -1, 1, -1, -1],
  });

  function tree() {
    const root = newRootPopulation(data.n);
    const pops: PopulationMap = { [root.population_id]: root };
    return { root, pops };
  }

  it("root = all events; AND child = parent ∩ gate", () => {
    const { root, pops } = tree();
    // rectangle capturing CD3 >= 0 (x in [0,2], y in [-2,2]) → 3 events
    const g = newGate("CD3+", "rectangle", "CD3", "CD19", [[0, -2], [2, 2]]);
    const gates: Record<string, Gate> = { [g.gate_id]: g };
    const child = newPopulation("CD3+", [newGateRef(g.gate_id, true)], root.population_id);
    pops[child.population_id] = child;
    linkChildToParent(pops, child.population_id, root.population_id);

    const { populations } = applyGatingStrategy(gates, pops, root.population_id, data);
    expect(populations[root.population_id].event_count).toBe(6);
    expect(populations[child.population_id].event_count).toBe(3);
    expect(populations[child.population_id].percent_of_parent).toBe(50);
  });

  it("exclude (include=false) inverts the gate within the parent", () => {
    const { root, pops } = tree();
    const g = newGate("CD3+", "rectangle", "CD3", "CD19", [[0, -2], [2, 2]]);
    const gates: Record<string, Gate> = { [g.gate_id]: g };
    const child = newPopulation("CD3-", [newGateRef(g.gate_id, false)], root.population_id);
    pops[child.population_id] = child;
    linkChildToParent(pops, child.population_id, root.population_id);

    const { populations } = applyGatingStrategy(gates, pops, root.population_id, data);
    expect(populations[child.population_id].event_count).toBe(3); // the CD3- half
  });

  it("AND of two gates vs OR of two gates", () => {
    const { root, pops } = tree();
    const gx = newGate("CD3+", "rectangle", "CD3", "CD19", [[0, -2], [2, 2]]); // CD3>=0 → 3
    const gy = newGate("CD19+", "rectangle", "CD3", "CD19", [[-2, 0], [2, 2]]); // CD19>=0 → 3
    const gates: Record<string, Gate> = { [gx.gate_id]: gx, [gy.gate_id]: gy };

    const andPop = newPopulation(
      "CD3+CD19+",
      [newGateRef(gx.gate_id, true), newGateRef(gy.gate_id, true)],
      root.population_id,
      "and",
    );
    const orPop = newPopulation(
      "CD3+ or CD19+",
      [newGateRef(gx.gate_id, true), newGateRef(gy.gate_id, true)],
      root.population_id,
      "or",
    );
    pops[andPop.population_id] = andPop;
    pops[orPop.population_id] = orPop;
    linkChildToParent(pops, andPop.population_id, root.population_id);
    linkChildToParent(pops, orPop.population_id, root.population_id);

    const { populations } = applyGatingStrategy(gates, pops, root.population_id, data);
    // events: (CD3,CD19) = (1,1)(1,1)(1,-1)(-1,1)(-1,-1)(-1,-1)
    // CD3>=0: idx0,1,2 ; CD19>=0: idx0,1,3
    expect(populations[andPop.population_id].event_count).toBe(2); // idx0,1
    expect(populations[orPop.population_id].event_count).toBe(4); // idx0,1,2,3
  });

  it("nested child computes percent_of_parent against its own parent", () => {
    const { root, pops } = tree();
    const gx = newGate("CD3+", "rectangle", "CD3", "CD19", [[0, -2], [2, 2]]); // 3 of 6
    const gy = newGate("CD19+", "rectangle", "CD3", "CD19", [[-2, 0], [2, 2]]);
    const gates: Record<string, Gate> = { [gx.gate_id]: gx, [gy.gate_id]: gy };
    const p1 = newPopulation("CD3+", [newGateRef(gx.gate_id, true)], root.population_id);
    pops[p1.population_id] = p1;
    linkChildToParent(pops, p1.population_id, root.population_id);
    const p2 = newPopulation("CD3+CD19+", [newGateRef(gy.gate_id, true)], p1.population_id);
    pops[p2.population_id] = p2;
    linkChildToParent(pops, p2.population_id, p1.population_id);

    const { populations } = applyGatingStrategy(gates, pops, root.population_id, data);
    expect(populations[p1.population_id].event_count).toBe(3);
    expect(populations[p2.population_id].event_count).toBe(2); // idx0,1 within CD3+
    expect(populations[p2.population_id].percent_of_parent).toBeCloseTo(66.67, 2);
  });
});

describe("computeGateCounts with a quadrant gate", () => {
  const data = assay({
    CD3: [1, 1, -1, -1, 0],
    CD19: [1, -1, 1, -1, 0],
  });
  it("returns four quadrant counts relative to the parent", () => {
    const q = newQuadrantGate("quad", "CD3", "CD19", [0, 0]);
    const counts = computeGateCounts({ [q.gate_id]: q }, null, data);
    const quads = counts[q.gate_id].quadrants!;
    // Q1 x-/y+: idx2 ; Q2 x+/y+ (ties): idx0,idx4 ; Q3 x+/y-: idx1 ; Q4 x-/y-: idx3
    expect(quads.map((z) => z.event_count)).toEqual([1, 2, 1, 1]);
  });
});

// ---------------------------------------------------------------------------
// Tree operations
// ---------------------------------------------------------------------------

describe("tree ops", () => {
  it("sortPopulationTree normalises children without changing their stored order", () => {
    const root = newRootPopulation(0);
    const pops: PopulationMap = { [root.population_id]: root };
    const names = ["beta", "Alpha", "gamma", "Delta"];
    const ids: string[] = [];
    for (const nm of names) {
      const p = newPopulation(nm, [], root.population_id);
      pops[p.population_id] = p;
      ids.push(p.population_id);
      linkChildToParent(pops, p.population_id, root.population_id);
    }
    pops[root.population_id].children = [
      ids[0],
      ids[1],
      ids[0],
      "missing",
      root.population_id,
      ids[2],
      ids[3],
    ];
    sortPopulationTree(pops, root.population_id);
    const ordered = pops[root.population_id].children.map((c) => pops[c].name);
    expect(ordered).toEqual(["beta", "Alpha", "gamma", "Delta"]);
  });

  it("sortPopulationTreeAlpha alphabetises siblings only when explicitly requested", () => {
    const root = newRootPopulation(0);
    const pops: PopulationMap = { [root.population_id]: root };
    for (const name of ["beta", "Alpha", "gamma", "Delta"]) {
      const child = newPopulation(name, [], root.population_id);
      pops[child.population_id] = child;
      linkChildToParent(pops, child.population_id, root.population_id);
    }
    sortPopulationTreeAlpha(pops, root.population_id);
    const ordered = pops[root.population_id].children.map((childId) => pops[childId].name);
    expect(ordered).toEqual(["Alpha", "beta", "Delta", "gamma"]);
  });

  it("wouldCreateCycle detects an ancestor loop", () => {
    const root = newRootPopulation(0);
    const pops: PopulationMap = { [root.population_id]: root };
    const a = newPopulation("a", [], root.population_id);
    pops[a.population_id] = a;
    linkChildToParent(pops, a.population_id, root.population_id);
    const b = newPopulation("b", [], a.population_id);
    pops[b.population_id] = b;
    linkChildToParent(pops, b.population_id, a.population_id);
    // reparenting a under b would loop
    expect(wouldCreateCycle(pops, a.population_id, b.population_id)).toBe(true);
    expect(wouldCreateCycle(pops, b.population_id, root.population_id)).toBe(false);
  });
});

// ── Repeated vertices ────────────────────────────────────────────────────────────────────────
//
// A repeated vertex makes a zero-length edge, and a zero-length edge has dx = dy = 0, so its
// cross product and dot product are identically zero for every point. The on-boundary test
// therefore fired for EVERY event inside the bounding box and the gate selected the whole box:
// a real biex polygon went from 790 events to 899, its exact bounding-box count.
//
// This is routine input, not a pathological case. polygonOutline closes its ring by repeating the
// first vertex, so every densified polygon GateLab exports carries one, and Gating-ML written by
// other tools often closes rings explicitly. Caught 2026-08-24 by the Gating-ML round-trip test
// once its fixture gates were made discriminating enough to have events near their boundaries.
describe("polygon masks tolerate repeated vertices", () => {
  // A unit triangle, and points chosen so that "inside the triangle" and "inside the bounding
  // box" differ: (0.9, 0.9) is in the box but outside the hypotenuse.
  const tri: [number, number][] = [[0, 0], [1, 0], [0, 1]];
  const xs = [0.1, 0.9, 0.25];
  const ys = [0.1, 0.9, 0.25];
  const expected = [1, 0, 1];

  it("gives the same mask with the ring closed explicitly", () => {
    expect(Array.from(gateMaskPolygon(xs, ys, tri))).toEqual(expected);
    expect(Array.from(gateMaskPolygon(xs, ys, [...tri, [0, 0]]))).toEqual(expected);
  });

  it("gives the same mask with a vertex repeated mid-ring", () => {
    expect(Array.from(gateMaskPolygon(xs, ys, [[0, 0], [1, 0], [1, 0], [0, 1]]))).toEqual(expected);
  });

  it("does not select the bounding box when every vertex is repeated", () => {
    const doubled = tri.flatMap((v) => [v, v]) as [number, number][];
    expect(Array.from(gateMaskPolygon(xs, ys, doubled))).toEqual(expected);
  });

  it("still counts a point genuinely on an edge as inside", () => {
    // The guard must not disable the on-boundary test for real edges.
    expect(Array.from(gateMaskPolygon([0.5], [0], [...tri, [0, 0]]))).toEqual([1]);
  });

  // pointInPolygon had the same fault, and worse: its edge test took a zero-length edge for one of
  // length 1, so a repeated vertex put EVERY point on the boundary, not just the bounding box. The
  // Gating-ML export of a FlowJo grid polygon enumerates its cells with it, and a grid polygon with
  // two vertices on one channel pair was written as a ring round the whole plane.
  it("holds no point off the polygon in pointInPolygon either", () => {
    const vx = [0, 1, 1, 0];
    const vy = [0, 0, 0, 1];
    for (let i = 0; i < xs.length; i++) expect(pointInPolygon(xs[i], ys[i], vx, vy)).toBe(expected[i] === 1);
    expect(pointInPolygon(50, 50, vx, vy)).toBe(false);
    expect(pointInPolygon(-3, 7, [0, 0, 1, 0], [0, 0, 0, 1])).toBe(false);
  });

  // A zero-length edge holds its one point, as every edge holds its own points: the boundary of a
  // polygon whose vertices all coincide is that point. This is the rule the reference
  // implementation of FlowJo's grid applies (a closed test on integers), and only a polygon with
  // every vertex on one point differs by it; FlowJo's own count for one has not been measured.
  it("holds the one point of a polygon whose vertices all coincide, and nothing else", () => {
    const px = [5, 5, 6, 4.999999];
    const py = [5, 6, 5, 5];
    expect(Array.from(gateMaskPolygon(px, py, [[5, 5], [5, 5], [5, 5]]))).toEqual([1, 0, 0, 0]);
    expect(px.map((x, i) => pointInPolygon(x, py[i], [5, 5, 5], [5, 5, 5]))).toEqual([true, false, false, false]);
  });
});

import * as curly from "./gates";

// FlowJo's curly quad: beyond the crosshair the horizontal arm rises and the vertical arm bends
// right, by k · d^power; to the left and below, the dividers are straight. Membership is
// decided against the divider's position at the event's own coordinate.
describe("quadrant gate with curled arms", () => {
  const curl = { power: 1.5, kx: 0.012, ky: 0.012 };
  const centre: [number, number] = [100, 100];
  // The horizontal arm at x = 200 sits at y = 100 + 0.012 · 100^1.5 = 112; the vertical arm at
  // y = 200 sits at x = 112.
  const xs = [200, 200, 112.5, 111.5, 50, 50, 100];
  const ys = [111, 113, 200, 200, 150, 50, 100];

  it("assigns events to quadrants against the bent dividers", () => {
    const q = (n: number) => Array.from(curly.gateMaskQuadrant(xs, ys, centre, n, curl));
    // (200, 111): right of the crosshair but BELOW the risen arm -> lower right, not upper.
    expect(q(3)[0]).toBe(1); expect(q(2)[0]).toBe(0);
    // (200, 113): just above the arm -> upper right.
    expect(q(2)[1]).toBe(1);
    // (112.5, 200): right of the bent vertical arm -> upper right; (111.5, 200): left of it.
    expect(q(2)[2]).toBe(1); expect(q(1)[3]).toBe(1);
    // Left of and below the crosshair the dividers are straight.
    expect(q(1)[4]).toBe(1); expect(q(4)[5]).toBe(1);
    // The crosshair itself falls in quadrant 2, as before.
    expect(q(2)[6]).toBe(1);
    // Exactly one quadrant per event.
    for (let i = 0; i < xs.length; i++) {
      expect(q(1)[i] + q(2)[i] + q(3)[i] + q(4)[i]).toBe(1);
    }
  });

  it("is the straight crosshair when the curl is absent or zero", () => {
    for (const c of [undefined, { power: 1.5, kx: 0, ky: 0 }]) {
      const q2 = Array.from(curly.gateMaskQuadrant(xs, ys, centre, 2, c));
      // (200, 111) is above the straight divider at y = 100.
      expect(q2[0]).toBe(1);
    }
  });

  it("traces each arm from the crosshair to the axis end, in the gate's own coordinates", () => {
    const h = curly.quadrantArmPoints(centre, curl, "h", 200, 4);
    expect(h[0]).toEqual([100, 100]);
    expect(h[4][0]).toBe(200);
    expect(h[4][1]).toBeCloseTo(112, 9);
    const v = curly.quadrantArmPoints(centre, curl, "v", 200, 4);
    expect(v[4]).toEqual([expect.closeTo(112, 9), 200]);
    // An axis that ends before the crosshair has no arm to draw.
    expect(curly.quadrantArmPoints(centre, curl, "h", 50)).toEqual([]);
  });
});

// ── Many edges ───────────────────────────────────────────────────────────────────────────────
//
// A polygon exported to be exact in raw space carries thousands of short edges (a biex polygon is
// split at every entry of its table it crosses), and GateLab reads it back as such. Testing every
// event against every edge made gating one of those twenty times slower than the polygon it came
// from. The mask now tests each event against the edges of its own horizontal band only.
describe("a polygon with thousands of edges", () => {
  /** The mask as it was: every event against every edge. */
  function everyEdge(xs: ArrayLike<number>, ys: ArrayLike<number>, vertices: Vertex[]): Uint8Array {
    const out = new Uint8Array(xs.length);
    const m = vertices.length;
    for (let i = 0; i < xs.length; i++) {
      const px = xs[i];
      const py = ys[i];
      let inside = false;
      for (let k = 0; k < m; k++) {
        const [ax, ay] = vertices[(k + m - 1) % m];
        const [bx, by] = vertices[k];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (len2 > 0 && Math.abs(dx * (py - ay) - dy * (px - ax)) <= 1e-9 * Math.sqrt(len2)) {
          const dot = (px - ax) * dx + (py - ay) * dy;
          if (dot >= -1e-12 && dot <= len2 + 1e-12) { inside = true; break; }
        }
        if ((ay > py) !== (by > py) && px < ax + ((py - ay) * dx) / dy) inside = !inside;
      }
      out[i] = inside ? 1 : 0;
    }
    return out;
  }
  /** Deterministic uniform [0, 1). */
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  /** A wobbly ring of `m` vertices, with repeated vertices, flat runs, and a skirt out to -1e15. */
  const ring = (m: number, seed: number): Vertex[] => {
    const u = rng(seed);
    const out: Vertex[] = [];
    for (let k = 0; k < m; k++) {
      const t = (2 * Math.PI * k) / m;
      const r = 100 * (1 + 0.3 * Math.sin(7 * t) + 0.05 * u());
      out.push([Math.round(r * Math.cos(t) * 8) / 8, k % 50 < 3 ? 0 : Math.round(r * Math.sin(t) * 8) / 8]);
      if (k % 97 === 0) out.push(out[out.length - 1]);
    }
    const j = out.findIndex((v) => v[1] === 0);
    out.splice(j + 1, 0, [out[j][0], -1e15], [out[j][0] - 5, -1e15], [out[j][0] - 5, 0]);
    return out;
  };

  it("selects exactly what testing every edge selects, on edges, vertices and ties included", () => {
    for (const seed of [1, 2, 3]) {
      const verts = ring(1500, seed);
      const u = rng(seed + 10);
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < 8000; i++) { xs.push(Math.round((260 * u() - 130) * 8) / 8); ys.push(Math.round((260 * u() - 130) * 8) / 8); }
      // Every vertex, every edge's midpoint, and points far below the ring, where the skirt is.
      verts.forEach(([x, y], k) => {
        const [bx, by] = verts[(k + 1) % verts.length];
        xs.push(x, (x + bx) / 2, x);
        ys.push(y, (y + by) / 2, -1e14);
      });
      const want = everyEdge(xs, ys, verts);
      expect(want.some((v) => v === 1) && want.some((v) => v === 0)).toBe(true);
      expect(Array.from(gateMaskPolygon(xs, ys, verts))).toEqual(Array.from(want));
    }
  }, 60000);

  it("costs about what a polygon of a few dozen edges costs", () => {
    const verts = ring(20000, 4);
    const u = rng(5);
    const n = 100000;
    const xs = Float32Array.from({ length: n }, () => 260 * u() - 130);
    const ys = Float32Array.from({ length: n }, () => 260 * u() - 130);
    const t0 = performance.now();
    gateMaskPolygon(xs, ys, verts);
    const ms = performance.now() - t0;
    // Every event against every edge took about 10 s here.
    expect(ms).toBeLessThan(1500);
  }, 60000);
});
