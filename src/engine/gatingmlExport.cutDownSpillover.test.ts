// @vitest-environment jsdom
// When the file's $SPILLOVER is cut down to the channels the sample keeps, the standard export
// writes that cut-down matrix and points compensated dimensions at it, never at "FCS".
import { describe, expect, it } from "vitest";
import { Sample } from "./sample";
import { exportGatingML } from "./gatingmlExport";
import { linkChildToParent, newGate, newGateRef, newPopulation, newRootPopulation, type PopulationMap, type Gate } from "./models";
import type { FcsFile } from "./fcs";

function workspace(gate: Gate) {
  const root = newRootPopulation();
  let populations: PopulationMap = { [root.population_id]: root };
  const p = newPopulation("P1", [newGateRef(gate.gate_id, true)], root.population_id, "and");
  populations[p.population_id] = p;
  populations = linkChildToParent(populations, p.population_id, root.population_id);
  return { gates: { [gate.gate_id]: gate }, gate_order: [gate.gate_id], populations, root_population_id: root.population_id };
}

function sampleWith(spillChannels: string[], matrix: number[][]): Sample {
  return new Sample({
    version: "FCS3.1", nEvents: 2, instrument: "flow", keywords: {},
    channels: [
      { index: 0, name: "FL3-A", marker: "FITC-A", bits: 32, range: 262144 },
      { index: 1, name: "FL4-A", marker: "PE-A", bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from([200, 300]), Float32Array.from([50, 60])],
    spillover: { channels: spillChannels, matrix },
  } as unknown as FcsFile);
}

function exportRect(sample: Sample): Document {
  sample.setCompensation(true);
  const [kx, ky] = sample.channels.map((c) => c.key);
  const gate = newGate("G", "rectangle", kx, ky, [[100, -1000], [1e5, -1000], [1e5, 1e5], [100, 1e5]]);
  const xml = exportGatingML({ ...workspace(gate), sample, format: "standard" });
  return new DOMParser().parseFromString(xml, "application/xml");
}

const refs = (doc: Document) =>
  [...doc.getElementsByTagName("gating:dimension")].map((d) => d.getAttribute("gating:compensation-ref"));

describe("standard Gating-ML export of a cut-down FCS spillover matrix", () => {
  it("writes the 2 x 2 block in use and references it from both dimensions", () => {
    // V1-A is named by the matrix but is not a channel of the sample, so it is dropped.
    const sample = sampleWith(["FL3-A", "FL4-A", "V1-A"], [[1, 0.05, 0], [0.02, 1, 0], [0.2, 0, 1]]);
    expect(sample.spilloverOrigin).toMatchObject({ kind: "fcs", droppedChannels: ["V1-A"] });
    const doc = exportRect(sample);
    expect(refs(doc)).toEqual(["Spill_1", "Spill_1"]);
    const spectra = [...doc.getElementsByTagName("transforms:spectrum")].map((s) =>
      [...s.getElementsByTagName("transforms:coefficient")].map((c) => Number(c.getAttribute("transforms:value"))));
    expect(spectra).toEqual([[1, 0.05], [0.02, 1]]);
  });

  it("still says FCS when the file's matrix is used in full", () => {
    const doc = exportRect(sampleWith(["FL3-A", "FL4-A"], [[1, 0.05], [0.02, 1]]));
    expect(refs(doc)).toEqual(["FCS", "FCS"]);
    expect(doc.getElementsByTagName("transforms:spectrumMatrix").length).toBe(0);
  });
});
