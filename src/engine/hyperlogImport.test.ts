// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { Sample, transformFromSpec } from "./sample";
import { importGatingML } from "./gatingml";
import { exportGatingML } from "./gatingmlExport";
import { flowJoWorkspaceToGatingML } from "./flowjoWorkspace";
import { exportFlowJoWorkspace } from "./flowjoExport";
import { getGateMask } from "./gates";
import { gateSpaceBadge } from "./gateSpaceBadge";
import { parseTransformSpec } from "./rectangleRecord";
import { transformSpec as hostedTransformSpec } from "../host/hostedWorkspace";
import { requiredWorkspaceFeatures } from "./workspaceFeatures";
import type { FcsFile } from "./fcs";
import type { Gate, TransformSpec } from "./models";
import oracle from "./__fixtures__/hyperlog-oracle.json";

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";
const ns = `xmlns:gating="${G}" xmlns:data-type="${D}" xmlns:transforms="${T}"`;
const spec = { kind: "hyperlog" as const, T: 1000, W: 1, M: 4, A: 0 };
const ref = oracle.cases[0];
const inv = (display: number): number => {
  const i = ref.display.findIndex((v) => Math.abs(v - display) < 1e-12);
  if (i < 0) throw new Error("coordinate absent from independent oracle");
  return ref.inverse[i];
};
const values = [-10, 0, 1, 10, 100, 1000];
const points = values.flatMap((x) => values.map((y) => [x, y]));
const forward = new Map(ref.raw.map((v, i) => [v, ref.forward[i]]));
const desired = points.map(([x, y]) => {
  const a = forward.get(x)!, b = forward.get(y)!;
  return a >= .2 && b >= .2 && a + b <= 1 ? 1 : 0;
});
const sample = () => new Sample({ version: "FCS3.1", nEvents: points.length, instrument: "flow", keywords: {}, spillover: null,
  channels: ["X", "Y"].map((name, index) => ({ name, index, marker: null, bits: 64, range: 1000 })),
  columns: [0, 1].map((j) => Float64Array.from(points, (p) => p[j])),
} as FcsFile);
const dims = (reference = "") => ["X", "Y"].map((ch) => `<gating:dimension ${reference}><data-type:fcs-dimension data-type:name="${ch}"/></gating:dimension>`).join("");
const triangle = (raw = false) => [[.2, .2], [.8, .2], [.2, .8]].map((v) => `<gating:vertex>${v.map((x) => `<gating:coordinate data-type:value="${raw ? inv(x) : x}"/>`).join("")}</gating:vertex>`).join("");
const transform = (attrs = 'transforms:T="1000" transforms:W="1" transforms:M="4" transforms:A="0"') => `<transforms:hyperlog ${attrs}/>`;
const gml = (attrs?: string) => `<gating:Gating-ML ${ns}><transforms:transformation transforms:id="H">${transform(attrs)}</transforms:transformation><gating:PolygonGate gating:id="CD4_positive">${dims('gating:transformation-ref="H"')}${triangle()}</gating:PolygonGate></gating:Gating-ML>`;
const wsp = (attrs?: string) => `<Workspace ${ns}><SampleList><Sample><Transformations>${["X", "Y"].map((ch) => transform(attrs).replace("/>", `><data-type:parameter data-type:name="${ch}"/></transforms:hyperlog>`)).join("")}</Transformations><SampleNode name="D1.fcs" count="36"><Subpopulations><Population name="CD4_positive" count="12"><Gate><gating:PolygonGate gating:id="g1" gateResolution="256">${dims()}${triangle(true)}</gating:PolygonGate></Gate></Population></Subpopulations></SampleNode></Sample></SampleList></Workspace>`;
const read = (xml: string) => importGatingML(xml, ["X", "Y"], {}, "flow");
const mask = (xml: string): number[] => {
  const g = Object.values(read(xml).gates)[0], s = sample();
  return Array.from(getGateMask(g, s.gatingDataFor(g)));
};

describe("Hyperlog import and complete persistence", () => {
  it("evaluates a Gating-ML polygon in its independently specified display space", () => {
    expect(mask(gml())).toEqual(desired);
    expect(Object.values(read(gml()).gates)[0].transforms).toEqual({ X: spec, Y: spec });
  });

  it("carries a FlowJo hyperlog polygon and rectangle into Hyperlog display space", () => {
    // A FlowJo workspace declares hyperlog with Gating-ML Hyperlog's T, W, M and A, and writes
    // polygon and rectangle coordinates raw. Both gates must come back on a Hyperlog axis with
    // the declared parameters, with no RAW-space warning, in either grid mode (hyperlog has no
    // FlowJo grid rule here, so the polygon stays continuous).
    const ch = ["CH1-A", "CH2-A"];
    const flowJoDims = (lo?: number, hi?: number) => ch.map((c) =>
      `<gating:dimension${lo === undefined ? "" : ` gating:min="${lo}" gating:max="${hi}"`}><data-type:fcs-dimension data-type:name="${c}"/></gating:dimension>`).join("");
    const transforms = ch.map((c) => transform().replace("/>", `><data-type:parameter data-type:name="${c}"/></transforms:hyperlog>`)).join("");
    const polygon = `<Population name="CD4_positive" count="2"><Gate><gating:PolygonGate gating:id="g1" gateResolution="256">${flowJoDims()}${triangle(true)}</gating:PolygonGate></Gate></Population>`;
    const rectangle = `<Population name="CD8_positive" count="2"><Gate><gating:RectangleGate gating:id="g2">${flowJoDims(inv(.2), inv(.8))}</gating:RectangleGate></Gate></Population>`;
    const flowJo = `<Workspace ${ns}><SampleList><Sample><Transformations>${transforms}</Transformations><SampleNode name="D2.fcs" count="6"><Subpopulations>${polygon}${rectangle}</Subpopulations></SampleNode></Sample></SampleList></Workspace>`;

    // Events either side of the triangle's long edge, which is straight in display space and
    // curved in raw. The first two sit one oracle step inside and outside it on the diagonal;
    // the third is inside the straight-in-raw triangle but beyond the edge in display space.
    const rawMid = 0.9 * (inv(.8) + inv(.2)) / 2;
    expect(rawMid).toBeGreaterThan(inv(16 / 30)); // so its display coordinates exceed 16/30
    const xs = [inv(14 / 30), inv(16 / 30), rawMid, inv(.3), inv(.1), inv(.9)];
    const events = xs.map((x) => [x, x]);
    const inPolygon = [1, 0, 0, 1, 0, 0];
    const inRectangle = [1, 1, 1, 1, 0, 0];
    const s = new Sample({ version: "FCS3.1", nEvents: events.length, instrument: "flow", keywords: {}, spillover: null,
      channels: ch.map((name, index) => ({ name, index, marker: null, bits: 64, range: 1000 })),
      columns: [0, 1].map((j) => Float64Array.from(events, (e) => e[j])),
    } as FcsFile);
    const maskOf = (g: Gate) => Array.from(getGateMask(g, s.gatingDataFor(g)));

    for (const flowJoGrid of [true, false]) {
      const converted = flowJoWorkspaceToGatingML(flowJo, 0, null, undefined, { flowJoGrid });
      expect(converted.warnings.join(" ")).not.toContain("RAW space");
      expect(converted.gridPolygons).toBe(0);
      const gates = Object.values(importGatingML(converted.gatingMl, ch, {}, "flow").gates);
      expect(gates).toHaveLength(2);
      const [poly, rect] = ["polygon", "rectangle"].map((type) => gates.find((g) => g.gate_type === type)!);
      for (const g of [poly, rect]) expect(g.transforms).toEqual({ "CH1-A": spec, "CH2-A": spec });
      const vertices = (poly as unknown as { vertices: [number, number][] }).vertices;
      [[.2, .2], [.8, .2], [.2, .8]].forEach((v, i) => v.forEach((c, j) => expect(vertices[i][j]).toBeCloseTo(c, 9)));
      expect(maskOf(poly)).toEqual(inPolygon);
      expect(maskOf(rect)).toEqual(inRectangle);
      // The same vertices straight in raw count the second and third events, which the edge in
      // display space excludes.
      const straight = { ...poly, space: "raw", transforms: undefined,
        vertices: [[inv(.2), inv(.2)], [inv(.8), inv(.2)], [inv(.2), inv(.8)]] } as unknown as Gate;
      expect(maskOf(straight)).toEqual([1, 1, 1, 1, 0, 0]);
    }
  });

  it("still skips a FlowJo ellipse on a hyperlog axis, with its warning", () => {
    // Where FlowJo writes an ellipse's channels on a hyperlog axis has not been checked against a
    // FlowJo export, so the ellipse is not placed, as before hyperlog axes were read.
    const transforms = ["X", "Y"].map((c) => transform().replace("/>", `><data-type:parameter data-type:name="${c}"/></transforms:hyperlog>`)).join("");
    const ellipse = `<Population name="CD4_positive" count="1"><Gate><gating:EllipsoidGate gating:id="e1" gating:distance="52">${dims()}<gating:foci><gating:vertex><gating:coordinate data-type:value="100"/><gating:coordinate data-type:value="128"/></gating:vertex><gating:vertex><gating:coordinate data-type:value="120"/><gating:coordinate data-type:value="128"/></gating:vertex></gating:foci></gating:EllipsoidGate></Gate></Population>`;
    const polygon = `<Population name="CD8_positive" count="12"><Gate><gating:PolygonGate gating:id="g1" gateResolution="256">${dims()}${triangle(true)}</gating:PolygonGate></Gate></Population>`;
    const converted = flowJoWorkspaceToGatingML(`<Workspace ${ns}><SampleList><Sample><Transformations>${transforms}</Transformations><SampleNode name="D1.fcs" count="13"><Subpopulations>${ellipse}${polygon}</Subpopulations></SampleNode></Sample></SampleList></Workspace>`, 0);
    expect(converted.warnings.join(" ")).toMatch(/"CD4_positive" is an ellipse .* skipped/);
    expect(converted.gatingMl).not.toContain("EllipsoidGate");
    expect(converted.gatingMl).toContain('gating:name="CD8_positive"');
  });

  it("marks a Gating-ML Hyperlog gate's space on its badge", () => {
    const gate = Object.values(read(gml()).gates)[0];
    expect(gateSpaceBadge(sample(), gate)?.text).toBe("HH*");
  });

  it("rejects missing, nonnumeric, zero-width or out-of-domain parameters", () => {
    for (const attrs of [
      'transforms:T="1000" transforms:W="1" transforms:M="4"',
      'transforms:T="1000" transforms:W="0" transforms:M="4" transforms:A="0"',
      'transforms:T="1000" transforms:W="1" transforms:M="4" transforms:A="-2"',
      'transforms:T="1000" transforms:W="1" transforms:M="0x4" transforms:A="0"',
    ]) expect(() => read(gml(attrs))).toThrow(/hyperlog/i);
    const converted = flowJoWorkspaceToGatingML(wsp('transforms:T="1000" transforms:W="0" transforms:M="4" transforms:A="0"'), 0);
    expect(converted.warnings.join(" ")).toContain("RAW space");
  });

  it("keeps Hyperlog distinct in serialized gate records and hosted workspaces", () => {
    const bounded: TransformSpec = { ...spec, A: -.5, bounds: { min: .1, max: .9 } };
    expect(parseTransformSpec(bounded)).toEqual(bounded);
    expect(hostedTransformSpec(bounded, "gate axis")).toEqual(bounded);
    expect(parseTransformSpec({ ...spec, W: 0 })).toBeNull();
    expect(requiredWorkspaceFeatures({ nested: [{ transforms: { X: bounded } }] })).toEqual(["hyperlog"]);
    const f = transformFromSpec(bounded).forward;
    expect(f(-1e6)).toBe(.1);
    expect(f(1e6)).toBe(.9);
  });

  it("exports standards-compliant Hyperlog and restores the same event membership", () => {
    const s = sample(), res = read(gml());
    const xml = exportGatingML({ sample: s, ...res, gate_order: Object.keys(res.gates), format: "standard", timestamp: "2026-01-01T00:00:00" });
    expect(xml).toContain("<transforms:hyperlog ");
    expect(xml).not.toContain("<transforms:logicle ");
    expect(mask(xml)).toEqual(desired);
    const check = spawnSync("xmllint", ["--noout", "--schema", "src/engine/__fixtures__/gatingml-2.0-xsd/Gating-ML.v2.0.xsd", "-"], { input: xml, encoding: "utf8" });
    expect(check.status, check.stderr).toBe(0);
  });

  it("keeps Hyperlog when its own FlowJo export is read back", () => {
    const s = sample(), res = read(gml());
    const { xml } = exportFlowJoWorkspace({ samples: [{ sample: s, fileName: "D1.fcs", ...res, gate_order: Object.keys(res.gates) }], now: new Date("2026-01-01T00:00:00Z") });
    const converted = flowJoWorkspaceToGatingML(xml, 0);
    expect(mask(converted.gatingMl)).toEqual(desired);
    expect(Object.values(read(converted.gatingMl).gates)[0].transforms).toEqual({ X: spec, Y: spec });
  });

  it("preserves a lower-inclusive upper-exclusive Hyperlog rectangle at its exact zero and top", () => {
    // Zero and T have exactly specified coordinates. An independently rounded inverse at an
    // arbitrary display coordinate is not necessarily an event exactly on that boundary.
    const raw = [-1, 0, 1, 999.9999, 1000, 1000.0001];
    const s = new Sample({ version: "FCS3.1", nEvents: raw.length, instrument: "flow", keywords: {}, spillover: null,
      channels: [{ name: "X", index: 0, marker: null, bits: 64, range: 1000 }], columns: [Float64Array.from(raw)],
    } as FcsFile);
    const xml = `<gating:Gating-ML ${ns}><transforms:transformation transforms:id="H">${transform()}</transforms:transformation><gating:RectangleGate gating:id="CD4_positive"><gating:dimension gating:min=".25" gating:max="1" gating:transformation-ref="H"><data-type:fcs-dimension data-type:name="X"/></gating:dimension></gating:RectangleGate></gating:Gating-ML>`;
    const g = Object.values(importGatingML(xml, ["X"], {}, "flow").gates)[0];
    expect(Array.from(getGateMask(g, s.gatingDataFor(g)))).toEqual([0, 1, 1, 1, 0, 0]);
  });
});
