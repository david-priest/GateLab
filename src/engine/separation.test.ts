import { describe, expect, it } from "vitest";
import { aucOf, rankSeparatingPairs, type SeparationColumn } from "./separation";

/** A deterministic pseudo-normal draw. */
function noise(seed: number): () => number {
  let a = seed >>> 0 || 1;
  const uniform = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => { let s = 0; for (let i = 0; i < 12; i++) s += uniform(); return s - 6; };
}

describe("aucOf", () => {
  it("is 1 for separated scores, 0.5 for identical ones, and symmetric in direction", () => {
    expect(aucOf(Float64Array.from([1, 2, 3]), Float64Array.from([4, 5, 6]))).toBe(1);
    expect(aucOf(Float64Array.from([4, 5, 6]), Float64Array.from([1, 2, 3]))).toBe(1);
    expect(aucOf(Float64Array.from([1, 1, 1]), Float64Array.from([1, 1, 1]))).toBe(0.5);
    expect(aucOf(Float64Array.from([1, 2, 3, 4]), Float64Array.from([2, 3, 4, 5]))).toBeCloseTo(0.71875, 4);
    expect(aucOf(new Float64Array(0), Float64Array.from([1]))).toBe(0.5);
  });
});

describe("rankSeparatingPairs", () => {
  const n = 1200;
  const inA = new Uint8Array(n);
  const inB = new Uint8Array(n);
  for (let e = 0; e < n; e++) (e % 2 === 0 ? inA : inB)[e] = 1;
  const draw = noise(11);
  const cls = (e: number) => (inA[e] ? 1 : 0);
  // ch0 separates well on its own; ch1 is noise; ch2 and ch3 separate only together (the difference
  // of two correlated channels); ch4 is a feature that separates perfectly.
  const shared = Float32Array.from({ length: n }, () => draw() * 3);
  const columns: SeparationColumn[] = [
    { label: "FSC-A", kind: "detector", index: 0, values: Float32Array.from({ length: n }, (_, e) => cls(e) * 2.5 + draw()) },
    { label: "SSC-A", kind: "detector", index: 1, values: Float32Array.from({ length: n }, () => draw()) },
    { label: "V1-A", kind: "detector", index: 2, values: Float32Array.from({ length: n }, (_, e) => shared[e] + draw() * 0.3) },
    { label: "V2-A", kind: "detector", index: 3, values: Float32Array.from({ length: n }, (_, e) => shared[e] + cls(e) * 2 + draw() * 0.3) },
    { label: "Size (SSC (Imaging))", kind: "feature", index: 4, values: Float32Array.from({ length: n }, (_, e) => cls(e) * 10 + draw() * 0.1) },
  ];

  it("ranks the pair that separates the classes first, and scores each axis alone", () => {
    const ranked = rankSeparatingPairs(columns, inA, inB, { top: 3 });
    expect(ranked).toHaveLength(3);
    expect(ranked[0].auc).toBeGreaterThan(0.99);
    expect([ranked[0].i, ranked[0].j]).toContain(4);
    const together = ranked.find((p) => (p.i === 2 && p.j === 3));
    const all = rankSeparatingPairs(columns, inA, inB, { top: 100 });
    const pair23 = all.find((p) => p.i === 2 && p.j === 3)!;
    expect(pair23.auc).toBeGreaterThan(0.99);
    expect(pair23.aucI).toBeLessThan(0.6);
    expect(pair23.aucJ).toBeLessThan(0.75);
    expect(together ?? pair23).toBeTruthy();
    const noisePair = all.find((p) => p.i === 1 && p.j === 2)!;
    expect(noisePair.auc).toBeLessThan(0.6);
  });

  it("can restrict itself to detectors, the channels a sorter gates on", () => {
    const ranked = rankSeparatingPairs(columns, inA, inB, { detectorsOnly: true, top: 2 });
    expect(ranked.every((p) => p.i !== 4 && p.j !== 4)).toBe(true);
    expect(ranked[0].auc).toBeGreaterThan(0.99);
  });

  it("returns nothing for a class with fewer than two events, or fewer than two channels", () => {
    const lonely = new Uint8Array(n);
    lonely[0] = 1;
    expect(rankSeparatingPairs(columns, inA, lonely)).toEqual([]);
    expect(rankSeparatingPairs(columns.slice(0, 1), inA, inB)).toEqual([]);
  });

  it("thins each class evenly to the cap and still finds the pair", () => {
    const ranked = rankSeparatingPairs(columns, inA, inB, { maxEvents: 100, top: 1 });
    expect(ranked[0].auc).toBeGreaterThan(0.98);
  });
});
