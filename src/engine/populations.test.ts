import { describe, it, expect } from "vitest";
import {
  applyGatingStrategy,
  computeGateCounts,
  computeGateMasks,
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
  // Root → Aaa → A1 (leaf); Root → Bbb (leaf). Children sort by name (Aaa before Bbb).
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
