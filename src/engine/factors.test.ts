import { describe, it, expect } from "vitest";
import { resolvePartitionLevels, partitionCountsFor, partitionAssign, resolvePerSampleValue, NA_VALUE } from "./factors";
import { encodeUint8Base64 } from "./encode";
import type { PopulationMap, Population } from "./models";

const pop = (id: string, name: string, parent: string | null, children: string[]): Population => ({
  population_id: id, name, gate_refs: [], gate_logic: "and", parent_id: parent, children, event_count: null, percent_of_parent: null,
});
const POPS: PopulationMap = {
  root: pop("root", "All", null, ["A", "C"]),
  A: pop("A", "A", "root", ["B"]),
  B: pop("B", "B", "A", []),
  C: pop("C", "C", "root", []),
};

describe("resolvePartitionLevels", () => {
  it("returns selected pops in tree order, excluding root", () => {
    const lv = resolvePartitionLevels(POPS, "root", ["C", "A", "B", "root"]);
    expect(lv.map((l) => l.name)).toEqual(["A", "B", "C"]); // tree order: A(1), B(2), C(1)
    expect(lv.map((l) => l.depth)).toEqual([1, 2, 1]);
  });
});

describe("partitionCountsFor — deepest-membership", () => {
  it("assigns each event to the deepest selected population, else ungated", () => {
    const masks = {
      A: Uint8Array.from([1, 1, 1, 0, 0]),
      B: Uint8Array.from([1, 1, 0, 0, 0]), // ⊂ A
      C: Uint8Array.from([0, 0, 0, 1, 0]),
    };
    const levels = resolvePartitionLevels(POPS, "root", ["A", "B", "C"]); // [A,B,C]
    const { counts, ungated } = partitionCountsFor(masks, levels, 5);
    // e0,e1 → B (deepest); e2 → A; e3 → C; e4 → ungated
    expect(counts).toEqual([1, 2, 1]); // A,B,C
    expect(ungated).toBe(1);
  });
});

describe("partitionAssign — per-event colour overlay indices", () => {
  it("assigns each event the deepest selected population index, -1 for ungated", () => {
    const masks = {
      A: Uint8Array.from([1, 1, 1, 0, 0]),
      B: Uint8Array.from([1, 1, 0, 0, 0]),
      C: Uint8Array.from([0, 0, 0, 1, 0]),
    };
    const levels = resolvePartitionLevels(POPS, "root", ["A", "B", "C"]); // [A(0),B(1),C(2)]
    expect(Array.from(partitionAssign(masks, levels, 5))).toEqual([1, 1, 0, 2, -1]);
  });
});

describe("encodeUint8Base64", () => {
  it("round-trips through atob into the same bytes (matches cytof decode)", () => {
    const bytes = Uint8Array.from([0, 1, 2, 255, 128, 7]);
    const b64 = encodeUint8Base64(bytes);
    const bin = atob(b64);
    const back = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) back[i] = bin.charCodeAt(i);
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });
});

describe("resolvePerSampleValue", () => {
  it("sample kind → the sample name; metadata kind → the field (NA when empty/missing)", () => {
    expect(resolvePerSampleValue({ kind: "sample" }, "run1.fcs", {})).toBe("run1.fcs");
    expect(resolvePerSampleValue({ kind: "metadata", field: "cond" }, "run1.fcs", { cond: "stim" })).toBe("stim");
    expect(resolvePerSampleValue({ kind: "metadata", field: "cond" }, "run1.fcs", {})).toBe(NA_VALUE);
    expect(resolvePerSampleValue({ kind: "metadata", field: "cond" }, "run1.fcs", undefined)).toBe(NA_VALUE);
  });
});
