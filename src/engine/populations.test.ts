import { describe, it, expect } from "vitest";
import {
  applyGatingStrategy,
  computeGateCounts,
  computeGateMasks,
  createGateMaskMemo,
  populationTreeOrder,
  pickPopColorSlot,
  ensurePopColorSlots,
} from "./populations";
import type { AssayData } from "./gates";
import type { Gate, Population, PopulationMap } from "./models";

// Population constructor (mirrors factors.test.ts, but exposes gate_refs / gate_logic).
const pop = (
  id: string,
  name: string,
  parent: string | null,
  children: string[],
  gate_refs: Population["gate_refs"] = [],
  gate_logic: "and" | "or" = "and",
): Population => ({
  population_id: id,
  name,
  gate_refs,
  gate_logic,
  parent_id: parent,
  children,
  event_count: null,
  percent_of_parent: null,
});

// Axis-aligned rectangle gate on channels x / y.
const rect = (id: string, xMin: number, xMax: number, yMin: number, yMax: number): Gate => ({
  gate_id: id,
  name: id,
  gate_type: "rectangle",
  x_channel: "x",
  y_channel: "y",
  vertices: [
    [xMin, yMin],
    [xMax, yMax],
  ],
  color: "#000000",
  label_offset: null,
});

// Quadrant gate centred at (cx, cy) on channels x / y.
const quad = (id: string, cx: number, cy: number): Gate => ({
  gate_id: id,
  name: id,
  gate_type: "quadrant",
  x_channel: "x",
  y_channel: "y",
  center: [cx, cy],
  color: "#000000",
  label_offset: null,
});

// AssayData backed by plain column arrays keyed by channel name.
const assay = (cols: Record<string, number[]>, n: number): AssayData => ({
  n,
  column: (ch: string) => {
    const c = cols[ch];
    return c ? Float32Array.from(c) : undefined;
  },
});

describe("applyGatingStrategy — gate_logic 'or' union path", () => {
  it("takes the union of two gate refs, intersected with the parent", () => {
    // x = 5,25,50,5 ; g1 keeps x∈[0,10] → {0,3}; g2 keeps x∈[20,30] → {1}.
    const data = assay({ x: [5, 25, 50, 5], y: [1, 1, 1, 1] }, 4);
    const gates: Record<string, Gate> = {
      g1: rect("g1", 0, 10, 0, 100),
      g2: rect("g2", 20, 30, 0, 100),
    };
    const pops: PopulationMap = {
      root: pop("root", "All", null, ["u"]),
      u: pop(
        "u",
        "Union",
        "root",
        [],
        [
          { gate_id: "g1", include: true },
          { gate_id: "g2", include: true },
        ],
        "or",
      ),
    };
    const { masks, populations } = applyGatingStrategy(gates, pops, "root", data);
    // Union = {0,1,3}
    expect(Array.from(masks.u)).toEqual([1, 1, 0, 1]);
    expect(populations.u.event_count).toBe(3);
    expect(populations.u.percent_of_parent).toBe(75); // 3/4
  });

  it("an excluded ref in the OR contributes its complement to the union", () => {
    // g1 keeps x∈[0,10] → {0,3}; NOT g2 (x∈[20,30]) → complement {0,2,3}. Union = {0,2,3}.
    const data = assay({ x: [5, 25, 50, 5], y: [1, 1, 1, 1] }, 4);
    const gates: Record<string, Gate> = {
      g1: rect("g1", 0, 10, 0, 100),
      g2: rect("g2", 20, 30, 0, 100),
    };
    const pops: PopulationMap = {
      root: pop("root", "All", null, ["u"]),
      u: pop(
        "u",
        "Union",
        "root",
        [],
        [
          { gate_id: "g1", include: true },
          { gate_id: "g2", include: false },
        ],
        "or",
      ),
    };
    const { masks } = applyGatingStrategy(gates, pops, "root", data);
    expect(Array.from(masks.u)).toEqual([1, 0, 1, 1]);
  });
});

describe("precomputed gate masks", () => {
  it("reuse gate geometry for strategy application and active-population counts", () => {
    const data = assay({ x: [1, 2, 8, 9], y: [1, 2, 8, 9] }, 4);
    const gates: Record<string, Gate> = { box: rect("box", 0, 5, 0, 5) };
    const pops: PopulationMap = {
      root: pop("root", "All", null, ["inside"]),
      inside: pop("inside", "Inside", "root", [], [{ gate_id: "box", include: true }]),
    };
    const gateMasks = computeGateMasks(gates, data);
    const cachedOnlyData: AssayData = {
      n: 4,
      column: () => {
        throw new Error("gate geometry was recomputed");
      },
    };

    const { masks } = applyGatingStrategy(gates, pops, "root", cachedOnlyData, gateMasks);
    const counts = computeGateCounts(gates, masks.inside, cachedOnlyData, gateMasks);

    expect(Array.from(masks.inside)).toEqual([1, 1, 0, 0]);
    expect(counts.box.event_count).toBe(2);
    expect(counts.box.percent_of_parent).toBe(100);
  });

  it("caches all four quadrant masks", () => {
    const data = assay({ x: [5, 15, 15, 5], y: [50, 150, 50, 150] }, 4);
    const gates: Record<string, Gate> = { q: quad("q", 10, 100) };
    const pops: PopulationMap = {
      root: pop("root", "All", null, ["q2"]),
      q2: pop("q2", "UR", "root", [], [{ gate_id: "q", include: true, quadrant: 2 }]),
    };
    const gateMasks = computeGateMasks(gates, data);
    const cachedOnlyData: AssayData = {
      n: 4,
      column: () => {
        throw new Error("quadrant geometry was recomputed");
      },
    };

    const { masks } = applyGatingStrategy(gates, pops, "root", cachedOnlyData, gateMasks);
    const counts = computeGateCounts(gates, masks.q2, cachedOnlyData, gateMasks);

    expect(Array.from(masks.q2)).toEqual([0, 1, 0, 0]);
    expect(counts.q.quadrants?.map((q) => q.event_count)).toEqual([0, 1, 0, 0]);
  });
});

describe("applyGatingStrategy — quadrant gate ref in a population", () => {
  it("selects only the requested quadrant (GateRef.quadrant)", () => {
    // center (10,100); quadrant 2 = x>=10 && y>=100.
    // events: (5,50)no (15,150)yes (15,50)no (5,150)no → {1}
    const data = assay({ x: [5, 15, 15, 5], y: [50, 150, 50, 150] }, 4);
    const gates: Record<string, Gate> = { q: quad("q", 10, 100) };
    const pops: PopulationMap = {
      root: pop("root", "All", null, ["q2"]),
      q2: pop("q2", "UR", "root", [], [{ gate_id: "q", include: true, quadrant: 2 }], "and"),
    };
    const { masks, populations } = applyGatingStrategy(gates, pops, "root", data);
    expect(Array.from(masks.q2)).toEqual([0, 1, 0, 0]);
    expect(populations.q2.event_count).toBe(1);
    expect(populations.q2.percent_of_parent).toBe(25); // 1/4
  });
});

describe("applyGatingStrategy — percent_of_parent through 3+ nested levels", () => {
  it("computes each level's percent relative to its own parent, not the root", () => {
    // x = 1..8. A: x∈[1,4] → 4/8 ; B: x∈[1,2] → 2/4 ; C: x==1 → 1/2. All 50%.
    const data = assay({ x: [1, 2, 3, 4, 5, 6, 7, 8], y: [1, 1, 1, 1, 1, 1, 1, 1] }, 8);
    const gates: Record<string, Gate> = {
      gA: rect("gA", 1, 4, 0, 10),
      gB: rect("gB", 1, 2, 0, 10),
      gC: rect("gC", 1, 1, 0, 10),
    };
    const pops: PopulationMap = {
      root: pop("root", "All", null, ["A"]),
      A: pop("A", "A", "root", ["B"], [{ gate_id: "gA", include: true }], "and"),
      B: pop("B", "B", "A", ["C"], [{ gate_id: "gB", include: true }], "and"),
      C: pop("C", "C", "B", [], [{ gate_id: "gC", include: true }], "and"),
    };
    const { populations } = applyGatingStrategy(gates, pops, "root", data);

    expect(populations.root.event_count).toBe(8);
    expect(populations.root.percent_of_parent).toBe(100);
    expect(populations.A.event_count).toBe(4);
    expect(populations.A.percent_of_parent).toBe(50);
    expect(populations.B.event_count).toBe(2);
    expect(populations.B.percent_of_parent).toBe(50);
    expect(populations.C.event_count).toBe(1);
    expect(populations.C.percent_of_parent).toBe(50); // 1/2, NOT 1/8
  });
});

describe("populationTreeOrder — depth + isLastPath for tree connectors", () => {
  // Root → Aaa → A1 (leaf); Root → Bbb (leaf). The stored child order is authoritative.
  const pops: PopulationMap = {
    root: pop("root", "Root", null, ["a", "b"]),
    a: pop("a", "Aaa", "root", ["a1"]),
    a1: pop("a1", "A1", "a", []),
    b: pop("b", "Bbb", "root", []),
  };

  it("emits shallow-first order with └/├/│ path flags matching the population tree", () => {
    expect(populationTreeOrder(pops, "root")).toEqual([
      { popId: "root", depth: 0, isLastPath: [] },
      { popId: "a", depth: 1, isLastPath: [false] }, // Aaa is not root's last child → ├, │ carries down
      { popId: "a1", depth: 2, isLastPath: [false, true] }, // A1 is Aaa's last child → └
      { popId: "b", depth: 1, isLastPath: [true] }, // Bbb is root's last child → └
    ]);
  });

  it("returns [] for a null/absent root", () => {
    expect(populationTreeOrder(pops, null)).toEqual([]);
    expect(populationTreeOrder(pops, "nope")).toEqual([]);
  });

  it("preserves a deliberately non-alphabetical sibling order", () => {
    const custom: PopulationMap = {
      root: pop("root", "Root", null, ["z", "a"]),
      z: pop("z", "Zulu", "root", []),
      a: pop("a", "Alpha", "root", []),
    };
    expect(populationTreeOrder(custom, "root").map(({ popId }) => popId)).toEqual([
      "root",
      "z",
      "a",
    ]);
  });
});

describe("colour slots — pickPopColorSlot / ensurePopColorSlots (freeze population colours)", () => {
  it("pickPopColorSlot returns the lowest unused slot", () => {
    expect(pickPopColorSlot({})).toBe(0);
    const p: PopulationMap = {
      a: { ...pop("a", "A", null, []), colorSlot: 0 },
      b: { ...pop("b", "B", null, []), colorSlot: 2 },
    };
    expect(pickPopColorSlot(p)).toBe(1); // 0 and 2 used → 1 is the lowest free
  });

  it("ensurePopColorSlots backfills in tree order, leaving the root uncoloured", () => {
    const pops: PopulationMap = {
      root: pop("root", "Root", null, ["a", "b"]),
      a: pop("a", "Aaa", "root", []),
      b: pop("b", "Bbb", "root", []),
    };
    ensurePopColorSlots(pops, "root");
    expect(pops.root.colorSlot).toBeUndefined(); // root/ungated never gets a slot
    expect(pops.a.colorSlot).toBe(0);
    expect(pops.b.colorSlot).toBe(1);
  });

  it("adding a population never changes an existing population's slot (the freeze guarantee)", () => {
    const pops: PopulationMap = { root: pop("root", "Root", null, ["a"]), a: pop("a", "Aaa", "root", []) };
    ensurePopColorSlots(pops, "root");
    const slotA = pops.a.colorSlot;
    pops.c = pop("c", "Ccc", "root", []);
    pops.root.children.push("c");
    pops.c.colorSlot = pickPopColorSlot(pops);
    expect(pops.a.colorSlot).toBe(slotA); // A's colour is frozen
    expect(pops.c.colorSlot).not.toBe(slotA);
  });
});

// A mask is a pure function of a gate's geometry and the two columns it reads, so the memo keys
// on exactly those, by reference. These cover both halves of that claim: unchanged inputs must
// reuse (or the fix does nothing), and any changed input must recompute (or it serves a stale
// mask, which would silently move population counts).
describe("computeGateMasks per-gate memo", () => {
  // Columns must be reference-stable for the memo to hit, exactly as Sample's caches make them.
  // The shared `assay` helper rebuilds a Float32Array per call, which would defeat it.
  const stableAssay = (cols: Record<string, number[]>, n: number): AssayData => {
    const built: Record<string, Float32Array> = {};
    for (const [ch, values] of Object.entries(cols)) built[ch] = Float32Array.from(values);
    return { n, column: (ch: string) => built[ch] };
  };

  const data = () => stableAssay({ x: [5, 25, 50, 5], y: [1, 1, 1, 1] }, 4);

  it("returns the very same mask object for a gate that did not change", () => {
    const memo = createGateMaskMemo();
    const gates = { g1: rect("g1", 0, 10, 0, 100), g2: rect("g2", 20, 30, 0, 100) };
    const d = data();

    const first = computeGateMasks(gates, d, memo);
    const second = computeGateMasks(gates, d, memo);

    // Reference identity: getGateMask allocates a fresh Uint8Array, so the same object back
    // proves it was not recomputed.
    expect(second.g1).toBe(first.g1);
    expect(second.g2).toBe(first.g2);
  });

  it("recomputes only the gate that moved", () => {
    const memo = createGateMaskMemo();
    const d = data();
    const gates = { g1: rect("g1", 0, 10, 0, 100), g2: rect("g2", 20, 30, 0, 100) };
    const first = computeGateMasks(gates, d, memo);

    // The store replaces the edited gate's object and keeps the others, as its reducer does.
    const moved = { ...gates, g1: rect("g1", 40, 60, 0, 100) };
    const second = computeGateMasks(moved, d, memo);

    expect(second.g2).toBe(first.g2);
    expect(second.g1).not.toBe(first.g1);
    // x = 5,25,50,5 — the moved gate now keeps only the third event.
    expect(Array.from(second.g1)).toEqual([0, 0, 1, 0]);
  });

  it("recomputes when the underlying column is replaced", () => {
    const memo = createGateMaskMemo();
    const gates = { g1: rect("g1", 0, 10, 0, 100) };
    const first = computeGateMasks(gates, data(), memo);

    // A fresh assay stands for compensation, an assay swap, or a transform change: Sample hands
    // back a different column object, and the gate object alone would not reveal that.
    const second = computeGateMasks(gates, data(), memo);

    expect(second.g1).not.toBe(first.g1);
    expect(Array.from(second.g1)).toEqual(Array.from(first.g1));
  });

  it("reuses every quadrant mask of an unchanged quadrant gate", () => {
    const memo = createGateMaskMemo();
    const gates = { q: quad("q", 20, 1) };
    const d = data();

    const first = computeGateMasks(gates, d, memo);
    const second = computeGateMasks(gates, d, memo);

    for (let q = 1; q <= 4; q++) {
      expect(second[`q::quadrant:${q}`]).toBe(first[`q::quadrant:${q}`]);
    }
  });

  it("forgets a deleted gate rather than retaining its mask", () => {
    const memo = createGateMaskMemo();
    const d = data();
    computeGateMasks({ g1: rect("g1", 0, 10, 0, 100), g2: rect("g2", 20, 30, 0, 100) }, d, memo);
    expect(memo.entries.size).toBe(2);

    computeGateMasks({ g1: rect("g1", 0, 10, 0, 100) }, d, memo);

    expect([...memo.entries.keys()]).toEqual(["g1"]);
  });

  it("matches an unmemoized recompute through a sequence of edits", () => {
    const memo = createGateMaskMemo();
    const d = data();
    const steps: Record<string, Gate>[] = [
      { g1: rect("g1", 0, 10, 0, 100), q: quad("q", 20, 1) },
      { g1: rect("g1", 0, 30, 0, 100), q: quad("q", 20, 1) },
      { g1: rect("g1", 0, 30, 0, 100), q: quad("q", 40, 1) },
      { g1: rect("g1", 0, 30, 0, 100) },
    ];

    for (const gates of steps) {
      const memoized = computeGateMasks(gates, d, memo);
      const plain = computeGateMasks(gates, d);
      expect(Object.keys(memoized).sort()).toEqual(Object.keys(plain).sort());
      for (const key of Object.keys(plain)) {
        expect(Array.from(memoized[key])).toEqual(Array.from(plain[key]));
      }
    }
  });
});

// Children are walked over their parent's member indices rather than the whole file, which is
// only sound while a population stays a strict subset of its parent. These pin that invariant and
// the edge cases the earlier mask-at-a-time form defined: a reference to a missing gate is
// skipped, so "and" over none is the parent and "or" over none is empty.
describe("applyGatingStrategy — parent-scoped membership", () => {
  const countOnes = (mask: Uint8Array) => mask.reduce((total, bit) => total + bit, 0);

  it("keeps a grandchild inside its parent, and its parent inside the root", () => {
    const data = assay({ x: [5, 25, 50, 5, 60], y: [1, 1, 1, 1, 1] }, 5);
    const gates: Record<string, Gate> = {
      outer: rect("outer", 0, 55, 0, 100), // drops x = 60
      inner: rect("inner", 0, 10, 0, 100), // of those, keeps x = 5
    };
    const pops: PopulationMap = {
      root: pop("root", "All", null, ["mid"]),
      mid: pop("mid", "Outer", "root", ["leaf"], [{ gate_id: "outer", include: true }]),
      leaf: pop("leaf", "Inner", "mid", [], [{ gate_id: "inner", include: true }]),
    };

    const { masks, populations } = applyGatingStrategy(gates, pops, "root", data);

    expect(Array.from(masks.mid)).toEqual([1, 1, 1, 1, 0]);
    expect(Array.from(masks.leaf)).toEqual([1, 0, 0, 1, 0]);
    // No event may appear in a child without appearing in its parent.
    for (let i = 0; i < 5; i++) {
      if (masks.leaf[i]) expect(masks.mid[i]).toBe(1);
      if (masks.mid[i]) expect(masks.root[i]).toBe(1);
    }
    expect(populations.leaf.event_count).toBe(2);
    expect(populations.leaf.percent_of_parent).toBe(50);
  });

  it("reports a count that matches its own mask at every depth", () => {
    const data = assay({ x: [5, 25, 50, 5, 60], y: [1, 1, 1, 1, 1] }, 5);
    const gates: Record<string, Gate> = { outer: rect("outer", 0, 55, 0, 100) };
    const pops: PopulationMap = {
      root: pop("root", "All", null, ["mid"]),
      mid: pop("mid", "Outer", "root", [], [{ gate_id: "outer", include: true }]),
    };

    const { masks, populations } = applyGatingStrategy(gates, pops, "root", data);

    for (const id of Object.keys(populations)) {
      expect(populations[id].event_count).toBe(countOnes(masks[id]));
    }
  });

  it("excludes with include:false, within the parent only", () => {
    const data = assay({ x: [5, 25, 50, 5], y: [1, 1, 1, 1] }, 4);
    const gates: Record<string, Gate> = {
      outer: rect("outer", 0, 30, 0, 100), // keeps 5, 25, 5
      drop: rect("drop", 0, 10, 0, 100),   // of those, removes the two x = 5
    };
    const pops: PopulationMap = {
      root: pop("root", "All", null, ["mid"]),
      mid: pop("mid", "Outer", "root", ["leaf"], [{ gate_id: "outer", include: true }]),
      leaf: pop("leaf", "Not small", "mid", [], [{ gate_id: "drop", include: false }]),
    };

    const { masks } = applyGatingStrategy(gates, pops, "root", data);

    // x = 50 is outside the parent, so excluding "drop" must not readmit it.
    expect(Array.from(masks.leaf)).toEqual([0, 1, 0, 0]);
  });

  it("treats an 'and' over a missing gate as the parent, and an 'or' as empty", () => {
    const data = assay({ x: [5, 25], y: [1, 1] }, 2);
    const pops: PopulationMap = {
      root: pop("root", "All", null, ["andPop", "orPop"]),
      andPop: pop("andPop", "And", "root", [], [{ gate_id: "gone", include: true }], "and"),
      orPop: pop("orPop", "Or", "root", [], [{ gate_id: "gone", include: true }], "or"),
    };

    const { masks } = applyGatingStrategy({}, pops, "root", data);

    expect(Array.from(masks.andPop)).toEqual([1, 1]);
    expect(Array.from(masks.orPop)).toEqual([0, 0]);
  });
});
