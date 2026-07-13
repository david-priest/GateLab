import { describe, it, expect } from "vitest";
import {
  pointInPolygon,
  gateMaskPolygon,
  gateMaskRectangle,
  gateMaskQuadrant,
  getGateMask,
  type AssayData,
} from "./gates";
import { applyGatingStrategy, computeGateCounts } from "./populations";
import {
  newGate,
  newQuadrantGate,
  newGateRef,
  newPopulation,
  newRootPopulation,
  linkChildToParent,
  sortPopulationTree,
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
  it("is inclusive on both bounds regardless of corner order", () => {
    const rect: Vertex[] = [
      [2, 3], [-1, -1],
    ]; // opposite corners, unordered
    const x = [0, -1, 2, 2.5, -2];
    const y = [0, -1, 3, 1, 1];
    const m = gateMaskRectangle(x, y, rect);
    expect(Array.from(m)).toEqual([1, 1, 1, 0, 0]);
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
  it("sortPopulationTree orders children case-insensitively by name", () => {
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
    sortPopulationTree(pops, root.population_id);
    const ordered = pops[root.population_id].children.map((c) => pops[c].name);
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
