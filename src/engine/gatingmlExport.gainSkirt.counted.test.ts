// @vitest-environment jsdom
// A polygon on a FlowJo log axis (offset 1) with an edge on the axis floor, on a channel with a
// $PnG other than 1, written by the standard format: in scale values (stored / $PnG) with a skirt
// below the floor. The skirt's inner edge was found on the stored values while the floor was in
// scale values, so at $PnG 5 it was written at five times the floor and 10 of 339 events above the
// floor were read into the gate.
//
// The written file is read here as Gating-ML 2.0 defines it, independently of GateLab's importer
// (each dimension's value is stored / $PnG, no transformation, even-odd point-in-polygon), and by
// GateLab's own importer.
import { describe, it, expect } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";
import { exportGatingML } from "./gatingmlExport";
import { importGatingML, gatingMLImportOptionsFor } from "./gatingml";
import { gatingMlGains } from "./gatingmlGain";
import { applyGatingStrategy } from "./populations";
import { linkChildToParent, newGateRef, newPopulation, newRootPopulation, type Gate, type PopulationMap } from "./models";

function sample(gain: number): Sample {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = 0; x <= 10000; x += 250) {
    for (const y of [-5, 0, 0.5, 1, 1.5, 2, 3, 4, 4.9, 6, 10, 100, 1000]) { xs.push(x); ys.push(y); }
  }
  const n = xs.length;
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: n, instrument: "flow", keywords: gain !== 1 ? { $P2G: String(gain) } : {}, spillover: null,
    channels: [
      { index: 0, name: "FL2-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL1-A", marker: null, bits: 32, range: 262144, ...(gain !== 1 ? { gain } : {}) },
    ] as FcsFile["channels"],
    columns: [Float32Array.from(xs), Float32Array.from(ys)],
  };
  return new Sample(fcs);
}

function evenOdd(px: number, py: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

describe("skirt below a log floor on a channel with a gain", () => {
  for (const gain of [1, 5, 0.5]) {
    it(`$PnG ${gain}`, () => {
      const s = sample(gain);
      const gate = {
        gate_id: "g", name: "CD4_positive", gate_type: "polygon", x_channel: "FL2-A", y_channel: "FL1-A",
        // x raw (identity), y on FlowJo's log: a triangle with its base on the floor (y = 0).
        vertices: [[1000, 0], [9000, 0], [5000, 0.8]], space: "display",
        transforms: { "FL2-A": { kind: "identity" }, "FL1-A": { kind: "wsplog", offset: 1, decades: 4.5 } },
        color: "#000", label_offset: null,
      } as unknown as Gate;
      const root = newRootPopulation();
      let pops: PopulationMap = { [root.population_id]: root };
      const p = newPopulation("CD4_positive", [newGateRef("g", true)], root.population_id);
      pops[p.population_id] = p;
      pops = linkChildToParent(pops, p.population_id, root.population_id);
      const ws = { gates: { g: gate }, gate_order: ["g"], populations: pops, root_population_id: root.population_id };
      const xml = exportGatingML({ ...ws, sample: s, format: "standard", timestamp: "t" });
      expect(xml).not.toContain("transformation-ref");
      const vals = [...xml.split("<gating:vertex>").slice(1).join("").matchAll(/data-type:value="([^"]+)"/g)].map((m) => Number(m[1]));
      const ring: [number, number][] = [];
      for (let k = 0; k + 1 < vals.length; k += 2) ring.push([vals[k], vals[k + 1]]);
      const own = applyGatingStrategy(ws.gates, ws.populations, ws.root_population_id, s.gateAssayData()).masks[p.population_id];
      const back = importGatingML(xml, s.channels.map((c) => c.key), Object.fromEntries(s.channels.map((c) => [c.pnn, c.key])), "flow",
        { ...gatingMLImportOptionsFor(s), gains: gatingMlGains(s) });
      const q = Object.values(back.populations).find((z) => z.name === "CD4_positive")!;
      const re = applyGatingStrategy(back.gates, back.populations, back.root_population_id, s.gateAssayData()).masks[q.population_id];
      const X = s.rawColumnData(0), Y = s.rawColumnData(1);
      const wrongSpec: string[] = [];
      let wrongReimport = 0;
      for (let i = 0; i < own.length; i++) {
        const spec = evenOdd(X[i], Y[i] / gain, ring) ? 1 : 0;
        if (spec !== own[i]) wrongSpec.push(`(FL2-A ${X[i]}, FL1-A ${Y[i]}) GateLab ${own[i]} file ${spec}`);
        if (re[i] !== own[i]) wrongReimport++;
      }
      expect(wrongSpec.slice(0, 5)).toEqual([]);
      expect(wrongReimport).toBe(0);
    });
  }
});
