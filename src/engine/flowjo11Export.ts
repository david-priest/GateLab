// flowjo11Export.ts — writing a FlowJo 11 workbench (.flowjo).
//
// The format is the one flowjo11Workbench.ts reads, established from FlowJo 11.2.0's own saved
// workbenches only (LabNotes: "GateLab — FlowJo 11 workbench (.flowjo) format, clean-room notes
// (2026-10-22)"); no FlowJo code was read. A workbench is a zip of JSON holding one analysis: a
// graph of nodes keyed by uuid, each linked to its parents and children by collection. This module
// writes every node FlowJo 11 writes for a new workbench (the three default groups, the parameter
// sets, the table, chart and report, one cytometer per instrument), so that the file FlowJo opens
// differs from one it saved itself only in the gates and samples GateLab put there.
//
// Why a workbench and not a .wsp: FlowJo 11 opens a FlowJo 10 workspace, but rounds every gate
// vertex down to its 256-channel display, which moved 12 of 13 populations of a GateLab .wsp by 1 to
// 113 events and one to 0. A workbench stores each vertex in the display units of its gate's own
// axis, at full precision, so nothing is rounded on the way in.
//
// The model, and how GateLab's is mapped onto it:
//
//   • A gate is defined once (populationDefinitions), for the Experiment Data group, and every
//     sample has one population of it (populations) holding that sample's count. GateLab's files
//     share one tree and may tailor a gate's coordinates; a file's tailored gate is that sample's
//     entry in the gate's desyncTable, a complete gate of its own, as FlowJo 11 writes a gate
//     adjusted in one sample. Files gated under trees of different structure cannot share one set
//     of definitions and are refused with the files named.
//   • Every gate stores its own axis per parameter (Linear, Log or Biex) and its vertices in that
//     axis's display units, 0 to 256. A gate whose space is one of these axes (a FlowJo grid gate,
//     a FlowJo biex or log gate, a raw gate on a linear axis) is written exactly. A polygon or an
//     ellipse in any other space (logicle, arcsinh, an older biex table) is written as its boundary
//     traced on an axis FlowJo 11 has, to within 1% of a display channel, and named.
//   • Quadrants: a straight crosshair is FlowJo 11's quad, its arms through the centre; FlowJo 11's
//     own curl is its curlyQuad. GateLab numbers quadrants 1 to 4 as Q1 (x−, y+), Q2 (x+, y+), Q3
//     (x+, y−), Q4 (x−, y−); FlowJo 11 numbers a quad's populations 0 to 3 as Q4, Q3, Q1, Q2.
//   • NOT and AND are FlowJo 11's not and and populations, which link the populations they combine
//     rather than gates: a NOT links its operand and counts the operand's parent without it, an AND
//     links each operand. Where GateLab's tree has no population holding a gate a NOT or an AND
//     uses, one is added beside it and named.
//   • Compensation: a sample compensated in GateLab links the matrix it is compensated with (a
//     spillover-matrix platform), and its gates on compensated channels name the `Comp-` parameter.
//   • Time is written in seconds, `$TIMESTEP` applied, as FlowJo 11 shows it.
//
// What FlowJo 11 requires of a workbench beyond what it writes is not documented; the fields it
// writes are written here, with the stored results (counts, keywords, parameters) GateLab knows.
// The sample hash FlowJo 11 stores is left out: its input is not known.

import { strToU8, zipSync } from "fflate";
import type { Sample } from "./sample";
import { isUnbounded, type EllipseGate, type Gate, type GateRef, type PolyRectGate, type Population, type PopulationMap, type QuadrantGate, type TransformSpec, type Vertex } from "./models";
import { FLOWJO_BIEX_TABLE_CHANNELS, biexBreakpoints } from "./biex";
import { flowJoGridScale, type FlowJoGridScale, type FlowJoGridSpec } from "./flowjoGrid";
import { axesFromCovariance, ellipseBoundary } from "./ellipse";
import { applyGatingStrategy } from "./populations";
import { columnsForGate, getGateMask } from "./gates";
import { strategyStructureKey } from "./tailoredImport";
import { isScatterChannel } from "./transforms";
import { FLOWJO11_CURLY_QUAD_CURL } from "./flowjo11Workbench";

/** One loaded file and the tree it is gated under. */
export interface FlowJo11ExportSample {
  sample: Sample;
  /** The FCS file's name, as FlowJo 11 will look for it in `fcsFolder`. */
  fileName: string;
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string;
}

export interface FlowJo11ExportOpts {
  samples: FlowJo11ExportSample[];
  /**
   * The folder the FCS files are in on the computer that will open the workbench, as an absolute
   * path: FlowJo 11 stores each sample's absolute path and looks for the file there.
   */
  fcsFolder: string;
  /** The workbench's name, as FlowJo 11 shows it. */
  name: string;
  /** Makes the node ids; random uuids unless given (tests give a deterministic one). */
  uuid?: () => string;
}

export interface FlowJo11ExportResult {
  bytes: Uint8Array;
  /** The analysis document, as written. */
  analysis: Record<string, unknown>;
  /** Everything approximated, added or left out, in the order met. */
  warnings: string[];
  /** Each sample's count per population, by GateLab population id, as written. */
  counts: Array<Record<string, number>>;
}

type Json = Record<string, unknown>;

/** FlowJo 11's display: every axis spans 256 units. */
const DISPLAY = 256;
/** How far a traced boundary may stray from the true one, in display units. */
const TRACE_TOLERANCE = 0.01;
/** Where an edge with no bound is written: beyond the display, which the reader takes as open. */
const OPEN_BELOW = -DISPLAY;
const OPEN_ABOVE = 2 * DISPLAY;

const COLLECTIONS = [
  "analysisRoot", "groups", "populationDefinitions", "compoundPopulations", "populations",
  "paramsetDefinitions", "compoundParameterSets", "dataSources", "cytometers", "platforms", "reports",
] as const;
type Collection = (typeof COLLECTIONS)[number];

// ── Axes ──────────────────────────────────────────────────────────────────────────────────────

/** A FlowJo 11 axis as a gate stores it. */
type AxisJson =
  | { transformType: "Linear"; minRange: number; maxRange: number }
  | { transformType: "Log"; decadesOffset: number; numberDecades: number; shift: number; negate: boolean }
  | { transformType: "Biex"; T: number; A: number; M: number; W: number; vectorLength: number; autoWidthBasis: boolean };

interface Fj11Axis {
  json: AxisJson;
  /** File value (raw; seconds for Time) → display units, unrounded. */
  display(v: number): number;
  /** The file values the axis can place a vertex at: a biex axis stops at its table's ends. */
  holds(v: number): boolean;
}

function linearAxis(minRange: number, maxRange: number): Fj11Axis {
  const scale = flowJoGridScale({ kind: "flowjoChannels", channels: DISPLAY, axis: { kind: "linear", minRange, maxRange }, rule: "flowjo11" });
  return { json: { transformType: "Linear", minRange, maxRange }, display: scale.vertexCell, holds: () => true };
}

function logAxis(offset: number, decades: number): Fj11Axis {
  const scale = flowJoGridScale({ kind: "flowjoChannels", channels: DISPLAY, axis: { kind: "wsplog", offset, decades }, rule: "flowjo11" });
  return {
    json: { transformType: "Log", decadesOffset: offset, numberDecades: decades, shift: 0, negate: false },
    display: scale.vertexCell,
    holds: (v) => v > 0,
  };
}

function biexAxis(p: { maxValue: number; pos: number; neg: number; widthBasis: number; channelRange: number }): Fj11Axis {
  const scale: FlowJoGridScale = flowJoGridScale({ kind: "flowjoChannels", channels: p.channelRange, axis: { kind: "biex", ...p }, rule: "flowjo11" });
  const { raw } = biexBreakpoints({ ...p, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS });
  const lo = raw[0];
  const hi = raw[raw.length - 1];
  return {
    json: { transformType: "Biex", T: p.maxValue, A: p.neg, M: p.pos, W: p.widthBasis, vectorLength: p.channelRange, autoWidthBasis: false },
    display: scale.vertexCell,
    holds: (v) => v >= lo && v <= hi,
  };
}

/**
 * The FlowJo 11 axis a GateLab space is, with the map from that space's coordinates to its display
 * units, when the two are one up to scale: then a polygon straight in the space is straight on the
 * axis, and an ellipse is an ellipse. Null for a space FlowJo 11 has no axis for.
 */
function axisOfSpace(spec: TransformSpec, fileScale: number, extent: () => [number, number]): { axis: Fj11Axis; fromSpace: (v: number) => number; scale: number } | null {
  switch (spec.kind) {
    case "identity": {
      const [lo, hi] = extent();
      const axis = linearAxis(lo, hi);
      const k = DISPLAY / (hi - lo);
      return { axis, fromSpace: (v) => (v * fileScale - lo) * k, scale: fileScale * k };
    }
    case "flowjoChannels": {
      // FlowJo's grid: the coordinates are the axis's display channels already. FlowJo 10's rule
      // puts an event on the nearest channel of a linear or log axis, FlowJo 11's on the one below
      // (flowjoGrid.ts); on FlowJo 10's axis moved down by half a channel FlowJo 11's channel is
      // FlowJo 10's, so a FlowJo 10 grid gate goes out on that axis, its coordinates half a channel
      // up to stay where they are. On a biex axis both rules put an event on the channel below.
      const a = spec.axis;
      if (spec.channels !== DISPLAY && a.kind !== "biex") return null;
      const half = spec.rule !== "flowjo11" && a.kind !== "biex" ? 0.5 : 0;
      const axis = a.kind === "linear"
        ? linearAxis(a.minRange - (half * (a.maxRange - a.minRange)) / DISPLAY, a.maxRange - (half * (a.maxRange - a.minRange)) / DISPLAY)
        : a.kind === "wsplog" ? logAxis(a.offset * Math.pow(10, (-half * a.decades) / DISPLAY), a.decades)
          : biexAxis(a);
      return { axis, fromSpace: (v) => v + half, scale: 1 };
    }
    case "biex":
      // GateLab's biex display is FlowJo's channels when it is built on FlowJo's own table.
      if (spec.tableChannels !== FLOWJO_BIEX_TABLE_CHANNELS || spec.spline) return null;
      return { axis: biexAxis(spec), fromSpace: (v) => v, scale: 1 };
    case "wsplog":
      return { axis: logAxis(spec.offset, spec.decades), fromSpace: (v) => v * DISPLAY, scale: DISPLAY };
    case "flog":
      // flog(x; T, M) is FlowJo's log with offset T·10^-M over M decades, divided by the display.
      if (spec.standard) return null;
      return { axis: logAxis(spec.T * Math.pow(10, -spec.M), spec.M), fromSpace: (v) => v * DISPLAY, scale: DISPLAY };
    default:
      return null;
  }
}

/** A linear range holding every value given, with three display channels to spare at each end. */
function fittedLinear(values: readonly number[], fallback: [number, number]): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  let lo = Math.min(fallback[0], ...finite);
  let hi = Math.max(fallback[1], ...finite);
  if (!(hi > lo)) {
    lo -= 1;
    hi += 1;
  }
  const pad = ((hi - lo) * 3) / (DISPLAY - 6);
  return lo < fallback[0] || hi > fallback[1] ? [lo - pad, hi + pad] : fallback;
}

// ── One sample's channels ─────────────────────────────────────────────────────────────────────

interface SampleChannels {
  /** GateLab channel key → the parameter name a gate on it states (`Comp-` when compensated). */
  name: Map<string, string>;
  /** GateLab channel key → the file's own parameter name. */
  pnn: Map<string, string>;
  /** GateLab raw → file value: `$TIMESTEP` on Time, else 1. */
  fileScale: (key: string) => number;
  /** The axis FlowJo 11 shows a channel on by default, for gates with no axis of their own. */
  defaultAxis: (key: string, values: readonly number[]) => Fj11Axis;
  compensated: Set<string>;
  /** GateLab channel key → the file's marker ($PnS), where it names one. */
  marker: Map<string, string>;
}

const isTime = (name: string): boolean => /^time$/i.test(name.trim());

function sampleChannels(sample: Sample, warnings: string[]): SampleChannels {
  const pnns = sample.channels.map((c) => c.pnn || c.key);
  const swapped = pnns.map((p) => p.split("/").join("_"));
  const pnn = new Map<string, string>();
  sample.channels.forEach((c, i) => {
    // FlowJo writes "/" in a parameter name as "_", unless that names another parameter of the file.
    const clash = swapped[i] !== pnns[i] && pnns.some((p, j) => j !== i && (p === swapped[i] || swapped[j] === swapped[i]));
    if (clash) warnings.push(`${pnns[i]} keeps its "/" in the workbench: ${swapped[i]} would name another parameter of the file.`);
    pnn.set(c.key, clash ? pnns[i] : swapped[i]);
  });
  const compensated = new Set(sample.instrument === "flow" && sample.compensationEnabled ? sample.spillover?.channels ?? [] : []);
  const name = new Map<string, string>();
  for (const c of sample.channels) name.set(c.key, compensated.has(c.key) ? `Comp-${pnn.get(c.key)}` : pnn.get(c.key)!);
  const step = Number(sample.fcs.keywords["$TIMESTEP"]);
  const timestep = Number.isFinite(step) && step > 0 ? step : 1;
  const channelOf = (key: string) => sample.channels.find((c) => c.key === key);
  const fileScale = (key: string) => (isTime(channelOf(key)?.pnn ?? key) ? timestep : 1);
  const defaultAxis = (key: string, values: readonly number[]): Fj11Axis => {
    const c = channelOf(key);
    const range = c && c.range > 0 ? c.range : 262144;
    if (!c || isTime(c.pnn) || isScatterChannel(c.key) || isScatterChannel(c.pnn) || sample.instrument !== "flow") {
      const top = isTime(c?.pnn ?? key) ? range * timestep : range;
      const [lo, hi] = fittedLinear(values, [0, top]);
      return linearAxis(lo, hi);
    }
    const idx = sample.channels.indexOf(c);
    const own = sample.fluorBiexParams(idx);
    const params = own && own.tableChannels === FLOWJO_BIEX_TABLE_CHANNELS && !own.spline
      ? own
      : { maxValue: range, pos: 4.5, neg: 0, widthBasis: -100, channelRange: DISPLAY };
    const biex = biexAxis(params);
    if (values.every((v) => biex.holds(v))) return biex;
    // A gate reaching below the biex table's floor goes out on a linear axis, which holds it.
    const [lo, hi] = fittedLinear(values, [Math.min(0, ...values), range]);
    return linearAxis(lo, hi);
  };
  const marker = new Map(sample.channels.filter((c) => c.marker).map((c) => [c.key, c.marker!]));
  return { name, pnn, fileScale, defaultAxis, compensated, marker };
}

// ── Gates ─────────────────────────────────────────────────────────────────────────────────────

/** A gate as FlowJo 11 stores it, without its uuid. */
type GateJson = Json & { type: string; xVertices: number[]; yVertices: number[] };

interface GateContext {
  sample: Sample;
  ch: SampleChannels;
  /** What the export could not write exactly, named for the user. */
  note: (message: string) => void;
}

/** A gate's axis: the parameter, with its marker where the file names one, and the transform. */
const axisJson = (ctx: GateContext, key: string, axis: Fj11Axis) => {
  const marker = ctx.ch.marker.get(key);
  return { parameterSpec: { name: ctx.ch.name.get(key)!, ...(marker ? { descriptiveName: marker } : {}) }, transform: axis.json };
};

/** The gate's space on one channel, as Sample.gateToRaw reads it. */
function spaceOf(sample: Sample, gate: Gate, channel: string): TransformSpec {
  if (sample.gateSpace(gate) === "raw") return { kind: "identity" };
  return gate.transforms?.[channel] ?? sample.transformSpec(channel);
}

/** A gate's coordinates on one of its channels, in raw values (bounds left out). */
function rawOn(sample: Sample, gate: Gate, axis: 0 | 1, points: readonly Vertex[]): number[] {
  const channel = axis === 0 ? gate.x_channel : gate.y_channel;
  return points.filter((p) => !isUnbounded(p[axis])).map((p) => sample.gateToRaw(gate, channel, p[axis]));
}

/** A linear range holding every value given, three display channels clear of each end. */
function paddedLinear(values: readonly number[]): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  let lo = finite.length ? Math.min(...finite) : 0;
  let hi = finite.length ? Math.max(...finite) : 1;
  if (!(hi > lo)) {
    const d = Math.max(1, Math.abs(lo));
    lo -= d;
    hi += d;
  }
  const pad = ((hi - lo) * 3) / (DISPLAY - 6);
  return [lo - pad, hi + pad];
}

interface PlacedAxis {
  axis: Fj11Axis;
  /** The gate's own coordinate on this channel → display units. */
  fromSpace: (v: number) => number;
  /** Display units per unit of the gate's space where the map is affine; NaN where it is not. */
  scale: number;
  /** Whether the gate's space is this axis up to scale, so a straight edge stays straight. */
  exact: boolean;
}

/**
 * The FlowJo 11 axis for one channel of a gate, and the map from the gate's space to its display.
 *
 * `straight`: the gate's boundary is straight in its own space (a polygon, an ellipse), so the axis
 * is that space's own where FlowJo 11 has one (a raw space on a linear axis fitted to the gate),
 * and otherwise the channel's default axis, on which the boundary must be traced (`exact` false).
 * Otherwise only the coordinates matter (a rectangle's bounds, a crosshair), and any axis that
 * holds them will do: the axis FlowJo saved the gate on, the gate's own space's, or the channel's
 * default, in that order.
 */
function axisFor(ctx: GateContext, gate: Gate, k: 0 | 1, points: readonly Vertex[], straight: boolean): PlacedAxis {
  const channel = k === 0 ? gate.x_channel : gate.y_channel;
  const spec = spaceOf(ctx.sample, gate, channel);
  const fileScale = ctx.ch.fileScale(channel);
  const raw = rawOn(ctx.sample, gate, k, points).map((v) => v * fileScale);
  const holds = (a: Fj11Axis) => raw.every((v) => a.holds(v));
  const viaRaw = (axis: Fj11Axis): PlacedAxis => ({
    axis, fromSpace: (v) => axis.display(ctx.sample.gateToRaw(gate, channel, v) * fileScale), scale: NaN, exact: false,
  });
  const fallback = ctx.ch.defaultAxis(channel, raw);
  if (straight) {
    const own = axisOfSpace(spec, fileScale, () => paddedLinear(raw));
    if (own && holds(own.axis)) return { ...own, exact: true };
    return viaRaw(fallback);
  }
  const saved = gate.gate_type === "rectangle" ? gate.flowjo_axes?.[channel] : undefined;
  if (saved) {
    const axis = saved.kind === "linear" ? linearAxis(saved.minRange, saved.maxRange)
      : saved.kind === "wsplog" ? logAxis(saved.offset, saved.decades) : biexAxis(saved);
    if (holds(axis)) return viaRaw(axis);
  }
  if (spec.kind !== "identity") {
    const own = axisOfSpace(spec, fileScale, () => paddedLinear(raw));
    if (own && holds(own.axis)) return { ...own, exact: true };
  }
  if (holds(fallback)) return viaRaw(fallback);
  return viaRaw(linearAxis(...paddedLinear(raw)));
}

/** A bound → display units on an axis; an edge with no bound goes beyond the display. */
function boundOn(placed: PlacedAxis, v: number, below: boolean): number {
  if (isUnbounded(v)) return below ? OPEN_BELOW : OPEN_ABOVE;
  return placed.fromSpace(v);
}

/**
 * A range's or rectangle's bound on a biex axis, in the middle of the table entry nearest it.
 * FlowJo 11 tests such a bound with the event on its 4096-entry table, floor(lo × 16) ≤ entry <
 * floor(hi × 16) (flowjo11Workbench.ts, onTable, where the measurement is), so the bound is written
 * where FlowJo 11 gives that entry whichever way it rounds, as a quad's arm is (quadArmOn); the
 * events between the entry's edge and GateLab's bound change side and are named per file
 * (rectangleDifference). A bound beyond the display stays where it is, an open edge.
 */
function boundOnTable(placed: PlacedAxis, d: number): number {
  const length = (placed.axis.json as { vectorLength: number }).vectorLength;
  return d < 0 || d > length ? d : quadArmOn(placed.axis.json, d);
}

function rectangleJson(ctx: GateContext, gate: PolyRectGate): GateJson {
  const xs = gate.vertices.map((v) => v[0]);
  const ys = gate.vertices.map((v) => v[1]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const ax = axisFor(ctx, gate, 0, gate.vertices, false);
  const lo = boundOn(ax, x0, true);
  const hi = boundOn(ax, x1, false);
  const biex = (p: PlacedAxis): boolean => p.axis.json.transformType === "Biex";
  if (gate.x_channel === gate.y_channel) {
    // A range: one parameter, the two ends; the y coordinates place its label.
    const ends = biex(ax) ? [boundOnTable(ax, lo), boundOnTable(ax, hi)] : [lo, hi];
    return { type: "range", xAxis: axisJson(ctx, gate.x_channel, ax.axis), xVertices: ends, yVertices: [DISPLAY / 4, DISPLAY / 4] };
  }
  const ay = axisFor(ctx, gate, 1, gate.vertices, false);
  const ylo = boundOn(ay, y0, true);
  const yhi = boundOn(ay, y1, false);
  // Only a rectangle biex on both axes goes on the table: one with a log or linear axis was not
  // measured, and is written as before.
  const table = biex(ax) && biex(ay);
  return {
    type: "rectangle",
    xAxis: axisJson(ctx, gate.x_channel, ax.axis),
    yAxis: axisJson(ctx, gate.y_channel, ay.axis),
    xVertices: table ? [boundOnTable(ax, lo), boundOnTable(ax, hi)] : [lo, hi],
    yVertices: table ? [boundOnTable(ay, ylo), boundOnTable(ay, yhi)] : [ylo, yhi],
  };
}

/**
 * A ring of points straight in the gate's own space, traced onto two display maps: each edge is
 * divided until the display point of its middle lies within TRACE_TOLERANCE of the chord.
 */
function traced(ring: readonly Vertex[], fx: (v: number) => number, fy: (v: number) => number): Vertex[] {
  const out: Vertex[] = [];
  const at = (p: Vertex): Vertex => [fx(p[0]), fy(p[1])];
  const edge = (p: Vertex, q: Vertex, dp: Vertex, dq: Vertex, depth: number) => {
    const m: Vertex = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const dm = at(m);
    const off = Math.hypot(dm[0] - (dp[0] + dq[0]) / 2, dm[1] - (dp[1] + dq[1]) / 2);
    if (depth < 16 && off > TRACE_TOLERANCE) {
      edge(p, m, dp, dm, depth + 1);
      out.push(dm);
      edge(m, q, dm, dq, depth + 1);
    }
  };
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length];
    const dp = at(p);
    out.push(dp);
    edge(p, q, dp, at(q), 0);
  });
  return out;
}

/**
 * How far a polygon's written vertices move on one axis, in display channels. FlowJo 11 tests an
 * event at the lower corner of the display channel it falls in (flowjoGrid.ts). A polygon already on
 * FlowJo 11's grid is written where it is. Any other is moved down by half a channel, so the corner
 * stands for the channel's middle: a continuous polygon is then tested at the middle of each
 * channel, and a FlowJo 10 grid polygon, on its axis moved by half a channel (axisOfSpace), at
 * FlowJo 10's own channel. On a biex axis FlowJo 10's rule is FlowJo 11's.
 */
function cornerShift(spec: TransformSpec): number {
  if (spec.kind === "flowjoChannels" && (spec.rule === "flowjo11" || spec.axis.kind === "biex")) return 0;
  return -0.5;
}

function polygonJson(ctx: GateContext, gate: Gate, ring: readonly Vertex[], what: string): GateJson {
  const ax = axisFor(ctx, gate, 0, ring, true);
  const ay = axisFor(ctx, gate, 1, ring, true);
  let pts: Vertex[];
  if (ax.exact && ay.exact) {
    pts = ring.map(([x, y]) => [ax.fromSpace(x), ay.fromSpace(y)]);
  } else {
    pts = traced(ring, ax.fromSpace, ay.fromSpace);
    ctx.note(`${what} is not straight on any axis the workbench can declare; its boundary was traced as a polygon of ${pts.length} vertices on ` +
      `${ax.axis.json.transformType} × ${ay.axis.json.transformType} axes, within ${TRACE_TOLERANCE} of a display channel.`);
  }
  const dx = ax.exact ? cornerShift(spaceOf(ctx.sample, gate, gate.x_channel)) : -0.5;
  const dy = ay.exact ? cornerShift(spaceOf(ctx.sample, gate, gate.y_channel)) : -0.5;
  return {
    type: "polygon",
    xAxis: axisJson(ctx, gate.x_channel, ax.axis),
    yAxis: axisJson(ctx, gate.y_channel, ay.axis),
    xVertices: pts.map((p) => p[0] + dx),
    yVertices: pts.map((p) => p[1] + dy),
  };
}

function ellipseJson(ctx: GateContext, gate: EllipseGate): GateJson {
  const reach = ellipseBoundary(gate, 64);
  const ax = axisFor(ctx, gate, 0, reach, true);
  const ay = axisFor(ctx, gate, 1, reach, true);
  if (!(ax.exact && ay.exact && Number.isFinite(ax.scale) && Number.isFinite(ay.scale))) {
    return polygonJson(ctx, gate, ellipseBoundary(gate, 256), `The ellipse "${gate.name}"`);
  }
  // An affine map of each axis: the ellipse in display units is the gate's, scaled.
  const [[a, b], [, c]] = gate.covariance;
  const cov: [[number, number], [number, number]] = [
    [a * ax.scale * ax.scale, b * ax.scale * ay.scale],
    [b * ax.scale * ay.scale, c * ay.scale * ay.scale],
  ];
  const { major, minor, angle } = axesFromCovariance(cov, gate.distance_square);
  const cx = ax.fromSpace(gate.mean[0]);
  const cy = ay.fromSpace(gate.mean[1]);
  // FlowJo 11's two points are opposite corners of the ellipse's box in its own frame, turned by
  // rotationAngle degrees about the box's centre (flowjo11Workbench.ts).
  return {
    type: "ellipse",
    xAxis: axisJson(ctx, gate.x_channel, ax.axis),
    yAxis: axisJson(ctx, gate.y_channel, ay.axis),
    xVertices: [cx - major, cx + major],
    yVertices: [cy - minor, cy + minor],
    rotationAngle: (angle * 180) / Math.PI,
  };
}

const sameCurl = (a: { power: number; kx: number; ky: number }, b: { power: number; kx: number; ky: number }) =>
  a.power === b.power && a.kx === b.kx && a.ky === b.ky;

/** A quadrant gate as FlowJo 11's quad (straight) or curlyQuad (FlowJo 11's own curl); else null. */
function quadrantJson(ctx: GateContext, gate: QuadrantGate): GateJson | null {
  const centre: Vertex[] = [gate.center];
  const ax = axisFor(ctx, gate, 0, centre, false);
  const ay = axisFor(ctx, gate, 1, centre, false);
  const cx = ax.fromSpace(gate.center[0]);
  const cy = ay.fromSpace(gate.center[1]);
  const axes = {
    xAxis: axisJson(ctx, gate.x_channel, ax.axis),
    yAxis: axisJson(ctx, gate.y_channel, ay.axis),
  };
  if (gate.curl) {
    // FlowJo 11's bend is in its display channels: carried only where the gate's space is them.
    const inChannels = ax.exact && ay.exact && ax.scale === 1 && ay.scale === 1;
    if (!inChannels || !sameCurl(gate.curl, FLOWJO11_CURLY_QUAD_CURL)) return null;
    return { type: "curlyQuad", ...axes, xVertices: [cx], yVertices: [cy] };
  }
  // [centre, down, right, up, left], each arm through the centre, ending where FlowJo 11 ends a new
  // quadrant's arms. On a biex axis the arm goes in the middle of the table entry nearest the centre
  // (quadArmEntry).
  const qx = quadArmOn(ax.axis.json, cx);
  const qy = quadArmOn(ay.axis.json, cy);
  return { type: "quad", ...axes, xVertices: [qx, qx, DISPLAY + 37, qx, 0], yVertices: [qy, -37, qy, DISPLAY, qy] };
}

/**
 * FlowJo 11 tests a plain quad's arm on a biex axis with the event on its 4096-entry table: an event
 * is on the arm's upper side where the table entry at or below its value is at or above the entry
 * at or below the arm, and an event below the table's first entry on either axis is in no quadrant.
 * Measured on 2026-10-23 against every plain quad FlowJo 11.2.0 saved in David's S6 workbenches
 * (196 quadrant populations in 18 workbenches, four files): the rule gives FlowJo 11's count for all
 * 196, GateLab's continuous test for 118 (sample_PBMC_check Q1 15 where FlowJo 11 counts 16: the
 * event at display 92.587 is on the arm's entry, the arm at 92.614). The arm is written in the
 * middle of the entry nearest GateLab's centre, so that FlowJo 11 gives the entry whichever way it
 * places the arm; the events between that entry's edge and GateLab's centre change side, and are
 * named per file (quadDifference). Not measured on a linear or log axis, where the centre is
 * written as it is.
 */
function quadArmEntry(axis: AxisJson, display: number): number | null {
  if (axis.transformType !== "Biex") return null;
  const perCell = FLOWJO_BIEX_TABLE_CHANNELS / axis.vectorLength;
  return Math.min(Math.max(Math.round(display * perCell), 0), FLOWJO_BIEX_TABLE_CHANNELS);
}

function quadArmOn(axis: AxisJson, display: number): number {
  const j = quadArmEntry(axis, display);
  if (j === null) return display;
  const perCell = FLOWJO_BIEX_TABLE_CHANNELS / (axis as { vectorLength: number }).vectorLength;
  return (Math.min(j, FLOWJO_BIEX_TABLE_CHANNELS - 1) + 0.5) / perCell;
}

/** FlowJo 11's population number for GateLab's quadrant 1 to 4. */
const FJ11_QUADRANT: Record<number, number> = { 1: 2, 2: 3, 3: 1, 4: 0 };
/** GateLab's quadrant for FlowJo 11's population number 0 to 3. */
const GATELAB_QUADRANT = [4, 3, 1, 2];

/** One gate as FlowJo 11 stores it, or the reason it cannot be. */
function gateJson(ctx: GateContext, gate: Gate): GateJson | { refused: string } {
  for (const ch of [gate.x_channel, gate.y_channel]) {
    if (!ctx.ch.name.has(ch)) return { refused: `"${gate.name}" is on ${ch}, which the file does not have.` };
  }
  switch (gate.gate_type) {
    case "rectangle":
      return rectangleJson(ctx, gate);
    case "polygon":
      return polygonJson(ctx, gate, gate.vertices, `The polygon "${gate.name}"`);
    case "ellipse":
      return ellipseJson(ctx, gate);
    case "quadrant":
      return quadrantJson(ctx, gate) ?? {
        refused: `The quadrant gate "${gate.name}" has curved arms the workbench cannot hold (only a curly quadrant's ` +
          "bend can be written); straighten it, or redraw it as a curly quadrant, to export it.",
      };
  }
}

// ── The tree FlowJo 11 is given ───────────────────────────────────────────────────────────────

/** One population definition to write, with the GateLab population (or gate) it comes from. */
interface DefPlan {
  key: string;
  kind: "gate" | "quad" | "not" | "and";
  /** The gate whose definition this is (gate and quad); for quad, by population number 0 to 3. */
  gateId?: string;
  names: string[];
  /** Populations of this definition: one, or four for a quad, each with its GateLab id if any. */
  pops: Array<{ number: number; populationId: string | null }>;
  /** The definition key of the population each population of this one sits under (gate, quad). */
  parentKey: string | null;
  parentNumber: number;
  /** For not and and: the populations combined, as [definition key, population number]. */
  operands?: Array<[string, number]>;
}

const rootKey = "root";

/**
 * The definitions FlowJo 11 is given for a tree: one per gate population, one per quadrant gate
 * under a parent (its four populations), one per NOT and AND, and a helper beside a NOT or an AND
 * where the tree has no population holding a gate it combines.
 */
function planTree(entry: FlowJo11ExportSample, warnings: string[], refusals: Map<string, string>): DefPlan[] {
  const { populations, gates } = entry;
  const plans: DefPlan[] = [];
  const byKey = new Map<string, DefPlan>();
  const add = (p: DefPlan) => {
    plans.push(p);
    byKey.set(p.key, p);
    return p;
  };
  /** Where a GateLab population is written: [definition key, population number]. */
  const placeOf = new Map<string, [string, number]>();
  placeOf.set(entry.root_population_id, [rootKey, 0]);

  const visit = (parentId: string) => {
    const parent = populations[parentId];
    if (!parent) return;
    const [parentKey, parentNumber] = placeOf.get(parentId)!;
    const kids = parent.children.map((id) => populations[id]).filter((p): p is Population => !!p);
    /** A population under this parent holding exactly one ref, as given. */
    const holding = (ref: GateRef): [string, number] | null => {
      const same = (r: GateRef) => r.gate_id === ref.gate_id && r.include === ref.include && (r.quadrant ?? null) === (ref.quadrant ?? null);
      const p = kids.find((k) => k.gate_refs.length === 1 && same(k.gate_refs[0]) && placeOf.has(k.population_id));
      return p ? placeOf.get(p.population_id)! : null;
    };
    const quadKey = (gateId: string) => `quad:${parentId}:${gateId}`;
    const helper = (ref: GateRef, beside: string): [string, number] => {
      const g = gates[ref.gate_id];
      if (g?.gate_type === "quadrant") {
        const key = quadKey(ref.gate_id);
        const quad = byKey.get(key) ?? add({ key, kind: "quad", gateId: ref.gate_id, names: quadNames(g), pops: [0, 1, 2, 3].map((n) => ({ number: n, populationId: null })), parentKey, parentNumber });
        const at: [string, number] = [quad.key, FJ11_QUADRANT[ref.quadrant ?? 1]];
        if (!ref.include) return notOf(at, `Not ${quad.names[at[1]]}`, beside);
        return at;
      }
      const key = `helper:${parentId}:${ref.gate_id}`;
      const gatePlan = byKey.get(key) ?? (() => {
        warnings.push(`"${g?.name ?? ref.gate_id}" was added under "${parent.name}", as the workbench combines populations, not gates, in "${beside}".`);
        return add({ key, kind: "gate", gateId: ref.gate_id, names: [g?.name ?? ref.gate_id], pops: [{ number: 0, populationId: null }], parentKey, parentNumber });
      })();
      if (!ref.include) return notOf([gatePlan.key, 0], `Not gate of ${gatePlan.names[0]}`, beside);
      return [gatePlan.key, 0];
    };
    const notOf = (operand: [string, number], name: string, beside: string): [string, number] => {
      const key = `not:${operand[0]}:${operand[1]}`;
      if (!byKey.has(key)) {
        warnings.push(`"${name}" was added under "${parent.name}", as the workbench combines populations, not gates, in "${beside}".`);
        add({ key, kind: "not", names: [name], pops: [{ number: 0, populationId: null }], parentKey, parentNumber, operands: [operand] });
      }
      return [key, 0];
    };
    const quadNames = (g: Gate): string[] => GATELAB_QUADRANT.map((q) => {
      const named = kids.find((k) => k.gate_refs.length === 1 && k.gate_refs[0].gate_id === g.gate_id && k.gate_refs[0].include && k.gate_refs[0].quadrant === q);
      if (named) return named.name;
      const x = g.x_channel;
      const y = g.y_channel;
      return [`Q4: ${x}-, ${y}-`, `Q3: ${x}+, ${y}-`, `Q1: ${x}-, ${y}+`, `Q2: ${x}+, ${y}+`][FJ11_QUADRANT[q]];
    });

    // Gate populations first, so a NOT or an AND finds the populations it combines among them.
    const later: Population[] = [];
    for (const pop of kids) {
      const refs = pop.gate_refs;
      const one = refs.length === 1 ? refs[0] : null;
      if (one && one.include) {
        const g = gates[one.gate_id];
        if (!g) {
          refusals.set(pop.population_id, `"${pop.name}" names a gate the tree does not hold.`);
          continue;
        }
        if (g.gate_type === "quadrant") {
          const key = quadKey(g.gate_id);
          const quad = byKey.get(key) ?? add({ key, kind: "quad", gateId: g.gate_id, names: quadNames(g), pops: [0, 1, 2, 3].map((n) => ({ number: n, populationId: null })), parentKey, parentNumber });
          const number = FJ11_QUADRANT[one.quadrant ?? 1];
          quad.pops[number].populationId = pop.population_id;
          placeOf.set(pop.population_id, [key, number]);
        } else {
          const key = `pop:${pop.population_id}`;
          add({ key, kind: "gate", gateId: g.gate_id, names: [pop.name], pops: [{ number: 0, populationId: pop.population_id }], parentKey, parentNumber });
          placeOf.set(pop.population_id, [key, 0]);
        }
      } else {
        later.push(pop);
      }
    }
    // A NOT of one gate before an AND, which may combine it.
    later.sort((a, b) => a.gate_refs.length - b.gate_refs.length);
    for (const pop of later) {
      const refs = pop.gate_refs;
      if (!refs.length) {
        refusals.set(pop.population_id, `"${pop.name}" holds no gate; the workbench has no population without one.`);
        continue;
      }
      if (refs.length > 1 && pop.gate_logic === "or") {
        refusals.set(pop.population_id, `"${pop.name}" combines gates with OR, which GateLab does not export.`);
        continue;
      }
      const key = `pop:${pop.population_id}`;
      if (refs.length === 1) {
        // A NOT of one gate: FlowJo 11's not, linked to the population holding the gate.
        const operand = holding({ ...refs[0], include: true }) ?? helper({ ...refs[0], include: true }, pop.name);
        add({ key, kind: "not", names: [pop.name], pops: [{ number: 0, populationId: pop.population_id }], parentKey, parentNumber, operands: [operand] });
      } else {
        const operands = refs.map((r) => holding(r) ?? helper(r, pop.name));
        add({ key, kind: "and", names: [pop.name], pops: [{ number: 0, populationId: pop.population_id }], parentKey, parentNumber, operands });
      }
      placeOf.set(pop.population_id, [key, 0]);
    }
    for (const pop of kids) if (placeOf.has(pop.population_id)) visit(pop.population_id);
  };
  visit(entry.root_population_id);
  return plans;
}

/** Each population of one file's tree by its path of names from the root. */
function populationsByPath(entry: FlowJo11ExportSample): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (id: string, path: string) => {
    const pop = entry.populations[id];
    if (!pop) return;
    if (!out.has(path)) out.set(path, id);
    for (const c of pop.children) {
      const child = entry.populations[c];
      if (child) visit(c, `${path}/${child.name}`);
    }
  };
  visit(entry.root_population_id, "");
  return out;
}

/** A written gate's axis as GateLab's grid spec for FlowJo 11's rule. */
function gridSpecOf(axis: AxisJson): TransformSpec {
  switch (axis.transformType) {
    case "Linear":
      return { kind: "flowjoChannels", channels: DISPLAY, axis: { kind: "linear", minRange: axis.minRange, maxRange: axis.maxRange }, rule: "flowjo11" };
    case "Log":
      return { kind: "flowjoChannels", channels: DISPLAY, axis: { kind: "wsplog", offset: axis.decadesOffset, decades: axis.numberDecades }, rule: "flowjo11" };
    case "Biex":
      return {
        kind: "flowjoChannels", channels: axis.vectorLength, rule: "flowjo11",
        axis: { kind: "biex", maxValue: axis.T, pos: axis.M, neg: axis.A, widthBasis: axis.W, channelRange: axis.vectorLength },
      };
  }
}

/**
 * How many events of a parent one written quadrant holds otherwise than GateLab's quadrant does,
 * with the quad tested as FlowJo 11 tests it (quadArmEntry). Only a quad on two biex axes is checked.
 */
function quadDifference(ch: SampleChannels, gate: QuadrantGate, quadrant: number, written: GateJson, parent: Uint8Array, data: ReturnType<Sample["gateAssayData"]>): number {
  const axes = [written.xAxis, written.yAxis].map((a) => (a as { transform: AxisJson }).transform);
  if (axes.some((a) => a.transformType !== "Biex")) return 0;
  const tables = axes.map((a) => {
    const b = a as Extract<AxisJson, { transformType: "Biex" }>;
    return flowJoGridScale({ kind: "flowjoChannels", channels: b.vectorLength, axis: { kind: "biex", maxValue: b.T, pos: b.M, neg: b.A, widthBasis: b.W, channelRange: b.vectorLength }, rule: "flowjo11" });
  });
  const lows = axes.map((a) => {
    const b = a as Extract<AxisJson, { transformType: "Biex" }>;
    return biexBreakpoints({ maxValue: b.T, pos: b.M, neg: b.A, widthBasis: b.W, channelRange: b.vectorLength, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS }).raw[0];
  });
  const arms = [written.xVertices[0], written.yVertices[0]].map((d, k) => {
    const perCell = FLOWJO_BIEX_TABLE_CHANNELS / (axes[k] as { vectorLength: number }).vectorLength;
    return Math.floor(d * perCell);
  });
  const raw = data.forGate({ ...gate, space: "raw" });
  const xs = raw.column(gate.x_channel);
  const ys = raw.column(gate.y_channel);
  if (!xs || !ys) return 0;
  const sx = ch.fileScale(gate.x_channel);
  const sy = ch.fileScale(gate.y_channel);
  const ours = getGateMask(gate, columnsForGate(data, gate), quadrant);
  const perCell = axes.map((a) => FLOWJO_BIEX_TABLE_CHANNELS / (a as { vectorLength: number }).vectorLength);
  let n = 0;
  for (let j = 0; j < parent.length; j++) {
    if (!parent[j]) continue;
    const x = xs[j] * sx;
    const y = ys[j] * sy;
    let theirs = false;
    if (x >= lows[0] && y >= lows[1]) {
      const right = Math.round(tables[0].channel(x) * perCell[0]) >= arms[0];
      const up = Math.round(tables[1].channel(y) * perCell[1]) >= arms[1];
      theirs = quadrant === 1 ? !right && up : quadrant === 2 ? right && up : quadrant === 3 ? right && !up : !right && !up;
    }
    if (theirs !== (ours[j] === 1)) n++;
  }
  return n;
}

/**
 * How many events of a parent a written range or rectangle holds otherwise than GateLab's gate
 * does, with it tested as FlowJo 11 tests one biex on every axis: floor(lo × 16) ≤ entry <
 * floor(hi × 16), the entry the last of the 4096-entry table at or below the event (boundOnTable),
 * a bound beyond the display an open edge. One with a log or linear axis is not checked.
 */
function rectangleDifference(ch: SampleChannels, gate: PolyRectGate, written: GateJson, parent: Uint8Array, data: ReturnType<Sample["gateAssayData"]>): number {
  const range = written.type === "range";
  const channels = range ? [gate.x_channel] : [gate.x_channel, gate.y_channel];
  const axes = (range ? [written.xAxis] : [written.xAxis, written.yAxis]).map((a) => (a as { transform: AxisJson }).transform);
  if (axes.some((a) => a.transformType !== "Biex")) return 0;
  const verts = range ? [written.xVertices] : [written.xVertices, written.yVertices];
  const raw = data.forGate({ ...gate, space: "raw" });
  const cols = channels.map((c) => raw.column(c));
  if (cols.some((c) => !c)) return 0;
  const tests = axes.map((a, k) => {
    const b = a as Extract<AxisJson, { transformType: "Biex" }>;
    const table = flowJoGridScale({ kind: "flowjoChannels", channels: b.vectorLength, axis: { kind: "biex", maxValue: b.T, pos: b.M, neg: b.A, widthBasis: b.W, channelRange: b.vectorLength }, rule: "flowjo11" });
    const perCell = FLOWJO_BIEX_TABLE_CHANNELS / b.vectorLength;
    const [lo, hi] = [Math.min(verts[k][0], verts[k][1]), Math.max(verts[k][0], verts[k][1])];
    const from = lo < 0 ? -Infinity : Math.floor(lo * perCell);
    const to = hi > b.vectorLength ? Infinity : Math.floor(hi * perCell);
    const scale = ch.fileScale(channels[k]);
    const col = cols[k]!;
    return (j: number): boolean => {
      const e = Math.round(table.channel(col[j] * scale) * perCell);
      return e >= from && e < to;
    };
  });
  const ours = getGateMask(gate, columnsForGate(data, gate));
  let n = 0;
  for (let j = 0; j < parent.length; j++) {
    if (!parent[j]) continue;
    if (tests.every((t) => t(j)) !== (ours[j] === 1)) n++;
  }
  return n;
}

/**
 * How many events of a parent a written ellipse holds otherwise than GateLab's ellipse does, with
 * the ellipse tested as FlowJo 11 tests it: each event at the middle of its display channel (the
 * channel its value falls in, rounded down, flowjoGrid.ts, plus a half), against the ellipse as
 * written. Measured on 2026-10-23 against every ellipse count FlowJo 11.2.0 saved or recounted (ten
 * populations: four S6 files under one ellipse, one of them tailored; four populations on two
 * ellipses of an S8 file; GateLab's own E1, which FlowJo 11 recounts 208 where GateLab counts 207): the rule gives
 * FlowJo 11's count for all ten, GateLab's continuous test for five. The ellipse is written exactly;
 * GateLab tests each event at its value, which no ellipse FlowJo 11 tests on its channels can
 * reproduce, so the events between are named. Time, written in seconds, is not checked.
 */
function ellipseDifference(ch: SampleChannels, gate: EllipseGate, written: GateJson, parent: Uint8Array, data: ReturnType<Sample["gateAssayData"]>): number {
  if (ch.fileScale(gate.x_channel) !== 1 || ch.fileScale(gate.y_channel) !== 1) return 0;
  const axis = (a: unknown) => (a as { transform: AxisJson }).transform;
  const sx = flowJoGridScale(gridSpecOf(axis(written.xAxis)) as FlowJoGridSpec);
  const sy = flowJoGridScale(gridSpecOf(axis(written.yAxis)) as FlowJoGridSpec);
  const [x0, x1] = written.xVertices;
  const [y0, y1] = written.yVertices;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = Math.abs(x1 - x0) / 2;
  const hy = Math.abs(y1 - y0) / 2;
  const th = ((Number(written.rotationAngle) || 0) * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const raw = data.forGate({ ...gate, space: "raw" });
  const xs = raw.column(gate.x_channel);
  const ys = raw.column(gate.y_channel);
  if (!xs || !ys) return 0;
  const ours = getGateMask(gate, columnsForGate(data, gate));
  let n = 0;
  for (let j = 0; j < parent.length; j++) {
    if (!parent[j]) continue;
    const dx = sx.eventCell(xs[j]) + 0.5 - cx;
    const dy = sy.eventCell(ys[j]) + 0.5 - cy;
    const u = (dx * cos + dy * sin) / hx;
    const v = (-dx * sin + dy * cos) / hy;
    if ((u * u + v * v <= 1) !== (ours[j] === 1)) n++;
  }
  return n;
}

/**
 * How many events of a parent a written polygon holds otherwise than GateLab's gate does, with the
 * polygon tested as FlowJo 11 tests it (each event on its display channel, flowjoGrid.ts), which is
 * how GateLab's .flowjo import evaluates it. Time, written in seconds, is not checked.
 */
function gridDifference(ch: SampleChannels, gate: Gate, written: GateJson, parent: Uint8Array, data: ReturnType<Sample["gateAssayData"]>): number {
  if (ch.fileScale(gate.x_channel) !== 1 || ch.fileScale(gate.y_channel) !== 1) return 0;
  const axis = (a: unknown) => (a as { transform: AxisJson }).transform;
  const grid: PolyRectGate = {
    gate_id: `${gate.gate_id}:flowjo11`, name: gate.name, gate_type: "polygon", x_channel: gate.x_channel, y_channel: gate.y_channel,
    vertices: written.xVertices.map((x, k) => [x, written.yVertices[k]] as Vertex), space: "display",
    transforms: { [gate.x_channel]: gridSpecOf(axis(written.xAxis)), [gate.y_channel]: gridSpecOf(axis(written.yAxis)) },
    color: "#000000", label_offset: null,
  };
  const a = getGateMask(grid, columnsForGate(data, grid));
  const b = getGateMask(gate, columnsForGate(data, gate));
  let n = 0;
  for (let j = 0; j < parent.length; j++) if (parent[j] && a[j] !== b[j]) n++;
  return n;
}

// ── Workbench JSON ────────────────────────────────────────────────────────────────────────────

/** A node with every link collection present, as FlowJo 11 writes one. */
interface Node {
  uuid: string;
  properties: Json;
  definition: Json;
  parents: Record<string, string[]>;
  children: Record<string, string[]>;
  results: Json;
  definitionVersion: number;
  resultsVersion: number;
  stableSince: number;
  recalcVersion: number;
}

const emptyLinks = (): Record<string, string[]> => Object.fromEntries(COLLECTIONS.map((c) => [c, [] as string[]]));

function pulseType(name: string): string {
  if (/-A$/.test(name)) return "area";
  if (/-H$/.test(name)) return "height";
  if (/-W$/.test(name)) return "width";
  if (/-T$/.test(name)) return "timeToPeak";
  return "other";
}

/** FlowJo 11's name and match for a cytometer, where its own saved workbenches show one. */
function cytometerSpecName(cyt: string): { name: string; match: string } {
  if (/FACSDiscover/i.test(cyt)) return { name: "FACSDiscover", match: "facsdiscover" };
  if (/FACSymphony/i.test(cyt)) return { name: "FACSymphony", match: "" };
  return { name: "Default", match: "" };
}

/** Counts as FlowJo 11 writes them in a population's statistics. */
const cnt = (n: number) => String(n);
const fop = (n: number, parent: number) => (parent > 0 ? ((100 * n) / parent).toFixed(6) : "0");

/** A random version-4 uuid. */
function randomUuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const joinPath = (folder: string, file: string): string => `${folder.replace(/[\\/]+$/, "")}/${file}`;

/**
 * Write the files and their trees as a FlowJo 11 workbench. Refused, with the files named, when the
 * files are gated under trees of different structure, which one analysis cannot hold.
 */
export function exportFlowJo11Workbench(opts: FlowJo11ExportOpts): FlowJo11ExportResult {
  const { samples } = opts;
  if (!samples.length) throw new Error("No files to export.");
  if (!opts.fcsFolder.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(opts.fcsFolder)) {
    throw new Error("A FlowJo 11 workbench needs the folder the FCS files are in as an absolute path.");
  }
  const lead = samples[0];
  const leadKey = strategyStructureKey(lead);
  const others = samples.filter((s) => strategyStructureKey(s) !== leadKey).map((s) => s.fileName);
  if (others.length) {
    throw new Error(
      `A FlowJo 11 workbench gives every file one tree, and ${others.join(", ")} ${others.length === 1 ? "is" : "are"} gated under another ` +
        `than ${lead.fileName}. Export the files of each tree as a workbench of their own.`,
    );
  }

  const uuid = opts.uuid ?? randomUuid;
  const warnings: string[] = [];
  const note = (m: string) => {
    if (!warnings.includes(m)) warnings.push(m);
  };

  const analysisId = uuid();
  const nodes: Record<Collection, Record<string, Node>> = Object.fromEntries(COLLECTIONS.map((c) => [c, {}])) as Record<Collection, Record<string, Node>>;
  const platformGroups: Record<string, Record<string, Node>> = { spilloverMatrix: {}, statisticalModeling: {} };
  const kindOf = new Map<string, Collection>();
  const node = (collection: Collection, definition: Json, extra: Partial<Node> = {}): Node => {
    const n: Node = {
      uuid: extra.uuid ?? uuid(), properties: {}, definition, parents: emptyLinks(), children: emptyLinks(), results: {},
      definitionVersion: 2, resultsVersion: 2, stableSince: 0, recalcVersion: 0, ...extra,
    };
    n.parents._analysis = [analysisId];
    kindOf.set(n.uuid, collection);
    if (collection === "platforms") platformGroups[String(definition.platformType)][n.uuid] = n;
    else nodes[collection][n.uuid] = n;
    return n;
  };
  const link = (parent: Node, child: Node, as?: { parentKey?: string; childKey?: string }) => {
    const pc = as?.parentKey ?? kindOf.get(parent.uuid)!;
    const cc = as?.childKey ?? kindOf.get(child.uuid)!;
    (parent.children[cc] ??= []).push(child.uuid);
    (child.parents[pc] ??= []).push(parent.uuid);
  };

  // The analysis root, and the three groups every workbench starts with.
  const root = node("analysisRoot", {
    transforms: [], parameterMappings: {},
    statisticDefinitions: { FOP: { statType: "FreqOfParent" }, CNT: { statType: "Count" } },
    samplesTableDefinition: (() => {
      const stat = uuid();
      return {
        columns: [
          { uuid: uuid(), columnId: "SMP:SmpName", factorType: "sampleName", dataType: "nominal", width: 200.0, deletable: false },
          { uuid: stat, columnId: "STA::FreqOfParent", factorType: "statistic", dataType: "continuous", width: 200.0, statisticDefinition: { orientation: "parameter", statType: "FreqOfParent" }, deletable: false },
        ],
        populationStatisticColumnId: stat,
      };
    })(),
    imageWallSettings: { palette: [], currentChannelSettingsId: "" },
  }, { uuid: analysisId });
  root.parents = emptyLinks();
  root.parents._analysis = [analysisId];

  const fileCriteria = (fn: "Contains" | "Lacks", terms: string[]) =>
    terms.flatMap((value) => [{ keyword: "$FIL", function: fn, value }, { keyword: "File Name", function: fn, value }]);
  // Every group's results list its files, an empty list where it has none: FlowJo 11 refuses a
  // workbench with a group whose results lack the list ("the file you tried to open is not
  // supported"; David's probe G1, 2026-10-23).
  const groupResults = () => ({ results: { dataSources: [] as string[] } });
  const acquired = node("groups", { name: "Acquired Data", criteria: ["And", { inclusive: true }], color: "default" }, groupResults());
  const compensation = node("groups", {
    name: "Compensation Data",
    criteria: ["And", ["Or", ...fileCriteria("Contains", ["comp", "unstained", "stained control"]).sort((a, b) => (a.keyword === b.keyword ? 0 : a.keyword === "$FIL" ? -1 : 1))],
      { keyword: "$FIL", function: "Lacks", value: "FMO" }, { keyword: "File Name", function: "Lacks", value: "FMO" },
      { keyword: "$FIL", function: "Lacks", value: "isotype" }, { keyword: "File Name", function: "Lacks", value: "isotype" }, { inclusive: true }],
    color: "default",
  }, groupResults());
  const experiment = node("groups", {
    name: "Experiment Data",
    criteria: ["And", ["Or", ["And", ...fileCriteria("Lacks", ["comp", "unstained", "stained control"]).sort((a, b) => (a.keyword === b.keyword ? 0 : a.keyword === "$FIL" ? -1 : 1))],
      { keyword: "$FIL", function: "Contains", value: "FMO" }, { keyword: "File Name", function: "Contains", value: "FMO" },
      { keyword: "$FIL", function: "Contains", value: "isotype" }, { keyword: "File Name", function: "Contains", value: "isotype" }], { inclusive: true }],
    color: "default",
  }, groupResults());
  link(root, acquired);
  link(acquired, compensation);
  link(acquired, experiment);

  // Parameter sets: FlowJo 11's eight, each with a compound set per group.
  const paramsets: Array<[string, string, Json, boolean]> = [
    ["scatter", "Scatter", { conditions: [{ type: "ParameterIsScatter" }] }, false],
    ["uncompensated", "Uncompensated", { conditions: [{ type: "ParameterIsRawData" }] }, false],
    ["imageDerived", "Image Derived", { conditions: [{ type: "ParameterIsImageDerived" }] }, false],
    ["metadata", "Metadata", { conditions: [{ type: "ParameterIsMetadata" }] }, false],
    ["", "Parameter Set", {}, true],
    ["compensated", "Compensated", { conditions: [{ type: "ParameterIsUnmixed" }] }, false],
    ["all", "All", { conditions: [{ type: "ParameterAll" }] }, true],
    ["derived", "Derived", { conditions: [{ type: "ParameterIsDerived" }] }, true],
  ];
  const descriptions: Record<string, string> = {
    Scatter: "Scatter parameters.", Uncompensated: "Raw fluorescent, mass, or other detector data.", "Image Derived": "Image-derived parameters.",
    Metadata: "Metadata parameters.", "Parameter Set": "", Compensated: "Compensated and Unmixed parameters.", All: "All parameters.",
    Derived: "Derived (calculated) parameters.",
  };
  const parameterSets: Record<string, string> = {};
  /** Each group's compound parameter set of each parameter set, by group and set name. */
  const compoundSets: Array<{ group: Node; set: string; node: Node }> = [];
  for (const [role, name, rule, downstream] of paramsets) {
    const def = node("paramsetDefinitions", {
      name, description: descriptions[name], type: role ? "rule" : "static", includeDownstream: downstream,
      ...(role ? { rule } : {}),
    });
    if (role) parameterSets[role] = def.uuid;
    link(acquired, def);
    for (const g of [compensation, acquired, experiment]) {
      const cps = node("compoundParameterSets", {}, { results: { count: 0, parameters: {} }, stableSince: 2, recalcVersion: 2 });
      link(def, cps);
      link(g, cps);
      compoundSets.push({ group: g, set: name, node: cps });
    }
  }

  // Population definitions: the root, then the tree.
  const rootDef = node("populationDefinitions", { name: ["Ungated"], type: "root", kind: "ungated" });
  link(root, rootDef);
  link(acquired, rootDef);

  const refusals = new Map<string, string>();
  const plans = planTree(lead, warnings, refusals);
  for (const [, why] of refusals) note(`${why} It and the populations below it were left out.`);

  // The lead's populations by path, and each other file's population at the same path.
  const leadPaths = new Map<string, string>([...populationsByPath(lead)].map(([p, id]) => [id, p]));
  const filePaths = samples.map((s) => populationsByPath(s));
  /** A file's gate at the place of the lead's gate, matched by the population that holds it. */
  const gateIn = (fileIndex: number, plan: DefPlan): Gate | null => {
    const s = samples[fileIndex];
    if (fileIndex === 0) return lead.gates[plan.gateId!] ?? null;
    const holder = plan.pops.find((p) => p.populationId)?.populationId;
    if (!holder) {
      // A helper: the gate of the same name, kind and axes under the matching parent.
      const g = lead.gates[plan.gateId!];
      return Object.values(s.gates).find((x) => x.name === g?.name && x.gate_type === g?.gate_type && x.x_channel === g?.x_channel && x.y_channel === g?.y_channel) ?? null;
    }
    const path = leadPaths.get(holder);
    const id = path !== undefined ? filePaths[fileIndex].get(path) : undefined;
    const pop = id ? s.populations[id] : undefined;
    const ref = pop?.gate_refs.find((r) => r.include);
    return ref ? s.gates[ref.gate_id] ?? null : null;
  };

  const sampleChans = samples.map((s) => sampleChannels(s.sample, warnings));
  const gateJsonFor = (fileIndex: number, gate: Gate): GateJson | { refused: string } =>
    gateJson({ sample: samples[fileIndex].sample, ch: sampleChans[fileIndex], note: (m) => note(`${samples[fileIndex].fileName}: ${m}`) }, gate);

  const sampleIds = samples.map(() => uuid());
  /** Each gate as written for each file, by definition key. */
  const writtenGates = new Map<string, GateJson[]>();
  const defNode = new Map<string, Node>([[rootKey, rootDef]]);
  const written = new Set<string>([rootKey]);
  for (const plan of plans) {
    if (!written.has(plan.parentKey ?? "")) continue; // under a refused population
    let definition: Json;
    if (plan.kind === "gate" || plan.kind === "quad") {
      const id = uuid();
      const versions: Array<GateJson | { refused: string }> = samples.map((_, i) => {
        const g = gateIn(i, plan);
        return g ? gateJsonFor(i, g) : { refused: `${samples[i].fileName} has no gate for "${plan.names[0]}".` };
      });
      const refused = versions.find((v): v is { refused: string } => "refused" in v);
      if (refused) {
        note(`${refused.refused} It and the populations below it were left out.`);
        continue;
      }
      const shared = versions[0] as GateJson;
      writtenGates.set(plan.key, versions as GateJson[]);
      const gateDefinition = (g: GateJson) => ({ uuid: id, ...g, recalcVersion: -1, magnetic: false });
      const desyncTable: Record<string, Json> = {};
      versions.forEach((v, i) => {
        if (i > 0 && JSON.stringify(v) !== JSON.stringify(shared)) desyncTable[sampleIds[i]] = gateDefinition(v as GateJson);
      });
      definition = {
        name: plan.names, type: shared.type === "quad" || shared.type === "curlyQuad" ? shared.type : "gate", kind: "general",
        gateDefinition: gateDefinition(shared), desyncTable,
      };
      if (plan.kind === "quad" && shared.type !== "quad" && shared.type !== "curlyQuad") continue;
      defNode.set(plan.key, node("populationDefinitions", definition, { uuid: id }));
    } else {
      const operands = plan.operands ?? [];
      if (!operands.every(([k]) => written.has(k))) {
        note(`"${plan.names[0]}" combines a population that was left out; it and the populations below it were left out.`);
        continue;
      }
      definition = { name: plan.names, type: plan.kind, kind: "general", desyncTable: {} };
      defNode.set(plan.key, node("populationDefinitions", definition));
    }
    link(experiment, defNode.get(plan.key)!);
    written.add(plan.key);
  }

  // The plot each population opens on, which FlowJo 11 keeps with its definition: the axes of the
  // first gate drawn on it, or its own gate's.
  const labelOf = new Map<string, string>();
  for (const c of lead.sample.channels) {
    const name = sampleChans[0].name.get(c.key)!;
    labelOf.set(name, c.marker ? `${name} :: ${c.marker}` : name);
  }
  const plotAxes = (g: GateJson) => {
    const x = (g.xAxis as { parameterSpec: { name: string } }).parameterSpec.name;
    const y = g.type === "range" ? null : (g.yAxis as { parameterSpec: { name: string } }).parameterSpec.name;
    return {
      xAxis: { parameter: labelOf.get(x) ?? x, type: "Parameter", statistic: null },
      yAxis: y === null ? { parameter: "", type: "Histogram", statistic: null } : { parameter: labelOf.get(y) ?? y, type: "Parameter", statistic: null },
    };
  };
  for (const [key, def] of defNode) {
    const child = plans.find((p) => p.parentKey === key && defNode.has(p.key) && writtenGates.has(p.key));
    const own = writtenGates.get(key)?.[0];
    const shown = child ? writtenGates.get(child.key)![0] : own;
    if (!shown) continue;
    const axes = plotAxes(shown);
    def.properties = {
      graphHistory: {
        settings: {
          backgroundColor: "#ffffff", plotType: axes.yAxis.type === "Histogram" ? "Histogram" : "Pseudocolor", colorPalette: "FlowJoClassic",
          pointColor: "#00ccff", contourLevels: 20, isSmooth: false, resolution: "R_256", ...axes,
        },
        lastViewedParameters: axes,
      },
    };
  }

  // Each file's counts, under its own tree, by GateLab population id.
  const counts = samples.map((s) => {
    const data = s.sample.gateAssayData();
    const { masks } = applyGatingStrategy(s.gates, s.populations, s.root_population_id, data);
    const out: Record<string, number> = {};
    for (const [id, m] of Object.entries(masks)) {
      let n = 0;
      for (let i = 0; i < m.length; i++) n += m[i];
      out[id] = n;
    }
    return { out, masks, data };
  });
  /** A helper population's count in one file, from the gate it holds, under its parent. */
  const helperMasks = new Map<string, Uint8Array>();

  // Cytometers, one per instrument.
  const cytometers = new Map<string, Node>();
  const cytometerOf = (fileIndex: number): Node => {
    const s = samples[fileIndex].sample;
    const cyt = s.fcs.keywords["$CYT"] ?? "";
    const hit = cytometers.get(cyt);
    if (hit) return hit;
    const ch = sampleChans[fileIndex];
    const spec = cytometerSpecName(cyt);
    const cytId = uuid();
    const transforms = s.channels.flatMap((c) => {
      const scatter = isScatterChannel(c.key) || isScatterChannel(c.pnn);
      if (isTime(c.pnn)) return [];
      const axis = ch.defaultAxis(c.key, []).json;
      const entries = [{ parameterSpec: { name: ch.pnn.get(c.key)!, type: scatter ? "scatter" : "rawData" }, transform: axis, targetType: "cytometer", targetId: cytId, autoAssigned: true }];
      if (ch.compensated.has(c.key)) entries.push({ parameterSpec: { name: ch.name.get(c.key)!, type: "unmixed" }, transform: axis, targetType: "cytometer", targetId: cytId, autoAssigned: true });
      return entries;
    });
    const n = node("cytometers", {
      cytometer: cyt, system: s.fcs.keywords["$SYS"] ?? "",
      cytometerTransformSpec: {
        name: spec.name, match: spec.match, logRescale: 1.0, linearRescale: 1.0, useFCSEmbeddedTransforms: false,
        transformRules: [
          { name: "Forward Scatter", rule: [{ type: "ParameterIsForwardScatter" }], transform: { transformType: "Linear", minRange: 0.0, maxRange: 262144.0 } },
          { name: "Side Scatter", rule: [{ type: "ParameterIsSideScatter" }], transform: { transformType: "Linear", minRange: 0.0, maxRange: 262144.0 } },
          { name: "Fluorescent", rule: [{ type: "ParameterIsFluorescent" }], transform: { transformType: "Biex", T: 262144.0, A: 0.0, M: 4.5, W: -100.0, vectorLength: 256, autoWidthBasis: false } },
        ],
      },
      transforms,
    }, { uuid: cytId });
    link(root, n);
    cytometers.set(cyt, n);
    return n;
  };

  // Matrices: one per distinct matrix a compensated file is compensated with.
  const matrices = new Map<string, Node>();
  const matrixOf = (fileIndex: number): Node | null => {
    const s = samples[fileIndex].sample;
    const ch = sampleChans[fileIndex];
    const spill = s.instrument === "flow" && s.compensationEnabled ? s.spillover : null;
    if (!spill) return null;
    const detectors = spill.channels.map((k) => ch.pnn.get(k) ?? k);
    const rows = spill.channels.map((k) => ch.name.get(k) ?? `Comp-${k}`);
    const origin = s.spilloverOrigin;
    const name = origin.kind === "external" ? origin.label : "Acquisition-defined Matrix";
    const key = JSON.stringify([name, detectors, spill.matrix]);
    const hit = matrices.get(key);
    if (hit) return hit;
    const identity = spill.channels.map((_, i) => spill.channels.map((__, j) => (i === j ? 1.0 : 0.0)));
    const n = node("platforms", {
      recalcPrefs: { platformChanged: "n/a", platformUndone: "n/a", inputsRecalculated: "n/a", annotationsChanged: "n/a", samplesAdded: "n/a", samplesRemoved: "n/a" },
      platformType: "spilloverMatrix", name, isSpectral: false,
      matrixType: origin.kind === "external" ? "userDefined" : "acquisitionDefined", edited: false,
      fluorToPrimaryDetector: Object.fromEntries(rows.map((r, i) => [r, detectors[i]])),
      compSpec: {
        CompensationSpec: {
          id: uuid(), spectral: false, version: 0,
          parameters: rows.map((r) => ({ name: r })), detectors: detectors.map((d) => ({ name: d })),
          primaryDetectors: detectors.map((d) => ({ name: d })), coefficients: spill.matrix.map((r) => [...r]), weights: detectors.map(() => 1.0),
        },
      },
      detectors,
      spillover: { rows, columns: detectors, values: spill.matrix.map((r) => [...r]) },
      adjustment: { rows, columns: rows, values: identity },
      transforms: [],
    });
    link(root, n);
    matrices.set(key, n);
    return n;
  };

  /** Each sample's parameters by type, as [key, description] for the compound parameter sets. */
  const parameterLists: Array<Record<string, Array<[string, Json]>>> = [];

  // Samples, and each sample's populations.
  const pooled = new Map<string, number>();
  samples.forEach((s, i) => {
    const sample = s.sample;
    const ch = sampleChans[i];
    const filePath = joinPath(opts.fcsFolder, s.fileName);
    const matrix = matrixOf(i);
    const total = sample.fcs.nEvents;
    const step = Number(sample.fcs.keywords["$TIMESTEP"]);
    const timeKey = sample.channels.find((c) => isTime(c.pnn))?.key;
    let timeMin = 0;
    let timeMax = 0;
    if (timeKey) {
      const col = sample.rawColumnData(sample.channels.findIndex((c) => c.key === timeKey));
      timeMin = Infinity;
      timeMax = -Infinity;
      for (let j = 0; j < col.length; j++) {
        const v = col[j] * (Number.isFinite(step) && step > 0 ? step : 1);
        if (v < timeMin) timeMin = v;
        if (v > timeMax) timeMax = v;
      }
    }
    const cyt = sample.fcs.keywords["$CYT"] ?? "";
    const parameter = (c: (typeof sample.channels)[number], type: string, name: string) => {
      const n = c.columnIndex + 1;
      const keywords = Object.fromEntries(Object.entries(sample.fcs.keywords).filter(([k]) => new RegExp(`^\\$?P${n}[A-Z]+$`).test(k)));
      return {
        name, descriptiveName: c.marker ?? "", analyteName: "", type, orientation: "parameter", index: c.columnIndex,
        parameterSource: cyt, originalName: name, originalDescriptiveName: c.marker ?? "", originalAnalyteName: "",
        representableRange: c.range, pulseType: type === "metadata" ? "other" : pulseType(name), keywords,
      };
    };
    const params: Record<string, Json[]> = { rawData: [], metadata: [], scatter: [], unmixed: [], imageDerived: [], derived: [], debug: [] };
    for (const c of sample.channels) {
      const name = ch.pnn.get(c.key)!;
      if (isTime(c.pnn)) {
        params.metadata.push({ ...parameter(c, "metadata", name), defaultTransform: { transformType: "Linear", minRange: timeMin, maxRange: timeMax } });
      } else if (isScatterChannel(c.key) || isScatterChannel(c.pnn)) {
        params.scatter.push(parameter(c, "scatter", name));
      } else {
        params.rawData.push(parameter(c, "rawData", name));
        if (ch.compensated.has(c.key)) params.unmixed.push({ ...parameter(c, "unmixed", ch.name.get(c.key)!), originalName: ch.name.get(c.key)! });
      }
    }
    params.metadata.push({
      name: "Event #", descriptiveName: "", analyteName: "", type: "metadata", orientation: "parameter", parameterSource: cyt,
      originalName: "Event #", originalDescriptiveName: "", originalAnalyteName: "", representableRange: total, pulseType: "other",
      defaultTransform: { transformType: "Linear", minRange: 0.0, maxRange: total + 1 },
    });
    // The sample's parameters as its groups' parameter sets list them: each described as the sample
    // describes it, without its keywords, with the axis it is shown on.
    const shownOn = (p: Json): AxisJson | Json => {
      if (p.name === "Event #") return { transformType: "Linear", minRange: 0.0, maxRange: total };
      if (p.type === "metadata") return { transformType: "Linear", minRange: timeMin, maxRange: timeMax };
      const c = sample.channels.find((x) => x.columnIndex === p.index)!;
      return ch.defaultAxis(c.key, []).json;
    };
    parameterLists.push(Object.fromEntries(Object.entries(params).map(([type, list]) => [type, list.map((p) => {
      const { keywords: _k, defaultTransform, ...rest } = p;
      void _k;
      return [`${p.name} :: ${p.descriptiveName}`, { ...rest, transform: shownOn(p), ...(defaultTransform ? { defaultTransform } : {}) }] as [string, Json];
    })])));
    const keywords: Record<string, string> = {
      ...Object.fromEntries(Object.entries(sample.fcs.keywords).map(([k, v]) => [k, String(v)])),
      FJ_FCS_VERSION: sample.fcs.version.replace(/^FCS(\d\.\d)$/, "$1").replace(/^(\d)\.0$/, "$1"),
    };
    const ds = node("dataSources", {
      uri: filePath,
      customKeywords: { "File Name": s.fileName, "File URI": filePath, "Compensation Matrix": matrix ? String(matrix.definition.name) : "" },
      transforms: [
        { parameterSpec: { name: "Event #", type: "metadata" }, transform: { transformType: "Linear", minRange: 0.0, maxRange: total }, targetType: "sample", targetId: sampleIds[i], autoAssigned: true },
        ...(timeKey ? [{ parameterSpec: { name: ch.pnn.get(timeKey)!, type: "metadata" }, transform: { transformType: "Linear", minRange: timeMin, maxRange: timeMax }, targetType: "sample", targetId: sampleIds[i], autoAssigned: true }] : []),
      ],
    }, {
      uuid: sampleIds[i],
      // Always written: FlowJo 11 refuses a workbench whose data source or populations hold empty
      // results (David's probes B1 and B2, round 8, 2026-10-23).
      results: {
        dataStatus: "loaded", isSpectralFX: false, hasHardwareUnmixedParameters: false,
        acquisitionCompensationMatrixId: matrix && matrix.definition.matrixType === "acquisitionDefined" ? matrix.uuid : "",
        timeMinMax: [timeMin, timeMax], keywords, parameters: params,
      },
    });
    link(root, ds);
    link(cytometerOf(i), ds);
    if (matrix) link(matrix, ds);
    link(ds, acquired);
    const inCompensation = /comp|unstained|stained control/i.test(s.fileName) && !/FMO|isotype/i.test(s.fileName);
    if (inCompensation) {
      note(`${s.fileName}: when the workbench is opened, a file whose name contains "comp", "unstained" or "stained control" is put in its Compensation Data group, ` +
        "not Experiment Data, where the gates are; open the workbench and drag the gates onto it, or rename the file.");
    } else {
      link(ds, experiment);
    }
    (acquired.results.dataSources as string[]).push(ds.uuid);
    if (!inCompensation) (experiment.results.dataSources as string[]).push(ds.uuid);

    // The populations of this sample: the root, then each definition's.
    const { out: own, masks, data } = counts[i];
    const fileByPath = filePaths[i];
    const popNodes = new Map<string, Node>();
    const countOf = new Map<string, number>();
    const resultsOf = (n: number, parent: number) => ({
      status: n > 0 ? "valid" : "empty", validPopulations: n > 0 ? 1 : 0, invalidPopulations: 0, count: n,
      statistics: { CNT: cnt(n), FOP: fop(n, parent) },
    });
    const rootPop = node("populations", { populationNumber: 0 }, { results: resultsOf(total, total), stableSince: 1, recalcVersion: 1 });
    link(rootDef, rootPop);
    link(ds, rootPop);
    rootPop.parents._dataSource = [ds.uuid];
    popNodes.set(`${rootKey}#0`, rootPop);
    countOf.set(`${rootKey}#0`, total);

    /** This file's count of one of the lead's populations, or a helper's from its gate. */
    const fileCount = (plan: DefPlan, number: number, parentPopId: string | null): number => {
      const popId = plan.pops[number]?.populationId;
      if (popId) {
        const path = leadPaths.get(popId);
        const id = path !== undefined ? fileByPath.get(path) : undefined;
        if (id !== undefined && own[id] !== undefined) return own[id];
      }
      // A helper, or a quadrant no population of the tree holds: counted from its gate under the
      // parent's events. Its count is FlowJo's to compute; this is what GateLab would give.
      const g = plan.gateId ? gateIn(i, plan) : null;
      const parentMask = parentPopId && masks[parentPopId] ? masks[parentPopId] : null;
      if (!g || !parentMask) return 0;
      const key = `${i}:${plan.key}:${number}`;
      let m = helperMasks.get(key);
      if (!m) {
        const quadrant = plan.kind === "quad" ? GATELAB_QUADRANT[number] : undefined;
        const r = applyGatingStrategy({ [g.gate_id]: g }, {
          r: { population_id: "r", name: "r", gate_refs: [], gate_logic: "and", parent_id: null, children: ["h"], event_count: null, percent_of_parent: null },
          h: { population_id: "h", name: "h", gate_refs: [{ gate_id: g.gate_id, include: true, ...(quadrant ? { quadrant } : {}) }], gate_logic: "and", parent_id: "r", children: [], event_count: null, percent_of_parent: null },
        }, "r", data);
        m = r.masks.h;
        helperMasks.set(key, m);
      }
      let n = 0;
      for (let j = 0; j < m.length; j++) n += m[j] & parentMask[j];
      return n;
    };

    /** The GateLab population id of this file at a written place, for its children's counts. */
    const fileIdAt = (plan: DefPlan, number: number): string | null => {
      const popId = plan.pops[number]?.populationId;
      if (!popId) return null;
      const path = leadPaths.get(popId);
      return path !== undefined ? fileByPath.get(path) ?? null : null;
    };
    const fileIdAtKey = new Map<string, string | null>([[`${rootKey}#0`, fileByPath.get("") ?? s.root_population_id]]);

    for (const plan of plans) {
      const def = defNode.get(plan.key);
      if (!def) continue;
      const parentPlace = `${plan.parentKey}#${plan.parentNumber}`;
      const parentPop = popNodes.get(parentPlace);
      if (!parentPop) continue;
      for (const { number } of plan.pops) {
        const parentCount = countOf.get(parentPlace) ?? 0;
        let n: number;
        if (plan.kind === "not" || plan.kind === "and") {
          const popId = plan.pops[number]?.populationId;
          const path = popId ? leadPaths.get(popId) : undefined;
          const id = path !== undefined ? fileByPath.get(path) : undefined;
          n = id !== undefined && own[id] !== undefined ? own[id] : 0;
          if (!popId) {
            // A helper NOT: its operand's parent without the operand.
            const [k, num] = plan.operands![0];
            n = parentCount - (countOf.get(`${k}#${num}`) ?? 0);
          }
        } else {
          n = fileCount(plan, number, fileIdAtKey.get(parentPlace) ?? null);
          const written = writtenGates.get(plan.key)?.[i];
          const own = plan.kind === "gate" ? gateIn(i, plan) : null;
          const parentId = fileIdAtKey.get(parentPlace);
          if (plan.kind === "quad" && written?.type === "quad" && parentId && masks[parentId]) {
            const g = gateIn(i, plan);
            const quadrant = GATELAB_QUADRANT[number];
            const differ = g?.gate_type === "quadrant" ? quadDifference(ch, g, quadrant, written, masks[parentId], data) : 0;
            if (differ) {
              note(`${s.fileName}: the workbench tests the quadrant "${plan.names[number]}" with each event on its biex table, which puts ` +
                `${differ} event${differ === 1 ? "" : "s"} of "${s.populations[parentId]?.name ?? "its parent"}" in it otherwise than GateLab ` +
                "(an event below the table's first entry is in no quadrant).");
            }
          }
          if (written?.type === "ellipse" && own?.gate_type === "ellipse" && parentId && masks[parentId]) {
            const differ = ellipseDifference(ch, own, written, masks[parentId], data);
            if (differ) {
              note(`${s.fileName}: the workbench tests the ellipse "${plan.names[0]}" with each event at the middle of its display channel, which puts ` +
                `${differ} event${differ === 1 ? "" : "s"} of "${s.populations[parentId]?.name ?? "its parent"}" on the other side of it than GateLab.`);
            }
          }
          if ((written?.type === "range" || written?.type === "rectangle") && own?.gate_type === "rectangle" && parentId && masks[parentId]) {
            const differ = rectangleDifference(ch, own, written, masks[parentId], data);
            if (differ) {
              note(`${s.fileName}: the workbench tests the ${written.type} "${plan.names[0]}" with each event on its biex table, which puts ` +
                `${differ} event${differ === 1 ? "" : "s"} of "${s.populations[parentId]?.name ?? "its parent"}" on the other side of it than GateLab.`);
            }
          }
          if (written?.type === "polygon" && own && parentId && masks[parentId]) {
            const differ = gridDifference(ch, own, written, masks[parentId], data);
            if (differ) {
              note(`${s.fileName}: the workbench tests the polygon "${plan.names[0]}" with each event on its display channel, which puts ` +
                `${differ} event${differ === 1 ? "" : "s"} of "${s.populations[parentId]?.name ?? "its parent"}" on the other side of it than GateLab ` +
                "(as GateLab's .flowjo import reads the workbench's rule).");
            }
          }
        }
        const pop = node("populations", { populationNumber: number }, { results: resultsOf(n, parentCount), stableSince: 1, recalcVersion: 1 });
        pop.parents._dataSource = [ds.uuid];
        link(def, pop);
        if (plan.kind === "not" || plan.kind === "and") {
          for (const [k, num] of plan.operands!) {
            const operand = popNodes.get(`${k}#${num}`);
            if (operand) link(operand, pop);
          }
        } else {
          link(parentPop, pop);
        }
        const place = `${plan.key}#${number}`;
        popNodes.set(place, pop);
        countOf.set(place, n);
        fileIdAtKey.set(place, fileIdAt(plan, number));
        pooled.set(place, (pooled.get(place) ?? 0) + n);
      }
    }
    pooled.set(`${rootKey}#0`, (pooled.get(`${rootKey}#0`) ?? 0) + total);

  });

  // Each group's parameter sets list the parameters of its files: FlowJo 11 draws no data from a
  // workbench whose lists are empty (David's probes H2 and G9, 2026-10-23). A parameter is listed
  // once, as the first of the group's files describes it.
  const SET_TYPES: Record<string, string[]> = {
    Scatter: ["scatter"], Uncompensated: ["rawData"], Compensated: ["unmixed"], Metadata: ["metadata"],
    All: ["rawData", "metadata", "scatter", "unmixed"],
  };
  for (const { group, set, node: cps } of compoundSets) {
    const members = new Set(group.results.dataSources as string[]);
    const listed = new Map<string, Json>();
    samples.forEach((_, i) => {
      if (!members.has(sampleIds[i])) return;
      for (const type of SET_TYPES[set] ?? []) {
        for (const [key, entry] of parameterLists[i][type] ?? []) if (!listed.has(key)) listed.set(key, entry);
      }
    });
    cps.results = { count: listed.size, parameters: Object.fromEntries(listed) };
  }

  // Group-pooled populations: the root in each group, the tree in Experiment Data.
  const experimentTotal = (experiment.results.dataSources as string[] | undefined)?.length ? pooled.get(`${rootKey}#0`) ?? 0 : 0;
  const compoundResults = (n: number, parent: number) => ({
    status: n > 0 ? "valid" : "empty", validPopulations: n > 0 ? 1 : 0, invalidPopulations: 0, count: n,
    statistics: { CNT: cnt(n), FOP: fop(n, parent) },
  });
  const rootPops = Object.values(nodes.populations).filter((p) => p.parents.populationDefinitions[0] === rootDef.uuid);
  const compoundRoots = new Map<Node, Node>();
  for (const [g, n] of [[compensation, 0], [acquired, pooled.get(`${rootKey}#0`) ?? 0], [experiment, experimentTotal]] as const) {
    const cp = node("compoundPopulations", { populationNumber: 0 }, { results: compoundResults(n, n), stableSince: 1, recalcVersion: 1 });
    cp.parents._group = [g.uuid];
    link(g, cp);
    link(rootDef, cp);
    const members = (g.results.dataSources as string[] | undefined) ?? [];
    for (const p of rootPops) if (members.includes(p.parents._dataSource[0])) link(p, cp);
    compoundRoots.set(g, cp);
  }
  const compoundAt = new Map<string, Node>([[`${rootKey}#0`, compoundRoots.get(experiment)!]]);
  for (const plan of plans) {
    const def = defNode.get(plan.key);
    if (!def) continue;
    const parent = compoundAt.get(`${plan.parentKey}#${plan.parentNumber}`);
    if (!parent) continue;
    for (const { number } of plan.pops) {
      const place = `${plan.key}#${number}`;
      const n = pooled.get(place) ?? 0;
      const cp = node("compoundPopulations", { populationNumber: number }, { results: compoundResults(n, pooled.get(`${plan.parentKey}#${plan.parentNumber}`) ?? 0), stableSince: 1, recalcVersion: 1 });
      cp.parents._group = [experiment.uuid];
      link(def, cp);
      link(parent, cp);
      for (const p of Object.values(nodes.populations)) {
        if (p.parents.populationDefinitions[0] === def.uuid && p.definition.populationNumber === number) link(p, cp);
      }
      compoundAt.set(place, cp);
    }
  }

  // The table and chart every workbench starts with, and its report.
  const factor = () => ({ uuid: uuid(), columnId: "SMP:SmpName", factorType: "sampleName", dataType: "nominal", width: 200.0 });
  const recalc = { platformChanged: "recalculate", platformUndone: "recalculate", inputsRecalculated: "recalculate", annotationsChanged: "recalculate", samplesAdded: "n/a", samplesRemoved: "n/a" };
  const tableFactor = factor();
  const table = node("platforms", {
    recalcPrefs: recalc, platformType: "statisticalModeling", name: "Table", model: "table",
    rowSpecification: { summarization: "bySample", populationIds: [] }, factorSpecifications: [tableFactor], responseSpecifications: [],
  }, { results: { statistics: { table: { rows: [], columns: [tableFactor], values: [] } } }, stableSince: 1, recalcVersion: 1 });
  link(root, table);
  link(compoundRoots.get(acquired)!, table);
  const chart = node("platforms", {
    recalcPrefs: recalc, platformType: "statisticalModeling", name: "Chart", model: "chart",
    rowSpecification: { summarization: "bySample", populationIds: [] }, factorSpecifications: [factor()], responseSpecifications: [],
    parentModel: table.uuid,
    chartDefinition: {
      type: "bar",
      settings: {
        colorPalette: "Blues", fontColor: "#000000", fontStyle: "Regular", fontSize: 12, fontFamily: "Noto Sans", showLegend: true,
        showTable: true, showGuides: true, showMinorTicks: false, showMajorTicks: false, showComparisonLine: false, showPValue: false,
        showSignificance: false, rotateText: false, ellipsisStyle: "post", scale: "linear", range: { value: 0.0, auto: true },
        statistic: "Mean", errorBars: { enabled: true, statistic: "sd" },
      },
      primaryAxis: "category", groupBy: { enabled: false, factor: "" }, legends: {},
      comparison: { testStatistic: "Wilks' Lambda", mainFactor: "", primaryValue: "" },
    },
  }, { results: { statistics: { table: { rows: [], columns: [], values: [] } } }, stableSince: 1, recalcVersion: 1 });
  link(root, chart);
  link(table, chart);
  const page = uuid();
  const reportSpec = (pageId: string, type: string) => ({
    layout: { type: "custom", unitOfMeasurement: "inches", size: { width: 2496.0, height: 1920.0 } },
    batchSettings: {
      batchBy: "group", batchById: experiment.uuid,
      iterator: { type: "sample", sort: "ascending", keyword: "File Name", statistic: { type: "Count" } },
      discriminator: { type: "off", keyword: "File Name", statistic: { type: "Count" } },
      direction: "across", rows: 1, columns: 1, interval: 1,
    },
    pages: { [pageId]: { id: pageId, type, elements: { charts: {}, graphs: {}, tables: {}, text: {}, groups: {}, images: {} }, ...(type === "batched" ? { sourcePageId: page } : {}) } },
    pageOrder: [pageId],
  });
  const report = node("reports", { name: "Report", reportSpec: reportSpec(page, "source") }, { results: { reportSpec: reportSpec(`${page}:0`, "batched") }, stableSince: 1, recalcVersion: 1 });
  link(root, report);

  // The root's properties name the default groups, their root populations and the parameter sets.
  const workbenchId = uuid();
  // FlowJo 11 keeps an analysis under the user's preferences; the user is the one whose home the
  // FCS folder is in, where it is in one.
  const home = /^\/Users\/[^/]+/.exec(opts.fcsFolder)?.[0];
  const workingDirectory = home ? `${home}/Library/Preferences/FlowJo 11/analyses` : "/Users/Shared/FlowJo 11/analyses";
  const analysisDir = `${workingDirectory}/analysis-${analysisId}`;
  root.properties = {
    acquiredData: { groupId: acquired.uuid, compoundPopulationId: compoundRoots.get(acquired)!.uuid, populationDefinitionId: rootDef.uuid },
    compensationData: { groupId: compensation.uuid, compoundPopulationId: compoundRoots.get(compensation)!.uuid, populationDefinitionId: rootDef.uuid },
    experimentData: { groupId: experiment.uuid, compoundPopulationId: compoundRoots.get(experiment)!.uuid, populationDefinitionId: rootDef.uuid },
    parameterSets: parameterSets,
    workbenchId,
    workingDirectory,
    analysisWorkingDirectory: analysisDir,
  };

  const analysis: Record<string, unknown> = {
    schemaVersion: "3.0.0",
    analysisUUID: analysisId,
    uri: `${analysisDir}/analysis-${analysisId}.json`,
    reports: nodes.reports,
    compoundParameterSets: nodes.compoundParameterSets,
    populationDefinitions: nodes.populationDefinitions,
    compoundPopulations: nodes.compoundPopulations,
    paramsetDefinitions: nodes.paramsetDefinitions,
    groups: nodes.groups,
    dataSources: nodes.dataSources,
    populations: nodes.populations,
    platforms: platformGroups,
    cytometers: nodes.cytometers,
    analysisRoot: nodes.analysisRoot,
  };
  const dir = `analyses/analysis-${analysisId}`;
  const bytes = zipSync({
    "workbench.json": strToU8(JSON.stringify({ id: workbenchId, name: opts.name, analyses: [analysisId] })),
    "preferences.json": strToU8(JSON.stringify({ version: "4.0.0" })),
    [`${dir}/analysis-${analysisId}.json`]: strToU8(JSON.stringify(analysis)),
    [`${dir}/analysis-${analysisId}_manifest.txt`]: strToU8("[]"),
  });
  return { bytes, analysis, warnings, counts: counts.map((c) => c.out) };
}
