// @vitest-environment jsdom
// A transform restated on scale values for a channel with a gain is declared by its own
// definition. Its id rounds the gain to four decimals, so two channels sharing one transform with
// gains of 2.00001 and 2.00004 once shared the first channel's declaration.
import { describe, it, expect } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";
import { exportGatingML } from "./gatingmlExport";
import { linkChildToParent, newGateRef, newPopulation, newRootPopulation, type Gate, type PopulationMap } from "./models";

const G1 = 2.00001, G2 = 2.00004;
function sample(): Sample {
  const n = 200000;
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: n, instrument: "flow", keywords: { $P1G: String(G1), $P2G: String(G2) }, spillover: null,
    channels: [
      { index: 0, name: "FL1-A", marker: null, bits: 32, range: 262144, gain: G1 },
      { index: 1, name: "FL2-A", marker: null, bits: 32, range: 262144, gain: G2 },
    ] as FcsFile["channels"],
    columns: [Float32Array.from({ length: n }, (_, i) => i), Float32Array.from({ length: n }, (_, i) => i)],
  };
  return new Sample(fcs);
}

describe("transform ids restated on scale values", () => {
  it("declares each channel's own T / gain", () => {
    const s = sample();
    const asinh = { kind: "asinh", cofactor: 150 } as const;
    const gate = {
      gate_id: "g", name: "CD4_positive", gate_type: "rectangle", x_channel: "FL1-A", y_channel: "FL2-A",
      vertices: [[2, 2], [8, 2], [8, 8], [2, 8]], space: "display", transforms: { "FL1-A": asinh, "FL2-A": asinh },
      bounds: "half-open", color: "#000", label_offset: null,
    } as unknown as Gate;
    const root = newRootPopulation();
    let pops: PopulationMap = { [root.population_id]: root };
    const p = newPopulation("CD4_positive", [newGateRef("g", true)], root.population_id);
    pops[p.population_id] = p;
    pops = linkChildToParent(pops, p.population_id, root.population_id);
    const xml = exportGatingML({ gates: { g: gate }, gate_order: ["g"], populations: pops, root_population_id: root.population_id, sample: s, format: "standard", timestamp: "t" });
    const trs = [...xml.matchAll(/<transforms:transformation transforms:id="([^"]+)"[^>]*>\s*<transforms:fasinh transforms:T="([^"]+)"/g)].map((m) => [m[1], Number(m[2])] as const);
    const refs = [...xml.matchAll(/gating:transformation-ref="([^"]+)"[^>]*>\s*<data-type:fcs-dimension data-type:name="([^"]+)"/g)].map((m) => [m[2], m[1]]);
    const tOf = (dim: string) => trs.find(([id]) => id === refs.find(([d]) => d === dim)![1])![1];
    // Independent expectation: on scale values x / g the same fasinh needs T = 150·sinh(1) / g.
    const expectT = (g: number) => (150 * Math.sinh(1)) / g;
    expect(tOf("FL1-A")).toBeCloseTo(expectT(G1), 9);
    expect(tOf("FL2-A")).toBeCloseTo(expectT(G2), 9);
  });
});
