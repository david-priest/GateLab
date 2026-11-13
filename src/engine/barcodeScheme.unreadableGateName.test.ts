// "Save hierarchy CSV" does not write a gate whose name the file would read back as another gate
// or as two gates ("not CD3", "CD4, CD8"); it names the gate in the notes instead.
import { describe, expect, it } from "vitest";
import { buildBarcodeGating, exportHierarchyCsv, parseBarcodeTable, resolveBarcodeScheme } from "./barcodeScheme";
import { DEFAULT_BARCODE_TEMPLATE } from "./barcodeTemplate";
import type { Gate, PolyRectGate, PopulationMap } from "./models";

const CHANNELS = [{ key: "FL1-A", pnn: "FL1-A", marker: null }, { key: "FL2-A", pnn: "FL2-A", marker: null }];

function poly(id: string, name: string, at: number): PolyRectGate {
  return { gate_id: id, name, gate_type: "polygon", x_channel: "FL1-A", y_channel: "FL2-A", space: "raw", vertices: [[at, at], [at + 10, at], [at + 10, at + 10]], color: "#000000", label_offset: null };
}

function tree(pops: { id: string; name: string; gateId: string }[]): PopulationMap {
  const map: PopulationMap = {
    root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: [], event_count: null, percent_of_parent: null },
  };
  for (const p of pops) {
    map[p.id] = { population_id: p.id, name: p.name, gate_refs: [{ gate_id: p.gateId, include: true }], gate_logic: "and", parent_id: "root", children: [], event_count: null, percent_of_parent: null };
    map.root.children.push(p.id);
  }
  return map;
}

function readBack(gates: Gate[], populations: PopulationMap) {
  const out = exportHierarchyCsv(gates, populations, "root", "test", { cofactor: 5 });
  const scheme = resolveBarcodeScheme(parseBarcodeTable(out.csv), CHANNELS);
  expect(scheme.problems).toEqual([]);
  const built = buildBarcodeGating(scheme, DEFAULT_BARCODE_TEMPLATE, 5, { qc: true, channels: CHANNELS, reuse: false });
  const refs = Object.fromEntries(Object.values(built.populations).filter((p) => p.parent_id).map((p) =>
    [p.name, p.gate_refs.map((r) => `${r.include ? "" : "NOT "}${built.gates[r.gate_id].name}`)]));
  return { notes: out.notes, refs };
}

describe("hierarchy CSV and gate names the file cannot hold", () => {
  it("does not write a gate named 'not CD3' as an excluded CD3", () => {
    const { notes, refs } = readBack(
      [poly("g1", "CD3", 0), poly("g2", "not CD3", 20)],
      tree([{ id: "a", name: "T cells", gateId: "g1" }, { id: "b", name: "Other cells", gateId: "g2" }]),
    );
    expect(refs).toEqual({ "T cells": ["CD3"] });
    expect(notes.some((n) => n.startsWith('"not CD3": ') && n.includes("excluded gate"))).toBe(true);
  });

  it("does not write a gate named 'CD4, CD8' as two gates", () => {
    const { notes, refs } = readBack(
      [poly("g1", "CD4", 0), poly("g2", "CD8", 20), poly("g3", "CD4, CD8", 40)],
      tree([{ id: "a", name: "CD4_positive", gateId: "g1" }, { id: "b", name: "CD8_positive", gateId: "g2" }, { id: "c", name: "Double", gateId: "g3" }]),
    );
    expect(refs).toEqual({ CD4_positive: ["CD4"], CD8_positive: ["CD8"] });
    expect(notes.some((n) => n.startsWith('"CD4, CD8": ') && n.includes("two gates"))).toBe(true);
  });
});
