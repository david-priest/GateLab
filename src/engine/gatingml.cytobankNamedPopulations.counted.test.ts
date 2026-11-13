// @vitest-environment jsdom
// Cytobank's flat model: a Boolean gate that names other populations. A second population it
// names adds that population's gates, and the complement of a population, which is an OR of
// excluded gates, is left out by name.
import { describe, expect, it } from "vitest";
import {
  importGatingML,
  resolveGatingMLCompensation,
  gatingMLImportOptionsFor,
  fcsDeclaresCompensation,
  type GatingMLImportOptions,
} from "./gatingml";
import { applyGatingStrategy } from "./populations";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";

const NS = `xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
  xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations"
  xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"`;
const gml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<gating:Gating-ML ${NS}>\n${body}\n</gating:Gating-ML>`;

function sampleOf(cols: Record<string, number[]>): Sample {
  const names = Object.keys(cols);
  const n = cols[names[0]].length;
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: n, instrument: "flow", keywords: {}, spillover: null,
    channels: names.map((name, index) => ({ index, name, marker: null, bits: 64, range: 262144 })),
    columns: names.map((name) => Float64Array.from(cols[name])),
  } as FcsFile;
  return new Sample(fcs);
}
function evaluate(xml: string, sample: Sample, options?: GatingMLImportOptions) {
  const pnn: Record<string, string> = {};
  for (const c of sample.channels) pnn[c.pnn] = c.key;
  const res = importGatingML(xml, sample.channels.map((c) => c.key), pnn, sample.instrument,
    options ?? gatingMLImportOptionsFor(sample));
  const comp = resolveGatingMLCompensation(res.compensation, res.compensation_refs, true,
    sample.spillover ?? null, { fcsHasSpillover: fcsDeclaresCompensation(sample.fcs) });
  if (comp.target !== null) sample.setCompensation(comp.target);
  const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, sample.gateAssayData());
  const byName = (name: string): number[] | string => {
    const pop = Object.values(res.populations).find((p) => p.name === name);
    if (!pop) return `(no population ${name})`;
    return Array.from(masks[pop.population_id]);
  };
  return { res, byName };
}
const dim = (ch: string, min?: number, max?: number, extra = "") =>
  `<gating:dimension gating:compensation-ref="uncompensated"${min !== undefined ? ` gating:min="${min}"` : ""}${max !== undefined ? ` gating:max="${max}"` : ""}${extra}><data-type:fcs-dimension data-type:name="${ch}"/></gating:dimension>`;
const cb = (name: string, extra = "") => `<data-type:custom_info><cytobank><name>${name}</name>${extra}</cytobank></data-type:custom_info>`;

describe("a Cytobank Boolean gate naming other populations", () => {
  it("holds the events of both populations it names (2 events, 1 held)", () => {
    const xml = gml(`
      <gating:RectangleGate gating:id="G1">${cb("g1")}${dim("FL1-A", 10, 100)}</gating:RectangleGate>
      <gating:RectangleGate gating:id="G2">${cb("g2")}${dim("FL2-A", 10, 100)}</gating:RectangleGate>
      <gating:RectangleGate gating:id="G3">${cb("g3")}${dim("FL3-A", 10, 100)}</gating:RectangleGate>
      <gating:BooleanGate gating:id="B1">${cb("P1", "<gate_set_id>1</gate_set_id>")}
        <gating:and><gating:gateReference gating:ref="G1"/><gating:gateReference gating:ref="G1"/></gating:and></gating:BooleanGate>
      <gating:BooleanGate gating:id="B2">${cb("P2", "<gate_set_id>2</gate_set_id>")}
        <gating:and><gating:gateReference gating:ref="G2"/><gating:gateReference gating:ref="G2"/></gating:and></gating:BooleanGate>
      <gating:BooleanGate gating:id="B3">${cb("P3", `<gate_set_id>3</gate_set_id><definition>{"booleanExpression":"pop_1 AND pop_2"}</definition>`)}
        <gating:and><gating:gateReference gating:ref="B1"/><gating:gateReference gating:ref="B2"/><gating:gateReference gating:ref="G3"/></gating:and></gating:BooleanGate>`);
    // The second event is in P1 and outside P2.
    const { byName, res } = evaluate(xml, sampleOf({ "FL1-A": [50, 50], "FL2-A": [50, 5], "FL3-A": [50, 50] }));
    expect(byName("P1")).toEqual([1, 1]);
    expect(byName("P2")).toEqual([1, 0]);
    expect(byName("P3")).toEqual([1, 0]);
    expect(res.warnings).toEqual([]);
  });

  it("adds nothing for the population it sits under", () => {
    const xml = gml(`
      <gating:RectangleGate gating:id="G1">${cb("g1")}${dim("FL1-A", 10, 100)}</gating:RectangleGate>
      <gating:RectangleGate gating:id="G2">${cb("g2")}${dim("FL2-A", 10, 100)}</gating:RectangleGate>
      <gating:BooleanGate gating:id="B1">${cb("P1", "<gate_set_id>1</gate_set_id>")}
        <gating:and><gating:gateReference gating:ref="G1"/><gating:gateReference gating:ref="G1"/></gating:and></gating:BooleanGate>
      <gating:BooleanGate gating:id="B2">${cb("P2", `<gate_set_id>2</gate_set_id><definition>{"booleanExpression":"pop_1"}</definition>`)}
        <gating:and><gating:gateReference gating:ref="B1"/><gating:gateReference gating:ref="G2"/></gating:and></gating:BooleanGate>`);
    const { byName, res } = evaluate(xml, sampleOf({ "FL1-A": [50, 50, 5], "FL2-A": [50, 5, 50] }));
    const p2 = Object.values(res.populations).find((p) => p.name === "P2")!;
    expect(p2.gate_refs).toHaveLength(1);
    expect(res.populations[p2.parent_id!].name).toBe("P1");
    expect(byName("P2")).toEqual([1, 0, 0]);
  });

  it("leaves out the complement of a population, by name", () => {
    const xml = gml(`
      <gating:RectangleGate gating:id="G1">${cb("CD4_gate")}${dim("FL1-A", 10, 100)}</gating:RectangleGate>
      <gating:RectangleGate gating:id="G2">${cb("CD8_gate")}${dim("FL2-A", 10, 100)}</gating:RectangleGate>
      <gating:BooleanGate gating:id="B1">${cb("CD4_positive", "<gate_set_id>1</gate_set_id>")}
        <gating:and><gating:gateReference gating:ref="G1"/><gating:gateReference gating:ref="G1"/></gating:and></gating:BooleanGate>
      <gating:BooleanGate gating:id="B2">${cb("notCD4_CD8", `<gate_set_id>2</gate_set_id><definition>{"booleanExpression":"pop_1"}</definition>`)}
        <gating:and><gating:gateReference gating:ref="B1" gating:use-as-complement="true"/><gating:gateReference gating:ref="G2"/></gating:and></gating:BooleanGate>`);
    const { byName, res } = evaluate(xml, sampleOf({ "FL1-A": [50, 5], "FL2-A": [50, 50] }));
    expect(byName("CD4_positive")).toEqual([1, 0]);
    expect(Object.values(res.populations).some((p) => p.name === "notCD4_CD8")).toBe(false);
    expect(res.warnings.filter((w) => w.includes("notCD4_CD8"))).toHaveLength(1);
  });
});
