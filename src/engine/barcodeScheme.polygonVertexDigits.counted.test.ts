// A raw-space polygon saved with "Save hierarchy CSV" and imported again has the same vertices,
// so float32 events lying next to its edges stay on the side they were on.
import { describe, expect, it } from "vitest";
import { buildBarcodeGating, exportHierarchyCsv, parseBarcodeTable, resolveBarcodeScheme } from "./barcodeScheme";
import { DEFAULT_BARCODE_TEMPLATE } from "./barcodeTemplate";
import { getGateMask } from "./gates";
import type { PolyRectGate, PopulationMap } from "./models";

const CHANNELS = [{ key: "FL1-A", pnn: "FL1-A", marker: null }, { key: "FL2-A", pnn: "FL2-A", marker: null }];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function readBack(g: PolyRectGate): PolyRectGate {
  const populations: PopulationMap = {
    root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: ["a"], event_count: null, percent_of_parent: null },
    a: { population_id: "a", name: "CD4_positive", gate_refs: [{ gate_id: g.gate_id, include: true }], gate_logic: "and", parent_id: "root", children: [], event_count: null, percent_of_parent: null },
  };
  const csv = exportHierarchyCsv([g], populations, "root", "test", { cofactor: 5 }).csv;
  const scheme = resolveBarcodeScheme(parseBarcodeTable(csv), CHANNELS);
  expect(scheme.problems).toEqual([]);
  const built = buildBarcodeGating(scheme, DEFAULT_BARCODE_TEMPLATE, 5, { qc: true, channels: CHANNELS, reuse: false });
  return Object.values(built.gates)[0] as PolyRectGate;
}

describe("hierarchy CSV polygon vertices", () => {
  it("2,000 seeded raw-space triangles keep their vertices and every float32 event near an edge", () => {
    const rand = mulberry32(31);
    let changedVertices = 0;
    let flipped = 0;
    let events = 0;
    for (let i = 0; i < 2000; i++) {
      const v = Array.from({ length: 3 }, () => [rand() * 200000 - 1000, rand() * 200000 - 1000] as [number, number]);
      const g: PolyRectGate = { gate_id: "g1", name: "CD4_positive", gate_type: "polygon", x_channel: "FL1-A", y_channel: "FL2-A", space: "raw", vertices: v, color: "#000000", label_offset: null };
      const xs: number[] = [];
      const ys: number[] = [];
      for (let k = 0; k < 3; k++) {
        const [a, b] = [v[k], v[(k + 1) % 3]];
        for (let t = 0; t < 20; t++) {
          const s = rand();
          xs.push(Math.fround(a[0] + (b[0] - a[0]) * s));
          ys.push(Math.fround(a[1] + (b[1] - a[1]) * s));
        }
      }
      const fx = Float32Array.from(xs);
      const fy = Float32Array.from(ys);
      const data = { n: fx.length, column: (ch: string) => (ch === "FL1-A" ? fx : ch === "FL2-A" ? fy : undefined) };
      const back = readBack(g);
      if (JSON.stringify(back.vertices) !== JSON.stringify(v)) changedVertices++;
      const before = getGateMask(g, data);
      const after = getGateMask(back, data);
      for (let j = 0; j < fx.length; j++) if (before[j] !== after[j]) flipped++;
      events += fx.length;
    }
    expect(events).toBe(120000);
    expect(flipped).toBe(0);
    expect(changedVertices).toBe(0);
  });
});
