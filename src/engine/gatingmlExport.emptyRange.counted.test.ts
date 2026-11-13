// @vitest-environment jsdom
// A rectangle with one channel on both axes whose two intervals do not overlap holds no event.
// It is written as one dimension with min above max, which holds no value under the Gating-ML
// rule (min <= x < max), and it comes back holding none.
import { describe, it, expect } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";
import { exportGatingML } from "./gatingmlExport";
import { importGatingML, gatingMLImportOptionsFor } from "./gatingml";
import { applyGatingStrategy } from "./populations";
import { getGateMask, columnsForGate } from "./gates";
import { linkChildToParent, newGateRef, newPopulation, newRootPopulation, type Gate, type PopulationMap } from "./models";

function sample(): Sample {
  const n = 1000;
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: n, instrument: "flow", keywords: {}, spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL2-A", marker: null, bits: 32, range: 262144 },
    ] as FcsFile["channels"],
    columns: [Float32Array.from({ length: n }, (_, i) => i * 100), Float32Array.from({ length: n }, (_, i) => i * 30)],
  };
  return new Sample(fcs);
}

describe("range with disjoint x and y intervals", () => {
  for (const format of ["standard", "cytobank"] as const) {
    it(format, () => {
      const s = sample();
      const gate = {
        gate_id: "g1", name: "CD4_positive", gate_type: "rectangle", x_channel: "FL2-A", y_channel: "FL2-A",
        vertices: [[0, 6000], [3000, 6000], [3000, 24000], [0, 24000]], space: "raw", bounds: "half-open",
        color: "#000", label_offset: null,
      } as unknown as Gate;
      const root = newRootPopulation();
      let pops: PopulationMap = { [root.population_id]: root };
      const p = newPopulation("CD4_positive", [newGateRef("g1", true)], root.population_id);
      pops[p.population_id] = p;
      pops = linkChildToParent(pops, p.population_id, root.population_id);
      const ws = { gates: { g1: gate }, gate_order: ["g1"], populations: pops, root_population_id: root.population_id };
      const own = getGateMask(gate, columnsForGate(s.gateAssayData(), gate)).reduce((a, v) => a + v, 0);
      const xml = exportGatingML({ ...ws, sample: s, format, timestamp: "t" });
      const back = importGatingML(xml, s.channels.map((c) => c.key), Object.fromEntries(s.channels.map((c) => [c.pnn, c.key])), "flow", gatingMLImportOptionsFor(s));
      const m = applyGatingStrategy(back.gates, back.populations, back.root_population_id, s.gateAssayData()).masks;
      const q = Object.values(back.populations).find((z) => z.name === "CD4_positive")!;
      const reimported = m[q.population_id].reduce((a, v) => a + v, 0);
      // A Gating-ML 2.0 reader (min <= x < max) holds nothing either: 6000 <= x < 3000 is empty.
      expect(/gating:min="6000"[^>]*gating:max="2999\.9+\d*"/.test(xml)).toBe(true);
      expect(own).toBe(0);
      expect(reimported).toBe(own);
    });
  }
});
