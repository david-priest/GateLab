// @vitest-environment jsdom
// A file on a compensation profile is gated on the profile's values. The FlowJo writers take the
// matrix from the file's own or an installed one, so neither can carry the profile's: written
// anyway, the gates were read on uncompensated values. Both refuse the export by name.
import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { exportFlowJoWorkspace } from "./flowjoExport";
import { exportFlowJo11Workbench } from "./flowjo11Export";
import { columnsForGate, getGateMask } from "./gates";
import { newGate, newPopulation, type Gate, type PopulationMap } from "./models";
import { Sample } from "./sample";

const fcs = (): FcsFile => ({
  version: "FCS3.1", nEvents: 4, instrument: "flow", keywords: {}, spillover: null,
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "FL1-A", marker: "CD3", bits: 32, range: 262144 },
    { index: 2, name: "FL2-A", marker: "CD19", bits: 32, range: 262144 },
  ],
  columns: [Float32Array.from([100, 200, 300, 400]), Float32Array.from([10, 20, 30, 40]), Float32Array.from([1, 2, 3, 4])],
} as unknown as FcsFile);
const digest = (c: string) => `sha256:${c.repeat(64)}`;

/** S1 on a profile whose compensated FL1-A is 9, 18, 27, 36 where the file stores 10, 20, 30, 40. */
function onProfile(): Sample {
  const sample = new Sample(fcs());
  sample.installCompensatedLayer({
    metadata: {
      profileId: "p", profileHash: digest("a"), matrixHash: digest("b"), kind: "flow-spillover", method: "matrix-inverse",
      includedPnns: ["FL1-A", "FL2-A"],
      channelBindings: [
        { pnn: "FL1-A", fcsColumnIndex: 1, matrixSourceIndex: 0, matrixReceiverIndex: 0, included: true },
        { pnn: "FL2-A", fcsColumnIndex: 2, matrixSourceIndex: 1, matrixReceiverIndex: 1, included: true },
      ],
      transformBinding: { kind: "flow-linear" },
    },
    columns: [
      { pnn: "FL1-A", fcsColumnIndex: 1, values: Float32Array.from([9, 18, 27, 36]) },
      { pnn: "FL2-A", fcsColumnIndex: 2, values: Float32Array.from([-1, -2, -3, -4]) },
    ],
  } as never);
  sample.setActiveLayer("compensated");
  return sample;
}

function tree(sample: Sample) {
  const [, fl1, fl2] = sample.channels.map((c) => c.key);
  // FL1-A from 19.5 to 30: the stored 20 is inside, and of the compensated values only 27 is.
  const gate: Gate = { ...newGate("CD3_positive", "rectangle", fl1, fl2, [[19.5, -10], [30, -10], [30, 10], [19.5, 10]]), space: "raw", bounds: "half-open" };
  const root = newPopulation("All Events", [], null);
  const pop = newPopulation("CD3_positive", [{ gate_id: gate.gate_id, include: true }], root.population_id);
  root.children.push(pop.population_id);
  const populations: PopulationMap = { [root.population_id]: root, [pop.population_id]: pop };
  return { gate, gates: { [gate.gate_id]: gate }, gate_order: [gate.gate_id], populations, root_population_id: root.population_id };
}

describe("a FlowJo export of a file on a compensation profile", () => {
  it("is refused by both writers, naming the file", () => {
    const sample = onProfile();
    expect(sample.compensationEnabled).toBe(true);
    const { gate, ...strategy } = tree(sample);
    // What GateLab counts, on the profile's values: the third event only.
    expect(Array.from(getGateMask(gate, columnsForGate(sample.gateAssayData(), gate)))).toEqual([0, 0, 1, 0]);
    expect(() => exportFlowJoWorkspace({ samples: [{ sample, fileName: "S1.fcs", ...strategy }], now: new Date(0) }))
      .toThrow(/FlowJo workspace cannot yet carry .* compensation profile, and S1\.fcs is compensated with one/);
    expect(() => exportFlowJo11Workbench({ samples: [{ sample, fileName: "S1.fcs", ...strategy }], fcsFolder: "/data", name: "S1" }))
      .toThrow(/FlowJo 11 workbench cannot yet carry .* compensation profile, and S1\.fcs is compensated with one/);
  });

  it("is written once the file is back on Original", () => {
    const sample = onProfile();
    sample.setActiveLayer("original");
    const { gate, ...strategy } = tree(sample);
    expect(Array.from(getGateMask(gate, columnsForGate(sample.gateAssayData(), gate)))).toEqual([0, 1, 0, 0]);
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample, fileName: "S1.fcs", ...strategy }], now: new Date(0) });
    expect(xml).toContain("CD3_positive");
    expect(xml).not.toContain("Comp-");
  });
});
