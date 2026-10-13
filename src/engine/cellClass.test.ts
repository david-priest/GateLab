import { describe, expect, it } from "vitest";
import { CELL_CLASS, CELL_CLASS_LABELS, CELL_REASON, cellClassColumns, cellReasonLabels, classifyCells } from "./cellClass";
import type { FcsFile } from "./fcs";

/** A file of imaged events with the mask channel's features, plus a decoy copy of each on FSC. */
function fileOf(rows: { size: number; ecc: number; longAxis: number; delta: number; diff: number }[]): FcsFile {
  const n = rows.length;
  const column = (pick: (r: (typeof rows)[number]) => number) => Float32Array.from(rows.map(pick));
  const channel = (index: number, name: string, feature: string) => ({ index, name, marker: null, bits: 32, range: 1e6, feature });
  return {
    version: "FCS3.1", nEvents: n, instrument: "flow", keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      channel(1, "Size (FSC)", "MaskSize"),
      channel(2, "Size (SSC (Imaging))", "MaskSize"),
      channel(3, "Eccentricity (SSC (Imaging))", "Eccentricity"),
      channel(4, "Long Axis Moment (SSC (Imaging))", "RadialMomentLongestAxis"),
      channel(5, "Delta CoM (SSC (Imaging)/LightLoss (Imaging))", "Delta CoM"),
      channel(6, "Delta CoM (LightLoss (Imaging)/FSC)", "Delta CoM"),
      channel(7, "Diffusivity (SSC (Imaging))", "Diffusivity"),
    ],
    columns: [
      Float32Array.from(rows.map((_, i) => i)),
      column((r) => r.size * 7),
      column((r) => r.size),
      column((r) => r.ecc),
      column((r) => r.longAxis),
      column((r) => r.delta),
      column(() => 99),
      column((r) => r.diff),
    ],
    spillover: null,
  };
}

/** Forty typical single cells, lightly jittered, then the special cases. */
function rows() {
  const out: { size: number; ecc: number; longAxis: number; delta: number; diff: number }[] = [];
  for (let i = 0; i < 40; i++) {
    const j = ((i * 7919) % 11) / 10 - 0.5; // -0.5 … 0.5
    out.push({ size: 200 + 20 * j, ecc: 0.3 + 0.05 * j, longAxis: 50 + 5 * j, delta: 1 + 0.2 * j, diff: 2 + 0.2 * j });
  }
  return out;
}

describe("classifyCells", () => {
  it("finds the mask channel's copy of each feature, and every Delta CoM pair that involves it", () => {
    const fcs = fileOf(rows());
    expect(cellClassColumns(fcs).map((c) => [c.key, c.index])).toEqual([["size", 2], ["eccentricity", 3], ["longAxis", 4], ["diffusivity", 7], ["deltaCoM", 5]]);
    // Another mask channel takes its own copies, and falls back to what exists.
    expect(cellClassColumns(fcs, "FSC").map((c) => [c.key, c.index])).toEqual([["size", 1], ["eccentricity", 3], ["longAxis", 4], ["diffusivity", 7], ["deltaCoM", 6]]);
  });

  it("calls typical one-object events single, and names why the others are not", () => {
    const special = [
      { size: 200, ecc: 0.9, longAxis: 50, delta: 1, diff: 2 }, // 40: eccentric
      { size: 1200, ecc: 0.3, longAxis: 50, delta: 1, diff: 2 }, // 41: large
      { size: 30, ecc: 0.3, longAxis: 50, delta: 1, diff: 2 }, // 42: small
      { size: 200, ecc: 0.3, longAxis: 50, delta: 6, diff: 2 }, // 43: centres disagree
      { size: 200, ecc: 0.3, longAxis: 50, delta: 1, diff: 2 }, // 44: two objects
      { size: 0, ecc: 0, longAxis: 0, delta: 0, diff: 0 }, // 45: no object
      { size: 0, ecc: 0, longAxis: 0, delta: 0, diff: 0 }, // 46: no image
    ];
    const all = [...rows(), ...special];
    const fcs = fileOf(all);
    const objectCount = new Uint8Array(all.length).fill(1);
    objectCount[44] = 2;
    objectCount[45] = 0;
    objectCount[46] = 255;
    const imaged = new Uint8Array(all.length).fill(1);
    imaged[46] = 0;
    const result = classifyCells(fcs, objectCount, imaged);
    expect(Array.from(result.classes.slice(0, 40)).every((c) => c === CELL_CLASS.single)).toBe(true);
    expect(result.classes[40]).toBe(CELL_CLASS.irregular);
    expect(result.reasons[40]).toBe(CELL_REASON.eccentric);
    expect(result.reasons[41]).toBe(CELL_REASON.large);
    expect(result.reasons[42]).toBe(CELL_REASON.small);
    expect(result.reasons[43]).toBe(CELL_REASON.centresDisagree);
    expect(result.classes[44]).toBe(CELL_CLASS.multiple);
    expect(result.classes[45]).toBe(CELL_CLASS.noObject);
    expect(result.classes[46]).toBe(CELL_CLASS.noImage);
    expect(result.counts).toEqual([40, 4, 1, 1, 1]);
    expect(result.counts.reduce((a, b) => a + b, 0)).toBe(all.length);
    expect(result.features.map((f) => f.key)).toEqual(["size", "eccentricity", "longAxis", "diffusivity", "deltaCoM"]);
    expect(result.features.every((f) => f.scale > 0)).toBe(true);
    expect(cellReasonLabels(CELL_REASON.eccentric | CELL_REASON.large)).toEqual(["larger than usual", "eccentric"]);
    expect(CELL_CLASS_LABELS).toHaveLength(5);
  });

  it("is looser with a higher strictness, and takes every imaged event as one object without a count", () => {
    const all = [...rows(), { size: 200, ecc: 0.9, longAxis: 50, delta: 1, diff: 2 }];
    const fcs = fileOf(all);
    const strict = classifyCells(fcs, null, null, { strictness: 3 });
    expect(strict.classes[40]).toBe(CELL_CLASS.irregular);
    expect(strict.counts[CELL_CLASS.noImage]).toBe(0);
    const loose = classifyCells(fcs, null, null, { strictness: 40 });
    expect(loose.classes[40]).toBe(CELL_CLASS.single);
    expect(loose.strictness).toBe(40);
  });

  it("works without any feature column: one object is single, and nothing is irregular", () => {
    const fcs: FcsFile = {
      version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {},
      channels: [{ index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 }],
      columns: [Float32Array.from([1, 2, 3])], spillover: null,
    };
    const result = classifyCells(fcs, Uint8Array.from([1, 2, 255]), null);
    expect(Array.from(result.classes)).toEqual([CELL_CLASS.single, CELL_CLASS.multiple, CELL_CLASS.noImage]);
    expect(result.features).toEqual([]);
  });
});
