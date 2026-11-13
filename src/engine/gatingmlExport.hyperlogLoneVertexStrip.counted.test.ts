// @vitest-environment jsdom
// A polygon on a Hyperlog axis with a lone vertex on the other axis's clamp keeps, on re-import, the
// events GateLab holds beyond the clamp at that vertex: Hyperlog values are compared in double.
import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample, transformFromSpec } from "./sample";
import { exportGatingML } from "./gatingmlExport";
import { importGatingML, gatingMLImportOptionsFor } from "./gatingml";
import { gatingMlGains } from "./gatingmlGain";
import { applyGatingStrategy } from "./populations";
import { linkChildToParent, newGateRef, newPopulation, newRootPopulation, type Gate, type PopulationMap, type TransformSpec } from "./models";

const HYPERLOG: TransformSpec = { kind: "hyperlog", T: 262144, W: 0.5, M: 4.5, A: 0 };
const OTHER: Record<"wsplog" | "biex", TransformSpec> = {
  wsplog: { kind: "wsplog", offset: 1, decades: 4.5 },
  biex: { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -100, channelRange: 256, tableChannels: 4096 } as TransformSpec,
};

function sampleOf(x: number[], y: number[]): Sample {
  return new Sample({
    version: "FCS3.1", nEvents: x.length, instrument: "flow", keywords: {}, spillover: null,
    channels: [
      { index: 0, name: "FL1-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL2-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from(x), Float32Array.from(y)],
  } as unknown as FcsFile);
}

/** Membership of CD4_positive as GateLab holds it, and as GateLab reads the exported file back. */
function roundTrip(s: Sample, gate: Gate): { own: number[]; back: number[] } {
  const root = newRootPopulation();
  let pops: PopulationMap = { [root.population_id]: root };
  const p = newPopulation("CD4_positive", [newGateRef(gate.gate_id, true)], root.population_id);
  pops[p.population_id] = p;
  pops = linkChildToParent(pops, p.population_id, root.population_id);
  const ws = { gates: { [gate.gate_id]: gate }, gate_order: [gate.gate_id], populations: pops, root_population_id: root.population_id };
  const xml = exportGatingML({ ...ws, sample: s, format: "standard", timestamp: "t" });
  const own = applyGatingStrategy(ws.gates, ws.populations, ws.root_population_id, s.gateAssayData()).masks[p.population_id];
  const res = importGatingML(xml, s.channels.map((c) => c.key), Object.fromEntries(s.channels.map((c) => [c.pnn, c.key])), "flow",
    { ...gatingMLImportOptionsFor(s), gains: gatingMlGains(s) });
  const q = Object.values(res.populations).find((z) => z.name === "CD4_positive")!;
  const back = applyGatingStrategy(res.gates, res.populations, res.root_population_id, s.gateAssayData()).masks[q.population_id];
  return { own: Array.from(own), back: Array.from(back) };
}

describe("Hyperlog polygon with a lone vertex on the other axis's clamp", () => {
  for (const ky of ["wsplog", "biex"] as const) {
    it(`keeps the events beyond the ${ky} clamp at the vertex`, () => {
      const hx = transformFromSpec(HYPERLOG).forward;
      const top = ky === "biex" ? 256 : 1;
      // Two events at the vertex's own FL1-A value, beyond the FL2-A clamp, which GateLab holds.
      const below = ky === "wsplog" ? [0, -3] : [-1e6, -2e6];
      const s = sampleOf([18999, 18999, 5000], [...below, 5000]);
      const gate = {
        gate_id: "g", name: "CD4_positive", gate_type: "polygon", x_channel: "FL1-A", y_channel: "FL2-A",
        vertices: [[hx(18999), 0], [hx(1000), 0.8 * top], [hx(30000), 0.6 * top]],
        space: "display", transforms: { "FL1-A": HYPERLOG, "FL2-A": OTHER[ky] }, color: "#000", label_offset: null,
      } as unknown as Gate;
      const t = roundTrip(s, gate);
      expect(t.own.slice(0, 2)).toEqual([1, 1]);
      expect(t.back).toEqual(t.own);
    });
  }
});
