// @vitest-environment jsdom
// XML 1.0 has no form for a C0 control character other than tab, line feed and carriage return,
// so a gate or population name that holds one is written without it, and the file parses.
import { describe, it, expect } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";
import { exportGatingML } from "./gatingmlExport";
import { importGatingML } from "./gatingml";
import { linkChildToParent, newGateRef, newPopulation, newRootPopulation, type Gate, type PopulationMap } from "./models";

function sample(): Sample {
  const n = 100;
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: n, instrument: "flow", keywords: {}, spillover: null,
    channels: [
      { index: 0, name: "FL1-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL2-A", marker: null, bits: 32, range: 262144 },
    ] as FcsFile["channels"],
    columns: [Float32Array.from({ length: n }, (_, i) => i), Float32Array.from({ length: n }, (_, i) => i)],
  };
  return new Sample(fcs);
}

describe("names with control characters", () => {
  for (const name of ["CD4\u000Bpositive", "CD4\u001Fpositive", "CD4 & <CD8> \"pos\" é"]) {
    for (const format of ["standard", "cytobank"] as const) {
      it(`${JSON.stringify(name)} ${format}`, () => {
        const s = sample();
        const gate = { gate_id: "g", name, gate_type: "rectangle", x_channel: "FL1-A", y_channel: "FL2-A",
          vertices: [[10, 10], [50, 10], [50, 50], [10, 50]], space: "raw", bounds: "half-open", color: "#000", label_offset: null } as unknown as Gate;
        const root = newRootPopulation();
        let pops: PopulationMap = { [root.population_id]: root };
        const p = newPopulation(name, [newGateRef("g", true)], root.population_id);
        pops[p.population_id] = p;
        pops = linkChildToParent(pops, p.population_id, root.population_id);
        const xml = exportGatingML({ gates: { g: gate }, gate_order: ["g"], populations: pops, root_population_id: root.population_id, sample: s, format, timestamp: "t" });
        const doc = new DOMParser().parseFromString(xml, "application/xml");
        expect(doc.getElementsByTagName("parsererror").length, "the written file is well-formed XML").toBe(0);
        const back = importGatingML(xml, s.channels.map((c) => c.key), Object.fromEntries(s.channels.map((c) => [c.pnn, c.key])), "flow");
        const written = name.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
        expect(Object.values(back.populations).some((q) => q.name === written)).toBe(true);
      });
    }
  }
});
