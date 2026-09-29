// @vitest-environment jsdom
//
// Gating-ML 2.0 conformance of what GateLab writes, on synthetic data so it runs on any machine.
//
// The round-trip suites prove GateLab reads its own files back. They cannot prove that anyone
// else can: GateLab's importer is lenient, and a file it accepts can still be rejected outright by
// a reader that follows the ISAC schema. FlowKit is one: it validates every document against the
// schema before parsing and refuses the whole file on the first violation.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FcsFile } from "./fcs";
import { Sample, transformFromSpec } from "./sample";
import { exportGatingML, GATELAB_ABOUT_LOGICLE_SCALE, type GatingMLFormat } from "./gatingmlExport";
import { importGatingML, resolveGatingMLCompensation } from "./gatingml";
import { invertMatrix } from "./compensation";
import { applyGatingStrategy } from "./populations";
import {
  newRootPopulation,
  newPopulation,
  newGateRef,
  linkChildToParent,
  type Gate,
  type GateRef,
  type PopulationMap,
  type TransformSpec,
  type Vertex,
} from "./models";

// ── A synthetic flow sample ──────────────────────────────────────────────────────────────────

/** Deterministic uniform [0, 1), so the fixture is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Three-colour flow data with a real negative population and a positive one on each marker, so a
 * gate boundary runs through dense data. Carries an FCS spillover matrix, and every fluorescence
 * channel has a $PnS, so the display key ("CD4") differs from the $PnN ("FITC-A").
 */
function syntheticFlowFcs(n = 4000, seed = 7): FcsFile {
  const u = prng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  const marker = (fracPos: number, mid: number) => () =>
    u() < fracPos ? Math.exp(Math.log(mid) + 0.6 * gauss()) : 250 * gauss();
  const cd4 = marker(0.45, 8000);
  const cd8 = marker(0.3, 5000);
  const cd3 = marker(0.7, 12000);
  const cols = { fsc: [] as number[], ssc: [] as number[], fitc: [] as number[], pe: [] as number[], apc: [] as number[], time: [] as number[] };
  for (let i = 0; i < n; i++) {
    cols.fsc.push(30000 + 150000 * u());
    cols.ssc.push(Math.exp(Math.log(40000) + 0.5 * gauss()));
    cols.fitc.push(cd4());
    cols.pe.push(cd8());
    cols.apc.push(cd3());
    cols.time.push(i);
  }
  const ch = (index: number, name: string, marker: string | null) =>
    ({ index, name, marker, bits: 32, range: 262144 });
  return {
    version: "FCS3.1",
    nEvents: n,
    instrument: "flow",
    keywords: {},
    spillover: {
      channels: ["FITC-A", "PE-A", "APC-A"],
      matrix: [[1, 0.12, 0.01], [0.02, 1, 0.05], [0, 0.03, 1]],
    },
    channels: [
      ch(0, "FSC-A", null), ch(1, "SSC-A", null), ch(2, "FITC-A", "CD4"),
      ch(3, "PE-A", "CD8"), ch(4, "APC-A", "CD3"), ch(5, "Time", null),
    ],
    columns: [cols.fsc, cols.ssc, cols.fitc, cols.pe, cols.apc, cols.time].map((c) => Float32Array.from(c)),
  };
}

const uuid = () => crypto.randomUUID();
const keyOf = (sample: Sample, pnn: string): string => sample.channels.find((c) => c.pnn === pnn)!.key;
const pnnMapOf = (sample: Sample): Record<string, string> =>
  Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key]));

function rawGate(name: string, type: "rectangle" | "polygon", x: string, y: string, vertices: Vertex[]): Gate {
  return { gate_id: uuid(), name, gate_type: type, x_channel: x, y_channel: y, vertices, color: "#377eb8", label_offset: null } as Gate;
}

/** A tree of populations, each entry [name, refs, parent name or null for root, logic]. */
function workspaceOf(gates: Gate[], pops: [string, GateRef[], string | null, ("and" | "or")?][]) {
  const root = newRootPopulation();
  let populations: PopulationMap = { [root.population_id]: root };
  const byName: Record<string, string> = {};
  for (const [name, refs, parent, logic] of pops) {
    const parentId = parent === null ? root.population_id : byName[parent];
    const p = newPopulation(name, refs, parentId, logic ?? "and");
    populations[p.population_id] = p;
    populations = linkChildToParent(populations, p.population_id, parentId);
    byName[name] = p.population_id;
  }
  return {
    gates: Object.fromEntries(gates.map((g) => [g.gate_id, g])),
    gate_order: gates.map((g) => g.gate_id),
    populations,
    root_population_id: root.population_id,
  };
}

type Workspace = ReturnType<typeof workspaceOf>;

/** Events per population, keyed by the population's name path from the root. */
function countsByPath(sample: Sample, ws: Pick<Workspace, "gates" | "populations" | "root_population_id">): Map<string, number[]> {
  const { masks } = applyGatingStrategy(ws.gates, ws.populations, ws.root_population_id, sample.gateAssayData());
  const out = new Map<string, number[]>();
  const walk = (id: string, path: string) => {
    for (const c of ws.populations[id].children) {
      const p = `${path}/${ws.populations[c].name}`;
      const m = masks[c];
      const idx: number[] = [];
      for (let i = 0; i < m.length; i++) if (m[i]) idx.push(i);
      out.set(p, idx);
      walk(c, p);
    }
  };
  walk(ws.root_population_id, "");
  return out;
}

const FORMATS: GatingMLFormat[] = ["standard", "cytobank"];

/** A display-space gate on the sample's own transforms, built from raw corners. */
function displayGate(sample: Sample, name: string, type: "rectangle" | "polygon", x: string, y: string, raw: Vertex[]): Gate {
  const g = { ...rawGate(name, type, x, y, raw), ...sample.newGateSpaceFields("display", x, y) } as Gate & { vertices: Vertex[] };
  g.vertices = raw.map(([vx, vy]) => [sample.rawToGate(g, x, vx), sample.rawToGate(g, y, vy)]);
  return g;
}

/**
 * Every construct the exporter writes, on flow data: raw, arcsinh, logicle and identity axes;
 * rectangles, polygons and an ellipse; a tree four deep; a gate shared by populations under
 * different parents; a single excluded reference; an exclusion among several references; and a
 * multi-gate AND.
 */
function richFlowWorkspace(sample: Sample) {
  const fsc = keyOf(sample, "FSC-A");
  const ssc = keyOf(sample, "SSC-A");
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const cd3 = keyOf(sample, "APC-A");
  const time = keyOf(sample, "Time");
  const cells = rawGate("Cells", "polygon", fsc, ssc, [[40000, 15000], [175000, 15000], [175000, 110000], [90000, 130000], [40000, 110000]]);
  // Two gate names whose standard base64 holds '/' ("Lymph?") and '+' ("Time >"), so every
  // validation case below also fails if a gate id is built from the standard alphabet.
  const lymph = displayGate(sample, "Lymph?", "rectangle", fsc, ssc, [[45000, 18000], [170000, 18000], [170000, 100000], [45000, 100000]]);
  const t = displayGate(sample, "CD3_positive", "rectangle", cd3, cd4, [[3000, -2000], [150000, -2000], [150000, 150000], [3000, 150000]]);
  const pos4 = displayGate(sample, "CD4_positive", "rectangle", cd4, cd8, [[2500, -1000], [150000, -1000], [150000, 1500], [2500, 1500]]);
  const pos8 = displayGate(sample, "CD8_positive", "polygon", cd4, cd8, [[-1000, 1500], [2500, 1200], [6000, 40000], [-1000, 60000]]);
  const ell: Gate = {
    gate_id: uuid(), name: "CD4 CD8 ellipse", gate_type: "ellipse", x_channel: cd4, y_channel: cd8,
    mean: [8000, 5000], covariance: [[1.2e7, 3e6], [3e6, 9e6]], distance_square: 2,
    color: "#000", label_offset: null, space: "raw",
  } as Gate;
  const early = rawGate("Time >", "rectangle", time, fsc, [[0, 0], [2000, 0], [2000, 262144], [0, 262144]]);
  const gates = [cells, lymph, t, pos4, pos8, ell, early];
  return workspaceOf(gates, [
    ["Cells", [newGateRef(cells.gate_id)], null],
    ["Lymph", [newGateRef(lymph.gate_id)], "Cells"],
    ["T cells", [newGateRef(t.gate_id)], "Lymph"],
    ["CD4 T", [newGateRef(pos4.gate_id)], "T cells"],
    ["CD8 T", [newGateRef(pos8.gate_id)], "T cells"],
    ["CD4 not CD8", [newGateRef(pos4.gate_id, true), newGateRef(pos8.gate_id, false)], "T cells"],
    ["Ellipse", [newGateRef(ell.gate_id)], "T cells"],
    ["Not T cells", [newGateRef(t.gate_id, false)], "Lymph"],
    ["CD4 in Lymph", [newGateRef(pos4.gate_id)], "Lymph"],
    ["CD3 and CD4", [newGateRef(t.gate_id), newGateRef(pos4.gate_id)], "Cells"],
    ["Early", [newGateRef(early.gate_id)], "Cells"],
  ]);
}

/** Each population as "name <- parent name : refs (logic)", so two trees compare as text. */
function treeShape(ws: Pick<Workspace, "gates" | "populations" | "root_population_id">): string[] {
  const out: string[] = [];
  for (const p of Object.values(ws.populations)) {
    if (p.population_id === ws.root_population_id) continue;
    const parent = p.parent_id === ws.root_population_id ? "(root)" : ws.populations[p.parent_id!].name;
    const refs = p.gate_refs.map((r) => `${r.include ? "" : "NOT "}${ws.gates[r.gate_id].name}`).sort().join(", ");
    out.push(`${p.name} <- ${parent} : ${refs} (${p.gate_logic})`);
  }
  return out.sort();
}

// ── Gate ids ─────────────────────────────────────────────────────────────────────────────────

describe("gate ids are valid xs:ID values", () => {
  const sample = new Sample(syntheticFlowFcs());
  const cd3 = keyOf(sample, "APC-A");
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  // Standard base64 of the first name contains '+' (from U+2212) and of the second '/'.
  const minus = rawGate("CD4 CD3−", "rectangle", cd3, cd4, [[-500, 3000], [2000, 3000], [2000, 60000], [-500, 60000]]);
  const query = rawGate("CD4 treated?", "rectangle", cd8, cd4, [[2000, 3000], [60000, 3000], [60000, 60000], [2000, 60000]]);
  const ws = workspaceOf([minus, query], [
    ["CD4 CD3−", [newGateRef(minus.gate_id)], null],
    ["CD4 treated?", [newGateRef(query.gate_id)], null],
  ]);

  for (const format of FORMATS) {
    it(`uses no character outside the xs:ID alphabet (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const ids = [...xml.matchAll(/gating:id="([^"]+)"/g)].map((m) => m[1]);
      expect(ids.length).toBeGreaterThanOrEqual(2);
      for (const id of ids) expect(id, id).toMatch(/^[A-Za-z_][A-Za-z0-9._-]*$/);
      // Cytobank's own spelling of the same name: '+' → '_'.
      expect(xml).toContain('gating:id="Gate_180000001_Q0Q0IENEM_KIkg.."');
      expect(xml).toContain('gating:id="Gate_180000002_Q0Q0IHRyZWF0ZWQ-"');
    });
  }

  it("still imports a file written with the old, standard-alphabet ids", () => {
    const xml = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" });
    const legacy = xml
      .replaceAll("Gate_180000001_Q0Q0IENEM_KIkg..", "Gate_180000001_Q0Q0IENEM+KIkg..")
      .replaceAll("Gate_180000002_Q0Q0IHRyZWF0ZWQ-", "Gate_180000002_Q0Q0IHRyZWF0ZWQ/");
    expect(legacy).toContain("Q0Q0IENEM+KIkg..");
    const now = importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow");
    const then = importGatingML(legacy, sample.channelNames(), pnnMapOf(sample), "flow");
    expect(then.n_gates_imported).toBe(2);
    expect(countsByPath(sample, then)).toEqual(countsByPath(sample, now));
    expect(countsByPath(sample, then)).toEqual(countsByPath(sample, ws));
  });
});

// ── Negated references ───────────────────────────────────────────────────────────────────────

describe("a negated reference is written the way Gating-ML 2.0 spells it", () => {
  const sample = new Sample(syntheticFlowFcs());
  const cd3 = keyOf(sample, "APC-A");
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const t = rawGate("T cells", "rectangle", cd3, cd4, [[3000, -2000], [100000, -2000], [100000, 100000], [3000, 100000]]);
  const pos8 = rawGate("CD8_positive", "rectangle", cd8, cd4, [[2000, -2000], [100000, -2000], [100000, 100000], [2000, 100000]]);
  // T cells that are NOT CD8_positive: one included and one excluded reference.
  const ws = workspaceOf([t, pos8], [
    ["CD3 not CD8", [newGateRef(t.gate_id, true), newGateRef(pos8.gate_id, false)], null],
  ]);

  it("uses use-as-complement, and the population survives the trip (cytobank)", () => {
    const xml = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" });
    expect(xml).toContain('gating:use-as-complement="true"');
    expect(xml).not.toMatch(/gating:complement=/);
    const back = importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow");
    const pop = Object.values(back.populations).find((p) => p.name === "CD3 not CD8")!;
    expect(pop.gate_refs.map((r) => r.include).sort()).toEqual([false, true]);
    const before = countsByPath(sample, ws);
    expect(before.get("/CD3 not CD8")!.length).toBeGreaterThan(0);
    expect(countsByPath(sample, back)).toEqual(before);
  });

  it("still reads the gating:complement attribute older GateLab files carry", () => {
    const xml = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" })
      .replaceAll('gating:use-as-complement="true"', 'gating:complement="true"');
    const back = importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow");
    expect(countsByPath(sample, back)).toEqual(countsByPath(sample, ws));
  });
});

// ── Dimension names ──────────────────────────────────────────────────────────────────────────

describe("dimensions name the FCS parameter, not GateLab's display label", () => {
  const sample = new Sample(syntheticFlowFcs());
  const cd3 = keyOf(sample, "APC-A");
  const cd4 = keyOf(sample, "FITC-A");
  const g = rawGate("CD4_positive", "rectangle", cd3, cd4, [[3000, 2000], [100000, 2000], [100000, 100000], [3000, 100000]]);
  const ws = workspaceOf([g], [["CD4_positive", [newGateRef(g.gate_id)], null]]);

  for (const format of FORMATS) {
    it(`writes $PnN in the ${format} format and reads it back`, () => {
      expect(cd4).not.toBe("FITC-A"); // the fixture must have a display label distinct from $PnN
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const names = new Set([...xml.matchAll(/<gating:dimension[^>]*>\s*<data-type:fcs-dimension data-type:name="([^"]+)"/g)].map((m) => m[1]));
      expect([...names].sort()).toEqual(["APC-A", "FITC-A"]);
      const back = importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow");
      const gate = Object.values(back.gates)[0];
      expect([gate.x_channel, gate.y_channel]).toEqual([cd3, cd4]);
      expect(countsByPath(sample, back)).toEqual(countsByPath(sample, ws));
    });
  }
});

// ── Range gates ──────────────────────────────────────────────────────────────────────────────

describe("a range gate is written with one dimension", () => {
  // GateLab holds a range (a one-dimensional Gating-ML RectangleGate) as a rectangle with the same
  // channel on both axes. Written that way, the parameter was named twice, and FlowKit failed on
  // the whole file.
  const sample = new Sample(syntheticFlowFcs());
  const cd4 = keyOf(sample, "FITC-A");
  const range = (bounds: string) => `<?xml version="1.0"?>
    <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
      xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
      <gating:RectangleGate gating:id="R1">
        <gating:dimension gating:compensation-ref="uncompensated" ${bounds}><data-type:fcs-dimension data-type:name="FITC-A"/></gating:dimension>
      </gating:RectangleGate>
    </gating:Gating-ML>`;

  for (const [bounds, format] of FORMATS.flatMap((f) =>
    ['gating:min="2000" gating:max="60000"', 'gating:min="2000"', 'gating:max="2000"'].map((b) => [b, f] as const))) {
    it(`keeps ${bounds} as a range and its events (${format})`, () => {
      const read = importGatingML(range(bounds), sample.channelNames(), pnnMapOf(sample), "flow");
      const gate = Object.values(read.gates)[0];
      expect([gate.x_channel, gate.y_channel]).toEqual([cd4, cd4]);
      const xml = exportGatingML({ ...read, sample, format, timestamp: "t" });
      const rect = xml.match(/<gating:RectangleGate[\s\S]*?<\/gating:RectangleGate>/)![0];
      const dims = [...rect.matchAll(/<gating:dimension ([^>]*)>/g)].map((m) => m[1]);
      expect(dims.length).toBe(1);
      for (const b of ["min", "max"]) expect(dims[0].includes(`gating:${b}=`), b).toBe(bounds.includes(`gating:${b}=`));
      const back = importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow");
      const n = countsByPath(sample, read).get("/R1")!.length;
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(sample.fcs.nEvents);
      expect(countsByPath(sample, back)).toEqual(countsByPath(sample, read));
      if (!SKIP_REASON) expect(validate(xml).errors.replace(/^- validates\s*$/m, "").trim()).toBe("");
    });
  }
});

// ── Logicle gates in the Cytobank format ─────────────────────────────────────────────────────

describe("a logicle gate re-expressed for Cytobank keeps its events", () => {
  const sample = new Sample(syntheticFlowFcs());
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  /** A display-space gate on the sample's own logicle axes, from raw corners. */
  const logicleGate = (name: string, type: "rectangle" | "polygon", raw: Vertex[]): Gate => {
    const g = { ...rawGate(name, type, cd4, cd8, raw), ...sample.newGateSpaceFields("display", cd4, cd8) } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([x, y]) => [sample.rawToGate(g, cd4, x), sample.rawToGate(g, cd8, y)]);
    return g;
  };
  const rect = logicleGate("CD4_positive", "rectangle", [[2000, -300], [60000, -300], [60000, 1500], [2000, 1500]]);
  const poly = logicleGate("CD8_positive", "polygon", [[-400, 1500], [1500, 1200], [4000, 30000], [-400, 40000]]);
  const ws = workspaceOf([rect, poly], [
    ["CD4_positive", [newGateRef(rect.gate_id)], null],
    ["CD8_positive", [newGateRef(poly.gate_id)], null],
  ]);

  it("is written from GateLab's [0, 1] logicle coordinate, not a rescaled one", () => {
    expect(sample.transformKind(sample.index(cd4)!)).toBe("logicle");
    const xml = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" });
    const back = importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow");
    const before = countsByPath(sample, ws);
    const after = countsByPath(sample, back);
    for (const [path, idx] of before) {
      expect(idx.length / sample.fcs.nEvents, `${path} is a partial population`).toBeGreaterThan(0.05);
      const got = new Set(after.get(path)!);
      const moved = idx.filter((i) => !got.has(i)).length + (got.size - idx.filter((i) => got.has(i)).length);
      // The rectangle maps exactly (a monotonic map keeps an axis-aligned box); the polygon is
      // densified, within the exporter's 0.2% tolerance.
      expect(moved, `${path}: ${moved} of ${idx.length} events moved`).toBeLessThanOrEqual(Math.max(1, Math.ceil(idx.length * 0.005)));
    }
  });
});

// ── Logicle coordinates in the standard format ───────────────────────────────────────────────

describe("the standard format writes logicle on Gating-ML's own scale", () => {
  const sample = new Sample(syntheticFlowFcs());
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const raw: Vertex[] = [[2000, -300], [60000, -300], [60000, 1500], [2000, 1500]];
  const g = { ...rawGate("CD4_positive", "rectangle", cd4, cd8, raw), ...sample.newGateSpaceFields("display", cd4, cd8) } as Gate & { vertices: Vertex[] };
  g.vertices = raw.map(([x, y]) => [sample.rawToGate(g, cd4, x), sample.rawToGate(g, cd8, y)]);
  const ws = workspaceOf([g], [["CD4_positive", [newGateRef(g.gate_id)], null]]);
  const xml = exportGatingML({ ...ws, sample, format: "standard", timestamp: "t" });
  const dims = [...xml.matchAll(/<gating:dimension ([^>]*)>/g)].map((m) => m[1]);
  const attr = (a: string, name: string) => Number(a.match(new RegExp(`gating:${name}="([^"]+)"`))![1]);

  it("maps T to 1, so a bound is the logicle value a standard reader computes", () => {
    // Gating-ML 2.0 logicle(T) = 1; GateLab's own display coordinate is the same function.
    expect(dims.length).toBe(2);
    for (const d of dims) expect(d).toMatch(/transformation-ref="Tr_Logicle_/);
    expect(attr(dims[0], "min")).toBeCloseTo(sample.rawToGate(g, cd4, 2000), 12);
    expect(attr(dims[0], "max")).toBeCloseTo(sample.rawToGate(g, cd4, 60000), 12);
    expect(attr(dims[0], "max")).toBeLessThan(1);
    expect(xml).toContain('<gatelab_format>{"version":3');
  });

  it("reads a file written on flowCore's scale (T at M), without the mark, as it was written", () => {
    // As GateLab wrote before 2026-09 and GateLabR still writes: no mark, gatelabr_scales at version
    // 3 or earlier (version 4 is written only with the mark, and says the scale on its own), and an
    // about text that does not name the scale.
    const legacy = xml
      .replace(/\s*<gatelab_format>[^<]*<\/gatelab_format>/, "")
      .replace(`; ${GATELAB_ABOUT_LOGICLE_SCALE}`, "")
      .replace('{"version":4,', '{"version":3,')
      .replace(/gating:(min|max)="([^"]+)"/g, (_m, k: string, v: string) => `gating:${k}="${Number(v) * 4.5}"`);
    expect(legacy).not.toContain("gatelab_format");
    expect(legacy).toContain('{"version":3,');
    const now = importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow");
    const then = importGatingML(legacy, sample.channelNames(), pnnMapOf(sample), "flow");
    const before = countsByPath(sample, ws);
    expect(before.get("/CD4_positive")!.length / sample.fcs.nEvents).toBeGreaterThan(0.05);
    expect(countsByPath(sample, now)).toEqual(before);
    expect(countsByPath(sample, then)).toEqual(before);
  });
});

// ── The standard format's hierarchy ──────────────────────────────────────────────────────────

describe("the standard format places populations with gating:parent_id", () => {
  const sample = new Sample(syntheticFlowFcs());
  sample.setCompensation(true);
  const ws = richFlowWorkspace(sample);
  const xml = exportGatingML({ ...ws, sample, format: "standard", timestamp: "t" });
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const elements = Array.from(doc.documentElement.children);
  const byId = new Map(elements.map((el) => [el.getAttribute("gating:id"), el]));
  const nameOf = (el: Element) => el.getElementsByTagName("name")[0]?.textContent ?? null;
  const populationEls = elements.filter((el) => el.localName === "BooleanGate" && el.getAttribute("gating:id")!.startsWith("GateSet_"));

  it("writes no GatingHierarchy, and one BooleanGate per population", () => {
    expect(sample.compensationEnabled).toBe(true);
    expect(xml).not.toContain("GatingHierarchy");
    expect(xml).not.toContain("PopulationGatePair");
    expect(populationEls.map(nameOf).sort()).toEqual(
      Object.values(ws.populations).filter((p) => p.population_id !== ws.root_population_id).map((p) => p.name).sort());
  });

  it("gives each population its parent's id, and no geometric gate a parent", () => {
    for (const el of elements) {
      if (["RectangleGate", "PolygonGate", "EllipsoidGate"].includes(el.localName)) {
        expect(el.hasAttribute("gating:parent_id"), el.getAttribute("gating:id")!).toBe(false);
      }
    }
    const popByName = new Map(Object.values(ws.populations).map((p) => [p.name, p]));
    for (const el of populationEls) {
      const pop = popByName.get(nameOf(el)!)!;
      const parentId = el.getAttribute("gating:parent_id");
      if (pop.parent_id === ws.root_population_id) expect(parentId).toBeNull();
      else expect(nameOf(byId.get(parentId)!)).toBe(ws.populations[pop.parent_id!].name);
    }
  });

  it("writes a lone exclusion as NOT, and an exclusion among several through a NOT gate", () => {
    const notT = populationEls.find((el) => nameOf(el) === "Not T cells")!;
    expect(notT.getElementsByTagName("gating:not").length).toBe(1);
    const mixed = populationEls.find((el) => nameOf(el) === "CD4 not CD8")!;
    const refs = Array.from(mixed.getElementsByTagName("gating:gateReference")).map((r) => r.getAttribute("gating:ref")!);
    expect(refs.length).toBe(2);
    const helper = byId.get(refs.find((r) => r.startsWith("Not_"))!)!;
    expect(helper.localName).toBe("BooleanGate");
    expect(helper.getElementsByTagName("gatelab_operand").length).toBe(1);
    expect(helper.getElementsByTagName("gating:not").length).toBe(1);
    expect(xml).not.toContain("use-as-complement");
  });

  it("comes back as the same tree, selecting the same events", () => {
    const back = importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow");
    expect(back.n_pops_imported).toBe(Object.keys(ws.populations).length - 1);
    expect(treeShape(back)).toEqual(treeShape(ws));
    // Sibling order too, which treeShape sorts away: the file lists parents first, children in order.
    const order = (t: Pick<Workspace, "populations" | "root_population_id">) => {
      const out: string[] = [];
      const walk = (id: string) => { for (const c of t.populations[id].children) { out.push(t.populations[c].name); walk(c); } };
      walk(t.root_population_id);
      return out;
    };
    expect(order(back)).toEqual(order(ws));
    const before = countsByPath(sample, ws);
    for (const [path, idx] of before) {
      expect(idx.length, `${path} is not empty`).toBeGreaterThan(0);
      expect(idx.length, `${path} is not everything`).toBeLessThan(sample.fcs.nEvents);
    }
    expect(countsByPath(sample, back)).toEqual(before);
  });

  it("is read by Gating-ML 2.0's model when it has lost GateLab's mark, selecting the same events", () => {
    // Each gate's custom_info carries a `cytobank` element, so a standard file without the root mark
    // was read by Cytobank's model and refused (a NOT operand is a nested Boolean reference there),
    // and its logicle gates were taken on flowCore's scale, 4.5 times too low.
    const stripped = xml.replace(/\s*<gatelab_format>[^<]*<\/gatelab_format>/, "");
    expect(stripped).not.toBe(xml);
    const back = importGatingML(stripped, sample.channelNames(), pnnMapOf(sample), "flow");
    // Every gate is a population by that model, so the geometric gates and the NOT operand come back
    // as populations of their own; GateLab's populations come back where they were, with their events.
    const got = countsByPath(sample, back);
    for (const [path, idx] of countsByPath(sample, ws)) expect(got.get(path), path).toEqual(idx);
  });

  it("is read on Gating-ML's logicle scale when it has lost GateLab's mark and gatelabr_scales but kept its about text", () => {
    // The about text says who wrote the file, and GateLab and GateLabR wrote it before 2026-09 on
    // flowCore's scale, so a rewriter that kept the text and dropped the rest had every logicle gate
    // read 4.5 times too low, and said nothing (T cells 0 of 47,255 on the public PBMC file). The
    // text now says the scale too.
    const stripped = xml
      .replace(/\s*<gatelab_format>[^<]*<\/gatelab_format>/, "")
      .replace(/\s*<gatelabr_scales>\s*<definition>[^<]*<\/definition>\s*<\/gatelabr_scales>/, "");
    expect(stripped).not.toContain("gatelab_format");
    expect(stripped).not.toContain("gatelabr_scales");
    expect(stripped).toMatch(/<about>Gating-ML 2\.0 export from GateLab/);
    const back = importGatingML(stripped, sample.channelNames(), pnnMapOf(sample), "flow");
    const got = countsByPath(sample, back);
    const before = countsByPath(sample, ws);
    expect(before.get("/Cells/Lymph/T cells")!.length).toBeGreaterThan(100);
    for (const [path, idx] of before) expect(got.get(path), path).toEqual(idx);
  });

  it("refuses a file in which a geometric gate has been given a parent", () => {
    // A reader following Gating-ML would narrow every population using that gate as an operand;
    // GateLab would not, so the two would disagree. Refusing is the only safe reading.
    const cellsId = [...xml.matchAll(/<gating:PolygonGate gating:id="([^"]+)"/g)][0][1];
    const edited = xml.replace(/<gating:RectangleGate gating:id="([^"]+)">/, `<gating:RectangleGate gating:id="$1" gating:parent_id="${cellsId}">`);
    expect(edited).not.toBe(xml);
    expect(() => importGatingML(edited, sample.channelNames(), pnnMapOf(sample), "flow"))
      .toThrow(/only a population may have one/);
  });
});

// ── The Cytobank format's tree ───────────────────────────────────────────────────────────────

describe("the Cytobank format carries each population's parent", () => {
  const sample = new Sample(syntheticFlowFcs());
  sample.setCompensation(true);
  const ws = richFlowWorkspace(sample);
  const xml = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" });
  const order = (t: Pick<Workspace, "populations" | "root_population_id">) => {
    const out: string[] = [];
    const walk = (id: string) => { for (const c of t.populations[id].children) { out.push(t.populations[c].name); walk(c); } };
    walk(t.root_population_id);
    return out;
  };
  const mark = () => JSON.parse(xml.match(/<gatelab_format>([^<]*)<\/gatelab_format>/)![1].replaceAll("&amp;", "&"));

  it("lists every population with its parent in the root custom_info, parents first", () => {
    const m = mark();
    expect(m).toMatchObject({ version: 3, logicle: "gating-ml", hierarchy: "tree", time: "ticks" });
    expect(m.tree.length).toBe(Object.keys(ws.populations).length - 1);
    const seen = new Set<string | null>([null]);
    for (const { id, parent } of m.tree) {
      expect(seen.has(parent), `${id} after its parent`).toBe(true);
      seen.add(id);
    }
    // Still no population references another: that is what Cytobank refuses.
    expect(xml).not.toMatch(/gating:ref="GateSet_/);
  });

  it("comes back as exactly the tree it came from, selecting the same events", () => {
    const back = importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow");
    expect(treeShape(back)).toEqual(treeShape(ws));
    expect(order(back)).toEqual(order(ws));
    expect(countsByPath(sample, back)).toEqual(countsByPath(sample, ws));
  });

  it("is needed: inferred from the flattened chains, a population moves under a sibling", () => {
    // CD4 not CD8 ANDs T cells' chain with CD4_positive and NOT CD8_positive, which contains CD4
    // T's whole chain, so inference files it under CD4 T. Its events are the same either way.
    const inferred = importGatingML(xml.replace(/\s*<gatelab_format>[^<]*<\/gatelab_format>/, ""),
      sample.channelNames(), pnnMapOf(sample), "flow");
    expect(treeShape(inferred)).not.toEqual(treeShape(ws));
    expect(treeShape(inferred)).toContain("CD4 not CD8 <- CD4 T : NOT CD8_positive (and)");
    const events = countsByPath(sample, ws).get("/Cells/Lymph/T cells/CD4 not CD8");
    expect(events!.length).toBeGreaterThan(0);
    expect(countsByPath(sample, inferred).get("/Cells/Lymph/T cells/CD4 T/CD4 not CD8")).toEqual(events);
  });

  it("keeps a population whose gates all repeat its ancestors', under its parent", () => {
    // Its BooleanGate is the same chain as its parent's, so it selects its parent's events. With
    // the tree mark it was left out with everything beneath it, and the population beneath it
    // stayed in the map with a parent that did not exist; the import raised nothing.
    const fsc = keyOf(sample, "FSC-A");
    const ssc = keyOf(sample, "SSC-A");
    const cd4 = keyOf(sample, "FITC-A");
    const poly = rawGate("Poly gate", "polygon", fsc, ssc, [[40000, 15000], [175000, 15000], [175000, 110000], [40000, 110000]]);
    const pos = displayGate(sample, "CD4_positive", "rectangle", cd4, ssc, [[2500, 0], [150000, 0], [150000, 262144], [2500, 262144]]);
    const again = workspaceOf([poly, pos], [
      ["Poly pop", [newGateRef(poly.gate_id)], null],
      ["Poly again", [newGateRef(poly.gate_id)], "Poly pop"],
      ["Under poly again", [newGateRef(pos.gate_id)], "Poly again"],
    ]);
    const x = exportGatingML({ ...again, sample, format: "cytobank", timestamp: "t" });
    const back = importGatingML(x, sample.channelNames(), pnnMapOf(sample), "flow");
    expect(treeShape(back)).toEqual(treeShape(again));
    expect(countsByPath(sample, back)).toEqual(countsByPath(sample, again));
    for (const p of Object.values(back.populations)) {
      if (p.population_id !== back.root_population_id) expect(back.populations[p.parent_id!], p.name).toBeDefined();
    }
  });

  it("refuses a tree that does not describe the file", () => {
    const m = mark();
    const edited = (tree: unknown) => xml.replace(/<gatelab_format>[^<]*<\/gatelab_format>/,
      `<gatelab_format>${JSON.stringify({ ...m, tree })}</gatelab_format>`);
    const read = (x: string) => () => importGatingML(x, sample.channelNames(), pnnMapOf(sample), "flow");
    expect(read(edited(m.tree.slice(1)))).toThrow(/does not list the population/);
    expect(read(edited([...m.tree].reverse()))).toThrow(/not a population listed before it/);
    expect(read(edited([...m.tree, { id: "Gate_missing", parent: null }]))).toThrow(/not a Boolean gate/);
  });
});

// ── Cytobank's own files: the tree inferred ─────────────────────────────────────────────────

describe("a Cytobank file without GateLab's tree is inferred with its exclusions respected", () => {
  // Cytobank's own exports carry no tree: every population ANDs its whole ancestry, and the
  // importer infers each parent as the largest population whose references it contains. Compared
  // by gate alone, a population excluding a gate went under the population including it.
  const sample = new Sample(syntheticFlowFcs());
  const fsc = keyOf(sample, "FSC-A");
  const ssc = keyOf(sample, "SSC-A");
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const cd3 = keyOf(sample, "APC-A");
  const cells = rawGate("Cells", "polygon", fsc, ssc, [[40000, 15000], [175000, 15000], [175000, 110000], [90000, 130000], [40000, 110000]]);
  const t = rawGate("CD3_positive", "rectangle", cd3, cd8, [[3000, -2000], [150000, -2000], [150000, 150000], [3000, 150000]]);
  const pos4 = rawGate("CD4_positive", "rectangle", cd4, cd8, [[2500, -1000], [150000, -1000], [150000, 150000], [2500, 150000]]);
  const ws = workspaceOf([cells, t, pos4], [
    ["Cells", [newGateRef(cells.gate_id)], null],
    ["T cells", [newGateRef(t.gate_id)], "Cells"],
    ["Neither T nor CD4", [newGateRef(t.gate_id, false), newGateRef(pos4.gate_id, false)], "Cells"],
    ["CD4 not T", [newGateRef(pos4.gate_id), newGateRef(t.gate_id, false)], "Cells"],
  ]);
  const cytobankOwn = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" })
    .replace(/\s*<gatelab_format>[^<]*<\/gatelab_format>/, "");

  it("places each population under the population it is inside, and keeps its events", () => {
    expect(cytobankOwn).not.toContain("gatelab_format");
    const back = importGatingML(cytobankOwn, sample.channelNames(), pnnMapOf(sample), "flow");
    expect(treeShape(back)).toEqual(treeShape(ws));
    const before = countsByPath(sample, ws);
    for (const [path, idx] of before) {
      expect(idx.length, `${path} is a partial population`).toBeGreaterThan(0);
      expect(idx.length, `${path} is a partial population`).toBeLessThan(sample.fcs.nEvents);
    }
    expect(countsByPath(sample, back)).toEqual(before);
  });
});

// ── A matrix that is not the FCS file's own ──────────────────────────────────────────────────

/** The synthetic sample compensated with a matrix of its own, not the FCS's (the S6 case). */
function externallyCompensated(): Sample {
  const sample = new Sample(syntheticFlowFcs());
  sample.installExternalSpillover({
    channels: ["FITC-A", "PE-A", "APC-A"],
    matrix: [[1, 0.2, 0.03], [0.05, 1, 0.1], [0.01, 0.06, 1]],
  }, "Matrix_B1", { replaceEmbedded: true });
  sample.setCompensation(true);
  return sample;
}

describe("the standard format carries a matrix that is not the FCS file's own", () => {
  const sample = externallyCompensated();
  const ws = richFlowWorkspace(sample);
  const xml = exportGatingML({ ...ws, sample, format: "standard", timestamp: "t" });
  const dims = [...xml.matchAll(/<gating:dimension ([^>]*)>\s*<data-type:fcs-dimension data-type:name="([^"]+)"/g)]
    .map((m) => ({ ref: m[1].match(/compensation-ref="([^"]+)"/)![1], name: m[2] }));
  /** The same data, as a fresh load of the FCS: its own matrix only. */
  const fresh = () => new Sample(syntheticFlowFcs());

  it("writes the matrix as a spectrumMatrix and points each compensated dimension at it", () => {
    expect(sample.spilloverOrigin.kind).toBe("external");
    expect(xml).toContain('<transforms:spectrumMatrix transforms:id="Spill_1">');
    expect(xml).not.toContain('compensation-ref="FCS"');
    // A dimension compensated by a matrix the file defines is named by its fluorochrome (§4.2.2).
    const compensated = dims.filter((d) => d.ref === "Spill_1").map((d) => d.name);
    expect(new Set(compensated)).toEqual(new Set(["Comp_FITC-A", "Comp_PE-A", "Comp_APC-A"]));
    for (const d of dims.filter((x) => x.ref === "uncompensated")) expect(["FSC-A", "SSC-A", "Time"]).toContain(d.name);
  });

  it("imports into a fresh load with that matrix, not the FCS file's, and the same events", () => {
    const target = fresh();
    const back = importGatingML(xml, target.channelNames(), pnnMapOf(target), "flow");
    expect(back.compensation_refs.sort()).toEqual(["matrix", "uncompensated"]);
    expect(back.spectrum_matrix).toMatchObject({ id: "Spill_1", name: "Matrix_B1", channels: ["FITC-A", "PE-A", "APC-A"] });
    const preview = target.externalSpilloverPreview(back.spectrum_matrix!);
    expect(resolveGatingMLCompensation(back.compensation, back.compensation_refs, true, preview.display))
      .toEqual({ target: true, source: "embedded", requiresConfirmation: false });
    // With the FCS file's own matrix instead, GateLab's record of the matrix does not match.
    expect(() => resolveGatingMLCompensation(back.compensation, back.compensation_refs, true, target.spillover))
      .toThrow(/different FCS spillover matrix/);
    target.installExternalSpillover(back.spectrum_matrix!, back.spectrum_matrix!.name, { replaceEmbedded: true });
    target.setCompensation(true);
    expect(treeShape(back)).toEqual(treeShape(ws));
    expect(countsByPath(target, back)).toEqual(countsByPath(sample, ws));
    // And the FCS file's matrix would have placed the compensated gates elsewhere.
    const fcsOnly = fresh();
    fcsOnly.setCompensation(true);
    expect(countsByPath(fcsOnly, back)).not.toEqual(countsByPath(sample, ws));
  });

  it("is read from the dimensions alone by a reader without GateLab's own record", () => {
    const thirdParty = xml.replace(/\s*<gatelabr_scales>[\s\S]*?<\/gatelabr_scales>/, "");
    const target = fresh();
    const back = importGatingML(thirdParty, target.channelNames(), pnnMapOf(target), "flow");
    expect(back.compensation).toBeNull();
    const preview = target.externalSpilloverPreview(back.spectrum_matrix!);
    expect(resolveGatingMLCompensation(back.compensation, back.compensation_refs, true, preview.display))
      .toEqual({ target: true, source: "dimensions", requiresConfirmation: true });
  });

  it("also reads a dimension that names the detector rather than the fluorochrome, as FlowKit does", () => {
    const byDetector = xml.replace(/(<gating:dimension gating:compensation-ref="Spill_1"[^>]*>\s*<data-type:fcs-dimension data-type:name=")Comp_/g, "$1");
    expect(byDetector).not.toMatch(/Spill_1"[^>]*>\s*<data-type:fcs-dimension data-type:name="Comp_/);
    const target = fresh();
    const back = importGatingML(byDetector, target.channelNames(), pnnMapOf(target), "flow");
    target.installExternalSpillover(back.spectrum_matrix!, back.spectrum_matrix!.name, { replaceEmbedded: true });
    target.setCompensation(true);
    expect(countsByPath(target, back)).toEqual(countsByPath(sample, ws));
  });

  it("takes a matrix the file gives already inverted, as §7.2 allows", () => {
    const block = xml.match(/<transforms:spectrumMatrix[\s\S]*?<\/transforms:spectrumMatrix>/)![0];
    const spill = [...block.matchAll(/<transforms:spectrum>([\s\S]*?)<\/transforms:spectrum>/g)]
      .map((r) => [...r[1].matchAll(/transforms:value="([^"]+)"/g)].map((v) => Number(v[1])));
    const inverse = invertMatrix(spill)!;
    let row = 0;
    const inverted = block
      .replace('transforms:id="Spill_1"', 'transforms:id="Spill_1" transforms:matrix-inverted-already="true"')
      .replace(/<transforms:spectrum>[\s\S]*?<\/transforms:spectrum>/g, () =>
        `<transforms:spectrum>${inverse[row++].map((v) => `<transforms:coefficient transforms:value="${v}" />`).join("")}</transforms:spectrum>`);
    const target = fresh();
    const back = importGatingML(xml.replace(block, inverted), target.channelNames(), pnnMapOf(target), "flow");
    back.spectrum_matrix!.matrix.forEach((r, i) => r.forEach((v, j) => expect(v).toBeCloseTo(spill[i][j], 12)));
  });

  it("refuses a matrix GateLab cannot apply, or two matrices at once", () => {
    const read = (x: string) => () => importGatingML(x, fresh().channelNames(), pnnMapOf(fresh()), "flow");
    // Spectral unmixing: two fluorochromes from three detectors.
    const unmixing = xml
      .replace(/<data-type:fcs-dimension data-type:name="Comp_APC-A" \/>\s*/, "")
      .replace(/(<transforms:spectrum>[\s\S]*?<\/transforms:spectrum>\s*){3}/, (m) =>
        m.split("</transforms:spectrum>").slice(0, 2).join("</transforms:spectrum>") + "</transforms:spectrum>\n");
    expect(read(unmixing)).toThrow(/square spillover matrix only/);
    const mixed = xml.replace('gating:compensation-ref="Spill_1"', 'gating:compensation-ref="FCS"');
    expect(read(mixed)).toThrow(/more than one spillover matrix/);
    expect(read(xml.replaceAll('gating:compensation-ref="Spill_1"', 'gating:compensation-ref="Spill_9"')))
      .toThrow(/unsupported compensation matrix "Spill_9"/);
  });

  it("imports the Cytobank format into a fresh load with that matrix, named by each gate's compensation_id", () => {
    // Cytobank's format keeps "FCS" on the dimension and names the gate's matrix in custom_info
    // compensation_id. Read as "FCS", GateLab's own export was refused in a fresh session as a
    // matrix mismatch, since its record of the matrix is not the FCS file's.
    const cytobank = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" });
    const target = fresh();
    const back = importGatingML(cytobank, target.channelNames(), pnnMapOf(target), "flow");
    expect(back.spectrum_matrix).toMatchObject({ id: "Spill_1", name: "Matrix_B1", channels: ["FITC-A", "PE-A", "APC-A"] });
    expect(back.compensation_refs.sort()).toEqual(["matrix", "uncompensated"]);
    const preview = target.externalSpilloverPreview(back.spectrum_matrix!);
    expect(resolveGatingMLCompensation(back.compensation, back.compensation_refs, true, preview.display))
      .toEqual({ target: true, source: "embedded", requiresConfirmation: false });
    target.installExternalSpillover(back.spectrum_matrix!, back.spectrum_matrix!.name, { replaceEmbedded: true });
    target.setCompensation(true);
    expect(treeShape(back)).toEqual(treeShape(ws));
    // The Cytobank format re-expresses logicle gates as arcsinh and densifies them, so a
    // population may move by the exporter's boundary tolerance; the wrong matrix moves far more.
    const before = countsByPath(sample, ws);
    const moved = (a: number[], b: number[]) => { const sb = new Set(b); const sa = new Set(a); return a.filter((i) => !sb.has(i)).length + b.filter((i) => !sa.has(i)).length; };
    for (const [path, idx] of countsByPath(target, back)) {
      expect(moved(idx, before.get(path)!), path).toBeLessThanOrEqual(Math.max(1, Math.ceil(before.get(path)!.length * 0.005)));
    }
  });

  it("reads a Cytobank file's named compensation from compensation_id without GateLab's own record", () => {
    const cytobankOwn = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" })
      .replace(/\s*<gatelabr_scales>[\s\S]*?<\/gatelabr_scales>/, "")
      .replace(/\s*<gatelab_format>[^<]*<\/gatelab_format>/, "");
    const target = fresh();
    const back = importGatingML(cytobankOwn, target.channelNames(), pnnMapOf(target), "flow");
    expect(back.compensation).toBeNull();
    expect(back.spectrum_matrix?.name).toBe("Matrix_B1");
    const preview = target.externalSpilloverPreview(back.spectrum_matrix!);
    expect(resolveGatingMLCompensation(back.compensation, back.compensation_refs, true, preview.display))
      .toEqual({ target: true, source: "dimensions", requiresConfirmation: true });
    // compensation_id 0 is the FCS file's own matrix, as before.
    const own = importGatingML(cytobankOwn.replaceAll("<compensation_id>1</compensation_id>", "<compensation_id>0</compensation_id>"),
      target.channelNames(), pnnMapOf(target), "flow");
    expect(own.spectrum_matrix).toBeNull();
    expect(own.compensation_refs.sort()).toEqual(["FCS", "uncompensated"]);
  });

  it("names the gates whose compensation_id names a matrix the file does not carry, and never takes the FCS file's", () => {
    // A Cytobank file without GateLab's record: every compensated dimension says FCS, and the
    // gates name their matrix by compensation_id alone. Without the spectrumMatrix they were read
    // as compensated by the FCS file's own matrix, with nothing said (754 to 1,990 events moved
    // on the public Fortessa file).
    const cytobankOwn = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" })
      .replace(/\s*<gatelabr_scales>[\s\S]*?<\/gatelabr_scales>/, "")
      .replace(/\s*<gatelab_format>[^<]*<\/gatelab_format>/, "")
      .replace(/\s*<transforms:spectrumMatrix[\s\S]*?<\/transforms:spectrumMatrix>/, "");
    const target = fresh();
    const back = importGatingML(cytobankOwn, target.channelNames(), pnnMapOf(target), "flow");
    const compensatedGates = Object.values(back.gates)
      .filter((g) => [g.x_channel, g.y_channel].some((ch) => target.spillover?.channels.includes(ch)))
      .map((g) => g.name).sort();
    expect(compensatedGates.length).toBeGreaterThan(0);
    expect(back.missing_compensation).toEqual({ id: 1, gates: compensatedGates });
    expect(back.compensation_refs).not.toContain("FCS");
    expect(back.compensation_refs).toContain("missing");
    // Resolved as compensated, with confirmation, so the dialog asks for the matrix.
    expect(resolveGatingMLCompensation(back.compensation, back.compensation_refs, true, target.spillover))
      .toEqual({ target: true, source: "dimensions", requiresConfirmation: true });
    // Gates on the FCS file's own matrix beside them would need two matrices at once: refused.
    const mixed = cytobankOwn.replace("<compensation_id>1</compensation_id>", "<compensation_id>0</compensation_id>");
    expect(() => importGatingML(mixed, target.channelNames(), pnnMapOf(target), "flow")).toThrow(/more than one spillover matrix/);
  });

  it("leaves the Cytobank format as Cytobank writes it: FCS on the dimension, the matrix by id in custom_info", () => {
    const cytobank = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" });
    expect(cytobank).toContain('<transforms:spectrumMatrix transforms:id="Spill_1">');
    expect(cytobank).not.toContain('compensation-ref="Spill_1"');
    expect(cytobank).toContain('compensation-ref="FCS"');
    expect(cytobank).toContain("<compensation_id>1</compensation_id>");
  });
});

// ── Gate edges at a clamp ────────────────────────────────────────────────────────────────────

/**
 * A population's events as a reader that follows Gating-ML 2.0 and nothing else finds them, on
 * uncompensated data: a rectangle bound is half-open, [min, max), a missing bound is no bound, flog
 * is undefined at or below zero, and a polygon holds a point by the even-odd crossing rule with
 * nothing added for its boundary. Only what the gates in these tests are written with is read:
 * raw and flog dimensions, rectangles and polygons. It is not GateLab's importer, which is the
 * point: the importer reads GateLab's own files as GateLab means them.
 */
function standardReaderEvents(
  xml: string, gateName: string, sample: Sample, edges: "strict" | "inclusive" = "strict",
  /**
   * Moves the value a declared transform gives, as a reader whose own logicle or arcsinh differs from
   * GateLab's in the last places does (FlowKit's by up to 2.2e-16 for logicle and a few units in the
   * last place for arcsinh). Raw values are read as they are.
   */
  perturb: (v: number) => number = (v) => v,
  /**
   * Moves each raw value before any transform, on the gate's first or second dimension, as a reader
   * that compensates in double precision, where GateLab rounds the compensated value to single,
   * lands up to half a single-precision step either side of GateLab's.
   */
  perturbRaw: (v: number, dim: number) => number = (v) => v,
): number[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const els = Array.from(doc.documentElement.children);
  const gate = els.find((el) => /Gate$/.test(el.localName) && el.localName !== "BooleanGate" &&
    el.getElementsByTagName("name")[0]?.textContent === gateName)!;
  expect(gate, gateName).toBeTruthy();
  const declared = new Map<string, (x: number) => number>();
  for (const el of els) {
    if (el.localName !== "transformation") continue;
    const num = (t: Element, a: string) => Number(t.getAttribute(`transforms:${a}`));
    const f = el.getElementsByTagName("transforms:flog")[0];
    const l = el.getElementsByTagName("transforms:logicle")[0];
    const h = el.getElementsByTagName("transforms:fasinh")[0];
    const id = el.getAttribute("transforms:id")!;
    if (f) declared.set(id, (x) => (x > 0 ? Math.log10(x / num(f, "T")) / num(f, "M") + 1 : NaN));
    else if (l) {
      const t = transformFromSpec({ kind: "logicle", T: num(l, "T"), W: num(l, "W"), M: num(l, "M"), A: num(l, "A") });
      declared.set(id, (x) => t.forward(x));
    } else if (h) {
      const [T, M, A] = [num(h, "T"), num(h, "M"), num(h, "A")];
      declared.set(id, (x) => (Math.asinh((x * Math.sinh(M * Math.LN10)) / T) + A * Math.LN10) / ((M + A) * Math.LN10));
    }
  }
  const dims = Array.from(gate.children).filter((c) => c.localName === "dimension").map((d, dim) => {
    const name = d.getElementsByTagName("data-type:fcs-dimension")[0].getAttribute("data-type:name")!;
    const col = sample.rawColumnData(sample.channels.findIndex((c) => c.pnn === name));
    const ref = d.getAttribute("gating:transformation-ref");
    if (ref && !declared.has(ref)) throw new Error(`standardReaderEvents does not read ${ref}`);
    const f = ref ? declared.get(ref)! : null;
    const at = (i: number) => (f ? perturb(f(perturbRaw(col[i], dim))) : perturbRaw(col[i], dim));
    const bound = (a: string) => (d.hasAttribute(a) ? Number(d.getAttribute(a)) : null);
    return { at, min: bound("gating:min"), max: bound("gating:max") };
  });
  const out: number[] = [];
  const n = sample.fcs.nEvents;
  if (gate.localName === "EllipsoidGate") {
    // As FlowKit reads one: the covariance inverted in general, and an event held when its form is at
    // most distanceSquare.
    const value = (el: Element) => Number(el.getAttribute("data-type:value"));
    const mean = Array.from(gate.getElementsByTagName("gating:mean")[0].getElementsByTagName("gating:coordinate")).map(value);
    const [[a, b], [c, d]] = Array.from(gate.getElementsByTagName("gating:row")).map((r) => Array.from(r.getElementsByTagName("gating:entry")).map(value));
    const d2 = value(gate.getElementsByTagName("gating:distanceSquare")[0]);
    const det = a * d - b * c;
    const [i00, i01, i10, i11] = [d / det, -b / det, -c / det, a / det];
    for (let i = 0; i < n; i++) {
      const dx = dims[0].at(i) - mean[0];
      const dy = dims[1].at(i) - mean[1];
      if (dx * (i00 * dx + i01 * dy) + dy * (i10 * dx + i11 * dy) <= d2) out.push(i);
    }
    return out;
  }
  if (gate.localName === "RectangleGate") {
    for (let i = 0; i < n; i++) {
      if (dims.every((d) => { const v = d.at(i); return (d.min === null || v >= d.min) && (d.max === null || v < d.max); })) out.push(i);
    }
    return out;
  }
  const verts = Array.from(gate.children).filter((c) => c.localName === "vertex").map((v) =>
    Array.from(v.getElementsByTagName("gating:coordinate")).map((c) => Number(c.getAttribute("data-type:value"))));
  for (let i = 0; i < n; i++) {
    const px = dims[0].at(i);
    const py = dims[1].at(i);
    // FlowKit's rule: an event on an edge is inside. The plain even-odd test holds it on some
    // edges and not on others.
    if (edges === "inclusive" && verts.some(([ax, ay], a) => {
      const [bx, by] = verts[(a + 1) % verts.length];
      return (bx - ax) * (py - ay) === (by - ay) * (px - ax) &&
        px >= Math.min(ax, bx) && px <= Math.max(ax, bx) && py >= Math.min(ay, by) && py <= Math.max(ay, by);
    })) { out.push(i); continue; }
    let inside = false;
    for (let a = 0, b = verts.length - 1; a < verts.length; b = a++) {
      const [ax, ay] = verts[a];
      const [bx, by] = verts[b];
      if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
    }
    if (inside) out.push(i);
  }
  return out;
}

describe("a gate edge at its axis's clamp keeps the events beyond it for a standard reader", () => {
  // GateLab, like FlowJo, evaluates an event beyond a clamp at the clamp: below FlowJo's log
  // offset, below GateLab's flog floor, beyond either end of a biex table. A gate edge there holds
  // all of them. Written as a bound at the clamp (biex, in raw) or as flog (log), a standard reader
  // dropped them: FlowKit lost 36,480 of 67,751 events of a log rectangle on the public PBMC file,
  // and 2,759 of 6,253 of a biex rectangle on the S8 file, whose biex table ends at −93.5.
  const sample = new Sample(syntheticFlowFcs());
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const biex: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const wsplog: TransformSpec = { kind: "wsplog", offset: 1, decades: 4.5 };
  const flog: TransformSpec = { kind: "flog", T: 262144, M: 4.5 };
  const inSpace = (name: string, type: "rectangle" | "polygon", spec: TransformSpec, raw: Vertex[]): Gate => {
    const g = { ...rawGate(name, type, cd4, cd8, raw), space: "display", transforms: { [cd4]: spec, [cd8]: spec } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, cd8, vy)]);
    return g;
  };
  const mixed = (name: string, xs: TransformSpec, ys: TransformSpec, raw: Vertex[]): Gate => {
    const g = { ...rawGate(name, "polygon", cd4, cd8, raw), space: "display", transforms: { [cd4]: xs, [cd8]: ys } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, cd8, vy)]);
    return g;
  };
  // Raw corners far below each clamp, which the transforms pin to it, and far above biex's top.
  const gates = [
    inSpace("biex floor rect", "rectangle", biex, [[-1e6, -1e6], [3000, -1e6], [3000, 2000], [-1e6, 2000]]),
    inSpace("biex top rect", "rectangle", biex, [[3000, -300], [1e9, -300], [1e9, 1e9], [3000, 1e9]]),
    inSpace("biex floor poly", "polygon", biex, [[-1e6, -1e6], [4000, -1e6], [6000, 3000], [-1e6, 5000]]),
    inSpace("log floor rect", "rectangle", wsplog, [[-1e6, -1e6], [2000, -1e6], [2000, 1500], [-1e6, 1500]]),
    inSpace("flog floor rect", "rectangle", flog, [[-1e6, -1e6], [2000, -1e6], [2000, 1500], [-1e6, 1500]]),
    // A log polygon on the floor. Written as flog, the events below the floor were outside it for
    // every reader, GateLab's own re-import included (9,101 of 54,784 kept on the public PBMC file).
    inSpace("log floor poly", "polygon", wsplog, [[-1e6, -1e6], [3000, -1e6], [2500, 2500], [-1e6, 4000]]),
    inSpace("flog floor poly", "polygon", flog, [[-1e6, -1e6], [3000, -1e6], [2500, 2500], [-1e6, 4000]]),
    mixed("log by biex floor poly", wsplog, biex, [[-1e6, -1e6], [3000, -1e6], [2500, 2500], [-1e6, 4000]]),
    // Two edges along the same floor, one over the other: GateLab holds every event beyond the
    // floor between them. A strip per edge cancelled where the two overlapped, for every even-odd
    // reader, GateLab's own re-import included (57 of 379 events on the public Aurora file).
    inSpace("log floor poly retraced", "polygon", wsplog, [[-1e6, -1e6], [3000, -1e6], [-1e6, 2500], [-1e6, 4000]]),
  ];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const counts = countsByPath(sample, ws);

  it("uses fixtures in which the clamp holds a real share of the events", () => {
    for (const g of gates) {
      const n = counts.get(`/${g.name}`)!.length;
      expect(n, g.name).toBeGreaterThan(sample.fcs.nEvents * 0.05);
      expect(n, g.name).toBeLessThan(sample.fcs.nEvents * 0.95);
    }
  });

  for (const format of FORMATS) {
    it(`is written so that a reader following the standard alone keeps them (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const theirs = standardReaderEvents(xml, g.name, sample);
        const mineSet = new Set(mine);
        const differ = theirs.filter((i) => !mineSet.has(i)).length + mine.length - theirs.filter((i) => mineSet.has(i)).length;
        // A rectangle is exact. A polygon goes out densified in raw space and held to the file's
        // events, so at most an event on its boundary is decided differently.
        expect(differ, `${g.name}: ${differ} of ${mine.length} events differ`)
          .toBeLessThanOrEqual(g.gate_type === "rectangle" ? 0 : Math.max(1, Math.floor(mine.length * 0.001)));
      }
      if (!SKIP_REASON) expect(validate(xml).errors.replace(/^- validates\s*$/m, "").trim()).toBe("");
    });

    it(`comes back into GateLab with the same events (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const got = back.get(`/${g.name}`)!;
        const set = new Set(got);
        const differ = mine.filter((i) => !set.has(i)).length + got.length - mine.filter((i) => set.has(i)).length;
        expect(differ, `${g.name}: ${differ} of ${mine.length}`)
          .toBeLessThanOrEqual(g.gate_type === "rectangle" ? 0 : Math.max(1, Math.floor(mine.length * 0.001)));
      }
    });
  }
});

describe("a rectangle's bounds: at least one on every dimension, and the Cytobank definition agrees", () => {
  // Gating-ML 2.0 requires gating:min or gating:max on every dimension (§5.1.1). A rectangle
  // spanning both ends of a biex table on one axis was written with neither there. And the Cytobank
  // format's custom_info definition kept a clamp edge at the clamp's raw value where the dimension
  // left the bound out: a FlowJo log rectangle at the floor was bounded at 1 in the definition,
  // which holds 8,765 events on the public PBMC file where the dimension holds 51,849.
  const sample = new Sample(syntheticFlowFcs());
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const biex: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const wsplog: TransformSpec = { kind: "wsplog", offset: 1, decades: 4.5 };
  const flog: TransformSpec = { kind: "flog", T: 262144, M: 4.5 };
  const inSpace = (name: string, spec: TransformSpec, raw: Vertex[], y = cd8): Gate => {
    const g = { ...rawGate(name, "rectangle", cd4, y, raw), space: "display", transforms: { [cd4]: spec, [y]: spec } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, y, vy)]);
    return g;
  };
  const gates = [
    inSpace("log floor rect", wsplog, [[-1e6, -1e6], [2000, -1e6], [2000, 1500], [-1e6, 1500]]),
    inSpace("flog floor rect", flog, [[-1e6, -1e6], [2000, -1e6], [2000, 1500], [-1e6, 1500]]),
    inSpace("biex floor rect", biex, [[-1e6, -1e6], [3000, -1e6], [3000, 2000], [-1e6, 2000]]),
    inSpace("biex span x rect", biex, [[-1e9, 500], [1e9, 500], [1e9, 5000], [-1e9, 5000]]),
    inSpace("biex span both rect", biex, [[-1e9, -1e9], [1e9, -1e9], [1e9, 1e9], [-1e9, 1e9]]),
    inSpace("biex range span", biex, [[-1e9, -1e9], [1e9, -1e9], [1e9, 1e9], [-1e9, 1e9]], cd4),
  ];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const counts = countsByPath(sample, ws);
  const element = (xml: string, name: string) =>
    (xml.match(/<gating:RectangleGate\b[\s\S]*?<\/gating:RectangleGate>/g) ?? []).find((g) => g.includes(`<name>${name}</name>`))!;
  const boundsOf = (el: string) => (el.match(/<gating:dimension\b[^>]*>/g) ?? []).map((d) => ({
    min: /gating:min="([^"]+)"/.exec(d)?.[1], max: /gating:max="([^"]+)"/.exec(d)?.[1],
  }));

  for (const format of FORMATS) {
    it(`writes at least one bound on every dimension, valid and read as GateLab reads it (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      for (const g of gates) {
        for (const b of boundsOf(element(xml, g.name))) expect(b.min ?? b.max, `${g.name}: a dimension with no bound`).toBeDefined();
        const mine = counts.get(`/${g.name}`)!;
        const theirs = standardReaderEvents(xml, g.name, sample);
        const set = new Set(mine);
        expect(theirs.length, g.name).toBe(mine.length);
        expect(theirs.every((i) => set.has(i)), g.name).toBe(true);
      }
      if (!SKIP_REASON) expect(validate(xml).errors.replace(/^- validates\s*$/m, "").trim()).toBe("");
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      for (const g of gates) expect(back.get(`/${g.name}`), g.name).toEqual(counts.get(`/${g.name}`));
    });
  }

  it("bounds the Cytobank definition exactly as its dimensions are bounded", () => {
    const xml = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" });
    const U = Number.MAX_VALUE;
    for (const g of gates) {
      const el = element(xml, g.name);
      const [bx, by = bx] = boundsOf(el);
      const def = JSON.parse(/<definition>([\s\S]*?)<\/definition>/.exec(el)![1]).rectangle;
      const want = (b: string | undefined, none: number) => (b === undefined ? none : Number(b));
      expect([def.x1, def.x2, def.y1, def.y2], g.name)
        .toEqual([want(bx.min, -U), want(bx.max, U), want(by.min, -U), want(by.max, U)]);
    }
  });
});

describe("a rectangle edge on an event's own value", () => {
  // Integer-valued data (the public S8 file's) puts events exactly on a gate edge drawn at an
  // integer. GateLab counts an edge's events inside. Its own re-import did not always: a biex
  // bound was the raw value the table inverts the edge to, which can sit a little beyond the event,
  // and every bound was rounded to 15 significant figures; a log bound, written as flog, is decided
  // on the event's value in single precision (Sample.pinnedColumn), which rounds v and v + 1
  // differently. And a reader that follows the standard excludes an event on a max bound. On the
  // verifier's S8 strategy that was 6 of 1,316, 4 of 1,805 and 2 of 1,623 events.
  const base = syntheticFlowFcs(4000, 5);
  base.columns[2] = Float32Array.from(base.columns[2], Math.round);
  base.columns[3] = Float32Array.from(base.columns[3], Math.round);
  const sample = new Sample(base);
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const col = (k: string) => Array.from(sample.rawColumnData(sample.index(k)!));
  const xs = col(cd4).filter((v) => v > 10).sort((a, b) => a - b);
  const ys = col(cd8).filter((v) => v > 10).sort((a, b) => a - b);
  const q = (a: number[], p: number) => a[Math.floor(p * (a.length - 1))];
  const specs: [string, TransformSpec][] = [
    ["biex", { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 }],
    ["biex 1000", { kind: "biex", maxValue: 1000, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 }],
    ["log", { kind: "wsplog", offset: 1, decades: 4.5 }],
    ["flog", { kind: "flog", T: 262144, M: 4.5 }],
  ];
  const gates: Gate[] = [];
  for (const [name, spec] of specs) {
    for (const [lo, hi] of [[0.2, 0.6], [0.3, 0.7], [0.4, 0.8], [0.5, 0.9]] as const) {
      const g = { ...rawGate(`${name} ${lo}`, "rectangle", cd4, cd8, []), space: "display", transforms: { [cd4]: spec, [cd8]: spec } } as Gate & { vertices: Vertex[] };
      g.vertices = ([[q(xs, lo), q(ys, lo)], [q(xs, hi), q(ys, hi)]] as Vertex[])
        .map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, cd8, vy)]);
      gates.push(g);
    }
  }
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));

  for (const format of FORMATS) {
    it(`comes back into GateLab, and is read by the standard alone, holding the same events (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const counts = countsByPath(sample, ws);
      for (const [, idx] of counts) expect(idx.length).toBeGreaterThan(50);
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      for (const [path, idx] of counts) expect(back.get(path), path).toEqual(idx);
      for (const g of gates) expect(standardReaderEvents(xml, g.name, sample), g.name).toEqual(counts.get(`/${g.name}`));
    });
  }
});

describe("a biex polygon written in raw space keeps its boundary where the events are", () => {
  // Measured in raw space as a fraction of the polygon's raw extent, the densification tolerance
  // was hundreds of raw units near zero, where biex spreads the densest events; measured where
  // GateLab evaluates the gate, it holds there too.
  const sample = new Sample(syntheticFlowFcs(20000, 3));
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const biex: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const g = { ...rawGate("biex poly", "polygon", cd4, cd8, []), space: "display", transforms: { [cd4]: biex, [cd8]: biex } } as Gate & { vertices: Vertex[] };
  g.vertices = ([[-60, 150], [150000, -50], [120000, 150000], [-40, 90000]] as Vertex[])
    .map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, cd8, vy)]);
  const ws = workspaceOf([g], [["biex poly", [newGateRef(g.gate_id)], null]]);

  for (const format of FORMATS) {
    it(`differs from GateLab by at most 0.1% of the population for a standard reader (${format})`, () => {
      const mine = countsByPath(sample, ws).get("/biex poly")!;
      expect(mine.length).toBeGreaterThan(sample.fcs.nEvents * 0.2);
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const theirs = standardReaderEvents(xml, "biex poly", sample);
      const set = new Set(mine);
      const differ = theirs.filter((i) => !set.has(i)).length + mine.length - theirs.filter((i) => set.has(i)).length;
      expect(differ, `${differ} of ${mine.length} events differ`).toBeLessThanOrEqual(Math.ceil(mine.length * 0.001));
    });
  }
});

describe("a densified gate is held to the exported file's own events", () => {
  // A bound on the boundary's distance is not a bound on events. On the public Fortessa file an
  // edge through the dense cloud near zero moved 8 of 1,122 events of a biex polygon at 0.05% of
  // the gate's extent. The export now splits every chord a reader of the file would place an event
  // on the wrong side of, until none is left.
  const u = prng(21);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  const base = syntheticFlowFcs(30000, 9);
  // Most events in a tight cloud a little above zero, where biex spreads them widest.
  base.columns[2] = Float32Array.from({ length: 30000 }, (_, i) => (i % 3 ? 20 + 8 * gauss() : Math.exp(7 + gauss())));
  base.columns[3] = Float32Array.from({ length: 30000 }, (_, i) => (i % 3 ? 25 + 8 * gauss() : Math.exp(7 + gauss())));
  const sample = new Sample(base);
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const biex: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const inSpace = (name: string, spec: TransformSpec | null, raw: Vertex[]): Gate => {
    const g = { ...rawGate(name, "polygon", cd4, cd8, raw), ...(spec ? { space: "display", transforms: { [cd4]: spec, [cd8]: spec } } : sample.newGateSpaceFields("display", cd4, cd8)) } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, cd8, vy)]);
    return g;
  };
  const corner = inSpace("biex corner through the cloud", biex, [[21, 21], [1e9, 40], [1e9, 1e9], [40, 1e9]]);
  const slant = inSpace("biex slant through the cloud", biex, [[-200, 60], [3000, -40], [6000, 5000], [-150, 3000]]);
  const logicle = inSpace("logicle slant through the cloud", null, [[-200, 60], [3000, -40], [6000, 5000], [-150, 3000]]);
  const sp = sample.newGateSpaceFields("display", cd4, cd8);
  const mid = [sample.rawToGate(sp as Gate, cd4, 25), sample.rawToGate(sp as Gate, cd8, 30)];
  const ellipse = { gate_id: uuid(), name: "logicle ellipse on the cloud", gate_type: "ellipse", x_channel: cd4, y_channel: cd8,
    mean: mid, covariance: [[0.004, 0.0015], [0.0015, 0.003]], distance_square: 1, color: "#000", label_offset: null, ...sp } as Gate;
  const gates = [corner, slant, logicle, ellipse];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const counts = countsByPath(sample, ws);

  for (const format of FORMATS) {
    it(`differs from GateLab by at most 0.1% of each population, and one event at least (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        expect(mine.length, g.name).toBeGreaterThan(300);
        const got = back.get(`/${g.name}`)!;
        const set = new Set(got);
        const differ = mine.filter((i) => !set.has(i)).length + got.length - mine.filter((i) => set.has(i)).length;
        expect(differ, `${format} ${g.name}: ${differ} of ${mine.length}`).toBeLessThanOrEqual(Math.max(1, Math.floor(mine.length * 0.001)));
      }
      // The raw ones read by the standard alone, too.
      for (const g of [corner, slant]) {
        const mine = counts.get(`/${g.name}`)!;
        const theirs = standardReaderEvents(xml, g.name, sample);
        const set = new Set(mine);
        const differ = theirs.filter((i) => !set.has(i)).length + mine.length - theirs.filter((i) => set.has(i)).length;
        expect(differ, `${format} ${g.name} (standard reader): ${differ} of ${mine.length}`).toBeLessThanOrEqual(Math.max(1, Math.floor(mine.length * 0.001)));
      }
      if (!SKIP_REASON) expect(validate(xml).errors.replace(/^- validates\s*$/m, "").trim()).toBe("");
    });
  }
});

describe("an ellipse written as its boundary follows the ellipse, not its first chords", () => {
  // An ellipse on axes that bend in the export space (logicle re-expressed for Cytobank, biex or a
  // log floor in raw) goes out as its boundary, from 64 arcs subdivided until each written chord
  // lay within the tolerance of the arc's own chord. Where the space barely bent an arc, the arc was
  // never split, and the boundary strayed from the ellipse by up to 0.12% of its radius whatever the
  // tolerance: another file's events near it were placed by chance, 29 of 25,417 of a logicle
  // ellipse exported from one public GvHD file and read on another.
  const n = 200000;
  const draw = (seed: number) => {
    const fcs = syntheticFlowFcs(n, seed);
    const u = prng(seed + 100);
    // Events spread evenly over the ellipse's display box, so as many lie near its edge as anywhere.
    const probe = new Sample(syntheticFlowFcs(10, 1));
    const sp = probe.newGateSpaceFields("display", keyOf(probe, "FITC-A"), keyOf(probe, "PE-A")) as Gate;
    fcs.columns[2] = Float32Array.from({ length: n }, () => probe.gateToRaw(sp, keyOf(probe, "FITC-A"), 0.35 + 0.3 * u()));
    fcs.columns[3] = Float32Array.from({ length: n }, () => probe.gateToRaw(sp, keyOf(probe, "PE-A"), 0.35 + 0.3 * u()));
    return new Sample(fcs);
  };
  const exporting = draw(41);
  const reading = draw(42);
  const cd4 = keyOf(exporting, "FITC-A");
  const cd8 = keyOf(exporting, "PE-A");
  const sp = exporting.newGateSpaceFields("display", cd4, cd8);
  const ellipse = { gate_id: uuid(), name: "logicle ellipse", gate_type: "ellipse", x_channel: cd4, y_channel: cd8,
    mean: [0.5, 0.5], covariance: [[0.01, 0.004], [0.004, 0.008]], distance_square: 1, color: "#000", label_offset: null, ...sp } as Gate;
  const biex: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const biexEllipse = { gate_id: uuid(), name: "biex ellipse", gate_type: "ellipse", x_channel: cd4, y_channel: cd8,
    mean: [exporting.rawToGate({ space: "display", transforms: { [cd4]: biex, [cd8]: biex } } as Gate, cd4, 2000), 0],
    covariance: [[0, 0], [0, 0]], distance_square: 1, color: "#000", label_offset: null, space: "display", transforms: { [cd4]: biex, [cd8]: biex } } as Gate & { mean: number[]; covariance: number[][] };
  // Centred where the logicle one is, in the biex display.
  const bx = (v: number) => exporting.rawToGate(biexEllipse, cd4, exporting.gateToRaw(sp as Gate, cd4, v));
  const by = (v: number) => exporting.rawToGate(biexEllipse, cd8, exporting.gateToRaw(sp as Gate, cd8, v));
  biexEllipse.mean = [bx(0.5), by(0.5)];
  const rx = (bx(0.6) - bx(0.4)) / 2;
  const ry = (by(0.6) - by(0.4)) / 2;
  biexEllipse.covariance = [[rx * rx, 0.3 * rx * ry], [0.3 * rx * ry, ry * ry]];
  const gates = [ellipse, biexEllipse];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const counts = countsByPath(reading, ws);
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };

  for (const format of FORMATS) {
    // Spread evenly over the box, a band 0.12% of the radius wide holds about 0.05% of the
    // ellipse's events, and one at the tolerance a fifth of that.
    it(`places at most 0.025% of another file's events differently (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample: exporting, format, timestamp: "t" });
      const back = countsByPath(reading, importGatingML(xml, reading.channelNames(), pnnMapOf(reading), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        expect(mine.length, g.name).toBeGreaterThan(20000);
        const d = differ(mine, back.get(`/${g.name}`)!);
        if (d > mine.length * 0.00025) bad.push(`${g.name}: ${d} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 60000);
  }
});

describe("an ellipse reaching a log floor", () => {
  // GateLab places every event below a FlowJo log or flog floor on the floor, and an ellipse that
  // reaches the floor holds those whose other value it crosses there. Written as an EllipsoidGate in
  // flog, it held none of them for any reader, GateLab reading the file back included, since flog is
  // not pinned at the floor: 674 of 679 events of such an ellipse on the public PBMC file and 21 of
  // 29 on the Fortessa file were lost in GateLab's own round trip, in both formats.
  const sample = (() => {
    const fcs = syntheticFlowFcs(8000, 181);
    const u = prng(182);
    // A third of the events at or below FlowJo log's offset of 1, and so on its floor, the rest above.
    const pick = () => (u() < 0.33 ? Math.fround(1 - 400 * u()) : Math.fround(10 ** (4 * u())));
    fcs.columns[2] = Float32Array.from(fcs.columns[2], pick);
    fcs.columns[3] = Float32Array.from(fcs.columns[3], pick);
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const ellipse = (name: string, spec: TransformSpec, mean: [number, number], r: [number, number], rho: number): Gate => ({
    gate_id: uuid(), name, gate_type: "ellipse", x_channel: cd4, y_channel: cd8, mean,
    covariance: [[r[0] * r[0], rho * r[0] * r[1]], [rho * r[0] * r[1], r[1] * r[1]]], distance_square: 1,
    color: "#000", label_offset: null, space: "display", transforms: { [cd4]: spec, [cd8]: spec },
  } as Gate);
  const log: TransformSpec = { kind: "wsplog", offset: 1, decades: 4.5 };
  const flog: TransformSpec = { kind: "flog", T: 262144, M: 4.5 };
  // flog's floor is at 0 in its own space as FlowJo log's is; raw 1 is 0 for FlowJo log and 0.03 or
  // so above flog's floor.
  const gates = [
    ellipse("log across the x floor", log, [0.1, 0.5], [0.2, 0.15], 0.3),
    ellipse("log in the corner", log, [0.05, 0.08], [0.15, 0.12], 0),
    ellipse("log clear of the floor", log, [0.6, 0.6], [0.1, 0.1], 0.2),
    ellipse("flog across the y floor", flog, [0.5, 0.15], [0.12, 0.25], -0.2),
    ellipse("flog in the corner", flog, [0.12, 0.12], [0.2, 0.2], 0.1),
  ];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };

  it("uses fixtures in which the floor holds a real share of each ellipse that reaches it", () => {
    const counts = countsByPath(sample, ws);
    const x = sample.rawColumnData(sample.index(cd4)!);
    const y = sample.rawColumnData(sample.index(cd8)!);
    for (const g of gates.filter((g) => !g.name.includes("clear"))) {
      const idx = counts.get(`/${g.name}`)!;
      const floor = g.name.startsWith("flog") ? 262144 * 10 ** -4.5 : 1;
      expect(idx.filter((i) => x[i] <= floor || y[i] <= floor).length, g.name).toBeGreaterThan(50);
    }
  });

  for (const format of FORMATS) {
    it(`holds what GateLab holds, for GateLab reading it back and for a standard reader (${format})`, () => {
      const counts = countsByPath(sample, ws);
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d1 = differ(mine, back.get(`/${g.name}`)!);
        // An EllipsoidGate is GateLab's re-import alone; a boundary polygon is a standard reader's too.
        const doc = new DOMParser().parseFromString(xml, "application/xml");
        const polygon = Array.from(doc.documentElement.children).some((el) =>
          el.localName === "PolygonGate" && el.getElementsByTagName("name")[0]?.textContent === g.name);
        const d2 = polygon ? differ(mine, standardReaderEvents(xml, g.name, sample)) : 0;
        if (d1 || d2) bad.push(`${g.name}: GateLab ${d1}, standard ${d2} of ${mine.length}`);
        if (!g.name.includes("clear") && !polygon) bad.push(`${g.name} is not written as its boundary`);
      }
      expect(bad).toEqual([]);
    }, 60000);
  }
});

describe("a gate whose boundary runs through the corner of two floors", () => {
  // GateLab places every event below both FlowJo log floors at the corner, and holds all of them when
  // the gate holds that point. A boundary through the corner comes out of the clip to the floors a
  // hair to one side of it, and the corner went unskirted: 2,601 of 3,929 events of an ellipse through
  // the corner on the public Fortessa file, 8,385 of 11,698 on the DiVa file, in both readers, and
  // 89,057 of a polygon through a biex table's top corner on the PBMC file.
  const sample = (() => {
    const fcs = syntheticFlowFcs(8000, 191);
    const u = prng(192);
    const pick = () => (u() < 0.4 ? Math.fround(1 - 400 * u()) : Math.fround(10 ** (4 * u())));
    fcs.columns[2] = Float32Array.from(fcs.columns[2], pick);
    fcs.columns[3] = Float32Array.from(fcs.columns[3], pick);
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const log: TransformSpec = { kind: "wsplog", offset: 1, decades: 4.5 };
  const space = { space: "display", transforms: { [cd4]: log, [cd8]: log } };
  // Through the corner: the quadratic form at (0, 0) is exactly 1 for a mean half a radius from each
  // floor and a correlation of −0.5.
  const ellipse = (name: string, rx: number, ry: number): Gate => ({
    gate_id: uuid(), name, gate_type: "ellipse", x_channel: cd4, y_channel: cd8, mean: [0.5 * rx, 0.5 * ry],
    covariance: [[rx * rx, -0.5 * rx * ry], [-0.5 * rx * ry, ry * ry]], distance_square: 1,
    color: "#000", label_offset: null, ...space,
  } as Gate);
  const polygon = (name: string, vertices: Vertex[]): Gate =>
    ({ ...rawGate(name, "polygon", cd4, cd8, vertices), ...space } as Gate);
  const gates = [
    ellipse("ellipse through the corner", 0.3, 0.2),
    ellipse("narrow ellipse through the corner", 0.12, 0.4),
    polygon("triangle with an edge through the corner", [[-0.1, -0.1], [0.4, 0.4], [0.1, 0.5]]),
    polygon("quadrilateral with an edge through the corner", [[-0.3, -0.1], [0.45, 0.15], [0.5, 0.5], [0.1, 0.3]]),
  ];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };

  it("uses gates that hold the stack at the corner", () => {
    const counts = countsByPath(sample, ws);
    const x = sample.rawColumnData(sample.index(cd4)!);
    const y = sample.rawColumnData(sample.index(cd8)!);
    for (const g of gates) {
      expect(counts.get(`/${g.name}`)!.filter((i) => x[i] <= 1 && y[i] <= 1).length, g.name).toBeGreaterThan(500);
    }
  });

  for (const format of FORMATS) {
    it(`holds the corner's events for GateLab reading it back and for a standard reader (${format})`, () => {
      const counts = countsByPath(sample, ws);
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d = [differ(mine, back.get(`/${g.name}`)!)];
        for (const rule of ["strict", "inclusive"] as const) d.push(differ(mine, standardReaderEvents(xml, g.name, sample, rule)));
        if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 60000);
  }
});

describe("a polygon vertex or edge on an event's own value", () => {
  // GateLab holds an event on a polygon's edge and decides on its value in single precision; a
  // reader computes the value itself and decides an event on an edge by its own rule. A vertex
  // drawn on a quantized event's value left those events to rounding: up to 4 events of a
  // population on the public files, 1 of 203 of the smallest, in FlowKit and in GateLab's own
  // re-import.
  const level = (k: number) => Math.fround(10 ** (k / 16));
  const sample = (() => {
    const fcs = syntheticFlowFcs(6000, 41);
    const u = prng(141);
    // Log-amplified data on a lattice of 64 values per axis, as the public GvHD files are.
    fcs.columns[2] = Float32Array.from(fcs.columns[2], () => level(Math.floor(u() * 64)));
    fcs.columns[3] = Float32Array.from(fcs.columns[3], () => level(Math.floor(u() * 64)));
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const inSpace = (name: string, spec: TransformSpec, raw: Vertex[]): Gate => {
    const g = { ...rawGate(name, "polygon", cd4, cd8, raw), space: "display", transforms: { [cd4]: spec, [cd8]: spec } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, cd8, vy)]);
    return g;
  };
  const L = level;
  // Vertices on lattice values, and edges along a lattice row and column.
  const shapes: [string, Vertex[]][] = [
    ["corners", [[L(20), L(28)], [L(36), L(22)], [L(55), L(40)], [L(30), L(58)]]],
    ["rows", [[L(22), L(22)], [L(45), L(22)], [L(45), L(50)], [L(22), L(50)]]],
  ];
  const spaces: [string, TransformSpec][] = [
    ["biex", { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 }],
    ["biex4096", { kind: "biex", maxValue: 262144, pos: 4.5, neg: 1, widthBasis: -100, channelRange: 4096 }],
    ["flog", { kind: "flog", T: 262144, M: 4.5 }],
    ["log", { kind: "wsplog", offset: 1, decades: 4.5 }],
    ["logicle", { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 }],
  ];
  const gates = spaces.flatMap(([label, spec]) => shapes.map(([shape, raw]) => inSpace(`${label} ${shape}`, spec, raw)));
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };

  for (const format of FORMATS) {
    it(`is decided as GateLab decides it by GateLab and by readers of either edge rule (${format})`, () => {
      const counts = countsByPath(sample, ws);
      // The fixture is a real test: GateLab holds events on these boundaries.
      expect(gates.reduce((t, g) => t + counts.get(`/${g.name}`)!.length, 0)).toBeGreaterThan(1000);
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d = [differ(mine, back.get(`/${g.name}`)!)];
        for (const rule of ["strict", "inclusive"] as const) {
          let theirs: number[] | null = null;
          try { theirs = standardReaderEvents(xml, g.name, sample, rule); } catch { /* logicle and arcsinh: GateLab's re-import only */ }
          if (theirs) d.push(differ(mine, theirs));
        }
        if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 60000);
  }
});

describe("a logicle gate re-expressed for Cytobank, read on another file", () => {
  // The Cytobank format has no logicle, so a logicle gate goes out as arcsinh, densified. Held to
  // the exporting file's events, it still left another file's events near the boundary to the
  // tolerance, and log-amplified data put many on one lattice point: exported from one public GvHD
  // file, up to 67 of 3,701 events of a logicle polygon on another.
  const level = (k: number) => Math.fround(10 ** (k / 32));
  const make = (n: number, seed: number) => {
    const fcs = syntheticFlowFcs(n, seed);
    const u = prng(seed + 1000);
    fcs.columns[2] = Float32Array.from(fcs.columns[2], () => level(Math.floor(u() * 128)));
    fcs.columns[3] = Float32Array.from(fcs.columns[3], () => level(Math.floor(u() * 128)));
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  };
  const exporting = make(3000, 51);
  const others = [make(20000, 52), make(20000, 53)];
  const cd4 = keyOf(exporting, "FITC-A");
  const cd8 = keyOf(exporting, "PE-A");
  const logicle: TransformSpec = { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 };
  const inLogicle = (name: string, raw: Vertex[]): Gate => {
    const g = { ...rawGate(name, "polygon", cd4, cd8, raw), space: "display", transforms: { [cd4]: logicle, [cd8]: logicle } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [exporting.rawToGate(g, cd4, vx), exporting.rawToGate(g, cd8, vy)]);
    return g;
  };
  const gates = [
    inLogicle("through", [[3.3, 27.1], [31.7, 3.9], [1811.4, 97.2], [19.3, 1033.6], [2.2, 377.7]]),
    inLogicle("wide", [[1.7, 1.9], [6113.2, 7.3], [4411.8, 7721.4], [2.9, 3312.3]]),
  ];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };

  it("moves at most 0.01% of a population's events on files other than the one exported", () => {
    const xml = exportGatingML({ ...ws, sample: exporting, format: "cytobank", timestamp: "t" });
    const bad: string[] = [];
    for (const [k, sample] of others.entries()) {
      const counts = countsByPath(sample, ws);
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d = differ(mine, back.get(`/${g.name}`)!);
        if (d > 0.0001 * mine.length) bad.push(`file ${k} ${g.name}: ${d} of ${mine.length}`);
      }
    }
    expect(bad).toEqual([]);
  }, 60000);
});

describe("a polygon vertex or edge on a stack of events", () => {
  // Quantized data stacks events on one value, most of all on the lowest: the public GvHD file's
  // lowest value, 1.0, carries 181 events of one channel pair. GateLab decides on its value in the
  // gate's space held in single precision and holds an event on an edge only within 1e-9 of it, and
  // logicle(1) held in single precision lies 1.9e-9 below a vertex drawn at 1: GateLab leaves the
  // stack out, and a reader in double precision finds it on the vertex. The notch that settles it
  // was refused whenever an event lay along an edge between 50 and 100 × TIE_MARGIN from the vertex,
  // and FlowKit read 805 events of a logicle polygon GateLab holds 619 of. A vertex at a sentinel
  // value (−2^31 on the public S8 file, where 113 events lie) made every margin enormous, and FlowKit
  // left out 47 events of a raw polygon.
  // A 1,024-channel log amplifier's lattice, as the public GvHD files' values lie on.
  const level = (k: number) => Math.fround(10 ** ((4 * k) / 1024));
  const SENTINEL = -2147483648;
  const sample = (() => {
    const fcs = syntheticFlowFcs(6000, 151);
    const u = prng(152);
    // 30% of the events on the lattice's lowest value, 1, 18% on the eight above it, and 2% on the
    // sentinel, as the public GvHD and S8 files have.
    const pick = () => {
      const r = u();
      return r < 0.02 ? SENTINEL : r < 0.32 ? 1 : r < 0.5 ? level(1 + Math.floor(u() * 8)) : level(Math.floor(u() * 1024));
    };
    fcs.columns[2] = Float32Array.from(fcs.columns[2], pick);
    fcs.columns[3] = Float32Array.from(fcs.columns[3], pick);
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const inSpace = (name: string, spec: TransformSpec | "raw", raw: Vertex[]): Gate => {
    if (spec === "raw") return rawGate(name, "polygon", cd4, cd8, raw);
    const g = { ...rawGate(name, "polygon", cd4, cd8, raw), space: "display", transforms: { [cd4]: spec, [cd8]: spec } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, cd8, vy)]);
    return g;
  };
  const L = (k: number) => level(16 * k);
  const shapes: [string, Vertex[]][] = [
    ["box at the lowest value", [[1, 1], [L(20), 1], [L(20), L(30)], [1, L(30)]]],
    ["triangle at the lowest value", [[1, 1], [L(40), L(10)], [L(10), L(40)]]],
    ["thin triangle at the lowest value", [[1, 1], [L(40), L(1)], [L(30), L(3)]]],
  ];
  const spaces: [string, TransformSpec | "raw"][] = [
    ["logicle", { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 }],
    ["biex", { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 }],
    ["biex4096", { kind: "biex", maxValue: 262144, pos: 4.5, neg: 1, widthBasis: -100, channelRange: 4096 }],
    ["arcsinh", { kind: "asinh", cofactor: 150 }],
    ["raw", "raw"],
  ];
  const gates = [
    ...spaces.flatMap(([label, spec]) => shapes.map(([shape, raw]) => inSpace(`${label} ${shape}`, spec, raw))),
    inSpace("raw box at the sentinel", "raw", [[SENTINEL, SENTINEL], [L(20), SENTINEL], [L(20), L(30)], [SENTINEL, L(30)]]),
    inSpace("raw triangle at the sentinel", "raw", [[SENTINEL, SENTINEL], [L(40), L(20)], [L(20), L(40)]]),
  ];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };
  // A reader whose own transform lands a few places either side of GateLab's.
  const nudge = (s: 1 | -1) => (v: number) => v + s * (4e-16 + 8 * Number.EPSILON * Math.abs(v));

  it("uses fixtures in which GateLab leaves the stack at the lowest value out of some gates and holds it in others", () => {
    const counts = countsByPath(sample, ws);
    const stack = new Set<number>();
    const x = sample.rawColumnData(sample.index(cd4)!);
    const y = sample.rawColumnData(sample.index(cd8)!);
    for (let i = 0; i < x.length; i++) if (x[i] === 1 && y[i] === 1) stack.add(i);
    expect(stack.size).toBeGreaterThan(300);
    const held = gates.filter((g) => counts.get(`/${g.name}`)!.some((i) => stack.has(i))).map((g) => g.name);
    expect(held.length).toBeGreaterThan(0);
    expect(held.length).toBeLessThan(gates.length);
  });

  for (const format of FORMATS) {
    it(`is decided as GateLab decides it by GateLab and by readers of either edge rule (${format})`, () => {
      const counts = countsByPath(sample, ws);
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d = [differ(mine, back.get(`/${g.name}`)!)];
        for (const rule of ["strict", "inclusive"] as const) {
          for (const p of [(v: number) => v, nudge(1), nudge(-1)]) d.push(differ(mine, standardReaderEvents(xml, g.name, sample, rule, p)));
        }
        if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 120000);
  }
});

describe("a polygon with a repeated vertex on a stack of events", () => {
  // A vertex repeated, as a double-click leaves it or a writer that closes its rings explicitly
  // writes the first vertex again last, is an edge of no length. It had no side to notch, and the
  // stack of events on it was left to rounding: with (1, 1) twice in the GvHD s6a01 logicle polygon,
  // where 181 events lie, FlowKit read 805 events against GateLab's 619, and GateLab's own Cytobank
  // round trip the same; so did the polygon as FlowKit writes it, its ring closed.
  const level = (k: number) => Math.fround(10 ** ((4 * k) / 1024));
  const sample = (() => {
    const fcs = syntheticFlowFcs(6000, 151);
    const u = prng(152);
    const pick = () => {
      const r = u();
      return r < 0.32 ? 1 : r < 0.5 ? level(1 + Math.floor(u() * 8)) : level(Math.floor(u() * 1024));
    };
    fcs.columns[2] = Float32Array.from(fcs.columns[2], pick);
    fcs.columns[3] = Float32Array.from(fcs.columns[3], pick);
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const inSpace = (name: string, spec: TransformSpec | "raw", raw: Vertex[]): Gate => {
    if (spec === "raw") return rawGate(name, "polygon", cd4, cd8, raw);
    const g = { ...rawGate(name, "polygon", cd4, cd8, raw), space: "display", transforms: { [cd4]: spec, [cd8]: spec } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, cd8, vy)]);
    return g;
  };
  const L = (k: number) => level(16 * k);
  const triangle: Vertex[] = [[1, 1], [L(40), L(10)], [L(10), L(40)]];
  const box: Vertex[] = [[1, 1], [L(20), 1], [L(20), L(30)], [1, L(30)]];
  const shapes: [string, Vertex[]][] = [
    ["triangle, its vertex at the lowest value twice", [triangle[0], ...triangle]],
    ["triangle, its vertex at the lowest value three times", [triangle[0], triangle[0], ...triangle]],
    ["triangle, its ring closed", [...triangle, triangle[0]]],
    ["box, its vertex at the lowest value twice", [box[0], ...box]],
    ["box, its ring closed", [...box, box[0]]],
    ["box, another vertex twice", [...box.slice(0, 3), box[2], box[3]]],
  ];
  const spaces: [string, TransformSpec | "raw"][] = [
    ["logicle", { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 }],
    ["arcsinh", { kind: "asinh", cofactor: 150 }],
    ["raw", "raw"],
  ];
  const gates = spaces.flatMap(([label, spec]) => shapes.map(([shape, raw]) => inSpace(`${label} ${shape}`, spec, raw)));
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };
  const nudge = (s: 1 | -1) => (v: number) => v + s * (4e-16 + 8 * Number.EPSILON * Math.abs(v));

  it("uses fixtures in which GateLab leaves the stack at the lowest value out of the logicle gates", () => {
    const counts = countsByPath(sample, ws);
    const x = sample.rawColumnData(sample.index(cd4)!);
    const y = sample.rawColumnData(sample.index(cd8)!);
    const stack: number[] = [];
    for (let i = 0; i < x.length; i++) if (x[i] === 1 && y[i] === 1) stack.push(i);
    expect(stack.length).toBeGreaterThan(300);
    for (const g of gates.filter((g) => g.name.startsWith("logicle"))) {
      expect(counts.get(`/${g.name}`)!.some((i) => stack.includes(i)), g.name).toBe(false);
    }
  });

  for (const format of FORMATS) {
    it(`is decided as GateLab decides it by GateLab and by readers of either edge rule (${format})`, () => {
      const counts = countsByPath(sample, ws);
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d = [differ(mine, back.get(`/${g.name}`)!)];
        for (const rule of ["strict", "inclusive"] as const) {
          for (const p of [(v: number) => v, nudge(1), nudge(-1)]) d.push(differ(mine, standardReaderEvents(xml, g.name, sample, rule, p)));
        }
        if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 120000);
  }
});

describe("a polygon that crosses itself, with its vertices on stacks of events", () => {
  // An edge of a polygon that crosses itself has the gate on one side before the crossing and on the
  // other after it. The side a notch was to go was found at the edge's middle alone, so a notch at a
  // vertex beyond the crossing went into the gate where it should have left it, was refused, and the
  // stack on that vertex was left to rounding: 2 to 58 events of the verifier's bowties and crossed
  // quadrilaterals on the public GvHD, S8 and Bodenmiller files.
  const level = (k: number) => Math.fround(10 ** ((4 * k) / 1024));
  const sample = (() => {
    const fcs = syntheticFlowFcs(6000, 201);
    const u = prng(202);
    const pick = () => {
      const r = u();
      return r < 0.3 ? 1 : r < 0.5 ? level(16 * [10, 20, 30, 40][Math.floor(u() * 4)]) : level(Math.floor(u() * 1024));
    };
    fcs.columns[2] = Float32Array.from(fcs.columns[2], pick);
    fcs.columns[3] = Float32Array.from(fcs.columns[3], pick);
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const inSpace = (name: string, spec: TransformSpec | "raw", raw: Vertex[]): Gate => {
    if (spec === "raw") return rawGate(name, "polygon", cd4, cd8, raw);
    const g = { ...rawGate(name, "polygon", cd4, cd8, raw), space: "display", transforms: { [cd4]: spec, [cd8]: spec } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, cd8, vy)]);
    return g;
  };
  const L = (k: number) => level(16 * k);
  // Every vertex on a stack; each ring's two diagonals cross.
  const shapes: [string, Vertex[]][] = [
    ["bowtie", [[1, 1], [L(40), L(10)], [L(10), L(40)], [L(30), L(30)]]],
    ["bowtie from its other end", [[L(30), L(30)], [L(10), L(40)], [L(40), L(10)], [1, 1]]],
    ["crossed quadrilateral", [[L(10), 1], [L(40), L(30)], [L(40), 1], [L(10), L(30)]]],
  ];
  const spaces: [string, TransformSpec | "raw"][] = [
    ["logicle", { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 }],
    ["arcsinh", { kind: "asinh", cofactor: 150 }],
    ["raw", "raw"],
  ];
  const gates = spaces.flatMap(([label, spec]) => shapes.map(([shape, raw]) => inSpace(`${label} ${shape}`, spec, raw)));
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };
  const nudge = (s: 1 | -1) => (v: number) => v + s * (4e-16 + 8 * Number.EPSILON * Math.abs(v));

  for (const format of FORMATS) {
    it(`is decided as GateLab decides it by GateLab and by readers of either edge rule (${format})`, () => {
      const counts = countsByPath(sample, ws);
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d = [differ(mine, back.get(`/${g.name}`)!)];
        for (const rule of ["strict", "inclusive"] as const) {
          for (const p of [(v: number) => v, nudge(1), nudge(-1)]) d.push(differ(mine, standardReaderEvents(xml, g.name, sample, rule, p)));
        }
        if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 120000);
  }
});

describe("an ellipse whose boundary runs through a stack of events", () => {
  // GateLab holds an event when the quadratic form of its single-precision value is at most
  // distanceSquare; a reader computes both itself, in double precision, and an ellipse drawn through a
  // stack of events on one quantized value left them to that rounding: FlowKit placed 78 to 95 events
  // of 24 to 29 of the r4 verifier's ellipses through a stack differently from GateLab on the public
  // files, and GateLab's own re-import 27 to 53.
  const level = (k: number) => Math.fround(10 ** ((4 * k) / 1024));
  const stacks: Vertex[] = [[level(300), level(420)], [level(640), level(700)]];
  const sample = (() => {
    const fcs = syntheticFlowFcs(6000, 221);
    const u = prng(222);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 6000; i++) {
      const r = u();
      if (r < 0.4) { const p = stacks[Math.floor(u() * stacks.length)]; xs.push(p[0]); ys.push(p[1]); }
      else { xs.push(level(Math.floor(u() * 1024))); ys.push(level(Math.floor(u() * 1024))); }
    }
    fcs.columns[2] = Float32Array.from(xs);
    fcs.columns[3] = Float32Array.from(ys);
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const spaces: [string, TransformSpec | "raw"][] = [
    ["logicle", { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 }],
    ["arcsinh", { kind: "asinh", cofactor: 150 }],
    ["biex", { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 }],
    ["raw", "raw"],
  ];
  const gates: Gate[] = [];
  for (const [label, spec] of spaces) {
    const g0 = { gate_id: "", name: "", gate_type: "ellipse", x_channel: cd4, y_channel: cd8, color: "#000", label_offset: null,
      ...(spec === "raw" ? {} : { space: "display", transforms: { [cd4]: spec, [cd8]: spec } }) } as unknown as Gate;
    const at = (p: Vertex): Vertex => [sample.rawToGate(g0, cd4, p[0]), sample.rawToGate(g0, cd8, p[1])];
    stacks.forEach((p, k) => {
      const [ax, ay] = at(p);
      // Half axes of a fifth and a tenth of the stack's own coordinates, the stack at one end of an axis.
      const r = 0.2 * Math.abs(ax);
      const t = 0.1 * Math.abs(ay);
      for (const [side, mean] of [["left", [ax + r, ay]], ["right", [ax - r, ay]], ["top", [ax, ay - t]]] as [string, Vertex][]) {
        gates.push({ ...g0, gate_id: uuid(), name: `${label} ellipse ${k} with the stack on its ${side}`, mean,
          covariance: side === "top" ? [[r * r, 0], [0, t * t]] : [[r * r, 0.3 * r * t], [0.3 * r * t, t * t]], distance_square: 1 } as Gate);
      }
    });
  }
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };
  const nudge = (s: 1 | -1) => (v: number) => v + s * (4e-16 + 8 * Number.EPSILON * Math.abs(v));

  it("uses ellipses that GateLab decides some stacks on the boundary into and some out of", () => {
    const counts = countsByPath(sample, ws);
    const x = sample.rawColumnData(sample.index(cd4)!);
    const y = sample.rawColumnData(sample.index(cd8)!);
    let held = 0;
    let left = 0;
    for (const g of gates.filter((g) => g.name.includes("top"))) {
      const k = Number(g.name.split(" ")[2]);
      const onIt = Array.from(x.keys()).filter((i) => x[i] === stacks[k][0] && y[i] === stacks[k][1]);
      const mine = new Set(counts.get(`/${g.name}`)!);
      if (onIt.every((i) => mine.has(i))) held++; else if (onIt.every((i) => !mine.has(i))) left++;
    }
    expect(held + left).toBe(gates.filter((g) => g.name.includes("top")).length);
    expect(held).toBeGreaterThan(0);
    expect(left).toBeGreaterThan(0);
  });

  for (const format of FORMATS) {
    it(`is decided as GateLab decides it, by GateLab reading it back and by a reader in double precision (${format})`, () => {
      const counts = countsByPath(sample, ws);
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d = [differ(mine, back.get(`/${g.name}`)!)];
        for (const rule of ["strict", "inclusive"] as const) {
          for (const p of [(v: number) => v, nudge(1), nudge(-1)]) d.push(differ(mine, standardReaderEvents(xml, g.name, sample, rule, p)));
        }
        if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 120000);
  }
});

describe("a floor stretch's end beside a logicle axis", () => {
  // The end of a stretch along a biex table's end beside a logicle axis, which does not clamp, was
  // written where the vertex maps, not where GateLab stops holding the events beyond the table there,
  // and the events stacked on the vertex's own value were left to rounding: in the Cytobank format,
  // which writes logicle as arcsinh, 3 and 4 of 288 to 9,223 events of the r4 verifier's polygons on
  // the public S8 file and 1 and 2 on the Aurora file; in the standard format 1 of 10 and of 303 on
  // the Aurora file.
  const logicle: TransformSpec = { kind: "logicle", T: 262144, W: 1.0797952544254512, M: 4.5, A: 0 };
  const biex: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  // Integer data; a third of y below the biex table's end, x stacked on a few values.
  const xs = [200, 350, 1200, 4000, 9000];
  const sample = (() => {
    const fcs = syntheticFlowFcs(6000, 271);
    const u = prng(272);
    fcs.columns[2] = Float32Array.from(fcs.columns[2], () => (u() < 0.6 ? xs[Math.floor(u() * xs.length)] : Math.floor(20000 * u() ** 2)));
    fcs.columns[3] = Float32Array.from(fcs.columns[3], () => (u() < 0.33 ? -500 - Math.floor(3000 * u()) : Math.floor(20000 * u() ** 2)));
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const g0 = { ...rawGate("probe", "polygon", cd4, cd8, []), space: "display", transforms: { [cd4]: logicle, [cd8]: biex } } as Gate;
  const gx = (v: number) => sample.rawToGate(g0, cd4, v);
  const floor = sample.rawToGate(g0, cd8, -1e12);
  const polygon = (name: string, vertices: Vertex[]): Gate => ({ ...g0, gate_id: uuid(), name, vertices } as Gate);
  const gates = [
    polygon("triangle on the floor between stacks", [[gx(1200), floor], [gx(350), 120], [gx(4000), floor]]),
    polygon("quadrilateral on the floor between stacks", [[gx(200), floor], [gx(9000), floor], [gx(4000), 150], [gx(350), 100]]),
  ];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const counts = countsByPath(sample, ws);

  it("uses stretches whose ends are stacks below the table's end, which GateLab holds at some ends", () => {
    const x = sample.rawColumnData(sample.index(cd4)!);
    const y = sample.rawColumnData(sample.index(cd8)!);
    let held = 0;
    for (const [g, ends] of [[gates[0], [1200, 4000]], [gates[1], [200, 9000]]] as [Gate, number[]][]) {
      const mine = new Set(counts.get(`/${g.name}`)!);
      for (const e of ends) {
        const stack = Array.from(x.keys()).filter((i) => x[i] === e && y[i] < -400);
        expect(stack.length).toBeGreaterThan(50);
        if (stack.every((i) => mine.has(i))) held++;
      }
    }
    expect(held).toBeGreaterThan(0);
  });

  for (const format of FORMATS) it(`is decided as GateLab decides it at the stretch's ends (${format})`, () => {
    const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
    const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
    const bad: string[] = [];
    for (const g of gates) {
      const mine = counts.get(`/${g.name}`)!;
      const d = [differOf(mine, back.get(`/${g.name}`)!)];
      for (const rule of ["strict", "inclusive"] as const) d.push(differOf(mine, standardReaderEvents(xml, g.name, sample, rule)));
      if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
    }
    expect(bad).toEqual([]);
  }, 60000);
});

describe("an ellipse that passes a hair below a biex table's end between the samples of its boundary", () => {
  // A rotated logicle-by-biex ellipse whose lowest point lies a millionth of a channel below the
  // biex table's end, between two of the points its boundary was sampled at to find where it
  // leaves the table: it was taken to lie wholly inside, so no edge ran along the table's end and
  // no skirt carried the ring out past the events GateLab places there. FlowKit left out 231 of
  // 5,227 events of such an ellipse on the public S8 file (#345's round-4 verifier), once
  // ellipseDistanceFor had moved its distance by 7e-14 and its one sample on the end inside it.
  const logicle: TransformSpec = { kind: "logicle", T: 262144, W: 1.3737572507247262, M: 4.5, A: 0 };
  const biex: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const xs = [200, 350, 1200, 4000, 9000];
  const sample = (() => {
    const fcs = syntheticFlowFcs(6000, 281);
    const u = prng(282);
    fcs.columns[2] = Float32Array.from(fcs.columns[2], () => (u() < 0.6 ? xs[Math.floor(u() * xs.length)] : Math.floor(20000 * u() ** 2)));
    fcs.columns[3] = Float32Array.from(fcs.columns[3], () => (u() < 0.33 ? -500 - Math.floor(3000 * u()) : Math.floor(20000 * u() ** 2)));
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const g0 = { ...rawGate("probe", "polygon", cd4, cd8, []), space: "display", transforms: { [cd4]: logicle, [cd8]: biex } } as Gate;
  const floor = sample.rawToGate(g0, cd8, -1e12);
  // The public case's shape: nearly upright, 69.35 channels tall about its centre and tilted, with
  // its chord along the table's end centred on the stack at 1200.
  const cov = [[432.8078022306117, -2.2136707796355366], [-2.2136707796355366, 4808.962018540485]];
  const my = floor + 69.346679140337;
  const dxAtFloor = (cov[0][1] / cov[1][1]) * (floor - my);
  const ellipse = {
    gate_id: uuid(), name: "ellipse a hair below the table", gate_type: "ellipse", x_channel: cd4, y_channel: cd8,
    color: "#377eb8", label_offset: null, space: "display", transforms: { [cd4]: logicle, [cd8]: biex },
    // The distance ellipseDistanceFor gave the public case: the end of its major axis, one of the
    // points sampled, 2.4e-12 of a channel above the table's end; its lowest point 1e-6 below it.
    mean: [sample.rawToGate(g0, cd4, 1200) - dxAtFloor, my], covariance: cov, distance_square: 0.9999999999999297,
  } as unknown as Gate;
  const ws = workspaceOf([ellipse], [[ellipse.name, [newGateRef(ellipse.gate_id)], null]]);
  const mine = countsByPath(sample, ws).get(`/${ellipse.name}`)!;

  it("holds the stack below the table at 1200, and no other stack there", () => {
    const x = sample.rawColumnData(sample.index(cd4)!);
    const y = sample.rawColumnData(sample.index(cd8)!);
    const held = new Set(mine);
    for (const v of xs) {
      const stack = Array.from(x.keys()).filter((i) => x[i] === v && y[i] < -400);
      expect(stack.length, String(v)).toBeGreaterThan(50);
      expect(stack.filter((i) => held.has(i)).length, String(v)).toBe(v === 1200 ? stack.length : 0);
    }
  });

  for (const format of FORMATS) it(`is written with a skirt below the table, and decided as GateLab decides it (${format})`, () => {
    const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
    const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
    const d = [differOf(mine, back.get(`/${ellipse.name}`)!)];
    for (const rule of ["strict", "inclusive"] as const) d.push(differOf(mine, standardReaderEvents(xml, ellipse.name, sample, rule)));
    expect(d, `of ${mine.length}`).toEqual([0, 0, 0]);
  }, 60000);
});

describe("a polygon of no area, its vertices on one line of stacked events", () => {
  // GateLab holds the events on a polygon's edges, within 1e-9, and a polygon whose vertices all lie
  // on one line has nothing else. A reader held none of them by even-odd, which crosses each edge
  // twice, and all of them by a rule that holds an event on an edge, where GateLab, in single
  // precision, can hold none (a logicle line through a stack). On the public S8 file, where four
  // stacked points of an integer width channel lie on one value, FlowKit read none of the 58 events
  // GateLab holds of the r4 verifier's triangle, quadrilateral and bowtie through them.
  const sample = (() => {
    const fcs = syntheticFlowFcs(6000, 261);
    const u = prng(262);
    // Integer data, a third of it on y = 1.
    fcs.columns[2] = Float32Array.from(fcs.columns[2], () => 500 + Math.floor(120 * u()));
    fcs.columns[3] = Float32Array.from(fcs.columns[3], () => (u() < 0.33 ? 1 : 1 + Math.floor(200 * u())));
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const inSpace = (name: string, spec: TransformSpec | "raw", raw: Vertex[]): Gate => {
    if (spec === "raw") return rawGate(name, "polygon", cd4, cd8, raw);
    const g = { ...rawGate(name, "polygon", cd4, cd8, raw), space: "display", transforms: { [cd4]: spec, [cd8]: spec } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, cd8, vy)]);
    return g;
  };
  const shapes: [string, Vertex[]][] = [
    ["triangle on one line", [[560, 1], [544, 1], [588, 1]]],
    ["quadrilateral on one line", [[560, 1], [544, 1], [588, 1], [570, 1]]],
    ["triangle on one line across", [[540, 30], [540, 5], [540, 90]]],
  ];
  const spaces: [string, TransformSpec | "raw"][] = [["raw", "raw"], ["logicle", { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 }]];
  const gates = spaces.flatMap(([label, spec]) => shapes.map(([shape, raw]) => inSpace(`${label} ${shape}`, spec, raw)));
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const counts = countsByPath(sample, ws);
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };

  it("uses polygons of which GateLab holds the events on the line in raw, and none in logicle", () => {
    for (const g of gates) {
      if (g.name.startsWith("raw")) expect(counts.get(`/${g.name}`)!.length, g.name).toBeGreaterThan(10);
      else expect(counts.get(`/${g.name}`)!.length, g.name).toBe(0);
    }
  });

  for (const format of FORMATS) {
    it(`is written so that readers hold what GateLab holds (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d = [differ(mine, back.get(`/${g.name}`)!)];
        for (const rule of ["strict", "inclusive"] as const) d.push(differ(mine, standardReaderEvents(xml, g.name, sample, rule)));
        if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 60000);
  }
});

describe("a polygon on a FlowJo log floor whose offset is a value events are stacked on", () => {
  // FlowJo log's floor in raw is its inverse at the floor, which need not be the offset itself: with
  // an offset of 49 it is 48.99999999999999, and GateLab places the events at 49, integer data's
  // stack there, on the floor. They were taken for the nearest events inside it, so no inset was left
  // room for and the skirted edge was written at 49, through them: FlowKit read 34 of 597 events of
  // polygons with a vertex on that corner of a public GvHD file on the other side.
  const sample = (() => {
    const fcs = syntheticFlowFcs(6000, 211);
    const u = prng(212);
    // Integer data: a fifth of each channel at 49 itself, a fifth below it, the rest above.
    const pick = () => { const r = u(); return r < 0.2 ? 49 : r < 0.4 ? Math.floor(49 * u()) : 50 + Math.floor(2000 * u() ** 2); };
    fcs.columns[2] = Float32Array.from(fcs.columns[2], pick);
    fcs.columns[3] = Float32Array.from(fcs.columns[3], pick);
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const log: TransformSpec = { kind: "wsplog", offset: 49, decades: 4 };
  const inSpace = (name: string, raw: Vertex[]): Gate => {
    const g = { ...rawGate(name, "polygon", cd4, cd8, raw), space: "display", transforms: { [cd4]: log, [cd8]: log } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, cd8, vy)]);
    return g;
  };
  const gates = [
    inSpace("triangle on the corner", [[0, 0], [900, 120], [150, 800]]),
    inSpace("box on both floors", [[0, 0], [600, 0], [600, 700], [0, 700]]),
    inSpace("stretch along the floor", [[100, 0], [900, 0], [700, 600]]),
  ];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };

  it("uses a floor whose raw value lies below the offset, with the stack at the offset on it", () => {
    const g = gates[0];
    expect(transformFromSpec(log).inverse(0)).toBeLessThan(49);
    const own = sample.gatingDataFor(g).column(cd4)!;
    const x = sample.rawColumnData(sample.index(cd4)!);
    const atOffset = Array.from(x.keys()).filter((i) => x[i] === 49);
    expect(atOffset.length).toBeGreaterThan(500);
    expect(atOffset.every((i) => own[i] === 0)).toBe(true);
  });

  for (const format of FORMATS) {
    it(`holds the stack at the offset as GateLab does, for GateLab reading it back and for readers of either edge rule (${format})`, () => {
      const counts = countsByPath(sample, ws);
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d = [differ(mine, back.get(`/${g.name}`)!)];
        for (const rule of ["strict", "inclusive"] as const) d.push(differ(mine, standardReaderEvents(xml, g.name, sample, rule)));
        if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 60000);
  }
});

describe("a polygon on a log floor with events stacked at the floor's own value", () => {
  // FlowJo log pins every value at or below its offset of 1 to the floor, and quantized data stacks
  // events at exactly 1, the lowest value of the public GvHD files. Written at one double inside the
  // floor, a skirted floor edge lay within GateLab's own 1e-9 edge tolerance of that stack, and
  // GateLab reading the file back held the stack's events at a stretch's end, which it leaves out: 7
  // of 1,267 events of a polygon on a public GvHD file. A vertex on the floor that ends no stretch
  // had no skirt at all, and the events GateLab decides onto it went to no reader: 23 of 883 on the
  // public S8 file.
  const level = (k: number) => Math.fround(10 ** (k / 16));
  const sample = (() => {
    const fcs = syntheticFlowFcs(6000, 161);
    const u = prng(162);
    // 30% of the events at exactly 1, 10% below it, the rest on a lattice above.
    const pick = () => { const r = u(); return r < 0.3 ? 1 : r < 0.4 ? -Math.floor(300 * u()) : level(1 + Math.floor(u() * 63)); };
    fcs.columns[2] = Float32Array.from(fcs.columns[2], pick);
    fcs.columns[3] = Float32Array.from(fcs.columns[3], pick);
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const log: TransformSpec = { kind: "wsplog", offset: 1, decades: 4.5 };
  const biex: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const inSpace = (name: string, sx: TransformSpec, sy: TransformSpec, raw: Vertex[]): Gate => {
    const g = { ...rawGate(name, "polygon", cd4, cd8, raw), space: "display", transforms: { [cd4]: sx, [cd8]: sy } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, cd8, vy)]);
    return g;
  };
  const L = level;
  const gates: Gate[] = [];
  for (const [label, sy] of [["log", log], ["log by biex", biex]] as [string, TransformSpec][]) {
    gates.push(
      // Stretches along both floors from the corner, ending at stacked values.
      inSpace(`${label} box on the floor`, log, sy, [[1, 1], [L(20), 1], [L(20), L(30)], [1, L(30)]]),
      inSpace(`${label} stretch ending at a stack`, log, sy, [[L(8), -1e6], [L(24), -1e6], [L(30), L(30)], [L(10), L(40)]]),
      // Lone vertices on each floor, at stacked values and at the floor itself.
      inSpace(`${label} triangle touching each floor`, log, sy, [[1, L(30)], [L(20), 1], [L(40), L(40)]]),
      inSpace(`${label} diamond touching each floor`, log, sy, [[L(20), -171], [L(40), L(24)], [L(20), L(50)], [-230, L(24)]]),
    );
  }
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };

  for (const format of FORMATS) {
    it(`is decided as GateLab decides it, by GateLab reading it back and by readers of either edge rule (${format})`, () => {
      const counts = countsByPath(sample, ws);
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d = [differ(mine, back.get(`/${g.name}`)!)];
        for (const rule of ["strict", "inclusive"] as const) d.push(differ(mine, standardReaderEvents(xml, g.name, sample, rule)));
        if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 120000);
  }
});

describe("a floor's events that GateLab holds within its edge tolerance beside a nearly flat edge", () => {
  // GateLab holds an event within 1e-9 of a polygon's edge, and beside a nearly flat edge that ends at
  // a vertex on a FlowJo log floor, that is a stretch of the floor well past the vertex. A strip's end
  // was compared with the vertex and kept there where GateLab's end lay more than 0.01% beyond it,
  // and a lone vertex was given no strip where its own value, in single precision, rounded to one
  // GateLab leaves out: 6 and 7 of 5,564 events of the r4 verifier's polygons on the public Fortessa
  // file, and 2 of 2,494 on the PBMC file, went to no reader.
  const log: TransformSpec = { kind: "wsplog", offset: 1, decades: 4.5 };
  const toRaw = transformFromSpec(log).inverse;
  // Vertices on the floor at the end of an edge rising 2e-6 of the axis over 0.05 of it (a band of
  // 2.5e-5 either side), and at the end of one rising 2.8e-4 over 0.83 (a band of 3.6e-6).
  const stretchEnd = 0.04688077100853005;
  const lone = [0.8301215501332316, 0.6200117, 0.7300031, 0.5100013];
  const sample = (() => {
    const fcs = syntheticFlowFcs(6000, 241);
    const u = prng(242);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 6000; i++) {
      const r = u();
      // Half the events below the y floor, their x packed around the vertices on it.
      const at = r < 0.2 ? stretchEnd + 3e-5 * (2 * u() - 1) : r < 0.5 ? lone[Math.floor(u() * lone.length)] + 5e-6 * (2 * u() - 1) : 0.05 + 0.9 * u();
      xs.push(Math.fround(toRaw(at)));
      ys.push(r < 0.5 ? Math.fround(1 - 300 * u()) : Math.fround(toRaw(0.05 + 0.9 * u())));
    }
    fcs.columns[2] = Float32Array.from(xs);
    fcs.columns[3] = Float32Array.from(ys);
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const polygon = (name: string, vertices: Vertex[]): Gate =>
    ({ ...rawGate(name, "polygon", cd4, cd8, vertices), space: "display", transforms: { [cd4]: log, [cd8]: log } } as Gate);
  const gates = [
    polygon("stretch along the floor, then a nearly flat edge", [[0, 1e-7], [0.09536617361278099, 1e-7], [stretchEnd, 0], [0, 0]]),
    ...lone.map((x, k) => polygon(`vertex ${k} on the floor at the end of a nearly flat edge`, [[0, 0.0002345678], [x, 0], [x + 0.35, 0.59]])),
  ];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const counts = countsByPath(sample, ws);

  it("uses gates that hold floor events beyond the vertex, within GateLab's edge tolerance", () => {
    const x = sample.gatingDataFor(gates[0]).column(cd4)!;
    const held = (g: Gate, end: number) => counts.get(`/${g.name}`)!.filter((i) => x[i] > end).length;
    expect(held(gates[0], stretchEnd)).toBeGreaterThan(20);
    expect(gates.slice(1).reduce((n, g, k) => n + counts.get(`/${g.name}`)!.filter((i) => Math.abs(x[i] - lone[k]) < 1e-5).length, 0)).toBeGreaterThan(50);
  });

  for (const format of FORMATS) {
    it(`holds them for GateLab reading it back and for readers of either edge rule (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d = [differOf(mine, back.get(`/${g.name}`)!)];
        for (const rule of ["strict", "inclusive"] as const) d.push(differOf(mine, standardReaderEvents(xml, g.name, sample, rule)));
        if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 60000);
  }
});

describe("a compensated floor whose offset is a value events are stacked on", () => {
  // FlowKit compensates in double precision where GateLab rounds the compensated value to single, so
  // its value for an event lies up to half a single-precision step from GateLab's. An event on a
  // FlowJo log floor whose offset is its own compensated value, 290,885.90625 on the public PBMC file,
  // was read above a skirted edge written 1e-8 of the offset inside it, and out of the corner GateLab
  // holds it in: 1 of 87,721 events of the r4 verifier's polygon on the PBMC file, 2 of 4,907 on the
  // Fortessa file.
  const sample = (() => {
    const fcs = syntheticFlowFcs(6000, 251);
    const u = prng(252);
    // A fifth of the events identical on all three fluorescence channels, so compensated alike.
    for (let i = 0; i < 6000; i++) {
      if (u() < 0.2) { fcs.columns[2][i] = 290885.90625; fcs.columns[3][i] = 180000.5; fcs.columns[4][i] = 5000; }
    }
    const s = new Sample(fcs);
    s.setCompensation(true);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const x = sample.rawColumnData(sample.index(cd4)!);
  const y = sample.rawColumnData(sample.index(cd8)!);
  const stack = Array.from(x.keys()).filter((i) => sample.fcs.columns[3][i] === 180000.5);
  const log = (offset: number): TransformSpec => ({ kind: "wsplog", offset, decades: 4 });
  const polygon = (name: string, vertices: Vertex[]): Gate =>
    ({ ...rawGate(name, "polygon", cd4, cd8, vertices), space: "display", transforms: { [cd4]: log(x[stack[0]]), [cd8]: log(y[stack[0]]) } } as Gate);
  const gates = [
    polygon("triangle on the corner", [[0, 0], [0.05, 0.12], [0.12, 0.05]]),
    polygon("box on both floors", [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]]),
  ];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const counts = countsByPath(sample, ws);
  // Half a single-precision step either way on each dimension, a hair short of it.
  const half = (sx: number, sy: number) => (v: number, dim: number) => {
    const a = Math.abs(v);
    const ulp = a < 1.1754943508222875e-38 ? 1.401298464324817e-45 : 2 ** (Math.floor(Math.log2(a)) - 23);
    return v + (dim === 0 ? sx : sy) * 0.4999 * ulp;
  };

  it("uses a stack compensated alike, on the corner of floors at its own values", () => {
    expect(stack.length).toBeGreaterThan(1000);
    expect(new Set(stack.map((i) => x[i])).size).toBe(1);
    expect(new Set(stack.map((i) => y[i])).size).toBe(1);
    for (const g of gates) expect(stack.every((i) => counts.get(`/${g.name}`)!.includes(i)), g.name).toBe(true);
  });

  for (const format of FORMATS) {
    it(`holds the stack for a reader whose compensated values lie half a step either side of GateLab's (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d = [differOf(mine, back.get(`/${g.name}`)!)];
        for (const [sx, sy] of [[0, 0], [1, -1], [-1, 1], [1, 1], [-1, -1]]) d.push(differOf(mine, standardReaderEvents(xml, g.name, sample, "strict", (v) => v, half(sx, sy))));
        if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 60000);
  }
});

describe("a rectangle edge on an integer event value, for a reader whose transform differs in the last places", () => {
  // A declared transform's bound was written one double from the value of the events on it, which
  // is GateLab's own double-precision value; FlowKit computes logicle and arcsinh its own way, a few
  // places off, and put those events on the other side: 7 of 3,005 events of a logicle rectangle
  // with an edge at −102 on the public S8 file's integer-valued width channels, and 26 and 42 of an
  // arcsinh rectangle's. The bound now keeps clear of every event's value by more than that.
  const sample = (() => {
    const fcs = syntheticFlowFcs(6000, 171);
    const u = prng(172);
    fcs.columns[2] = Float32Array.from(fcs.columns[2], () => Math.round(-600 + 1400 * u() ** 1.5));
    fcs.columns[3] = Float32Array.from(fcs.columns[3], () => Math.round(-400 + 1200 * u() ** 1.5));
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const rect = (name: string, sx: TransformSpec, sy: TransformSpec, [x0, y0, x1, y1]: number[]): Gate => {
    const raw: Vertex[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const g = { ...rawGate(name, "rectangle", cd4, cd8, raw), space: "display", transforms: { [cd4]: sx, [cd8]: sy } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, cd8, vy)]);
    return g;
  };
  const lg = (W: number): TransformSpec => ({ kind: "logicle", T: 262144, W, M: 4.5, A: 0 });
  const asinh: TransformSpec = { kind: "asinh", cofactor: 150 };
  const gates = [
    rect("logicle", lg(0.6879631521049656), lg(0.6330757544329686), [-102, -12, 68, 99]),
    rect("logicle wide", lg(0.5), lg(0.5), [-300, -250, 400, 350]),
    rect("arcsinh", asinh, asinh, [-102, -12, 68, 99]),
    rect("arcsinh wide", asinh, asinh, [-300, -250, 400, 350]),
  ];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };
  const nudge = (s: 1 | -1) => (v: number) => v + s * (4e-16 + 8 * Number.EPSILON * Math.abs(v));

  for (const format of FORMATS) {
    it(`is decided as GateLab decides it by GateLab and by such a reader (${format})`, () => {
      const counts = countsByPath(sample, ws);
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d = [differ(mine, back.get(`/${g.name}`)!), ...[nudge(1), nudge(-1)].map((p) => differ(mine, standardReaderEvents(xml, g.name, sample, "strict", p)))];
        if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 60000);
  }
});

describe("a floor stretch's end read back by GateLab in single precision", () => {
  // GateLab reads a declared transform's value in single precision when it reads a file back
  // (Sample.pinnedColumn). A floor stretch's end written as a reader computes it, on an flog axis
  // beside a raw floor, could then fall between an event GateLab holds and that event's own value
  // read back: 1 of 196 events of a FlowJo log polygon on the public Aurora file.
  const u = prng(77);
  const ends = Array.from({ length: 48 }, () => Math.fround(20 + 60000 * u() ** 2));
  const sample = (() => {
    const fcs = syntheticFlowFcs(6000, 43);
    fcs.columns[2] = Float32Array.from(fcs.columns[2], (v, i) => (i % 2 ? ends[(i >> 1) % ends.length] : v));
    fcs.columns[3] = Float32Array.from(fcs.columns[3], (v, i) => (i % 2 ? -300 - (i % 13) : v));
    return new Sample(fcs);
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const inSpace = (name: string, spec: TransformSpec, raw: Vertex[]): Gate => {
    const g = { ...rawGate(name, "polygon", cd4, cd8, raw), space: "display", transforms: { [cd4]: spec, [cd8]: spec } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, cd8, vy)]);
    return g;
  };
  const gates: Gate[] = [];
  for (const [label, spec] of [["flog", { kind: "flog", T: 262144, M: 4.5 }], ["log", { kind: "wsplog", offset: 1, decades: 4.5 }]] as [string, TransformSpec][]) {
    for (let k = 0; k + 1 < ends.length; k += 2) {
      const [a, b] = [ends[k], ends[k + 1]].sort((p, q) => p - q);
      gates.push(inSpace(`${label} stretch ${k}`, spec, [[a, -1e6], [b, -1e6], [b * 0.9, 4000], [a * 1.1, 3000]]));
    }
  }
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };

  for (const format of FORMATS) {
    it(`is decided as GateLab decides it, by GateLab reading it back and by a reader (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      const counts = countsByPath(sample, ws);
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d1 = differ(mine, back.get(`/${g.name}`)!);
        const d2 = differ(mine, standardReaderEvents(xml, g.name, sample));
        if (d1 || d2) bad.push(`${g.name}: GateLab ${d1}, standard ${d2} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 60000);
  }
});

describe("a floor stretch read on a file other than the one exported", () => {
  // GateLab evaluates an event beyond a floor on the floor, and holds it when its other value lies on
  // a stretch of the polygon along that floor. An event exactly at the floor's own raw value, as
  // FlowJo log's offset of 1 puts the lowest values of some public GvHD files, lay on the edge the
  // stretch and its skirt share, which a reader decides by its own edge rule: 29 of 8,158 and 63 of
  // 40,041 events of two FlowJo log polygons on public GvHD files the export never saw.
  const u = prng(97);
  const ends = Array.from({ length: 16 }, () => Math.fround(20 + 60000 * u() ** 2));
  const exporting = new Sample(syntheticFlowFcs(2000, 61));
  const reading = (() => {
    const fcs = syntheticFlowFcs(4000, 62);
    const end = (i: number) => ends[(i >> 3) % ends.length];
    // Events beyond each floor and exactly at FlowJo log's, with the other value on a stretch's end
    // or within it.
    const beyond = (i: number) => -300 - (i % 7);
    const x = (v: number, i: number) => [v, beyond(i), end(i), 1, v, 1, end(i), end(i) * 0.97][i % 8];
    const y = (v: number, i: number) => [v, end(i), beyond(i), end(i), v, end(i) * 0.97, 1, 1][i % 8];
    fcs.columns[2] = Float32Array.from(fcs.columns[2], x);
    fcs.columns[3] = Float32Array.from(fcs.columns[3], y);
    return new Sample(fcs);
  })();
  const cd4 = keyOf(exporting, "FITC-A");
  const cd8 = keyOf(exporting, "PE-A");
  const inSpace = (name: string, spec: TransformSpec, raw: Vertex[]): Gate => {
    const g = { ...rawGate(name, "polygon", cd4, cd8, raw), space: "display", transforms: { [cd4]: spec, [cd8]: spec } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [exporting.rawToGate(g, cd4, vx), exporting.rawToGate(g, cd8, vy)]);
    return g;
  };
  const gates: Gate[] = [];
  const spaces: [string, TransformSpec][] = [
    ["flog", { kind: "flog", T: 262144, M: 4.5 }],
    ["log", { kind: "wsplog", offset: 1, decades: 4.5 }],
  ];
  for (const [label, spec] of spaces) {
    for (let k = 0; k + 1 < ends.length; k += 2) {
      const [a, b] = [ends[k], ends[k + 1]].sort((p, q) => p - q);
      // Stretches on the y floor ending at x = a and b, on the x floor ending at y = a and b, and
      // on both floors from their corner, which writes both axes in raw.
      gates.push(inSpace(`${label} y floor ${k}`, spec, [[a, -1e6], [b, -1e6], [b * 0.9, 4000], [a * 1.1, 3000]]));
      gates.push(inSpace(`${label} x floor ${k}`, spec, [[-1e6, a], [3000, a * 1.1], [4000, b * 0.9], [-1e6, b]]));
      gates.push(inSpace(`${label} corner ${k}`, spec, [[-1e6, -1e6], [b, -1e6], [b * 0.8, 2500], [-1e6, a]]));
    }
  }
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };

  for (const format of FORMATS) {
    it(`is decided as GateLab decides it by readers of either edge rule (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample: exporting, format, timestamp: "t" });
      const counts = countsByPath(reading, ws);
      // Only the events at or beyond a floor: elsewhere the densified boundary is held to its tolerance.
      const beyond = (i: number) => i % 4 !== 0;
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!.filter(beyond);
        const d = ["strict", "inclusive"].map((rule) =>
          differ(mine, standardReaderEvents(xml, g.name, reading, rule as "strict" | "inclusive").filter(beyond)));
        if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 120000);
  }
});

describe("a floor stretch's end that GateLab holds within its edge tolerance", () => {
  // GateLab's polygon test holds a point within 1e-9 of an edge. On axes of very different scales,
  // FlowJo log beside a biex on 256 channels, the edge leaving a stretch's end vertex can run so
  // close to the clamp that an event beyond the clamp whose other value rounds just past the end is
  // still held. The end was placed by comparing with the vertex alone: 63 of 40,041 events of such
  // a polygon on a public GvHD file the export never saw, in FlowKit.
  const u = prng(131);
  const ends = Array.from({ length: 48 }, () => Math.fround(3 + 20 * u()));
  const exporting = new Sample(syntheticFlowFcs(2000, 71));
  const reading = (() => {
    const fcs = syntheticFlowFcs(6000, 72);
    const end = (i: number) => ends[(i >> 2) % ends.length];
    fcs.columns[2] = Float32Array.from(fcs.columns[2], (v, i) => [v, 1, -300 - (i % 7), v][i % 4]);
    fcs.columns[3] = Float32Array.from(fcs.columns[3], (v, i) => [v, end(i), end(i), v][i % 4]);
    return new Sample(fcs);
  })();
  const cd4 = keyOf(exporting, "FITC-A");
  const cd8 = keyOf(exporting, "PE-A");
  const log: TransformSpec = { kind: "wsplog", offset: 1, decades: 4.5 };
  const biex: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const gates = ends.map((a, k) => {
    const g = { ...rawGate(`log by biex ${k}`, "polygon", cd4, cd8, []), space: "display", transforms: { [cd4]: log, [cd8]: biex } } as Gate & { vertices: Vertex[] };
    const raw: Vertex[] = [[-1e6, -1e6], [19.2, -1e6], [6.8, a * 0.65], [1.6, a * 11.6], [-1e6, a]];
    g.vertices = raw.map(([vx, vy]) => [exporting.rawToGate(g, cd4, vx), exporting.rawToGate(g, cd8, vy)]);
    return g as Gate;
  });
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };

  for (const format of FORMATS) {
    it(`is decided as GateLab decides it on a file the export never saw (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample: exporting, format, timestamp: "t" });
      const counts = countsByPath(reading, ws);
      const beyond = (i: number) => i % 4 === 1 || i % 4 === 2;
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!.filter(beyond);
        const d = ["strict", "inclusive"].map((rule) =>
          differ(mine, standardReaderEvents(xml, g.name, reading, rule as "strict" | "inclusive").filter(beyond)));
        if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
    }, 120000);
  }
});

describe("a floor stretch that ends on an event's own value", () => {
  // GateLab evaluates an event below a floor on the floor, so it holds it exactly when its other
  // coordinate lies on the polygon's stretch of that floor; the skirt below the stretch is where a
  // reader holds it. A stretch that ends on a vertex drawn on an event was decided by which way
  // that end rounded when it was written: 54 of 7,905 events of a flog polygon on the public
  // Fortessa file, and on another file with events at the same values too.
  const ends = [1234.567, 2071.3, 517.25, 3333.3, 150.4, 811.9].map(Math.fround);
  const make = (seed: number) => {
    const fcs = syntheticFlowFcs(6000, seed);
    // Half the events on an end's own value, below every floor on the other axis.
    fcs.columns[2] = Float32Array.from(fcs.columns[2], (v, i) => (i % 2 ? ends[i % ends.length] : v));
    fcs.columns[3] = Float32Array.from(fcs.columns[3], (v, i) => (i % 2 ? -300 - (i % 11) : v));
    return new Sample(fcs);
  };
  const exporting = make(31);
  const reading = make(32);
  const cd4 = keyOf(exporting, "FITC-A");
  const cd8 = keyOf(exporting, "PE-A");
  const inSpace = (name: string, spec: TransformSpec, raw: Vertex[]): Gate => {
    const g = { ...rawGate(name, "polygon", cd4, cd8, raw), space: "display", transforms: { [cd4]: spec, [cd8]: spec } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [exporting.rawToGate(g, cd4, vx), exporting.rawToGate(g, cd8, vy)]);
    return g;
  };
  const flog: TransformSpec = { kind: "flog", T: 262144, M: 4.5 };
  const wsplog: TransformSpec = { kind: "wsplog", offset: 1, decades: 4.5 };
  const biex: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const gates: Gate[] = [];
  for (const [label, spec] of [["flog", flog], ["log", wsplog], ["biex", biex]] as [string, TransformSpec][]) {
    for (let k = 0; k + 1 < ends.length; k += 2) {
      const [a, b] = [ends[k], ends[k + 1]].sort((p, q) => p - q);
      // A stretch from one event's value to another's, and one from the corner to an event's value.
      gates.push(inSpace(`${label} stretch ${k}`, spec, [[a, -1e6], [b, -1e6], [b * 0.9, 4000], [a * 1.1, 3000]]));
      gates.push(inSpace(`${label} corner stretch ${k}`, spec, [[-1e6, -1e6], [b, -1e6], [b * 0.8, 2500], [-1e6, 4000]]));
    }
  }
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };

  for (const format of FORMATS) {
    it(`is decided as GateLab decides it, on the exported file and on another (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample: exporting, format, timestamp: "t" });
      const bad: string[] = [];
      for (const [label, sample] of [["exported", exporting], ["other", reading]] as [string, Sample][]) {
        const counts = countsByPath(sample, ws);
        const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
        for (const g of gates) {
          const mine = counts.get(`/${g.name}`)!;
          const d1 = differ(mine, back.get(`/${g.name}`)!);
          const d2 = differ(mine, standardReaderEvents(xml, g.name, sample));
          if (d1 || d2) bad.push(`${label} ${g.name}: GateLab ${d1}, standard ${d2} of ${mine.length}`);
        }
      }
      expect(bad).toEqual([]);
    }, 60000);
  }
});

describe("a biex polygon is written so that any file's events are read as GateLab reads them", () => {
  // Held to the exporting file's events, a densified edge still ran within 0.05% of the gate's
  // extent of the boundary, and another file's events there were placed differently: on the public
  // GvHD files, whose values sit on a lattice (a 1,024-channel log amplifier's), up to 49 of 1,388
  // events of a biex polygon exported from one file were misplaced on another. GateLab's biex is
  // linear between the entries of its table, so an edge split at every entry it crosses is the same
  // boundary in raw space, and no file's events can be placed differently except exactly on it.
  const exporting = new Sample(syntheticFlowFcs(20000, 11));
  // Another file: its values on a log lattice, ten to the power of a whole number of 256ths, as a
  // log amplifier's channels are, and piled up where the edges run.
  const u = prng(5);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  const other = syntheticFlowFcs(40000, 12);
  const lattice = (mu: number) => () => Math.pow(10, Math.round(mu + 90 * gauss()) / 256) * (u() < 0.1 ? -0.05 : 1);
  other.columns[2] = Float32Array.from({ length: 40000 }, lattice(560));
  other.columns[3] = Float32Array.from({ length: 40000 }, lattice(540));
  const reading = new Sample(other);
  const cd4 = keyOf(exporting, "FITC-A");
  const cd8 = keyOf(exporting, "PE-A");
  const inSpace = (name: string, spec: TransformSpec, raw: Vertex[]): Gate => {
    const g = { ...rawGate(name, "polygon", cd4, cd8, raw), space: "display", transforms: { [cd4]: spec, [cd8]: spec } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [exporting.rawToGate(g, cd4, vx), exporting.rawToGate(g, cd8, vy)]);
    return g;
  };
  const fj: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const fj4096: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.5, neg: 1, widthBasis: -100, channelRange: 4096 };
  const through = inSpace("biex through the lattice", fj, [[40, 700], [900, 30], [9000, 1200], [60, 9000]]);
  const through4096 = inSpace("biex through the lattice, 4096 channels", fj4096, [[30, 500], [700, 40], [6000, 900], [300, 7000], [20, 2500]]);
  const corner = inSpace("biex corner on the lattice", fj, [[-1e9, -1e9], [2000, -1e9], [800, 1500], [-1e9, 3000]]);
  const gates = [through, through4096, corner];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const counts = countsByPath(reading, ws);
  const differ = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };

  // A FlowJo log polygon on its floor bends in raw space and cannot be split exactly; it is held
  // within DENSIFY_TOLERANCE of the gate's extent. At 0.05% that placed 17 of 20,900 of this
  // file's events differently (0.08%); at 0.01%, 2.
  const wsplog: TransformSpec = { kind: "wsplog", offset: 1, decades: 4.5 };
  const logFloor = inSpace("log floor polygon over the lattice", wsplog, [[-1e6, -1e6], [300, -1e6], [170, 140], [90, 330], [-1e6, 250]]);
  const smooth = workspaceOf([logFloor], [[logFloor.name, [newGateRef(logFloor.gate_id)], null]]);
  const smoothCounts = countsByPath(reading, smooth);

  for (const format of FORMATS) {
    it(`places at most 0.03% of another file's events differently where it bends smoothly (${format})`, () => {
      const xml = exportGatingML({ ...smooth, sample: exporting, format, timestamp: "t" });
      const back = countsByPath(reading, importGatingML(xml, reading.channelNames(), pnnMapOf(reading), "flow"));
      const mine = smoothCounts.get(`/${logFloor.name}`)!;
      expect(mine.length).toBeGreaterThan(5000);
      const d1 = differ(mine, back.get(`/${logFloor.name}`)!);
      const d2 = differ(mine, standardReaderEvents(xml, logFloor.name, reading));
      expect(Math.max(d1, d2), `GateLab ${d1}, standard ${d2} of ${mine.length}`).toBeLessThanOrEqual(mine.length * 0.0003);
    }, 60000);
    it(`places no other file's event differently, for GateLab or a standard reader (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample: exporting, format, timestamp: "t" });
      const back = countsByPath(reading, importGatingML(xml, reading.channelNames(), pnnMapOf(reading), "flow"));
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        expect(mine.length, g.name).toBeGreaterThan(1000);
        const d1 = differ(mine, back.get(`/${g.name}`)!);
        const d2 = differ(mine, standardReaderEvents(xml, g.name, reading));
        expect([d1, d2], `${format} ${g.name}: GateLab ${d1}, standard ${d2} of ${mine.length}`).toEqual([0, 0]);
      }
    }, 60000);
  }
});

/** Events two readings place differently. */
const differOf = (a: number[], b: number[]) => { const set = new Set(b); return a.filter((i) => !set.has(i)).length + b.length - a.filter((i) => set.has(i)).length; };

describe("a polygon collapsed onto one corner of a biex table", () => {
  // Every vertex beyond both ends of its axes' tables puts the whole polygon, in GateLab's own
  // space, on the one point at that corner. GateLab's polygon test held nothing for a ring with no
  // edge of any length, and fix/gatingml-hardening (a54cb59) wrote such a ring without a corner
  // skirt to match; feat/flowjo-grid makes the test hold the ring's one point, as FlowJo's grid holds
  // a polygon all on one channel, so GateLab holds the events beyond the corner, and the export
  // skirts the corner again so that every reader holds them too.
  const sample = new Sample(syntheticFlowFcs());
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  // A table ending at 3,841 has many of the synthetic positives beyond its top; one ending at
  // 262,144 has many of the negatives below its floor (-93.5).
  const top: TransformSpec = { kind: "biex", maxValue: 4000, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const floor: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const inSpace = (name: string, xs: TransformSpec, ys: TransformSpec, raw: Vertex[]): Gate => {
    const g = { ...rawGate(name, "polygon", cd4, cd8, raw), space: "display", transforms: { [cd4]: xs, [cd8]: ys } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([vx, vy]) => [sample.rawToGate(g, cd4, vx), sample.rawToGate(g, cd8, vy)]);
    return g;
  };
  const B = 1e9;
  const collapsed = [
    inSpace("floor point", floor, floor, [[-B, -B], [-2 * B, -B], [-2 * B, -2 * B], [-B, -2 * B]]),
    inSpace("floor triangle", floor, floor, [[-B, -B], [-2 * B, -B], [-B, -2 * B]]),
    inSpace("top point", top, top, [[B, B], [2 * B, B], [2 * B, 2 * B], [B, 2 * B]]),
    inSpace("top by floor point", top, floor, [[B, -B], [2 * B, -B], [2 * B, -2 * B], [B, -2 * B]]),
  ];
  // Not collapsed, and holding the events beyond the corner, which is a vertex of an edge: a line
  // along the floor to the corner, and a triangle with a vertex there.
  const held = [
    inSpace("floor line to the corner", floor, floor, [[-B, -B], [-B, 3000], [-2 * B, 3000]]),
    inSpace("floor corner triangle", floor, floor, [[-B, -B], [3000, -B], [-B, 3000]]),
  ];
  const gates = [...collapsed, ...held];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const counts = countsByPath(sample, ws);

  it("uses fixtures with events beyond each corner, which GateLab holds at the collapsed ring's point", () => {
    const beyond = (g: Gate) => {
      const d = sample.gatingDataFor(g);
      const x = d.column(cd4)!;
      const y = d.column(cd8)!;
      const [cx, cy] = (g as Gate & { vertices: Vertex[] }).vertices[0];
      let n = 0;
      for (let i = 0; i < x.length; i++) if (x[i] === cx && y[i] === cy) n++;
      return n;
    };
    for (const g of collapsed) {
      expect(beyond(g), g.name).toBeGreaterThan(100);
      expect(counts.get(`/${g.name}`)!.length, g.name).toBe(beyond(g));
    }
    for (const g of held) expect(counts.get(`/${g.name}`)!.length, g.name).toBeGreaterThan(beyond(g));
  });

  for (const format of FORMATS) {
    it(`is written holding what GateLab holds, for a standard reader and for GateLab (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      if (!SKIP_REASON) expect(validate(xml).errors.replace(/^- validates\s*$/m, "").trim()).toBe("");
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const got = [
          differOf(mine, standardReaderEvents(xml, g.name, sample)),
          differOf(mine, standardReaderEvents(xml, g.name, sample, "inclusive")),
          differOf(mine, back.get(`/${g.name}`)!),
        ];
        expect(got, `${g.name}: ${got.join(", ")} of ${mine.length} events differ`).toEqual([0, 0, 0]);
      }
    });
  }
});

describe("a gate that reaches past the end of its biex table", () => {
  // GateLab places every event beyond a biex table at the table's end, so the part of a gate past
  // the end holds nothing, and the gate is the part within, with the table's end as its edge there.
  // A polygon vertex past the end, which the app never makes (it clamps what is drawn) but a
  // workspace or the API can carry, sent the export after a boundary that no written point can
  // reach, and it failed in both formats with "Maximum call stack size exceeded"; an ellipse
  // crossing the end, which a FlowJo workspace can carry, did the same. 0.8.3 exported both.
  const sample = new Sample(syntheticFlowFcs());
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const top: TransformSpec = { kind: "biex", maxValue: 4000, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const floor: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const stored = (name: string, spec: TransformSpec, vertices: Vertex[]): Gate =>
    ({ ...rawGate(name, "polygon", cd4, cd8, vertices), space: "display", transforms: { [cd4]: spec, [cd8]: spec } }) as Gate;
  const ellipse = (name: string, spec: TransformSpec, mean: [number, number], cov: [[number, number], [number, number]]): Gate => ({
    gate_id: uuid(), name, gate_type: "ellipse", x_channel: cd4, y_channel: cd8, mean, covariance: cov, distance_square: 1,
    color: "#000", label_offset: null, space: "display", transforms: { [cd4]: spec, [cd8]: spec },
  }) as Gate;
  const gates = [
    stored("past the top", top, [[140, 140], [262, 150], [256.5, 250], [150, 250]]),
    stored("past the floor", floor, [[-30, 60], [150, 80], [120, 200], [-30, 180]]),
    stored("past the top corner", top, [[200, 200], [300, 200], [300, 300], [200, 300]]),
    ellipse("ellipse past the top", top, [245, 200], [[400, 60], [60, 500]]),
    ellipse("ellipse past the floor corner", floor, [5, 8], [[300, 40], [40, 300]]),
  ];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const counts = countsByPath(sample, ws);

  it("uses gates that hold events on the table's end", () => {
    for (const g of gates) {
      const d = sample.gatingDataFor(g);
      const x = d.column(cd4)!;
      const y = d.column(cd8)!;
      const end = g.name.includes("floor") ? 0 : 256;
      const onEnd = counts.get(`/${g.name}`)!.filter((i) => x[i] === end || y[i] === end).length;
      expect(onEnd, g.name).toBeGreaterThan(10);
    }
  });

  for (const format of FORMATS) {
    it(`is written as the part within the table, holding what GateLab holds (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      if (!SKIP_REASON) expect(validate(xml).errors.replace(/^- validates\s*$/m, "").trim()).toBe("");
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const got = [differOf(mine, standardReaderEvents(xml, g.name, sample)), differOf(mine, back.get(`/${g.name}`)!)];
        expect(Math.max(...got), `${g.name}: ${got.join(", ")} of ${mine.length} events differ`)
          .toBeLessThanOrEqual(Math.max(1, Math.floor(mine.length * 0.001)));
      }
    }, 60000);
  }

  it("refuses, by name, a polygon that leaves the table more than once on one side", () => {
    // Clipped to the table, its parts past the end would be joined along the end, where GateLab
    // holds no event between them.
    const twice = stored("out and back twice", top, [[150, 100], [300, 110], [200, 130], [300, 150], [150, 160]]);
    const one = workspaceOf([twice], [[twice.name, [newGateRef(twice.gate_id)], null]]);
    for (const format of FORMATS) {
      expect(() => exportGatingML({ ...one, sample, format, timestamp: "t" }), format).toThrow(/"out and back twice"/);
    }
  });
});

describe("a gate with nothing within its axes' clamps but a point on them", () => {
  // A gate that lies wholly beyond a clamp, or reaches it only at a point, holds for GateLab only the
  // events it places on the clamp at that point, if any. Such a gate was refused, and the whole export
  // with it: an ellipse below a FlowJo log floor, which the export wrote as flog until the fifth round
  // (FlowKit read 224 of its events where GateLab holds 0), and a biex polygon with a vertex on the
  // table's end and the rest beyond it. With that vertex twice, it was written as a PolygonGate of two
  // vertices, which the schema refuses, and FlowKit and GateLab refused the file. An ellipse tangent to
  // a flog floor from inside was written as a sliver of 14,671 vertices.
  const biex: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const flog: TransformSpec = { kind: "flog", T: 262144, M: 4.5 };
  const log: TransformSpec = { kind: "wsplog", offset: 1, decades: 4.5 };
  const sample = (() => {
    const fcs = syntheticFlowFcs(6000, 231);
    const u = prng(232);
    // A fifth of the events beyond the biex table's top on x at one value of y, a twentieth beyond both
    // tops, a fifth below the log floors on x, the rest spread.
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 6000; i++) {
      const r = u();
      if (r < 0.05) { xs.push(300000); ys.push(300000); }
      else if (r < 0.2) { xs.push(300000); ys.push(5000); }
      else if (r < 0.4) { xs.push(Math.fround(1 - 300 * u())); ys.push(Math.fround(10 ** (1 + 3 * u()))); }
      else { xs.push(Math.fround(10 ** (4 * u()))); ys.push(Math.fround(10 ** (4 * u()))); }
    }
    fcs.columns[2] = Float32Array.from(xs);
    fcs.columns[3] = Float32Array.from(ys);
    const s = new Sample(fcs);
    s.setCompensation(false);
    return s;
  })();
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const space = (spec: TransformSpec) => ({ space: "display", transforms: { [cd4]: spec, [cd8]: spec } });
  const polygon = (name: string, spec: TransformSpec, vertices: Vertex[]): Gate => ({ ...rawGate(name, "polygon", cd4, cd8, vertices), ...space(spec) } as Gate);
  const ellipse = (name: string, spec: TransformSpec, mean: [number, number], r: [number, number]): Gate => ({
    gate_id: uuid(), name, gate_type: "ellipse", x_channel: cd4, y_channel: cd8, mean, covariance: [[r[0] * r[0], 0], [0, r[1] * r[1]]],
    distance_square: 1, color: "#000", label_offset: null, ...space(spec),
  } as Gate);
  // The stack's value of y in biex, as GateLab holds it, so a vertex there holds the stack.
  const stackY = Math.fround(sample.rawToGate(polygon("probe", biex, []), cd8, 5000));
  const gates = [
    // A triangle beyond the top of x and y but for a short edge along y's top end that reaches the
    // corner, where GateLab holds every event beyond both: an edge 2e-5 channels long is still an edge.
    polygon("biex triangle on the top corner by a short edge", biex, [[256 - 1e-5, 256], [256 + 1e-5, 256], [256, 256 + 1e-5]]),
    ellipse("flog ellipse below the floor", flog, [-0.05, 0.3], [0.04, 0.1]),
    ellipse("flog ellipse touching the floor from below", flog, [-0.04, 0.3], [0.04, 0.1]),
    ellipse("FlowJo log ellipse below the floor", log, [-0.06, 0.4], [0.05, 0.1]),
    ellipse("flog ellipse touching the floor from inside", flog, [0.04, 0.3], [0.04, 0.1]),
    polygon("biex vertex on the top twice, the rest beyond", biex, [[256, stackY], [256, stackY], [290, stackY + 10], [270, stackY + 30]]),
    polygon("biex vertex on the top, the rest beyond", biex, [[256, stackY], [290, stackY + 10], [270, stackY + 30]]),
    polygon("biex polygon wholly beyond the top", biex, [[260, 150], [290, 160], [270, 180]]),
  ];
  const ws = workspaceOf(gates, gates.map((g) => [g.name, [newGateRef(g.gate_id)], null] as [string, GateRef[], null]));
  const counts = countsByPath(sample, ws);

  it("uses gates of which GateLab holds a stack at the point for some and nothing for others", () => {
    expect(counts.get("/biex triangle on the top corner by a short edge")!.length).toBeGreaterThan(200);
    expect(counts.get("/biex vertex on the top twice, the rest beyond")!.length).toBeGreaterThan(500);
    expect(counts.get("/biex vertex on the top, the rest beyond")!.length).toBeGreaterThan(500);
    for (const g of gates.filter((g) => g.gate_type === "ellipse" && !g.name.includes("inside"))) expect(counts.get(`/${g.name}`)!.length, g.name).toBe(0);
    expect(counts.get("/biex polygon wholly beyond the top")!.length).toBe(0);
  });

  for (const format of FORMATS) {
    it(`is written as what GateLab holds there, in a file every reader accepts (${format})`, () => {
      const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
      if (!SKIP_REASON) expect(validate(xml).errors.replace(/^- validates\s*$/m, "").trim()).toBe("");
      const back = countsByPath(sample, importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow"));
      const bad: string[] = [];
      for (const g of gates) {
        const mine = counts.get(`/${g.name}`)!;
        const d = [differOf(mine, back.get(`/${g.name}`)!)];
        for (const rule of ["strict", "inclusive"] as const) d.push(differOf(mine, standardReaderEvents(xml, g.name, sample, rule)));
        if (d.some((v) => v > 0)) bad.push(`${g.name}: ${d.join(", ")} of ${mine.length}`);
      }
      expect(bad).toEqual([]);
      // A tangent from beyond is the point it touches at, not a sliver of thousands of vertices.
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      const tangent = Array.from(doc.documentElement.children).find((e) =>
        e.localName === "PolygonGate" && e.getElementsByTagName("name")[0]?.textContent === "flog ellipse touching the floor from below")!;
      expect(tangent.getElementsByTagName("gating:vertex").length).toBeLessThan(20);
    }, 60000);
  }
});

describe("the Cytobank format keeps an exclusion its ancestry contradicts", () => {
  // The Cytobank format writes each population as the AND of its whole ancestry, and it kept one
  // reference per gate: a population excluding a gate its ancestor includes, or including one its
  // ancestor excludes, or doing both itself, holds no event in GateLab and was written as the AND of
  // the included gates alone. FlowKit read 85,232, 72,020, 35,768 and 85,232 events of four such
  // populations on the public PBMC file, and GateLab's re-import 63,153 for one that holds none.
  const sample = new Sample(syntheticFlowFcs());
  const fsc = keyOf(sample, "FSC-A");
  const ssc = keyOf(sample, "SSC-A");
  const cd4 = keyOf(sample, "FITC-A");
  const cd3 = keyOf(sample, "APC-A");
  const cells = rawGate("Cells", "polygon", fsc, ssc, [[40000, 15000], [175000, 15000], [175000, 110000], [40000, 110000]]);
  const r = rawGate("CD3_positive", "rectangle", cd3, cd3, [[3000, 3000], [1e7, 3000], [1e7, 1e7], [3000, 1e7]]);
  const q = rawGate("CD4_positive", "rectangle", cd4, cd4, [[2500, 2500], [1e7, 2500], [1e7, 1e7], [2500, 1e7]]);
  const ws = workspaceOf([cells, r, q], [
    ["R", [newGateRef(r.gate_id)], null],
    ["R then not R", [newGateRef(r.gate_id, false)], "R"],
    ["beneath the contradiction", [newGateRef(q.gate_id)], "R then not R"],
    ["Not R", [newGateRef(r.gate_id, false)], null],
    ["Not R then R", [newGateRef(r.gate_id)], "Not R"],
    ["R and not R", [newGateRef(r.gate_id), newGateRef(r.gate_id, false)], null],
    ["Cells", [newGateRef(cells.gate_id)], null],
    ["QR", [newGateRef(q.gate_id), newGateRef(r.gate_id)], "Cells"],
    ["QR again", [newGateRef(r.gate_id), newGateRef(q.gate_id)], "QR"],
    ["not R beneath the repeat", [newGateRef(r.gate_id, false)], "QR again"],
    ["not R beside Q", [newGateRef(r.gate_id, false), newGateRef(q.gate_id)], "Cells"],
  ]);
  const xml = exportGatingML({ ...ws, sample, format: "cytobank", timestamp: "t" });
  const byName = (t: Pick<Workspace, "gates" | "populations" | "root_population_id">) => {
    const out = new Map<string, number[]>();
    for (const [path, idx] of countsByPath(sample, t)) out.set(path.slice(path.lastIndexOf("/") + 1), idx);
    return out;
  };
  const mine = byName(ws);

  /** Each population as a reader of the file alone reads it: the AND of its BooleanGate's references. */
  const readerEvents = (name: string): number[] => {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const els = Array.from(doc.documentElement.children);
    const nameOf = (el: Element) => el.getElementsByTagName("name")[0]?.textContent;
    const pop = els.find((el) => el.localName === "BooleanGate" && nameOf(el) === name)!;
    expect(pop, name).toBeTruthy();
    const terms = Array.from(pop.getElementsByTagName("gating:gateReference")).map((ref) => {
      const target = els.find((el) => el.getAttribute("gating:id") === ref.getAttribute("gating:ref"))!;
      return { inside: new Set(standardReaderEvents(xml, nameOf(target)!, sample)), out: ref.getAttribute("gating:use-as-complement") === "true" };
    });
    const held: number[] = [];
    for (let i = 0; i < sample.fcs.nEvents; i++) if (terms.every((t) => t.inside.has(i) !== t.out)) held.push(i);
    return held;
  };

  it("uses populations of which the contradictory ones hold nothing in GateLab and the rest hold some", () => {
    for (const name of ["R then not R", "beneath the contradiction", "Not R then R", "R and not R", "not R beneath the repeat"]) {
      expect(mine.get(name)!.length, name).toBe(0);
    }
    for (const name of ["R", "Not R", "Cells", "QR", "QR again", "not R beside Q"]) {
      expect(mine.get(name)!.length, name).toBeGreaterThan(50);
    }
  });

  it("is read from the file alone holding what GateLab holds", () => {
    for (const [name, idx] of mine) expect(readerEvents(name), name).toEqual(idx);
  });

  it("comes back into GateLab in the same places, holding the same events", () => {
    const back = importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow");
    expect(countsByPath(sample, back)).toEqual(countsByPath(sample, ws));
  });

  it("comes back into GateLab holding the same events without GateLab's tree", () => {
    const inferred = importGatingML(xml.replace(/\s*<gatelab_format>[^<]*<\/gatelab_format>/, ""),
      sample.channelNames(), pnnMapOf(sample), "flow");
    const got = byName(inferred);
    for (const [name, idx] of mine) expect(got.get(name), name).toEqual(idx);
  });
});

// ── Readers that predate these files ────────────────────────────────────────────────────────

describe("a file an older reader would misread is one it refuses", () => {
  // GateLab 0.2.0 to 0.8.3, GateLabR 1.3.0 to 1.4.7's R importer and the GateLab build GateLabR
  // 1.4.x embeds read a Cytobank-format exclusion as an inclusion and place a standard-format
  // logicle gate 4.5 times too low, and cannot be changed. They accept only "FCS" and
  // "uncompensated" as the compensation record's reference and stop on anything else before
  // changing anything, so every file now carries another. GateLab 0.1.0 and GateLabR 1.0.0 to
  // 1.2.2 predate that check: we know of nothing a well-formed file can hold that they refuse. They
  // leave out every range gate, misread these files of flow data (GateLabR 1.0.0 stops with an R
  // error instead), and misread files of mass cytometry data wherever a gate is on a logicle, FlowJo
  // biex, FlowJo log or flog axis or a population excludes a gate.
  const scalesOf = (xml: string) =>
    JSON.parse(xml.match(/<gatelabr_scales>\s*<definition>([^<]*)<\/definition>/)![1].replaceAll("&amp;", "&"));
  /** GateLab 0.8.3's own check (gatingml.ts parseGatelabrState, 2026-07-15 on), and GateLabR's. */
  const olderReaderAccepts = (xml: string) => ["FCS", "uncompensated"].includes(scalesOf(xml).compensation.reference);
  const cases: [string, () => { sample: Sample; ws: Workspace }][] = [
    ["flow, uncompensated", () => { const sample = new Sample(syntheticFlowFcs()); return { sample, ws: richFlowWorkspace(sample) }; }],
    ["flow, compensated", () => { const sample = new Sample(syntheticFlowFcs()); sample.setCompensation(true); return { sample, ws: richFlowWorkspace(sample) }; }],
    ["flow, a matrix not the FCS file's own", () => { const sample = externallyCompensated(); return { sample, ws: richFlowWorkspace(sample) }; }],
    ["CyTOF", () => { const sample = new Sample(syntheticCytofFcs()); return { sample, ws: cytofWorkspace(sample) }; }],
  ];
  for (const format of FORMATS) {
    for (const [name, make] of cases) {
      it(`carries a reference older readers refuse, and still imports here (${name}, ${format})`, () => {
        const { sample, ws } = make();
        const xml = exportGatingML({ ...ws, sample, format, timestamp: "t" });
        expect(scalesOf(xml)).toMatchObject({ version: 4, compensation: { reference: "dimensions" } });
        expect(olderReaderAccepts(xml)).toBe(false);
        const back = importGatingML(xml, sample.channelNames(), pnnMapOf(sample), sample.instrument);
        expect(back.compensation?.enabled).toBe(sample.instrument === "flow" && sample.compensationEnabled);
      });
    }
  }

  it("still reads the references files written before version 4 carry", () => {
    const sample = new Sample(syntheticFlowFcs());
    sample.setCompensation(true);
    const ws = richFlowWorkspace(sample);
    const xml = exportGatingML({ ...ws, sample, format: "standard", timestamp: "t" });
    const before = importGatingML(xml.replace('"reference":"dimensions"', '"reference":"FCS"'), sample.channelNames(), pnnMapOf(sample), "flow");
    const now = importGatingML(xml, sample.channelNames(), pnnMapOf(sample), "flow");
    expect(now.compensation).toEqual(before.compensation);
    expect(() => importGatingML(xml.replace('"reference":"dimensions"', '"reference":"elsewhere"'), sample.channelNames(), pnnMapOf(sample), "flow"))
      .toThrow(/Invalid embedded GateLab scale or compensation metadata/);
  });
});

// ── Validation against the ISAC schema ───────────────────────────────────────────────────────
//
// xmllint through a child process, against the schema files vendored (unmodified, under ISAC's
// free-distribution notice) in __fixtures__/gatingml-2.0-xsd. --nonet keeps it offline: the
// schema imports its two siblings by relative path. macOS ships xmllint; on Debian and Ubuntu it
// is in libxml2-utils. Without it these cases are skipped, and say so, rather than passing.

const XSD = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "gatingml-2.0-xsd", "Gating-ML.v2.0.xsd");
const XMLLINT_MISSING = spawnSync("xmllint", ["--version"]).error !== undefined;
const SKIP_REASON = XMLLINT_MISSING
  ? "xmllint is not installed (it ships with macOS; on Debian/Ubuntu install libxml2-utils)"
  : !existsSync(XSD) ? `the ISAC Gating-ML 2.0 schema is missing at ${XSD}` : null;

function validate(xml: string): { ok: boolean; errors: string } {
  const r = spawnSync("xmllint", ["--noout", "--nonet", "--schema", XSD, "-"], { input: xml, encoding: "utf8" });
  return { ok: r.status === 0, errors: `${r.stderr ?? ""}` };
}

/** CyTOF: every gate in arcsinh, a NOT, and a gate on a Gaussian parameter. */
function syntheticCytofFcs(n = 3000, seed = 11): FcsFile {
  const u = prng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  const pos = (frac: number, mid: number) => () => (u() < frac ? Math.exp(Math.log(mid) + 0.5 * gauss()) : Math.abs(2 * gauss()));
  const gens = [() => 0, pos(0.95, 400), pos(0.3, 60), pos(0.6, 90), pos(0.4, 50), () => 20 + 5 * gauss()];
  const columns = gens.map(() => [] as number[]);
  for (let i = 0; i < n; i++) gens.forEach((g, j) => columns[j].push(j === 0 ? i : g()));
  const ch = (index: number, name: string, marker: string | null) => ({ index, name, marker, bits: 32, range: 1 });
  return {
    version: "FCS3.0", nEvents: n, instrument: "cytof", keywords: {}, spillover: null,
    channels: [ch(0, "Time", null), ch(1, "Y89Di", "CD45"), ch(2, "Nd142Di", "CD19"), ch(3, "Nd144Di", "CD3"),
      ch(4, "Sm147Di", "CD4"), ch(5, "Width", null)],
    columns: columns.map((c) => Float32Array.from(c)),
  };
}

function cytofWorkspace(sample: Sample) {
  const [cd45, cd19, cd3, cd4, width] = ["Y89Di", "Nd142Di", "Nd144Di", "Sm147Di", "Width"].map((p) => keyOf(sample, p));
  // Gate names whose standard base64 holds '+' ("CD45 >") and '/' ("CD19 (B)?").
  const live = displayGate(sample, "CD45 >", "rectangle", cd45, width, [[100, 5], [5000, 5], [5000, 40], [100, 40]]);
  const b = displayGate(sample, "CD19 (B)?", "polygon", cd19, cd3, [[20, 0], [2000, 0], [2000, 15], [20, 15]]);
  const t = displayGate(sample, "CD3_positive", "rectangle", cd3, cd4, [[30, 0], [3000, 0], [3000, 3000], [30, 3000]]);
  return workspaceOf([live, b, t], [
    ["CD45_positive", [newGateRef(live.gate_id)], null],
    ["B cells", [newGateRef(b.gate_id)], "CD45_positive"],
    ["Not B", [newGateRef(b.gate_id, false)], "CD45_positive"],
    ["T not B", [newGateRef(t.gate_id), newGateRef(b.gate_id, false)], "CD45_positive"],
  ]);
}

/** Gates in the spaces a FlowJo workspace brings: biex (written raw, densified), log (flog). */
function flowjoSpaceWorkspace(sample: Sample) {
  const cd4 = keyOf(sample, "FITC-A");
  const cd8 = keyOf(sample, "PE-A");
  const inSpace = (name: string, type: "rectangle" | "polygon", spec: TransformSpec, raw: Vertex[]): Gate => {
    const g = { ...rawGate(name, type, cd4, cd8, raw), space: "display", transforms: { [cd4]: spec, [cd8]: spec } } as Gate & { vertices: Vertex[] };
    g.vertices = raw.map(([x, y]) => [sample.rawToGate(g, cd4, x), sample.rawToGate(g, cd8, y)]);
    return g;
  };
  const biex: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.418539922, neg: 0, widthBasis: -10, channelRange: 256 };
  const wsplog: TransformSpec = { kind: "wsplog", offset: 1, decades: 4.5 };
  const flog: TransformSpec = { kind: "flog", T: 262144, M: 4.5 };
  const a = inSpace("biex poly", "polygon", biex, [[-500, 1500], [2500, 1200], [6000, 40000], [-500, 60000]]);
  // Gate names whose standard base64 holds '+' ("floor rect >") and '/' ("log rect?").
  const b = inSpace("floor rect >", "rectangle", wsplog, [[0, 0], [2000, 0], [2000, 1500], [0, 1500]]);
  const c = inSpace("log rect?", "rectangle", flog, [[2000, 10], [60000, 10], [60000, 1500], [2000, 1500]]);
  return workspaceOf([a, b, c], [
    ["biex poly", [newGateRef(a.gate_id)], null],
    ["floor rect", [newGateRef(b.gate_id)], "biex poly"],
    ["log rect", [newGateRef(c.gate_id)], null],
  ]);
}

if (SKIP_REASON) {
  describe("exports validate against the ISAC Gating-ML 2.0 schema", () => {
    it.skip(`skipped: ${SKIP_REASON}`, () => {});
  });
} else {
  describe("exports validate against the ISAC Gating-ML 2.0 schema", () => {
    const flow = () => new Sample(syntheticFlowFcs());
    const cases: [string, () => { xml: string }][] = [];
    for (const format of FORMATS) {
      cases.push([`flow, every construct, compensated (${format})`, () => {
        const sample = flow();
        sample.setCompensation(true);
        expect(sample.compensationEnabled).toBe(true);
        return { xml: exportGatingML({ ...richFlowWorkspace(sample), sample, format, timestamp: "t" }) };
      }]);
      cases.push([`flow, every construct, uncompensated (${format})`, () => {
        const sample = flow();
        return { xml: exportGatingML({ ...richFlowWorkspace(sample), sample, format, timestamp: "t" }) };
      }]);
      cases.push([`flow, compensated with a matrix that is not the FCS file's own (${format})`, () => {
        const sample = externallyCompensated();
        return { xml: exportGatingML({ ...richFlowWorkspace(sample), sample, format, timestamp: "t" }) };
      }]);
      cases.push([`flow, FlowJo biex and log gates (${format})`, () => {
        const sample = flow();
        return { xml: exportGatingML({ ...flowjoSpaceWorkspace(sample), sample, format, timestamp: "t" }) };
      }]);
      cases.push([`CyTOF (${format})`, () => {
        const sample = new Sample(syntheticCytofFcs());
        return { xml: exportGatingML({ ...cytofWorkspace(sample), sample, format, timestamp: "t" }) };
      }]);
      cases.push([`an OR population at the root (${format})`, () => {
        const sample = flow();
        const cd4 = keyOf(sample, "FITC-A");
        const cd8 = keyOf(sample, "PE-A");
        const a = rawGate("CD4_positive", "rectangle", cd4, cd8, [[2500, -1000], [150000, -1000], [150000, 1500], [2500, 1500]]);
        const b = rawGate("CD8_positive", "rectangle", cd4, cd8, [[-1000, 1500], [2500, 1500], [2500, 60000], [-1000, 60000]]);
        const ws = workspaceOf([a, b], [["CD4 or CD8", [newGateRef(a.gate_id), newGateRef(b.gate_id, false)], null, "or"]]);
        return { xml: exportGatingML({ ...ws, sample, format, timestamp: "t" }) };
      }]);
    }

    for (const [name, make] of cases) {
      it(name, () => {
        const { xml } = make();
        const { ok, errors } = validate(xml);
        expect(errors.replace(/^- validates\s*$/m, "").trim(), name).toBe("");
        expect(ok).toBe(true);
      });
    }

    it("is a real check: a GatingHierarchy, a '+' in an id, or gating:complement fails it", () => {
      // Without this the cases above could pass on a validator that accepts anything.
      const sample = flow();
      const xml = exportGatingML({ ...richFlowWorkspace(sample), sample, format: "standard", timestamp: "t" });
      expect(validate(xml).ok).toBe(true);
      const legacy = xml.replace("</gating:Gating-ML>",
        "  <gating:GatingHierarchy><gating:PopulationGatePair gating:gate-ref=\"GateSet_36000000\" /></gating:GatingHierarchy>\n</gating:Gating-ML>");
      const bad = validate(legacy);
      expect(bad.ok).toBe(false);
      expect(bad.errors).toMatch(/GatingHierarchy/);
      const plus = xml.replaceAll("GateSet_36000000", "GateSet+36000000");
      expect(validate(plus).ok).toBe(false);
      const cytobank = exportGatingML({ ...richFlowWorkspace(sample), sample, format: "cytobank", timestamp: "t" });
      expect(cytobank).toContain("use-as-complement");
      expect(validate(cytobank.replaceAll("use-as-complement", "complement")).ok).toBe(false);
    });
  });
}
