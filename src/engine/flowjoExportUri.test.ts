// @vitest-environment jsdom
//
// The DataSet uri the FlowJo export writes for each sample. Synthetic file names and events.

import { describe, expect, it } from "vitest";
import { Sample } from "./sample";
import { exportFlowJoWorkspace, flowJoWorkspaceBytesAtMost, type FlowJoExportSample } from "./flowjoExport";
import { linkChildToParent, newGate, newGateRef, newPopulation, newRootPopulation, type PopulationMap } from "./models";
import type { FcsFile } from "./fcs";

function syntheticSample(events = 50, keywords: Record<string, string> = {}): Sample {
  const fsc = Float32Array.from({ length: events }, (_, i) => 1000 + i * 1000);
  const ssc = Float32Array.from({ length: events }, (_, i) => 500 + i * 700);
  return new Sample({
    version: "FCS3.1", nEvents: fsc.length, instrument: "flow", keywords: { $CYT: "Synthetic cytometer", ...keywords },
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [fsc, ssc],
    spillover: null,
  } as unknown as FcsFile);
}

function entry(fileName: string, extra: Partial<FlowJoExportSample> = {}): FlowJoExportSample {
  const gate = newGate("Cells", "rectangle", "FSC-A", "SSC-A", [[10000, 1000], [40000, 1000], [40000, 30000], [10000, 30000]]);
  const root = newRootPopulation();
  let populations: PopulationMap = { [root.population_id]: root };
  const cells = newPopulation("Cells", [newGateRef(gate.gate_id, true)], root.population_id, "and");
  populations[cells.population_id] = cells;
  populations = linkChildToParent(populations, cells.population_id, root.population_id);
  return {
    sample: syntheticSample(), fileName,
    gates: { [gate.gate_id]: gate }, gate_order: [gate.gate_id], populations, root_population_id: root.population_id,
    ...extra,
  };
}

/** Each sample's DataSet uri and SampleNode name, read back with an XML parser. */
function dataSets(xml: string): { uri: string | null; name: string | null }[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  return [...doc.getElementsByTagName("Sample")].map((s) => ({
    uri: s.getElementsByTagName("DataSet")[0]?.getAttribute("uri") ?? null,
    name: s.getElementsByTagName("SampleNode")[0]?.getAttribute("name") ?? null,
  }));
}

describe("the DataSet uri of a plain export", () => {
  it("is the file's name after file:, through encodeURI, as before", () => {
    const { xml } = exportFlowJoWorkspace({ samples: [entry("D1 run.fcs"), entry("D2_ü.fcs")] });
    expect(dataSets(xml)).toEqual([
      { uri: "file:D1%20run.fcs", name: "D1 run.fcs" },
      { uri: "file:D2_%C3%BC.fcs", name: "D2_ü.fcs" },
    ]);
  });

  it("is escaped for XML, so a name with & leaves the file well formed", () => {
    // encodeURI keeps "&", which was written raw and made the whole workspace malformed.
    const { xml } = exportFlowJoWorkspace({ samples: [entry("D1 & D2.fcs")] });
    expect(xml).toContain('<DataSet uri="file:D1%20&amp;%20D2.fcs"');
    expect(dataSets(xml)).toEqual([{ uri: "file:D1%20&%20D2.fcs", name: "D1 & D2.fcs" }]);
  });
});

describe("the DataSet uri of an export written as a folder", () => {
  it("is the file's path beside the workspace, each segment percent-encoded, and the sample keeps the file's name", () => {
    const { xml } = exportFlowJoWorkspace({
      samples: [
        entry("D1 #2&x?.fcs", { folderPath: "D1 #2&x?.fcs" }),
        entry("D1 #2&x?.fcs", { folderPath: "2/D1 #2&x?.fcs" }),
        entry("D2_ü.fcs", { folderPath: "D2_ü.fcs" }),
      ],
    });
    expect(dataSets(xml)).toEqual([
      { uri: "file:D1%20%232%26x%3F.fcs", name: "D1 #2&x?.fcs" },
      { uri: "file:2/D1%20%232%26x%3F.fcs", name: "D1 #2&x?.fcs" },
      { uri: "file:D2_%C3%BC.fcs", name: "D2_ü.fcs" },
    ]);
    // Read back as FlowJo and FlowKit read it: percent-decoded, relative to the workspace.
    expect(dataSets(xml).map((d) => decodeURIComponent(d.uri!.slice("file:".length)))).toEqual(["D1 #2&x?.fcs", "2/D1 #2&x?.fcs", "D2_ü.fcs"]);
  });
});

describe("a file written under another name, because Chrome refuses its own", () => {
  it("is named by the workspace's DataSet uri and sample as written, its keywords, $FIL among them, as recorded", () => {
    const { xml } = exportFlowJoWorkspace({
      samples: [entry("D1 1:2.fcs", { sample: syntheticSample(50, { $FIL: "D1 1:2.fcs" }), folderPath: "D1 1_2.fcs" })],
    });
    expect(dataSets(xml)).toEqual([{ uri: "file:D1%201_2.fcs", name: "D1 1_2.fcs" }]);
    expect(xml).toContain('<Keyword name="$FIL" value="D1 1:2.fcs" />');
  });

  it("keeps the name GateLab holds for group membership", () => {
    const { xml } = exportFlowJoWorkspace({
      samples: [entry("D1 1:2.fcs", { folderPath: "D1 1_2.fcs" }), entry("D2.fcs", { folderPath: "D2.fcs" })],
      groups: [{ name: "Stim", fileNames: ["D1 1:2.fcs"] }],
    });
    expect(xml).toMatch(/<GroupNode name="Stim"[^]*?<SampleRef sampleID="1" \/>\s*<\/SampleRefs>/);
  });
});

describe("the workspace's size before the export evaluates a population", () => {
  it("is at least what the export writes, and more only by the room its counts could take", () => {
    const samples = [
      entry("D1.fcs", { sample: syntheticSample(50), folderPath: "D1.fcs" }),
      entry("D2 #1.fcs", { sample: syntheticSample(12345), folderPath: "D2 #1.fcs" }),
    ];
    const opts = { samples, producer: "GateLab", groups: [{ name: "G", fileNames: ["D1.fcs"] }] };
    const atMost = flowJoWorkspaceBytesAtMost(opts);
    const { xml } = exportFlowJoWorkspace(opts);
    const written = new TextEncoder().encode(xml).byteLength;
    expect(atMost).toBeGreaterThanOrEqual(written);
    // One Cells population per sample, each count at most the 5 digits of the larger file's events.
    expect(atMost - written).toBeLessThanOrEqual(2 * ' count="12345"'.length);
  });
});
