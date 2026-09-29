// @vitest-environment jsdom
//
// Which events a rectangle holds when they lie exactly on its edges (models.ts, RectangleBounds).
//
//   - A rectangle drawn in GateLab is half-open, [min, max), Gating-ML 2.0's rule.
//   - A rectangle without a rule, which is every rectangle saved before rules existed, is closed,
//     [min, max], the rule it was evaluated under, and so is one from a writer whose own rule is
//     closed (FlowJo, flowUtils, CytoML) or unmeasured (Cytobank, FACSDiva, FACSChorus, GateLab
//     0.8.3 and earlier). A Gating-ML file whose writer cannot be identified is half-open.
//   - Every export GateLab writes brings each rectangle back holding the same events, the ones on
//     its edges and corners included, on every axis GateLab holds.
//
// The events are synthetic float32 values on a grid, so that every edge and corner has events
// exactly on it: each edge is placed at the display value of one grid value, as the column the
// gate is evaluated in holds it.

import { describe, expect, it } from "vitest";
import { writeFcs } from "./fcsExport";
import { parseFcs } from "./fcs";
import { Sample, transformFromSpec } from "./sample";
import { columnsForGate, getGateMask } from "./gates";
import { gatingMLWriter, importGatingML, writerRectangleBounds, type GatingMLResult } from "./gatingml";
import { exportGatingML } from "./gatingmlExport";
import { exportFlowJoWorkspace } from "./flowjoExport";
import { flowJoWorkspaceToGatingML, WSP_RECT_BOUNDS_TAG } from "./flowjoWorkspace";
import { DEFAULT_BARCODE_TEMPLATE } from "./barcodeTemplate";
import { buildBarcodeGating, exportHierarchyCsv, parseBarcodeTable, resolveBarcodeScheme } from "./barcodeScheme";
import { GATINGML_EDGE_RULE_TAG, GATINGML_RECTANGLES_TAG, WSP_RECTANGLE_ATTR } from "./rectangleRecord";
import {
  linkChildToParent, newGate, newGateRef, newPopulation, newRootPopulation,
  type Gate, type PolyRectGate, type PopulationMap, type RectangleBounds, type TransformSpec,
} from "./models";

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";

// ── The synthetic file ──────────────────────────────────────────────────────────────────────

/** Raw values for the fluorescence grid: negative, near zero, and up to the top of the axis. */
const GRID = [
  -500, -60, -5, 0, 1, 7, 30, 120, 250, 900, 1500, 3200, 7777, 12000, 40000, 65536, 100000, 150000, 262143,
].map(Math.fround);
/** Grid positions of the rectangle's edges on each axis. */
const X_EDGES = [4, 13];
const Y_EDGES = [2, 15];

const DV = new DataView(new ArrayBuffer(8));
/** The double `k` steps above (k > 0) or below (k < 0) x, stepping its bit pattern. */
function stepDouble(x: number, k: number): number {
  if (x === 0) return k * Number.MIN_VALUE; // the subnormals either side of 0 are evenly spaced
  DV.setFloat64(0, x);
  const bits = DV.getBigUint64(0);
  DV.setBigUint64(0, (x >= 0) === (k > 0) ? bits + BigInt(Math.abs(k)) : bits - BigInt(Math.abs(k)));
  return DV.getFloat64(0);
}

/** The float32 `k` steps above (k > 0) or below (k < 0) x, a float32 value other than 0. */
function stepFloat32(x: number, k: number): number {
  const u = new Uint32Array(new Float32Array([x]).buffer);
  u[0] = x > 0 === k > 0 ? u[0] + Math.abs(k) : u[0] - Math.abs(k);
  return new Float32Array(u.buffer)[0];
}

/**
 * FL1-A x FL2-A over the grid, each edge's raw neighbours included; FSC-A, SSC-A a 0..10000 grid;
 * Time counting. With `float64`, FL1-A and FL2-A are held as float64, as GateLab holds a
 * $DATATYPE D file or a decoded log-amplified channel. Each edge then also has the 20 float32
 * values either side of it, over which a compressive display's rounding changes value, and the
 * doubles halfway between each two of them and 1 and 16 steps from the edge, which no float32
 * holds.
 */
function edgeSample(float64 = false): Sample {
  const vals = [...GRID];
  for (const i of [...X_EDGES, ...Y_EDGES]) {
    // The float32 values either side of each edge's raw value, as tight as data can sit.
    if (GRID[i] !== 0) vals.push(stepFloat32(GRID[i], 1), stepFloat32(GRID[i], -1));
    if (!float64 || GRID[i] === 0) continue;
    const run = Array.from({ length: 41 }, (_, j) => stepFloat32(GRID[i], j - 20));
    for (let j = 0; j + 1 < run.length; j++) vals.push(run[j], (run[j] + run[j + 1]) / 2);
    for (const k of [1, 16]) vals.push(stepDouble(GRID[i], k), stepDouble(GRID[i], -k));
  }
  vals.splice(0, vals.length, ...new Set(vals));
  const n = vals.length * vals.length;
  const cols = [0, 1, 2, 3, 4].map(() => new Float32Array(n));
  const fl = [new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) {
    cols[0][i] = (i % 11) * 1000;
    cols[1][i] = (Math.floor(i / 11) % 11) * 1000;
    fl[0][i] = cols[2][i] = vals[i % vals.length];
    fl[1][i] = cols[3][i] = vals[Math.floor(i / vals.length)];
    cols[4][i] = i;
  }
  const bytes = writeFcs(cols, [
    { name: "FSC-A", desc: "" }, { name: "SSC-A", desc: "" },
    { name: "FL1-A", desc: "" }, { name: "FL2-A", desc: "" }, { name: "Time", desc: "" },
  ]);
  const fcs = parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  if (float64) [fcs.columns[2], fcs.columns[3]] = fl;
  return new Sample(fcs);
}

/** The axes GateLab holds a gate on. `null` is raw values (a linear axis). */
const AXES: Record<string, TransformSpec | null> = {
  linear: null,
  "arcsinh": { kind: "asinh", cofactor: 150 },
  "logicle": { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 },
  "biexponential (FlowJo)": { kind: "biex", maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -10, channelRange: 256 },
  "log (Gating-ML flog)": { kind: "flog", T: 262144, M: 4.5 },
  "log (FlowJo)": { kind: "wsplog", offset: 1, decades: 5 },
};
const RULES: RectangleBounds[] = ["closed", "half-open"];

/** A rectangle on FL1-A x FL2-A whose edges sit exactly on the display values of grid events. */
function edgeGate(sample: Sample, spec: TransformSpec | null, bounds: RectangleBounds, name = "Box"): PolyRectGate {
  const base = newGate(name, "rectangle", "FL1-A", "FL2-A", [[0, 0], [1, 1]]);
  const gate: PolyRectGate = spec
    ? { ...base, space: "display", transforms: { "FL1-A": spec, "FL2-A": spec }, bounds }
    : { ...base, space: "raw", bounds };
  const cols = columnsForGate(sample.gateAssayData(), gate);
  const fx = cols.column("FL1-A")!;
  const fy = cols.column("FL2-A")!;
  // Grid value k sits at event k of FL1-A (the first row) and event k * nVals of FL2-A.
  const nVals = Math.round(Math.sqrt(sample.fcs.nEvents));
  const [x0, x1] = X_EDGES.map((k) => fx[k]);
  const [y0, y1] = Y_EDGES.map((k) => fy[k * nVals]);
  gate.vertices = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return gate;
}

/** What the rule says the gate holds, read off the gate's own float32 columns. */
function expectedMask(sample: Sample, gate: PolyRectGate): number[] {
  const cols = columnsForGate(sample.gateAssayData(), gate);
  const fx = cols.column(gate.x_channel)!;
  const fy = cols.column(gate.y_channel)!;
  const xs = gate.vertices.map((v) => v[0]);
  const ys = gate.vertices.map((v) => v[1]);
  const closed = gate.bounds !== "half-open";
  const within = (v: number, lo: number, hi: number) => v >= lo && (closed ? v <= hi : v < hi);
  return Array.from({ length: sample.fcs.nEvents }, (_, i) =>
    (within(fx[i], Math.min(...xs), Math.max(...xs)) && within(fy[i], Math.min(...ys), Math.max(...ys)) ? 1 : 0));
}

/** Events with FSC-A in x and SSC-A in y, the upper ends held or not. */
function scatterBox(sample: Sample, x: [number, number], y: [number, number], bounds: RectangleBounds): number {
  const fsc = sample.fcs.columns[0];
  const ssc = sample.fcs.columns[1];
  const within = (v: number, [lo, hi]: [number, number]) => v >= lo && (bounds === "closed" ? v <= hi : v < hi);
  let n = 0;
  for (let i = 0; i < fsc.length; i++) if (within(fsc[i], x) && within(ssc[i], y)) n++;
  return n;
}

const maskOf = (sample: Sample, gate: Gate): Uint8Array =>
  getGateMask(gate, columnsForGate(sample.gateAssayData(), gate));
const count = (m: ArrayLike<number>): number => Array.from(m).reduce((s, v) => s + v, 0);

/** Events lying exactly on an upper edge of the gate, in its own columns. */
function upperEdgeEvents(sample: Sample, gate: PolyRectGate): number {
  const cols = columnsForGate(sample.gateAssayData(), gate);
  const fx = cols.column(gate.x_channel)!;
  const fy = cols.column(gate.y_channel)!;
  const xs = gate.vertices.map((v) => v[0]);
  const ys = gate.vertices.map((v) => v[1]);
  let n = 0;
  for (let i = 0; i < fx.length; i++) if (fx[i] === Math.max(...xs) || fy[i] === Math.max(...ys)) n++;
  return n;
}

/** One population per gate under the root, in the form the exporters take. */
function treeOf(...gates: Gate[]) {
  const root = newRootPopulation();
  let populations: PopulationMap = { [root.population_id]: root };
  const byId: Record<string, Gate> = {};
  for (const g of gates) {
    byId[g.gate_id] = g;
    const p = newPopulation(g.name, [newGateRef(g.gate_id, true)], root.population_id);
    populations[p.population_id] = p;
    populations = linkChildToParent(populations, p.population_id, root.population_id);
  }
  return { gates: byId, gate_order: gates.map((g) => g.gate_id), populations, root_population_id: root.population_id };
}

/** A Gating-ML file with GateLab's per-rectangle records taken out. */
function withoutRecords(xml: string): string {
  const out = xml.replace(new RegExp(`\\s*<${GATINGML_RECTANGLES_TAG}>[\\s\\S]*?</${GATINGML_RECTANGLES_TAG}>`), "");
  expect(out).not.toBe(xml);
  return out;
}

function importInto(sample: Sample, xml: string): GatingMLResult {
  const pnn: Record<string, string> = {};
  for (const c of sample.channels) pnn[c.pnn] = c.key;
  return importGatingML(xml, sample.channels.map((c) => c.key), pnn, sample.instrument);
}

function onlyRectangle(gates: Record<string, Gate>, name?: string): PolyRectGate {
  const rects = Object.values(gates).filter((g) => g.gate_type === "rectangle" && (!name || g.name === name));
  expect(rects).toHaveLength(1);
  return rects[0] as PolyRectGate;
}

const bareTemplate = () => ({
  ...DEFAULT_BARCODE_TEMPLATE,
  qc: [],
  states: { "--": [[0, 0], [1, 0], [1, 1]], "+-": [[0, 0], [1, 0], [1, 1]], "-+": [[0, 0], [1, 0], [1, 1]], "++": [[0, 0], [1, 0], [1, 1]] },
} as typeof DEFAULT_BARCODE_TEMPLATE);

/** Each export format, and GateLab reading it back: the rectangle as it comes back. */
const FORMATS: Record<string, (sample: Sample, gate: PolyRectGate) => PolyRectGate> = {
  "standard Gating-ML": (sample, gate) =>
    onlyRectangle(importInto(sample, exportGatingML({ ...treeOf(gate), sample, format: "standard", timestamp: "t" })).gates),
  "Cytobank Gating-ML": (sample, gate) =>
    onlyRectangle(importInto(sample, exportGatingML({ ...treeOf(gate), sample, format: "cytobank", timestamp: "t" })).gates),
  "FlowJo workspace": (sample, gate) => {
    const { xml } = exportFlowJoWorkspace({
      samples: [{ sample, fileName: "edges.fcs", ...treeOf(gate) }], now: new Date("2026-09-24T00:00:00Z"), producer: "GateLab test",
    });
    return onlyRectangle(importInto(sample, flowJoWorkspaceToGatingML(xml, 0, null).gatingMl).gates);
  },
  "hierarchy CSV": (sample, gate) => {
    const tree = treeOf(gate);
    const out = exportHierarchyCsv(Object.values(tree.gates), tree.populations, tree.root_population_id, "test", {
      context: sample, cofactor: sample.arcsinhCofactor,
    });
    const scheme = resolveBarcodeScheme(parseBarcodeTable(out.csv), sample.channels);
    expect(scheme.problems).toEqual([]);
    const built = buildBarcodeGating(scheme, bareTemplate(), sample.arcsinhCofactor, { qc: true, channels: sample.channels });
    return onlyRectangle(built.gates);
  },
};

/**
 * Whether the Cytobank format writes a logicle rectangle where it is. Until the Gating-ML
 * hardening branch (fix/gatingml-hardening), the logicle coordinate was multiplied by flowCore's
 * span before it was re-expressed as arcsinh, which put the rectangle far above the data. GateLab's
 * record does not paper over that (rectangleRecord.ts, statesRecord), so the round trip for that
 * one pair is run only once the file's own geometry is right.
 */
function cytobankWritesLogicleRight(sample: Sample): boolean {
  const gate = edgeGate(sample, AXES.logicle, "closed");
  const xml = exportGatingML({ ...treeOf(gate), sample, format: "cytobank", timestamp: "t" })
    .replace(new RegExp(`\\s*<${GATINGML_RECTANGLES_TAG}>[\\s\\S]*?</${GATINGML_RECTANGLES_TAG}>`), "");
  const back = onlyRectangle(importInto(sample, xml).gates);
  const raw = (g: PolyRectGate) => g.vertices.map(([x]) => sample.gateToRaw(g, g.x_channel, x));
  const [a, b] = [raw(gate), raw(back)];
  return Math.abs(Math.max(...a) - Math.max(...b)) <= 1e-6 * Math.abs(Math.max(...a));
}

// ── Round trips ─────────────────────────────────────────────────────────────────────────────

describe("every export brings a rectangle back holding the events on its edges", () => {
  const sample = edgeSample();
  const cytobankLogicle = cytobankWritesLogicleRight(sample);
  for (const [axis, spec] of Object.entries(AXES)) {
    for (const rule of RULES) {
      const gate = edgeGate(sample, spec, rule);
      const before = maskOf(sample, gate);

      it(`${axis}, ${rule}: the synthetic edges carry events, and the gate holds what its rule says`, () => {
        expect(Array.from(before)).toEqual(expectedMask(sample, gate));
        expect(upperEdgeEvents(sample, gate)).toBeGreaterThan(0);
        expect(count(before)).toBeGreaterThan(0);
        expect(count(before)).toBeLessThan(sample.fcs.nEvents);
        // The two rules differ on this gate exactly by the events on its upper edges.
        const other = maskOf(sample, { ...gate, bounds: rule === "closed" ? "half-open" : "closed" });
        expect(Math.abs(count(other) - count(before))).toBeGreaterThan(0);
      });

      for (const [format, roundTrip] of Object.entries(FORMATS)) {
        const knownExporterFault = axis === "logicle" && format === "Cytobank Gating-ML" && !cytobankLogicle;
        it.skipIf(knownExporterFault)(`${axis}, ${rule}: ${format}`, () => {
          const back = roundTrip(edgeSample(), gate);
          expect(back.bounds).toBe(rule);
          const after = maskOf(sample, back);
          const moved = Array.from(after).reduce((s, v, i) => s + (v !== before[i] ? 1 : 0), 0);
          expect(moved).toBe(0);
        });
      }
    }
  }
});

describe("the hierarchy CSV brings a rectangle back exactly when GateLab holds raw values as float64", () => {
  // A $DATATYPE D file, a decoded log-amplified channel or a wide integer channel: between two
  // float32 values the column holds many values, and the display rounding divides them, so the
  // raw bound written for a scale the file cannot name must be searched among doubles.
  const sample = edgeSample(true);
  it("the synthetic file holds its fluorescence as float64, with values no float32 holds", () => {
    expect(sample.rawPrecision("FL1-A")).toBe("float64");
    expect(sample.rawPrecision("FSC-A")).toBe("float32");
    const fl1 = sample.rawColumnData(sample.channels.findIndex((c) => c.key === "FL1-A"));
    expect(Array.from(fl1).some((v) => Math.fround(v) !== v)).toBe(true);
  });
  for (const axis of ["logicle", "biexponential (FlowJo)", "log (Gating-ML flog)", "log (FlowJo)"]) {
    for (const rule of RULES) {
      it(`${axis}, ${rule}`, () => {
        const gate = edgeGate(sample, AXES[axis], rule);
        const before = maskOf(sample, gate);
        expect(count(before)).toBeGreaterThan(0);
        const back = FORMATS["hierarchy CSV"](edgeSample(true), gate);
        expect(back.bounds).toBe(rule);
        const after = maskOf(sample, back);
        const moved = Array.from(after).reduce((n, v, i) => n + (v !== before[i] ? 1 : 0), 0);
        expect(moved).toBe(0);
      });
    }
  }
});

describe("a rectangle whose lower edge lies at or near display 0 comes back exactly", () => {
  // Where a log or logicle display nears 0, the transform and its inverse lose digits: flog's
  // forward(inverse(1e-12)) is 9.9987e-13, and every flog value below 0 comes back as 0. GateLab's
  // record must still be recognised as the file's own there, or the file's rounded bounds decide
  // the events on the other edges.
  const sample = edgeSample();
  const cytobankLogicle = cytobankWritesLogicleRight(sample);
  const LOWS = [0, 1e-12, 1e-6, 0.003, -1e-9, -0.05];
  for (const axis of ["logicle", "log (Gating-ML flog)"]) {
    for (const lo of LOWS) {
      for (const rule of RULES) {
        const gate = edgeGate(sample, AXES[axis], rule);
        const ys = gate.vertices.map((v) => v[1]);
        const x1 = Math.max(...gate.vertices.map((v) => v[0]));
        gate.vertices = [[lo, Math.min(...ys)], [x1, Math.min(...ys)], [x1, Math.max(...ys)], [lo, Math.max(...ys)]];
        const before = maskOf(sample, gate);
        for (const format of ["standard Gating-ML", "Cytobank Gating-ML", "FlowJo workspace"]) {
          const knownExporterFault = axis === "logicle" && format === "Cytobank Gating-ML" && !cytobankLogicle;
          it.skipIf(knownExporterFault)(`${axis}, lower x bound ${lo}, ${rule}: ${format}`, () => {
            expect(count(before)).toBeGreaterThan(0);
            const back = FORMATS[format](edgeSample(), gate);
            expect(back.bounds).toBe(rule);
            if (format !== "FlowJo workspace") expect(back.vertices).toEqual(gate.vertices);
            const moved = Array.from(maskOf(sample, back)).reduce((n, v, i) => n + (v !== before[i] ? 1 : 0), 0);
            expect(moved).toBe(0);
          });
        }
      }
    }
  }

  // A zero-width rectangle at the floor of a log axis, where every value below the floor is piled:
  // closed, it holds them all; half-open, none. Written with no lower bound, as an edge at a
  // clamp is for the events beyond it, the half-open one would hold them all.
  for (const axis of ["log (Gating-ML flog)", "log (FlowJo)"]) {
    for (const rule of RULES) {
      const base = edgeGate(sample, AXES[axis], rule);
      const ys = base.vertices.map((v) => v[1]);
      const flat: PolyRectGate = { ...base, vertices: [[0, Math.min(...ys)], [0, Math.min(...ys)], [0, Math.max(...ys)], [0, Math.max(...ys)]] };
      const before = maskOf(sample, flat);
      for (const format of ["standard Gating-ML", "Cytobank Gating-ML", "FlowJo workspace"]) {
        it(`${axis}, zero width at the floor, ${rule}: ${format}`, () => {
          expect(count(before) > 0).toBe(rule === "closed");
          const back = FORMATS[format](edgeSample(), flat);
          const moved = Array.from(maskOf(sample, back)).reduce((n, v, i) => n + (v !== before[i] ? 1 : 0), 0);
          expect(moved).toBe(0);
        });
      }
    }
  }
});

describe("a rectangle whose edges lie one double step off its events comes back holding the same events", () => {
  // An edge drawn a hair inside or outside an event holds it or not by the smallest margin a
  // double has, far less than the 1e-13 a bound moves for another reader's rule, and a placement
  // of the file's bounds among its own events must not decide it otherwise (the Gating-ML
  // hardening branch's exactBound and tieBreak). On float64 data the events lie a double step apart.
  for (const float64 of [false, true]) {
    const sample = edgeSample(float64);
    const cytobankLogicle = cytobankWritesLogicleRight(sample);
    for (const [axis, spec] of Object.entries(AXES)) {
      for (const rule of RULES) {
        for (const shift of ["in", "out"] as const) {
          const gate = edgeGate(sample, spec, rule);
          const xs = gate.vertices.map((v) => v[0]);
          const ys = gate.vertices.map((v) => v[1]);
          const k = shift === "in" ? 1 : -1;
          const [x0, x1] = [stepDouble(Math.min(...xs), k), stepDouble(Math.max(...xs), -k)];
          const [y0, y1] = [stepDouble(Math.min(...ys), k), stepDouble(Math.max(...ys), -k)];
          gate.vertices = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
          const before = maskOf(sample, gate);
          for (const format of ["standard Gating-ML", "Cytobank Gating-ML", "FlowJo workspace"]) {
            const knownExporterFault = axis === "logicle" && format === "Cytobank Gating-ML" && !cytobankLogicle;
            it.skipIf(knownExporterFault)(`${float64 ? "float64, " : ""}${axis}, ${rule}, one step ${shift}: ${format}`, () => {
              const back = FORMATS[format](edgeSample(float64), gate);
              expect(back.bounds).toBe(rule);
              const moved = Array.from(maskOf(sample, back)).reduce((n, v, i) => n + (v !== before[i] ? 1 : 0), 0);
              expect(moved).toBe(0);
            });
          }
        }
      }
    }
  }

  it("a zero-width rectangle at an event on float64 data holds its events closed and none half-open", () => {
    // FL1-A holds 1 and the doubles a step either side of it.
    const sample = edgeSample(true);
    for (const rule of RULES) {
      const flat = { ...newGate("Flat", "rectangle", "FL1-A", "FL2-A", [[1, -5000], [1, 262143]]), space: "raw" as const, bounds: rule };
      const held = count(maskOf(sample, flat));
      expect(held > 0).toBe(rule === "closed");
      for (const format of ["standard Gating-ML", "Cytobank Gating-ML", "FlowJo workspace"]) {
        const back = FORMATS[format](edgeSample(true), flat);
        expect({ format, rule, held: count(maskOf(sample, back)) }).toEqual({ format, rule, held });
      }
    }
  });
});

describe("a FlowJo workspace read as FlowJo reads it holds a rectangle's events at an edge one double off them", () => {
  // FlowJo compares a rectangle's bounds with raw values, both edges held (#349 measured it). A
  // half-open GateLab rectangle is written for it with its upper bound moved below the edge
  // (gates.ts, upperBoundForReader), by 1e-13 of the bound. A bound one double above a float32
  // event, which GateLab holds, was moved below that event too: 4203.130371093751 over events at
  // 4203.13037109375 was written as 4203.130371093331, and a reader of raw values dropped them
  // (the release candidate's verifier: 405 events of 6 populations). Read here without GateLab's
  // record, as FlowJo reads the file.
  const sample = edgeSample();
  const axes: [string, TransformSpec | null][] = [["linear", null], ["identity", { kind: "identity" }]];
  for (const [axis, spec] of axes) {
    for (const rule of RULES) {
      for (const shift of ["in", "out"] as const) {
        it(`${axis}, ${rule}, one step ${shift}`, () => {
          const gate = edgeGate(sample, spec, rule);
          const xs = gate.vertices.map((v) => v[0]);
          const ys = gate.vertices.map((v) => v[1]);
          const k = shift === "in" ? 1 : -1;
          const [x0, x1] = [stepDouble(Math.min(...xs), k), stepDouble(Math.max(...xs), -k)];
          const [y0, y1] = [stepDouble(Math.min(...ys), k), stepDouble(Math.max(...ys), -k)];
          gate.vertices = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
          const before = maskOf(sample, gate);
          expect(count(before)).toBeGreaterThan(0);
          const { xml } = exportFlowJoWorkspace({
            samples: [{ sample, fileName: "edges.fcs", ...treeOf(gate) }], now: new Date("2026-09-24T00:00:00Z"), producer: "GateLab test",
          });
          const asFlowJo = xml.replace(new RegExp(` ${WSP_RECTANGLE_ATTR}="[^"]*"`), "");
          expect(asFlowJo).not.toBe(xml);
          const flowjo = onlyRectangle(importInto(sample, flowJoWorkspaceToGatingML(asFlowJo, 0, null).gatingMl).gates);
          expect(flowjo.bounds).toBe("closed");
          const moved = Array.from(maskOf(sample, flowjo)).reduce((n, v, i) => n + (v !== before[i] ? 1 : 0), 0);
          expect(moved).toBe(0);
        });
      }
    }
  }
});

describe("the hierarchy CSV keeps a closed rectangle that holds no value of the column empty", () => {
  // A closed range between the display values of two neighbouring float32 raw values holds no
  // value a float32 column can hold, so it has no raw equivalent: float32Bounds.ts returns rawLo
  // above rawHi, and a range "lo..hi" written from those with its ends swapped holds both.
  /** A file whose FL1-A and FL2-A hold these raw values, every pairing of them. */
  const valuesSample = (vals: number[]): Sample => {
    const n = vals.length * vals.length;
    const cols = [0, 1, 2, 3, 4].map(() => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      cols[2][i] = vals[i % vals.length];
      cols[3][i] = vals[Math.floor(i / vals.length)];
      cols[4][i] = i;
    }
    const bytes = writeFcs(cols, [
      { name: "FSC-A", desc: "" }, { name: "SSC-A", desc: "" },
      { name: "FL1-A", desc: "" }, { name: "FL2-A", desc: "" }, { name: "Time", desc: "" },
    ]);
    return new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  };
  for (const axis of ["arcsinh", "logicle", "biexponential (FlowJo)", "log (Gating-ML flog)", "log (FlowJo)"]) {
    it(`${axis}: a zero-width closed range between the display values of neighbouring raw values`, () => {
      const t = transformFromSpec(AXES[axis]!);
      const display = (raw: number) => Math.fround(t.forward(raw));
      // Neighbouring float32 raw values whose display values differ, near each of these (above
      // the floor of both log axes, where every value below it displays alike).
      const pairs = [30, 1500, 4096.5, 65536].map((v) => {
        let a = Math.fround(v);
        for (let i = 0; i < 1000 && display(a) === display(stepFloat32(a, 1)); i++) a = stepFloat32(a, 1);
        expect(display(a)).toBeLessThan(display(stepFloat32(a, 1)));
        return [a, stepFloat32(a, 1)];
      });
      const sample = valuesSample([...new Set([-500, 0, 262143, ...pairs.flat()].map(Math.fround))]);
      for (const [a, b] of pairs) {
        const base = edgeGate(sample, AXES[axis], "closed");
        const mid = (display(a) + display(b)) / 2;
        const gate: PolyRectGate = {
          ...base,
          vertices: [[mid, display(-500)], [mid, display(-500)], [mid, display(262143)], [mid, display(262143)]],
        };
        expect(count(maskOf(sample, gate))).toBe(0);
        const back = FORMATS["hierarchy CSV"](sample, gate);
        expect({ between: [a, b], held: count(maskOf(sample, back)) }).toEqual({ between: [a, b], held: 0 });
      }
    });
  }
});




describe("every bound is written as the double it is", () => {
  // A float32 event value can need 16 or 17 significant digits as a double: float32(7.1) is
  // 7.099999904632568. Written to 15 (7.09999990463257, above it) a lower bound on it left the
  // event outside for every reader of the geometry alone: 86 events in the standard format with
  // GateLab's records gone, and 332 in a FlowJo workspace (third edge verifier, on
  // fix/gate-edge-semantics). Written in full, as fmtNum writes since fix/gatingml-hardening, and
  // with only the upper bound moved for the reader whose rule is not the rectangle's
  // (forEveryReader), the events on every edge are held on raw axes of float32 data by a reader of
  // either rule.
  const long = [7.1, -3.3, 1000 / 3, 12345.678].map(Math.fround);
  const vals = [...new Set([-500, 0, 1, 7, 30, 900, 40000, 262143, ...long.flatMap((v) => [stepFloat32(v, -1), v, stepFloat32(v, 1)])].map(Math.fround))];
  const n = vals.length * vals.length;
  const cols = [0, 1, 2, 3, 4].map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    cols[2][i] = vals[i % vals.length];
    cols[3][i] = vals[Math.floor(i / vals.length)];
    cols[4][i] = i;
  }
  const bytes = writeFcs(cols, [
    { name: "FSC-A", desc: "" }, { name: "SSC-A", desc: "" },
    { name: "FL1-A", desc: "" }, { name: "FL2-A", desc: "" }, { name: "Time", desc: "" },
  ]);
  const sample = new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  const [x0, y0, x1, y1] = long;
  const box = (bounds: RectangleBounds): PolyRectGate => ({
    ...newGate("Box", "rectangle", "FL1-A", "FL2-A", [[x0, y0], [x1, y1]]), space: "raw", bounds,
  });
  const cytobankAbout = "<data-type:custom_info><cytobank><about>Gating-ML 2.0 export of Cytobank experiment number 1.</about></cytobank></data-type:custom_info>";

  for (const rule of RULES) {
    it(`${rule}: Gating-ML and FlowJo workspace files read without GateLab's records hold the events on every edge`, () => {
      const gate = box(rule);
      const expected = Array.from(maskOf(sample, gate));
      // Events on each edge, lower edges included, and the edges' values need more than 15 digits.
      const fx = sample.rawColumnData(sample.index("FL1-A")!);
      const fy = sample.rawColumnData(sample.index("FL2-A")!);
      expect(Array.from(fx).filter((v) => v === x0).length).toBeGreaterThan(0);
      expect(Array.from(fy).filter((v) => v === y0).length).toBeGreaterThan(0);
      for (const v of [x0, y0, x1]) expect(Number(v.toPrecision(15))).not.toBe(v);
      for (const format of ["standard", "cytobank"] as const) {
        const xml = exportGatingML({ ...treeOf(gate), sample, format, timestamp: "t" });
        expect(xml).toContain(`gating:min="${x0}"`);
        expect(xml).toContain(`gating:min="${y0}"`);
        const bare = xml.replace(/<data-type:custom_info>[\s\S]*?<\/data-type:custom_info>/g, "");
        const cytobank = bare.replace(/(<gating:Gating-ML\b[^>]*>)/, `$1${cytobankAbout}`);
        for (const [reader, text] of [["half-open", bare], ["closed", cytobank]] as const) {
          const back = onlyRectangle(importInto(sample, text).gates);
          expect(back.bounds).toBe(reader);
          expect({ format, reader, held: Array.from(maskOf(sample, back)) }).toEqual({ format, reader, held: expected });
        }
      }
      const { xml } = exportFlowJoWorkspace({
        samples: [{ sample, fileName: "edges.fcs", ...treeOf(gate) }], now: new Date("2026-09-24T00:00:00Z"), producer: "GateLab test",
      });
      expect(xml).toContain(`gating:min="${x0}"`);
      const asFlowJo = xml.replace(new RegExp(` ${WSP_RECTANGLE_ATTR}="[^"]*"`, "g"), "");
      const flowjo = onlyRectangle(importInto(sample, flowJoWorkspaceToGatingML(asFlowJo, 0, null).gatingMl).gates);
      expect(flowjo.bounds).toBe("closed");
      expect(Array.from(maskOf(sample, flowjo))).toEqual(expected);
    });
  }
});

// ── What each file keeps meaning ────────────────────────────────────────────────────────────

describe("files written before rectangles carried a rule keep their meaning", () => {
  const sample = edgeSample();

  it("a Gating-ML file GateLab wrote before the rule was recorded reads closed", () => {
    // GateLab 0.8.3 wrote exactly this, less the record and the file's rule: the about line and
    // the scales block.
    const gate = edgeGate(sample, null, "closed");
    const xml = exportGatingML({ ...treeOf(gate), sample, format: "standard", timestamp: "t" });
    const old = withoutRecords(xml).replace(new RegExp(`\\s*<${GATINGML_EDGE_RULE_TAG}>[^<]*</${GATINGML_EDGE_RULE_TAG}>`), "")
      .replace(/gating:max="([^"]+)"/g, (_, v) => `gating:max="${Math.round(Number(v) * 1e6) / 1e6}"`);
    expect(old).not.toContain(GATINGML_RECTANGLES_TAG);
    expect(old).not.toContain(GATINGML_EDGE_RULE_TAG);
    const doc = new DOMParser().parseFromString(old, "application/xml");
    expect(gatingMLWriter(doc.documentElement)).toBe("gatelab");
    const back = onlyRectangle(importInto(sample, old).gates);
    expect(back.bounds).toBe("closed");
    expect(Array.from(maskOf(sample, back))).toEqual(Array.from(maskOf(sample, gate)));
  });

  for (const format of ["standard", "cytobank"] as const) {
    for (const rule of RULES) {
      it(`a ${format} Gating-ML file GateLab writes now reads under the standard's rule when its records are lost (${rule})`, () => {
        // As a program that keeps the document's custom_info but not GateLab's records would leave
        // it: the geometry was written for a reader of either rule, and the file states the
        // standard's.
        const gate = edgeGate(sample, null, rule);
        const xml = exportGatingML({ ...treeOf(gate), sample, format, timestamp: "t" });
        expect(xml).toContain(`<${GATINGML_EDGE_RULE_TAG}>half-open</${GATINGML_EDGE_RULE_TAG}>`);
        const back = onlyRectangle(importInto(sample, withoutRecords(xml)).gates);
        expect(back.bounds).toBe("half-open");
        expect(Array.from(maskOf(sample, back))).toEqual(Array.from(maskOf(sample, gate)));
      });
    }
  }

  it("a hierarchy CSV range lo..hi holds both ends, so an integer channel keeps the events at hi", () => {
    // Time counts 0, 1, 2, ...: "Time 10..20" holds 11 values, and 20 is one of them.
    const csv = [
      "# gate: Early | rectangle | Time x FSC-A | raw | x 10..20 | y 0..10000",
      "# gate: EarlyOpen | rectangle | Time x FSC-A | raw | x 10..<20 | y 0..<10001",
      "# population: EarlyPop = Early",
      "# population: EarlyOpenPop < All Events = EarlyOpen",
      "",
    ].join("\n");
    const scheme = resolveBarcodeScheme(parseBarcodeTable(csv), sample.channels);
    expect(scheme.problems).toEqual([]);
    const built = buildBarcodeGating(scheme, bareTemplate(), sample.arcsinhCofactor, { qc: true, channels: sample.channels });
    const early = onlyRectangle(built.gates, "Early");
    const open = onlyRectangle(built.gates, "EarlyOpen");
    expect(early.bounds).toBe("closed");
    expect(open.bounds).toBe("half-open");
    expect(count(maskOf(sample, early))).toBe(11);
    expect(count(maskOf(sample, open))).toBe(10);
  });

  it("a hierarchy CSV rectangle written at another arcsinh cofactor is rescaled to the file's, as 0.8.3 read it", () => {
    // GateLab 0.8.3 wrote a rectangle at its own cofactor, 150 here, where the file displays 5,
    // and read it back rescaled to 5: the same raw values, decided in the asinh(5) column.
    expect(sample.arcsinhCofactor).toBe(5);
    const drawn = edgeGate(sample, AXES.arcsinh, "closed");
    const xs = drawn.vertices.map((v) => v[0]);
    const ys = drawn.vertices.map((v) => v[1]);
    const csv = [
      `# gate: Box | rectangle | FL1-A x FL2-A | asinh(150) | x ${Math.min(...xs)}..${Math.max(...xs)} | y ${Math.min(...ys)}..${Math.max(...ys)}`,
      "# population: BoxPop = Box",
      "",
    ].join("\n");
    const scheme = resolveBarcodeScheme(parseBarcodeTable(csv), sample.channels);
    expect(scheme.problems).toEqual([]);
    const built = buildBarcodeGating(scheme, bareTemplate(), sample.arcsinhCofactor, { qc: true, channels: sample.channels });
    const box = onlyRectangle(built.gates);
    expect(box.bounds).toBe("closed");
    // 0.8.3's reading, computed here from the raw values.
    const at5 = (v: number) => Math.asinh((Math.sinh(v) * 150) / 5);
    const [x0, x1, y0, y1] = [at5(Math.min(...xs)), at5(Math.max(...xs)), at5(Math.min(...ys)), at5(Math.max(...ys))];
    const fl1 = sample.fcs.columns[2];
    const fl2 = sample.fcs.columns[3];
    const d = (v: number) => Math.fround(Math.asinh(v / 5));
    const expected = Array.from({ length: sample.fcs.nEvents }, (_, i) =>
      (d(fl1[i]) >= x0 && d(fl1[i]) <= x1 && d(fl2[i]) >= y0 && d(fl2[i]) <= y1 ? 1 : 0));
    expect(Array.from(maskOf(sample, box))).toEqual(expected);
    // Which is not the same as holding the rectangle at 150, the rectangle as drawn.
    expect(Array.from(maskOf(sample, drawn))).not.toEqual(expected);
  });

  it("a rectangle at a cofactor other than the file's is written in raw values, which hold the same events", () => {
    const drawn = edgeGate(sample, AXES.arcsinh, "half-open");
    const tree = treeOf(drawn);
    const out = exportHierarchyCsv(Object.values(tree.gates), tree.populations, tree.root_population_id, "test", {
      context: sample, cofactor: sample.arcsinhCofactor,
    });
    expect(out.csv).toMatch(/# gate: Box \| rectangle \| FL1-A x FL2-A \| raw \| x \S+\.\.<\S+ \| y \S+\.\.<\S+/);
    expect(out.notes.join(" ")).toMatch(/cofactor 150, not this file's 5/);
  });

  it("a hierarchy CSV rectangle may not mix lo..hi and lo..<hi", () => {
    const csv = "# gate: Mixed | rectangle | Time x FSC-A | raw | x 10..<20 | y 0..10000\n# population: P = Mixed\n";
    const scheme = resolveBarcodeScheme(parseBarcodeTable(csv), sample.channels);
    expect(scheme.problems.join(" ")).toMatch(/mixes "lo\.\.hi" and "lo\.\.<hi"/);
  });
});

// ── Other programs' files ───────────────────────────────────────────────────────────────────

describe("a Gating-ML file is read under its writer's rule", () => {
  const sample = edgeSample();
  const X: [number, number] = [2000, 8000];
  const Y: [number, number] = [3000, 7000];
  const dims = `
      <gating:dimension gating:min="${X[0]}" gating:max="${X[1]}"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
      <gating:dimension gating:min="${Y[0]}" gating:max="${Y[1]}"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>`;
  /** A document with this writer's mark, as read off real files of each writer. */
  const doc = (info: string, gateAttrs = ""): string => `<gating:Gating-ML xmlns:gating="${G}" xmlns:data-type="${D}">
    ${info}
    <gating:RectangleGate gating:id="Box" ${gateAttrs}>${dims}
    </gating:RectangleGate>
  </gating:Gating-ML>`;
  const WRITERS: Record<string, { xml: string; writer: string; rule: RectangleBounds }> = {
    unidentified: { xml: doc(""), writer: "unidentified", rule: "half-open" },
    "FlowKit (writes no mark)": { xml: doc(""), writer: "unidentified", rule: "half-open" },
    flowUtils: {
      xml: doc("<data-type:custom_info><info>Gating-ML 2.0 export generated by R/flowUtils/flowCore</info><flowUtils-version>1.58.0</flowUtils-version></data-type:custom_info>"),
      writer: "flowutils", rule: "closed",
    },
    CytoML: {
      xml: doc("<data-type:custom_info><info>Gating-ML 2.0 export generated by R/flowCore/CytoML</info><CytoML-version>2.16.0</CytoML-version><cytobank><experiment_number></experiment_number></cytobank></data-type:custom_info>"),
      writer: "cytoml", rule: "closed",
    },
    Cytobank: {
      xml: doc("<data-type:custom_info><cytobank><about>Gating-ML 2.0 export of Cytobank experiment number 1.</about></cytobank></data-type:custom_info>"),
      writer: "cytobank", rule: "closed",
    },
    "FlowJo's Gating-ML export": {
      xml: doc("", 'eventsInside="1" annoOffsetX="0" annoOffsetY="0" tint="#000000" isTinted="0" lineWeight="Normal" userDefined="1"'),
      writer: "flowjo", rule: "closed",
    },
    "GateLab 0.8.3": {
      xml: doc("<data-type:custom_info><cytobank><about>Gating-ML 2.0 export from GateLab (standard / re-importable)</about></cytobank></data-type:custom_info>"),
      writer: "gatelab", rule: "closed",
    },
    "GateLabR": {
      xml: doc("<data-type:custom_info><cytobank><about>Gating-ML 2.0 export from GateLabR (standard / re-importable)</about></cytobank></data-type:custom_info>"),
      writer: "gatelab", rule: "closed",
    },
  };
  for (const [name, w] of Object.entries(WRITERS)) {
    it(`${name}: ${w.rule}`, () => {
      const root = new DOMParser().parseFromString(w.xml, "application/xml").documentElement;
      expect(gatingMLWriter(root)).toBe(w.writer);
      expect(writerRectangleBounds(gatingMLWriter(root))).toBe(w.rule);
      const gate = onlyRectangle(importInto(sample, w.xml).gates);
      expect(gate.bounds).toBe(w.rule);
      // FSC-A and SSC-A step by 1000, so the edges carry events.
      expect(count(maskOf(sample, gate))).toBe(scatterBox(sample, X, Y, w.rule));
      expect(scatterBox(sample, X, Y, "closed")).toBeGreaterThan(scatterBox(sample, X, Y, "half-open"));
    });
  }

  it("flowUtils: a zero-width rectangle holds nothing, as flowCore evaluates it; CytoML's keeps its events", () => {
    // flowCore's %in% for a rectangleGate returns FALSE for a dimension whose min equals its max,
    // and cut(include.lowest = TRUE, right = FALSE), [min, max], otherwise (flowCore 2.16
    // R/in-methods.R). cytolib, which CytoML evaluates with, keeps the events at that value.
    const flat = `
      <gating:dimension gating:min="${X[0]}" gating:max="${X[0]}"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
      <gating:dimension gating:min="${Y[0]}" gating:max="${Y[1]}"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>`;
    const atX0 = scatterBox(sample, [X[0], X[0]], Y, "closed");
    expect(atX0).toBeGreaterThan(0);
    const flowUtils = WRITERS.flowUtils.xml.replace(dims, flat);
    const cytoml = WRITERS.CytoML.xml.replace(dims, flat);
    expect(flowUtils).not.toBe(WRITERS.flowUtils.xml);
    expect(count(maskOf(sample, onlyRectangle(importInto(sample, flowUtils).gates)))).toBe(0);
    expect(count(maskOf(sample, onlyRectangle(importInto(sample, cytoml).gates)))).toBe(atX0);
    // A flowUtils rectangle of any width holds both its edges.
    expect(count(maskOf(sample, onlyRectangle(importInto(sample, WRITERS.flowUtils.xml).gates)))).toBe(scatterBox(sample, X, Y, "closed"));
  });

  it("a FlowJo workspace rectangle is closed, and only rectangles are marked", () => {
    const wsp = `<Workspace><SampleList><SampleNode name="edges.fcs" count="1"><Subpopulations>
      <Population name="Box" count="1"><Gate><gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="r1">${dims}
      </gating:RectangleGate></Gate></Population>
      <Population name="Tri" count="1"><Gate><gating:PolygonGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="p1">
        <gating:dimension><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
        <gating:dimension><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
        <gating:vertex><gating:coordinate data-type:value="0"/><gating:coordinate data-type:value="0"/></gating:vertex>
        <gating:vertex><gating:coordinate data-type:value="5000"/><gating:coordinate data-type:value="0"/></gating:vertex>
        <gating:vertex><gating:coordinate data-type:value="5000"/><gating:coordinate data-type:value="5000"/></gating:vertex>
      </gating:PolygonGate></Gate></Population>
    </Subpopulations></SampleNode></SampleList></Workspace>`;
    const conv = flowJoWorkspaceToGatingML(wsp, 0, null);
    expect(conv.gatingMl.split(WSP_RECT_BOUNDS_TAG).length - 1).toBe(2); // one open and one close tag
    const gate = onlyRectangle(importInto(sample, conv.gatingMl).gates);
    expect(gate.bounds).toBe("closed");
    expect(count(maskOf(sample, gate))).toBe(scatterBox(sample, X, Y, "closed"));
  });
});

// ── The bounds another program reads ────────────────────────────────────────────────────────

describe("the bounds written for another program's reader", () => {
  const sample = edgeSample();

  it("Cytobank format: a closed rectangle's gating:max and its definition's x2, y2 are the same numbers", () => {
    const gate = edgeGate(sample, null, "closed");
    const xml = exportGatingML({ ...treeOf(gate), sample, format: "cytobank", timestamp: "t" });
    const maxes = [...xml.matchAll(/gating:max="([^"]+)"/g)].map((m) => m[1]);
    const def = /&quot;x2&quot;:([^,]+),&quot;y2&quot;:([^}]+)\}|"x2":([^,]+),"y2":([^}]+)\}/.exec(xml)!;
    const [x2, y2] = def[1] !== undefined ? [def[1], def[2]] : [def[3], def[4]];
    expect(maxes).toEqual([x2, y2]);
    // Just above the edge, so that a reader following the standard, min <= x < max, holds it.
    const xs = gate.vertices.map((v) => v[0]);
    expect(Number(x2)).toBeGreaterThan(Math.max(...xs));
    expect(Number(x2)).toBeLessThan(Math.max(...xs) * (1 + 1e-9));
  });

  it("standard format: a closed rectangle is written just above its upper edges, a half-open one just below", () => {
    const X: [number, number] = [2000, 8000];
    const Y: [number, number] = [3000, 7000];
    const drawn = { ...newGate("Box", "rectangle", "FSC-A", "SSC-A", [[X[0], Y[0]], [X[1], Y[1]]]), space: "raw" as const, bounds: "half-open" as const };
    const boundsOf = (g: Gate, attr: string) => [...exportGatingML({ ...treeOf(g), sample, format: "standard", timestamp: "t" })
      .matchAll(new RegExp(`gating:${attr}="([^"]+)"`, "g"))].map((m) => Number(m[1]));
    const [hx, hy] = boundsOf(drawn, "max");
    expect(hx).toBeLessThan(X[1]);
    expect(hx).toBeGreaterThan(X[1] - 1e-3);
    expect(hy).toBeLessThan(Y[1]);
    expect(boundsOf(drawn, "min")).toEqual([X[0], Y[0]]);
    const [cx, cy] = boundsOf({ ...drawn, bounds: "closed" }, "max");
    expect(cx).toBeGreaterThan(X[1]);
    expect(cx).toBeLessThan(X[1] + 1e-3);
    expect(cy).toBeGreaterThan(Y[1]);
  });

  for (const format of ["standard", "cytobank"] as const) {
    for (const rule of RULES) {
      it(`${format} format, ${rule}: a reader of either rule holds the rectangle's own events, as GateLab's own records lost`, () => {
        // What flowCore, CytoML or FlowKit read: the geometry alone. Read here by GateLab as an
        // unidentified file (half-open, the standard's rule) and as a Cytobank file (closed).
        const gate = edgeGate(sample, null, rule);
        const scatter = { ...newGate("Scatter", "rectangle", "FSC-A", "SSC-A", [[2000, 3000], [8000, 7000]]), space: "raw" as const, bounds: rule };
        for (const g of [gate, scatter]) {
          const xml = exportGatingML({ ...treeOf(g), sample, format, timestamp: "t" });
          const bare = xml.replace(/<data-type:custom_info>[\s\S]*?<\/data-type:custom_info>/g, "");
          const cytobank = bare.replace(/(<gating:Gating-ML\b[^>]*>)/,
            "$1<data-type:custom_info><cytobank><about>Gating-ML 2.0 export of Cytobank experiment number 1.</about></cytobank></data-type:custom_info>");
          expect(cytobank).not.toBe(bare);
          const expected = Array.from(maskOf(sample, g));
          expect(upperEdgeEvents(sample, g)).toBeGreaterThan(0);
          for (const [reader, text] of [["half-open", bare], ["closed", cytobank]] as const) {
            const back = onlyRectangle(importInto(sample, text).gates);
            expect(back.bounds).toBe(reader);
            expect(Array.from(maskOf(sample, back))).toEqual(expected);
          }
        }
      });
    }
  }

  it("FlowJo workspace: a zero-width half-open rectangle is written with min not above max, and holds nothing", () => {
    const flat = { ...newGate("Flat", "rectangle", "FSC-A", "SSC-A", [[2000, 3000], [2000, 7000]]), space: "raw" as const, bounds: "half-open" as const };
    expect(count(maskOf(sample, flat))).toBe(0);
    const { xml } = exportFlowJoWorkspace({
      samples: [{ sample, fileName: "edges.fcs", ...treeOf(flat) }], now: new Date("2026-09-24T00:00:00Z"), producer: "GateLab test",
    });
    for (const m of xml.matchAll(/gating:min="([^"]+)" gating:max="([^"]+)"/g)) {
      expect(Number(m[1])).toBeLessThanOrEqual(Number(m[2]));
    }
    const back = onlyRectangle(importInto(sample, flowJoWorkspaceToGatingML(xml, 0, null).gatingMl).gates);
    expect(count(maskOf(sample, back))).toBe(0);
    // As FlowJo reads it, without GateLab's record: still nothing.
    const asFlowJo = xml.replace(new RegExp(` ${WSP_RECTANGLE_ATTR}="[^"]*"`), "");
    const flowjo = onlyRectangle(importInto(sample, flowJoWorkspaceToGatingML(asFlowJo, 0, null).gatingMl).gates);
    expect(flowjo.bounds).toBe("closed");
    expect(count(maskOf(sample, flowjo))).toBe(0);
  });

  it("FlowJo workspace: as FlowJo reads it, a half-open rectangle's upper-edge events stay out", () => {
    // Raw values on linear scatter axes, which FlowJo compares directly.
    const X: [number, number] = [2000, 8000];
    const Y: [number, number] = [3000, 7000];
    const drawn = { ...newGate("Box", "rectangle", "FSC-A", "SSC-A", [[X[0], Y[0]], [X[1], Y[1]]]), space: "raw" as const, bounds: "half-open" as const };
    const { xml } = exportFlowJoWorkspace({
      samples: [{ sample, fileName: "edges.fcs", ...treeOf(drawn) }], now: new Date("2026-09-24T00:00:00Z"), producer: "GateLab test",
    });
    const asFlowJo = xml.replace(new RegExp(` ${WSP_RECTANGLE_ATTR}="[^"]*"`), "");
    const flowjo = onlyRectangle(importInto(sample, flowJoWorkspaceToGatingML(asFlowJo, 0, null).gatingMl).gates);
    expect(flowjo.bounds).toBe("closed");
    expect(Array.from(maskOf(sample, flowjo))).toEqual(Array.from(maskOf(sample, drawn)));
    expect(count(maskOf(sample, drawn))).toBe(scatterBox(sample, X, Y, "half-open"));
  });

  it("GateLab's record never moves a rectangle: a record whose bounds are not the file's is not restored", () => {
    // As an exporter that wrote the geometry wrongly would leave it: the file's numbers as
    // written, the record's own bounds elsewhere. GateLab reads the file's geometry, under the
    // recorded rule, so its own reading shows the fault instead of hiding it.
    const gate = edgeGate(sample, null, "half-open");
    const xml = exportGatingML({ ...treeOf(gate), sample, format: "standard", timestamp: "t" });
    const xs = gate.vertices.map((v) => v[0]);
    const moved = xml.replace(/&quot;x&quot;:\[([^,]+),/, (_, lo) => `&quot;x&quot;:[${Number(lo) - 100},`)
      .replace(/"x":\[([^,]+),/, (_, lo) => `"x":[${Number(lo) - 100},`);
    expect(moved).not.toBe(xml);
    const back = onlyRectangle(importInto(sample, moved).gates);
    expect(back.bounds).toBe("half-open");
    expect(Math.min(...back.vertices.map((v) => v[0]))).toBe(Math.min(...xs));
    const restored = onlyRectangle(importInto(sample, xml).gates);
    expect(restored.vertices).toEqual(gate.vertices);
  });

  for (const format of ["standard", "cytobank"] as const) {
    it(`${format} format: a zero-width closed rectangle keeps its lower bound, so a standard reader holds its events`, () => {
      // FSC-A steps by 1000, so x = 2000 holds events; only the upper bound may move.
      const flat = { ...newGate("Flat", "rectangle", "FSC-A", "SSC-A", [[2000, 3000], [2000, 7000]]), space: "raw" as const, bounds: "closed" as const };
      const held = count(maskOf(sample, flat));
      expect(held).toBe(scatterBox(sample, [2000, 2000], [3000, 7000], "closed"));
      expect(held).toBeGreaterThan(0);
      const xml = exportGatingML({ ...treeOf(flat), sample, format, timestamp: "t" });
      const mins = [...xml.matchAll(/gating:min="([^"]+)"/g)].map((m) => Number(m[1]));
      expect(mins).toEqual([2000, 3000]);
      // As a program following the standard reads it: GateLab's own marks and record removed.
      const bare = xml.replace(/<data-type:custom_info>[\s\S]*?<\/data-type:custom_info>/g, "");
      const asStandard = onlyRectangle(importInto(sample, bare).gates);
      expect(asStandard.bounds).toBe("half-open");
      expect(count(maskOf(sample, asStandard))).toBe(held);
    });
  }

  it("Gating-ML: a record is not restored over a lower bound moved by as little as the reader's shift", () => {
    // An exporter that moved a lower bound by 1e-13 of itself, as the zero-width case once did,
    // with the record's copy of the written bounds moved alike: GateLab reads the file's own
    // geometry, so the fault shows in its reading of the file instead of being covered.
    const gate = { ...newGate("Box", "rectangle", "FSC-A", "SSC-A", [[2000, 3000], [8000, 7000]]), space: "raw" as const, bounds: "closed" as const };
    const xml = exportGatingML({ ...treeOf(gate), sample, format: "standard", timestamp: "t" });
    const moved = String(2000 * (1 + 1e-13));
    expect(Number(moved)).not.toBe(2000);
    const faulty = xml.replace('gating:min="2000"', `gating:min="${moved}"`)
      .replace(/(&quot;written&quot;:\[&quot;)2000\|/, `$1${moved}|`)
      .replace(/("written":\[")2000\|/, `$1${moved}|`);
    expect(faulty).toContain(`gating:min="${moved}"`);
    expect(faulty.split(moved).length - 1).toBe(2);
    const back = onlyRectangle(importInto(sample, faulty).gates);
    expect(back.bounds).toBe("closed");
    expect(Math.min(...back.vertices.map((v) => v[0]))).toBe(Number(moved));
    // The file as GateLab wrote it is restored.
    const restored = onlyRectangle(importInto(sample, xml).gates);
    expect(restored.vertices).toEqual([[2000, 3000], [8000, 3000], [8000, 7000], [2000, 7000]]);
  });

  it("FlowJo workspace: a record is not restored over a lower bound moved by as little as the reader's shift", () => {
    const gate = { ...newGate("Box", "rectangle", "FSC-A", "SSC-A", [[2000, 3000], [8000, 7000]]), space: "raw" as const, bounds: "half-open" as const };
    const { xml } = exportFlowJoWorkspace({
      samples: [{ sample, fileName: "edges.fcs", ...treeOf(gate) }], now: new Date("2026-09-24T00:00:00Z"), producer: "GateLab test",
    });
    const moved = String(2000 * (1 + 1e-13));
    const faulty = xml.replace('gating:min="2000"', `gating:min="${moved}"`)
      .replace(/(&quot;written&quot;:\[&quot;)2000\|/, `$1${moved}|`);
    expect(faulty.split(moved).length - 1).toBe(2);
    const back = onlyRectangle(importInto(sample, flowJoWorkspaceToGatingML(faulty, 0, null).gatingMl).gates);
    // Read as FlowJo's own rectangle: closed, at the file's bounds.
    expect(back.bounds).toBe("closed");
    expect(Math.min(...back.vertices.map((v) => v[0]))).toBe(Number(moved));
    const restored = onlyRectangle(importInto(sample, flowJoWorkspaceToGatingML(xml, 0, null).gatingMl).gates);
    expect(restored.bounds).toBe("half-open");
    expect(restored.vertices).toEqual([[2000, 3000], [8000, 3000], [8000, 7000], [2000, 7000]]);
  });

  it("GateLab's record gives way when the file's bounds were changed after GateLab wrote them", () => {
    const gate = edgeGate(sample, null, "half-open");
    const xml = exportGatingML({ ...treeOf(gate), sample, format: "standard", timestamp: "t" });
    // Another program moves the rectangle's lower x bound and keeps GateLab's custom_info.
    const edited = xml.replace(/gating:min="([^"]+)"/, 'gating:min="-1000"');
    const back = onlyRectangle(importInto(sample, edited).gates);
    expect(back.bounds).toBe("half-open");
    expect(Math.min(...back.vertices.map((v) => v[0]))).toBe(-1000);
  });
});

describe("a reader in double precision holds the exporting file's own events on a transformed axis", () => {
  // FlowKit computes a dimension's transform in double precision from the raw value; GateLab decides
  // an event on its transformed value in single precision. The written bound is placed among the
  // file's own events so that the two agree (gatingmlExport.ts, tieBreak). Where GateLab reading
  // the file back without its record, in single precision on the WRITTEN scale, could not be met as
  // well -- FlowJo's log is written as flog one decade up, whose single-precision values are eight
  // times coarser than the gate's own -- the bound was left where it was, and FlowKit decided the
  // events on it the other way: 45 of a closed and 198 of a half-open FlowJo log rectangle here.
  // Edge candidates as the edge verifier's files carry them, each with two float32 steps either side.
  const candidates = [
    -137.5, -3.3, 0, 0.015625, 1, 2.75, 7.1, 100.3, 1000 / 3, 1000, 4096.5, 12345.678, 131071.5, 200000, 262143, 262144, 300000,
  ].map(Math.fround);
  const vals = [...new Set(candidates.flatMap((v) => (v === 0 ? [0] : [-2, -1, 0, 1, 2].map((k) => (k ? stepFloat32(v, k) : v)))))];
  const n = vals.length * vals.length;
  const cols = [0, 1, 2, 3, 4].map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    cols[2][i] = vals[i % vals.length];
    cols[3][i] = vals[Math.floor(i / vals.length)];
    cols[4][i] = i;
  }
  const bytes = writeFcs(cols, [
    { name: "FSC-A", desc: "" }, { name: "SSC-A", desc: "" },
    { name: "FL1-A", desc: "" }, { name: "FL2-A", desc: "" }, { name: "Time", desc: "" },
  ]);
  const sample = new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
  const rawX = sample.rawColumnData(sample.index("FL1-A")!);
  const rawY = sample.rawColumnData(sample.index("FL2-A")!);
  const f = Math.fround;
  // The edge verifier's rectangles, x and y edges as raw values of events.
  const boxes: [number, number][][] = [
    [[1, 4096.5], [0.015625, 262143]],
    [[2.75, 131071.5], [1, 131071.5]],
    [[0.015625, 300000], [f(-3.3), f(12345.678)]],
    [[f(100.3), 262144], [f(1000 / 3), 200000]],
    [[1, 1000], [f(7.1), 300000]],
  ];
  const axes: Record<string, TransformSpec> = {
    "arcsinh, cofactor 5": { kind: "asinh", cofactor: 5 },
    "arcsinh, cofactor 150": { kind: "asinh", cofactor: 150 },
    "log (Gating-ML flog)": { kind: "flog", T: 262144, M: 4.5 },
    "log (FlowJo)": { kind: "wsplog", offset: 1, decades: 5 },
  };
  const TR = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";
  /** The standard file as a double-precision reader holds it: flog and fasinh as Gating-ML 2.0 defines them. */
  const readInDouble = (xml: string): Uint8Array => {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const transforms = new Map<string, (x: number) => number>();
    for (const t of Array.from(doc.getElementsByTagNameNS(TR, "transformation"))) {
      const el = t.firstElementChild!;
      const p = (a: string) => Number(el.getAttributeNS(TR, a) || 0);
      const [T, M, A] = [p("T"), p("M"), p("A")];
      transforms.set(t.getAttributeNS(TR, "id")!, el.localName === "flog"
        ? (x) => (1 / M) * Math.log10(x / T) + 1
        : (x) => (Math.asinh((x * Math.sinh(M * Math.LN10)) / T) + A * Math.LN10) / ((M + A) * Math.LN10));
    }
    const dims = Array.from(doc.getElementsByTagNameNS(G, "dimension")).map((d) => {
      const tr = d.getAttributeNS(G, "transformation-ref");
      const min = d.getAttributeNS(G, "min");
      const max = d.getAttributeNS(G, "max");
      return {
        fn: tr ? transforms.get(tr)! : (x: number) => x,
        min: min === null || min === "" ? -Infinity : Number(min),
        max: max === null || max === "" ? Infinity : Number(max),
      };
    });
    expect(dims).toHaveLength(2);
    const within = (d: (typeof dims)[number], x: number) => { const y = d.fn(x); return y >= d.min && y < d.max; };
    return Uint8Array.from({ length: n }, (_, i) => (within(dims[0], rawX[i]) && within(dims[1], rawY[i]) ? 1 : 0));
  };

  for (const [label, spec] of Object.entries(axes)) {
    for (const rule of RULES) {
      it(`${label}, ${rule}: the standard file's bounds decide every edge event as GateLab does`, () => {
        const base = newGate("R", "rectangle", "FL1-A", "FL2-A", [[0, 0], [1, 1]]);
        const probe: PolyRectGate = { ...base, space: "display", transforms: { "FL1-A": spec, "FL2-A": spec }, bounds: rule };
        const c = columnsForGate(sample.gateAssayData(), probe);
        const at = (col: ArrayLike<number>, raw: ArrayLike<number>, v: number) => {
          for (let i = 0; i < raw.length; i++) if (raw[i] === v) return col[i];
          throw new Error(`no event at ${v}`);
        };
        let differ = 0;
        const rows: string[] = [];
        for (const [[x0, x1], [y0, y1]] of boxes) {
          const fx = c.column("FL1-A")!;
          const fy = c.column("FL2-A")!;
          const gate: PolyRectGate = {
            ...probe, gate_id: `${probe.gate_id}-${x0}-${y0}`,
            vertices: [[at(fx, rawX, x0), at(fy, rawY, y0)], [at(fx, rawX, x1), at(fy, rawY, y1)]],
          };
          const mine = maskOf(sample, gate);
          expect(count(mine)).toBeGreaterThan(0);
          const theirs = readInDouble(exportGatingML({ ...treeOf(gate), sample, format: "standard", timestamp: "t" }));
          let d = 0;
          for (let i = 0; i < n; i++) if (mine[i] !== theirs[i]) d++;
          if (d) rows.push(`x ${x0}..${x1}, y ${y0}..${y1}: ${d}`);
          differ += d;
        }
        expect({ differ, rows }).toEqual({ differ: 0, rows: [] });
      });
    }
  }
});
