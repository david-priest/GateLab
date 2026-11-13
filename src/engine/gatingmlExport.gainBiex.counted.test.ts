// @vitest-environment jsdom
// An ellipse on a FlowJo biex x axis (FL1-A, $PnG 0.5) by a Gating-ML flog y axis, written by the
// standard format as its traced boundary in scale values. With the skirt's edge at the biex lower
// clamp found on stored values, 1 of the gate's 870 events came back on the other side; the same
// gate with no gain round-trips. Synthetic data from a fixed seed.
import { describe, it, expect } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";
import { exportGatingML } from "./gatingmlExport";
import { importGatingML, gatingMLImportOptionsFor } from "./gatingml";
import { gatingMlGains } from "./gatingmlGain";
import { applyGatingStrategy } from "./populations";
import { linkChildToParent, newGateRef, newPopulation, newRootPopulation, type Gate, type PopulationMap } from "./models";

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function makeSample(seed: number, gains: boolean): Sample {
  const r = rng(seed);
  const n = 3000;
  const col = (f: () => number) => Float32Array.from({ length: n }, f);
  const normal = () => { const u = Math.max(1e-12, r()); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: n, instrument: "flow",
    keywords: { $TIMESTEP: "0.01", ...(gains ? { $P1G: "2", $P3G: "0.5" } : {}) },
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144, ...(gains ? { gain: 2 } : {}) },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      { index: 2, name: "FL1-A", marker: null, bits: 32, range: 262144, ...(gains ? { gain: 0.5 } : {}) },
      { index: 3, name: "FL2-A", marker: null, bits: 32, range: 262144 },
      { index: 4, name: "Time", marker: null, bits: 32, range: 262144 },
    ] as FcsFile["channels"],
    columns: [
      col(() => Math.round(50000 + 30000 * normal())),
      col(() => Math.round(30000 + 20000 * normal())),
      col(() => Math.round(r() < 0.5 ? 200 * normal() : 5000 * Math.exp(normal()))),
      col(() => Math.round(r() < 0.5 ? 300 * normal() : 8000 * Math.exp(normal()))),
      Float32Array.from({ length: n }, (_, i) => i * 10),
    ],
  };
  return new Sample(fcs);
}

describe("biex x flog ellipse across a gain", () => {
  for (const gains of [false, true]) {
    it(`gains=${gains}`, () => {
      const sample = makeSample(68, gains);
      const gate = {
        gate_id: "g4", name: "CD4_positive", x_channel: "FL1-A", y_channel: "SSC-A", color: "#000", label_offset: null,
        space: "display", transforms: {
          "FL1-A": { kind: "biex", maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -10, channelRange: 4096 },
          "SSC-A": { kind: "flog", T: 262144, M: 4.5, standard: true },
        },
        gate_type: "ellipse", mean: [3195.510605107744, 0.8401013642825716],
        covariance: [[10211294.418378273, 50.62788944331603], [50.62788944331603, 0.001395238330057922]], distance_square: 1,
      } as unknown as Gate;
      const root = newRootPopulation();
      let pops: PopulationMap = { [root.population_id]: root };
      const p = newPopulation("CD4_positive", [newGateRef("g4", true)], root.population_id);
      pops[p.population_id] = p;
      pops = linkChildToParent(pops, p.population_id, root.population_id);
      const ws = { gates: { g4: gate }, gate_order: ["g4"], populations: pops, root_population_id: root.population_id };
      const xml = exportGatingML({ ...ws, sample, format: "standard", timestamp: "t" });
      const back = importGatingML(xml, sample.channels.map((c) => c.key), Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key])), "flow",
        { ...gatingMLImportOptionsFor(sample), gains: gatingMlGains(sample) });
      const a = applyGatingStrategy(ws.gates, ws.populations, ws.root_population_id, sample.gateAssayData()).masks[p.population_id];
      const q = Object.values(back.populations).find((z) => z.name === "CD4_positive")!;
      const b = applyGatingStrategy(back.gates, back.populations, back.root_population_id, sample.gateAssayData()).masks[q.population_id];
      const diff: string[] = [];
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(`#${i} FL1-A=${sample.rawColumnData(2)[i]} SSC-A=${sample.rawColumnData(1)[i]} GateLab=${a[i]} reimport=${b[i]}`);
      expect(a.reduce((s, v) => s + v, 0)).toBeGreaterThan(100);
      expect(diff).toEqual([]);
    });
  }
});
