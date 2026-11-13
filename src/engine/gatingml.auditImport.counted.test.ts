// @vitest-environment jsdom
// Gating-ML files read against the specification's own rules, on events with known members.
import { describe, expect, it } from "vitest";
import { importGatingML, gatingMLImportOptionsFor, type GatingMLImportOptions } from "./gatingml";
import { applyGatingStrategy } from "./populations";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";

const NS = `xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
  xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations"
  xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"`;
const gml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<gating:Gating-ML ${NS}>\n${body}\n</gating:Gating-ML>`;
const dim = (channel: string, min?: number, max?: number, extra = "") =>
  `<gating:dimension gating:compensation-ref="uncompensated"${min !== undefined ? ` gating:min="${min}"` : ""}${max !== undefined ? ` gating:max="${max}"` : ""}${extra}><data-type:fcs-dimension data-type:name="${channel}"/></gating:dimension>`;

function sampleOf(columns: Record<string, number[]>): Sample {
  const names = Object.keys(columns);
  return new Sample({
    version: "FCS3.1", nEvents: columns[names[0]].length, instrument: "flow", keywords: {}, spillover: null,
    channels: names.map((name, index) => ({ index, name, marker: null, bits: 64, range: 262144 })),
    columns: names.map((name) => Float64Array.from(columns[name])),
  } as FcsFile);
}

/** The events each population of the file holds, by population name. */
function membersOf(xml: string, sample: Sample, options?: GatingMLImportOptions) {
  const pnn: Record<string, string> = {};
  for (const c of sample.channels) pnn[c.pnn] = c.key;
  const res = importGatingML(xml, sample.channels.map((c) => c.key), pnn, sample.instrument, options ?? gatingMLImportOptionsFor(sample));
  const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, sample.gateAssayData());
  const members = (name: string): number[] => {
    const pop = Object.values(res.populations).find((p) => p.name === name);
    expect(pop, `population "${name}"`).toBeDefined();
    return Array.from(masks[pop!.population_id]);
  };
  return { res, members };
}

describe("Gating-ML import, counted", () => {
  it("reads matrix-inverted-already=\"1\" as true", () => {
    const file = (flag: string) => gml(`
      <transforms:spectrumMatrix transforms:id="SM" transforms:matrix-inverted-already="${flag}">
        <transforms:fluorochromes><data-type:fcs-dimension data-type:name="FL1-A"/><data-type:fcs-dimension data-type:name="FL2-A"/></transforms:fluorochromes>
        <transforms:detectors><data-type:fcs-dimension data-type:name="FL1-A"/><data-type:fcs-dimension data-type:name="FL2-A"/></transforms:detectors>
        <transforms:spectrum><transforms:coefficient transforms:value="1"/><transforms:coefficient transforms:value="-0.25"/></transforms:spectrum>
        <transforms:spectrum><transforms:coefficient transforms:value="0"/><transforms:coefficient transforms:value="1"/></transforms:spectrum>
      </transforms:spectrumMatrix>
      <gating:RectangleGate gating:id="G1"><gating:dimension gating:compensation-ref="SM" gating:min="10" gating:max="100"><data-type:fcs-dimension data-type:name="FL1-A"/></gating:dimension></gating:RectangleGate>`);
    const spill = (flag: string) => importGatingML(file(flag), ["FL1-A", "FL2-A"], {}, "flow").spectrum_matrix?.matrix;
    expect(spill("true")).toEqual([[1, 0.25], [0, 1]]);
    expect(spill("1")).toEqual([[1, 0.25], [0, 1]]);
    expect(spill("false")).toEqual([[1, -0.25], [0, 1]]);
    expect(spill("0")).toEqual([[1, -0.25], [0, 1]]);
  });

  it("holds no event in a rectangle whose min is above its max", () => {
    const xml = gml(`<gating:RectangleGate gating:id="R1">${dim("FL1-A", 100, 10)}</gating:RectangleGate>
      <gating:RectangleGate gating:id="R2">${dim("FL1-A", 10, 100)}</gating:RectangleGate>`);
    const { members } = membersOf(xml, sampleOf({ "FL1-A": [50, 5, 200, 100, 10] }));
    expect(members("R1")).toEqual([0, 0, 0, 0, 0]);
    expect(members("R2")).toEqual([1, 0, 0, 0, 1]);
  });

  it("holds no event in a gate ANDed with its own complement (GatingHierarchy form)", () => {
    const xml = gml(`
      <gating:RectangleGate gating:id="G1">${dim("FL1-A", 10, 100)}</gating:RectangleGate>
      <gating:BooleanGate gating:id="B1"><gating:and><gating:gateReference gating:ref="G1"/><gating:gateReference gating:ref="G1" gating:use-as-complement="true"/></gating:and></gating:BooleanGate>
      <gating:GatingHierarchy><gating:PopulationGatePair gating:gate-ref="B1"><gating:name>CD4_and_not_CD4</gating:name></gating:PopulationGatePair></gating:GatingHierarchy>`);
    expect(membersOf(xml, sampleOf({ "FL1-A": [50, 5] })).members("CD4_and_not_CD4")).toEqual([0, 0]);
  });

  it("refuses a file whose parent gates form a cycle, naming the gates", () => {
    const xml = gml(`
      <gating:RectangleGate gating:id="R1" gating:parent_id="R2">${dim("FL1-A", 0, 100)}</gating:RectangleGate>
      <gating:RectangleGate gating:id="R2" gating:parent_id="R1">${dim("FL2-A", 0, 100)}</gating:RectangleGate>
      <gating:RectangleGate gating:id="R3">${dim("FL1-A", 0, 100)}</gating:RectangleGate>`);
    expect(() => importGatingML(xml, ["FL1-A", "FL2-A"], {}, "flow")).toThrow(/R1 .*is its own ancestor[\s\S]*R2 .*is its own ancestor/);
  });

  it("restates a bounded linear axis's bound with its coordinates under $PnG", () => {
    const xml = gml(`
      <transforms:transformation transforms:id="Lin" transforms:boundMax="0.5"><transforms:flin transforms:T="1000" transforms:A="0"/></transforms:transformation>
      <gating:PolygonGate gating:id="P1">
        ${dim("FL1-A", undefined, undefined, ' gating:transformation-ref="Lin"')}
        ${dim("FL2-A")}
        <gating:vertex><gating:coordinate data-type:value="0.4"/><gating:coordinate data-type:value="0"/></gating:vertex>
        <gating:vertex><gating:coordinate data-type:value="0.6"/><gating:coordinate data-type:value="0"/></gating:vertex>
        <gating:vertex><gating:coordinate data-type:value="0.6"/><gating:coordinate data-type:value="100"/></gating:vertex>
        <gating:vertex><gating:coordinate data-type:value="0.4"/><gating:coordinate data-type:value="100"/></gating:vertex>
      </gating:PolygonGate>`);
    // Scale values 450, 750 and 300: on the axis 0.45, 0.75 (held at the bound, 0.5) and 0.3.
    expect(membersOf(xml, sampleOf({ "FL1-A": [450, 750, 300], "FL2-A": [50, 50, 50] }), {}).members("P1")).toEqual([1, 1, 0]);
    // The same events stored at twice the scale value, with $PnG 2.
    expect(membersOf(xml, sampleOf({ "FL1-A": [900, 1500, 600], "FL2-A": [50, 50, 50] }), { gains: new Map([["FL1-A", 2]]) }).members("P1")).toEqual([1, 1, 0]);
  });
});
