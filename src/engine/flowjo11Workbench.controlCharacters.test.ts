// @vitest-environment jsdom
// A FlowJo 11 workbench is read by rewriting it as a FlowJo 10 workspace document. A keyword value
// or a population name that holds a control character XML has no form for made that document
// unparsable; GateLab's own .flowjo of such a file could not be reopened.
import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { exportFlowJo11Workbench } from "./flowjo11Export";
import { flowJo11WorkbenchToWorkspace, readFlowJo11Workbench } from "./flowjo11Workbench";
import { listFlowJoWorkspaceSamples } from "./flowjoWorkspace";
import { newGate, newPopulation, type Gate, type PopulationMap } from "./models";
import { Sample } from "./sample";

function sample(keywords: Record<string, string>): Sample {
  const n = 500;
  return new Sample({
    version: "FCS3.1", nEvents: n, instrument: "flow", keywords, spillover: null,
    channels: ["FSC-A", "SSC-A", "FL1-A"].map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: [0, 1, 2].map((c) => Float32Array.from({ length: n }, (_, i) => ((i * 523 + c * 7919) % 2000) * 100)),
  } as FcsFile);
}

describe("a FlowJo 11 workbench with a control character", () => {
  it.each([
    ["a keyword value", { $CYT: "Synthetic cytometer", $COM: "lot 7\u0002B" }, "Cells"],
    ["a population name", { $CYT: "Synthetic cytometer" }, "Cells\u0007"],
  ])("in %s is read", (_, keywords, populationName) => {
    const s = sample(keywords as Record<string, string>);
    const [fsc, ssc] = s.channels.map((c) => c.key);
    const gate: Gate = { ...newGate("Cells", "rectangle", fsc, ssc, [[40000, 5000], [200000, 5000], [200000, 140000], [40000, 140000]]), bounds: "closed" };
    const root = newPopulation("All Events", [], null);
    const pop = newPopulation(populationName, [{ gate_id: gate.gate_id, include: true }], root.population_id);
    root.children.push(pop.population_id);
    const populations: PopulationMap = { [root.population_id]: root, [pop.population_id]: pop };
    const { bytes } = exportFlowJo11Workbench({
      samples: [{ sample: s, fileName: "S1.fcs", gates: { [gate.gate_id]: gate }, gate_order: [gate.gate_id], populations, root_population_id: root.population_id }],
      fcsFolder: "/data", name: "S1",
    });
    const xml = flowJo11WorkbenchToWorkspace(readFlowJo11Workbench(bytes));
    expect(new DOMParser().parseFromString(xml, "application/xml").getElementsByTagName("parsererror")).toHaveLength(0);
    expect(listFlowJoWorkspaceSamples(xml).map((entry) => entry.name)).toEqual(["S1.fcs"]);
  });
});
