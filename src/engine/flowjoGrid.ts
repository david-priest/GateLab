// flowjoGrid.ts — FlowJo's gate grid: how FlowJo tests an event against a polygon it imported.
//
// FlowJo does not test a PolygonGate against the event's value. Every FlowJo polygon carries
// gateResolution="256", and that attribute is the grid: FlowJo quantises each axis to 256
// integer channels over the axis as the sample's <Transformations> element saves it, rounds the
// polygon's vertices onto the same channels, and tests the event's channel pair against the
// rounded polygon, boundary included. Established event by event against FlowJo's own exported
// memberships: zero disagreements in all 56 populations of three datasets (a FACSDiscover S8 file
// uncompensated, a FACSDiva and an LSRFortessa file compensated; FlowJo 10.9.0 and 10.10.0), where
// about 90 variants each leave events behind. Per axis, with N = gateResolution:
//
//   linear  c = floor((v − minRange) · N / (maxRange − minRange) + 0.5)
//   log     c = floor(log10(v / offset) / decades · N + 0.5)
//   biex    c = floor(channel4096 · N / 4096), channel4096 the index of the last entry of FlowJo's
//           4096-channel table at or below v (biex.ts), so interpolation does not matter
//
// On a linear or log axis an event's channel is then clamped to 0 … N−1, so every event beyond an
// end of the axis sits on its first or last channel, and a vertex is rounded the same way and NOT
// clamped: the 20 mixed biex × linear gates of the reference data put linear-axis vertices a few
// channels below 0, and clamping those leaves 10 of the 20 exact (289 events differ). The corpus
// keeps both for log axes: clamping a log vertex loses FR-FCM-ZZSX's two exact counts, and putting
// an event past a log axis's top on channel N loses FR-FCM-ZY9F's. A log vertex at or below zero,
// which has no logarithm, depends on FlowJo's version (logVertexAtZeroOnFloor): FlowJo 10.6 and
// later put it on channel 0, the axis floor (FR-FCM-Z2KY's CD3+, 10.6.2, a vertex at -93.44, 69,124
// events as FlowJo counts them, against 67,180 far below; FR-FCM-Z2V7, 10.6.1, 11 of 13 exact against
// 5), and FlowJo 10.2 and earlier far below it, as log10(1e-300) (FR-FCM-ZZSX, 10.0.7r2, 15 of 16
// exact against 3 on the floor; FR-FCM-ZY9F, 10.2, 320 events off against 1,679). No workspace of
// the corpus between 10.2 and 10.6.1 has such a vertex; one stating no version is taken far below.
// Checked again on 2026-09-25 over the eight corpus workspaces with such a vertex, varying where a
// workspace before 10.6 puts it: far below as here and at Java's int of -Infinity (-2^31) count
// alike (ZZSX 15 of 16, ZY9F 320 events off), while the floor, Java's int of NaN (0 for a negative
// vertex, -2^31 for zero) and the channel of the value 1 are worse (3 of 16 and 1,679; 3 of 16 and
// 1,679; 3 of 16 and 597); FR-FCM-Z248 (10.2) counts alike under all five. FlowJo's own per-event
// memberships (the three datasets above) hold no log vertex at or below zero, so they decide nothing.
//
// On a biex axis the lookup is the whole rule, for an event and a vertex alike: a value below the
// table is on entry 0 and one at or above its top on entry 4096, so both land on channels 0 … N,
// the table's last entry being channel N of its own. The per-event data do not decide this part
// (every variant of it keeps the 56 populations exact); FlowRepository's counts do. Over the 594
// biex grid polygons of the corpus whose parent the rule counts exactly as FlowJo does, the lookup
// clamped to the table gives FlowJo's count for 563 (summed difference 5,310 events), where
// extrapolating vertices beyond the table linearly and clamping events to 0 … N−1, as this module
// did until 2026-09-25, gave 533 (6,566). Of the 41 polygons whose count the ends decide, the lookup
// gives 30 exactly and the old rule none, including both FlowJo 10.9.0 workspaces nothing else
// explained (FR-FCM-Z6L9 20170823 "autofluor", 500; 20180423 "viable CD45+", 1,467); clamping
// vertices alone, with events kept to 0 … N−1, gives 28, the six FR-FCM-Z73A counts (FlowJo 10.8.2)
// preferring an event past the top on channel N. Still unexplained: FR-FCM-Z6ME 20200528 "(Gut)"
// total CD45 (FlowJo 1,725, the rule 1,737; continuing the biex function past the table gives
// 1,726 there, but FlowJo's count for only 2 of the 17 polygons whose parent holds events past a
// biex top), and 1 to 53 events in 10 polygons of FR-FCM-Z2FC, FR-FCM-Z2R7 (FlowJo 10.0.7, 10.0.8)
// and FR-FCM-Z73A.
//
// A polygon on two axes of different kinds takes each axis by its own rule and one integer grid.
//
// What the grid does NOT cover, and stays continuous whatever the import option says: rectangles
// (FlowJo compares them in raw units; flowjoWorkspace.ts), ellipses (none in the per-event data),
// curly quadrants, the panels of a quadrant gate (a PolygonGate with quadId 0 to 3; below),
// polygons with no gateResolution, and polygons on a Time axis, a linear axis with a gain other
// than 1, or a FlowJo ArcSinh or Logicle axis (untested). A gateResolution other than 256 is taken
// at its word, N channels, and named by the import: no corpus polygon declares one.
//
// A quadrant panel is tested continuously because neither reading is FlowJo's rule. Surveyed on
// 2026-09-26 over every quadId polygon in the trees the FlowRepository count oracle compares (219
// panels FlowJo counted, in 42 workspaces of 17 deposits, FlowJo 10.0.7 to 10.10.0, every one the
// file FlowJo counted; the import with the grid on, the panel continuous or on the grid, every
// other gate alike): the grid gives FlowJo's count for 130 panels and the continuous test for 49,
// and 13,263 events off in all against 13,792, but the grid is further from FlowJo's count for 35
// panels, by 1 to 123 events (a panel beneath FR-FCM-Z2KY Panel_T_pegi.wsp's CD3+: 5,860 on the
// grid, 5,737 in FlowJo and continuously). FlowJo's four panels of one gate divide their parent (39
// of 45 complete gates sum to it), where on the grid they overlap or leave gaps along the
// crosshair's channels (25 of 45 sum above the parent, 7 below), so FlowJo decides a quadrant's
// shared edges by another rule than a polygon's, not established here.
//
// Two lattice points coincide when two of FlowJo's vertices round onto one channel pair; that
// zero-length edge holds its one point (gates.ts), as the reference implementation's closed test
// does, which decides only a polygon with every vertex on one channel pair: it holds that cell.
// FlowJo's own count for such a polygon is not measured.

import type { FlowJoGridAxis, TransformSpec, Vertex } from "./models";
import { FLOWJO_BIEX_TABLE_CHANNELS, biexBreakpoints } from "./biex";

/** FlowJo's gateResolution: every corpus polygon that declares one declares 256. */
export const FLOWJO_GATE_RESOLUTION = 256;

/**
 * Whether the FlowJo that wrote a workspace (its Workspace element's flowJoVersion) puts a
 * log-axis polygon vertex at or below zero on the axis floor, channel 0, rather than far below it
 * (see the header): FlowJo 10.6 and later do. A version not stated, or not read, is taken as not.
 */
export function logVertexAtZeroOnFloor(flowJoVersion: string | null | undefined): boolean {
  const m = /^\s*(\d+)\.(\d+)/.exec(flowJoVersion ?? "");
  if (!m) return false;
  const major = Number(m[1]);
  return major > 10 || (major === 10 && Number(m[2]) >= 6);
}


/** The grid spec of one axis: the rule, and the channel count it quantises to. */
export type FlowJoGridSpec = Extract<TransformSpec, { kind: "flowjoChannels" }>;

/** One axis of the grid, compiled for evaluation. */
export interface FlowJoGridScale {
  /**
   * How many channels an event can land on: N on a linear or log axis (0 … N−1), N + 1 on a biex
   * axis (0 … N, the table's last entry being a channel of its own).
   */
  cells: number;
  /** Raw → the unrounded channel: unclamped on a linear or log axis, within the table on biex. */
  channel(v: number): number;
  /** Raw → the channel FlowJo tests an EVENT on: rounded, then clamped to 0 … cells − 1. */
  eventCell(v: number): number;
  /**
   * Raw → the channel FlowJo puts a VERTEX on: rounded the same way, never clamped on a linear or
   * log axis; on a biex axis the table's own channel, 0 … N, as an event's.
   */
  vertexCell(v: number): number;
  /**
   * A channel → the raw value at the middle of the events it holds: channel c itself on a linear
   * or log axis (which round half up), c + ½ on a biex axis (which floors), and the table's last
   * entry for a biex axis's channel N, which holds every value from there up. A vertex is drawn
   * there, and a vertex written there rounds back onto its channel under FlowJo's own rule.
   */
  centre(c: number): number;
}

const scaleCache = new Map<string, FlowJoGridScale>();

/** The grid of one axis. Cached by spec, since every event of a column goes through it. */
export function flowJoGridScale(spec: FlowJoGridSpec): FlowJoGridScale {
  const key = JSON.stringify(spec);
  const hit = scaleCache.get(key);
  if (hit) return hit;
  const scale = buildScale(spec.axis, spec.channels);
  if (scaleCache.size >= 256) scaleCache.delete(scaleCache.keys().next().value as string);
  scaleCache.set(key, scale);
  return scale;
}

function buildScale(axis: FlowJoGridAxis, N: number): FlowJoGridScale {
  const top = N - 1;
  const clampCell = (c: number): number => (c < 0 ? 0 : c > top ? top : c);
  if (axis.kind === "linear") {
    const { minRange, maxRange } = axis;
    const span = maxRange - minRange;
    // The operation order is the reference implementation's: ((v − min) · N) / span.
    const channel = (v: number): number => ((v - minRange) * N) / span;
    const vertexCell = (v: number): number => Math.floor(channel(v) + 0.5);
    return {
      cells: N,
      channel,
      vertexCell,
      eventCell: (v) => clampCell(vertexCell(v)),
      centre: (c) => minRange + (c * span) / N,
    };
  }
  if (axis.kind === "wsplog") {
    const { offset, decades } = axis;
    const logOffset = Math.log10(offset);
    // A value at or below zero has no logarithm; it is taken at 1e-300, which puts an event on
    // channel 0 once clamped and a vertex far below the axis, as FlowJo 10.2 and earlier leave it.
    // FlowJo 10.6 and later put such a vertex on channel 0; the import decides that by the
    // workspace's version (logVertexAtZeroOnFloor).
    const channel = (v: number): number => ((Math.log10(Math.max(v, 1e-300)) - logOffset) / decades) * N;
    const vertexCell = (v: number): number => Math.floor(channel(v) + 0.5);
    return {
      cells: N,
      channel,
      vertexCell,
      eventCell: (v) => clampCell(vertexCell(v)),
      centre: (c) => offset * Math.pow(10, (c * decades) / N),
    };
  }
  // biex: FlowJo's own table, whatever table a saved continuous biex spec was built on. A value is
  // looked up, an event and a vertex alike: the last of the table's 4097 entries at or below it,
  // the first entry for anything below the table and the last for anything at or above its top.
  const { raw: x } = biexBreakpoints({
    maxValue: axis.maxValue, pos: axis.pos, neg: axis.neg, widthBasis: axis.widthBasis,
    channelRange: axis.channelRange, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS,
  });
  const last = x.length - 1; // 4096
  const perCell = last / N; // table entries per grid channel: 16 for N = 256
  /** Raw → the 4096-table channel: the last entry at or below v, 0 … 4096. */
  const tableChannel = (v: number): number => {
    if (!(v >= x[0])) return 0; // below the table, and NaN
    if (v >= x[last]) return last;
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (x[mid] <= v) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const channel = (v: number): number => tableChannel(v) / perCell;
  const cell = (v: number): number => Math.floor(channel(v));
  /** The 4096-table channel → raw, interpolated. */
  const tableRaw = (ch: number): number => {
    if (ch <= 0) return x[0];
    if (ch >= last) return x[last];
    const j = Math.floor(ch);
    const f = ch - j;
    return f === 0 ? x[j] : x[j] + f * (x[j + 1] - x[j]);
  };
  return {
    cells: N + 1,
    channel,
    vertexCell: cell,
    eventCell: cell,
    centre: (c) => (c >= N ? x[last] : tableRaw((Math.max(c, 0) + 0.5) * perCell)),
  };
}

/** Whether a transform spec is one axis of FlowJo's gate grid. */
export function isFlowJoGridSpec(spec: TransformSpec | undefined): spec is FlowJoGridSpec {
  return spec?.kind === "flowjoChannels";
}

/**
 * Whether a gate is a FlowJo grid gate: a polygon whose two axes are both on the grid. The
 * importer marks both axes or neither, so one without the other is not a grid gate.
 */
export function isFlowJoGridGate(gate: {
  gate_type: string; x_channel: string; y_channel: string; space?: string; transforms?: Record<string, TransformSpec>;
}): boolean {
  return gate.gate_type === "polygon" && gate.space === "display"
    && isFlowJoGridSpec(gate.transforms?.[gate.x_channel])
    && isFlowJoGridSpec(gate.transforms?.[gate.y_channel]);
}

/**
 * A grid polygon's FlowJo vertices (PolyRectGate.flowjo_vertices) for a new list of its vertices on
 * channels, one per vertex, so an edit never leaves the two lists out of step. Each vertex that is
 * still one of the gate's vertices, in order, keeps the raw value FlowJo saved for it; a vertex
 * added or moved gets the middle of its channel, which FlowJo rounds back onto it. So deleting a
 * vertex keeps every other one's raw value, and adding one keeps them all. Undefined for a gate
 * that carries none, or one no longer on the grid.
 */
export function realignFlowJoVertices(
  gate: { gate_type: string; x_channel: string; y_channel: string; space?: string; transforms?: Record<string, TransformSpec>;
    vertices?: readonly Vertex[]; flowjo_vertices?: readonly Vertex[] },
  next: readonly Vertex[],
): Vertex[] | undefined {
  const raw = gate.flowjo_vertices;
  const before = gate.vertices;
  if (!raw || !before || raw.length !== before.length || !isFlowJoGridGate(gate)) return undefined;
  const gx = flowJoGridScale(gate.transforms![gate.x_channel] as FlowJoGridSpec);
  const gy = flowJoGridScale(gate.transforms![gate.y_channel] as FlowJoGridSpec);
  let from = 0;
  return next.map(([cx, cy]) => {
    for (let k = from; k < before.length; k++) {
      if (before[k][0] === cx && before[k][1] === cy) {
        from = k + 1;
        return [raw[k][0], raw[k][1]] as Vertex;
      }
    }
    return [gx.centre(cx), gy.centre(cy)] as Vertex;
  });
}

/** Validate a grid axis read from a file: null unless every parameter is usable. */
export function parseFlowJoGridAxis(value: unknown): FlowJoGridAxis | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const finite = (k: string): boolean => typeof v[k] === "number" && Number.isFinite(v[k] as number);
  switch (v.kind) {
    case "linear":
      return finite("minRange") && finite("maxRange") && (v.maxRange as number) > (v.minRange as number)
        ? { kind: "linear", minRange: v.minRange as number, maxRange: v.maxRange as number }
        : null;
    case "wsplog":
      return finite("offset") && finite("decades") && (v.offset as number) > 0 && (v.decades as number) > 0
        ? { kind: "wsplog", offset: v.offset as number, decades: v.decades as number }
        : null;
    case "biex": {
      if (!["maxValue", "pos", "neg", "widthBasis", "channelRange"].every(finite)) return null;
      const axis = {
        kind: "biex" as const,
        maxValue: v.maxValue as number, pos: v.pos as number, neg: v.neg as number,
        widthBasis: v.widthBasis as number, channelRange: v.channelRange as number,
      };
      try {
        biexBreakpoints({ ...axis, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS });
      } catch {
        return null;
      }
      return axis;
    }
    default:
      return null;
  }
}

/** Validate a whole grid spec read from a file. */
export function parseFlowJoGridSpec(value: unknown): FlowJoGridSpec | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== "flowjoChannels") return null;
  const channels = v.channels;
  if (typeof channels !== "number" || !Number.isInteger(channels) || channels < 2 || channels > 65536) return null;
  const axis = parseFlowJoGridAxis(v.axis);
  return axis ? { kind: "flowjoChannels", channels, axis } : null;
}

/** Whether two grid axes are the same one, field by field. */
export function sameFlowJoGridSpec(a: FlowJoGridSpec, b: FlowJoGridSpec): boolean {
  if (a.channels !== b.channels || a.axis.kind !== b.axis.kind) return false;
  const x = a.axis as Record<string, unknown>;
  const y = b.axis as Record<string, unknown>;
  return Object.keys(x).every((k) => x[k] === y[k]) && Object.keys(y).every((k) => x[k] === y[k]);
}

/** What the badge's tooltip says about a grid axis. */
export function describeFlowJoGridAxis(spec: FlowJoGridSpec): string {
  const a = spec.axis;
  const rule = a.kind === "linear"
    ? `linear ${a.minRange.toPrecision(4)} to ${a.maxRange.toPrecision(4)}`
    : a.kind === "wsplog"
      ? `log (offset ${a.offset.toPrecision(4)}, ${a.decades.toPrecision(4)} decades)`
      : `biex (width ${a.widthBasis.toPrecision(4)}, neg ${a.neg}, pos ${a.pos}), on FlowJo's 4096-channel table`;
  return `FlowJo's ${spec.channels}-channel grid, ${rule}`;
}

// ── Exporting a grid polygon as the set of events it selects ─────────────────────────────────
//
// Gating-ML has no quantised axis, so a grid polygon is written as exactly the region it selects:
// the union of its grid cells, a rectilinear polygon in raw units. Every cell edge is written
// where no event can lie, each channel found with this module's own rule:
//
//   • a float32 column (every FCS $DATATYPE F file, and every compensated column): halfway between
//     the last float32 of one channel and the first of the next, a double no float32 is;
//   • an integer column ($DATATYPE I, held as exact integers, which float32 cannot hold above 2^24):
//     halfway between the last integer of one channel and the first of the next;
//   • any other float64 column ($DATATYPE D, a decoded log-amplified channel): at the first double
//     of the next channel, since no double lies between two adjacent ones. There an event exactly
//     on a channel's first value lies on the edge: FlowKit's half-open test puts it on the right
//     side, a closed test on the ring's upper side puts it in the wrong cell.
//
// Every event then lies strictly to one side of every edge, so the edge is the same one under a
// closed rule (Gating-ML, GateLab, cytolib) and the half-open one FlowKit applies to polygons; the
// exporter writes every coordinate as the double it is (gatingmlExport.ts, fmtNum, since
// fix/gatingml-hardening; 15 significant digits before, which moved an edge far less than its
// half-gap except for float32 values within about 0.02 of zero, below). The outer edge of a channel
// at an end of the axis, which holds every event beyond it, is RING_OUTER, a double just beyond the
// largest float32 (written ±3.4028235170913126e38): a double reader keeps every float32 event
// strictly inside it, the largest float32 included, and a reader that parses coordinates as
// float32 rounds it to the largest float32, a finite ring. At twice the largest float32, as until
// 2026-09-25, such a reader read ±Infinity, and a ray test through an infinite vertex is undefined;
// at the largest float32 itself, as until the release candidate, an event there lay on the ring's
// right or upper edge, which FlowKit's polygon test drops (the interoperability tester's version 5
// probes it). A float32 reader still has an event at exactly the largest float32 on the edge.
// A float64 column can hold values far beyond the largest float32, which GateLab places on the end
// channels too; its ring's outer edge is RING_OUTER_FLOAT64, half the largest double, so that every
// value up to it lies inside (tester version 6's probes at ±1e155 on corpus-flowjo-grid-double lay
// outside RING_OUTER: 374 and 2 probes of two rings, held by GateLab only). Half, not the largest
// double itself: a reader's crossing test takes a value's distance from a vertex (y − yᵢ), which
// for every value within the ring then stays finite. A value beyond half the largest double is
// still outside it.
//
// Holes and separate pieces, rare but possible where a thin polygon crosses few grid points, are
// joined into the one ring Gating-ML allows by bridges run out and back along those edge
// coordinates: no event lies on one, a horizontal piece is never crossed, and a vertical piece is
// crossed twice, so a bridge changes no event under an even-odd or a winding rule.
//
// One reader departs from this. GateLab's own raw polygon test counts an event within 1e-9 of an
// edge as on it, and within about 0.02 of zero adjacent float32 values are closer together than
// that. GateLab restores the grid gate itself from its own mark (gatingmlExport.ts), so this
// reaches GateLab only if another program drops the mark.

/** The largest finite float32, the largest value an event of a float32 column can hold. */
export const FLOAT32_MAX = 3.4028234663852886e38;

/**
 * The ring's outer edge: the largest float32 plus 2^102, a double beyond every event a float32 can
 * hold, the largest float32 included, and short of the halfway point to 2^128 (the largest float32
 * plus 2^103), so a reader that parses it as float32 rounds it to the largest float32 and not to
 * Infinity.
 */
export const RING_OUTER = FLOAT32_MAX + 2 ** 102;

/**
 * A float64 column's ring's outer edge: half the largest double, beyond every value of the column
 * up to it, while a value's distance from any vertex within the ring stays a finite double.
 */
export const RING_OUTER_FLOAT64 = Number.MAX_VALUE / 2;

/** The values a column can hold, which decide where between two channels an edge can go. */
export type GridEdgeValues = "float32" | "integer" | "float64";

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/**
 * The float32 at an order key: keys run in the floats' order, 0 for zero, ±1 for the smallest
 * magnitudes, ±MAX_KEY for the largest finite ones.
 */
function fromOrderKey(k: number): number {
  u32[0] = k >= 0 ? k : 0x80000000 + -k;
  return f32[0];
}

const MAX_KEY = 0x7f7fffff; // the largest finite float32

const f64 = new Float64Array(1);
const i64 = new BigInt64Array(f64.buffer);
const MAX_KEY64 = 0x7fefffffffffffffn; // the largest finite double

/** The double at an order key, as fromOrderKey is for float32. */
function fromOrderKey64(k: bigint): number {
  i64[0] = k >= 0n ? k : BigInt.asIntN(64, -k | (1n << 63n));
  return f64[0];
}

/** The integers GateLab holds a column of exactly: within ±2^53. */
const MAX_INT = Number.MAX_SAFE_INTEGER;

/**
 * The raw value of every channel boundary: `edges[c]` (c = 1 … cells − 1) lies between the last
 * value the column can hold on channel c−1 and the first on channel c (see above for where, by
 * `values`). `edges[0]` and `edges[cells]` are the ring's outer edge, negated and not (RING_OUTER,
 * or RING_OUTER_FLOAT64 on a float64 column), and so is the edge of a channel no value reaches.
 */
export function flowJoGridEdges(spec: FlowJoGridSpec, values: GridEdgeValues = "float32"): Float64Array {
  const scale = flowJoGridScale(spec);
  const cells = scale.cells;
  const edges = new Float64Array(cells + 1);
  const outer = values === "float64" ? RING_OUTER_FLOAT64 : RING_OUTER;
  edges[0] = -outer;
  edges[cells] = outer;
  for (let c = 1; c < cells; c++) {
    if (values === "float32") {
      let lo = -MAX_KEY; // channel 0: everything this low is clamped there
      let hi = MAX_KEY;
      if (scale.eventCell(fromOrderKey(hi)) < c) {
        edges[c] = outer;
        continue;
      }
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (scale.eventCell(fromOrderKey(mid)) >= c) hi = mid;
        else lo = mid;
      }
      const first = fromOrderKey(hi);
      const below = fromOrderKey(hi - 1);
      edges[c] = below + (first - below) / 2;
    } else if (values === "integer") {
      let lo = -MAX_INT;
      let hi = MAX_INT;
      if (scale.eventCell(hi) < c) {
        edges[c] = outer;
        continue;
      }
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (scale.eventCell(mid) >= c) hi = mid;
        else lo = mid;
      }
      edges[c] = hi - 0.5;
    } else {
      let lo = -MAX_KEY64;
      let hi = MAX_KEY64;
      if (scale.eventCell(fromOrderKey64(hi)) < c) {
        edges[c] = outer;
        continue;
      }
      while (hi - lo > 1n) {
        const mid = lo + (hi - lo) / 2n;
        if (scale.eventCell(fromOrderKey64(mid)) >= c) hi = mid;
        else lo = mid;
      }
      edges[c] = fromOrderKey64(hi);
    }
  }
  return edges;
}

type Dir = 0 | 1 | 2 | 3; // right, up, left, down
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * The cells of the grid a polygon on integer channels selects: the channel pairs (cx, cy) in
 * 0 … nx − 1 and 0 … ny − 1 (FlowJoGridScale.cells on each axis) inside it or on its boundary.
 * `inside` is the membership test on integer points.
 */
export function flowJoGridCells(
  nx: number, ny: number, inside: (cx: number, cy: number) => boolean,
): Uint8Array {
  const cells = new Uint8Array(nx * ny);
  for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) if (inside(cx, cy)) cells[cy * nx + cx] = 1;
  return cells;
}

/**
 * The boundary loops of a set of cells, each a list of lattice corners with the direction the
 * boundary leaves it in, the region on the left (so outer loops run anticlockwise and holes
 * clockwise). Lattice point (i, j) is the corner where channels i−1 and i meet on x and j−1 and j
 * on y. At a point two diagonal cells share, the boundary turns left, which keeps two regions that
 * only touch at a corner apart.
 */
export function flowJoGridLoops(cells: Uint8Array, nx: number, ny: number): Array<Array<{ i: number; j: number; out: Dir }>> {
  const inSet = (cx: number, cy: number): boolean => cx >= 0 && cy >= 0 && cx < nx && cy < ny && cells[cy * nx + cx] === 1;
  // Unit edges keyed by their start point and direction.
  const W = nx + 1;
  const key = (i: number, j: number, d: Dir): number => ((j * W + i) << 2) | d;
  const edges = new Set<number>();
  for (let cy = 0; cy < ny; cy++) {
    for (let cx = 0; cx < nx; cx++) {
      if (!inSet(cx, cy)) continue;
      if (!inSet(cx, cy - 1)) edges.add(key(cx, cy, 0)); // bottom, going right
      if (!inSet(cx + 1, cy)) edges.add(key(cx + 1, cy, 1)); // right, going up
      if (!inSet(cx, cy + 1)) edges.add(key(cx + 1, cy + 1, 2)); // top, going left
      if (!inSet(cx - 1, cy)) edges.add(key(cx, cy + 1, 3)); // left, going down
    }
  }
  const loops: Array<Array<{ i: number; j: number; out: Dir }>> = [];
  while (edges.size) {
    const first = edges.values().next().value as number;
    let d = (first & 3) as Dir;
    const p0 = first >> 2;
    let i = p0 % W;
    let j = (p0 - i) / W;
    const loop: Array<{ i: number; j: number; out: Dir }> = [];
    const startI = i;
    const startJ = j;
    const startD = d;
    let guard = 0;
    for (;;) {
      edges.delete(key(i, j, d));
      const ni = i + DX[d];
      const nj = j + DY[d];
      // Prefer a left turn, then straight on, then a right turn.
      const options: Dir[] = [((d + 1) % 4) as Dir, d, ((d + 3) % 4) as Dir];
      const next = options.find((nd) => edges.has(key(ni, nj, nd)));
      if (next === undefined) {
        if (ni !== startI || nj !== startJ) throw new Error("A grid region's boundary did not close.");
        if (d !== startD) loop.push({ i: startI, j: startJ, out: startD });
        break;
      }
      if (next !== d) loop.push({ i: ni, j: nj, out: next });
      i = ni;
      j = nj;
      d = next;
      if (++guard > 4 * (nx + 1) * (ny + 1)) throw new Error("A grid region's boundary did not close.");
    }
    // The start point was recorded above only if the loop turns there.
    loops.push(loop);
  }
  return loops;
}

/**
 * A grid polygon as the rectilinear ring, in raw units, that holds exactly the events it selects.
 * `xEdges`/`yEdges` come from flowJoGridEdges, `cells` from flowJoGridCells. Null when the polygon
 * selects no channel pair at all.
 */
export function flowJoGridRing(
  cells: Uint8Array, nx: number, ny: number, xEdges: Float64Array, yEdges: Float64Array,
): Vertex[] | null {
  const loops = flowJoGridLoops(cells, nx, ny);
  if (!loops.length) return null;
  // The main ring is the largest loop, measured in lattice units.
  const latticeArea = (loop: Array<{ i: number; j: number }>): number => {
    let a = 0;
    for (let k = 0, m = loop.length - 1; k < loop.length; m = k++) a += (loop[m].i - loop[k].i) * (loop[m].j + loop[k].j);
    return a / 2;
  };
  let main = 0;
  for (let k = 1; k < loops.length; k++) if (latticeArea(loops[k]) > latticeArea(loops[main])) main = k;
  const toVertices = (loop: Array<{ i: number; j: number }>): Vertex[] => loop.map((p) => [xEdges[p.i], yEdges[p.j]]);
  let ring = toVertices(loops[main]);
  for (let k = 0; k < loops.length; k++) {
    if (k === main) continue;
    // Out from the ring's first corner along its y to the x of the other loop's first corner,
    // round that loop, and back: every leg on an edge coordinate, so no event lies on it.
    const other = toVertices(loops[k]);
    const from = ring[0];
    const to = other[0];
    const elbow: Vertex = [to[0], from[1]];
    ring = [from, elbow, ...other, to, elbow, ...ring];
  }
  return ring;
}

// ── GateLab's own mark on an exported grid polygon ───────────────────────────────────────────

/**
 * The custom_info element GateLab writes on a grid polygon it exports to Gating-ML: the grid
 * itself (both axes' specs), the polygon's vertices on its channels, and FlowJo's raw vertices
 * when the gate still carries them. GateLab restores the grid gate from it, while every other
 * reader evaluates the written ring, which selects the same events (flowJoGridRing).
 */
export const GATINGML_GRID_TAG = "gatelab_flowjo_grid";

export interface FlowJoGridMark {
  version: 1;
  x: FlowJoGridSpec;
  y: FlowJoGridSpec;
  /** The polygon's vertices on its channels, as GateLab holds them. */
  vertices: Vertex[];
  /** FlowJo's raw vertices (PolyRectGate.flowjo_vertices), when the gate has them. */
  raw?: Vertex[];
  /** fingerprintRing of the ring written beside it; the mark is honoured only while that holds. */
  written: string;
}

/**
 * A coordinate to 15 significant digits, for the fingerprint only. The exporter writes every
 * coordinate in full (gatingmlExport.fmtNum), and the fingerprint is taken of the doubles on both
 * sides, the written ring and the ring read back, so rounding both alike changes no fingerprint.
 */
function fmt15(x: number): string {
  if (!Number.isFinite(x) || x === 0) return "0";
  let s = x.toPrecision(15);
  if (!/e/i.test(s) && s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/**
 * A short fingerprint of a ring as written: its vertex count and an FNV-1a hash of its
 * coordinates at 15 significant digits. A ring edited by another program no longer matches, and
 * GateLab then reads the ring as written rather than a grid gate it no longer describes.
 */
export function fingerprintRing(ring: readonly Vertex[]): string {
  let h = 0x811c9dc5;
  const text = ring.map(([x, y]) => `${fmt15(x)},${fmt15(y)}`).join(";");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${ring.length}:${h.toString(16).padStart(8, "0")}`;
}

const integerPair = (v: unknown): v is Vertex =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isInteger(n));
const finitePairValue = (v: unknown): v is Vertex =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/** Read a grid mark, or null when any part of it is missing or malformed. */
export function parseFlowJoGridMark(text: string): FlowJoGridMark | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || v.version !== 1 || typeof v.written !== "string") return null;
  const x = parseFlowJoGridSpec(v.x);
  const y = parseFlowJoGridSpec(v.y);
  const vertices = v.vertices;
  if (!x || !y || !Array.isArray(vertices) || vertices.length < 3 || !vertices.every(integerPair)) return null;
  const raw = v.raw;
  const rawOk = Array.isArray(raw) && raw.length === vertices.length && raw.every(finitePairValue);
  return {
    version: 1, x, y,
    vertices: vertices.map(([a, b]) => [a, b] as Vertex),
    ...(rawOk ? { raw: (raw as Vertex[]).map(([a, b]) => [a, b] as Vertex) } : {}),
    written: v.written,
  };
}
