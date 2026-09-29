// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFcs, type FcsFile } from "./fcs";
import { Sample } from "./sample";
import { analyzeCytobankOrOmissions, analyzeGatingMLQuadrantOmissions, exportGatingML, fmtNum, skirtRing, splitAtKnots, tieBreakPolygon } from "./gatingmlExport";
import { importGatingML, resolveGatingMLCompensation, restoreGatingMLScaleState } from "./gatingml";
import { gateMaskPolygon, getGateMask } from "./gates";
import { applyGatingStrategy } from "./populations";
import {
  newRootPopulation,
  newPopulation,
  newGateRef,
  linkChildToParent,
  type Gate,
  type PopulationMap,
  type Vertex,
} from "./models";
import { ARIA_SMALL } from "../testFixtures";
import { writeFcs } from "./fcsExport";


function loadArrayBuffer(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

const uuid = () => crypto.randomUUID();

/** Build a small workspace: a scatter rectangle and a fluorophore polygon, with a
 *  positive-AND parent→child population tree. Returns raw-space gates. */
function buildWorkspace(sample: Sample) {
  // scatter x scatter (FSC-A x SSC-A → fasinh) and fluor x fluor (→ logicle)
  const scatterIdx = sample.channels.findIndex((_, i) => sample.transformKind(i) === "asinh");
  const scatter2 = sample.channels.findIndex(
    (_, i) => sample.transformKind(i) === "asinh" && i !== scatterIdx,
  );
  const logicleIdxs = sample.channels
    .map((_, i) => i)
    .filter((i) => sample.transformKind(i) === "logicle");
  const [fx, fy] = [logicleIdxs[0], logicleIdxs[1]];

  const sKeyX = sample.channels[scatterIdx].key;
  const sKeyY = sample.channels[scatter2].key;
  const fKeyX = sample.channels[fx].key;
  const fKeyY = sample.channels[fy].key;

  // Rectangle in RAW scatter space.
  const rectVerts: Vertex[] = [
    [20000, 10000],
    [80000, 10000],
    [80000, 90000],
    [20000, 90000],
  ];
  // Polygon in RAW fluorophore space (spans negative → positive, like real logicle data).
  const polyVerts: Vertex[] = [
    [-200, -100],
    [3000, -100],
    [4000, 5000],
    [500, 8000],
    [-200, 2000],
  ];

  const rect: Gate = {
    gate_id: uuid(),
    name: "Cells",
    gate_type: "rectangle",
    x_channel: sKeyX,
    y_channel: sKeyY,
    vertices: rectVerts,
    color: "#e41a1c",
    label_offset: null,
  };
  const poly: Gate = {
    gate_id: uuid(),
    name: "PE+APC gate",
    gate_type: "polygon",
    x_channel: fKeyX,
    y_channel: fKeyY,
    vertices: polyVerts,
    color: "#377eb8",
    label_offset: null,
  };
  const gates: Record<string, Gate> = { [rect.gate_id]: rect, [poly.gate_id]: poly };
  const gate_order = [rect.gate_id, poly.gate_id];

  const root = newRootPopulation();
  let pops: PopulationMap = { [root.population_id]: root };
  const pCells = newPopulation("Cells", [newGateRef(rect.gate_id, true)], root.population_id);
  pops[pCells.population_id] = pCells;
  pops = linkChildToParent(pops, pCells.population_id, root.population_id);
  const pSignal = newPopulation("PE+APC+ of Cells", [newGateRef(poly.gate_id, true)], pCells.population_id);
  pops[pSignal.population_id] = pSignal;
  pops = linkChildToParent(pops, pSignal.population_id, pCells.population_id);

  return { gates, gate_order, populations: pops, root_population_id: root.population_id };
}
/**
 * The same workspace with every gate in DISPLAY space, snapshotting the sample's transforms.
 *
 * A raw gate now exports with no transformation-ref at all — that is the whole point of Phase 4 —
 * so the cases that assert what GateLab *declares* have to use gates that declare something.
 */
function asDisplayWorkspace(sample: Sample, ws: ReturnType<typeof buildWorkspace>) {
  const gates: Record<string, Gate> = {};
  for (const [gid, g] of Object.entries(ws.gates)) {
    const toDisp = (v: Vertex): Vertex => [
      sample.rawToDisplay(g.x_channel, v[0]),
      sample.rawToDisplay(g.y_channel, v[1]),
    ];
    gates[gid] = {
      ...g,
      vertices: (g as { vertices: Vertex[] }).vertices.map(toDisp),
      ...sample.newGateSpaceFields("display", g.x_channel, g.y_channel),
    } as Gate;
  }
  return { ...ws, gates };
}


// Cytobank has exactly three scale types: Linear (flag 1), Log (2) and Arcsinh (4). Its own
// exports confirm it — a CyTOF experiment writes transforms:fasinh with "flag":4, and a flow
// experiment writes transforms:flog with "flag":2. Neither ever writes transforms:logicle, and
// there is no flag 5.
//
// GateLab used to emit logicle with "flag":5 for flow fluorescence, producing a file Cytobank
// rejects. It went unnoticed because every earlier test of this format used CyTOF data, where
// everything is arcsinh already and the logicle branch is never reached. These tests use FLOW
// data specifically, so that gap cannot reopen.
describe("Cytobank format never emits a scale Cytobank cannot read (flow)", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const ws = buildWorkspace(sample);
  // Display-space gates, because only a gate that declares a transform can declare a WRONG one.
  const dispWs = asDisplayWorkspace(sample, ws);
  const xml = exportGatingML({ ...dispWs, sample, format: "cytobank", timestamp: "2026-01-01T00:00:00" });
  const rawXml = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "2026-01-01T00:00:00" });

  it("declares no logicle transform", () => {
    expect(sample.instrument).toBe("flow"); // the case the old tests never covered
    expect(xml).not.toContain("transforms:logicle");
    expect(xml).toContain("transforms:fasinh");
  });

  // Phase 4: the export declares the space the gate is actually in. A raw gate is straight in raw,
  // so it declares nothing at all and writes raw values — which is what makes a compliant reader
  // reproduce GateLab's own populations instead of a transformed lookalike.
  it("declares nothing for raw-space gates, and writes their raw vertices", () => {
    expect(rawXml).not.toContain("transformation-ref");
    expect(rawXml).not.toContain("<transforms:");
    // The rectangle's raw bounds, verbatim, save the upper one: the fixture's rectangle has no
    // edge rule, so it is closed, and goes out just above its edge for a reader that follows
    // Gating-ML's [min, max) (gatingmlExport.ts, forEveryReader).
    expect(rawXml).toContain('gating:min="20000"');
    expect(rawXml).toContain('gating:max="90000.000000009"');
    // And Cytobank is told the axis is Linear, which is exactly true of a raw-space gate.
    expect(rawXml).toContain('"flag":1');
  });

  it("uses only Cytobank's own scale flags", () => {
    const flags = [...xml.matchAll(/"flag":(\d+)/g)].map((m) => Number(m[1]));
    expect(flags.length).toBeGreaterThan(0);
    // 1 = Linear, 2 = Log, 4 = Arcsinh. Anything else is not a Cytobank scale type.
    expect([...new Set(flags)].sort()).toEqual(
      [...new Set(flags)].filter((f) => [1, 2, 4].includes(f)).sort(),
    );
    expect(flags).not.toContain(5);
  });

  it("quotes the cofactor the vertices were actually transformed with", () => {
    // A definition JSON that names a cofactor the coordinates were not built from would place
    // every gate wrongly while importing cleanly — the worst outcome available here.
    const fluor = sample.channels.find((_c, i) => sample.transformKind(i) === "logicle");
    expect(fluor, "fixture has a logicle fluorescence channel").toBeTruthy();
    const m = xml.match(/<transforms:fasinh transforms:T="([0-9.]+)"/);
    expect(m).toBeTruthy();
    // fasinh(T = cf·sinh(1)) reduces to asinh(x / cf); recover cf and check it is the one the
    // arcsinh scale entries advertise.
    const cf = Number(m![1]) / Math.sinh(1);
    expect(xml).toContain(`"flag":4,"argument":"${Math.round(cf)}"`);
  });

  // A channel the user set to linear has no transform, so toExport() leaves its gate vertices in
  // raw space. The exporter declared fasinh for every scatter channel regardless, so a linear
  // SSC-A gate went out carrying a vertex of ~2.4e5 on an axis declared fasinh over [-2, 12].
  // Cytobank's Gating-ML upload hangs on that file and GateLab reported nothing wrong.
  it("declares no transform for a channel the user set to linear", () => {
    const s2 = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
    const ws2 = buildWorkspace(s2); // gates first: flow gates are stored raw, so rescaling is safe
    const linIdx = s2.channels.findIndex((_c, i) => s2.transformKind(i) === "asinh");
    expect(linIdx, "fixture has an arcsinh scatter channel").toBeGreaterThanOrEqual(0);
    s2.setScatterScale(linIdx, "linear");
    expect(s2.transformKind(linIdx)).toBe("identity");

    const out = exportGatingML({
      ...ws2, sample: s2, format: "cytobank", timestamp: "2026-01-01T00:00:00",
    });
    const dims = [
      ...out.matchAll(/<gating:dimension([^>]*)>\s*<data-type:fcs-dimension data-type:name="([^"]+)"/g),
    ];
    expect(dims.length).toBeGreaterThan(0);
    expect(dims.some((m) => m[2] === s2.channels[linIdx].key), "the linear channel is gated on").toBe(true);
    for (const [, attrs, name] of dims) {
      const idx = s2.index(name);
      if (idx !== undefined && s2.transformKind(idx) === "identity") {
        expect(attrs, `${name} is linear, so it must declare no transform`).not.toContain(
          "transformation-ref",
        );
      }
    }
  });

  it("never references a GateSet, and flattens ancestry like Cytobank does", () => {
    // Cytobank has no construct for a population referencing another population: every GateSet
    // is the AND of its whole ancestor chain of primitive gates, and its own exports reference
    // a GateSet exactly zero times. GateLab used to emit a parent GateSet reference plus a
    // "pop_N" token in the boolean expression — legal Gating-ML, round-trips with itself, and
    // rejected by Cytobank with no explanation.
    expect(xml).not.toMatch(/gating:ref="GateSet_/);
    expect(xml).toMatch(/gating:ref="Gate_/);

    const exprs = [...xml.matchAll(/"booleanExpression":"([^"]*)"/g)].map((m) => m[1]);
    expect(exprs.length).toBeGreaterThan(0);
    for (const e of exprs) expect(e).not.toMatch(/\bpop_\d+\b/);
    expect(xml).not.toContain("gatelabParent");

    // A child population must name its parent's gates too, not just its own.
    const nested = exprs.filter((e) => e.split(" AND ").length > 1);
    expect(nested.length, "fixture has a nested population").toBeGreaterThan(0);
  });

  it("still round-trips back into GateLab", () => {
    const back = importGatingML(xml, sample.channels.map((c) => c.key),
      Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key])), sample.instrument);
    expect(back.n_gates_imported).toBe(2);
  });
});

// The point of Phase 4: the file must describe the gate GateLab APPLIES, not a transformed
// lookalike. Previously the exporter forward-transformed raw vertices and declared the channel's
// transform, which per Gating-ML §2.3.2 means "straight in that space" — a different gate, and the
// spec calls that substitution naïve by name. Measured at Jaccard 0.984–0.997 on the S6 scatter
// gates against a compliant reader.
describe("the exported file declares the space each gate is actually in", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const ws = buildWorkspace(sample);

  /** The whole <gating:PolygonGate>/<gating:RectangleGate> element carrying this name. */
  function gateXml(xml: string, gateName: string): string {
    const all = xml.match(/<gating:(PolygonGate|RectangleGate)\b[\s\S]*?<\/gating:\1>/g) ?? [];
    const hit = all.find((g) => g.includes(`<name>${gateName}</name>`));
    expect(hit, `gate ${gateName} present`).toBeTruthy();
    return hit!;
  }
  /** Dimensions as the file states them: [channel, transformation-ref | null]. */
  function dimsOf(xml: string, gateName: string): [string, string | null][] {
    return [...gateXml(xml, gateName).matchAll(
      /<gating:dimension([^>]*)>\s*<data-type:fcs-dimension data-type:name="([^"]+)"/g,
    )].map((m) => [m[2], (/transformation-ref="([^"]+)"/.exec(m[1]) ?? [null, null])[1]]);
  }
  function vertsOf(xml: string, gateName: string): number[] {
    // Polygons carry data-type:value on each vertex; rectangles carry gating:min / gating:max
    // as attributes of the dimension itself.
    return [...gateXml(xml, gateName).matchAll(
      /(?:data-type:value|gating:min|gating:max)="([-0-9.eE]+)"/g,
    )].map((m) => Number(m[1]));
  }

  it("writes a raw gate as raw values with no transformation-ref", () => {
    const xml = exportGatingML({ ...ws, sample, format: "standard", timestamp: "2026-01-01T00:00:00" });
    for (const [, tr] of dimsOf(xml, "PE+APC gate")) expect(tr).toBeNull();
    // Verbatim: a reader joining these with straight segments in raw space reproduces GateLab's
    // own gate exactly, which is the property the old export did not have.
    const poly = Object.values(ws.gates).find((g) => g.name === "PE+APC gate")!;
    const expected = (poly as { vertices: [number, number][] }).vertices.flat();
    expect(vertsOf(xml, "PE+APC gate")).toEqual(expected);
  });

  it("writes a display gate in its own transform, and declares that transform", () => {
    const dispWs = asDisplayWorkspace(sample, ws);
    const xml = exportGatingML({ ...dispWs, sample, format: "standard", timestamp: "2026-01-01T00:00:00" });
    const rect = Object.values(dispWs.gates).find((g) => g.name === "Cells")!;
    const cf = (rect.transforms?.[rect.x_channel] as { cofactor: number }).cofactor;

    for (const [, tr] of dimsOf(xml, "Cells")) expect(tr).toBe(`Tr_Fasinh_${cf}`);
    expect(xml).toContain(`transforms:id="Tr_Fasinh_${cf}"`);
    // Vertices verbatim again — arcsinh display coordinates ARE fasinh(T = cf·sinh(1)) coordinates.
    // Compared with tolerance only because the writer formats to finite precision.
    const xs = (rect as { vertices: [number, number][] }).vertices.map((v) => v[0]);
    const written = vertsOf(xml, "Cells");
    expect(written.some((w) => Math.abs(w - Math.min(...xs)) < 1e-9)).toBe(true);
    expect(written.some((w) => Math.abs(w - Math.max(...xs)) < 1e-9)).toBe(true);
  });

  it("keeps two gates on the same channel in their own spaces", () => {
    // The reason the plan is per gate and not per channel: one channel, two answers.
    const dispWs = asDisplayWorkspace(sample, ws);
    const mixed = {
      ...ws,
      gates: {
        ...ws.gates,
        ...Object.fromEntries(
          Object.entries(dispWs.gates)
            .filter(([, g]) => g.name === "Cells")
            .map(([gid, g]) => [`${gid}-d`, { ...g, gate_id: `${gid}-d`, name: "Cells display" }]),
        ),
      },
      gate_order: [...ws.gate_order, `${Object.entries(ws.gates).find(([, g]) => g.name === "Cells")![0]}-d`],
    };
    const xml = exportGatingML({ ...mixed, sample, format: "standard", timestamp: "2026-01-01T00:00:00" });
    expect(dimsOf(xml, "Cells").every(([, tr]) => tr === null)).toBe(true);
    expect(dimsOf(xml, "Cells display").every(([, tr]) => tr !== null)).toBe(true);
  });
});

// Export and import must agree about what the file means, or GateLab quietly disagrees with
// itself: the round trip is the only place both halves of Phase 4 are exercised together.
describe("a gate survives export → import in the same space", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const ws = buildWorkspace(sample);

  function roundTrip(w: ReturnType<typeof buildWorkspace>) {
    const xml = exportGatingML({ ...w, sample, format: "standard", timestamp: "2026-01-01T00:00:00" });
    return importGatingML(xml, sample.channels.map((c) => c.key), {}, sample.instrument);
  }

  it("keeps a raw gate raw, selecting exactly the same events", () => {
    const res = roundTrip(ws);
    const before = Object.values(ws.gates).find((g) => g.name === "PE+APC gate")!;
    const after = Object.values(res.gates).find((g) => g.name === "PE+APC gate")!;
    expect(sample.gateSpace(after)).toBe("raw");
    expect(Array.from(getGateMask(after, sample.gatingDataFor(after))))
      .toEqual(Array.from(getGateMask(before, sample.gatingDataFor(before))));
  });

  it("keeps a display gate in display space, selecting exactly the same events", () => {
    const dispWs = asDisplayWorkspace(sample, ws);
    const res = roundTrip(dispWs);
    const before = Object.values(dispWs.gates).find((g) => g.name === "PE+APC gate")!;
    const after = Object.values(res.gates).find((g) => g.name === "PE+APC gate")!;
    expect(sample.gateSpace(after)).toBe("display");
    expect(after.transforms?.[after.x_channel]?.kind).toBe("logicle");
    expect(Array.from(getGateMask(after, sample.gatingDataFor(after))))
      .toEqual(Array.from(getGateMask(before, sample.gatingDataFor(before))));
  });

  it("does not collapse the two spaces into one representation", () => {
    // Guards the tests above from passing vacuously. Note these two gates select the SAME events
    // on this fixture: the polygon is compact, so the lens between its straight-in-raw edges and
    // its straight-in-logicle edges contains no events. That is expected — the divergence scales
    // with how far an edge spans the transform, which is why it showed up on real spanning gates
    // (Jaccard 0.984–0.997 on the S6 scatter gates) and not here.
    const rawG = Object.values(roundTrip(ws).gates).find((g) => g.name === "PE+APC gate")!;
    const dispG = Object.values(roundTrip(asDisplayWorkspace(sample, ws)).gates)
      .find((g) => g.name === "PE+APC gate")!;

    expect(sample.gateSpace(rawG)).toBe("raw");
    expect(sample.gateSpace(dispG)).toBe("display");
    expect(rawG.transforms).toBeUndefined();
    expect(dispG.transforms).toBeTruthy();
    // Same gate, two spaces: the stored numbers must not be the same numbers.
    const xs = (g: typeof rawG) => (g as { vertices: [number, number][] }).vertices.map((v) => v[0]);
    expect(xs(rawG)).not.toEqual(xs(dispG));
    // Each still selects a real, non-trivial population.
    for (const g of [rawG, dispG]) {
      const n = Array.from(getGateMask(g, sample.gatingDataFor(g))).reduce((a, v) => a + v, 0);
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(sample.fcs.nEvents);
    }
  });
});

describe("GatingML export → import round-trip (Aria III flow)", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const ws = buildWorkspace(sample);
  const sessionChannels = sample.channels.map((c) => c.key);
  const pnnMap: Record<string, string> = {};
  for (const c of sample.channels) pnnMap[c.pnn] = c.key;

  for (const format of ["standard", "cytobank"] as const) {
    describe(`${format} format`, () => {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "2026-01-01T00:00:00" });
      const back = importGatingML(xml, sessionChannels, pnnMap, sample.instrument);

      it("is valid XML with the right header + gate elements", () => {
        expect(xml).toContain("<gating:Gating-ML");
        expect(xml).toContain("<gating:RectangleGate");
        expect(xml).toContain("<gating:PolygonGate");
        expect(xml).toContain(format === "cytobank" ? "Cytobank-compatible" : "re-importable");
        // The standard format places populations with gating:parent_id; GatingHierarchy is not
        // a Gating-ML 2.0 element.
        expect(xml).not.toContain("<gating:GatingHierarchy");
        if (format === "standard") expect(xml).toMatch(/<gating:BooleanGate gating:id="GateSet_\d+" gating:parent_id="GateSet_\d+">/);
      });

      it("re-imports both gates with the same channels", () => {
        expect(back.n_gates_imported).toBe(2);
        const byName = Object.fromEntries(Object.values(back.gates).map((g) => [g.name, g]));
        expect(byName["Cells"].x_channel).toBe(ws.gates[ws.gate_order[0]].x_channel);
        expect(byName["PE+APC gate"].x_channel).toBe(ws.gates[ws.gate_order[1]].x_channel);
      });

      it("recovers the raw vertices through the transform round-trip", () => {
        const byName = Object.fromEntries(Object.values(back.gates).map((g) => [g.name, g]));
        // rectangle: AABB corners recovered (order-independent → compare min/max)
        const origRect = ws.gates[ws.gate_order[0]];
        const rx = byName["Cells"].gate_type !== "quadrant" ? (byName["Cells"] as { vertices: Vertex[] }).vertices : [];
        const oxs = origRect.gate_type === "polygon" || origRect.gate_type === "rectangle" ? origRect.vertices.map((v) => v[0]) : [];
        const rxs = rx.map((v) => v[0]);
        expect(Math.min(...rxs)).toBeCloseTo(Math.min(...oxs), 0);
        expect(Math.max(...rxs)).toBeCloseTo(Math.max(...oxs), 0);

        // polygon (logicle): every vertex recovered to within 1% (relative)
        const origPoly = ws.gates[ws.gate_order[1]];
        const rp = (byName["PE+APC gate"] as { vertices: Vertex[] }).vertices;
        const op = origPoly.gate_type === "polygon" || origPoly.gate_type === "rectangle" ? origPoly.vertices : [];
        expect(rp.length).toBe(op.length);
        for (let i = 0; i < op.length; i++) {
          for (let k = 0; k < 2; k++) {
            const denom = Math.max(Math.abs(op[i][k]), 1);
            expect(Math.abs(rp[i][k] - op[i][k]) / denom).toBeLessThan(0.01);
          }
        }
      });

      it("recovers the positive-AND population tree", () => {
        expect(back.n_pops_imported).toBe(2);
        const pops = Object.values(back.populations).filter((p) => p.parent_id !== null);
        const cells = pops.find((p) => p.name === "Cells");
        const signal = pops.find((p) => p.name.startsWith("PE+APC+"));
        expect(cells).toBeDefined();
        expect(signal).toBeDefined();
        // child's parent is the Cells population
        expect(signal!.parent_id).toBe(cells!.population_id);
        expect(signal!.gate_refs[0].include).toBe(true);
      });

      it("persists logicle W in gatelabr_scales", () => {
        expect(xml).toContain("<gatelabr_scales>");
        expect(back.scales).not.toBeNull();
      });

      it("round-trips transform-neutral axis endpoints and a non-default scatter cofactor", () => {
        const scatterIdx = sample.index("FSC-A")!;
        sample.setScatterCofactor(scatterIdx, 300);
        const chKey = sample.channels[scatterIdx].key;
        const displayRange: [number, number] = [-1, 8];
        const xml2 = exportGatingML({
          ...ws, sample, format, timestamp: "2026-01-01T00:00:00",
          globalScales: { [chKey]: displayRange },
        });
        const back2 = importGatingML(xml2, sessionChannels, pnnMap);
        // Version 4 (2026-09): the compensation record's reference, so older readers refuse.
        expect(xml2).toContain('"version":4');
        expect(back2.scales?.[chKey]?.lo).toBeCloseTo(displayRange[0], 6); // legacy reader field
        expect(back2.scales?.[chKey]?.hi).toBeCloseTo(displayRange[1], 6);
        expect(back2.scales?.[chKey]?.raw_lo).toBeCloseTo(300 * Math.sinh(displayRange[0]), 6);
        expect(back2.scales?.[chKey]?.raw_hi).toBeCloseTo(300 * Math.sinh(displayRange[1]), 3);

        const destination = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
        const restored = restoreGatingMLScaleState(destination, back2.scales, back2.cytof_cofactor);
        expect(destination.currentScatterCofactor(destination.index(chKey)!)).toBe(300);
        expect(restored.ranges[chKey][0]).toBeCloseTo(displayRange[0], 6);
        expect(restored.ranges[chKey][1]).toBeCloseTo(displayRange[1], 6);
      });
    });
  }
});

describe("GatingML CyTOF cofactor/display fidelity", () => {
  const mk = (values: number[]) => Float32Array.from(values);
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: 6,
    instrument: "cytof",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "Time", marker: null, bits: 32, range: 1 },
      { index: 1, name: "Ce140Di", marker: "CD3", bits: 32, range: 1 },
      { index: 2, name: "Nd144Di", marker: "CD19", bits: 32, range: 1 },
    ],
    columns: [
      mk([1, 2, 3, 4, 5, 6]),
      mk([0, 10, 100, 1000, 5000, 10000]),
      mk([0, 20, 200, 2000, 7000, 12000]),
    ],
  };

  it("restores the producer's cofactor before evaluating imported display-space gates", () => {
    const source = new Sample(fcs, { cytofCofactor: 10 });
    const root = newRootPopulation();
    const gate: Gate = {
      gate_id: uuid(), name: "Double positive", gate_type: "rectangle",
      x_channel: "CD3", y_channel: "CD19",
      vertices: [[1, 1], [7, 1], [7, 7], [1, 7]],
      color: "#377eb8", label_offset: null,
    };
    const pop = newPopulation("Double positive", [newGateRef(gate.gate_id)], root.population_id);
    let populations: PopulationMap = { [root.population_id]: root, [pop.population_id]: pop };
    populations = linkChildToParent(populations, pop.population_id, root.population_id);
    const displayRange: [number, number] = [-0.5, 6];
    const xml = exportGatingML({
      gates: { [gate.gate_id]: gate }, gate_order: [gate.gate_id], populations,
      root_population_id: root.population_id, sample: source, format: "standard",
      globalScales: { CD3: displayRange },
    });
    // The file names $PnN (Ce140Di), so the channel map the app always passes is needed here too.
    const imported = importGatingML(xml, source.channelNames(),
      Object.fromEntries(source.channels.map((c) => [c.pnn, c.key])));
    const destination = new Sample(fcs); // deliberately starts at the default cofactor 5
    const restored = restoreGatingMLScaleState(destination, imported.scales, imported.cytof_cofactor);

    expect(imported.cytof_cofactor).toBe(10);
    expect(destination.arcsinhCofactor).toBe(10);
    expect(restored.ranges.CD3[0]).toBeCloseTo(displayRange[0], 6);
    expect(restored.ranges.CD3[1]).toBeCloseTo(displayRange[1], 6);
    const importedGate = Object.values(imported.gates)[0];
    expect(Array.from(getGateMask(importedGate, destination.gatingData())))
      .toEqual(Array.from(getGateMask(gate, source.gatingData())));
  });
});

describe("GatingML compensation-state fidelity", () => {
  function fixture() {
    const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
    const ws = buildWorkspace(sample);
    const sessionChannels = sample.channels.map((c) => c.key);
    const pnnMap = Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key]));
    return { sample, ws, sessionChannels, pnnMap };
  }

  it("exports uncompensated dimensions and restores compensation off", () => {
    const { sample, ws, sessionChannels, pnnMap } = fixture();
    const xml = exportGatingML({ ...ws, sample, format: "standard" });
    const back = importGatingML(xml, sessionChannels, pnnMap);

    expect(xml).toContain('gating:compensation-ref="uncompensated"');
    expect(xml).not.toContain('gating:compensation-ref="FCS"');
    expect(back.compensation).toEqual({
      enabled: false,
      reference: "uncompensated",
      channels: [],
    });
    expect(back.compensation_refs).toEqual(["uncompensated"]);
    expect(resolveGatingMLCompensation(
      back.compensation, back.compensation_refs, true, sample.spillover,
    )).toEqual({ target: false, source: "embedded", requiresConfirmation: false });
  });

  it("round-trips and verifies the exact embedded spillover matrix", () => {
    const { sample, ws, sessionChannels, pnnMap } = fixture();
    expect(sample.hasCompensation).toBe(true);
    sample.setCompensation(true);
    expect(sample.compensationEnabled).toBe(true);

    const xml = exportGatingML({ ...ws, sample, format: "standard" });
    const back = importGatingML(xml, sessionChannels, pnnMap);
    expect(xml).toContain('gating:compensation-ref="FCS"');
    expect(xml).toContain('gating:compensation-ref="uncompensated"');
    expect(back.compensation?.enabled).toBe(true);
    expect(back.compensation?.channels).toEqual(sample.spillover?.channels);
    expect(back.compensation?.matrix).toEqual(sample.spillover?.matrix);
    expect(resolveGatingMLCompensation(
      back.compensation, back.compensation_refs, true, sample.spillover,
    )).toEqual({ target: true, source: "embedded", requiresConfirmation: false });
  });

  it("blocks a GateLab file whose recorded spillover matrix differs", () => {
    const { sample, ws, sessionChannels, pnnMap } = fixture();
    sample.setCompensation(true);
    const back = importGatingML(
      exportGatingML({ ...ws, sample, format: "standard" }), sessionChannels, pnnMap,
    );
    const mismatched = {
      ...sample.spillover!,
      matrix: sample.spillover!.matrix.map((row) => [...row]),
    };
    mismatched.matrix[0][1] += 0.01;
    expect(() => resolveGatingMLCompensation(
      back.compensation, back.compensation_refs, true, mismatched,
    )).toThrow(/different FCS spillover matrix/);
  });

  it("requires confirmation for third-party FCS compensation references", () => {
    const { sample, ws, sessionChannels, pnnMap } = fixture();
    sample.setCompensation(true);
    const xml = exportGatingML({ ...ws, sample, format: "standard" }).replace(
      /\s*<gatelabr_scales>[\s\S]*?<\/gatelabr_scales>/,
      "",
    );
    const back = importGatingML(xml, sessionChannels, pnnMap);
    expect(back.compensation).toBeNull();
    expect(resolveGatingMLCompensation(
      back.compensation, back.compensation_refs, true, sample.spillover,
    )).toEqual({ target: true, source: "dimensions", requiresConfirmation: true });
  });

  it("rejects named compensation matrices that GateLab cannot evaluate", () => {
    const { sample, ws, sessionChannels, pnnMap } = fixture();
    sample.setCompensation(true);
    const xml = exportGatingML({ ...ws, sample, format: "standard" }).replace(
      'gating:compensation-ref="FCS"',
      'gating:compensation-ref="vendor-matrix"',
    );
    expect(() => importGatingML(xml, sessionChannels, pnnMap)).toThrow(/unsupported compensation matrix/);
  });

  it("rejects contradictory embedded and per-dimension compensation state", () => {
    const { sample, ws, sessionChannels, pnnMap } = fixture();
    const xml = exportGatingML({ ...ws, sample, format: "standard" }).replace(
      'gating:compensation-ref="uncompensated"',
      'gating:compensation-ref="FCS"',
    );
    const back = importGatingML(xml, sessionChannels, pnnMap);
    expect(() => resolveGatingMLCompensation(
      back.compensation, back.compensation_refs, true, sample.spillover,
    )).toThrow(/contradicts/);
  });
});

describe("GatingML positive-AND import policy", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const sessionChannels = sample.channels.map((c) => c.key);
  const pnnMap = Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key]));

  function rootOrWorkspace() {
    const ws = buildWorkspace(sample);
    const root = ws.populations[ws.root_population_id];
    const orPop = newPopulation(
      "Scatter OR signal",
      ws.gate_order.map((gid) => newGateRef(gid, true)),
      ws.root_population_id,
      "or",
    );
    ws.populations[orPop.population_id] = orPop;
    linkChildToParent(ws.populations, orPop.population_id, root.population_id);
    return { ws, orPop };
  }

  for (const format of ["standard", "cytobank"] as const) {
    it(`leaves out a root-level OR population exported in ${format} format, and imports the rest`, () => {
      const { ws } = rootOrWorkspace();
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "2026-01-01T00:00:00" });
      expect(xml).toContain("<gating:or>");
      const back = importGatingML(xml, sessionChannels, pnnMap);
      const names = Object.values(back.populations).map((p) => p.name);
      expect(names).not.toContain("Scatter OR signal");
      expect(back.n_pops_imported).toBe(Object.keys(ws.populations).length - 2);
      expect(back.warnings).toEqual([expect.stringMatching(/^"Scatter OR signal" combines its references with OR/)]);
    });
  }

  it("leaves out a nested OR population in standard format, with everything beneath it", () => {
    const ws = buildWorkspace(sample);
    const parent = Object.values(ws.populations).find((p) => p.name === "Cells")!;
    const nested = newPopulation(
      "Nested OR",
      ws.gate_order.map((gid) => newGateRef(gid, true)),
      parent.population_id,
      "or",
    );
    ws.populations[nested.population_id] = nested;
    linkChildToParent(ws.populations, nested.population_id, parent.population_id);
    const child = newPopulation("Beneath the OR", [newGateRef(ws.gate_order[0], true)], nested.population_id);
    ws.populations[child.population_id] = child;
    linkChildToParent(ws.populations, child.population_id, nested.population_id);
    const xml = exportGatingML({ ...ws, sample, format: "standard" });
    const back = importGatingML(xml, sessionChannels, pnnMap);
    const names = Object.values(back.populations).map((p) => p.name);
    expect(names).not.toContain("Nested OR");
    expect(names).not.toContain("Beneath the OR");
    expect(back.n_pops_imported).toBe(Object.keys(ws.populations).length - 3);
    expect(back.warnings).toEqual([expect.stringMatching(/^"Nested OR" combines its references with OR/)]);
  });

  it("blocks Cytobank-compatible export rather than corrupting a nested OR population", () => {
    const ws = buildWorkspace(sample);
    const parent = Object.values(ws.populations).find((p) => p.name === "Cells")!;
    const nested = newPopulation(
      "Nested OR",
      ws.gate_order.map((gid) => newGateRef(gid, true)),
      parent.population_id,
      "or",
    );
    ws.populations[nested.population_id] = nested;
    linkChildToParent(ws.populations, nested.population_id, parent.population_id);
    expect(() => exportGatingML({ ...ws, sample, format: "cytobank" })).toThrow(
      /cannot represent the OR population "Nested OR" beneath another population/,
    );
    // It must not send the user to a format GateLab would not read the population back from.
    expect(() => exportGatingML({ ...ws, sample, format: "cytobank" })).toThrow(
      /GateLab leaves OR populations out when it imports Gating-ML; the \.gatelab workspace keeps it/,
    );
  });

  it("leaves what sits beneath a top-level OR population out of the Cytobank format, by name", () => {
    // The Cytobank format ANDs every population with its whole ancestry. Beneath an OR that wrote
    // the child as the AND of the OR's operands and its own gate, which is not the child: on the
    // public PBMC file FlowKit read 213 events where GateLab holds 10,802, and with the tree mark
    // gone, as in a file back from Cytobank, GateLab re-imported it re-homed with those 213.
    const ws = buildWorkspace(sample);
    const or = newPopulation("Top OR", ws.gate_order.map((gid) => newGateRef(gid, true)), ws.root_population_id, "or");
    ws.populations[or.population_id] = or;
    linkChildToParent(ws.populations, or.population_id, ws.root_population_id);
    const child = newPopulation("Beneath the OR", [newGateRef(ws.gate_order[0], true)], or.population_id);
    ws.populations[child.population_id] = child;
    linkChildToParent(ws.populations, child.population_id, or.population_id);
    const grandchild = newPopulation("Further beneath", [newGateRef(ws.gate_order[1], true)], child.population_id);
    ws.populations[grandchild.population_id] = grandchild;
    linkChildToParent(ws.populations, grandchild.population_id, child.population_id);

    expect(analyzeCytobankOrOmissions(ws.populations, ws.root_population_id))
      .toEqual({ populationIds: [child.population_id, grandchild.population_id], names: ["Beneath the OR"] });
    const warnings: string[] = [];
    const xml = exportGatingML({ ...ws, sample, format: "cytobank", warnings });
    expect(xml).toContain("<name>Top OR</name>");
    expect(xml).not.toContain("Beneath the OR");
    expect(xml).not.toContain("Further beneath");
    expect(warnings).toEqual([expect.stringMatching(/^"Beneath the OR" sits beneath the OR population "Top OR"/)]);
    // Nor is anything beneath the OR re-imported, with the tree mark or without it.
    for (const text of [xml, xml.replace(/\s*<gatelab_format>[^<]*<\/gatelab_format>/, "")]) {
      const names = Object.values(importGatingML(text, sessionChannels, pnnMap).populations).map((p) => p.name);
      expect(names).not.toContain("Beneath the OR");
      expect(names).not.toContain("Further beneath");
    }
    // The standard format writes the child where it is, by parent_id, for other readers.
    expect(exportGatingML({ ...ws, sample, format: "standard" })).toContain("Beneath the OR");
  });

  it("requires explicit quadrant omission and prunes the entire dependent branch", () => {
    const ws = buildWorkspace(sample);
    const quadrant: Gate = {
      gate_id: "quadrant-1", name: "CD4 CD8 quadrants", gate_type: "quadrant",
      x_channel: ws.gates[ws.gate_order[0]].x_channel,
      y_channel: ws.gates[ws.gate_order[0]].y_channel,
      center: [40000, 40000], color: "#984ea3", label_offset: null,
    };
    ws.gates[quadrant.gate_id] = quadrant;
    ws.gate_order.push(quadrant.gate_id);
    const quadrantPop = newPopulation(
      "Quadrant population", [newGateRef(quadrant.gate_id, true, 2)], ws.root_population_id,
    );
    ws.populations[quadrantPop.population_id] = quadrantPop;
    linkChildToParent(ws.populations, quadrantPop.population_id, ws.root_population_id);
    const descendant = newPopulation(
      "Quadrant descendant", [newGateRef(ws.gate_order[1])], quadrantPop.population_id,
    );
    ws.populations[descendant.population_id] = descendant;
    linkChildToParent(ws.populations, descendant.population_id, quadrantPop.population_id);

    const omissions = analyzeGatingMLQuadrantOmissions(ws.gates, ws.populations);
    expect(new Set(omissions.populationIds)).toEqual(
      new Set([quadrantPop.population_id, descendant.population_id]),
    );
    expect(() => exportGatingML({ ...ws, sample, format: "standard" })).toThrow(
      /explicitly accepting their omission/i,
    );
    const xml = exportGatingML({
      ...ws, sample, format: "standard", allowQuadrantOmission: true,
    });
    expect(xml).not.toContain("Quadrant population");
    expect(xml).not.toContain("Quadrant descendant");
    const back = importGatingML(xml, sessionChannels, pnnMap);
    expect(Object.values(back.populations).some((pop) => pop.name.startsWith("Quadrant"))).toBe(false);
  });
});

describe("GatingML NOT round-trip (Aria III flow, real events)", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const sessionChannels = sample.channels.map((c) => c.key);
  const pnnMap: Record<string, string> = {};
  for (const c of sample.channels) pnnMap[c.pnn] = c.key;

  /**
   * The positive-AND workspace plus a sibling population that EXCLUDES the scatter
   * rectangle. Negating the fluorophore polygon instead would be vacuous: it contains
   * every event of its parent, so its complement is empty and the test could not fail.
   */
  function buildExcludedWorkspace() {
    const ws = buildWorkspace(sample);
    const rectGateId = ws.gate_order[0];
    const notCells = newPopulation(
      "Not cells", [newGateRef(rectGateId, false)], ws.root_population_id,
    );
    ws.populations[notCells.population_id] = notCells;
    ws.populations = linkChildToParent(
      ws.populations, notCells.population_id, ws.root_population_id,
    );
    return ws;
  }

  /** Per-event membership of every named population, keyed by name. */
  function membershipByName(ws: ReturnType<typeof buildWorkspace>): Record<string, Uint8Array> {
    const { masks } = applyGatingStrategy(
      ws.gates, ws.populations, ws.root_population_id, sample.gatingData(),
    );
    const out: Record<string, Uint8Array> = {};
    for (const pop of Object.values(ws.populations)) {
      if (pop.population_id === ws.root_population_id) continue;
      out[pop.name] = masks[pop.population_id];
    }
    return out;
  }

  for (const format of ["standard", "cytobank"] as const) {
    describe(`${format} format`, () => {
      const ws = buildExcludedWorkspace();
      const before = membershipByName(ws);
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "2026-01-01T00:00:00" });
      const back = importGatingML(xml, sessionChannels, pnnMap, sample.instrument);

      it("emits the exclusion rather than dropping it", () => {
        expect(xml).toMatch(/complement="true"|NOT gate_/);
      });

      it("re-imports the excluded reference as include = false", () => {
        const notCells = Object.values(back.populations).find((p) => p.name === "Not cells");
        expect(notCells).toBeDefined();
        expect(notCells!.gate_refs).toHaveLength(1);
        expect(notCells!.gate_refs[0].include).toBe(false);
      });

      it("preserves membership event for event, and the NOT population is not empty", () => {
        const after = membershipByName({
          gates: back.gates,
          gate_order: back.gate_order,
          populations: back.populations,
          root_population_id: back.root_population_id,
        });
        for (const name of Object.keys(before)) {
          expect(after[name], `population ${name} missing after round-trip`).toBeDefined();
          expect(Array.from(after[name])).toEqual(Array.from(before[name]));
        }
        // Guard against a vacuous pass: NOT and its positive counterpart must partition
        // the root, so neither is empty and equality above is a real constraint.
        const count = (m: Uint8Array) => m.reduce((s, v) => s + v, 0);
        const nCells = count(before["Cells"]);
        const nNotCells = count(before["Not cells"]);
        expect(nCells).toBeGreaterThan(0);
        expect(nNotCells).toBeGreaterThan(0);
        expect(nCells + nNotCells).toBe(sample.gatingData().n);
      });
    });
  }
});

// ── The declared scale must contain the gate it describes ────────────────────────────────────
//
// Cytobank draws the axis from the <definition> scale block and recomputes membership from the
// vertices, so a gate whose vertices fall outside its own declared min/max imports invisible.
// The ranges used to be hardcoded constants (linear got 1 … 1570900, flow arcsinh -2 … 12), and
// on real data 17 of LP4's axis/gate combinations fell outside them -- one by a factor of 100.
// That is what stalled the Cytobank arm of GateLab-2026-08-15-B.
describe("Cytobank scale ranges contain their own gates", () => {
  const scalesOf = (xml: string) => {
    const out: { name: string; scale: Record<string, { min: number; max: number }>;
                 xs: number[]; ys: number[] }[] = [];
    for (const m of xml.matchAll(/<name>([^<]*)<\/name>[\s\S]*?<definition>([\s\S]*?)<\/definition>/g)) {
      const json = m[2].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
      let j: Record<string, unknown>;
      try { j = JSON.parse(json); } catch { continue; }
      const scale = j.scale as Record<string, { min: number; max: number }> | undefined;
      if (!scale) continue;
      const poly = (j.polygon as { vertices?: [number, number][] } | undefined)?.vertices;
      const rect = j.rectangle as { x1: number; y1: number; x2: number; y2: number } | undefined;
      const verts = poly ?? (rect ? [[rect.x1, rect.y1], [rect.x2, rect.y2]] as [number, number][] : null);
      if (!verts) continue;
      out.push({ name: m[1], scale, xs: verts.map((v) => v[0]), ys: verts.map((v) => v[1]) });
    }
    return out;
  };

  for (const format of ["cytobank", "standard"] as const) {
    it(`holds for every gate in the ${format} format`, () => {
      const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
      // Display-space gates, which is where the hardcoded ranges failed worst: a biex or logicle
      // gate re-expressed for export lands far outside a constant guessed in advance.
      const base = asDisplayWorkspace(sample, buildWorkspace(sample));

      // Plus a raw gate deliberately BEYOND this fixture's own data, because the fixture alone
      // cannot expose the bug: every ARIA value happens to sit inside the old hardcoded
      // 1 … 1570900, so restoring that constant still passed. LP4's FACSDiscover S8 reaches
      // 1.5e8 -- two orders past it -- which is the real case this guards.
      const far = sample.channels[0].key;
      const far2 = sample.channels[1].key;
      const farGate = {
        gate_id: uuid(), name: "far out", gate_type: "rectangle",
        x_channel: far, y_channel: far2, color: "#000", label_offset: null, space: "raw",
        vertices: [[2e6, 2e6], [5e7, 5e7]] as Vertex[],
      } as Gate;
      const farPop = newPopulation("far out", [newGateRef(farGate.gate_id, true)],
                                   base.root_population_id);
      const ws = {
        ...base,
        gates: { ...base.gates, [farGate.gate_id]: farGate },
        gate_order: [...base.gate_order, farGate.gate_id],
        populations: linkChildToParent(
          { ...base.populations, [farPop.population_id]: farPop },
          farPop.population_id, base.root_population_id),
      };
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const gates = scalesOf(xml);
      expect(gates.length).toBeGreaterThan(0);
      for (const g of gates) {
        for (const [axis, vals] of [["x", g.xs], ["y", g.ys]] as const) {
          const a = g.scale[axis];
          expect(Math.min(...vals), `${g.name} ${axis} min inside declared scale`)
            .toBeGreaterThanOrEqual(a.min);
          expect(Math.max(...vals), `${g.name} ${axis} max inside declared scale`)
            .toBeLessThanOrEqual(a.max);
        }
      }
    });
  }
});

// ── The compensation matrix travels in the Cytobank flavour ──────────────────────────────────
//
// The export used to write compensation-ref="FCS" and no matrix, so a receiving tool had to
// find one itself — and when the gates were computed under a matrix that is not in the FCS (S6:
// FlowJo's hand-adjusted DivaCompMtx vs the acquisition matrix in the file, 48 of 49
// coefficients different), Cytobank silently compensated with the wrong one: its 3 uncompensated
// scatter gates matched GateLab exactly while all 15 compensated gates drifted, 1,437 events.
describe("Cytobank export carries the active spillover matrix", () => {
  function compFixture() {
    const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
    expect(sample.hasCompensation).toBe(true);
    sample.setCompensation(true);
    return { sample, ws: buildWorkspace(sample) };
  }

  it("emits a spectrumMatrix block with the matrix values, detectors and Comp_ fluorochromes", () => {
    const { sample, ws } = compFixture();
    const xml = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" });
    expect(xml).toContain('<transforms:spectrumMatrix transforms:id="Spill_1">');
    const sp = sample.spillover!;
    for (const ch of sp.channels) {
      const pnn = sample.channels.find((c) => c.key === ch)!.pnn;
      expect(xml).toContain(`<data-type:fcs-dimension data-type:name="Comp_${pnn}" />`);
      expect(xml).toContain(`<data-type:fcs-dimension data-type:name="${pnn}" />`);
    }
    // One spectrum row per channel, and a representative off-diagonal coefficient survives.
    expect(xml.match(/<transforms:spectrum>/g)!.length).toBe(sp.channels.length);
    const offDiag = sp.matrix.flatMap((row, i) => row.filter((_, j) => j !== i)).find((v) => v > 0)!;
    expect(xml).toContain(`transforms:value="${offDiag}"`);
  });

  it("points compensated gates at the file-internal matrix and leaves uncompensated ones alone", () => {
    const { sample, ws } = compFixture();
    const xml = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" });
    // ARIA's spillover comes from the FCS itself, so compensated gates say 0 (Cytobank's
    // "file internal"), not a declared-matrix id; uncompensated gates keep -2.
    expect(sample.spilloverOrigin.kind).toBe("fcs");
    // Scoped to GEOMETRIC gates: boolean gate-set blocks hardcode 0 in every export (mirroring
    // Cytobank's own), so a whole-file toContain(0) is satisfied vacuously — mutation-tested.
    const ids = [...xml.matchAll(
      /<gating:(?:Polygon|Rectangle)Gate[\s\S]*?<compensation_id>(-?\d+)</g)].map((m) => m[1]);
    expect(ids).toContain("0");
    expect(ids).toContain("-2");
  });

  it("keeps the standard flavour free of transforms elements — the raw-vertex proof", () => {
    const { sample, ws } = compFixture();
    const xml = exportGatingML({ ...ws, sample, format: "standard", timestamp: "t" });
    expect(xml).not.toContain("spectrumMatrix");
    // The round-trip notebook REFUSES a standard file containing any transforms: element, and
    // that refusal is what proves the standard flavour's vertices are raw. asDisplayWorkspace
    // gates would legitimately add transformation blocks, so this fixture keeps raw gates.
    expect(xml).not.toContain("<transforms:transformation");
    // And the compensated round trip through the importer still resolves.
    const back = importGatingML(xml, sample.channels.map((c) => c.key),
      Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key])));
    expect(resolveGatingMLCompensation(back.compensation, back.compensation_refs, true,
      sample.spillover)).toEqual({ target: true, source: "embedded", requiresConfirmation: false });
  });

  it("names an externally installed matrix and points compensated gates at it", () => {
    // The S6 shape: the matrix the gates were computed under came from the FlowJo workspace,
    // not the FCS, so "file internal" (0) would hand the receiver the WRONG matrix. The gate
    // must point at the declared block instead.
    const { sample, ws } = compFixture();
    const doctored = {
      channels: sample.spillover!.channels,
      matrix: sample.spillover!.matrix.map((row, i) =>
        row.map((v, j) => (i === j ? 1 : Math.min(0.9, v + 0.05)))),
    };
    sample.setCompensation(false);
    sample.installExternalSpillover(doctored, "DivaCompMtx_test.fcs", { replaceEmbedded: true });
    sample.setCompensation(true);
    expect(sample.spilloverOrigin.kind).toBe("external");

    const xml = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" });
    expect(xml).toContain("<cytobank_compensation_name>DivaCompMtx_test.fcs</cytobank_compensation_name>");
    expect(xml).toContain("<compensation_id>1</compensation_id>");
    // And the values in the block are the ACTIVE (external) matrix's as the sample now holds
    // it — installExternalSpillover re-extracts to display space, so compare post-install.
    const active = sample.spillover!;
    const offDiag = active.matrix.flatMap((row, i) => row.filter((_, j) => j !== i)).find((v) => v > 0.01)!;
    const m = xml.match(/<transforms:spectrumMatrix[\s\S]*?<\/transforms:spectrumMatrix>/)![0];
    const emitted = [...m.matchAll(/transforms:value="([^"]+)"/g)].map((x) => Number(x[1]));
    expect(emitted.some((v) => Math.abs(v - offDiag) < 1e-6)).toBe(true);
  });

  it("emits no matrix when compensation is off", () => {
    const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
    const ws = buildWorkspace(sample);
    const xml = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" });
    expect(xml).not.toContain("spectrumMatrix");
    // Boolean gate sets always say 0, mirroring Cytobank's own exports; the check is that no
    // GEOMETRIC gate claims a compensation while compensation is off.
    for (const m of xml.matchAll(/<gating:(?:Polygon|Rectangle)Gate[\s\S]*?<compensation_id>(-?\d+)</g)) {
      expect(m[1]).toBe("-2");
    }
  });
});

// ── Densified polygons are collapsed to editable vertex counts ──────────────────────────────
//
// subdivideEdge bisects, so it distributes points uniformly along an edge even where the curve
// is locally straight: a real LP4 export carried 25-67 vertices per gate, unusable to hand-edit
// in Cytobank. The exporter now subdivides at half the 0.2% tolerance and Douglas-Peuckers the
// interior points at the other half — the same total bound (the round-trip suite measures moved
// events and still passes), roughly half the vertices on the shapes that were worst.
describe("a biex polygon's vertices in raw space", () => {
  it("are its own, and one where an edge crosses each entry of the biex table", () => {
    const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
    const fluor = sample.channels.filter((_, i) => sample.transformKind(i) === "logicle")
      .map((c) => c.key);
    const [fx, fy] = fluor;
    const biex = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0,
                   widthBasis: -10, channelRange: 256 } as const;
    // Spans most of the biex range, the shape that exported 67 vertices before the collapse.
    const raw: Vertex[] = [[-150, -80], [2500, -80], [3500, 4000], [400, 7000], [-150, 1500]];
    const g = {
      gate_id: uuid(), name: "wide", gate_type: "polygon", x_channel: fx, y_channel: fy,
      color: "#000", label_offset: null, vertices: raw, space: "display",
      transforms: { [fx]: biex, [fy]: biex },
    } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [
      sample.rawToGate(g as Gate, fx, vx), sample.rawToGate(g as Gate, fy, vy)]);

    const root = newRootPopulation();
    let pops: PopulationMap = { [root.population_id]: root };
    const pp = newPopulation("wide", [newGateRef(g.gate_id, true)], root.population_id);
    pops[pp.population_id] = pp;
    pops = linkChildToParent(pops, pp.population_id, root.population_id);
    const ws = { gates: { [g.gate_id]: g as Gate }, gate_order: [g.gate_id],
                 populations: pops, root_population_id: root.population_id };
    const xml = exportGatingML({ ...ws, sample, format: "standard", timestamp: "t" });

    const n = (xml.match(/<gating:vertex>/g) ?? []).length;
    // GateLab's biex is linear between the entries of its table, one per display channel, so the
    // polygon split at every entry its edges cross is the same boundary in raw space
    // (splitAtKnots). It was densified to a tolerance until 2026-09, 36 vertices for this shape,
    // which placed another file's events near an edge by chance. One vertex per channel crossed on
    // either axis, the polygon's own, and the skirt loops that carry its clamped corner.
    const vs = g.vertices as Vertex[];
    let crossings = 0;
    vs.forEach((v, i) => {
      const w = vs[(i + 1) % vs.length];
      for (const k of [0, 1]) crossings += Math.abs(Math.floor(w[k]) - Math.floor(v[k]));
    });
    expect(n).toBeGreaterThan(crossings / 2);
    expect(n).toBeLessThanOrEqual(raw.length + crossings + 12);

    // Every ORIGINAL vertex survives as the gate actually holds it: corners are forced anchors
    // in the collapse. "As the gate holds it" matters — a raw coordinate outside the biex
    // table's domain (x = -150 here; this table bottoms out near -93.5) was clamped when the
    // display-space gate was CREATED, so the export legitimately returns the clamp, not the
    // out-of-domain number. Membership is unaffected: every raw value beyond the domain edge
    // shares that display coordinate. So the invariant is round-tripped-vertex survival, and
    // exactness is additionally asserted for the in-domain corners.
    const vals = [...xml.matchAll(/data-type:value="([^"]+)"/g)].map((m) => Number(m[1]));
    const pts: [number, number][] = [];
    for (let i = 0; i + 1 < vals.length; i += 2) pts.push([vals[i], vals[i + 1]]);
    raw.forEach(([rx, ry], i) => {
      const ex = sample.gateToRaw(g as Gate, fx, (g.vertices as Vertex[])[i][0]);
      const ey = sample.gateToRaw(g as Gate, fy, (g.vertices as Vertex[])[i][1]);
      expect(pts.some(([x, y]) => Math.abs(x - ex) < 1e-6 && Math.abs(y - ey) < 1e-6),
        `vertex ${i} (${rx}, ${ry}) survived as (${ex}, ${ey})`).toBe(true);
      if (rx > -90 && ry > -90) {
        expect(Math.abs(ex - rx)).toBeLessThan(1e-6);
        expect(Math.abs(ey - ry)).toBeLessThan(1e-6);
      }
    });
  });
});

// A gate held in Gating-ML's own log space (the form a Cytobank flow export arrives in, and the
// form a FlowJo log axis is declared as) must leave the Cytobank format as flog with its
// coordinates verbatim. Until 2026-09-11 the Cytobank branch for logicle came first and treated a
// flog gate as logicle: coordinates scaled by the logicle span and inverted, then declared as
// arcsinh, so every such gate sat far off the top of the axis on upload.
describe("an edge along one axis is not split at the other axis's knots", () => {
  // Each axis is written by a monotonic map of its own coordinate, so an edge along one axis is a
  // straight line in the written space whatever the other axis crosses. Split at every entry of a
  // biex table, an edge a polygon lays along the table's end was a third of the vertices of the
  // verifier's PBMC strategy (5,116 of 15,421), each exactly on the line between its neighbours.
  const knots = (lo: number, hi: number) => { const out: number[] = []; for (let k = Math.ceil(lo); k <= hi; k++) out.push(k); return out; };

  it("splits a slanted edge at every knot it crosses and leaves an edge along an axis whole", () => {
    const out = splitAtKnots([[0.5, 0.5], [10.5, 0.5], [10.5, 8.5], [0.5, 3.5]], knots, knots);
    // The slanted edge crosses ten x knots and five y knots; the three along an axis cross none.
    expect(out.filter((p) => p[1] === 0.5)).toEqual([[0.5, 0.5], [10.5, 0.5]]);
    expect(out.filter((p) => p[0] === 10.5)).toEqual([[10.5, 0.5], [10.5, 8.5]]);
    expect(out.length).toBe(4 + 10 + 5);
  });

  it("writes a biex polygon laid along its table's end with that edge's two ends alone", () => {
    const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
    const [fx, fy] = sample.channels.filter((_, i) => sample.transformKind(i) === "logicle").map((c) => c.key);
    const biex = { kind: "biex", maxValue: 262144, pos: 4.5, neg: 1, widthBasis: -100, channelRange: 4096 } as const;
    const g = { gate_id: uuid(), name: "top corner", gate_type: "polygon", x_channel: fx, y_channel: fy,
      color: "#000", label_offset: null, vertices: [], space: "display", transforms: { [fx]: biex, [fy]: biex } } as unknown as Gate & { vertices: Vertex[] };
    g.vertices = ([[400, 300], [1e9, 200], [1e9, 1e9], [300, 1e9]] as Vertex[]).map(([vx, vy]) => [sample.rawToGate(g, fx, vx), sample.rawToGate(g, fy, vy)]);
    const root = newRootPopulation();
    let pops: PopulationMap = { [root.population_id]: root };
    const pp = newPopulation("top corner", [newGateRef(g.gate_id, true)], root.population_id);
    pops[pp.population_id] = pp;
    pops = linkChildToParent(pops, pp.population_id, root.population_id);
    const ws = { gates: { [g.gate_id]: g as Gate }, gate_order: [g.gate_id], populations: pops, root_population_id: root.population_id };
    for (const format of ["standard", "cytobank"] as const) {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const vals = [...xml.split("<gating:vertex>").slice(1).join("").matchAll(/data-type:value="([^"]+)"/g)].map((m) => Number(m[1]));
      const pts: [number, number][] = [];
      for (let i = 0; i + 1 < vals.length; i += 2) pts.push([vals[i], vals[i + 1]]);
      // The table's top end, written a hair inside it: the greatest coordinate below the skirts.
      const top = (k: 0 | 1) => Math.max(...pts.map((p) => p[k]).filter((v) => v < 1e14));
      for (const k of [0, 1] as const) {
        const onEnd = new Set(pts.filter((p) => Math.abs(p[k] - top(k)) <= 1e-9 * top(k)).map((p) => String(p))).size;
        // The edge's two ends and the few points of the skirt loops on it, not one per table entry.
        expect(onEnd, `${format}, axis ${k}`).toBeLessThanOrEqual(8);
      }
      const back = importGatingML(xml, sample.channelNames(), Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key])), "flow");
      const mask = (w: { gates: Record<string, Gate>; populations: PopulationMap; root_population_id: string }) =>
        applyGatingStrategy(w.gates, w.populations, w.root_population_id, sample.gateAssayData()).masks;
      const pid = (w: { populations: PopulationMap }) => Object.values(w.populations).find((p) => p.name === "top corner")!.population_id;
      expect(Array.from(mask(back)[pid(back)])).toEqual(Array.from(mask(ws)[pid(ws)]));
    }
  }, 60000);
});

describe("Cytobank format declares a flog gate as log, with its coordinates verbatim", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const fluor = sample.channels.filter((_, i) => sample.isLogicleChannel(i)).map((c) => c.key);
  const [fx, fy] = fluor;
  const flog = { kind: "flog" as const, T: 1, M: 1 };
  const gate: Gate = {
    gate_id: uuid(), name: "log rect", gate_type: "rectangle", x_channel: fx, y_channel: fy,
    vertices: [[2, 2], [4, 2], [4, 4], [2, 4]] as Vertex[],
    space: "display", transforms: { [fx]: flog, [fy]: flog }, bounds: "half-open",
    color: "#377eb8", label_offset: null,
  };
  const root = newRootPopulation();
  const pop = newPopulation(gate.name, [newGateRef(gate.gate_id, true)], root.population_id);
  const populations: PopulationMap = linkChildToParent(
    { [root.population_id]: root, [pop.population_id]: pop }, pop.population_id, root.population_id);
  const xml = exportGatingML({
    gates: { [gate.gate_id]: gate }, gate_order: [gate.gate_id], populations,
    root_population_id: root.population_id, sample, format: "cytobank", timestamp: "t",
  });

  it("declares transforms:flog with the gate's own T and M, and no arcsinh", () => {
    expect(xml).toMatch(/<transforms:flog transforms:T="1" transforms:M="1"/);
    expect(xml).toMatch(/gating:transformation-ref="Tr_Log_/);
    expect(xml).not.toContain("transforms:fasinh");
  });

  it("writes the log coordinates unchanged", () => {
    expect(xml).toContain('gating:min="2"');
    // 4 less 1e-13 of itself: the rectangle is half-open, and its upper bound goes out just
    // below the edge for a reader that holds both edges (gatingmlExport.ts, forEveryReader).
    expect(xml).toContain('gating:max="3.9999999999996"');
  });

  it("tells Cytobank the axis is Log, as its own flow exports do", () => {
    expect(xml).toContain('"flag":2,"argument":"1"');
    expect(xml).not.toContain('"flag":4');
  });
});

// A logicle gate carries its own T, W, M and A (a FlowKit-written W = 0 or A = 0.5 imports
// exactly since #342). The standard format declared clampW(W), so W = 0 went out as 0.1 and
// W = 2.2 as 2, and keyed the transform by channel and W alone, so a second gate on the channel
// with the same W but another A was declared with the first gate's A. A faithfully imported
// FlowKit strategy came back 34, 8,754 of 26,684 and 2,574 events different.
describe("the standard format declares each logicle gate's own parameters", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const logicle = sample.channels.map((_, i) => i).filter((i) => sample.transformKind(i) === "logicle");
  const [xKey, yKey] = [sample.channels[logicle[0]].key, sample.channels[logicle[1]].key];
  const specs = [
    { name: "W0", T: 262144, W: 0, M: 4.5, A: 0 },
    { name: "W22", T: 262144, W: 2.2, M: 4.5, A: 0 },
    { name: "W05 A0", T: 262144, W: 0.5, M: 4.5, A: 0 },
    { name: "W05 A05", T: 262144, W: 0.5, M: 4.5, A: 0.5 },
    { name: "T1e5", T: 100000, W: 0.5, M: 4.5, A: 0 },
  ];
  const root = newRootPopulation();
  let populations: PopulationMap = { [root.population_id]: root };
  const gates: Record<string, Gate> = {};
  for (const s of specs) {
    const spec = { kind: "logicle" as const, T: s.T, W: s.W, M: s.M, A: s.A };
    const g: Gate = {
      gate_id: uuid(), name: s.name, gate_type: "rectangle", x_channel: xKey, y_channel: yKey,
      vertices: [[0.25, 0.2], [0.7, 0.2], [0.7, 0.8], [0.25, 0.8]], color: "#e41a1c", label_offset: null,
      space: "display", transforms: { [xKey]: spec, [yKey]: spec },
    } as Gate;
    gates[g.gate_id] = g;
    const p = newPopulation(s.name, [newGateRef(g.gate_id, true)], root.population_id);
    populations[p.population_id] = p;
    populations = linkChildToParent(populations, p.population_id, root.population_id);
  }
  const ws = { gates, gate_order: Object.keys(gates), populations, root_population_id: root.population_id };
  const xml = exportGatingML({ ...ws, sample, format: "standard", timestamp: "2026-01-01T00:00:00" });

  it("writes every gate's T, W, M and A exactly, one transform per parameter set", () => {
    const declared = new Map<string, number[]>();
    for (const m of xml.matchAll(/transforms:id="([^"]+)">\s*<transforms:logicle transforms:T="([^"]+)" transforms:W="([^"]+)" transforms:M="([^"]+)" transforms:A="([^"]+)"/g)) {
      declared.set(m[1], [m[2], m[3], m[4], m[5]].map(Number));
    }
    for (const s of specs) {
      const el = (xml.match(/<gating:RectangleGate\b[\s\S]*?<\/gating:RectangleGate>/g) ?? [])
        .find((g) => g.includes(`<name>${s.name}</name>`))!;
      const refs = [...el.matchAll(/transformation-ref="([^"]+)"/g)].map((m) => m[1]);
      expect(refs).toHaveLength(2);
      for (const r of refs) expect(declared.get(r), `${s.name} via ${r}`).toEqual([s.T, s.W, s.M, s.A]);
    }
    expect(new Set([...declared.values()].map((v) => v.join())).size).toBe(declared.size);
  });

  it("re-imports every gate selecting the same events", () => {
    const res = importGatingML(xml, sample.channels.map((c) => c.key), {}, sample.instrument);
    for (const s of specs) {
      const before = Object.values(gates).find((g) => g.name === s.name)!;
      const after = Object.values(res.gates).find((g) => g.name === s.name)!;
      expect(after.transforms?.[xKey], s.name).toEqual(before.transforms?.[xKey]);
      expect(Array.from(getGateMask(after, sample.gatingDataFor(after))), s.name)
        .toEqual(Array.from(getGateMask(before, sample.gatingDataFor(before))));
    }
  });
});

// An absent Gating-ML bound imports as ±UNBOUNDED. The exporters must write such an edge, and an
// edge the export space cannot reach on its own side, as no bound: fmtNum turned a non-finite
// coordinate into "0", so the Cytobank format wrote an open-top logicle range as max="0" (empty;
// 20,732 to 29,019 events moved on re-import), and the FlowJo export the same.
describe("an unbounded rectangle edge is written unbounded", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const logicle = sample.channels.map((_, i) => i).filter((i) => sample.transformKind(i) === "logicle");
  const [f1, f2] = [sample.channels[logicle[0]].key, sample.channels[logicle[1]].key];
  const fsc = sample.channels.find((c) => /FSC-A/.test(c.key))!.key;
  const root = newRootPopulation();
  let populations: PopulationMap = { [root.population_id]: root };
  const gates: Record<string, Gate> = {};
  const add = (g: Omit<Gate, "gate_id" | "color" | "label_offset">) => {
    const gate = { ...g, gate_id: uuid(), color: "#e41a1c", label_offset: null } as Gate;
    gates[gate.gate_id] = gate;
    const p = newPopulation(gate.name, [newGateRef(gate.gate_id, true)], root.population_id);
    populations[p.population_id] = p;
    populations = linkChildToParent(populations, p.population_id, root.population_id);
  };
  const lg = sample.gateTransformSnapshot(f1, f2);
  const U = Number.MAX_VALUE;
  add({ name: "Open-top logicle range", gate_type: "rectangle", x_channel: f1, y_channel: f1,
    vertices: [[0.3, 0.3], [U, 0.3], [U, U], [0.3, U]], space: "display", transforms: { [f1]: lg[f1] } } as never);
  add({ name: "Open-bottom logicle rectangle", gate_type: "rectangle", x_channel: f1, y_channel: f2,
    vertices: [[0.2, -U], [0.8, -U], [0.8, 0.5], [0.2, 0.5]], space: "display", transforms: lg } as never);
  add({ name: "Old stand-in logicle rectangle", gate_type: "rectangle", x_channel: f1, y_channel: f2,
    vertices: [[0.2, 0.4], [0.8, 0.4], [0.8, 1e9], [0.2, 1e9]], space: "display", transforms: lg } as never);
  add({ name: "Open raw range", gate_type: "rectangle", x_channel: fsc, y_channel: fsc,
    vertices: [[20000, 20000], [U, 20000], [U, U], [20000, U]], space: "raw" } as never);
  const ws = { gates, gate_order: Object.keys(gates), populations, root_population_id: root.population_id };
  const masksOf = (g: Record<string, Gate>) => Object.fromEntries(Object.values(g).map((x) =>
    [x.name, Array.from(getGateMask(x, sample.gatingDataFor(x)))]));

  it("writes no finite bound for an unbounded edge, and re-imports the same events", () => {
    const before = masksOf(gates);
    for (const name of Object.keys(before)) expect(before[name].some(Boolean), name).toBe(true);
    for (const format of ["standard", "cytobank"] as const) {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "2026-01-01T00:00:00" });
      // Every dimension of a rectangle keeps at least one bound, and none is at 0.
      for (const el of xml.match(/<gating:RectangleGate\b[\s\S]*?<\/gating:RectangleGate>/g) ?? []) {
        for (const d of el.match(/<gating:dimension\b[^>]*>/g) ?? []) {
          expect(d, `${format}: ${d}`).toMatch(/gating:(min|max)="/);
          expect(d, `${format}: ${d}`).not.toMatch(/gating:(min|max)="0"/);
        }
      }
      const res = importGatingML(xml, sample.channels.map((c) => c.key), {}, sample.instrument);
      const after = masksOf(res.gates);
      for (const name of Object.keys(before)) expect(after[name], `${format}: ${name}`).toEqual(before[name]);
    }
  });

  it("puts an unbounded edge in the Cytobank definition as unbounded too", () => {
    const xml = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "2026-01-01T00:00:00" });
    const el = (xml.match(/<gating:RectangleGate\b[\s\S]*?<\/gating:RectangleGate>/g) ?? [])
      .find((g) => g.includes("<name>Open-top logicle range</name>"))!;
    const def = JSON.parse(/<definition>([\s\S]*?)<\/definition>/.exec(el)![1]);
    expect(def.rectangle.x2).toBe(U);
    expect(def.rectangle.y2).toBe(U);
    expect(Number.isFinite(def.label[0]) && Math.abs(def.label[0]) < 1e3).toBe(true);
  });

  it("refuses to write a coordinate that is not finite, rather than writing 0", () => {
    expect(() => fmtNum(Infinity)).toThrow(/not finite/);
    expect(() => fmtNum(NaN)).toThrow(/not finite/);
    expect(Number(fmtNum(U))).toBe(U);
    expect(Number(fmtNum(-U))).toBe(-U);
  });
});

describe("tieBreakPolygon", () => {
  // Events on the boundary, as GateLab decides them: held at a vertex and on an edge, and one left
  // out on an edge (GateLab's single-precision value fell outside). A reader decides such an event
  // by its own edge rule, so the boundary must pass beyond each, to GateLab's side.
  const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const pts: [number, number, number][] = [
    [10, 10, 1], [10, 5, 1], [5, 0, 0], [0, 7, 1], [7, 10, 1],
    [5, 5, 1], [11, 5, 0], [-3, -3, 0], [5, 10.5, 0], [9.9999, 5, 1],
  ];
  const x = pts.map((p) => p[0]);
  const y = pts.map((p) => p[1]);
  const inside = pts.map((p) => p[2]);
  const strict = (w: [number, number][], px: number, py: number) => {
    let c = false;
    for (let a = 0, b = w.length - 1; a < w.length; b = a++) {
      const [ax, ay] = w[a];
      const [bx, by] = w[b];
      if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) c = !c;
    }
    return c ? 1 : 0;
  };
  const gap = (w: [number, number][], px: number, py: number) => Math.min(...w.map((a, k) => {
    const b = w[(k + 1) % w.length];
    const dx = b[0] - a[0]; const dy = b[1] - a[1];
    const u = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - a[0] - u * dx, py - a[1] - u * dy);
  }));

  it("puts every event on the boundary a margin inside or outside, as GateLab decides it", () => {
    // Without the notches a plain even-odd reader leaves out the vertex and two edge events.
    expect(pts.filter(([px, py, want]) => strict(square, px, py) !== want).length).toBeGreaterThan(0);
    const w = tieBreakPolygon(square, x, y, inside);
    for (const [px, py, want] of pts) {
      expect(strict(w, px, py), `${px},${py}`).toBe(want);
      expect(gateMaskPolygon([px], [py], w)[0], `${px},${py}`).toBe(want);
    }
    // Far enough from the new boundary that no reader's rounding can move them: half the tie margin
    // (1e-6) of the event's own magnitude on each axis, at least 0.01.
    const own = (w: [number, number][], px: number, py: number) => {
      const [rx, ry] = [Math.max(Math.abs(px), 0.01), Math.max(Math.abs(py), 0.01)];
      return gap(w.map(([a, b]) => [a / rx, b / ry] as [number, number]), px / rx, py / ry);
    };
    for (const [px, py] of pts.slice(0, 5)) expect(own(w, px, py)).toBeGreaterThan(5e-7);
    // A vertex no event lies near is kept, and nothing moves by more than 1e-3. The events GateLab
    // holds on the right edge, at the top right vertex, on the top edge and on the left edge are
    // settled by one notch, which moves the two vertices between them.
    for (const v of square.slice(0, 2)) expect(w).toContainEqual(v);
    for (const v of w) expect(Math.min(...square.map((q) => Math.hypot(v[0] - q[0], v[1] - q[1])), gap(square, v[0], v[1]))).toBeLessThan(1e-3);
  });

  it("leaves a polygon with no event on its boundary as it was", () => {
    const off = pts.slice(5);
    expect(tieBreakPolygon(square, off.map((p) => p[0]), off.map((p) => p[1]), off.map((p) => p[2]))).toEqual(square);
  });

  it("does not notch where the notch would change another event", () => {
    // An event GateLab leaves out lies just beyond the vertex, where a notch holding the vertex's
    // own event would take it in: the vertex is left as it was.
    const w = tieBreakPolygon(square, [10, 10 + 1.2e-5], [10, 10 + 1.2e-5], [1, 0]);
    expect(w).toEqual(square);
  });

  it("settles a polygon far below 1/16 as it settles the same polygon at 1/16 and above, scaled", () => {
    // GateLab tests such a polygon at its own magnitude (polygonTestScale), and a fasinh with a small
    // M is held at one: at M = 1e-4 the whole scale reached 2.3e-4. The least scale here was in the
    // gate's units, so there every event lay within a notch's reach of an edge (the verifier: 45 s
    // to write one polygon on the public PBMC file, and at M = 1e-6 no end).
    const at = (f: number) => tieBreakPolygon(
      square.map(([a, b]) => [a * f, b * f] as [number, number]), x.map((v) => v * f), y.map((v) => v * f), inside);
    const unit = at(1 / 128); // the square spans 0.078: tested as it is
    expect(unit).not.toEqual(square.map(([a, b]) => [a / 128, b / 128]));
    for (const k of [2 ** -20, 2 ** -60]) {
      expect(at(k / 128)).toEqual(unit.map(([a, b]) => [a * k, b * k]));
    }
  });
});

describe("skirtRing", () => {
  // A corner skirt holds every event beyond both clamps, which GateLab holds when the polygon has a
  // vertex there that ends an edge, and, since feat/flowjo-grid, when the whole ring is that one
  // point: GateLab's polygon test holds a ring collapsed onto one point at that point (gates.ts),
  // as FlowJo's grid holds a polygon all on one channel. fix/gatingml-hardening wrote such a ring
  // without the skirt when GateLab held nothing for it.
  const R = 251716.54911695892;
  const L = -93.49809945251306;
  const far = (ring: [number, number][]) => ring.some((v) => Math.abs(v[0]) >= 1e15 || Math.abs(v[1]) >= 1e15);

  it("adds a corner loop to a ring collapsed onto the corner, whose point GateLab holds", () => {
    expect(far(skirtRing([[R, R], [R, R], [R, R], [R, R]], { lo: L, hi: R }, { lo: L, hi: R }))).toBe(true);
    expect(far(skirtRing([[R, L], [R, L], [R, L], [R, L]], { lo: L, hi: R }, { lo: L, hi: R }))).toBe(true);
  });

  it("skirts a lone vertex on a clamp only where GateLab holds events beyond it, and writes clamp points at the inset", () => {
    // A vertex on a floor whose edges leave it at once: GateLab holds the events beyond the floor
    // that it decides onto the vertex, a stack at the value the vertex was drawn on (23 of 883 events
    // of a FlowJo log polygon on the public S8 file went to no reader). `ends` says how wide that is,
    // and NaN where GateLab holds nothing there.
    const ring: [number, number][] = [[L, 500], [2000, 800], [900, 3000]];
    const inset: [{ lo?: number; hi?: number }, undefined] = [{ lo: L + 1e-6 }, undefined];
    const held = (w: number, side: "lo" | "hi", _s: "lo" | "hi", alone?: boolean) => (alone ? w + (side === "lo" ? -0.5 : 0.5) : w);
    const none = (w: number, _side: "lo" | "hi", _s: "lo" | "hi", alone?: boolean) => (alone ? NaN : w);
    const a = skirtRing(ring, { lo: L, hi: R }, { lo: L, hi: R }, [undefined, held], inset);
    expect(far(a)).toBe(true);
    expect(a).toContainEqual([-1e15, 500.5]);
    expect(a).toContainEqual([-1e15, 499.5]);
    const b = skirtRing(ring, { lo: L, hi: R }, { lo: L, hi: R }, [undefined, none], inset);
    expect(far(b)).toBe(false);
    // No point is left on the clamp itself, where GateLab's own edge tolerance would hold the events there.
    for (const r of [a, b]) expect(r.some((p) => p[0] === L)).toBe(false);
    expect(b[0]).toEqual([L + 1e-6, 500]);
  });

  it("still skirts a corner that ends an edge, and an edge along a clamp", () => {
    expect(far(skirtRing([[L, L], [3000, L], [L, 3000]], { lo: L, hi: R }, { lo: L, hi: R }))).toBe(true);
    expect(far(skirtRing([[L, L], [L, L], [L, 3000], [L, 3000]], { lo: L, hi: R }, { lo: L, hi: R }))).toBe(true);
    expect(far(skirtRing([[R, R], [R, R], [200, R], [R, R]], { lo: L, hi: R }, { lo: L, hi: R }))).toBe(true);
  });
});

// The FlowJo export wrote a rectangle bound on a display at the edge's raw pre-image, where GateLab
// decides an event lying on the edge in double precision on its float32 column, and FlowJo read the
// events at 60 on a half-open asinh(60 / 15) edge the other way (flowjoExport.ts onGateLabSide). The
// Gating-ML export places each written bound among the file's own events for a reader in double
// precision (tieBreak), which covers the same events: checked here, for both formats and both edges.
// Synthetic names and events.
describe("Gating-ML export of an edge GateLab decides on its float32 display", () => {
  const fl = Float32Array.from([58, 59, 60, 60, 60, 61, 62, 63]);
  const fsc = new Float32Array(fl.length).fill(50000);
  const bytes = writeFcs([fsc, fl], [{ name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "CD4" }]);
  const read = () => new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  const edge = Math.asinh(60 / 15);

  it("writes each bound where a reader in double precision divides the events at the edge as GateLab does", () => {
    expect(Math.fround(edge)).toBeLessThan(edge);
    for (const format of ["standard", "cytobank"] as const) {
      const sample = read();
      const [x, y] = [sample.channels[0].key, sample.channels[1].key];
      const root = newRootPopulation();
      let populations: PopulationMap = { [root.population_id]: root };
      const gates: Record<string, Gate> = {};
      const add = (name: string, lo: number, hi: number, bounds: "closed" | "half-open") => {
        const g = {
          gate_id: uuid(), name, gate_type: "rectangle", x_channel: x, y_channel: y, color: "#000000", label_offset: null,
          vertices: [[0, lo], [100000, lo], [100000, hi], [0, hi]], space: "display",
          transforms: { [x]: { kind: "identity" }, [y]: { kind: "asinh", cofactor: 15 } }, bounds,
        } as Gate;
        gates[g.gate_id] = g;
        const p = newPopulation(`${name}_cells`, [newGateRef(g.gate_id, true)], root.population_id, "and");
        populations[p.population_id] = p;
        populations = linkChildToParent(populations, p.population_id, root.population_id);
        return { gate: g, pop: p.population_id };
      };
      const upper = add("Upper", Math.asinh(58.5 / 15), edge, "half-open");
      const lower = add("Lower", edge, Math.asinh(62.5 / 15), "closed");
      const { masks } = applyGatingStrategy(gates, populations, root.population_id, sample.gateAssayData());
      expect(Array.from(masks[upper.pop])).toEqual([0, 1, 1, 1, 1, 0, 0, 0]);
      expect(Array.from(masks[lower.pop])).toEqual([0, 0, 0, 0, 0, 1, 1, 0]);
      const xml = exportGatingML({ gates, gate_order: Object.keys(gates), populations, root_population_id: root.population_id, sample, format, timestamp: "2026-01-01T00:00:00" });
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      const transforms = new Map<string, (v: number) => number>();
      for (const t of Array.from(doc.getElementsByTagNameNS("*", "transformation"))) {
        const f = t.getElementsByTagNameNS("*", "fasinh")[0];
        if (!f) continue;
        const num = (k: string) => Number(f.getAttributeNS(f.namespaceURI, k) ?? f.getAttribute(`transforms:${k}`));
        const [T, M, A] = [num("T"), num("M"), num("A") || 0];
        transforms.set(t.getAttributeNS(t.namespaceURI, "id") ?? t.getAttribute("transforms:id") ?? "", (v) => (Math.asinh((v * Math.sinh(M * Math.LN10)) / T) + A * Math.LN10) / ((M + A) * Math.LN10));
      }
      // A standard reader: each rectangle's FL1-A dimension, half-open, on the file's fasinh of each event.
      const dims = Array.from(doc.getElementsByTagNameNS("*", "RectangleGate")).flatMap((r) => Array.from(r.getElementsByTagNameNS("*", "dimension"))
        .filter((d) => d.getElementsByTagNameNS("*", "fcs-dimension")[0]?.getAttribute("data-type:name") === "FL1-A"));
      expect(dims.length).toBe(2);
      const decide = (d: Element) => {
        const tr = transforms.get(d.getAttribute("gating:transformation-ref") ?? "") ?? ((v: number) => v);
        const min = d.getAttribute("gating:min");
        const max = d.getAttribute("gating:max");
        return Array.from(fl, (v) => ((min === null || tr(v) >= Number(min)) && (max === null || tr(v) < Number(max)) ? 1 : 0));
      };
      // The file's two rectangles, in the order written: GateLab's decisions, by a reader in double precision.
      const decided = dims.map(decide);
      expect(decided, format).toContainEqual(Array.from(masks[upper.pop]));
      expect(decided, format).toContainEqual(Array.from(masks[lower.pop]));
    }
  });
});
