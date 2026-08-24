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
// raw with densified polygon edges. Both forms are BOUNDED rather than exact, and the bounds have
// different causes: a polygon by the densification tolerance, a rectangle by float precision at
// the boundary (a monotonic transform preserves an axis-aligned box's geometry exactly, but the
// two membership predicates can differ by an ulp -- see the rectangle case). Class 1 is the only
// thing asserted exact here.

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
  // Real, PARTIAL populations, with the boundary running through dense data — which is the only
  // place a round trip can go wrong. The previous shapes spanned this fixture's whole fluorescence
  // range and held 1079 of its 1080 events, so "membership survived" was nearly unfalsifiable:
  // shifting an edge by 1% of the gate's extent moved zero events, because the edges sat in empty
  // space. These bounds come from the fixture's own quantiles (PE-A q25/q75 = -2/11,
  // PE-Cy7-A q25/q75 = 10/32), and a 1% edge shift now moves 1.3-2.3% of the gate, two orders
  // above the Class 2 tolerance below. assertPartial keeps it that way.
  const rectRaw: Vertex[] = [[-2, 10], [11, 10], [11, 32], [-2, 32]];
  // Spans negative on both axes — the region where transforms bend hardest.
  const polyRaw: Vertex[] = [[-11, 0], [11, 0], [25, 32], [4, 61], [-11, 21]];
  // wsplog clamps at its offset, so its gate must sit strictly positive to stay meaningful.
  const wsplogRect: Vertex[] = [[2, 2], [25, 2], [25, 61], [2, 61]];

  const asinhSpec = (cf: number): TransformSpec => ({ kind: "asinh", cofactor: cf });
  const logicleSpecFor = (key: string): TransformSpec =>
    sample.transformSpec(key) as TransformSpec; // the fixture's own estimated logicle
  const biexSpec: TransformSpec = {
    // The S6 workspace's own parameters (FlowJo 10.9 defaults for this instrument).
    kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256,
  };
  const wsplogSpec: TransformSpec = { kind: "wsplog", offset: 1, decades: 4.5 };

  /**
   * A gate that holds almost every event cannot test membership: there is nothing outside it to
   * move in, so the assertion passes however the round trip behaves. `events > 0 && < n` was meant
   * to catch that and did not -- it passed on a gate holding 1079 of 1080. A real band is the fix.
   */
  const assertPartial = (name: string, events: number, n: number) => {
    const frac = events / n;
    expect(frac, `"${name}" holds ${events}/${n} — too small to test membership`).toBeGreaterThan(0.05);
    expect(frac, `"${name}" holds ${events}/${n} — an almost-everything gate cannot fail`).toBeLessThan(0.95);
  };

  const assertExact = (gates: Gate[]) => {
    const back = roundTrip(sample, gates);
    for (const g of gates) {
      const before = maskOf(sample, g);
      const events = before.reduce((s, v) => s + v, 0);
      assertPartial(g.name, events, before.length);
      expect(moved(before, maskOf(sample, back.get(g.name)!)), `"${g.name}" events moved`).toBe(0);
    }
  };

  /**
   * Class 2's bounded counterpart. `frac` is the share of a gate's own events allowed to move,
   * floored at one event so a small population is not held to a stricter standard than a large
   * one. Kept separate from assertExact so that "exact" keeps meaning exact.
   */
  const assertWithin = (gates: Gate[], frac: number) => {
    const back = roundTrip(sample, gates);
    for (const g of gates) {
      const before = maskOf(sample, g);
      const events = before.reduce((s, v) => s + v, 0);
      assertPartial(g.name, events, before.length);
      expect(moved(before, maskOf(sample, back.get(g.name)!)), `"${g.name}" events moved`)
        .toBeLessThanOrEqual(Math.max(1, Math.ceil(events * frac)));
    }
  };

  it("Class 1: raw gates return with identical membership", () => {
    assertExact([
      gateIn(sample, "raw rect", "rectangle", fx, fy, rectRaw, null),
      gateIn(sample, "raw poly", "polygon", fx, fy, polyRaw, null),
    ]);
  });

  it("Class 1: arcsinh display gates return with identical membership", () => {
    const spec = { x: asinhSpec(150), y: asinhSpec(150) };
    assertExact([
      gateIn(sample, "asinh rect", "rectangle", fx, fy, rectRaw, spec),
      gateIn(sample, "asinh poly", "polygon", fx, fy, polyRaw, spec),
    ]);
  });

  it("Class 1: logicle display gates return with identical membership", () => {
    const spec = { x: logicleSpecFor(fx), y: logicleSpecFor(fy) };
    assertExact([
      gateIn(sample, "logicle rect", "rectangle", fx, fy, rectRaw, spec),
      gateIn(sample, "logicle poly", "polygon", fx, fy, polyRaw, spec),
    ]);
  });

  it("Class 2: a rectangle under biex or wsplog is bounded by float precision at the boundary", () => {
    // A monotonic transform maps an axis-aligned box to an axis-aligned box, so exporting these
    // raw preserves the GEOMETRY exactly. The arithmetic is what is not exact: GateLab evaluates
    // the original by forward-transforming each event and comparing against display-space corners,
    // while the re-imported gate compares raw values against LUT-inverted corners. The two
    // predicates agree in exact arithmetic and can differ by one float ulp, so an event sitting on
    // the boundary value can fall the other way.
    //
    // This case asserted exactness until 2026-08-24, and passed -- but only because no event in
    // this fixture sits that close to an edge. On the S6 FACSDiva data, whose values are quantised
    // so that several events share one boundary value, a biex rectangle moves 1 event of 1,518
    // (experiment GateLab-2026-08-15-B). Zero was therefore an accident of the fixture, not a
    // property of the round trip, and a test that encodes an accident fails for the wrong reason
    // the day the fixture changes. The bound below is two orders of magnitude tighter than any
    // real geometric regression, which moves a percent-level share of the gate.
    //
    // wsplog clamps below its offset, so its rectangle sits fully above it to stay meaningful.
    assertWithin([
      gateIn(sample, "biex rect", "rectangle", fx, fy, rectRaw,
        { x: biexSpec, y: biexSpec }),
      gateIn(sample, "wsplog rect", "rectangle", fx, fy, wsplogRect,
        { x: wsplogSpec, y: wsplogSpec }),
    ], 0.0005);
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
