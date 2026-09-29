// @vitest-environment jsdom
//
// Gating-ML import and export of what a dimension declares: every transform GateLab reads, held
// exactly (fasinh for any M and A, flin, flog as the standard defines it, and a transformation's
// bounds), on every channel, Time in the unit its writer uses, compensation per gate, and the
// problems a file can carry, each refused or left out by name. Every expectation here is computed
// from the Gating-ML 2.0 formulas in this file, never from GateLab's own transforms, and each
// case is evaluated through the sample's own gating path (Sample.gateAssayData).
import { describe, it, expect } from "vitest";
import {
  importGatingML,
  resolveGatingMLCompensation,
  gatingMLImportOptionsFor,
  channelsCompensationChanges,
  fcsDeclaresCompensation,
  type GatingMLImportOptions,
  type GatingMLResult,
} from "./gatingml";
import { CYTOBANK_OMITS_CONTRADICTIONS, exportGatingML, analyzeCytobankContradictions } from "./gatingmlExport";
import { applyGatingStrategy } from "./populations";
import { Sample, transformFromSpec } from "./sample";
import type { FcsFile, SpilloverMatrix } from "./fcs";
import type { Gate, PopulationMap, TransformSpec } from "./models";
import { getGateMask } from "./gates";
import { UNBOUNDED, newGateRef, newPopulation, newRootPopulation, linkChildToParent } from "./models";
import { flowJoWorkspaceToGatingML } from "./flowjoWorkspace";

const LN10 = Math.LN10;
const NS = `xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
  xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations"
  xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"`;
const gml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<gating:Gating-ML ${NS}>\n${body}\n</gating:Gating-ML>`;

/** Gating-ML 2.0 fasinh and its inverse, straight from the specification. */
const fasinh = (x: number, T: number, M: number, A: number) =>
  (Math.asinh((x * Math.sinh(M * LN10)) / T) + A * LN10) / ((M + A) * LN10);
const fasinhInv = (y: number, T: number, M: number, A: number) =>
  (T / Math.sinh(M * LN10)) * Math.sinh(y * (M + A) * LN10 - A * LN10);
/** Gating-ML 2.0 flog: undefined (NaN, or −Infinity at 0) for x <= 0. */
const flog = (x: number, T: number, M: number) => Math.log10(x / T) / M + 1;

/** A sample from columns of values, one channel per key ($PnN, no $PnS). */
function sampleOf(
  instrument: "flow" | "cytof",
  cols: Record<string, number[]>,
  opts: { keywords?: Record<string, string>; spillover?: SpilloverMatrix | null } = {},
): Sample {
  const names = Object.keys(cols);
  const n = cols[names[0]].length;
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: n,
    instrument,
    keywords: opts.keywords ?? {},
    spillover: opts.spillover ?? null,
    channels: names.map((name, index) => ({ index, name, marker: null, bits: 64, range: 262144 })),
    columns: names.map((name) => Float64Array.from(cols[name])),
  };
  return new Sample(fcs);
}

/** Import as the app does, turn compensation where the file asks, and evaluate every population. */
function evaluate(xml: string, sample: Sample, options?: GatingMLImportOptions) {
  const pnn: Record<string, string> = {};
  for (const c of sample.channels) pnn[c.pnn] = c.key;
  const res = importGatingML(xml, sample.channels.map((c) => c.key), pnn, sample.instrument,
    options ?? gatingMLImportOptionsFor(sample));
  const comp = resolveGatingMLCompensation(res.compensation, res.compensation_refs, sample.instrument === "flow",
    sample.spillover ?? null, { fcsHasSpillover: fcsDeclaresCompensation(sample.fcs) });
  if (comp.target !== null) sample.setCompensation(comp.target);
  const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, sample.gateAssayData());
  const byName = (name: string): number[] => {
    const pop = Object.values(res.populations).find((p) => p.name === name);
    if (!pop) throw new Error(`no population ${name}; have ${Object.values(res.populations).map((p) => p.name).join(", ")}`);
    return Array.from(masks[pop.population_id]);
  };
  return { res, comp, byName };
}

const gateNames = (res: GatingMLResult) => Object.values(res.gates).map((g) => g.name).sort();

describe("fasinh with any M and A (confirmed 1, 2, 3, 20, 21, 28, 29, 34)", () => {
  it("inverts A the right way: a flow range on fasinh T=10000 M=4 A=1 selects what the formula does", () => {
    // ISAC ScaleRange1's transform. The inverse subtracts A ln10; GateLab added it, which put the
    // range at 707.9..14125 instead of 6.94..141.2 and kept 1 event where the suite expects 8,425.
    const [T, M, A] = [10000, 4, 1];
    const xs = [5, 6.9, 7, 50, 141, 142, 700, 1000, 10000, 14000];
    const s = sampleOf("flow", { "FL1-H": xs });
    const xml = gml(`
      <transforms:transformation transforms:id="Tr"><transforms:fasinh transforms:T="${T}" transforms:M="${M}" transforms:A="${A}"/></transforms:transformation>
      <gating:RectangleGate gating:id="R" gating:name="R">
        <gating:dimension gating:min="0.37" gating:max="0.63" gating:transformation-ref="Tr" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="FL1-H"/></gating:dimension>
      </gating:RectangleGate>`);
    const expected = xs.map((x) => (fasinh(x, T, M, A) >= 0.37 && fasinh(x, T, M, A) <= 0.63 ? 1 : 0));
    expect(expected).toEqual([0, 0, 1, 1, 1, 0, 0, 0, 0, 0]);
    expect(evaluate(xml, s).byName("R")).toEqual(expected);
  });

  it("keeps a flow polygon straight in the declared fasinh, and imports an ellipse there", () => {
    // Inverted into raw, a polygon's edges were straight in raw space, another gate, and an
    // ellipse was dropped with the population that used it.
    const [T, M, A] = [262144, 4.5, 0.5];
    const grid: [number, number][] = [];
    // Off every vertex and edge by far more than single precision, so no event is a boundary tie.
    for (let i = 0; i <= 24; i++) for (let j = 0; j <= 24; j++) grid.push([0.2013 + i * 0.0301, 0.2027 + j * 0.0299]);
    const s = sampleOf("flow", {
      "FITC-A": grid.map(([u]) => fasinhInv(u, T, M, A)),
      "PE-A": grid.map(([, v]) => fasinhInv(v, T, M, A)),
    });
    const tri: [number, number][] = [[0.3, 0.3], [0.85, 0.35], [0.35, 0.8]];
    const inTri = ([x, y]: [number, number]) => {
      let inside = false;
      for (let i = 0, j = tri.length - 1; i < tri.length; j = i++) {
        const [xi, yi] = tri[i];
        const [xj, yj] = tri[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside ? 1 : 0;
    };
    const dim = (ch: string) => `<gating:dimension gating:transformation-ref="Tr" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="${ch}"/></gating:dimension>`;
    const xml = gml(`
      <transforms:transformation transforms:id="Tr"><transforms:fasinh transforms:T="${T}" transforms:M="${M}" transforms:A="${A}"/></transforms:transformation>
      <gating:PolygonGate gating:id="P" gating:name="P">${dim("FITC-A")}${dim("PE-A")}
        ${tri.map(([x, y]) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`).join("")}
      </gating:PolygonGate>
      <gating:EllipsoidGate gating:id="E" gating:name="E">${dim("FITC-A")}${dim("PE-A")}
        <gating:mean><gating:coordinate data-type:value="0.55"/><gating:coordinate data-type:value="0.5"/></gating:mean>
        <gating:covarianceMatrix>
          <gating:row><gating:entry data-type:value="0.02"/><gating:entry data-type:value="0.005"/></gating:row>
          <gating:row><gating:entry data-type:value="0.005"/><gating:entry data-type:value="0.01"/></gating:row>
        </gating:covarianceMatrix>
        <gating:distanceSquare data-type:value="1"/>
      </gating:EllipsoidGate>`);
    const { res, byName } = evaluate(xml, s);
    expect(res.n_gates_skipped).toBe(0);
    expect(res.warnings).toEqual([]);
    // Every gate stays in the space the file declares.
    for (const g of Object.values(res.gates)) expect(g.space, g.name).toBe("display");
    expect(byName("P")).toEqual(grid.map(inTri));
    // (p − μ)ᵀ Σ⁻¹ (p − μ) <= 1 in the declared space.
    const det = 0.02 * 0.01 - 0.005 * 0.005;
    const inE = ([x, y]: [number, number]) => {
      const dx = x - 0.55;
      const dy = y - 0.5;
      return (0.01 * dx * dx - 2 * 0.005 * dx * dy + 0.02 * dy * dy) / det <= 1 ? 1 : 0;
    };
    const expectedE = grid.map(inE);
    expect(expectedE.reduce((a: number, b) => a + b, 0)).toBeGreaterThan(20);
    expect(byName("E")).toEqual(expectedE);
  });

  it("does not take a CyTOF gate's fasinh coordinates as ion counts", () => {
    // On a metal channel the fallback kept the transformed coordinates and labelled them raw, so
    // 0.05..0.35 was compared with counts.
    const [T, M, A] = [262144, 4.5, 0];
    const xs = [0, 0.1, 0.3, 5, 20, 60, 200, 1000];
    const s = sampleOf("cytof", { Nd142Di: xs, Nd144Di: xs.map(() => 1) });
    const xml = gml(`
      <transforms:transformation transforms:id="Tr"><transforms:fasinh transforms:T="${T}" transforms:M="${M}" transforms:A="${A}"/></transforms:transformation>
      <gating:RectangleGate gating:id="R" gating:name="R">
        <gating:dimension gating:min="0.05" gating:max="0.35" gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="Nd142Di"/></gating:dimension>
      </gating:RectangleGate>`);
    const expected = xs.map((x) => (fasinh(x, T, M, A) >= 0.05 && fasinh(x, T, M, A) <= 0.35 ? 1 : 0));
    expect(expected.reduce((a: number, b) => a + b, 0)).toBeGreaterThan(1);
    expect(evaluate(xml, s).byName("R")).toEqual(expected);
  });

  it("re-expresses no gate inexactly: what it cannot hold exactly is refused by name (confirmed 22)", () => {
    // The raw fallback's list was never shown to anyone. Nothing reaches it now: a fasinh is held
    // exactly, a polygon in the declared space and a rectangle from another writer on raw values
    // with its edges placed where the file's transform puts them, and a transformation GateLab
    // cannot hold is refused with its gate named.
    const s = sampleOf("flow", { "PE-A": [1, 2, 3], "FITC-A": [1, 2, 3] });
    const polygon = (tr: string) => gml(`
      ${tr}
      <gating:RectangleGate gating:id="R" gating:name="Odd">
        <gating:dimension gating:min="0.2" gating:max="0.6" gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
      </gating:RectangleGate>
      <gating:PolygonGate gating:id="P" gating:name="Poly">
        <gating:dimension gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
        <gating:dimension gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="FITC-A"/></gating:dimension>
        ${[[0.2, 0.2], [0.6, 0.2], [0.4, 0.6]].map(([x, y]) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`).join("")}
      </gating:PolygonGate>`);
    const held = evaluate(polygon(`<transforms:transformation transforms:id="Tr"><transforms:fasinh transforms:T="1000" transforms:M="2" transforms:A="0.5"/></transforms:transformation>`), s);
    const byName = (n: string) => Object.values(held.res.gates).find((g) => g.name === n) as Extract<Gate, { vertices: unknown }>;
    expect(byName("Poly").space).toBe("display");
    expect(byName("Odd").space).toBe("raw");
    const xs = byName("Odd").vertices.map((v) => v[0]);
    expect(fasinh(Math.min(...xs), 1000, 2, 0.5)).toBeCloseTo(0.2, 12);
    expect(fasinh(Math.max(...xs), 1000, 2, 0.5)).toBeCloseTo(0.6, 12);
    expect("untranslatable_transform_gates" in held.res).toBe(false);
    // W above M/2 is no logicle; the gate was inverted into raw and imported without a word.
    expect(() => importGatingML(polygon(`<transforms:transformation transforms:id="Tr"><transforms:logicle transforms:T="262144" transforms:W="3" transforms:M="4.5" transforms:A="0"/></transforms:transformation>`), ["PE-A"], {}, "flow"))
      .toThrow(/R \(Odd\) references transformation Tr, which is invalid: logicle with W = 3 above M\/2 = 2\.25/);
  });
});

// A fasinh is held as GateLab's asinh(x / c), its coordinates v as v (M + A) ln 10 − A ln 10, so at
// a small M the whole scale is small: at M = 1e-4 it reaches 2.3e-4 at T. GateLab's polygon test
// holds an event within 1e-9 of an edge, and there that is some 4e-6 of the scale: on the public
// PBMC file a FlowKit-written polygon held 136 events FlowKit leaves out, and at M = 1e-9 its whole
// bounding box (verifier). Each event here lies off the triangle's edges by 1.4e-6 of the scale, far
// beyond single precision's rounding and within 1e-9 of an edge in GateLab's units.
describe("a polygon on a fasinh with a small M (verifier)", () => {
  const T = 262144;
  const tri: [number, number][] = [[0.1, 0.1], [0.5, 0.1], [0.1, 0.5]];
  const inTri = (x: number, y: number) => {
    let inside = false;
    for (let i = 0, j = tri.length - 1; i < tri.length; j = i++) {
      const [xi, yi] = tri[i];
      const [xj, yj] = tri[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside ? 1 : 0;
  };
  const d = 1e-6;
  const pts: [number, number][] = [];
  for (let t = 0.15; t < 0.46; t += 0.05) {
    for (const s of [-1, 1]) {
      pts.push([t + s * d, 0.6 - t + s * d]); // either side of the long edge
      pts.push([t, 0.1 - s * d]); // either side of the lower edge
      pts.push([0.1 - s * d, t]); // either side of the left edge
    }
  }
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) pts.push([0.0213 + i * 0.05, 0.0187 + j * 0.05]);
  const dim = (ch: string) => `<gating:dimension gating:transformation-ref="Tr" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="${ch}"/></gating:dimension>`;
  const file = (M: number) => gml(`
    <transforms:transformation transforms:id="Tr"><transforms:fasinh transforms:T="${T}" transforms:M="${M}" transforms:A="0"/></transforms:transformation>
    <gating:PolygonGate gating:id="P" gating:name="Tri">${dim("FITC-A")}${dim("PE-A")}
      ${tri.map(([x, y]) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`).join("")}
    </gating:PolygonGate>
    <gating:RectangleGate gating:id="R" gating:name="Box">
      <gating:dimension gating:min="0.1" gating:max="0.5" gating:transformation-ref="Tr" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="FITC-A"/></gating:dimension>
    </gating:RectangleGate>`);
  const sample = (M: number) => sampleOf("flow", {
    "FITC-A": pts.map(([x]) => fasinhInv(x, T, M, 0)),
    "PE-A": pts.map(([, y]) => fasinhInv(y, T, M, 0)),
  });
  /** Each event's decision, by the standard's fasinh in double precision and an even-odd test. */
  const expected = (M: number) => pts.map(([x, y]) => {
    const [u, v] = [fasinh(fasinhInv(x, T, M, 0), T, M, 0), fasinh(fasinhInv(y, T, M, 0), T, M, 0)];
    return inTri(u, v);
  });

  for (const M of [1e-4, 1e-9, 1e-30]) {
    it(`holds the events the standard's fasinh puts in the polygon, and no event beside it (M = ${M})`, () => {
      const want = expected(M);
      expect(want.reduce((a: number, b) => a + b, 0)).toBeGreaterThan(20);
      const { res, byName } = evaluate(file(M), sample(M));
      expect(res.warnings).toEqual([]);
      expect(byName("Tri")).toEqual(want);
    });
  }

  // The exporter settles each event on a polygon's edge with a notch (tieBreakPolygon), and its least
  // scale was in the gate's units: at M = 1e-4 every event lay near an edge, one polygon on the
  // public PBMC file took 45 s to write and 524 events moved on reading it back. At M = 1e-30 the
  // asinh cofactor, 1.1e35, put a "+" in the transformation's id, which an xs:ID has not.
  for (const M of [1e-4, 1e-30]) {
    it(`writes such a polygon in both formats, valid, which read back with the same events (M = ${M})`, () => {
      const s = sample(M);
      const { res, byName } = evaluate(file(M), s);
      const want = byName("Tri");
      expect(want).toEqual(expected(M));
      for (const format of ["standard", "cytobank"] as const) {
        const t0 = performance.now();
        const out = exportGatingML({
          gates: res.gates, gate_order: res.gate_order, populations: res.populations, root_population_id: res.root_population_id,
          sample: s, format, timestamp: "2026-01-01T00:00:00",
        });
        const took = performance.now() - t0;
        expect(took, `${format}: ${took.toFixed(0)} ms`).toBeLessThan(5000);
        for (const [, id] of out.matchAll(/transforms:id="([^"]+)"/g)) expect(id, format).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]*$/);
        expect(evaluate(out, sample(M)).byName("Tri"), format).toEqual(want);
      }
    });
  }

  it("leaves a polygon out by name where single precision cannot hold the scale, and reads the rectangle", () => {
    // Below about M = 8.6e-32 a value at T / 2^24 lies under single precision's least normal
    // number on the scale; at M = 1e-45 every event of the public PBMC file was 0 there, and the
    // polygon held none of the 30,464 events FlowKit counts.
    const M = 1e-45;
    const { res, byName } = evaluate(file(M), sample(M));
    expect(Object.values(res.gates).map((g) => g.name)).toEqual(["Box"]);
    expect(res.warnings.join("\n")).toMatch(/Tri.*fasinh with M = 1e-45.*single precision/);
    const box = pts.map(([x]) => { const u = fasinh(fasinhInv(x, T, M, 0), T, M, 0); return u >= 0.1 && u <= 0.5 ? 1 : 0; });
    expect(byName("Box")).toEqual(box);
  });
});

describe("a file that mixes uncompensated and FCS dimensions (confirmed 4, 24, 37)", () => {
  const spill = { channels: ["FITC-A", "PE-A"], matrix: [[1, 0.2], [0.1, 1]] };
  const cols = {
    "FSC-A": [10, 20, 30, 40],
    "SSC-A": [10, 20, 30, 40],
    "FITC-A": [1000, 1200, 3000, 5000],
    "PE-A": [500, 2000, 800, 4000],
  };
  const rect = (id: string, x: string, y: string, ref: string) => `
    <gating:RectangleGate gating:id="${id}" gating:name="${id}">
      <gating:dimension gating:min="900" gating:compensation-ref="${ref}"><data-type:fcs-dimension data-type:name="${x}"/></gating:dimension>
      <gating:dimension gating:min="0" gating:compensation-ref="${ref}"><data-type:fcs-dimension data-type:name="${y}"/></gating:dimension>
    </gating:RectangleGate>`;
  const xml = gml(`
    ${rect("Uncompensated", "FITC-A", "PE-A", "uncompensated")}
    ${rect("Compensated", "FITC-A", "PE-A", "FCS")}
    <gating:RectangleGate gating:id="Scatter" gating:name="Scatter">
      <gating:dimension gating:min="15" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
    </gating:RectangleGate>`);

  it("leaves the uncompensated gate on a compensated channel out, by name, and keeps the rest", () => {
    const s = sampleOf("flow", cols, { spillover: spill });
    const { res, comp, byName } = evaluate(xml, s);
    expect(comp.target).toBe(true);
    expect(gateNames(res)).toEqual(["Compensated", "Scatter"]);
    expect(res.warnings).toEqual([
      expect.stringMatching(/^"Uncompensated" declares uncompensated values on FITC-A, PE-A, which the file's other gates compensate; .*it and anything below it were skipped\.$/),
    ]);
    // Scatter is outside the matrix, so "uncompensated" there is what compensation leaves it.
    expect(byName("Scatter")).toEqual([0, 1, 1, 1]);
  });

  it("does the same when it does not know which channels the matrix covers", () => {
    const s = sampleOf("flow", cols, { spillover: spill });
    const pnn: Record<string, string> = {};
    for (const c of s.channels) pnn[c.pnn] = c.key;
    const res = importGatingML(xml, s.channels.map((c) => c.key), pnn, "flow");
    expect(gateNames(res)).toEqual(["Compensated", "Scatter"]);
  });

  it("evaluates every gate uncompensated when only channels the matrix leaves alone ask for compensation (verifier)", () => {
    // "FCS" on scatter, which no matrix covers, asks for nothing compensation changes; the
    // fluorescence gate says uncompensated. Compensation off holds both exactly, where the gate on
    // FITC-A and PE-A was left out (a FlowKit-written file on the public FACSDiva data: "UncompFluor"
    // left out, FlowKit 36,759 events).
    const mixed = gml(`
      ${rect("UncompFluor", "FITC-A", "PE-A", "uncompensated")}
      <gating:RectangleGate gating:id="ScatterFCS" gating:name="ScatterFCS">
        <gating:dimension gating:min="15" gating:compensation-ref="FCS"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
      </gating:RectangleGate>`);
    const s = sampleOf("flow", cols, { spillover: spill });
    const { res, comp, byName } = evaluate(mixed, s);
    expect(gateNames(res)).toEqual(["ScatterFCS", "UncompFluor"]);
    expect(res.warnings).toEqual([]);
    expect(comp.target).toBe(false);
    expect(byName("UncompFluor")).toEqual(cols["FITC-A"].map((x, i) => (x >= 900 && cols["PE-A"][i] >= 0 ? 1 : 0)));
    expect(byName("ScatterFCS")).toEqual([0, 1, 1, 1]);
    // Not knowing which channels the matrix covers, scatter is still taken as outside it.
    const pnn: Record<string, string> = {};
    for (const c of s.channels) pnn[c.pnn] = c.key;
    expect(gateNames(importGatingML(mixed, s.channels.map((c) => c.key), pnn, "flow"))).toEqual(["ScatterFCS", "UncompFluor"]);
    // "FCS" on a channel the matrix does cover is still the mix, and the uncompensated gate is left out.
    const both = gml(`
      ${rect("UncompFluor", "FITC-A", "PE-A", "uncompensated")}
      <gating:RectangleGate gating:id="FluorFCS" gating:name="FluorFCS">
        <gating:dimension gating:min="15" gating:compensation-ref="FCS"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
      </gating:RectangleGate>`);
    expect(gateNames(evaluate(both, sampleOf("flow", cols, { spillover: spill })).res)).toEqual(["FluorFCS"]);
  });
});

describe("uncompensated on a detector the matrix lists but leaves as stored (verifier: FR-FCM-ZZRQ)", () => {
  // Nothing spills into PerCP-A: its column of the matrix, and of the inverse the compensation is
  // computed with, is the unit vector, so its compensated values are its stored ones. A gate drawn
  // on it uncompensated was left out with every other channel of the matrix; on the public
  // FR-FCM-ZZRQ workspace, whose matrix's PerCP-H column is (0, ..., 0, 1), "dead, FSC-H subset"
  // and its 8 descendants, which GateLab had evaluated exactly before.
  const spill = { channels: ["FITC-A", "PE-A", "PerCP-A"], matrix: [[1, 0.2, 0], [0.1, 1, 0], [0.3, 0.15, 1]] };
  const cols = {
    "FSC-A": [10, 20, 30, 40, 50, 60],
    "FITC-A": [1000, 1200, 3000, 5000, 800, 2000],
    "PE-A": [500, 2000, 800, 4000, 3000, 900],
    "PerCP-A": [100, 2500, 3100, 900, 4000, 1500],
  };
  /** Each event's compensated values: the row c with c · matrix = stored, by Cramer's rule. */
  const compensated = (i: number): number[] => {
    const m = spill.matrix;
    const det3 = (a: number[][]) =>
      a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
      a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    const b = spill.channels.map((ch) => cols[ch as keyof typeof cols][i]);
    // c · m = b is mᵀ cᵀ = bᵀ.
    const t = [0, 1, 2].map((r) => [0, 1, 2].map((c) => m[c][r]));
    return [0, 1, 2].map((k) => det3(t.map((row, r) => row.map((v, c) => (c === k ? b[r] : v)))) / det3(t));
  };
  const dim = (ch: string, ref: string, min: number, max?: number) =>
    `<gating:dimension gating:min="${min}"${max === undefined ? "" : ` gating:max="${max}"`} gating:compensation-ref="${ref}"><data-type:fcs-dimension data-type:name="${ch}"/></gating:dimension>`;
  const xml = gml(`
    <gating:RectangleGate gating:id="Comp" gating:name="Compensated">${dim("FITC-A", "FCS", 900)}${dim("PE-A", "FCS", 0)}</gating:RectangleGate>
    <gating:RectangleGate gating:id="PerCP" gating:name="PerCP as stored">${dim("PerCP-A", "uncompensated", 1000, 3500)}${dim("FSC-A", "uncompensated", 15)}</gating:RectangleGate>
    <gating:RectangleGate gating:id="Child" gating:name="Child of PerCP" gating:parent_id="PerCP">${dim("FITC-A", "FCS", 1000)}</gating:RectangleGate>
    <gating:BooleanGate gating:id="Both" gating:name="Both"><gating:and><gating:gateReference gating:ref="Comp"/><gating:gateReference gating:ref="PerCP"/></gating:and></gating:BooleanGate>
    <gating:RectangleGate gating:id="PEStored" gating:name="PE as stored">${dim("PE-A", "uncompensated", 1000)}</gating:RectangleGate>`);

  it("evaluates that gate, its child and a Boolean over it on the stored values, and leaves out one on a detector the matrix changes", () => {
    const s = sampleOf("flow", cols, { spillover: spill });
    const { res, comp, byName } = evaluate(xml, s);
    expect(comp.target).toBe(true);
    expect(res.warnings).toEqual([
      expect.stringMatching(/^"PE as stored" declares uncompensated values on PE-A, which the file's other gates compensate; .*it and anything below it were skipped\.$/),
    ]);
    const n = cols["FSC-A"].length;
    const range = Array.from({ length: n }, (_, i) => i);
    const percp = range.map((i) => (cols["PerCP-A"][i] >= 1000 && cols["PerCP-A"][i] <= 3500 && cols["FSC-A"][i] >= 15 ? 1 : 0));
    const comped = range.map((i) => { const [f, p] = compensated(i); return f >= 900 && p >= 0 ? 1 : 0; });
    expect(percp).toEqual([0, 1, 1, 0, 0, 1]);
    expect(byName("PerCP as stored")).toEqual(percp);
    expect(byName("Compensated")).toEqual(comped);
    expect(byName("Child of PerCP")).toEqual(range.map((i) => (percp[i] && compensated(i)[0] >= 1000 ? 1 : 0)));
    expect(byName("Both")).toEqual(range.map((i) => percp[i] & comped[i]));
    // The compensated PerCP-A values are the stored ones, as the rule says.
    expect(range.map((i) => compensated(i)[2])).toEqual(cols["PerCP-A"]);
  });

  it("names only the channels the matrix changes", () => {
    const s = sampleOf("flow", cols, { spillover: spill });
    expect(gatingMLImportOptionsFor(s).compensatedChannels).toEqual(["FITC-A", "PE-A"]);
    expect(channelsCompensationChanges(s.spillover!, () => null)).toEqual(["FITC-A", "PE-A", "PerCP-A"]);
  });

  it("still leaves the gate out where single precision changes the stored values", () => {
    // The compensated values are kept in single precision; 2500.1 is not a single-precision number,
    // so compensation moves an event on a gate edge there, and the gate is left out, by name.
    const s = sampleOf("flow", { ...cols, "PerCP-A": cols["PerCP-A"].map((v) => v + 0.1) }, { spillover: spill });
    expect(gatingMLImportOptionsFor(s).compensatedChannels).toEqual(["FITC-A", "PE-A", "PerCP-A"]);
    const { res } = evaluate(xml, s);
    expect(gateNames(res)).not.toContain("PerCP as stored");
    expect(res.warnings).toContainEqual(
      expect.stringMatching(/^"PerCP as stored" declares uncompensated values on PerCP-A, which the file's other gates compensate/),
    );
  });

  it("does the same through a FlowJo workspace, whose unprefixed parameter is uncompensated", () => {
    const gate = (name: string, x: string, y: string) => `
        <Population name="${name}" count="10"><Gate><gating:RectangleGate>
          <gating:dimension gating:min="1000" gating:max="3500"><data-type:fcs-dimension data-type:name="${x}"/></gating:dimension>
          <gating:dimension gating:min="15" gating:max="200000"><data-type:fcs-dimension data-type:name="${y}"/></gating:dimension>
        </gating:RectangleGate></Gate></Population>`;
    const coef = (row: string, values: [string, number][]) => `
      <transforms:spillover data-type:parameter="${row}">${values.map(([d, v]) => `<transforms:coefficient data-type:parameter="${d}" transforms:value="${v}"/>`).join("")}</transforms:spillover>`;
    const wsp = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0" xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <SampleList><Sample>
    <transforms:spilloverMatrix spectral="0" prefix="Comp-" suffix="" name="Matrix">
      <data-type:parameters><data-type:parameter data-type:name="FITC-A"/><data-type:parameter data-type:name="PE-A"/><data-type:parameter data-type:name="PerCP-A"/></data-type:parameters>
      ${coef("FITC-A", [["FITC-A", 1], ["PE-A", 0.2], ["PerCP-A", 0]])}
      ${coef("PE-A", [["FITC-A", 0.1], ["PE-A", 1], ["PerCP-A", 0]])}
      ${coef("PerCP-A", [["FITC-A", 0.3], ["PE-A", 0.15], ["PerCP-A", 1]])}
    </transforms:spilloverMatrix>
    <SampleNode name="x.fcs" count="10"><Subpopulations>
      ${gate("Compensated", "Comp-FITC-A", "FSC-A")}
      ${gate("PerCP as stored", "PerCP-A", "FSC-A")}
      ${gate("As stored", "PE-A", "FSC-A")}
    </Subpopulations></SampleNode>
  </Sample></SampleList>
</Workspace>`;
    const conv = flowJoWorkspaceToGatingML(wsp, 0);
    const s = sampleOf("flow", cols);
    const matrix = s.externalSpilloverPreview(conv.spillover!.matrix).display;
    const pnn: Record<string, string> = {};
    for (const c of s.channels) pnn[c.pnn] = c.key;
    const res = importGatingML(conv.gatingMl, s.channels.map((c) => c.key), pnn, "flow", gatingMLImportOptionsFor(s, matrix));
    expect(gateNames(res)).toEqual(["Compensated", "PerCP as stored"]);
    expect(res.warnings).toEqual([
      expect.stringMatching(/^"As stored" declares uncompensated values on PE-A, which the file's other gates compensate/),
    ]);
    s.installExternalSpillover(conv.spillover!.matrix, "Matrix");
    s.setCompensation(true);
    const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, s.gateAssayData());
    const pop = (name: string) => Array.from(masks[Object.values(res.populations).find((p) => p.name === name)!.population_id]);
    const range = cols["FSC-A"].map((_, i) => i);
    expect(pop("PerCP as stored")).toEqual(range.map((i) => (cols["PerCP-A"][i] >= 1000 && cols["PerCP-A"][i] <= 3500 && cols["FSC-A"][i] >= 15 ? 1 : 0)));
    expect(pop("Compensated")).toEqual(range.map((i) => { const f = compensated(i)[0]; return f >= 1000 && f <= 3500 && cols["FSC-A"][i] >= 15 ? 1 : 0; }));
  });
});

describe("a FlowJo workspace gate on a fluorescence parameter without Comp- (open question 33)", () => {
  it("is left out by name when the workspace's matrix compensates that detector", () => {
    // FlowJo evaluates an unprefixed parameter on uncompensated values; the converter says so
    // (compensation-ref "uncompensated"), and the importer compensated it anyway with the rest.
    const gate = (name: string, x: string, y: string) => `
        <Population name="${name}" count="10"><Gate><gating:RectangleGate>
          <gating:dimension gating:min="100" gating:max="200000"><data-type:fcs-dimension data-type:name="${x}"/></gating:dimension>
          <gating:dimension gating:min="100" gating:max="200000"><data-type:fcs-dimension data-type:name="${y}"/></gating:dimension>
        </gating:RectangleGate></Gate></Population>`;
    const wsp = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0" xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <SampleList><Sample>
    <transforms:spilloverMatrix spectral="0" prefix="Comp-" suffix="" name="Matrix">
      <data-type:parameters><data-type:parameter data-type:name="BV786-A"/><data-type:parameter data-type:name="APC-A"/></data-type:parameters>
      <transforms:spillover data-type:parameter="BV786-A">
        <transforms:coefficient data-type:parameter="BV786-A" transforms:value="1"/><transforms:coefficient data-type:parameter="APC-A" transforms:value="0.25"/>
      </transforms:spillover>
      <transforms:spillover data-type:parameter="APC-A">
        <transforms:coefficient data-type:parameter="BV786-A" transforms:value="0.05"/><transforms:coefficient data-type:parameter="APC-A" transforms:value="1"/>
      </transforms:spillover>
    </transforms:spilloverMatrix>
    <SampleNode name="x.fcs" count="10"><Subpopulations>
      ${gate("Compensated", "Comp-BV786-A", "Comp-APC-A")}
      ${gate("As stored", "BV786-A", "APC-A")}
      ${gate("Scatter", "FSC-A", "SSC-A")}
    </Subpopulations></SampleNode>
  </Sample></SampleList>
</Workspace>`;
    const conv = flowJoWorkspaceToGatingML(wsp, 0);
    const s = sampleOf("flow", { "FSC-A": [1000, 2000], "SSC-A": [1000, 2000], "BV786-A": [500, 5000], "APC-A": [500, 5000] });
    const matrix = s.externalSpilloverPreview(conv.spillover!.matrix).display;
    const pnn: Record<string, string> = {};
    for (const c of s.channels) pnn[c.pnn] = c.key;
    const res = importGatingML(conv.gatingMl, s.channels.map((c) => c.key), pnn, "flow", gatingMLImportOptionsFor(s, matrix));
    expect(gateNames(res)).toEqual(["Compensated", "Scatter"]);
    expect(res.warnings).toEqual([
      expect.stringMatching(/^"As stored" declares uncompensated values on BV786-A, APC-A, which the file's other gates compensate/),
    ]);
  });

  it("keeps a gate on a detector the workspace's matrix leaves out, where the FCS file's own matrix covers it (verifier, FR-FCM-Z2TQ)", () => {
    // The import installs the workspace's matrix in place of the FCS file's, so a detector only the
    // FCS matrix covers is left uncompensated, as FlowJo drew "Mixed" on it. Taking the two
    // matrices' detectors together left out a gate GateLab evaluates exactly: on the public
    // FR-FCM-Z2TQ deposit, "Macrophages" (Comp-BV711-A x AmCyan-A) and 6 more of its 16 populations.
    const gate = (name: string, x: string, y: string) => `
        <Population name="${name}" count="10"><Gate><gating:RectangleGate>
          <gating:dimension gating:min="100" gating:max="200000"><data-type:fcs-dimension data-type:name="${x}"/></gating:dimension>
          <gating:dimension gating:min="100" gating:max="200000"><data-type:fcs-dimension data-type:name="${y}"/></gating:dimension>
        </gating:RectangleGate></Gate></Population>`;
    const wsp = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0" xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <SampleList><Sample>
    <transforms:spilloverMatrix spectral="0" prefix="Comp-" suffix="" name="Matrix">
      <data-type:parameters><data-type:parameter data-type:name="BV786-A"/><data-type:parameter data-type:name="APC-A"/></data-type:parameters>
      <transforms:spillover data-type:parameter="BV786-A">
        <transforms:coefficient data-type:parameter="BV786-A" transforms:value="1"/><transforms:coefficient data-type:parameter="APC-A" transforms:value="0.25"/>
      </transforms:spillover>
      <transforms:spillover data-type:parameter="APC-A">
        <transforms:coefficient data-type:parameter="BV786-A" transforms:value="0.05"/><transforms:coefficient data-type:parameter="APC-A" transforms:value="1"/>
      </transforms:spillover>
    </transforms:spilloverMatrix>
    <SampleNode name="x.fcs" count="10"><Subpopulations>
      ${gate("Compensated", "Comp-BV786-A", "Comp-APC-A")}
      ${gate("Mixed", "Comp-BV786-A", "AmCyan-A")}
      ${gate("As stored", "BV786-A", "APC-A")}
      ${gate("Scatter", "FSC-A", "SSC-A")}
    </Subpopulations></SampleNode>
  </Sample></SampleList>
</Workspace>`;
    const conv = flowJoWorkspaceToGatingML(wsp, 0);
    const cols = {
      "FSC-A": [1000, 1000, 1000, 1000, 1000],
      "SSC-A": [1000, 1000, 1000, 1000, 1000],
      "BV786-A": [500, 250, 300, 5000, 500],
      "APC-A": [500, 4000, 4000, 100, 500],
      "AmCyan-A": [150, 150, 150, 150, 50],
    };
    // The FCS file's own matrix, over one detector more, and not the workspace's.
    const fcsSpill = {
      channels: ["BV786-A", "APC-A", "AmCyan-A"],
      matrix: [[1, 0.2, 0.3], [0.04, 1, 0], [0.5, 0, 1]],
    };
    const s = sampleOf("flow", cols, { spillover: fcsSpill });
    const pnn: Record<string, string> = {};
    for (const c of s.channels) pnn[c.pnn] = c.key;
    const matrix = s.externalSpilloverPreview(conv.spillover!.matrix).display;
    const res = importGatingML(conv.gatingMl, s.channels.map((c) => c.key), pnn, "flow", gatingMLImportOptionsFor(s, matrix));
    expect(gateNames(res)).toEqual(["Compensated", "Mixed", "Scatter"]);
    expect(res.warnings).toEqual([
      expect.stringMatching(/^"As stored" declares uncompensated values on BV786-A, APC-A, which the file's other gates compensate/),
    ]);
    // Evaluated as the import applies it: the workspace's matrix installed, compensation on.
    s.installExternalSpillover(conv.spillover!.matrix, "Matrix", { replaceEmbedded: true });
    s.setCompensation(true);
    const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, s.gateAssayData());
    const mixed = Object.values(res.populations).find((p) => p.name === "Mixed")!;
    // Comp-BV786-A from the workspace's 2 x 2 matrix; AmCyan-A as stored.
    const [a, b] = [0.25, 0.05];
    const expected = cols["BV786-A"].map((bv, i) => {
      const comp = (bv - b * cols["APC-A"][i]) / (1 - a * b);
      const amcyan = cols["AmCyan-A"][i];
      return comp >= 100 && comp <= 200000 && amcyan >= 100 && amcyan <= 200000 ? 1 : 0;
    });
    expect(expected).toEqual([1, 0, 1, 1, 0]);
    expect(Array.from(masks[mixed.population_id])).toEqual(expected);
    // Keeping the FCS file's own matrix instead compensates AmCyan-A, which "Mixed" says it did
    // not: then it is left out, by name.
    const own = importGatingML(conv.gatingMl, s.channels.map((c) => c.key), pnn, "flow", gatingMLImportOptionsFor(sampleOf("flow", cols, { spillover: fcsSpill })));
    expect(gateNames(own)).toEqual(["Compensated", "Scatter"]);
    expect(own.warnings).toContainEqual(
      expect.stringMatching(/^"Mixed" declares uncompensated values on AmCyan-A, which the file's other gates compensate/),
    );
  });
});

describe("a transformation's boundMin and boundMax (confirmed 5)", () => {
  it("holds a flog value at boundMax before the gate is tested", () => {
    // ISAC ScaleRange6Bound: flog T=10000 M=5 with boundMax 0.5 over [0.37, 0.63]. A value above
    // 0.5 is taken as 0.5 and is inside; ignoring the bound left it out.
    const [T, M] = [10000, 5];
    const ys = [0.2, 0.36, 0.4, 0.55, 0.62, 0.7, 0.95];
    const xs = ys.map((y) => T * Math.pow(10, (y - 1) * M));
    const s = sampleOf("flow", { "FL1-H": xs });
    const xml = gml(`
      <transforms:transformation transforms:id="Tr" transforms:boundMax="0.5"><transforms:flog transforms:T="${T}" transforms:M="${M}"/></transforms:transformation>
      <gating:RectangleGate gating:id="R" gating:name="R">
        <gating:dimension gating:min="0.37" gating:max="0.63" gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="FL1-H"/></gating:dimension>
      </gating:RectangleGate>`);
    const clamped = ys.map((y) => Math.min(y, 0.5));
    expect(evaluate(xml, s).byName("R")).toEqual(clamped.map((y) => (y >= 0.37 && y <= 0.63 ? 1 : 0)));
    expect(evaluate(xml, sampleOf("flow", { "FL1-H": xs })).byName("R")).toEqual([0, 0, 1, 1, 1, 1, 1]);
  });

  it("holds a fasinh and a flin value at boundMin", () => {
    const xs = [-500, -10, 0, 40, 200, 600, 5000];
    const s = sampleOf("flow", { "PE-A": xs, "FITC-A": xs });
    const xml = gml(`
      <transforms:transformation transforms:id="As" transforms:boundMin="0.3"><transforms:fasinh transforms:T="262144" transforms:M="4.5" transforms:A="0"/></transforms:transformation>
      <transforms:transformation transforms:id="Li" transforms:boundMin="0.05" transforms:boundMax="0.4"><transforms:flin transforms:T="1000" transforms:A="0"/></transforms:transformation>
      <gating:RectangleGate gating:id="A" gating:name="A">
        <gating:dimension gating:min="0.25" gating:max="0.45" gating:transformation-ref="As"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
      </gating:RectangleGate>
      <gating:RectangleGate gating:id="L" gating:name="L">
        <gating:dimension gating:min="0.3" gating:max="0.9" gating:transformation-ref="Li"><data-type:fcs-dimension data-type:name="FITC-A"/></gating:dimension>
      </gating:RectangleGate>`);
    const { byName } = evaluate(xml, s);
    const a = xs.map((x) => Math.max(fasinh(x, 262144, 4.5, 0), 0.3));
    expect(byName("A")).toEqual(a.map((y) => (y >= 0.25 && y <= 0.45 ? 1 : 0)));
    const l = xs.map((x) => Math.min(Math.max(x / 1000, 0.05), 0.4));
    expect(byName("L")).toEqual(l.map((y) => (y >= 0.3 && y <= 0.9 ? 1 : 0)));
  });

  it("writes the bounds back on export, and reads its own file the same", () => {
    const xs = [0.5, 3, 30, 300, 3000, 30000];
    const s = sampleOf("flow", { "FL1-H": xs });
    const xml = gml(`
      <transforms:transformation transforms:id="Tr" transforms:boundMax="0.5"><transforms:flog transforms:T="10000" transforms:M="5"/></transforms:transformation>
      <gating:RectangleGate gating:id="R" gating:name="R">
        <gating:dimension gating:min="0.37" gating:max="0.63" gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="FL1-H"/></gating:dimension>
      </gating:RectangleGate>`);
    const first = evaluate(xml, s);
    const out = exportGatingML({
      gates: first.res.gates, gate_order: first.res.gate_order, populations: first.res.populations,
      root_population_id: first.res.root_population_id, sample: s, format: "standard", timestamp: "2026-01-01T00:00:00",
    });
    expect(out).toMatch(/<transforms:transformation transforms:id="[^"]+" transforms:boundMax="0\.5">\s*<transforms:flog /);
    expect(evaluate(out, sampleOf("flow", { "FL1-H": xs })).byName("R")).toEqual(first.byName("R"));
    expect(() => exportGatingML({
      gates: first.res.gates, gate_order: first.res.gate_order, populations: first.res.populations,
      root_population_id: first.res.root_population_id, sample: s, format: "cytobank", timestamp: "2026-01-01T00:00:00",
    })).toThrow(/bounds FL1-H .* Cytobank-compatible format cannot carry/);
  });

  // GateLab's own record of a rectangle (rectangleRecord.ts, fix/gate-edge-semantics) restores the
  // gate's transforms from the file; read without `bounds` and `standard`, it gave the gate back a
  // flog with the pinned floor and no bound, and the events the bound held fell out of it.
  it("keeps a transformation's bounds and Gating-ML's own flog when GateLab's record restores the rectangle", () => {
    const xs = [0.5, 3, 30, 300, 3000, 30000];
    const s = sampleOf("flow", { "FL1-H": xs, "FL2-H": xs });
    const xml = gml(`
      <transforms:transformation transforms:id="Tr" transforms:boundMax="0.5"><transforms:flog transforms:T="10000" transforms:M="5"/></transforms:transformation>
      <transforms:transformation transforms:id="Lo" transforms:boundMin="0.2"><transforms:flog transforms:T="10000" transforms:M="5"/></transforms:transformation>
      <gating:RectangleGate gating:id="R" gating:name="R">
        <gating:dimension gating:min="0.37" gating:max="0.63" gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="FL1-H"/></gating:dimension>
        <gating:dimension gating:min="0.1" gating:max="0.9" gating:transformation-ref="Lo"><data-type:fcs-dimension data-type:name="FL2-H"/></gating:dimension>
      </gating:RectangleGate>`);
    const first = evaluate(xml, s);
    const out = exportGatingML({
      gates: first.res.gates, gate_order: first.res.gate_order, populations: first.res.populations,
      root_population_id: first.res.root_population_id, sample: s, format: "standard", timestamp: "2026-01-01T00:00:00",
    });
    expect(out).toContain("gatelab_rectangles");
    const back = evaluate(out, sampleOf("flow", { "FL1-H": xs, "FL2-H": xs }));
    const before = Object.values(first.res.gates)[0];
    const after = Object.values(back.res.gates)[0];
    expect(after.transforms).toEqual(before.transforms);
    expect(after.transforms?.["FL1-H"]).toMatchObject({ kind: "flog", standard: true, bounds: { max: 0.5 } });
    expect(back.byName("R")).toEqual(first.byName("R"));
  });
});

describe("a ratio dimension (confirmed 6, 27)", () => {
  it("leaves a rectangle with a new-dimension out by name instead of reading it as a range", () => {
    const s = sampleOf("flow", { "FL1-H": [100, 500, 2000], "FL2-H": [1, 2, 3], "FL2-A": [1, 1, 1] });
    const xml = gml(`
      <transforms:transformation transforms:id="Rat"><transforms:fratio transforms:A="1" transforms:B="0" transforms:C="0">
        <data-type:fcs-dimension data-type:name="FL2-H"/><data-type:fcs-dimension data-type:name="FL2-A"/></transforms:fratio></transforms:transformation>
      <gating:RectangleGate gating:id="R" gating:name="Ratio and FL1">
        <gating:dimension gating:min="100" gating:max="1000"><data-type:fcs-dimension data-type:name="FL1-H"/></gating:dimension>
        <gating:dimension gating:min="1.5" gating:max="2.5"><data-type:new-dimension data-type:transformation-ref="Rat"/></gating:dimension>
      </gating:RectangleGate>
      <gating:RectangleGate gating:id="K" gating:name="Kept">
        <gating:dimension gating:min="100"><data-type:fcs-dimension data-type:name="FL1-H"/></gating:dimension>
      </gating:RectangleGate>
      <gating:RectangleGate gating:id="C" gating:name="Child" gating:parent_id="R">
        <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="FL1-H"/></gating:dimension>
      </gating:RectangleGate>`);
    const { res } = evaluate(xml, s);
    expect(gateNames(res)).not.toContain("Ratio and FL1");
    expect(res.warnings).toEqual([
      '"Ratio and FL1" has the ratio dimension Rat, which GateLab cannot hold; it and anything below it were skipped.',
    ]);
    expect(Object.values(res.populations).map((p) => p.name).sort()).toEqual(["All Events", "Kept"].sort());
  });
});

describe("flog as Gating-ML defines it (confirmed 8, 23)", () => {
  const xs = [-100, 0, 1, 5, 100, 1000];
  const file = (header = "") => gml(`${header}
    <transforms:transformation transforms:id="Tr"><transforms:flog transforms:T="262144" transforms:M="4.5"/></transforms:transformation>
    <gating:RectangleGate gating:id="R" gating:name="R">
      <gating:dimension gating:min="-0.5" gating:max="0.3" gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
    </gating:RectangleGate>`);

  it("puts an event at or below zero in no gate, and pins nothing below the floor, in another tool's file", () => {
    const expected = xs.map((x) => {
      const y = flog(x, 262144, 4.5);
      return y >= -0.5 && y <= 0.3 ? 1 : 0;
    });
    expect(expected).toEqual([0, 0, 1, 1, 1, 0]);
    expect(evaluate(file(), sampleOf("flow", { "PE-A": xs })).byName("R")).toEqual(expected);
  });

  it("keeps GateLab's own older floor for a file GateLab wrote before its mark said otherwise", () => {
    const older = `<data-type:custom_info><cytobank><about>Gating-ML 2.0 export from GateLab (standard / re-importable)</about></cytobank></data-type:custom_info>`;
    expect(evaluate(file(older), sampleOf("flow", { "PE-A": xs })).byName("R")).toEqual([1, 1, 1, 1, 1, 0]);
  });

  // flog is -Infinity at 0. A dimension with no min has no lower bound, so an event at 0 lies
  // inside it, as FlowKit reads such a file; below 0, flog has no value and the event is in no
  // gate. The absent bound is held as -UNBOUNDED (the largest double), which -Infinity is below:
  // the interop sweep found FlowKit's rectangle on FL3-A holding 3 events at 0 that GateLab left
  // out (random-0016, reverse Gating-ML).
  it("holds an event at zero where the dimension has no lower bound", () => {
    const open = gml(`
    <transforms:transformation transforms:id="Tr"><transforms:flog transforms:T="262144" transforms:M="4.5"/></transforms:transformation>
    <gating:RectangleGate gating:id="R" gating:name="R">
      <gating:dimension gating:max="0.3" gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
    </gating:RectangleGate>`);
    expect(evaluate(open, sampleOf("flow", { "PE-A": [-100, -0, 0, 1, 5, 100, 1000] })).byName("R")).toEqual([0, 1, 1, 1, 1, 1, 0]);
  });

  it("writes an older-floor flog polygon with vertices below the floor, and reads it back with the same events", () => {
    // GateLab's older flog pins every value below T·10^−M at y = 0. Written in raw space, the part
    // of such a polygon below y = 0 was measured back through that pin, never came within
    // tolerance, and was split to 2^14 points an edge: the export overflowed the stack.
    const older = `<data-type:custom_info><cytobank><about>Gating-ML 2.0 export from GateLab (standard / re-importable)</about></cytobank></data-type:custom_info>`;
    const [T, M] = [262144, 4.5];
    const floor = T * Math.pow(10, -M);
    const pinned = (x: number) => Math.log10(Math.max(x, floor) / T) / M + 1;
    const values = [-50, 0, 1, 5, 8, 20, 100, 1000, 10000, 100000];
    const grid: [number, number][] = [];
    for (const u of values) for (const v of values) grid.push([u, v]);
    const tri: [number, number][] = [[-0.2, -0.2], [0.6, -0.1], [0.5, 0.6], [-0.1, 0.5]];
    const inPoly = ([x, y]: [number, number]) => {
      let inside = false;
      for (let i = 0, j = tri.length - 1; i < tri.length; j = i++) {
        const [xi, yi] = tri[i];
        const [xj, yj] = tri[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside ? 1 : 0;
    };
    const cols = { "PE-A": grid.map(([u]) => u), "APC-A": grid.map(([, v]) => v) };
    const dim = (ch: string) => `<gating:dimension gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="${ch}"/></gating:dimension>`;
    const xml = gml(`${older}
      <transforms:transformation transforms:id="Tr"><transforms:flog transforms:T="${T}" transforms:M="${M}"/></transforms:transformation>
      <gating:PolygonGate gating:id="P" gating:name="P">${dim("PE-A")}${dim("APC-A")}
        ${tri.map(([x, y]) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`).join("")}
      </gating:PolygonGate>`);
    const expected = grid.map(([u, v]) => inPoly([pinned(u), pinned(v)]));
    // Every value at or below the floor is pinned inside the polygon.
    expect(expected.filter(Boolean).length).toBeGreaterThan(20);
    const s = sampleOf("flow", cols);
    const first = evaluate(xml, s);
    expect(first.byName("P")).toEqual(expected);
    for (const format of ["standard", "cytobank"] as const) {
      const out = exportGatingML({
        gates: first.res.gates, gate_order: first.res.gate_order, populations: first.res.populations,
        root_population_id: first.res.root_population_id, sample: s, format, timestamp: "2026-01-01T00:00:00",
      });
      expect(out.match(/<gating:vertex>/g)!.length, format).toBeLessThan(200);
      expect(evaluate(out, sampleOf("flow", cols)).byName("P"), format).toEqual(expected);
    }
    // A polygon wholly below the floor holds for GateLab only what it places on the floor where the
    // polygon comes nearest, and this one reaches no event there. #345's clipToClamps refused it by
    // name until 8d2f25b, and now writes it as that point, which holds what GateLab holds: nothing.
    const below = evaluate(xml.replace(/-0\.1"\/><gating:coordinate data-type:value="0\.5"/, '-0.1"/><gating:coordinate data-type:value="-0.05"')
      .replace(/"0\.5"\/><gating:coordinate data-type:value="0\.6"/, '"0.5"/><gating:coordinate data-type:value="-0.05"'), sampleOf("flow", cols));
    expect(Object.values(below.res.gates)[0].gate_type).toBe("polygon");
    expect(below.byName("P").every((v) => v === 0)).toBe(true);
    for (const format of ["standard", "cytobank"] as const) {
      const out = exportGatingML({
        gates: below.res.gates, gate_order: below.res.gate_order, populations: below.res.populations,
        root_population_id: below.res.root_population_id, sample: s, format, timestamp: "2026-01-01T00:00:00",
      });
      expect(evaluate(out, sampleOf("flow", cols)).byName("P"), format).toEqual(below.byName("P"));
    }
    // A U whose two arms pass below the floor meets the floor in two stretches; cut there, the gap
    // between them would join the gate along the floor. Named.
    const u: [number, number][] = [[0, 0.8], [0, -0.2], [0.6, -0.2], [0.6, 0.8], [0.4, 0.8], [0.4, -0.1], [0.2, -0.1], [0.2, 0.8]];
    const uXml = gml(`${older}
      <transforms:transformation transforms:id="Tr"><transforms:flog transforms:T="${T}" transforms:M="${M}"/></transforms:transformation>
      <gating:PolygonGate gating:id="U" gating:name="U">${dim("PE-A")}${dim("APC-A")}
        ${u.map(([x, y]) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`).join("")}
      </gating:PolygonGate>`);
    const uImport = evaluate(uXml, sampleOf("flow", cols));
    expect(() => exportGatingML({
      gates: uImport.res.gates, gate_order: uImport.res.gate_order, populations: uImport.res.populations,
      root_population_id: uImport.res.root_population_id, sample: s, format: "standard", timestamp: "2026-01-01T00:00:00",
    // In the release candidate #345's clipToClamps refuses it, in its own words.
    })).toThrow(/The gate "U" (passes its axis's floor or ceiling|leaves the end of its axis) more than once/);
  });

  it("holds an event at zero in a range with no lower bound, as FlowKit and flowCore do, and writes that range back unbounded", () => {
    // flog(0) is −Infinity. A bound the file leaves out is not tested (FlowKit 1.3.1, flowCore
    // 2.16.0), so the event at zero is in the range and the one below zero, NaN, is not. GateLab
    // held the missing bound as −UNBOUNDED, a finite number above −Infinity, and left every zero
    // out: 17,200 events where FlowKit counts 37,390 on the public FACSCalibur FL2-A.
    const [T, M] = [262144, 4.5];
    const open = gml(`
      <transforms:transformation transforms:id="Tr"><transforms:flog transforms:T="${T}" transforms:M="${M}"/></transforms:transformation>
      <gating:RectangleGate gating:id="R" gating:name="R">
        <gating:dimension gating:max="0.3" gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
      </gating:RectangleGate>
      <gating:RectangleGate gating:id="Q" gating:name="Q">
        <gating:dimension gating:max="0.3" gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
        <gating:dimension gating:min="2"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
      </gating:RectangleGate>`);
    const cols = { "PE-A": xs, "FSC-A": [1, 3, 3, 1, 3, 3] };
    const inRange = (x: number) => {
      const y = flog(x, T, M);
      return y <= 0.3 ? 1 : 0; // no lower bound: nothing tested below
    };
    const expectedR = xs.map(inRange);
    expect(expectedR).toEqual([0, 1, 1, 1, 1, 0]);
    const expectedQ = xs.map((x, i) => (inRange(x) && cols["FSC-A"][i] >= 2 ? 1 : 0));
    expect(expectedQ).toEqual([0, 1, 1, 0, 1, 0]);
    const s = sampleOf("flow", cols);
    const first = evaluate(open, s);
    expect(first.byName("R")).toEqual(expectedR);
    expect(first.byName("Q")).toEqual(expectedQ);

    // The export leaves the bound out, so another reader holds the zeros as GateLab does.
    const out = exportGatingML({
      gates: first.res.gates, gate_order: first.res.gate_order, populations: first.res.populations,
      root_population_id: first.res.root_population_id, sample: s, format: "standard", timestamp: "2026-01-01T00:00:00",
    });
    const flogDims = [...out.matchAll(/<gating:dimension([^>]*)>\s*<data-type:fcs-dimension data-type:name="PE-A"/g)].map((m) => m[1]);
    expect(flogDims).toHaveLength(2);
    for (const attrs of flogDims) expect(attrs).not.toMatch(/gating:min=/);
    const again = evaluate(out, sampleOf("flow", cols));
    expect(again.byName("R")).toEqual(expectedR);
    expect(again.byName("Q")).toEqual(expectedQ);
  });
});

describe("flin (open question: refused although the standard defines it)", () => {
  it("reads flin as the linear scale it is", () => {
    const xs = [100, 540, 560, 4700, 4800];
    const s = sampleOf("flow", { "FSC-A": xs });
    const xml = gml(`
      <transforms:transformation transforms:id="Li"><transforms:flin transforms:T="10000" transforms:A="500"/></transforms:transformation>
      <gating:RectangleGate gating:id="R" gating:name="R">
        <gating:dimension gating:min="0.1" gating:max="0.5" gating:transformation-ref="Li"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
      </gating:RectangleGate>`);
    const { res, byName } = evaluate(xml, s);
    // (x + A) / (T + A) in [0.1, 0.5] is x in [550, 4750], straight in raw.
    expect(Object.values(res.gates)[0].space).toBe("raw");
    expect(byName("R")).toEqual([0, 0, 1, 1, 0]);
  });

  it("holds an event whose flin value is a range's edge, where converting the edge to raw rounds past it", () => {
    // Single-precision values whose flin coordinate, (x + A) / (T + A), converts back to raw one
    // step off x: 161.37... comes back above itself, 171.37... below. A FlowKit-written edge on
    // such an event's own coordinate lost it on GateLab's closed rectangle.
    const [T, A] = [10000, 500];
    const xs = [160.3699951171875, 161.3699951171875, 166.3699951171875, 171.3699951171875];
    const lin = (x: number) => (x + A) / (T + A);
    const [lo, hi] = [lin(xs[1]), lin(xs[3])];
    expect(lo * (T + A) - A).toBeGreaterThan(xs[1]);
    expect(hi * (T + A) - A).toBeLessThan(xs[3]);
    const xml = gml(`
      <transforms:transformation transforms:id="Li"><transforms:flin transforms:T="${T}" transforms:A="${A}"/></transforms:transformation>
      <gating:RectangleGate gating:id="R" gating:name="R">
        <gating:dimension gating:min="${lo}" gating:max="${hi}" gating:transformation-ref="Li"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
      </gating:RectangleGate>`);
    // Both edges held, as GateLab's rectangle holds them (#344 makes a Gating-ML file's upper edge open).
    const expected = xs.map((x) => (lin(x) >= lo && lin(x) <= hi ? 1 : 0));
    expect(expected).toEqual([0, 1, 1, 1]);
    expect(evaluate(xml, sampleOf("flow", { "FSC-A": xs })).byName("R")).toEqual(expected);
  });
});

// GateLab decides a gate held in a transformed space on each event's value in single precision
// (Sample.pinnedColumn), so an event whose value is a rectangle's edge, as a writer puts it when it
// draws an edge on an event, can land on either side of a double edge. A fasinh other than
// GateLab's own asinh was held on raw values before this branch, where a rectangle's edges are
// exact; held as asinh, a FlowKit-written TimeAsinh range on the public FACSCalibur file lost 75
// events on its lower edge, a Cell_length range with A = 1 on the public Bodenmiller file 118, and
// a bounded Time asinh on the public FACSDiva file 2. A rectangle from another writer on such an
// axis is held on raw values again, its edges placed on the stored values exactly (exactStoredEdge)
// as the file's reader computes the transform. GateLab's own asinh, logicle and flog are held as
// declared, as they always were, and keep their single-precision ties ("Not in this PR").
describe("a rectangle edge on an event's own value, from another writer (verifier: single precision)", () => {
  /** FlowKit's fasinh (flowutils.transforms.asinh), operation for operation. */
  const fkFasinh = (T: number, M: number, A: number) => {
    const preScale = Math.sinh(M * LN10) / T;
    const transpose = A * LN10;
    const divisor = (M + A) * LN10;
    return (x: number) => (Math.asinh(x * preScale) + transpose) / divisor;
  };
  // Stored values as a float32 FCS holds them, each the edge of one range below.
  const xs = [11.4, 17.9, 27, 28, 101.3, 250.7, 1234.5, 5000.25, 8.2, 64.6, 333.3, 777.7, 2.3, 45.1, 99.9, 12.5]
    .map(Math.fround);
  const lows = (tr: string, f: (x: number) => number, channel = "FITC-A") => xs.map((x, i) => `
    <gating:RectangleGate gating:id="R${i}" gating:name="R${i}">
      <gating:dimension gating:min="${f(x)}" gating:transformation-ref="${tr}"><data-type:fcs-dimension data-type:name="${channel}"/></gating:dimension>
    </gating:RectangleGate>`).join("");
  const highs = (tr: string, f: (x: number) => number, channel = "FITC-A") => xs.map((x, i) => `
    <gating:RectangleGate gating:id="H${i}" gating:name="H${i}">
      <gating:dimension gating:max="${f(x)}" gating:transformation-ref="${tr}"><data-type:fcs-dimension data-type:name="${channel}"/></gating:dimension>
    </gating:RectangleGate>`).join("");
  /** Each range's events as the file's reader decides them in double precision; GateLab's upper edge is closed. */
  const expectedLow = (f: (x: number) => number, vals: number[], i: number) => vals.map((v) => (f(v) >= f(xs[i]) ? 1 : 0));
  const expectedHigh = (f: (x: number) => number, vals: number[], i: number) => vals.map((v) => (f(v) <= f(xs[i]) ? 1 : 0));

  for (const [T, M, A] of [[262144, 4.5, 0], [262144, 4.2, 0.5], [10000, 4, 1]] as const) {
    it(`holds every event on a fasinh range's edge (T=${T}, M=${M}, A=${A})`, () => {
      const f = fkFasinh(T, M, A);
      const s = sampleOf("flow", { "FITC-A": xs });
      const xml = gml(`<transforms:transformation transforms:id="Tr"><transforms:fasinh transforms:T="${T}" transforms:M="${M}" transforms:A="${A}"/></transforms:transformation>
        ${lows("Tr", f)}${highs("Tr", f)}`);
      const { res, byName } = evaluate(xml, s);
      xs.forEach((_, i) => {
        expect(byName(`R${i}`), `R${i}`).toEqual(expectedLow(f, xs, i));
        expect(byName(`H${i}`), `H${i}`).toEqual(expectedHigh(f, xs, i));
      });
      // Held on raw values, the lower edge at the event, above the float32 value below it.
      const r0 = Object.values(res.gates).find((g) => g.name === "R0") as Extract<Gate, { vertices: unknown }>;
      expect(r0.space).toBe("raw");
      const lo = Math.min(...r0.vertices.map((v) => v[0]));
      const below = new Float32Array([xs[0]]);
      new Int32Array(below.buffer)[0] -= 1;
      expect(lo).toBeLessThanOrEqual(xs[0]);
      expect(lo).toBeGreaterThan(below[0]);
    });
  }

  it("holds an event on an edge FlowKit wrote, where V8's asinh and the C library's differ in the last place", () => {
    // Each edge is FlowKit's own fasinh of an event (NumPy's arcsinh, the C library's), which V8's
    // Math.asinh puts one or two units in the last place to the other side of it. GateLab's rule is
    // closed, so each event is inside its own range, on either edge.
    const onLow: [number, string][] = [[17.809999465942383, "0.09003357749866803"], [34.25, "0.14212872541556765"], [183.5800018310547, "0.29914851151436606"]];
    const onHigh: [number, string][] = [[41.099998474121094, "0.15821769448583303"], [47.95000076293945, "0.17215177259167805"], [83.56999969482422, "0.22393823351583655"]];
    const f = fkFasinh(262144, 4.5, 0);
    for (const [x, v] of onLow) expect(f(x)).toBeLessThan(Number(v));
    for (const [x, v] of onHigh) expect(f(x)).toBeGreaterThan(Number(v));
    const vals = [...onLow, ...onHigh].map(([x]) => x).flatMap((x) => [Math.fround(x * 0.999), x, Math.fround(x * 1.001)]);
    const range = (id: string, attr: "min" | "max", v: string) => `<gating:RectangleGate gating:id="${id}" gating:name="${id}">
      <gating:dimension gating:${attr}="${v}" gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="FITC-A"/></gating:dimension>
    </gating:RectangleGate>`;
    const { byName } = evaluate(gml(`<transforms:transformation transforms:id="Tr"><transforms:fasinh transforms:T="262144" transforms:M="4.5" transforms:A="0"/></transforms:transformation>
      ${onLow.map(([, v], i) => range(`L${i}`, "min", v)).join("")}${onHigh.map(([, v], i) => range(`H${i}`, "max", v)).join("")}`), sampleOf("flow", { "FITC-A": vals }));
    onLow.forEach(([x], i) => expect(byName(`L${i}`), `L${i}`).toEqual(vals.map((u) => (u >= x ? 1 : 0))));
    onHigh.forEach(([x], i) => expect(byName(`H${i}`), `H${i}`).toEqual(vals.map((u) => (u <= x ? 1 : 0))));
  });

  it("holds every event on the edge of a fasinh Time range in seconds, and of a bounded one", () => {
    const ticks = xs.map((x) => Math.fround(x * 7));
    const s = () => sampleOf("flow", { Time: ticks, "FSC-A": ticks }, { keywords: { $TIMESTEP: "0.01" } });
    const f = fkFasinh(1000, 3, 0);
    const seconds = (t: number) => t * 0.01;
    const file = (bounds: string) => gml(`<transforms:transformation transforms:id="Tr"${bounds}><transforms:fasinh transforms:T="1000" transforms:M="3" transforms:A="0"/></transforms:transformation>
      ${ticks.map((t, i) => `<gating:RectangleGate gating:id="R${i}" gating:name="R${i}">
        <gating:dimension gating:min="${f(seconds(t))}" gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="Time"/></gating:dimension>
      </gating:RectangleGate>`).join("")}`);
    const plain = evaluate(file(""), s());
    ticks.forEach((t, i) => expect(plain.byName(`R${i}`), `R${i}`).toEqual(ticks.map((u) => (f(seconds(u)) >= f(seconds(t)) ? 1 : 0))));
    // Held at a boundMax the file's reader reaches first: an edge above it holds nothing, one at it
    // the events at or beyond it.
    const top = f(seconds(ticks[5]));
    const bounded = evaluate(file(` transforms:boundMax="${top}"`), s());
    const fb = (t: number) => Math.min(f(seconds(t)), top);
    ticks.forEach((t, i) => expect(bounded.byName(`R${i}`), `bounded R${i}`).toEqual(ticks.map((u) => (fb(u) >= f(seconds(t)) ? 1 : 0))));
    expect(bounded.byName("R5")).toEqual(ticks.map((u) => (u >= ticks[5] ? 1 : 0)));
    expect(bounded.byName("R6")).toEqual(ticks.map(() => 0));
  });

  it("holds every event on a CyTOF fasinh range's edge", () => {
    const f = fkFasinh(10000, 4, 1);
    const s = sampleOf("cytof", { Cell_length: xs, "Ir191Di": xs });
    const { byName } = evaluate(gml(`<transforms:transformation transforms:id="Tr"><transforms:fasinh transforms:T="10000" transforms:M="4" transforms:A="1"/></transforms:transformation>
      ${lows("Tr", f, "Cell_length")}`), s);
    xs.forEach((_, i) => expect(byName(`R${i}`), `R${i}`).toEqual(expectedLow(f, xs, i)));
  });

  it("keeps GateLab's own arcsinh rectangle in its own space, as the file declares it", () => {
    // GateLab's asinh is held as declared, as it was before; its exporter places each bound for
    // GateLab's own reading.
    const s = sampleOf("flow", { "FITC-A": xs, "PE-A": xs });
    const gate: Gate = {
      gate_id: "g", name: "g", gate_type: "rectangle", x_channel: "FITC-A", y_channel: "PE-A",
      vertices: [[Math.asinh(27 / 150), -UNBOUNDED], [UNBOUNDED, -UNBOUNDED], [UNBOUNDED, UNBOUNDED], [Math.asinh(27 / 150), UNBOUNDED]],
      space: "display", transforms: { "FITC-A": { kind: "asinh", cofactor: 150 }, "PE-A": { kind: "asinh", cofactor: 150 } },
      color: "#000", label_offset: null,
    };
    const root = newRootPopulation();
    const pop = newPopulation("g", [newGateRef("g", true)], root.population_id);
    const populations = linkChildToParent({ [root.population_id]: root, [pop.population_id]: pop }, pop.population_id, root.population_id);
    for (const format of ["standard", "cytobank"] as const) {
      const out = exportGatingML({ gates: { g: gate }, gate_order: ["g"], populations, root_population_id: root.population_id, sample: s, format, timestamp: "2026-01-01T00:00:00" });
      const back = evaluate(out, sampleOf("flow", { "FITC-A": xs, "PE-A": xs }));
      const g = Object.values(back.res.gates)[0];
      expect(g.space, format).toBe("display");
      expect(g.transforms?.["FITC-A"], format).toEqual({ kind: "asinh", cofactor: 150 });
    }
  });
});

// The exporter writes GateLab's asinh(x / c) as fasinh(T = c sinh 1, M = log10 e, A = 0) and moves a
// rectangle's bound, within rounding, so that the file's own events are decided as GateLab decides
// them (tieBreak). It modelled the reader's value as asinh(x / c), where FlowKit computes
// asinh(x · (sinh(M ln10) / T)) / (M ln10), one unit in the last place lower for some x: an event
// GateLab holds on the edge then fell outside for FlowKit (the verifier's FlowKit-written M = 4.2,
// A = 0.5 range on the public LSR-II file, re-exported: 46 events of "RectChild", 57 of them at
// raw 11.4 on the edge).
describe("an exported asinh bound, for a reader that computes fasinh as the standard writes it (verifier)", () => {
  it("is placed where FlowKit's fasinh decides every event of the file as GateLab does", () => {
    const c = 262144 / Math.sinh(4.2 * LN10);
    // 2.59, 4.07 and 5.18 are events whose fasinh FlowKit computes one unit below asinh(x / c).
    const xs = [2.58, 2.59, 2.6, 4.06, 4.07, 4.08, 5.17, 5.18, 5.19].map(Math.fround);
    const s = sampleOf("flow", { "FITC-A": xs, "PE-A": xs });
    for (const edgeAt of [2.59, 4.07, 5.18].map(Math.fround)) {
      const lo = Math.fround(Math.asinh(edgeAt / c)); // on the event, as a drawn edge lands on it
      const gate: Gate = {
        gate_id: "g", name: "g", gate_type: "rectangle", x_channel: "FITC-A", y_channel: "PE-A",
        vertices: [[lo, -UNBOUNDED], [UNBOUNDED, -UNBOUNDED], [UNBOUNDED, UNBOUNDED], [lo, UNBOUNDED]],
        space: "display", transforms: { "FITC-A": { kind: "asinh", cofactor: c }, "PE-A": { kind: "asinh", cofactor: c } },
        color: "#000", label_offset: null,
      };
      const root = newRootPopulation();
      const pop = newPopulation("g", [newGateRef("g", true)], root.population_id);
      const populations = linkChildToParent({ [root.population_id]: root, [pop.population_id]: pop }, pop.population_id, root.population_id);
      // GateLab's own decision: on the value in single precision.
      const own = xs.map((x) => (Math.fround(Math.asinh(x / c)) >= lo ? 1 : 0));
      expect(own[xs.indexOf(edgeAt)]).toBe(1);
      const out = exportGatingML({ gates: { g: gate }, gate_order: ["g"], populations, root_population_id: root.population_id, sample: s, format: "standard", timestamp: "2026-01-01T00:00:00" });
      const tr = /<transforms:fasinh transforms:T="([^"]+)" transforms:M="([^"]+)" transforms:A="([^"]+)"/.exec(out)!;
      const [T, M, A] = [Number(tr[1]), Number(tr[2]), Number(tr[3])];
      const min = Number(/gating:min="([^"]+)"[^>]*>\s*<data-type:fcs-dimension data-type:name="FITC-A"/.exec(out)![1]);
      // FlowKit's reading (flowutils.transforms.asinh), operation for operation.
      const preScale = Math.sinh(M * LN10) / T;
      const reader = xs.map((x) => ((Math.asinh(x * preScale) + A * LN10) / ((M + A) * LN10) >= min ? 1 : 0));
      expect(reader, `edge at ${edgeAt}`).toEqual(own);
      // GateLab reads its own file back the same.
      expect(evaluate(out, sampleOf("flow", { "FITC-A": xs, "PE-A": xs })).byName("g"), `edge at ${edgeAt}`).toEqual(own);
    }
  });
});

describe("compensation-ref FCS on a file with no matrix (tester D15)", () => {
  it("evaluates uncompensated, as the ISAC suite does, and says so", () => {
    expect(resolveGatingMLCompensation(null, ["FCS"], true, null, { fcsHasSpillover: false })).toMatchObject({
      target: false, source: "dimensions", requiresConfirmation: false,
      note: expect.stringMatching(/carries no spillover matrix .* evaluated on uncompensated values/),
    });
    // Knowing nothing about the file, the refusal stands.
    expect(() => resolveGatingMLCompensation(null, ["FCS"], true, null)).toThrow(/no usable spillover matrix/);
    const s = sampleOf("flow", { "PE-A": [10, 2000, 5000] });
    const xml = gml(`<gating:RectangleGate gating:id="R" gating:name="R">
      <gating:dimension gating:min="1000" gating:compensation-ref="FCS"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
    </gating:RectangleGate>`);
    const { comp, byName } = evaluate(xml, s);
    expect(comp.target).toBe(false);
    expect(byName("R")).toEqual([0, 1, 1]);
  });

  it("refuses a file whose $SPILLOVER cannot be read, rather than take it for none (verifier)", () => {
    // The FCS reader returns no matrix for an absent, an identity and an unreadable $SPILLOVER
    // alike. Only the first two declare no compensation; "2,FITC-A,PE-A,1,0.2" has three of its four
    // coefficients, and gates asking for the file's compensation were evaluated uncompensated,
    // with a note saying the file carries none.
    const xml = gml(`<gating:RectangleGate gating:id="R" gating:name="R">
      <gating:dimension gating:min="1000" gating:compensation-ref="FCS"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
    </gating:RectangleGate>`);
    const cols = { "FITC-A": [10, 2000, 5000], "PE-A": [10, 2000, 5000] };
    for (const spill of ["2,FITC-A,PE-A,1,0.2", "2,FITC-A,PE-A,1,0,x,1", "3,FITC-A,PE-A,1,0,0,1", "two"]) {
      const s = sampleOf("flow", cols, { keywords: { $SPILLOVER: spill } });
      expect(fcsDeclaresCompensation(s.fcs), spill).toBe(true);
      expect(() => evaluate(xml, s), spill).toThrow(/no usable spillover matrix/);
    }
    // An identity matrix, blank or absent, under any of the three keywords: none, as before.
    const none: Record<string, string>[] = [{ $SPILLOVER: "2,FITC-A,PE-A,1,0,0,1" }, { SPILL: "2, FITC-A, PE-A, 1, 0, 0, 1" }, { $SPILL: " " }, {}];
    for (const keywords of none) {
      const s = sampleOf("flow", cols, { keywords });
      expect(fcsDeclaresCompensation(s.fcs), JSON.stringify(keywords)).toBe(false);
      const { comp, byName } = evaluate(xml, s);
      expect(comp.target).toBe(false);
      expect(comp.note).toMatch(/carries no spillover matrix \(or an identity one\)/);
      expect(byName("R")).toEqual([0, 1, 1]);
    }
    // A matrix the reader did read.
    expect(fcsDeclaresCompensation(sampleOf("flow", cols, { spillover: { channels: ["FITC-A", "PE-A"], matrix: [[1, 0.2], [0, 1]] } }).fcs)).toBe(true);
  });
});

describe("a transform declared on Time, Event_length and the other raw channels (tester D13, investigation B2)", () => {
  it("honours an arcsinh on a CyTOF Event_length gate", () => {
    const s = sampleOf("cytof", { Event_length: [10, 15, 18, 25], Nd142Di: [1, 1, 1, 1] });
    const cf = 5;
    const xml = gml(`
      <transforms:transformation transforms:id="Tr_Arcsinh_5"><transforms:fasinh transforms:T="${cf * Math.sinh(1)}" transforms:M="${Math.log10(Math.E)}" transforms:A="0"/></transforms:transformation>
      <gating:RectangleGate gating:id="R" gating:name="Singlets">
        <gating:dimension gating:min="${Math.asinh(14 / cf)}" gating:max="${Math.asinh(19 / cf)}" gating:transformation-ref="Tr_Arcsinh_5"><data-type:fcs-dimension data-type:name="Event_length"/></gating:dimension>
      </gating:RectangleGate>`);
    expect(evaluate(xml, s).byName("Singlets")).toEqual([0, 1, 1, 0]);
  });

  it("reads back GateLab's own export of an arcsinh gate on Event_length with the same events", () => {
    const s = sampleOf("cytof", { Event_length: [10, 15, 18, 25], Nd142Di: [1, 2, 3, 4] });
    const gate: Gate = {
      gate_id: "g1", name: "Singlets", gate_type: "rectangle", x_channel: "Event_length", y_channel: "Nd142Di",
      vertices: [[Math.asinh(14 / 5), -1e9], [Math.asinh(19 / 5), -1e9], [Math.asinh(19 / 5), 1e9], [Math.asinh(14 / 5), 1e9]],
      space: "display", transforms: { Event_length: { kind: "asinh", cofactor: 5 }, Nd142Di: { kind: "asinh", cofactor: 5 } },
      color: "#000000", label_offset: null,
    };
    const root = newRootPopulation();
    const pop = newPopulation("Singlets", [newGateRef("g1", true)], root.population_id);
    const populations = linkChildToParent({ [root.population_id]: root, [pop.population_id]: pop }, pop.population_id, root.population_id);
    const out = exportGatingML({ gates: { g1: gate }, gate_order: ["g1"], populations, root_population_id: root.population_id,
      sample: s, format: "standard", timestamp: "2026-01-01T00:00:00" });
    expect(evaluate(out, s).byName("Singlets")).toEqual([0, 1, 1, 0]);
  });
});

describe("Time in the unit its writer uses (tester D14; open questions 0, 19, 32)", () => {
  const ticks = [100, 200, 300, 400];
  const time = (header: string, lo: number, hi: number) => gml(`${header}
    <gating:RectangleGate gating:id="R" gating:name="Middle">
      <gating:dimension gating:min="${lo}" gating:max="${hi}"><data-type:fcs-dimension data-type:name="Time"/></gating:dimension>
    </gating:RectangleGate>`);
  const flow = () => sampleOf("flow", { Time: ticks, "FSC-A": [1, 2, 3, 4] }, { keywords: { $TIMESTEP: "0.01" } });

  it("reads another tool's Time in seconds, as FlowKit and FlowJo write it", () => {
    expect(evaluate(time("", 1.5, 2.5), flow()).byName("Middle")).toEqual([0, 1, 0, 0]);
  });

  it("holds an event whose seconds value is a range's edge, where dividing the edge by $TIMESTEP rounds past its tick", () => {
    // FlowKit reads Time as tick × $TIMESTEP (flowio, in double precision) and a writer may put an
    // edge on an event's own value. 10.052100219726563 s / 0.01 is one step above the tick
    // 1005.2100219726562 it came from, so the lower edge left that event out (4 of 60 FlowKit
    // ranges' edges on the public FACSDiva file, 4 on PBMC17, 3 on Fortessa); 10.062100830078125 s
    // divides to one step below 1006.2100830078125, which the closed upper edge left out.
    const ts = 0.01;
    const stored = [1003.2100219726562, 1004.2100219726562, 1005.2100219726562, 1006.2100830078125, 1007.2100830078125];
    const secs = stored.map((t) => t * ts);
    const [lo, hi] = [secs[2], secs[3]];
    expect(lo / ts).toBeGreaterThan(stored[2]);
    expect(hi / ts).toBeLessThan(stored[3]);
    const sample = () => sampleOf("flow", { Time: stored, "FSC-A": [1, 2, 3, 4, 5] }, { keywords: { $TIMESTEP: String(ts) } });
    // With #344's edge rules (release candidate) a Gating-ML file with no mark is half-open, as
    // FlowKit reads it: the event on the lower edge is held, and the one on the upper edge is not.
    const expected = secs.map((s) => (s >= lo && s < hi ? 1 : 0));
    expect(expected).toEqual([0, 0, 1, 0, 0]);
    const first = evaluate(time("", lo, hi), sample());
    expect(first.byName("Middle")).toEqual(expected);
    // Written back in seconds, the range holds the same events for GateLab and for the standard's reader.
    const out = exportGatingML({ gates: first.res.gates, gate_order: first.res.gate_order, populations: first.res.populations,
      root_population_id: first.res.root_population_id, sample: sample(), format: "standard", timestamp: "2026-01-01T00:00:00" });
    const written = /<gating:dimension[^>]* gating:min="([^"]+)" gating:max="([^"]+)"/.exec(out)!;
    // A reader of either rule holds the same events (the upper bound is written for both).
    expect(secs.map((s) => (s >= Number(written[1]) && s <= Number(written[2]) ? 1 : 0))).toEqual(expected);
    expect(secs.map((s) => (s >= Number(written[1]) && s < Number(written[2]) ? 1 : 0))).toEqual(expected);
    expect(evaluate(out, sample()).byName("Middle")).toEqual(expected);
  });

  it("reads a Cytobank file's Time as stored", () => {
    const cytobank = `<data-type:custom_info><cytobank><about>exported</about></cytobank></data-type:custom_info>`;
    expect(evaluate(time(cytobank, 150, 250), flow()).byName("Middle")).toEqual([0, 1, 0, 0]);
  });

  it("writes Time in seconds in the standard format and as stored in the Cytobank format, and says which", () => {
    const s = flow();
    const first = evaluate(time("", 1.5, 3.5), s);
    const args = { gates: first.res.gates, gate_order: first.res.gate_order, populations: first.res.populations,
      root_population_id: first.res.root_population_id, sample: s, timestamp: "2026-01-01T00:00:00" };
    // A bound is written where GateLab's own single-precision decision falls, within 1e-7 of it.
    const minOf = (xml: string) => Number(/<gating:dimension[^>]*gating:min="([^"]+)"/.exec(xml)![1]);
    const standard = exportGatingML({ ...args, format: "standard" });
    expect(standard).toContain('"time":"seconds"');
    expect(minOf(standard)).toBeCloseTo(1.5, 6);
    const cytobank = exportGatingML({ ...args, format: "cytobank" });
    expect(cytobank).toContain('"time":"ticks"');
    expect(minOf(cytobank)).toBeCloseTo(150, 4);
    for (const xml of [standard, cytobank]) expect(evaluate(xml, flow()).byName("Middle")).toEqual([0, 1, 1, 0]);
  });

  it("leaves a converted FlowJo workspace's Time as the converter wrote it, in ticks", () => {
    const wsp = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0" xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations">
  <SampleList><Sample>
    <DataSet uri="file:t.fcs" sampleID="1"/>
    <Keywords><Keyword name="$TIMESTEP" value="0.01"/><Keyword name="$FIL" value="t.fcs"/></Keywords>
    <SampleNode name="t.fcs" count="4" sampleID="1">
      <Subpopulations>
        <Population name="Middle" count="2">
          <Gate gating:id="G1">
            <gating:RectangleGate gating:id="G1">
              <gating:dimension gating:min="1.5" gating:max="3.5"><data-type:fcs-dimension data-type:name="Time"/></gating:dimension>
              <gating:dimension gating:min="0" gating:max="10"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
            </gating:RectangleGate>
          </Gate>
        </Population>
      </Subpopulations>
    </SampleNode>
  </Sample></SampleList>
</Workspace>`;
    const conv = flowJoWorkspaceToGatingML(wsp, 0);
    expect(conv.gatingMl).toContain('{"version":3,"time":"ticks","fcs":"compensated"}');
    expect(evaluate(conv.gatingMl, flow()).byName("Middle")).toEqual([0, 1, 1, 0]);
  });
});

describe("a densified polygon checked on the values GateLab reads back (#345's readBack x this branch)", () => {
  // A polygon with one axis written in raw space (FlowJo's biex) is densified and held to the
  // exported file's events as GateLab reads them back (#345's readBack). The standard format writes
  // Time in seconds, with the transform declared on seconds (its T times $TIMESTEP), and GateLab
  // reading the file back restates it on stored ticks. readBack applied the declaration as written
  // to stored ticks, so the check found events misplaced that GateLab reads where they belong and
  // notched the polygon to move them: 2,557 vertices where 371 hold the same events in ticks. (A
  // flog on Time is a clamped axis, which the standard format refuses to write in seconds.)
  const n = 40000;
  const polygonSample = (timestep: number | null) => {
    const col = (f: (i: number) => number) => Float32Array.from({ length: n }, (_, i) => f(i));
    return new Sample({
      version: "FCS3.1", nEvents: n, instrument: "flow", keywords: timestep === null ? {} : { $TIMESTEP: String(timestep) }, spillover: null,
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
        { index: 2, name: "Time", marker: null, bits: 32, range: 262144 },
        { index: 3, name: "FL2-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [
        col((i) => 1000 + (i * 2477) % 200000),
        col((i) => 500 + (i * 1181) % 150000),
        col((i) => 10 ** (((i * 7919) % 40000) / 8000) - 20),
        col((i) => 10 ** (((i * 3571) % 30000) / 6000) - 10),
      ],
    } as FcsFile);
  };
  const mask = (sample: Sample, gate: Gate): Uint8Array => getGateMask(gate, sample.gateAssayData().forGate(gate));
  const exported = (sample: Sample, gate: Gate) => {
    const root = newRootPopulation();
    let populations: PopulationMap = { [root.population_id]: root };
    const pop = newPopulation(gate.name, [newGateRef(gate.gate_id, true)], root.population_id, "and");
    populations[pop.population_id] = pop;
    populations = linkChildToParent(populations, pop.population_id, root.population_id);
    return exportGatingML({
      gates: { [gate.gate_id]: gate }, gate_order: [gate.gate_id], populations, root_population_id: root.population_id,
      sample, format: "standard", timestamp: "2026-01-01T00:00:00",
    });
  };
  const vertices = (xml: string) => (xml.match(/<gating:vertex>/g) ?? []).length;
  const polygon = (y: TransformSpec, yChannel: string): Gate => {
    const x: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -10, channelRange: 256 };
    const fx = transformFromSpec(x).forward;
    const fy = transformFromSpec(y).forward;
    return {
      gate_id: "poly", name: "Poly", gate_type: "polygon", x_channel: "FL2-A", y_channel: yChannel,
      vertices: [[fx(30), fy(40)], [fx(20000), fy(90)], [fx(60000), fy(30000)], [fx(900), fy(8000)]],
      space: "display", transforms: { "FL2-A": x, [yChannel]: y }, color: "#000000", label_offset: null,
    };
  };
  for (const [label, y] of [
    ["arcsinh", { kind: "asinh", cofactor: 150 }],
    ["logicle", { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 }],
  ] as [string, TransformSpec][]) {
    it(`writes a polygon whose ${label} axis is Time in seconds with as many vertices as in ticks, and brings it back`, () => {
      const gate = polygon(y, "Time");
      const inTicks = exported(polygonSample(null), gate);
      const sample = polygonSample(0.01);
      const xml = exported(sample, gate);
      expect(xml).toContain('"time":"seconds"');
      const before = mask(sample, gate);
      expect(before.reduce((a, v) => a + v, 0)).toBeGreaterThan(1000);
      expect(vertices(xml)).toBe(vertices(inTicks));
      const { byName } = evaluate(xml, polygonSample(0.01));
      expect(byName("Poly")).toEqual(Array.from(before));
    });
  }
});

describe("every compensation problem, named together (open question 3)", () => {
  it("names the unsupported matrix and the missing channel in one refusal", () => {
    const xml = gml(`
      <gating:RectangleGate gating:id="A" gating:name="A">
        <gating:dimension gating:min="0" gating:compensation-ref="MySpill"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
      </gating:RectangleGate>
      <gating:RectangleGate gating:id="B" gating:name="B">
        <gating:dimension gating:min="0" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="Absent-A"/></gating:dimension>
      </gating:RectangleGate>`);
    let message = "";
    try {
      importGatingML(xml, ["PE-A"], {}, "flow");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/unsupported compensation matrix "MySpill"/);
    expect(message).toMatch(/Gate "B" \(B\) references channel\(s\) not present in the loaded data: "Absent-A"/);
  });
});

describe("a GatingHierarchy population whose gate is left out (open question 29)", () => {
  it("is named in a warning with its subtree, as in the other layouts", () => {
    const xml = gml(`
      <data-type:custom_info><cytobank><about>Gating-ML 2.0 export from GateLab (standard / re-importable)</about></cytobank></data-type:custom_info>
      <gating:RectangleGate gating:id="A" gating:name="A">
        <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
      </gating:RectangleGate>
      <gating:RectangleGate gating:id="Q" gating:name="Ratio">
        <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
        <gating:dimension gating:min="1" gating:max="2"><data-type:new-dimension data-type:transformation-ref="Rat"/></gating:dimension>
      </gating:RectangleGate>
      <gating:GatingHierarchy>
        <gating:PopulationGatePair gating:gate-ref="A"><gating:name>Top</gating:name>
          <gating:PopulationGatePair gating:gate-ref="Q"><gating:name>Of the ratio</gating:name>
            <gating:PopulationGatePair gating:gate-ref="A"><gating:name>Beneath</gating:name></gating:PopulationGatePair>
          </gating:PopulationGatePair>
        </gating:PopulationGatePair>
      </gating:GatingHierarchy>`);
    const res = importGatingML(xml, ["PE-A"], {}, "flow");
    expect(Object.values(res.populations).map((p) => p.name).sort()).toEqual(["All Events", "Top"]);
    expect(res.warnings).toEqual([
      '"Of the ratio" uses the gate "Ratio", which has the ratio dimension Rat, which GateLab cannot hold; it and anything below it were skipped.',
    ]);
  });
});

describe("the Cytobank format's flattened chains (a tester finding)", () => {
  // fix/gatingml-transforms left such a population out by name; fix/gatingml-hardening (f6a2af8)
  // writes it as the AND of the gate and its complement, which holds nothing for every reader, and
  // reads it back so. The release candidate writes it (CYTOBANK_OMITS_CONTRADICTIONS, a decision
  // for David); the analysis that would leave it out still names it.
  it("writes a population excluding a gate its ancestor includes, empty, and names it for the choice to leave it out", () => {
    const s = sampleOf("flow", { "PE-A": [1, 2, 3], "FSC-A": [1, 2, 3] });
    const rectangle = (id: string, lo: number): Gate => ({
      gate_id: id, name: id, gate_type: "rectangle", x_channel: "PE-A", y_channel: "PE-A",
      vertices: [[lo, lo], [1e9, lo], [1e9, 1e9], [lo, 1e9]], space: "raw", color: "#000000", label_offset: null,
    });
    const gates = { g: rectangle("g", 2), h: rectangle("h", 1) };
    const root = newRootPopulation();
    const top = newPopulation("In g", [newGateRef("g", true)], root.population_id);
    const inner = newPopulation("Not g", [newGateRef("g", false)], top.population_id);
    const deeper = newPopulation("Beneath", [newGateRef("h", true)], inner.population_id);
    const other = newPopulation("In h", [newGateRef("h", true)], top.population_id);
    let populations: PopulationMap = { [root.population_id]: root };
    for (const p of [top, inner, deeper, other]) {
      populations[p.population_id] = p;
      populations = linkChildToParent(populations, p.population_id, p.parent_id!);
    }
    const warnings: string[] = [];
    const xml = exportGatingML({ gates, gate_order: ["g", "h"], populations, root_population_id: root.population_id,
      sample: s, format: "cytobank", timestamp: "2026-01-01T00:00:00", warnings });
    // It was written as and(g, g), which every reader takes for "In g"; it is and(g, not g) now.
    expect(CYTOBANK_OMITS_CONTRADICTIONS).toBe(false);
    expect(xml).toContain("<name>Not g</name>");
    expect(xml).toContain("<name>Beneath</name>");
    expect(xml).toContain("<name>In h</name>");
    expect(warnings).toEqual([]);
    // The analysis the export dialog and the export use when the population is to be left out.
    const analysis = analyzeCytobankContradictions(gates, populations, root.population_id);
    expect(analysis.names).toEqual(["Not g"]);
    expect(analysis.populationIds.sort()).toEqual([inner.population_id, deeper.population_id].sort());
    // GateLab reads its own file back with the whole tree in place, the contradiction empty.
    const back = evaluate(xml, s);
    expect(Object.values(back.res.populations).map((p) => p.name).sort()).toEqual(["All Events", "Beneath", "In g", "In h", "Not g"]);
    expect(back.byName("Not g")).toEqual([0, 0, 0]);
    expect(back.byName("Beneath")).toEqual([0, 0, 0]);
    expect(back.byName("In g")).toEqual([0, 1, 1]);
  });
});

describe("a Cytobank-format file with every population left out (verifier)", () => {
  it("reads back no population, where it read each geometric gate as one", () => {
    // Every population of this tree uses a quadrant, which the format leaves out with what uses it;
    // the rectangle beside it is still written. With no Boolean gate in the file it was read by
    // Gating-ML 2.0's model, in which every gate is a population, and "g" came back as a population
    // the user never had. The same happens with CYTOBANK_OMITS_CONTRADICTIONS and a tree whose
    // every population is contradictory ("Both", AND(g, NOT g), left out).
    const s = sampleOf("flow", { "PE-A": [1, 2, 3, 4], "FITC-A": [1, 2, 3, 4] });
    const g: Gate = {
      gate_id: "g", name: "g", gate_type: "rectangle", x_channel: "PE-A", y_channel: "PE-A",
      vertices: [[2, 2], [1e9, 2], [1e9, 1e9], [2, 1e9]], space: "raw", color: "#000", label_offset: null,
    };
    const q: Gate = {
      gate_id: "q", name: "q", gate_type: "quadrant", x_channel: "PE-A", y_channel: "FITC-A",
      center: [2, 2], space: "raw", color: "#000", label_offset: null,
    };
    const root = newRootPopulation();
    const pop = newPopulation("Q and g", [newGateRef("q", true, 1), newGateRef("g", true)], root.population_id);
    const populations = linkChildToParent({ [root.population_id]: root, [pop.population_id]: pop }, pop.population_id, root.population_id);
    for (const format of ["cytobank", "standard"] as const) {
      const xml = exportGatingML({ gates: { g, q }, gate_order: ["g", "q"], populations, root_population_id: root.population_id,
        sample: s, format, timestamp: "2026-01-01T00:00:00", allowQuadrantOmission: true });
      expect(xml, format).toContain("<gating:RectangleGate");
      expect(xml, format).not.toContain("<gating:BooleanGate");
      const back = importGatingML(xml, ["PE-A", "FITC-A"], {}, "flow");
      expect(Object.values(back.populations).map((p) => p.name), format).toEqual(["All Events"]);
    }
  });
});

describe("a file GateLab cannot read as written is refused, by name (format robustness)", () => {
  const rect = `<gating:RectangleGate gating:id="R" gating:name="R">
      <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
    </gating:RectangleGate>`;
  const marked = (mark: string) => gml(`<data-type:custom_info><gatelab_format>${mark}</gatelab_format></data-type:custom_info>${rect}`);
  const refuses = (xml: string, why: RegExp) => expect(() => importGatingML(xml, ["PE-A", "FSC-A"], {}, "flow")).toThrow(why);

  it("refuses a mark it cannot read instead of reading the file as unmarked", () => {
    refuses(marked(`{"version":3,"logicle":"gating-`), /gatelab_format mark is not readable JSON/);
    refuses(marked(`[2]`), /gatelab_format mark is not a JSON object/);
    refuses(marked(``), /gatelab_format mark is empty/);
    refuses(marked(`{"version":9}`), /mark has version 9, which this GateLab does not read/);
    refuses(marked(`{"logicle":"gating-ml"}`), /mark has version null/);
    refuses(marked(`{"version":3,"time":"minutes"}`), /unknown Time unit "minutes"/);
    expect(() => importGatingML(marked(`{"version":3,"time":"ticks"}`), ["PE-A"], {}, "flow")).not.toThrow();
  });

  it("refuses a Cytobank-format tree that contradicts the Boolean gates' chains", () => {
    const g = (id: string) => `<gating:RectangleGate gating:id="${id}" gating:name="${id}">
      <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension></gating:RectangleGate>`;
    const pop = (id: string, refs: string) => `<gating:BooleanGate gating:id="${id}">
      <data-type:custom_info><cytobank><name>${id}</name></cytobank></data-type:custom_info><gating:and>${refs}</gating:and></gating:BooleanGate>`;
    const ref = (id: string, complement = false) => `<gating:gateReference gating:ref="${id}"${complement ? ' gating:use-as-complement="true"' : ""}/>`;
    const tree = (parent: string) => `{"version":3,"logicle":"gating-ml","hierarchy":"tree","time":"ticks","tree":[{"id":"P1","parent":null},{"id":"P2","parent":${parent}}]}`;
    const file = (p2: string, parent: string) => gml(`<data-type:custom_info><gatelab_format>${tree(parent)}</gatelab_format></data-type:custom_info>
      ${g("a")}${g("b")}${pop("P1", ref("a") + ref("a"))}${pop("P2", p2)}`);
    expect(() => importGatingML(file(ref("a") + ref("b"), '"P1"'), ["PE-A"], {}, "flow")).not.toThrow();
    refuses(file(ref("b") + ref("b"), '"P1"'), /tree places P2 under P1, but P2's Boolean gate does not hold P1's gates/);
    refuses(file(ref("a", true) + ref("b"), '"P1"'), /tree places P2 under P1, but P2's Boolean gate does not hold P1's gates/);
  });

  it("reads a complement as xs:boolean, and refuses one it cannot read or that says two things", () => {
    const pair = (attrs: string) => gml(`
      <data-type:custom_info><cytobank><about>Gating-ML 2.0 export from GateLab (standard / re-importable)</about></cytobank></data-type:custom_info>
      ${rect}
      <gating:GatingHierarchy><gating:PopulationGatePair gating:gate-ref="R" ${attrs}><gating:name>P</gating:name></gating:PopulationGatePair></gating:GatingHierarchy>`);
    const s = sampleOf("flow", { "PE-A": [-1, 1] });
    for (const yes of ['gating:complement="1"', 'gating:complement=" true"', 'gating:use-as-complement="true"']) {
      expect(evaluate(pair(yes), s).byName("P"), yes).toEqual([1, 0]);
    }
    refuses(pair('gating:use-as-complement="true" gating:complement="false"'), /PopulationGatePair for R has use-as-complement="true" and complement="false" disagree/);
    refuses(pair('gating:complement="yes"'), /complement="yes" is not true or false/);
  });

  it("refuses a gateReference with no ref instead of dropping it", () => {
    refuses(gml(`${rect}
      <gating:BooleanGate gating:id="B"><gating:and><gating:gateReference gating:ref="R"/><gating:gateReference/></gating:and></gating:BooleanGate>`),
    /BooleanGate B has a gateReference with no ref/);
    // An empty or blank ref, and one under NOT or OR (verifier of GateLabR: GateLab dropped these,
    // and on the public PBMC standard export NK cells came back 362 events off).
    refuses(gml(`${rect}
      <gating:BooleanGate gating:id="B"><gating:and><gating:gateReference gating:ref="R"/><gating:gateReference gating:ref=""/></gating:and></gating:BooleanGate>`),
    /BooleanGate B has a gateReference with no ref/);
    refuses(gml(`${rect}
      <gating:BooleanGate gating:id="B"><gating:not><gating:gateReference/></gating:not></gating:BooleanGate>`),
    /BooleanGate B has a gateReference with no ref/);
    refuses(gml(`${rect}
      <gating:BooleanGate gating:id="B"><gating:or><gating:gateReference gating:ref="R"/><gating:gateReference gating:ref=" "/></gating:or></gating:BooleanGate>`),
    /BooleanGate B has a gateReference with no ref/);
  });

  it("refuses a mark with a comment in it, which JSON has not, instead of reading the file as unmarked", () => {
    // Read as no mark, a GateLab file's logicle came back on flowCore's scale and its tree was
    // rebuilt from the Boolean gates (verifier of GateLabR: 88,103 events in one population).
    const mark = `{"version":3,"logicle":"gating-ml","time":"ticks"}`;
    refuses(marked(`/* written by hand */${mark}`), /gatelab_format mark is not readable JSON/);
    refuses(marked(`${mark} // written by hand`), /gatelab_format mark is not readable JSON/);
    refuses(marked(`// written by hand\n${mark}`), /gatelab_format mark is not readable JSON/);
    // An XML comment is not part of the mark's text, and the mark is read as it is.
    expect(() => importGatingML(marked(`<!-- written by hand -->${mark}`), ["PE-A"], {}, "flow")).not.toThrow();
  });

  it("refuses logicle and fasinh parameters no scale has, naming the transformation and the gate", () => {
    const on = (tr: string) => gml(`<transforms:transformation transforms:id="Tr">${tr}</transforms:transformation>
      <gating:RectangleGate gating:id="R" gating:name="Gate R">
        <gating:dimension gating:min="0" gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
      </gating:RectangleGate>`);
    const logicle = (T: number, W: number, M: number, A: number) =>
      on(`<transforms:logicle transforms:T="${T}" transforms:W="${W}" transforms:M="${M}" transforms:A="${A}"/>`);
    refuses(logicle(262144, 3, 4.5, 0), /R \(Gate R\) references transformation Tr, which is invalid: logicle with W = 3 above M\/2/);
    refuses(logicle(262144, -0.5, 4.5, 0), /W = -0.5; W cannot be negative/);
    refuses(logicle(0, 0.5, 4.5, 0), /T = 0; T must be positive/);
    refuses(logicle(262144, 0.5, 0, 0), /M = 0; M must be positive/);
    refuses(logicle(262144, 0.5, 4.5, -1), /A = -1; A cannot be negative/);
    // Transformations.v2.0.xsd bounds A by M - 2W, in a comment that leaves the check to the reader.
    refuses(logicle(262144, 1, 4.5, 3), /R \(Gate R\) references transformation Tr, which is invalid: logicle with A = 3 above M - 2W = 2.5/);
    expect(() => importGatingML(logicle(262144, 1, 4.5, 2.5), ["PE-A", "FSC-A"], {}, "flow")).not.toThrow();
    const fa = (T: number, M: number, A: number) => on(`<transforms:fasinh transforms:T="${T}" transforms:M="${M}" transforms:A="${A}"/>`);
    refuses(fa(262144, 0, 1), /fasinh with M = 0; M must be positive/);
    refuses(fa(-1, 4, 0), /fasinh with T = -1; T must be positive/);
    // Transformations.v2.0.xsd types A as UFloat64 (A >= 0), and FlowKit refuses a file with A < 0.
    refuses(fa(262144, 4, -0.5), /R \(Gate R\) references transformation Tr, which is invalid: fasinh with A = -0.5; A cannot be negative/);
    refuses(fa(262144, 1, -2), /fasinh with A = -2; A cannot be negative/);
  });

  it("refuses a logicle, fasinh or flin parameter it cannot read as a number, instead of putting a default in its place", () => {
    const on = (tr: string) => gml(`<transforms:transformation transforms:id="Tr">${tr}</transforms:transformation>
      <gating:RectangleGate gating:id="R" gating:name="Gate R">
        <gating:dimension gating:min="0.2" gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
      </gating:RectangleGate>`);
    const attrs = (p: Record<string, string>) => Object.entries(p).map(([k, v]) => `transforms:${k}="${v}"`).join(" ");
    const logicle = { T: "262144", W: "0.5", M: "4.5", A: "0" };
    const fasinh = { T: "262144", M: "4", A: "0" };
    // Until 2026-09 a logicle M or A, and a fasinh M or A, that was not a number was read as absent:
    // M="abc" became 4.5 (logicle) or log10 e (fasinh), and the gate was evaluated on that scale.
    for (const [name, value] of [["M", "abc"], ["A", "abc"], ["M", "INF"], ["A", "NaN"], ["M", ""], ["A", " "], ["W", "0x1"], ["T", "abc"], ["W", "abc"]]) {
      refuses(on(`<transforms:logicle ${attrs({ ...logicle, [name]: value })}/>`),
        new RegExp(`R \\(Gate R\\) references transformation Tr, which is invalid: logicle with ${name} = "${value}", which is not a finite number`));
    }
    for (const [name, value] of [["M", "abc"], ["A", "abc"], ["M", "INF"], ["A", "-INF"], ["T", "abc"]]) {
      refuses(on(`<transforms:fasinh ${attrs({ ...fasinh, [name]: value })}/>`),
        new RegExp(`references transformation Tr, which is invalid: fasinh with ${name} = "${value}", which is not a finite number`));
    }
    refuses(on(`<transforms:logicle ${attrs({ ...logicle, M: "abc", A: "x" })}/>`), /logicle with M = "abc" and A = "x", which are not finite numbers/);
    refuses(on(`<transforms:flin transforms:T="262144" transforms:A="abc"/>`), /flin with A = "abc", which is not a finite number/);
    // A parameter the file leaves out still takes its default, as GateLabR gives it.
    expect(() => importGatingML(on(`<transforms:logicle transforms:T="262144" transforms:W="0.5"/>`), ["PE-A"], {}, "flow")).not.toThrow();
    expect(() => importGatingML(on(`<transforms:fasinh transforms:T="262144"/>`), ["PE-A"], {}, "flow")).not.toThrow();
  });

  it("refuses a range's edge, a vertex, an ellipse's number, a bound or a flog parameter it cannot read as a number (verifier)", () => {
    // Number() reads "" and " " as 0 and "0x1" as 1, and an edge that read as no number was taken
    // for no bound, a vertex that did was dropped, and a distanceSquare that did became 1: on the
    // public PBMC file a range with min="NaN" held 37,405 events where FlowKit holds none, and a
    // vertex "abc" or "" turned a polygon of 50,482 events into one of 40,375 or 76,037 (verifier).
    const dim = (ch: string, attrs = "") => `<gating:dimension${attrs}><data-type:fcs-dimension data-type:name="${ch}"/></gating:dimension>`;
    const rect = (min: string) => gml(`<gating:RectangleGate gating:id="R" gating:name="Gate R">${dim("PE-A", ` gating:min="${min}" gating:max="5"`)}</gating:RectangleGate>`);
    for (const v of ["abc", "", " ", "0x1", "NaN", "1,5", "Infinity"]) {
      refuses(rect(v), new RegExp(`RectangleGate R \\(Gate R\\) has min = ${JSON.stringify(v)} on PE-A, which is not a number`));
    }
    // An xs:double as the schema spells one is read; INF and -INF are no bound.
    for (const v of ["+0.5", "5E-1", " 0.5 ", "0.", "-INF", "INF"]) expect(() => importGatingML(rect(v), ["PE-A"], {}, "flow"), v).not.toThrow();
    const vertex = (x: string, y: string) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`;
    const poly = (x0: string) => gml(`<gating:PolygonGate gating:id="P" gating:name="Poly">${dim("PE-A")}${dim("FSC-A")}
      ${vertex(x0, "0")}${vertex("1", "0")}${vertex("1", "1")}${vertex("0", "1")}</gating:PolygonGate>`);
    for (const v of ["abc", "", "0x1", "INF", "NaN"]) {
      refuses(poly(v), new RegExp(`PolygonGate P \\(Poly\\) has vertex 1 with x = ${JSON.stringify(v)}, which is not a finite number`));
    }
    const ellipse = (mean: string, entry: string, d2: string) => gml(`<gating:EllipsoidGate gating:id="E" gating:name="Oval">${dim("PE-A")}${dim("FSC-A")}
      <gating:mean><gating:coordinate data-type:value="${mean}"/><gating:coordinate data-type:value="1"/></gating:mean>
      <gating:covarianceMatrix><gating:row><gating:entry data-type:value="${entry}"/><gating:entry data-type:value="0"/></gating:row>
        <gating:row><gating:entry data-type:value="0"/><gating:entry data-type:value="1"/></gating:row></gating:covarianceMatrix>
      <gating:distanceSquare data-type:value="${d2}"/></gating:EllipsoidGate>`);
    refuses(ellipse("abc", "1", "1"), /EllipsoidGate E \(Oval\) has mean x = "abc", which is not a finite number/);
    refuses(ellipse("1", "", "1"), /EllipsoidGate E \(Oval\) has covariance entry 1, 1 = "", which is not a finite number/);
    refuses(ellipse("1", "1", ""), /EllipsoidGate E \(Oval\) has distanceSquare = "", which is not a finite number/);
    refuses(ellipse("1", "1", "abc"), /EllipsoidGate E \(Oval\) has distanceSquare = "abc", which is not a finite number/);
    expect(() => importGatingML(ellipse("1", "1", "1"), ["PE-A", "FSC-A"], {}, "flow")).not.toThrow();
    const on = (tr: string, bounds = "") => gml(`<transforms:transformation transforms:id="Tr"${bounds}>${tr}</transforms:transformation>
      <gating:RectangleGate gating:id="R" gating:name="Gate R">${dim("PE-A", ' gating:min="0.2" gating:transformation-ref="Tr"')}</gating:RectangleGate>`);
    const flin = `<transforms:flin transforms:T="262144" transforms:A="0"/>`;
    for (const [name, v] of [["boundMin", ""], ["boundMin", " "], ["boundMin", "abc"], ["boundMin", "0x10"], ["boundMax", "0x1"], ["boundMax", "NaN"]]) {
      refuses(on(flin, ` transforms:${name}="${v}"`),
        new RegExp(`R \\(Gate R\\) references transformation Tr, which is invalid: its ${name} = ${JSON.stringify(v)}, which is not a number`));
    }
    expect(() => importGatingML(on(flin, ' transforms:boundMin="-INF" transforms:boundMax="1E0"'), ["PE-A"], {}, "flow")).not.toThrow();
    for (const [name, v] of [["M", "abc"], ["M", "0x4"], ["T", ""], ["M", "INF"]]) {
      const params = { T: "262144", M: "4", [name]: v };
      refuses(on(`<transforms:flog transforms:T="${params.T}" transforms:M="${params.M}"/>`),
        new RegExp(`references transformation Tr, which is invalid: flog with ${name} = ${JSON.stringify(v)}, which is not a finite number`));
    }
    // A spillover coefficient: Number() read "" as 0.
    const spill = (c: string) => gml(`<transforms:spectrumMatrix transforms:id="S">
        <transforms:fluorochromes><data-type:fcs-dimension data-type:name="PE-A"/><data-type:fcs-dimension data-type:name="FSC-A"/></transforms:fluorochromes>
        <transforms:detectors><data-type:fcs-dimension data-type:name="PE-A"/><data-type:fcs-dimension data-type:name="FSC-A"/></transforms:detectors>
        <transforms:spectrum><transforms:coefficient transforms:value="1"/><transforms:coefficient transforms:value="${c}"/></transforms:spectrum>
        <transforms:spectrum><transforms:coefficient transforms:value="0"/><transforms:coefficient transforms:value="1"/></transforms:spectrum>
      </transforms:spectrumMatrix>
      <gating:RectangleGate gating:id="R" gating:name="Gate R">${dim("PE-A", ' gating:min="0.2" gating:compensation-ref="S"')}</gating:RectangleGate>`);
    for (const c of ["", "0x1", "abc"]) refuses(spill(c), /Spillover matrix S is not a complete 2 by 2 matrix of numbers/);
    expect(() => importGatingML(spill("0.1"), ["PE-A", "FSC-A"], {}, "flow")).not.toThrow();
  });

  it("reads a fasinh until sinh(M ln 10) overflows, an event whose x sinh(M ln 10) / T overflows where FlowKit places it, and names what it refuses", () => {
    type Kind = "rectangle" | "range" | "polygon";
    const on = (M: number, kind: Kind, T = 262144) => gml(`<transforms:transformation transforms:id="Tr"><transforms:fasinh transforms:T="${T}" transforms:M="${M}" transforms:A="0"/></transforms:transformation>
      ${kind === "polygon"
        ? `<gating:PolygonGate gating:id="R" gating:name="Gate R">
            <gating:dimension gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
            <gating:dimension><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
            <gating:vertex><gating:coordinate data-type:value="0.99"/><gating:coordinate data-type:value="0"/></gating:vertex>
            <gating:vertex><gating:coordinate data-type:value="1.002"/><gating:coordinate data-type:value="0"/></gating:vertex>
            <gating:vertex><gating:coordinate data-type:value="1.002"/><gating:coordinate data-type:value="100"/></gating:vertex>
            <gating:vertex><gating:coordinate data-type:value="0.99"/><gating:coordinate data-type:value="100"/></gating:vertex>
          </gating:PolygonGate>`
        : `<gating:RectangleGate gating:id="R" gating:name="Gate R">
            <gating:dimension gating:min="0.99"${kind === "rectangle" ? ' gating:max="1.002"' : ""} gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
          </gating:RectangleGate>`}`);
    const kinds: Kind[] = ["rectangle", "range", "polygon"];
    // sinh(M ln 10) is infinite above M of about 308.55: refused before too, but only as a transform
    // GateLab "cannot hold exactly", and so was a T / sinh(M ln 10) that overflows (verifier: T = 1e308,
    // M = 1e-3, which FlowKit reads).
    for (const kind of kinds) {
      refuses(on(400, kind), /R \(Gate R\) references transformation Tr, which is invalid: fasinh with M = 400; sinh\(M ln 10\) overflows double precision/);
      refuses(on(308.6, kind), /fasinh with M = 308\.6; sinh\(M ln 10\) overflows double precision/);
      refuses(on(1e-3, kind, 1e308), /R \(Gate R\) references transformation Tr, which is invalid: fasinh with T = 1e\+308 and M = 0\.001; T \/ sinh\(M ln 10\) overflows double precision/);
    }
    // Below, each event is placed as FlowKit places it (flowutils: x times sinh(M ln 10) / T), one whose
    // product overflows at +Infinity, which a range open above holds and a rectangle bounded above or a
    // polygon does not. b37ef44 read M from 276 to 308.5 so, equal to FlowKit on the public PBMC file;
    // 5f2de9c refused them, bounding every value a single-precision parameter can hold (verifier).
    const xs = [-5, 0.5, 3, 40, 900, 20000, 262144, 3e5, 3e6, 1e15];
    const s = sampleOf("flow", { "PE-A": xs, "FSC-A": xs.map(() => 50) });
    for (const M of [250, 300, 308.5]) {
      const reader = (x: number) => Math.asinh(x * (Math.sinh(M * LN10) / 262144)) / (M * LN10);
      expect(xs.filter((x) => reader(x) === Infinity).length, `M = ${M}`).toBe(M === 250 ? 0 : M === 300 ? 1 : 3);
      for (const kind of kinds) {
        const want = xs.map((x) => { const y = reader(x); return y >= 0.99 && (kind === "range" || y <= 1.002) ? 1 : 0; });
        expect(want.reduce((a: number, b) => a + b, 0)).toBeGreaterThan(2);
        const { res, byName } = evaluate(on(M, kind), s);
        expect(res.warnings, `${kind}, M = ${M}`).toEqual([]);
        expect(byName("Gate R"), `${kind}, M = ${M}`).toEqual(want);
      }
    }
  });
});

describe("a population name's own spaces", () => {
  it("comes back from both Gating-ML formats with a leading or trailing space kept", () => {
    // Read from a FlowJo workspace, a name keeps its trailing space (the converter writes
    // gating:name); GateLab's own files carry it in custom_info, which was read trimmed, so the
    // population came back under another name (a public FlowRepository workspace, 2 populations).
    const s = sampleOf("flow", { "FSC-A": [1, 5, 9], "SSC-A": [1, 5, 9] });
    const gate: Gate = {
      gate_id: "g1", name: "Gate one ", gate_type: "rectangle", x_channel: "FSC-A", y_channel: "SSC-A",
      vertices: [[2, 2], [8, 2], [8, 8], [2, 8]], space: "raw", color: "#000000", label_offset: null,
    };
    const root = newRootPopulation();
    const a = newPopulation("Middle ", [newGateRef("g1", true)], root.population_id);
    const b = newPopulation(" Outer", [newGateRef("g1", false)], root.population_id);
    let populations: PopulationMap = { [root.population_id]: root, [a.population_id]: a, [b.population_id]: b };
    populations = linkChildToParent(populations, a.population_id, root.population_id);
    populations = linkChildToParent(populations, b.population_id, root.population_id);
    for (const format of ["standard", "cytobank"] as const) {
      const out = exportGatingML({ gates: { g1: gate }, gate_order: ["g1"], populations, root_population_id: root.population_id,
        sample: s, format, timestamp: "2026-01-01T00:00:00" });
      const back = evaluate(out, sampleOf("flow", { "FSC-A": [1, 5, 9], "SSC-A": [1, 5, 9] }));
      const names = Object.values(back.res.populations).filter((p) => p.population_id !== back.res.root_population_id).map((p) => p.name).sort();
      expect(names, format).toEqual([" Outer", "Middle "]);
      expect(back.byName("Middle "), format).toEqual([0, 1, 0]);
      expect(gateNames(back.res), format).toContain("Gate one ");
    }
  });

  it("still drops the line breaks and indentation a formatter puts around a name", () => {
    const xml = gml(`
      <gating:RectangleGate gating:id="R">
        <data-type:custom_info><cytobank><name>
          Pretty
        </name></cytobank></data-type:custom_info>
        <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
      </gating:RectangleGate>`);
    expect(gateNames(evaluate(xml, sampleOf("flow", { "FSC-A": [1] })).res)).toEqual(["Pretty"]);
  });
});
