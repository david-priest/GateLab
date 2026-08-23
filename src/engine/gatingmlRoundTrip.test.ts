// @vitest-environment jsdom
//
// The Class 1 self round-trip: export a gate to Gating-ML, import it back, and the SAME engine
// must assign the SAME events — not approximately, identically. For any gate whose space
// Gating-ML can express (raw, arcsinh, logicle) a difference is a bug, never a finding.
//
// This is the assertion the per-gate coordinate-space work exists to make true, and the paper's
// round-trip leg (concordance plan §3B) depends on it holding. It lives in npm test rather than
// only in the notebook because the notebook runs manually, and this is exactly the kind of
// invariant a refactor of transform(), transformSpec() or the exporter could silently break.
//
// FlowJo's biex and wsplog (Class 2) have no Gating-ML representation, so those gates export as
// raw with densified polygon edges. Rectangles must survive that EXACTLY (a monotonic transform
// maps an axis-aligned box to an axis-aligned box); polygons are bounded by the densification
// tolerance, and the bound is measured here rather than assumed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";
import { exportGatingML, analyzeGatingMLQuadrantOmissions } from "./gatingmlExport";
import { importGatingML } from "./gatingml";
import { getGateMask, columnsForGate } from "./gates";
import { newRootPopulation, newPopulation, newGateRef, linkChildToParent, type Gate, type PopulationMap, type TransformSpec, type Vertex } from "./models";
import { ARIA_SMALL } from "../testFixtures";

function load(): Sample {
  const b = readFileSync(ARIA_SMALL);
  return new Sample(parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}

const uuid = () => crypto.randomUUID();

/** Membership mask for a gate, evaluated in ITS OWN space. */
function maskOf(sample: Sample, gate: Gate): Uint8Array {
  return getGateMask(gate, columnsForGate(sample.gateAssayData(), gate));
}

/** Events assigned differently by two gates. */
function moved(a: Uint8Array, b: Uint8Array): number {
  expect(b.length).toBe(a.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

/** Wrap gates in the minimal population tree exportGatingML requires. */
function workspaceFor(gates: Gate[]) {
  const byId: Record<string, Gate> = {};
  const order: string[] = [];
  const root = newRootPopulation();
  let pops: PopulationMap = { [root.population_id]: root };
  for (const g of gates) {
    byId[g.gate_id] = g;
    order.push(g.gate_id);
    const p = newPopulation(g.name, [newGateRef(g.gate_id, true)], root.population_id);
    pops[p.population_id] = p;
    pops = linkChildToParent(pops, p.population_id, root.population_id);
  }
  return { gates: byId, gate_order: order, populations: pops, root_population_id: root.population_id };
}

/** Export → import, and return the re-imported gates matched to the originals by name. */
function roundTrip(sample: Sample, gates: Gate[]): Map<string, Gate> {
  const ws = workspaceFor(gates);
  const xml = exportGatingML({ ...ws, sample, format: "standard", timestamp: "2026-01-01T00:00:00" });
  const res = importGatingML(xml, sample.channelNames(), {}, "flow");
  expect(res.n_gates_imported).toBe(gates.length);
  const byName = new Map<string, Gate>();
  for (const g of Object.values(res.gates)) byName.set(g.name, g);
  for (const g of gates) expect(byName.has(g.name), `"${g.name}" survived the trip`).toBe(true);
  return byName;
}

/** A gate whose vertices are the given RAW shape pushed into `spec`'s space (or left raw). */
function gateIn(
  sample: Sample,
  name: string,
  type: "rectangle" | "polygon",
  x: string,
  y: string,
  rawVerts: Vertex[],
  specs: { x: TransformSpec; y: TransformSpec } | null,
): Gate {
  const base = {
    gate_id: uuid(), name, gate_type: type, x_channel: x, y_channel: y,
    color: "#377eb8", label_offset: null,
  };
  if (!specs) return { ...base, vertices: rawVerts, space: "raw" } as Gate;
  const g = {
    ...base,
    vertices: rawVerts,
    space: "display",
    transforms: { [x]: specs.x, [y]: specs.y },
  } as Gate & { vertices: Vertex[] };
  // Push the raw shape through the gate's own transforms, so the stored vertices live where
  // the gate says they do — the same thing newGateSpaceFields + drawing would produce.
  g.vertices = rawVerts.map(([vx, vy]) => [
    sample.rawToGate(g, x, vx),
    sample.rawToGate(g, y, vy),
  ]);
  return g;
}

describe("Gating-ML self round-trip", () => {
  const sample = load();
  const fluor = sample.channels.filter((_, i) => sample.isLogicleChannel(i)).map((c) => c.key);
  const [fx, fy] = fluor;
  // Real, partial populations: bounds from the fixture's quantiles so no mask is all-in/all-out.
  const rectRaw: Vertex[] = [[20000, 10000], [80000, 10000], [80000, 90000], [20000, 90000]];
  // Spans negative on both axes — the region where transforms bend hardest.
  const polyRaw: Vertex[] = [[-150, -80], [2500, -80], [3500, 4000], [400, 7000], [-150, 1500]];

  const asinhSpec = (cf: number): TransformSpec => ({ kind: "asinh", cofactor: cf });
  const logicleSpecFor = (key: string): TransformSpec =>
    sample.transformSpec(key) as TransformSpec; // the fixture's own estimated logicle
  const biexSpec: TransformSpec = {
    // The S6 workspace's own parameters (FlowJo 10.9 defaults for this instrument).
    kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256,
  };
  const wsplogSpec: TransformSpec = { kind: "wsplog", offset: 1, decades: 4.5 };

  const assertExact = (gates: Gate[]) => {
    const back = roundTrip(sample, gates);
    for (const g of gates) {
      const before = maskOf(sample, g);
      const events = before.reduce((s, v) => s + v, 0);
      expect(events, `"${g.name}" holds a real population`).toBeGreaterThan(0);
      expect(events, `"${g.name}" is not all-in`).toBeLessThan(before.length);
      expect(moved(before, maskOf(sample, back.get(g.name)!)), `"${g.name}" events moved`).toBe(0);
    }
  };

  it("Class 1: raw gates return with identical membership", () => {
    assertExact([
      gateIn(sample, "raw rect", "rectangle", "FSC-A", "SSC-A", rectRaw, null),
      gateIn(sample, "raw poly", "polygon", fx, fy, polyRaw, null),
    ]);
  });

  it("Class 1: arcsinh display gates return with identical membership", () => {
    const spec = { x: asinhSpec(150), y: asinhSpec(150) };
    assertExact([
      gateIn(sample, "asinh rect", "rectangle", fx, fy, polyRawBox(polyRaw), spec),
      gateIn(sample, "asinh poly", "polygon", fx, fy, polyRaw, spec),
    ]);
  });

  it("Class 1: logicle display gates return with identical membership", () => {
    const spec = { x: logicleSpecFor(fx), y: logicleSpecFor(fy) };
    assertExact([
      gateIn(sample, "logicle rect", "rectangle", fx, fy, polyRawBox(polyRaw), spec),
      gateIn(sample, "logicle poly", "polygon", fx, fy, polyRaw, spec),
    ]);
  });

  it("Class 2: a rectangle under biex or wsplog survives exactly through raw", () => {
    // No Gating-ML representation exists, so these export as raw — which is EXACT for an
    // axis-aligned box under any monotonic transform. wsplog clamps below its offset, so its
    // rectangle sits fully above it to stay meaningful.
    assertExact([
      gateIn(sample, "biex rect", "rectangle", fx, fy, polyRawBox(polyRaw),
        { x: biexSpec, y: biexSpec }),
      gateIn(sample, "wsplog rect", "rectangle", fx, fy, [[50, 40], [6000, 40], [6000, 9000], [50, 9000]],
        { x: wsplogSpec, y: wsplogSpec }),
    ]);
  });

  it("Class 2: a polygon under biex is bounded by densification, and the bound is small", () => {
    const g = gateIn(sample, "biex poly", "polygon", fx, fy, polyRaw, { x: biexSpec, y: biexSpec });
    const before = maskOf(sample, g);
    const events = before.reduce((s, v) => s + v, 0);
    expect(events).toBeGreaterThan(0);

    const back = roundTrip(sample, [g]).get(g.name)!;
    const movedEvents = moved(before, maskOf(sample, back));
    // The densified boundary is within 0.2% of the gate's extent of the true curve, so on this
    // fixture the expectation is zero moved events; anything beyond a fraction of a percent of
    // the gate means densification regressed, not that the data got unlucky.
    expect(movedEvents).toBeLessThanOrEqual(Math.max(1, Math.ceil(events * 0.005)));
  });

  it("quadrant gates are refused, not silently dropped", () => {
    const q: Gate = {
      gate_id: uuid(), name: "Q", gate_type: "quadrant", x_channel: fx, y_channel: fy,
      center: [500, 500], color: "#888", label_offset: null,
    } as unknown as Gate;
    const ws = workspaceFor([q]);
    expect(analyzeGatingMLQuadrantOmissions(ws.gates, ws.populations).gateIds).toContain(q.gate_id);
    expect(() => exportGatingML({ ...ws, sample, format: "standard", timestamp: "t" }))
      .toThrow(/quadrant/i);
  });
});

/** The bounding box of a polygon, as 4 rectangle corners in the same raw units. */
function polyRawBox(poly: Vertex[]): Vertex[] {
  const xs = poly.map((v) => v[0]);
  const ys = poly.map((v) => v[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}
