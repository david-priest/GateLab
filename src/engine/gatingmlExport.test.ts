// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFcs, type FcsFile } from "./fcs";
import { Sample } from "./sample";
import { analyzeGatingMLQuadrantOmissions, exportGatingML } from "./gatingmlExport";
import { importGatingML, resolveGatingMLCompensation, restoreGatingMLScaleState } from "./gatingml";
import { getGateMask } from "./gates";
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
    // The rectangle's raw bounds, verbatim.
    expect(rawXml).toContain('gating:min="20000"');
    expect(rawXml).toContain('gating:max="90000"');
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
        if (format === "standard") expect(xml).toContain("<gating:GatingHierarchy");
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
        expect(xml2).toContain('"version":3');
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
    const imported = importGatingML(xml, source.channelNames());
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
    it(`rejects a root-level OR population exported in ${format} format`, () => {
      const { ws } = rootOrWorkspace();
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "2026-01-01T00:00:00" });
      expect(xml).toContain("<gating:or>");
      expect(() => importGatingML(xml, sessionChannels, pnnMap)).toThrow(
        /Population "Scatter OR signal" uses OR logic/,
      );
    });
  }

  it("rejects a nested OR population in standard format", () => {
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
    const xml = exportGatingML({ ...ws, sample, format: "standard" });
    expect(() => importGatingML(xml, sessionChannels, pnnMap)).toThrow(
      /Population "Nested OR" uses OR logic/,
    );
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
      /cannot safely represent the nested OR population "Nested OR"/,
    );
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
describe("densified polygon vertex collapse", () => {
  it("halves the pathological case and never simplifies away an original vertex", () => {
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
    // Measured 36 with the collapse (67 without it; ~130 if only the finer subdivision ran).
    expect(n).toBeLessThanOrEqual(45);
    expect(n).toBeGreaterThanOrEqual(raw.length);

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
