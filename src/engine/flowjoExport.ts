/**
 * Write the workspace as a FlowJo workspace (`.wsp`).
 *
 * Why this exists: BD FACSChorus, the acquisition and sort software of the FACSDiscover S8, can
 * import sort gates from a FlowJo workspace but from nothing else, so a strategy drawn in GateLab
 * had no way onto the sorter. FlowJo itself is the other reader. Neither publishes its format;
 * both were built against what FlowJo writes, so this module writes what FlowJo writes — the
 * layout of a FlowJo 10.10 workspace saved from an S8 file, read off real workspaces — and the
 * importer in flowjoWorkspace.ts, which reads real FlowJo files, is what reads the result back.
 *
 * The file's model, and how GateLab's is mapped onto it:
 *
 *   • One `<Sample>` per loaded file, holding the tree of the hierarchy that file is gated
 *     under. FlowJo has no shared gate table: every sample carries its own copy of every gate.
 *   • Gate vertices are written in RAW values, as FlowJo stores them, and FlowJo evaluates the
 *     gate as straight lines in the space the axis is DISPLAYED in, declared per parameter in
 *     the sample's `<Transformations>` block. That block is written in FlowJo's own vocabulary
 *     — linear for scatter and time, biex for flow fluorescence, log where a gate arrived from
 *     FlowJo or Gating-ML with a log axis, fasinh for mass cytometry, and an imported gate's own
 *     biex verbatim — because the readers were built against that vocabulary and nothing else. A
 *     log or a gate's own biex gives way to FlowJo's default where another gate on the parameter
 *     reaches below its floor with events below it (axisMisreadsOtherGates), and a gate on that
 *     floor then goes out cut at the floor and skirted below it (cutBelowFloor, skirtFloor), or,
 *     with nothing above the floor, where it holds what GateLab holds there (floorOnlyRing).
 *   • A gate whose vertices are straight in the declared space is written verbatim and is exact.
 *     A polygon straight in some other space (GateLab's default raw space for flow, or a logicle
 *     display) is densified: its boundary is sampled in the declared display until a straight
 *     chord between samples stays within 0.1% of the gate's extent, so the file's gate is the
 *     same boundary to well under a pixel, at the cost of vertices. Rectangles need nothing —
 *     an axis-aligned box is a box under any monotonic axis. An ellipse is written in FlowJo's
 *     foci form when the gate's space maps affinely onto the declared display, and as its
 *     sampled boundary otherwise. A quadrant gate is written the way FlowJo writes its own:
 *     four polygons reaching the axis limits, `quadId` 0–3; bent arms follow the curl.
 *   • FlowJo tests every polygon on its 256-channel gate grid, not on the boundary: where the
 *     grid reads a polygon's events of this file otherwise than GateLab holds them, an
 *     axis-aligned one goes out as a rectangle, which FlowJo does not grid, another has its
 *     vertices moved onto the grid where that reads it exactly, and the rest are named with the
 *     number of events FlowJo reads otherwise ("A written polygon as FlowJo's grid reads it").
 *   • A population that excludes a gate, or intersects several, is written as FlowJo's
 *     `<NotNode>` / `<AndNode>` (`<OrNode>` for OR), which name sibling populations rather
 *     than gates, so a helper population holding each referenced gate is written beside it.
 *   • Compensation: with a matrix active, gates on its channels name `Comp-` parameters and the
 *     matrix is written into the sample, in FlowJo's `<transforms:spilloverMatrix>` form.
 *   • Time is written in seconds, `$TIMESTEP` applied, because that is how FlowJo stores it.
 *
 * What is not carried, and is reported: nothing silently. Every densified polygon, ellipse
 * written as a polygon, quadrant written as four, helper population and skipped population is
 * named in the warnings the caller shows before the file is saved, and so is every polygon
 * FlowJo's grid reads otherwise than GateLab.
 *
 * Verified by round trip (flowjoExport.test.ts): export → the FlowJo importer → the same engine
 * assigns the same events, exactly for rectangles, quadrants, declared-space gates and FlowJo's
 * own re-exported gates, and within the densification bound for the rest. FACSChorus itself is
 * not on this machine; what it accepts beyond what FlowJo writes is not documented.
 */

import type { Sample } from "./sample";
import { UNBOUNDED, isUnbounded, type EllipseGate, type FlowJoGridAxis, type Gate, type GateRef, type PolyRectGate, type PopulationMap, type QuadrantGate, type TransformSpec, type Vertex } from "./models";
import { FLOWJO_BIEX_TABLE_CHANNELS, biexBreakpoints, biexTransform, wspLogTransform, type BiexParams } from "./biex";
import { flowJoGridScale, isFlowJoGridGate, isFlowJoGridSpec, logVertexAtZeroOnFloor, parseFlowJoGridAxis, type FlowJoGridScale, type FlowJoGridSpec } from "./flowjoGrid";
import { axesFromCovariance, ellipseBoundary } from "./ellipse";
import { columnsForGate, gateMaskPolygon, getGateMask, quadrantArmPoints, upperBoundForReader } from "./gates";
import { rectangleRule } from "./models";
import { WSP_RECTANGLE_ATTR, rectangleRecordOf, writtenRectangleBounds } from "./rectangleRecord";
import { WSP_POLYGON_ATTR, polygonRecordOf, writtenPolygonCoordinates } from "./polygonRecord";
import { WSP_ONE_TREE_ATTR, WSP_OPERAND_ATTR, WSP_OPERAND_SLASH } from "./flowjoWorkspace";
import { applyGatingStrategy } from "./populations";
import { collapseDensifiedRing, fmtNum } from "./gatingmlExport";
import { polygonOutline } from "../plots/gatePayload";
import { flowJoFolderUri } from "./flowjoExportFolder";

/** One loaded file and the tree it is gated under. */
export interface FlowJoExportSample {
  sample: Sample;
  /** The FCS file name FlowJo and FACSChorus will look for. */
  fileName: string;
  /**
   * Where the file sits relative to the workspace, "/"-separated, when the export writes the
   * files beside it (flowjoExportFolder.ts). The DataSet uri is then this path with each segment
   * percent-encoded, which FlowJo, FlowKit and GateLab resolve against the .wsp's folder, and the
   * SampleNode is named by its last segment, the name written: `fileName` unless Chrome would not
   * write that name. Groups still name the sample by `fileName`.
   */
  folderPath?: string;
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string;
}

export interface FlowJoExportOpts {
  samples: FlowJoExportSample[];
  /** GateLab's groups, written as FlowJo groups: each names the files (by `fileName`) in it. */
  groups?: readonly { name: string; fileNames: readonly string[] }[];
  /** Written as the workspace's modification time; injectable for deterministic tests. */
  now?: Date;
  /** Named in a comment at the top of the file, e.g. "GateLab 0.7.7". */
  producer?: string;
  /**
   * Skip the per-population event counts. Counts mean evaluating every population of every
   * sample; the export dialog's preview wants the warnings without that.
   */
  withoutCounts?: boolean;
}

export interface FlowJoExportResult {
  xml: string;
  /** Everything that was approximated, added or left out, in the order met. */
  warnings: string[];
  sampleCount: number;
  /** Gate elements written across every sample. */
  gateCount: number;
}

/** FlowJo's display resolution: every biex in a 433-workspace corpus declares length 256. */
const FLOWJO_CHANNELS = 256;
/** The file format this module writes, which is what the readers were built against. */
const FLOWJO_VERSION = "10.10.0";
/** Half the 0.2% documented densification bound on subdivision, half on collapse. */
const DENSIFY_TOL = 0.001;

const GATING_NS = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const TRANSFORMS_NS = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";
const DATATYPE_NS = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";

const escAttr = (s: string): string =>
  String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** FlowJo's parameter names: the FCS `$PnN`, never GateLab's display key. */
const isTimeAxis = (name: string): boolean => /^time$/i.test(name.trim());

/** x rounded UP to a half decade: 262144 → 316227.77 (10^5.5), as FlowJo's biex tops are. */
function halfDecadeCeil(x: number): number {
  if (!(x > 0)) return 1e4;
  return Math.pow(10, Math.ceil(2 * Math.log10(x)) / 2);
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** Where Gating-ML's flog(x; T, M) is 0: FlowJo's log offset for the same axis, T·10^-M. */
const flogOffset = (spec: { T: number; M: number }): number => spec.T * Math.pow(10, -spec.M);

// ── Axes: what the file declares for each parameter ─────────────────────────────────────────

type AxisDecl =
  | { kind: "linear"; minRange: number; maxRange: number }
  | { kind: "log"; offset: number; decades: number }
  | { kind: "biex"; params: BiexParams }
  | { kind: "fasinh"; T: number; M: number; A: number };

/**
 * A number as JavaScript's shortest round-trip form, which reads back as the same double, as fmtNum
 * writes it since fix/gatingml-hardening (15 significant digits before). Every axis parameter and
 * polygon vertex is written this way: FlowJo grids a polygon on the declared axis, and a vertex
 * written short can move from within about 5e-15 of a channel boundary onto the next channel; and
 * an axis written short is another axis, on which a continuous polygon's vertex at an end of the
 * display (a quadrant panel's, a NOT panel's) no longer lies exactly at that end, so the events
 * FlowJo and GateLab pin there fall outside it. A non-finite value goes through fmtNum, which
 * refuses it.
 */
function fmtExact(x: number): string {
  return Number.isFinite(x) ? String(x === 0 ? 0 : x) : fmtNum(x);
}

interface Axis {
  /** GateLab channel key. */
  key: string;
  /** The parameter name written into the file, `Comp-` prefixed when compensated. */
  name: string;
  decl: AxisDecl;
  /** File value (raw, or seconds for Time) → FlowJo display channel, 0..256. */
  forward(v: number): number;
  /** FlowJo display channel → file value. */
  inverse(c: number): number;
  /** GateLab raw → file value: 1, or `$TIMESTEP` for the Time parameter. */
  fileScale: number;
  /** The axis as FlowJo draws it, in file values, for bounding a quadrant. */
  range: [number, number];
  /** Whether a gate straight in `spec` (GateLab's space) is straight in this display. */
  straightIn(spec: TransformSpec): boolean;
}

function transformXml(decl: AxisDecl, name: string): string[] {
  const p = `<data-type:parameter data-type:name="${escAttr(name)}" />`;
  const num = fmtExact;
  switch (decl.kind) {
    case "linear":
      return [
        `<transforms:linear transforms:minRange="${num(decl.minRange)}" transforms:maxRange="${num(decl.maxRange)}" gain="1">`,
        `  ${p}`, "</transforms:linear>",
      ];
    case "log":
      return [
        `<transforms:log transforms:offset="${num(decl.offset)}" transforms:decades="${num(decl.decades)}">`,
        `  ${p}`, "</transforms:log>",
      ];
    case "biex": {
      const b = decl.params;
      return [
        `<transforms:biex transforms:length="${b.channelRange}" transforms:maxRange="${num(b.maxValue)}" transforms:neg="${num(b.neg)}" transforms:width="${num(b.widthBasis)}" transforms:pos="${num(b.pos)}">`,
        `  ${p}`, "</transforms:biex>",
      ];
    }
    case "fasinh":
      // FlowJo writes maxRange = T and W = -T beside Gating-ML's T, M and A.
      return [
        `<transforms:fasinh transforms:length="${FLOWJO_CHANNELS}" transforms:maxRange="${num(decl.T)}" transforms:T="${num(decl.T)}" transforms:A="${num(decl.A)}" transforms:M="${num(decl.M)}" transforms:W="${num(-decl.T)}">`,
        `  ${p}`, "</transforms:fasinh>",
      ];
  }
}

/** The forward/inverse pair and axis range of a declaration, in file values. */
function axisMaps(decl: AxisDecl): Pick<Axis, "forward" | "inverse" | "range"> {
  switch (decl.kind) {
    case "linear": {
      const { minRange, maxRange } = decl;
      const span = maxRange - minRange;
      return {
        forward: (v) => (FLOWJO_CHANNELS * (v - minRange)) / span,
        inverse: (c) => minRange + (c / FLOWJO_CHANNELS) * span,
        range: [minRange, maxRange],
      };
    }
    case "log": {
      const t = wspLogTransform({ offset: decl.offset, decades: decl.decades });
      return {
        forward: (v) => FLOWJO_CHANNELS * t.forward(v),
        inverse: (c) => t.inverse(c / FLOWJO_CHANNELS),
        range: [decl.offset, decl.offset * Math.pow(10, decl.decades)],
      };
    }
    case "biex": {
      // biexTransform is built with channelRange = length, so forward returns channel numbers.
      const t = biexTransform(decl.params);
      return { forward: t.forward, inverse: t.inverse, range: [t.inverse(0), decl.params.maxValue] };
    }
    case "fasinh": {
      const { T, M, A } = decl;
      const k = Math.sinh(M * Math.LN10) / T;
      const den = (M + A) * Math.LN10;
      return {
        forward: (v) => (FLOWJO_CHANNELS * (Math.asinh(v * k) + A * Math.LN10)) / den,
        inverse: (c) => Math.sinh((c / FLOWJO_CHANNELS) * den - A * Math.LN10) / k,
        range: [-T, T],
      };
    }
  }
}

/** Whether a gate straight in GateLab's `spec` is straight in the declared display. */
function straightIn(decl: AxisDecl, spec: TransformSpec): boolean {
  switch (decl.kind) {
    case "linear":
      // A grid axis is "straight" in a declaration of the very axis FlowJo grids it on: FlowJo
      // then re-rounds the written vertices onto the same channels.
      if (spec.kind === "flowjoChannels") {
        return spec.axis.kind === "linear" && near(spec.axis.minRange, decl.minRange) && near(spec.axis.maxRange, decl.maxRange);
      }
      return spec.kind === "identity";
    case "log":
      if (spec.kind === "flowjoChannels") {
        return spec.axis.kind === "wsplog" && near(spec.axis.offset, decl.offset) && near(spec.axis.decades, decl.decades);
      }
      // FlowJo's log with offset O and D decades is log10(x / O) / D; Gating-ML's flog(x; T, M) is
      // log10(x / T) / M + 1 = log10(x / (T·10^-M)) / M, the same log with O = T·10^-M and D = M.
      return (spec.kind === "wsplog" && near(spec.offset, decl.offset) && near(spec.decades, decl.decades))
        || (spec.kind === "flog" && near(flogOffset(spec), decl.offset) && near(spec.M, decl.decades));
    case "biex": {
      // FlowJo reads the declaration on its own 4096-channel table, so a gate is straight in it
      // only on that table too: a gate saved on the older table (biex.ts) is densified.
      const b = decl.params;
      const same = (p: BiexParams): boolean => near(p.maxValue, b.maxValue) && near(p.pos, b.pos)
        && near(p.neg, b.neg) && near(p.widthBasis, b.widthBasis) && p.channelRange === b.channelRange;
      if (spec.kind === "flowjoChannels") return spec.axis.kind === "biex" && same(spec.axis);
      return spec.kind === "biex" && same(spec) && spec.tableChannels === FLOWJO_BIEX_TABLE_CHANNELS;
    }
    case "fasinh":
      // fasinh(x; T, M, A) is affine in asinh(x · sinh(M ln10) / T), whatever A is.
      return spec.kind === "asinh" && near(spec.cofactor, decl.T / Math.sinh(decl.M * Math.LN10));
  }
}

/**
 * The space a gate's vertices are straight in, per axis: identity for a raw gate, else the
 * transform it recorded (or, for a legacy CyTOF gate that recorded none, the current display).
 */
function gateSpec(sample: Sample, gate: Gate, channel: string): TransformSpec {
  if (sample.gateSpace(gate) === "raw") return { kind: "identity" };
  return gate.transforms?.[channel] ?? sample.transformSpec(channel);
}

/** FlowJo's default biex for a new sample, by instrument. */
function defaultBiex(sample: Sample, range: number): BiexParams {
  const cyt = sample.fcs.keywords["$CYT"] ?? "";
  // The S8's cytometer rule in FlowJo: "Log Parameters (A) -> Biex", read off a saved workspace.
  if (/FACSDiscover|FACSChorus/i.test(cyt)) {
    return {
      maxValue: 9999999.999999998, pos: 5, neg: 0, widthBasis: -100, channelRange: FLOWJO_CHANNELS,
      tableChannels: FLOWJO_BIEX_TABLE_CHANNELS,
    };
  }
  return {
    maxValue: halfDecadeCeil(range), pos: 4.5, neg: 0, widthBasis: -10, channelRange: FLOWJO_CHANNELS,
    tableChannels: FLOWJO_BIEX_TABLE_CHANNELS,
  };
}

/**
 * The candidate width bases for a default biex, FlowJo's -10 first. FlowJo itself writes any
 * negative value here (-22.68, -36.91, -60.32 on one published workspace), so nothing about the
 * ladder is special beyond covering four decades of negative range.
 */
const WIDTH_BASIS_LADDER = [-10, -20, -50, -100, -200, -500, -1000, -2000, -5000, -10000, -20000, -50000, -100000];

/**
 * FlowJo's biex "extra negative decades", tried in turn where no width reaches on the base's own. No
 * more than one: from 1.5 decades at the wider widths, GateLab's 256-channel biex table and the
 * interoperability tester's port of cytolib's part by a few parts in a million (fail:transform on a
 * 316 top with 1.5 decades at width -1,000), which a declaration should not depend on.
 */
const NEG_DECADES_LADDER = [0.5, 1];

/**
 * A biex declaration whose display reaches down to `needMin`, the most negative raw value any
 * gate on this parameter has to show. The default width basis of -10 puts the floor of the
 * display at about -113 on a 316,228 top; a polygon vertex at -611 is then traced in a space
 * that cannot hold it, and comes out at the floor. That moved two gates of a published strategy
 * on their way through GateLab (2026-09-16). Widening the width basis lowers the floor and
 * changes nothing above zero except the linear region near it, which is what FlowJo's own
 * auto-width does.
 */
function coveringBiex(base: BiexParams, needMin: number | undefined): { params: BiexParams; covered: boolean } {
  if (needMin === undefined || !Number.isFinite(needMin) || needMin >= 0) return { params: base, covered: true };
  const target = needMin * 1.05;
  const ladder = [base.widthBasis, ...WIDTH_BASIS_LADDER.filter((w) => w < base.widthBasis)];
  // Where no width reaches, the one whose floor lies lowest. The floor does not keep falling down
  // the ladder: past about -1,000 the biex clamps its width, and on a 316,228 top the floor jumps
  // from -15,828 back up to -27. Taking the last width tried declared that floor for a gate reaching
  // -1e9, and a raw ellipse reaching -2,691 beside it went out clipped at -27 (random-0005
  // "Lymphocytes" in the interoperability sweep, 22 events FlowJo moves onto the floor and reads
  // otherwise, fail:flowjo-axis-range).
  let lowest = base;
  let lowestFloor = Infinity;
  // Then FlowJo's extra negative decades, where no width reaches on the base's own: on a 1,000 top
  // the widest width reaches -50, and a range from -52.2 went out with its lower bound below the
  // floor, where FlowJo moves the events below it into the range (the public MACSQuant file's FL2-W).
  // Where none reaches, the base's own negative decades, as before.
  // (The widest reach this adds on a 1,000 top is -341, at one decade and width -1,000.)
  for (const neg of [base.neg, ...NEG_DECADES_LADDER.filter((n) => n > base.neg)]) {
    for (const widthBasis of ladder) {
      const params = { ...base, neg, widthBasis };
      let floor: number;
      try {
        floor = biexTransform(params).inverse(0);
      } catch {
        break;
      }
      if (floor <= target) return { params, covered: true };
      if (neg === base.neg && floor < lowestFloor) {
        lowest = params;
        lowestFloor = floor;
      }
    }
  }
  return { params: lowest, covered: false };
}

/** Extent of a channel's raw values, sampled; null for an empty column. */
function columnExtent(sample: Sample, idx: number): [number, number] | null {
  const raw = sample.rawColumnData(idx);
  const n = raw.length;
  if (!n) return null;
  let lo = Infinity;
  let hi = -Infinity;
  const step = Math.max(1, Math.floor(n / 50000));
  for (let j = 0; j < n; j += step) {
    const v = raw[j];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null;
}

/**
 * The raw value at or below which GateLab's own transform puts an event on the display's floor: a
 * FlowJo log's offset, a floored flog's T·10^-M (biex.ts wspLogTransform, flogTransform); null for
 * any other space, and for Gating-ML's own flog (`standard`, #350), which has no floor.
 */
function logClampOf(spec: TransformSpec): number | null {
  if (spec.kind === "wsplog") return spec.offset;
  if (spec.kind === "flog" && !spec.standard) return flogOffset(spec);
  return null;
}

/**
 * The raw value at or below which GateLab's own transform puts an event on the display's floor, the
 * lowest value that display shows: a FlowJo log's offset or a floored flog's T·10^-M (logClampOf),
 * and a biex table's first entry, below which biexTransform pins every value (biex.ts); null for any
 * other space, for Gating-ML's own flog, which has no floor, and for FlowJo's grid, whose polygons go
 * out on their own axis (declareAxis).
 */
function floorOf(spec: TransformSpec): number | null {
  const log = logClampOf(spec);
  if (log !== null) return log;
  if (spec.kind !== "biex") return null;
  try {
    const t = biexTransform(spec);
    const floor = t.inverse(t.forward(-Number.MAX_VALUE));
    return Number.isFinite(floor) ? floor : null;
  } catch {
    return null;
  }
}

/**
 * Whether the declared axis moves the events below a gate's floor (floorOf) onto that very value
 * before FlowJo tests the gate, as GateLab puts them on its floor: a log axis from that offset, or a
 * biex whose table on FlowJo's 4096 channels begins there (clampEdges). A biex GateLab draws on its
 * own 256-channel table does not begin where FlowJo's table for the same parameters begins (-93.5
 * against -132.3 at width -10 on a 262,144 top), so on such an axis, and on any other, a gate that
 * reaches its floor holds the events below it through a skirt (skirtFloor) or an open bound.
 */
function clampsAtFloor(decl: AxisDecl, clamp: number): boolean {
  if (decl.kind === "log") return near(decl.offset, clamp);
  if (decl.kind === "biex") return near(clampEdges(decl)[0], clamp);
  return false;
}

/**
 * A ring in its gate's own space cut off below the floor of its space on axis `k` (a value `floor`
 * there, floorOf in gate units): GateLab puts every event below the floor on it, so what the gate
 * holds below the floor is what it holds on it, and the part of the ring below it holds nothing
 * GateLab gates. Written on an axis that does not move those events onto the floor, the cut ring's
 * edges on the floor are then skirted down past every event (skirtFloor), and FlowJo reads the gate
 * as GateLab holds it; written uncut, its part below the floor went out as raw values below the
 * floor, at which no event is on GateLab's floor (random-0040, an ellipse on FlowJo's log held on the
 * log for itself, took the events below -175 into a rectangle beside it). `corners` are the ring's
 * vertices to keep as corners, where it has any (a quadrant's box and crosshair, an ellipse's
 * start); a vertex made where an edge crosses the floor is one. Null where nothing lies below the
 * floor, and an empty ring where everything does.
 */
function cutBelowFloor(ring: readonly Vertex[], k: 0 | 1, floor: number, corners?: readonly number[]): { ring: Vertex[]; corners?: number[] } | null {
  if (!ring.some((v) => v[k] < floor)) return null;
  const isCorner = (i: number) => corners === undefined || corners.includes(i);
  const out: Vertex[] = [];
  const flags: boolean[] = [];
  const push = (v: Vertex, corner: boolean) => {
    const last = out[out.length - 1];
    if (last && last[0] === v[0] && last[1] === v[1]) { flags[flags.length - 1] ||= corner; return; }
    out.push(v);
    flags.push(corner);
  };
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const aIn = a[k] >= floor;
    const bIn = b[k] >= floor;
    if (aIn) push(a, isCorner(i));
    if (aIn !== bIn) {
      const t = (floor - a[k]) / (b[k] - a[k]);
      const o = 1 - k;
      const at = a[o] + t * (b[o] - a[o]);
      push(k === 0 ? [floor, at] : [at, floor], true);
    }
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) {
    flags[0] ||= flags[flags.length - 1];
    out.pop();
    flags.pop();
  }
  if (out.length < 3) return { ring: [], ...(corners ? { corners: [] } : {}) };
  return { ring: out, ...(corners ? { corners: flags.flatMap((c, i) => (c ? [i] : [])) } : {}) };
}

/**
 * A raw value at which an empty rectangle is written so that it holds none of this file's events for
 * any reader: inside the declared axis, above where FlowJo moves events and below its top, halfway
 * across the widest gap the declared display shows between two neighbouring values of the file (or
 * between the axis's floor and the lowest value). Written below every event, as until 2026-09-26,
 * a reader that pins a value below a biex table to the table's first channel (FlowKit, np.interp)
 * put the bound there with every event below the table, and held 786 events where GateLab holds
 * none (the release candidate's verifier). Below every event where the axis holds no value of the
 * file.
 */
function emptyAt(sample: Sample, channel: string, a: Axis): number {
  const idx = sample.index(channel);
  const column = idx === undefined ? null : sample.rawColumnData(idx);
  const [edgeLo, edgeHi] = clampEdges(a.decl);
  const lo = Math.max(edgeLo, a.range[0]) / a.fileScale;
  const hi = Math.min(edgeHi, a.range[1]) / a.fileScale;
  const fallback = belowEveryEvent(sample, channel);
  if (!column || !(lo < hi)) return fallback;
  const inside: number[] = [];
  for (let i = 0; i < column.length; i++) {
    const v = column[i];
    if (v > lo && v < hi) inside.push(v);
  }
  const values = Float64Array.from(inside).sort();
  const shown = (v: number) => a.forward(v * a.fileScale);
  let best = NaN;
  let widest = 0;
  let prev = lo;
  for (const v of [...values, hi]) {
    if (v > prev) {
      const gap = shown(v) - shown(prev);
      const mid = prev + (v - prev) / 2;
      if (gap > widest && mid > prev && mid < v && shown(mid) > shown(prev) && shown(mid) < shown(v)) {
        widest = gap;
        best = mid;
      }
    }
    prev = v;
  }
  return Number.isFinite(best) ? best : fallback;
}

/** A raw value below every event of a channel (and below its declared biex table, far enough). */
function belowEveryEvent(sample: Sample, channel: string): number {
  const idx = sample.index(channel);
  const extent = idx === undefined ? null : columnExtent(sample, idx);
  const lo = extent ? Math.min(extent[0], 0) : 0;
  const span = extent ? Math.max(extent[1] - extent[0], 1) : 1;
  return lo - span;
}

/**
 * A polygon or an ellipse's boundary on a FlowJo log, a floored flog or a biex with nothing above its
 * floor on axis `k` (floorOf), as the file should hold it on an axis that does not move the events
 * below the floor onto that value (clampsAtFloor), in file values. GateLab puts every event below the
 * floor on it, so such a gate holds only events it places on the floor, where its edge runs along the
 * floor from below, and none where it lies wholly below. Cut at the floor it leaves no ring
 * (cutBelowFloor), which polygonXml took for a quadrant's and wrote as drawn, until 2026-09-26: raw
 * values below the floor, where events lie that GateLab places on the floor and so outside the gate.
 * FlowKit held 43 events of such a polygon and 4 of such an ellipse where GateLab holds none (the
 * release candidate's verifier, on a channel declared biex for a raw range beside them).
 *
 * Where the gate holds no event of the file, it goes where none lies for any reader, as an empty
 * rectangle does (emptyAt): a band about that value reaching half the way to the nearest value either
 * side, across the gate's own extent on the other axis. Where it holds some, it goes as a strip over
 * them: on axis `k` from past every event (and past where the declared axis moves an event below its
 * end) up to halfway between the highest of them and the next value above it, and on the other axis
 * over each run of them among the events at or below that height, from halfway to the event before
 * the run that it leaves out to halfway to the one after it (the gate's own extent there where that
 * lies between, and past every event where there is none). No event lies on an edge, so every reader
 * holds what GateLab holds, whichever edges it keeps.
 */
function floorOnlyRing(sample: Sample, gate: Gate, ring: readonly Vertex[], k: 0 | 1, ax: Axis, ay: Axis): Vertex[] {
  const o = (1 - k) as 0 | 1;
  const [a, b] = k === 0 ? [ax, ay] : [ay, ax];
  const [chK, chO] = k === 0 ? [gate.x_channel, gate.y_channel] : [gate.y_channel, gate.x_channel];
  const at = (kv: number, ov: number): Vertex => (k === 0 ? [kv, ov] : [ov, kv]);
  const idxK = sample.index(chK);
  const idxO = sample.index(chO);
  const rk = idxK === undefined ? null : sample.rawColumnData(idxK);
  const ro = idxO === undefined ? null : sample.rawColumnData(idxO);
  // The gate's own extent on the other axis, raw.
  let [oMin, oMax] = [Infinity, -Infinity];
  for (const p of ring) {
    const v = sample.gateToRaw(gate, chO, p[o]);
    if (!Number.isFinite(v)) continue;
    if (v < oMin) oMin = v;
    if (v > oMax) oMax = v;
  }
  if (!(oMin <= oMax)) [oMin, oMax] = [0, 0];
  const held = getGateMask(gate, columnsForGate(sample.gateAssayData(), gate));
  let top = -Infinity;
  if (rk && ro) for (let i = 0; i < held.length; i++) if (held[i] && rk[i] > top && Number.isFinite(ro[i])) top = rk[i];
  if (!rk || !ro || !Number.isFinite(top)) {
    const e = emptyAt(sample, chK, a);
    const [edgeLo, edgeHi] = clampEdges(a.decl);
    let lo = Math.max(edgeLo, a.range[0]) / a.fileScale;
    let hi = Math.min(edgeHi, a.range[1]) / a.fileScale;
    if (rk) for (let i = 0; i < rk.length; i++) {
      const v = rk[i];
      if (v < e && v > lo) lo = v;
      if (v > e && v < hi) hi = v;
    }
    const h = Math.min(e - lo, hi - e) / 2;
    const [kLo, kHi] = h > 0 && Number.isFinite(h) ? [e - h, e + h] : [e, e];
    return [
      at(kLo * a.fileScale, oMin * b.fileScale), at(kLo * a.fileScale, oMax * b.fileScale),
      at(kHi * a.fileScale, oMax * b.fileScale), at(kHi * a.fileScale, oMin * b.fileScale),
    ];
  }
  let next = Infinity;
  for (let i = 0; i < rk.length; i++) if (rk[i] > top && rk[i] < next) next = rk[i];
  const kTop = Number.isFinite(next) ? top + (next - top) / 2 : top + Math.abs(top) + 1;
  const endK = clampEdges(a.decl)[0];
  const kBottom = Math.min(belowEveryEvent(sample, chK) * a.fileScale, Number.isFinite(endK) ? endK - Math.abs(endK) - 1 : Infinity);
  // Past every event on the other axis, and past where the declared axis moves an event beyond its ends.
  const [endLo, endHi] = clampEdges(b.decl);
  const extent = idxO === undefined ? null : columnExtent(sample, idxO);
  const span = extent ? Math.max(extent[1] - extent[0], 1) : 1;
  const pastLo = Math.min(belowEveryEvent(sample, chO), Number.isFinite(endLo) ? (endLo - Math.abs(endLo) - 1) / b.fileScale : Infinity);
  const pastHi = Math.max((extent ? Math.max(extent[1], 0) : 0) + span, Number.isFinite(endHi) ? (endHi + Math.abs(endHi) + 1) / b.fileScale : -Infinity);
  const low: number[] = [];
  for (let i = 0; i < rk.length; i++) if (rk[i] <= top && Number.isFinite(ro[i])) low.push(i);
  low.sort((p, q) => ro[p] - ro[q]);
  // Each run down one side and up the other, the runs joined along the top, where no event lies: a
  // join along the bottom lies where a reader pinning a value below the declared axis to its end puts
  // every event below it (GateLab, FlowKit), and one keeping its edges held those between the runs.
  const out: Vertex[] = [];
  for (let j = 0; j < low.length;) {
    if (!held[low[j]]) { j++; continue; }
    let e = j;
    while (e + 1 < low.length && held[low[e + 1]]) e++;
    const [first, last] = [ro[low[j]], ro[low[e]]];
    const before = j > 0 ? ro[low[j - 1]] : null;
    const after = e + 1 < low.length ? ro[low[e + 1]] : null;
    const lo = oMin < first && (before === null || oMin > before) ? oMin
      : before === null ? pastLo : before < first ? before + (first - before) / 2 : first;
    const hi = oMax > last && (after === null || oMax < after) ? oMax
      : after === null ? pastHi : after > last ? last + (after - last) / 2 : last;
    out.push(
      at(kTop * a.fileScale, lo * b.fileScale), at(kBottom, lo * b.fileScale),
      at(kBottom, hi * b.fileScale), at(kTop * a.fileScale, hi * b.fileScale),
    );
    j = e + 1;
  }
  return out;
}

/**
 * A polygon on a FlowJo log or a floored flog, written on an axis that does not move events below
 * the log's offset onto it, with every run of its edges on the floor skirted straight down past
 * every event: GateLab puts each such event on the floor, inside the polygon where the floor is,
 * and so does the skirt. `ring` is the written ring in file values; `k` the axis; `clamp` the log's
 * offset in file values. A run of edges not monotone along the floor is skirted edge by edge.
 */
function skirtFloor(ring: readonly Vertex[], k: 0 | 1, clamp: number, bottom: number): Vertex[] {
  const pts: Vertex[] = [];
  for (const p of ring) if (!pts.length || pts[pts.length - 1][0] !== p[0] || pts[pts.length - 1][1] !== p[1]) pts.push(p);
  while (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  const n = pts.length;
  const tol = 1e-9 * Math.max(1, Math.abs(clamp));
  const on = pts.map((p) => Math.abs(p[k] - clamp) <= tol);
  if (n < 3 || on.every(Boolean) || !on.some(Boolean)) return [...ring];
  // Start just after a vertex off the floor, so no run wraps round the end.
  const start = (on.findIndex((v) => !v) + 1) % n;
  const order = Array.from({ length: n }, (_, i) => pts[(start + i) % n]);
  const flags = Array.from({ length: n }, (_, i) => on[(start + i) % n]);
  const other = (1 - k) as 0 | 1;
  const down = (p: Vertex): Vertex => (k === 0 ? [bottom, p[1]] : [p[0], bottom]);
  const out: Vertex[] = [];
  for (let i = 0; i < n;) {
    if (!flags[i]) { out.push(order[i]); i++; continue; }
    let j = i;
    while (j + 1 < n && flags[j + 1]) j++;
    const run = order.slice(i, j + 1);
    if (run.length < 2) { out.push(run[0]); i = j + 1; continue; }
    const steps = run.slice(1).map((p, m) => Math.sign(p[other] - run[m][other]));
    const monotone = steps.every((d) => d === steps[0]) && steps[0] !== 0;
    if (monotone) {
      out.push(run[0], down(run[0]), down(run[run.length - 1]), run[run.length - 1]);
    } else {
      out.push(run[0]);
      for (let m = 1; m < run.length; m++) out.push(down(run[m - 1]), down(run[m]), run[m]);
    }
    i = j + 1;
  }
  return out;
}

/**
 * Points of an ellipse's boundary, in its own space, that reach as far as it does on each axis: 32
 * samples and the four points where it is widest and tallest, (mean ± √(D²·Σxx), ...) and (..., mean
 * ± √(D²·Σyy)). The samples alone fall short of an extreme by up to 1 − cos(π / 32) of the half-axis
 * (0.5%), inside coveringBiex's 5% margin; with these points the reach an axis is declared to show is
 * the ellipse's own, not a sample's.
 */
function ellipseReach(g: EllipseGate): Vertex[] {
  const out: Vertex[] = ellipseBoundary(g, 32);
  const [[a, b], [, c]] = g.covariance;
  const d2 = g.distance_square;
  const [mx, my] = g.mean;
  if (a > 0 && d2 > 0) {
    const w = Math.sqrt(d2 * a);
    const dy = (b * w) / a;
    out.push([mx + w, my + dy], [mx - w, my - dy]);
  }
  if (c > 0 && d2 > 0) {
    const h = Math.sqrt(d2 * c);
    const dx = (b * h) / c;
    out.push([mx + dx, my + h], [mx - dx, my - h]);
  }
  return out;
}

/** A gate's coordinates on one channel, in raw values, the edges with no bound left out. */
function rawCoordinates(sample: Sample, g: Gate, channel: string): number[] {
  const points: readonly Vertex[] = g.gate_type === "quadrant"
    ? [g.center]
    : g.gate_type === "ellipse"
      ? ellipseReach(g)
      : g.vertices;
  const out: number[] = [];
  for (const [k, ch] of [[0, g.x_channel], [1, g.y_channel]] as const) {
    if (ch !== channel) continue;
    for (const pt of points) {
      if (isUnbounded(pt[k])) continue;
      const raw = sample.gateToRaw(g, channel, pt[k]);
      if (Number.isFinite(raw) && !isOpenBound(raw)) out.push(raw);
    }
  }
  return out;
}

/**
 * Whether FlowJo would read a gate on this parameter otherwise than GateLab holds it were the
 * parameter declared on an axis whose floor, `floor` in raw values, FlowJo moves every event below
 * onto before it tests any gate (clampEdges): a FlowJo log, whose offset it is, or a biex a gate was
 * drawn on, whose table's first entry it is. A gate not on that very axis (`onAxis`) with a
 * coordinate at or below the floor, where the file has events below it, holds apart events FlowJo
 * cannot tell from one another.
 *
 * Declared on the log because another gate on the parameter was on it, the channel took them all
 * into such a gate: the interoperability sweep's fail:flowjo-axis-range, 36 of 43 rows on the release
 * candidate (random-0122 "Live", a range on PE−Cy7-A from -213 to -182 beside a FlowJo-log rectangle,
 * 137 events in GateLab and every event below 1 in FlowJo's reading; random-0034, random-0059, the
 * corpus's rect-edges-display). The log was kept, until 2026-09-26, where a gate needed it (an ellipse
 * or quadrant on it, a polygon on it with a vertex below the floor), and the rest of those rows stayed
 * (random-0040 and 0140, 18 and 84 events FlowJo moved): each such gate now goes out on the other axis cut
 * at its floor and skirted below it (cutBelowFloor, skirtFloor), as GateLab holds it, and only a
 * quadrant whose crosshair lies below the floor, whose lower quadrants hold nothing there, keeps it
 * (`needs`). The same holds of a biex another gate was drawn on (random-0042, 0112, 0142 and the
 * corpus's transform-zoo, a raw ellipse reaching -1,863 beside a biex whose table begins at -132).
 */
function axisMisreadsOtherGates(
  sample: Sample, idx: number, floor: number, onAxis: (g: Gate) => boolean, gates: readonly Gate[], needs: (g: Gate) => boolean = () => false,
): boolean {
  const key = sample.channels[idx].key;
  if (gates.some((g) => onAxis(g) && needs(g))) return false;
  const column = sample.rawColumnData(idx);
  let below = false;
  for (let i = 0; i < column.length && !below; i++) below = column[i] < floor;
  return below && gates.some((g) => !onAxis(g) && rawCoordinates(sample, g, key).some((v) => v <= floor));
}

/** axisMisreadsOtherGates for a FlowJo log at `log`. */
function logMisreadsOtherGates(sample: Sample, idx: number, log: Extract<AxisDecl, { kind: "log" }>, gates: readonly Gate[]): boolean {
  const key = sample.channels[idx].key;
  const onLog = (g: Gate): boolean => {
    const spec = gateSpec(sample, g, key);
    const clamp = logClampOf(spec);
    return clamp !== null && near(clamp, log.offset) && straightIn(log, spec);
  };
  // A quadrant's crosshair below the floor: every event is on or above the floor, on the upper or
  // right side, and its lower or left quadrants, cut at the floor, would be no ring at all.
  const needs = (g: Gate): boolean => g.gate_type === "quadrant"
    && ((g.x_channel === key && g.center[0] < sample.rawToGate(g, key, log.offset)) || (g.y_channel === key && g.center[1] < sample.rawToGate(g, key, log.offset)));
  return axisMisreadsOtherGates(sample, idx, log.offset, onLog, gates, needs);
}

/** axisMisreadsOtherGates for a biex a gate on the parameter was drawn on, at FlowJo's table's first entry. */
function biexMisreadsOtherGates(sample: Sample, idx: number, decl: Extract<AxisDecl, { kind: "biex" }>, gates: readonly Gate[]): boolean {
  const key = sample.channels[idx].key;
  const floor = clampEdges(decl)[0];
  const onBiex = (g: Gate): boolean => {
    const own = floorOf(gateSpec(sample, g, key));
    return own !== null && near(own, floor);
  };
  const needs = (g: Gate): boolean => g.gate_type === "quadrant"
    && ((g.x_channel === key && g.center[0] < sample.rawToGate(g, key, floor)) || (g.y_channel === key && g.center[1] < sample.rawToGate(g, key, floor)));
  return axisMisreadsOtherGates(sample, idx, floor, onBiex, gates, needs);
}

/**
 * What to declare for one parameter.
 *
 * A gate that arrived from FlowJo or from Gating-ML with an axis FlowJo can name (biex, log)
 * keeps it, so a FlowJo workspace that passed through GateLab goes back the shape it came, unless
 * FlowJo would then read another gate on the parameter otherwise than GateLab holds it
 * (logMisreadsOtherGates, biexMisreadsOtherGates): a biex is then widened until it reaches every
 * gate, and a log gives way to the parameter's default axis, reaching as high as the log did. Every
 * other parameter is declared the way FlowJo would declare it for a new sample: linear for
 * scatter, QC and time, biex for flow fluorescence (whatever GateLab shows it on: logicle or
 * arcsinh, the readers know biex), fasinh for mass cytometry with T and M chosen so that
 * straight lines in GateLab's asinh(x / cofactor) are straight in the file, which makes those
 * gates exact rather than densified.
 */
function declareAxis(
  sample: Sample,
  idx: number,
  displaySpecs: readonly TransformSpec[],
  timestep: number | null,
  warnings: string[],
  /** The most negative raw value a gate on this parameter has to show; the default biex must reach it. */
  gateMin?: number,
  /** Every coordinate a gate on this parameter states, raw, open bounds left out. */
  gateValues: readonly number[] = [],
  /** Every gate drawn on this parameter, on either axis. */
  channelGates: readonly Gate[] = [],
): { decl: AxisDecl; fileScale: number } {
  const ch = sample.channels[idx];
  const fileScale = timestep !== null && isTimeAxis(ch.pnn) ? timestep : 1;
  // A FlowJo grid polygon's axis first: FlowJo grids a polygon on the axis the file declares, so
  // declaring the very axis the gate was imported on is what lets FlowJo re-round its vertices
  // onto the same channels.
  const gridded = displaySpecs.find((s): s is FlowJoGridSpec => s.kind === "flowjoChannels");
  if (gridded) {
    const a = gridded.axis;
    if (a.kind === "linear") return { decl: { kind: "linear", minRange: a.minRange, maxRange: a.maxRange }, fileScale };
    if (a.kind === "wsplog") return { decl: { kind: "log", offset: a.offset, decades: a.decades }, fileScale };
    return { decl: { kind: "biex", params: { ...a, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS } }, fileScale };
  }
  // A channel held on FlowJo's log for a gate on it, and declared otherwise because the log misreads
  // another gate (logMisreadsOtherGates): the axis declared instead reaches up to the log gate too.
  let logDropped = false;
  const imported = displaySpecs.find((s) => s.kind === "biex")
    ?? displaySpecs.find((s) => s.kind === "wsplog")
    ?? displaySpecs.find((s) => s.kind === "flog");
  if (imported?.kind === "biex") {
    try {
      // Declared as FlowJo will read it, on its own table, whichever table the gate was saved on.
      const params: BiexParams = {
        maxValue: imported.maxValue, pos: imported.pos, neg: imported.neg, widthBasis: imported.widthBasis,
        channelRange: imported.channelRange, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS,
      };
      biexTransform(params);
      const decl: Extract<AxisDecl, { kind: "biex" }> = { kind: "biex", params };
      if (!biexMisreadsOtherGates(sample, idx, decl, channelGates)) return { decl, fileScale };
      // Another gate reaches the table's first entry, with events below it, which FlowJo would move
      // onto it: the biex widened as a default one is, until its floor reaches every gate
      // (coveringBiex), the gate drawn on it then cut at its own floor and skirted (polygonXml).
      const { params: wider, covered } = coveringBiex(params, gateMin);
      if (!covered) {
        warnings.push(`No biex width reaches ${fmtNum(gateMin ?? 0)} on ${ch.pnn}; a gate there is written at the axis floor.`);
      }
      biexTransform(wider);
      return { decl: { kind: "biex", params: wider }, fileScale };
    } catch {
      warnings.push(`The biex axis a gate recorded for ${ch.pnn} could not be rebuilt; the parameter is declared linear and that gate densified.`);
    }
  } else if (imported?.kind === "wsplog" || imported?.kind === "flog") {
    // A flog is declared as the FlowJo log it is: its offset where flog is 0, T·10^-M, and M
    // decades, so FlowJo's axis runs from flog 0 to 1 as flog's own display does. Declared with the
    // offset at T, as until 2026-09-25, the axis was flog's display shifted a whole axis up, straight
    // lines alike, but FlowJo puts every event below its offset on the axis's floor, and so read
    // every event below T there: the interoperability sweep's fail:flowjo-log-offset (131 checks on
    // 0.8.3, 165 on the last release candidate), e.g. random-0041 "IFN-γ", 3,562 of 10,000 events.
    const log: AxisDecl = imported.kind === "wsplog"
      ? { kind: "log", offset: imported.offset, decades: imported.decades }
      : { kind: "log", offset: flogOffset(imported), decades: imported.M };
    if (!logMisreadsOtherGates(sample, idx, log, channelGates)) return { decl: log, fileScale };
    logDropped = true;
  }

  const spec = sample.transformSpec(ch.key);
  const extent = columnExtent(sample, idx);
  if (sample.instrument === "cytof" && spec.kind === "asinh") {
    // Top of the axis at the data's own reach, never below ten cofactors; T and M then fix the
    // straightness (see straightIn), A = 0.5 gives the negative room FlowJo's own CyTOF axes have.
    const top = Math.max(halfDecadeCeil(extent ? extent[1] : 0), 10 * spec.cofactor);
    return { decl: { kind: "fasinh", T: top, M: Math.asinh(top / spec.cofactor) / Math.LN10, A: 0.5 }, fileScale };
  }
  const fluor = sample.instrument === "flow" && sample.isFluorChannel(idx);
  if (fluor && (spec.kind === "logicle" || spec.kind === "asinh")) {
    // FlowJo's default top is the parameter's range; a log gate declared on it instead reaches as
    // high as the log did (a flog vertex at 0.9 on a 262,144 top lies at 93,012, beyond the top of a
    // file whose $PnR is 10,000, and went out pinned there).
    const top = logDropped ? gateValues.reduce((m, v) => (v > m ? v : m), ch.range) : ch.range;
    const { params, covered } = coveringBiex(defaultBiex(sample, top), gateMin);
    if (!covered) {
      warnings.push(`No biex width reaches ${fmtNum(gateMin ?? 0)} on ${ch.pnn}; a gate there is written at the axis floor.`);
    }
    try {
      biexTransform(params);
      return { decl: { kind: "biex", params }, fileScale };
    } catch {
      warnings.push(`FlowJo's default biex could not be built for ${ch.pnn}; the parameter is declared linear.`);
    }
  }
  // Linear: scatter, QC, time, anything GateLab shows linear, and the fallbacks above.
  if (isTimeAxis(ch.pnn) && extent) {
    return { decl: { kind: "linear", minRange: extent[0] * fileScale, maxRange: Math.max(extent[1] * fileScale, extent[0] * fileScale + 1) }, fileScale };
  }
  return { decl: { kind: "linear", ...linearRange(sample, idx, gateValues) }, fileScale };
}

/**
 * The range a linear axis is declared over: FlowJo's own default, 0 to $PnR, widened only where a
 * gate needs it.
 *
 * FlowJo tests every polygon on a 256-channel grid over the declared range (flowjoGrid.ts), and
 * moves an event beyond the range onto its edge before it tests any gate. Declaring the data's
 * extent let one outlier decide the grid: on a saved bundle, FSC-A ran from -4.4e7 to 1.7e7 and
 * FlowJo's channel was 240,000 raw units wide, so a polygon GateLab drew there was 167,890 events
 * another polygon to FlowJo. The data's percentiles are no better: a file whose 99.9th percentile
 * of FSC-A is 1.9e8 (5% of its events past a $PnR of 262,144) put every polygon drawn in the
 * bulk of it on one or two channels.
 *
 * What the move changes is which side of a gate an event beyond the axis lands on. It lands on the
 * edge channel, so it is inside a polygon that reaches within a channel or two of that edge, and
 * inside a rectangle whose bound lies at or beyond it; in GateLab it is outside both when it lies
 * beyond the vertex or bound. So the range reaches past every coordinate a gate states that lies
 * within two channels of an end or beyond it and has an event beyond it, by 1% of the range. A
 * coordinate with no event beyond it (a rectangle's bound dragged far past the data, as FlowJo
 * users do) is left beyond the axis, where the move changes nothing, rather than stretching the
 * grid. Where no gate comes near an end, the range is FlowJo's default.
 */
function linearRange(sample: Sample, idx: number, gateValues: readonly number[]): { minRange: number; maxRange: number } {
  const ch = sample.channels[idx];
  const column = sample.rawColumnData(idx);
  let fullMin = Infinity;
  let fullMax = -Infinity;
  for (let i = 0; i < column.length; i++) {
    const v = column[i];
    if (v < fullMin) fullMin = v;
    if (v > fullMax) fullMax = v;
  }
  const top = ch.range > 1 ? ch.range : 1;
  const near = (2 * top) / FLOWJO_CHANNELS;
  // The coordinates near or beyond an end with an event beyond them.
  const low = gateValues.filter((v) => v <= near && v > fullMin);
  const high = gateValues.filter((v) => v >= top - near && v < fullMax);
  const lo = low.reduce((m, v) => (v < m ? v : m), 0);
  const hi = high.reduce((m, v) => (v > m ? v : m), top);
  const pad = 0.01 * (hi - lo);
  return { minRange: low.length ? lo - pad : 0, maxRange: high.length ? hi + pad : top };
}

// ── Gate geometry, in the file's terms ──────────────────────────────────────────────────────

/** GateLab's quadrant numbers (1 = x−/y+, 2 = x+/y+, 3 = x+/y−, 4 = x−/y−) as FlowJo's quadId. */
const FLOWJO_QUAD_ID: Record<number, number> = { 1: 2, 2: 3, 3: 1, 4: 0 };

interface GateSpec {
  /** The gate element lines, indented from column 0. */
  lines: string[];
  densified: boolean;
  /** An ellipse written as its sampled boundary, or a quadrant written as polygons. */
  recast: "ellipse" | "quadrant" | null;
}

const gateAttrs = 'eventsInside="1" annoOffsetX="0" annoOffsetY="0" tint="#000000" isTinted="0" lineWeight="Normal" userDefined="1"';

function dimensionXml(ax: Axis, min?: number, max?: number, fmt: (x: number) => string = fmtNum): string[] {
  const mn = min !== undefined ? ` gating:min="${fmt(min)}"` : "";
  const mx = max !== undefined ? ` gating:max="${fmt(max)}"` : "";
  return [
    `  <gating:dimension${mn}${mx}>`,
    `    <data-type:fcs-dimension data-type:name="${escAttr(ax.name)}" />`,
    "  </gating:dimension>",
  ];
}

/** A vertex with every digit (fmtExact). */
function vertexXml(v: Vertex): string[] {
  return [
    "  <gating:vertex>",
    `    <gating:coordinate data-type:value="${fmtExact(v[0])}" />`,
    `    <gating:coordinate data-type:value="${fmtExact(v[1])}" />`,
    "  </gating:vertex>",
  ];
}

/**
 * A polygon given in the gate's own space, written in file values: verbatim when it is straight
 * in the declared display, densified there otherwise. `quadId` is FlowJo's for a quadrant panel.
 *
 * `corners` names the vertices that are true corners of the shape. When given, only those are
 * forced to survive: the rest of the ring is a sampled curve (a bent quadrant arm, an ellipse's
 * boundary) whose samples are collapsed in the display until a chord stays within tolerance,
 * so the file carries as many vertices as the curve needs there and no more. Without it every
 * vertex is a corner, which is what a drawn polygon is.
 */
function polygonXml(
  sample: Sample, gate: Gate, ring: readonly Vertex[], ax: Axis, ay: Axis, id: string, quadId: number,
  corners?: readonly number[], warnings?: string[],
  /** A quadrant's dividers in file values, each with where the quadrants' shared edge on it goes. */
  pullIn?: { x?: [number, number]; y?: [number, number] },
  /** The grid check's work for this sample so far (gridOutcome). */
  gridMemo?: GridMemo,
  /** The population the gate is written for, and its parent's events, which a note counts within (gridNote). */
  scope?: GridScope | null,
): { lines: string[]; densified: boolean; rectangle?: boolean } {
  const toFile = (p: Vertex): Vertex => [
    sample.gateToRaw(gate, gate.x_channel, p[0]) * ax.fileScale,
    sample.gateToRaw(gate, gate.y_channel, p[1]) * ay.fileScale,
  ];
  // The ring as GateLab holds it, for its record; what is written is cut at a floor of the gate's
  // own space the declared axis does not move events onto (cutBelowFloor), and skirted below; or,
  // with nothing above that floor, written where it holds what GateLab holds (floorOnlyRing).
  const held = ring;
  let floorOnly: Vertex[] | null = null;
  let floorAxis: { k: 0 | 1; floor: number } | null = null;
  for (const [k, a, ch] of [[0, ax, gate.x_channel], [1, ay, gate.y_channel]] as const) {
    const clamp = floorOf(gateSpec(sample, gate, ch));
    if (clamp === null || clampsAtFloor(a.decl, clamp * a.fileScale)) continue;
    const floor = sample.rawToGate(gate, ch, clamp);
    if (gate.gate_type !== "quadrant" && !ring.some((v) => v[k] > floor)) {
      floorOnly = floorOnlyRing(sample, gate, ring, k, ax, ay);
      floorAxis = { k, floor };
      break;
    }
    const cut = cutBelowFloor(ring, k, floor, corners);
    // Nothing below the floor; or everything, where a quadrant's crosshair lies below it (below).
    if (!cut || cut.ring.length < 3) continue;
    ring = cut.ring;
    corners = cut.corners;
  }
  const straight = ax.straightIn(gateSpec(sample, gate, gate.x_channel))
    && ay.straightIn(gateSpec(sample, gate, gate.y_channel));
  let out: Vertex[] = ring.map(toFile);
  const grid = gridVertices(gate, corners === undefined ? ring : null);
  if (grid) {
    // FlowJo's grid: the vertices FlowJo saved, where each still rounds onto the channel the gate
    // holds, and a channel's centre where it was edited. Nothing is densified -- FlowJo grids the
    // polygon on the declared axis, which is the gate's own when `straight`.
    if (!straight) {
      warnings?.push(`${gate.name}: it is on FlowJo's grid for an axis this file declares differently, so FlowJo will grid it on the declared axis instead.`);
    }
    return {
      densified: false,
      lines: [
        `<gating:PolygonGate ${gateAttrs} quadId="${quadId}" gateResolution="${grid.channels}" gating:id="${id}">`,
        ...dimensionXml(ax), ...dimensionXml(ay),
        // Every digit: FlowJo rounds them onto channels again (fmtExact).
        ...grid.vertices.flatMap(vertexXml),
        "</gating:PolygonGate>",
      ],
    };
  }
  let densified = false;
  // Said once the polygon is known to go out as one (below, gridOutcome).
  const notes: string[] = [];
  if (floorOnly) {
    out = floorOnly;
  } else if ((!straight || corners) && ring.length >= 3) {
    const toDisplay = (p: Vertex): Vertex => {
      const f = toFile(p);
      return [ax.forward(f[0]), ay.forward(f[1])];
    };
    const displayVerts = ring.map(toDisplay);
    const detail: { span?: [number, number]; edgeBreaks?: number[] } = {};
    let dense = polygonOutline([...ring], toDisplay, displayVerts, { tol: DENSIFY_TOL, detail });
    if (!dense && corners) {
      // Nothing bent, so nothing was subdivided; the ring itself, closed, in the outline's
      // layout: vertex 0, then each edge's endpoint, edge i's points beginning at i + 1.
      dense = [...displayVerts, displayVerts[0]];
      detail.edgeBreaks = ring.map((_, i) => i + 1);
      const xs = displayVerts.map((v) => v[0]);
      const ys = displayVerts.map((v) => v[1]);
      const spanX = Math.max(...xs) - Math.min(...xs);
      const spanY = Math.max(...ys) - Math.min(...ys);
      detail.span = [spanX > 0 ? spanX : Infinity, spanY > 0 ? spanY : Infinity];
    }
    // A vertex the declared display cannot hold is pinned at its floor or ceiling by the
    // transform, and the traced polygon would carry the pinned position as if it were the gate.
    // The axis declaration is built to cover every vertex, so this is the check on that promise.
    // Named once per axis: a traced polygon can hold thousands of such vertices, and one warning
    // each put 5,406 lines in the export dialog (FR-FCM-Z2HV, its quadrant panels through Gating-ML).
    const outside: [number[], number[]] = [[], []];
    for (const p of ring) {
      const f = toFile(p);
      const back: Vertex = [ax.inverse(ax.forward(f[0])), ay.inverse(ay.forward(f[1]))];
      for (const k of [0, 1] as const) {
        if (Math.abs(back[k] - f[k]) > 1e-6 * Math.max(1, Math.abs(f[k]))) {
          outside[k].push(f[k]);
          break;
        }
      }
    }
    const at = (v: number): string => (Number.isFinite(v) ? fmtNum(v) : String(v));
    for (const k of [0, 1] as const) {
      const vs = outside[k];
      if (!vs.length) continue;
      const axis = k === 0 ? ax : ay;
      const lo = vs.reduce((m, v) => (v < m ? v : m), Infinity);
      const hi = vs.reduce((m, v) => (v > m ? v : m), -Infinity);
      notes.push(vs.length === 1
        ? `${gate.name}: a vertex at ${at(vs[0])} on ${axis.name} lies outside the declared axis and is written at its edge.`
        : `${gate.name}: ${vs.length} vertices from ${at(lo)} to ${at(hi)} on ${axis.name} lie outside the declared axis and are written at its edge.`);
    }
    if (dense) {
      const breaks = detail.edgeBreaks && corners
        ? corners.filter((c) => c < detail.edgeBreaks!.length).map((c) => detail.edgeBreaks![c])
        : detail.edgeBreaks;
      const kept = detail.span && breaks
        ? collapseDensifiedRing(dense, breaks, detail.span, DENSIFY_TOL)
        : dense;
      out = kept.map((c) => [ax.inverse(c[0]), ay.inverse(c[1])]);
      densified = !straight && out.length > (corners ? corners.length : ring.length);
      if (corners && quadId >= 0) {
        // A corner placed beyond the declared axis on purpose -- a quadrant's box, which reaches
        // past the axis and past every event so that FlowJo's clamp keeps each event inside one of
        // the four -- goes out where it is, not pinned to the axis's end through the display: on
        // FlowJo's 4096-channel biex table the top pinned to 261,622 on a 262,144 axis, below the
        // top FlowJo moves an event beyond it onto, and such an event fell outside every quadrant
        // (the interoperability sweep's corpus-quadrants "Q3", FL1-A at 352,568).
        const beyond = new Map<string, Vertex>();
        for (const c of corners) {
          if (!(c < ring.length)) continue;
          const f = toFile(ring[c]);
          const pinned = [ax, ay].some((a, k) => Math.abs(a.inverse(a.forward(f[k])) - f[k]) > 1e-6 * Math.max(1, Math.abs(f[k])));
          if (pinned) beyond.set(`${displayVerts[c][0]},${displayVerts[c][1]}`, f);
        }
        if (beyond.size) out = out.map((v, k) => beyond.get(`${kept[k][0]},${kept[k][1]}`) ?? v);
      }
    }
  }
  // A gate on a FlowJo log, a floored flog or a biex, written on an axis that does not move the
  // events below its floor onto that very value (clampsAtFloor), holds those events GateLab puts on
  // the floor through a skirt below its edges there (skirtFloor), the ring having been cut at the
  // floor above. A ring with vertices below the floor still is a quadrant's whose crosshair lies below
  // it (its lower or left quadrants were not cut; logMisreadsOtherGates keeps the log for one). A gate
  // with nothing above a floor is written as floorOnlyRing placed it, and needs no skirt.
  for (const [k, a, ch] of [[0, ax, gate.x_channel], [1, ay, gate.y_channel]] as const) {
    const clamp = floorOf(gateSpec(sample, gate, ch));
    if (floorOnly || clamp === null || clampsAtFloor(a.decl, clamp * a.fileScale)) continue;
    const floor = clamp * a.fileScale;
    const tol = 1e-9 * Math.max(1, Math.abs(floor));
    // Past every event, and past where the declared axis moves an event below its end.
    const end = clampEdges(a.decl)[0];
    const bottom = Math.min(belowEveryEvent(sample, ch) * a.fileScale, Number.isFinite(end) ? end - Math.abs(end) - 1 : Infinity);
    if (!out.some((v) => v[k] < floor - tol)) {
      out = skirtFloor(out, k, floor, bottom);
    } else if (gate.gate_type === "quadrant" && sample.gateToRaw(gate, ch, gate.center[k]) * a.fileScale >= floor - tol) {
      // A quadrant's box, placed below the floor in the gate's own space, is a positive value just
      // below the log's offset in raw values; every event below it is on the floor to GateLab, on the
      // lower or left side, and goes past it here (random-0139 "CD3−", SSC-A on flog declared biex).
      out = out.map((v): Vertex => (v[k] < floor - tol ? (k === 0 ? [bottom, v[1]] : [v[0], bottom]) : v));
    }
  }
  if (pullIn) {
    // GateLab puts an event exactly on a divider on its upper or right side (gateMaskQuadrant, as
    // Gating-ML 2.0 section 5.4.1 does), and the four polygons share their edges there, so a reader
    // that holds a polygon's edge (FlowJo's closed rule, Gating-ML's for a polygon) put such an event
    // in two quadrants, one that drops an upper or right edge (FlowKit) in none, and a reader
    // comparing in a float32 display either: the four share their edge on each divider just below
    // it instead, where quadrantPullIn puts it and no event lies.
    const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
    out = out.map((v): Vertex => [
      pullIn.x && near(v[0], pullIn.x[0]) ? pullIn.x[1] : v[0],
      pullIn.y && near(v[1], pullIn.y[0]) ? pullIn.y[1] : v[1],
    ]);
  }
  if (out.some((v) => !Number.isFinite(v[0]) || !Number.isFinite(v[1]))) {
    throw new Error(`The gate "${gate.name}" has a vertex that cannot be written to a FlowJo workspace.`);
  }
  // A FlowJo polygon imported continuously goes back with its own quadId and gateResolution (a
  // quadrant panel's, or none), so FlowJo and an import read the polygon it was; any other polygon
  // FlowJo grids at 256 channels as it does every polygon it draws.
  const own = quadId === -1 && gate.gate_type === "polygon" ? gate.flowjo_polygon : undefined;
  const quadAttr = own ? own.quadId : quadId;
  const resolution = own ? own.gateResolution : FLOWJO_CHANNELS;
  const resolutionAttr = resolution === null ? "" : ` gateResolution="${resolution}"`;
  // A polygon FlowJo grids is written where FlowJo's grid reads it as GateLab holds it, or named
  // (gridOutcome). A quadrant's panels are not gridded (quadId), nor a polygon with no resolution.
  if (quadId === -1 && quadAttr === -1 && resolution !== null && gate.gate_type !== "quadrant") {
    let outcome = gridMemo?.outcomes.get(gate.gate_id);
    if (!outcome) {
      outcome = gridOutcome(sample, gate, held, out, floorAxis, ax, ay, resolution, gridMemo);
      gridMemo?.outcomes.set(gate.gate_id, outcome);
    }
    if (outcome.kind === "rectangle") {
      return { lines: rectangleForFlowJo(sample, outcome.rect, ax, ay, id, warnings, { clearOfEvents: outcome.clear }), densified: false, rectangle: true };
    }
    if (outcome.kind === "moved") out = outcome.ring.map(([x, y]) => [x, y] as Vertex);
    if (outcome.kind === "named") {
      const note = gridNote(gate, outcome, scope ?? null);
      if (note) notes.push(note);
    }
  }
  warnings?.push(...notes);
  const lines = [
    `<gating:PolygonGate ${gateAttrs} quadId="${quadAttr}"${resolutionAttr} gating:id="${id}">`,
    ...dimensionXml(ax), ...dimensionXml(ay),
    ...out.flatMap(vertexXml),
    "</gating:PolygonGate>",
  ];
  // GateLab evaluates this polygon continuously, and FlowJo, which has no continuous polygon, will
  // grid it; so does an import of the file with "Evaluate gates as FlowJo does" on. GateLab's record
  // (polygonRecord.ts) gives it back to GateLab as it is held here, whichever answer the import is
  // given, while the file still states these coordinates. A quadrant's panels are not polygons of
  // their own and carry none: an import reads them continuously in either mode.
  if (quadId === -1) {
    const record = polygonRecordOf(sample, gate, held, writtenPolygonCoordinates(lines).get(id) ?? []);
    lines[0] = lines[0].replace(/ gating:id="/, ` ${WSP_POLYGON_ATTR}="${escAttr(JSON.stringify(record))}" gating:id="`);
  }
  return { densified, lines };
}

/**
 * A bound a gate holds as no bound: the importer's ±1e9 for one a file leaves out (gatingml.ts, until
 * 2026-09), or a coordinate at or beyond the largest double, as the Gating-ML hardening branch holds
 * one. rectangleForFlowJo never moves such a bound for FlowJo's rule.
 */
function isOpenBound(v: number): boolean {
  return !(Math.abs(v) < Number.MAX_VALUE) || Math.abs(v) === 1e9;
}

/**
 * Whether the FlowJo this export declares (FLOWJO_VERSION) puts a log-axis polygon vertex at or
 * below zero on the axis floor, as FlowJo 10.6 and later do (flowjoGrid.ts), rather than far below.
 */
const WRITTEN_LOG_VERTEX_AT_ZERO_ON_FLOOR = logVertexAtZeroOnFloor(FLOWJO_VERSION);

/**
 * A FlowJo grid polygon's vertices as the FlowJo file should hold them, in raw units, with the
 * grid's channel count; null for any other gate, or a ring that is not the gate's own vertices.
 * Each coordinate is FlowJo's own raw value (PolyRectGate.flowjo_vertices) where that value still
 * rounds onto the channel the gate holds on its axis, and the middle of that channel otherwise,
 * which rounds back onto it under FlowJo's rule (flowjoGrid.ts). FlowJo rounds each axis on its
 * own, so a coordinate that still rounds is kept beside one that does not, and an import of the
 * file with the option off reads FlowJo's own value there as it did the first time.
 *
 * "Rounds onto" is read as the FlowJo this file declares reads it: a log vertex at or below zero on
 * the floor (WRITTEN_LOG_VERTEX_AT_ZERO_ON_FLOOR). A workspace FlowJo 10.2 or earlier wrote holds
 * such a vertex far below the axis, and the scale alone rounds FlowJo's saved value there, so the
 * value was kept and the declared 10.10.0 then put it on the floor: FR-FCM-ZZSX FMOs.wsp (10.0.7r2)
 * moved 413 events through GateLab's own .wsp and FR-FCM-ZY9F 20150408.wsp (10.2) 1,365. It now
 * goes out at the middle of its channel far below, a positive value about 1e-300 that GateLab and
 * the scale round there by its logarithm; how FlowJo 10.6 and later round a positive log vertex that
 * small is not measured (none is in the per-event data), only how they round one at or below zero.
 * A vertex FlowJo 10.6 or later put on the floor goes out as FlowJo saved it, where it went out at
 * the floor channel's middle with its other coordinate moved to its channel's middle.
 */
function gridVertices(gate: Gate, ring: readonly Vertex[] | null): { vertices: Vertex[]; channels: number } | null {
  if (!ring || gate.gate_type !== "polygon" || ring !== gate.vertices || !isFlowJoGridGate(gate)) return null;
  const sx = gate.transforms![gate.x_channel] as FlowJoGridSpec;
  const sy = gate.transforms![gate.y_channel] as FlowJoGridSpec;
  const gx = flowJoGridScale(sx);
  const gy = flowJoGridScale(sy);
  const writtenCell = (spec: FlowJoGridSpec, scale: FlowJoGridScale) =>
    WRITTEN_LOG_VERTEX_AT_ZERO_ON_FLOOR && spec.axis.kind === "wsplog"
      ? (v: number): number => (v <= 0 ? 0 : scale.vertexCell(v))
      : scale.vertexCell;
  const [cellX, cellY] = [writtenCell(sx, gx), writtenCell(sy, gy)];
  const saved = gate.flowjo_vertices?.length === gate.vertices.length ? gate.flowjo_vertices : null;
  return {
    channels: sx.channels,
    vertices: gate.vertices.map(([cx, cy], i) => {
      const raw = saved?.[i];
      return [raw && cellX(raw[0]) === cx ? raw[0] : gx.centre(cx), raw && cellY(raw[1]) === cy ? raw[1] : gy.centre(cy)];
    }),
  };
}

// ── A written polygon as FlowJo's grid reads it ─────────────────────────────────────────────
//
// FlowJo tests every PolygonGate that declares a gateResolution on its gate grid (flowjoGrid.ts),
// and the export writes 256 on every polygon it draws: GateLab's own polygons, an ellipse written as
// its boundary, the strips and bands floorOnlyRing places. GateLab holds such a gate continuously
// (its record, polygonRecord.ts, gives it back so), so FlowJo's reading could differ from GateLab's
// membership without a word: the release candidate's verifier, reading the export through GateLab's
// own grid import (the importer with GateLab's records taken out), found a strip on the public
// FACSCalibur file's floor read otherwise at 13,600 of 22,112 events, a band holding no event in
// GateLab read as holding 66, and every floor strip on synthetic data misread at a few to 292 events.
//
// So each such polygon is read here as that import reads it, from the axes the file declares, on
// the file's own events: each event on its channel pair (eventCell), each written vertex on its
// channel (vertexCell, a log vertex at or below zero on the floor as the declared FlowJo 10.10.0 puts
// it), and the closed test on the integers (gateMaskPolygon). Where that differs from GateLab's
// membership of the gate: a shape a rectangle holds exactly (an axis-aligned ring, or a gate with
// nothing above a floor that meets it along one stretch or not at all) goes out as a RectangleGate,
// which FlowJo compares in raw values and does not grid, carrying GateLab's record of it
// (rectangleRecord.ts), so GateLab reads it back as that rectangle, holding the same events, its
// bounds clear of the file's events wherever FlowJo's rule allows (rectangleInstead); else
// its vertices are moved, each coordinate just across a boundary of its channel, where that makes the
// grid read the gate exactly and a reader testing it continuously holds the same events as before;
// else it goes out as it was and the warnings name it with the number of events FlowJo reads
// otherwise within the parent of the population it is written for (gridNote). Each is decided on
// GateLab's membership of the gate alone, over all the file's events, so the export's preview, which
// evaluates no population, says what the export does, and counts over the file.
// Only a polygon on two axes the import grids is read so (a unit-gain linear, log or biex axis that is
// not Time): a polygon on a FlowJo ArcSinh axis stays continuous in GateLab's model of FlowJo.

/** What the grid check decided for one gate of one sample, so that every copy of it is written alike. */
type GridOutcome =
  | { kind: "as-written" }
  /** `clear`: which of its bounds are moved off this file's events (rectangleForFlowJo, clearOfEvents). */
  | { kind: "rectangle"; rect: PolyRectGate; clear: ClearBounds }
  | { kind: "moved"; ring: Vertex[] }
  /**
   * Written as it is, and named: `differ` of the file's `events` FlowJo's grid reads otherwise than
   * GateLab holds them, `shape` what the gate went out as, and `reading` what tells which (gridNote).
   */
  | { kind: "named"; differ: number; events: number; reading: NamedReading; shape: string; channels: number };

/**
 * Enough of a named gate's reading to tell which events FlowJo's grid reads otherwise: each event's
 * channel pair (GridReading's ex, ey and slot), whether the written ring holds it (`inside`, by
 * pair), and GateLab's membership (`mask`).
 */
interface NamedReading {
  ex: Int32Array;
  ey: Int32Array;
  nx: number;
  slot: Int32Array;
  inside: Uint8Array;
  mask: Uint8Array;
}

/** A population a gate is written for, by name, and its parent's events (null where not evaluated). */
interface GridScope {
  population: string;
  parent: Uint8Array | null;
}

/**
 * The warning for a polygon FlowJo's grid reads otherwise than GateLab holds it: within the parent
 * of the population it is written for, where the export evaluated the populations, and over the
 * file's events otherwise (the export dialog's preview, planFlowJoExport, evaluates none). Null
 * where FlowJo reads none of the parent's events otherwise, which is then the population's count too.
 */
function gridNote(gate: Gate, o: Extract<GridOutcome, { kind: "named" }>, scope: GridScope | null): string | null {
  const head = `"${gate.name}" is ${o.shape}, which FlowJo tests on its ${o.channels}-channel grid: `;
  if (scope?.parent) {
    const { ex, ey, nx, slot, inside, mask } = o.reading;
    let n = 0;
    let k = 0;
    for (let i = 0; i < scope.parent.length; i++) {
      if (!scope.parent[i]) continue;
      n++;
      const s = ex[i] < 0 || ey[i] < 0 ? -1 : slot[ey[i] * nx + ex[i]];
      if ((s >= 0 && inside[s] !== 0) !== (mask[i] !== 0)) k++;
    }
    if (!k) return null;
    return head + `at this gate FlowJo reads ${k} of the ${n} events of "${scope.population}"'s parent otherwise than GateLab does.`;
  }
  return head + `at this gate FlowJo reads ${o.differ} of this file's ${o.events} events otherwise than GateLab does.`;
}

/**
 * The grid check's work for one sample: each gate's outcome, by gate id, and each channel's events
 * on the channels of a grid axis (-1 for a value no channel takes), shared by the gates on it.
 */
interface GridMemo {
  outcomes: Map<string, GridOutcome>;
  cells: Map<string, Int32Array>;
}

/** The events of a channel on a grid axis's channels (eventCell), -1 where none takes the value. */
function eventCells(sample: Sample, idx: number, spec: FlowJoGridSpec, scale: FlowJoGridScale, memo?: GridMemo): Int32Array {
  const key = `${idx}|${JSON.stringify(spec)}`;
  const hit = memo?.cells.get(key);
  if (hit) return hit;
  const raw = sample.rawColumnData(idx);
  const out = new Int32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const c = scale.eventCell(raw[i]);
    out[i] = c >= 0 && c < scale.cells ? c : -1;
  }
  memo?.cells.set(key, out);
  return out;
}

/**
 * One axis of FlowJo's gate grid as GateLab's FlowJo import builds it from the axis this file
 * declares (flowjoWorkspace.ts, workspaceGridAxes and gridFor): a linear axis (every one written
 * here has gain 1), a log axis or a biex axis, at `channels`, the gateResolution written; null where
 * the import leaves a polygon on the axis continuous (Time, fasinh).
 */
function declaredGridAxis(a: Axis, channels: number): FlowJoGridSpec | null {
  if (isTimeAxis(a.name) || a.fileScale !== 1) return null;
  const d = a.decl;
  const axis = d.kind === "linear"
    ? parseFlowJoGridAxis({ kind: "linear", minRange: d.minRange, maxRange: d.maxRange })
    : d.kind === "log"
      ? parseFlowJoGridAxis({ kind: "wsplog", offset: d.offset, decades: d.decades })
      : d.kind === "biex"
        ? parseFlowJoGridAxis({
          kind: "biex", maxValue: d.params.maxValue, pos: d.params.pos, neg: d.params.neg,
          widthBasis: d.params.widthBasis, channelRange: d.params.channelRange,
        })
        : null;
  return axis ? { kind: "flowjoChannels", channels, axis } : null;
}

/**
 * A gate's membership of the file's events, GateLab's, beside those events on FlowJo's grid of the
 * declared axes: each channel pair an event lies on (`cx`, `cy`), with how many of its events the
 * gate holds and leaves out.
 */
interface GridReading {
  sx: FlowJoGridSpec;
  sy: FlowJoGridSpec;
  gx: FlowJoGridScale;
  gy: FlowJoGridScale;
  /** Raw → the channel FlowJo puts a written vertex on, per axis. */
  vertexX(v: number): number;
  vertexY(v: number): number;
  cx: Float64Array;
  cy: Float64Array;
  held: Uint32Array;
  other: Uint32Array;
  /** Each event's channel on either axis (-1 for none), and each pair's index into cx and cy (-1 for none). */
  ex: Int32Array;
  ey: Int32Array;
  nx: number;
  slot: Int32Array;
  /** Events the gate holds that lie on no channel pair (a value no channel takes), which FlowJo cannot hold. */
  lost: number;
  events: number;
}

function gridReadingOf(sample: Sample, gate: Gate, ax: Axis, ay: Axis, channels: number, mask: Uint8Array, memo?: GridMemo): GridReading | null {
  const sx = declaredGridAxis(ax, channels);
  const sy = declaredGridAxis(ay, channels);
  const ix = sample.index(gate.x_channel);
  const iy = sample.index(gate.y_channel);
  if (!sx || !sy || ix === undefined || iy === undefined) return null;
  const gx = flowJoGridScale(sx);
  const gy = flowJoGridScale(sy);
  const onFloor = (spec: FlowJoGridSpec, scale: FlowJoGridScale) =>
    WRITTEN_LOG_VERTEX_AT_ZERO_ON_FLOOR && spec.axis.kind === "wsplog"
      ? (v: number): number => (v <= 0 ? 0 : scale.vertexCell(v))
      : scale.vertexCell;
  // A grid axis's file values are raw values (declaredGridAxis: no Time), so the events go on as they are.
  const ex = eventCells(sample, ix, sx, gx, memo);
  const ey = eventCells(sample, iy, sy, gy, memo);
  const nx = gx.cells;
  const slot = new Int32Array(nx * gy.cells).fill(-1);
  const cx: number[] = [];
  const cy: number[] = [];
  const held: number[] = [];
  const other: number[] = [];
  let lost = 0;
  for (let i = 0; i < mask.length; i++) {
    const a = ex[i];
    const b = ey[i];
    if (a < 0 || b < 0) {
      if (mask[i]) lost++;
      continue;
    }
    const k = b * nx + a;
    let s = slot[k];
    if (s < 0) {
      s = slot[k] = cx.length;
      cx.push(a);
      cy.push(b);
      held.push(0);
      other.push(0);
    }
    if (mask[i]) held[s]++;
    else other[s]++;
  }
  return {
    sx, sy, gx, gy, vertexX: onFloor(sx, gx), vertexY: onFloor(sy, gy),
    cx: Float64Array.from(cx), cy: Float64Array.from(cy), held: Uint32Array.from(held), other: Uint32Array.from(other),
    ex, ey, nx, slot, lost, events: mask.length,
  };
}

/** A ring's vertices on the channels FlowJo puts them on. */
function latticeOf(r: GridReading, ring: readonly Vertex[]): Vertex[] {
  return ring.map(([x, y]) => [r.vertexX(x), r.vertexY(y)] as Vertex);
}

/** How many of the file's events FlowJo's grid reads otherwise than GateLab holds them, for a lattice ring. */
function gridDiffers(r: GridReading, lattice: readonly Vertex[]): { differ: number; heldOut: number; otherIn: number; inside: Uint8Array } {
  const inside = gateMaskPolygon(r.cx, r.cy, lattice as Vertex[]);
  let heldOut = r.lost;
  let otherIn = 0;
  for (let s = 0; s < inside.length; s++) {
    if (inside[s]) otherIn += r.other[s];
    else heldOut += r.held[s];
  }
  return { differ: heldOut + otherIn, heldOut, otherIn, inside };
}

const sameMask = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** A ring without repeated consecutive vertices, a closing repeat of the first included. */
function distinctRing(ring: readonly Vertex[]): Vertex[] {
  const out: Vertex[] = [];
  for (const v of ring) if (!out.length || out[out.length - 1][0] !== v[0] || out[out.length - 1][1] !== v[1]) out.push(v);
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

/**
 * The closed GateLab rectangle, in the gate's own space, that holds what the gate holds for any
 * events, or null where there is none: the gate's own ring where that is an axis-aligned rectangle
 * traced once (every edge on its bounding box, the area the box's), and, for a polygon or an
 * ellipse with nothing above a floor (floorOf) on one axis, which holds only the events GateLab puts
 * on that floor where its edges run along it, the stretch of the floor it runs along, where that is
 * one stretch (or none: then it holds nothing, and so does the rectangle about it).
 */
function rectangleOfRing(gate: Gate, ring: readonly Vertex[], floorAxis: { k: 0 | 1; floor: number } | null): PolyRectGate | null {
  if (gate.x_channel === gate.y_channel) return null;
  const pts = distinctRing(ring);
  const n = pts.length;
  if (n < 3) return null;
  const lo = (k: 0 | 1) => pts.reduce((m, v) => (v[k] < m ? v[k] : m), Infinity);
  const hi = (k: 0 | 1) => pts.reduce((m, v) => (v[k] > m ? v[k] : m), -Infinity);
  let box: [[number, number], [number, number]] | null = null;
  const [x0, x1, y0, y1] = [lo(0), hi(0), lo(1), hi(1)];
  const alongBox = x0 < x1 && y0 < y1 && pts.every((a, i) => {
    const b = pts[(i + 1) % n];
    return (a[0] === b[0] && (a[0] === x0 || a[0] === x1)) || (a[1] === b[1] && (a[1] === y0 || a[1] === y1));
  });
  if (alongBox) {
    let twice = 0;
    for (let i = 0; i < n; i++) {
      const [a, b] = [pts[i], pts[(i + 1) % n]];
      twice += a[0] * b[1] - b[0] * a[1];
    }
    const area = (x1 - x0) * (y1 - y0);
    if (Math.abs(Math.abs(twice) / 2 - area) <= 1e-9 * area) box = [[x0, x1], [y0, y1]];
  }
  if (!box && floorAxis) {
    const { k, floor } = floorAxis;
    const o = (1 - k) as 0 | 1;
    const tol = 1e-9 * Math.max(1, Math.abs(floor));
    const on = pts.map((v) => Math.abs(v[k] - floor) <= tol);
    const spans: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      if (on[i] && on[next]) spans.push([Math.min(pts[i][o], pts[next][o]), Math.max(pts[i][o], pts[next][o])]);
      else if (on[i] && !on[(i + n - 1) % n]) spans.push([pts[i][o], pts[i][o]]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    if (merged.length > 1) return null;
    // On the floor, GateLab's column holds the floor's value as float32 holds it.
    const kSpan: [number, number] = merged.length ? [lo(k), Math.max(floor, Math.fround(floor), hi(k))] : [lo(k), hi(k)];
    const oSpan: [number, number] = merged.length ? merged[0] : [lo(o), hi(o)];
    box = k === 0 ? [kSpan, oSpan] : [oSpan, kSpan];
  }
  if (!box) return null;
  const [[bx0, bx1], [by0, by1]] = box;
  return {
    gate_id: gate.gate_id, name: gate.name, gate_type: "rectangle", x_channel: gate.x_channel, y_channel: gate.y_channel,
    vertices: [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]], bounds: "closed",
    ...(gate.space !== undefined ? { space: gate.space } : {}),
    ...(gate.transforms ? { transforms: gate.transforms } : {}),
    color: gate.color, label_offset: gate.label_offset,
  };
}

/**
 * FlowJo's reading of a rectangle this export wrote, `written` its bounds as the file states them
 * (writtenRectangleBounds): each event moved onto an end of the declared axis it lies beyond
 * (clampEdges), then held between the bounds, both edges included, as flowjoWorkspace.ts reads
 * FlowJo's rectangles. Null where FlowJo's count is not established, a rectangle lying wholly beyond
 * where FlowJo moves events on an axis.
 */
function flowJoRectangleMask(sample: Sample, gate: PolyRectGate, ax: Axis, ay: Axis, written: readonly string[]): Uint8Array | null {
  const axes: Array<[string, Axis, string | undefined]> = [[gate.x_channel, ax, written[0]], [gate.y_channel, ay, written[1] ?? written[0]]];
  const parts: Array<{ column: ArrayLike<number>; scale: number; lo: number; hi: number; edgeLo: number; edgeHi: number }> = [];
  for (const [channel, a, text] of axes) {
    const idx = sample.index(channel);
    if (idx === undefined || text === undefined) return null;
    const [min, max] = text.split("|");
    const lo = min === "" || min === undefined ? -Infinity : Number(min);
    const hi = max === "" || max === undefined ? Infinity : Number(max);
    const [edgeLo, edgeHi] = clampEdges(a.decl);
    if (hi < edgeLo || lo > edgeHi || Number.isNaN(lo) || Number.isNaN(hi)) return null;
    parts.push({ column: sample.rawColumnData(idx), scale: a.fileScale, lo, hi, edgeLo, edgeHi });
  }
  const n = parts[0].column.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let inside = true;
    for (const p of parts) {
      let v = p.column[i] * p.scale;
      if (v < p.edgeLo) v = p.edgeLo;
      else if (v > p.edgeHi) v = p.edgeHi;
      if (!(v >= p.lo && v <= p.hi)) {
        inside = false;
        break;
      }
    }
    if (inside) out[i] = 1;
  }
  return out;
}

/**
 * A polygon's RectangleGate (rectangleForFlowJo, GateLab's record included), where the gate is one
 * (rectangleOfRing) that holds exactly what the polygon holds of this file's events and FlowJo's rule
 * reads the written rectangle as GateLab holds it; null otherwise. `mask` is GateLab's membership.
 *
 * Its bounds go clear of the file's events (clearOfEvents), as floorOnlyRing and emptyAt place
 * theirs, wherever FlowJo's rule still reads it so: rectangleForFlowJo puts a bound on the file's
 * events for FlowJo's closed rule, and a half-open reader (FlowKit reads a workspace's rectangle so)
 * then drops the events on its upper bounds, and holds nothing of a rectangle whose axis is one value
 * (a triangle with its apex on a floor). Written on the events, FlowKit 1.3.1 left out 89 of the
 * public FACSCalibur file's 22,112 events at a strip on its log floor, which 47a262e's strip had held
 * (the follow-up's verifier). Each bound is cleared where FlowJo's rule still reads the rectangle as
 * GateLab holds it, and stays on the events where it would not (a bound at the end of the declared
 * axis, past which FlowJo moves the events beyond it onto that end). Clearing moves a bound only
 * across values no event takes, so a bound's clearing changes FlowJo's reading only through that
 * move, and bounds each safe alone are safe together; the whole is checked once more all the same.
 */
function rectangleInstead(
  sample: Sample, gate: Gate, held: readonly Vertex[], floorAxis: { k: 0 | 1; floor: number } | null, ax: Axis, ay: Axis, mask: Uint8Array,
): { rect: PolyRectGate; clear: ClearBounds } | null {
  const rect = rectangleOfRing(gate, held, floorAxis);
  if (!rect) return null;
  if (!sameMask(getGateMask(rect, columnsForGate(sample.gateAssayData(), rect)), mask)) return null;
  const id = "grid-check";
  const readsAsGateLab = (clear: ClearBounds): boolean | null => {
    let lines: string[];
    try {
      lines = rectangleForFlowJo(sample, rect, ax, ay, id, [], { clearOfEvents: clear });
    } catch {
      return null;
    }
    const written = writtenRectangleBounds(lines).get(id);
    const flowJo = written ? flowJoRectangleMask(sample, rect, ax, ay, written) : null;
    return !!flowJo && sameMask(flowJo, mask);
  };
  const all: ClearBounds = [true, true, true, true];
  const none: ClearBounds = [false, false, false, false];
  const whole = readsAsGateLab(all);
  if (whole === null) return null;
  if (whole) return { rect, clear: all };
  if (!readsAsGateLab(none)) return null;
  const only = (i: number): ClearBounds => [i === 0, i === 1, i === 2, i === 3];
  const safe = [0, 1, 2, 3].map((i) => readsAsGateLab(only(i)) === true);
  const each: ClearBounds = [safe[0], safe[1], safe[2], safe[3]];
  return { rect, clear: safe.some(Boolean) && readsAsGateLab(each) ? each : none };
}

/**
 * The raw value nearest `v`, on the far side of the channel boundary between `v`'s channel and the
 * next one towards `target` (the channel either side of it), at which FlowJo puts a vertex on
 * `target`: the largest double below the boundary, or the least at or above it. Null where none is
 * found there.
 */
function acrossBoundary(cell: (v: number) => number, scale: FlowJoGridScale, v: number, target: number): number | null {
  const from = cell(v);
  const known = scale.centre(target);
  if (!Number.isFinite(known) || cell(known) !== target) return null;
  let [lo, hi] = target < from ? [known, v] : [v, known];
  const want = (x: number): boolean => (target < from ? cell(x) <= target : cell(x) >= target);
  for (let i = 0; i < 4000; i++) {
    const mid = lo + (hi - lo) / 2;
    if (!(mid > lo && mid < hi)) break;
    if (want(mid) === (target < from)) lo = mid;
    else hi = mid;
  }
  const out = target < from ? lo : hi;
  return cell(out) === target ? out : null;
}

/** Bounds on the work of snapOntoGrid, beyond which it names the gate rather than search. */
const SNAP_NEAR_BUDGET = 5e7;
const SNAP_SEARCH_BUDGET = 2e8;

/**
 * The ring with some of its coordinates moved, each just across one boundary of the channel FlowJo
 * puts it on, to the nearest value on the other side (acrossBoundary), so that FlowJo's grid reads
 * the file's events exactly as GateLab holds them; null where no such move is found. Equal
 * coordinates on one axis move together, so an edge along an axis stays along it. Only a gate no
 * channel pair holds events of both kinds in can be read exactly, and only the channel pairs within
 * two channels of an edge can change side; the search is greedy, one coordinate at a time, the
 * nearer boundary first, keeping a move that lowers the count, until none does. A coordinate moves by
 * less than a channel, and gridOutcome keeps the moves only where a reader testing the polygon
 * continuously holds the same events of the file after them as before (continuousAlike).
 */
function snapOntoGrid(r: GridReading, ring: readonly Vertex[]): Vertex[] | null {
  if (r.lost) return null;
  for (let s = 0; s < r.cx.length; s++) if (r.held[s] && r.other[s]) return null;
  const n = ring.length;
  const lattice = latticeOf(r, ring);
  if (lattice.some((v) => !Number.isFinite(v[0]) || !Number.isFinite(v[1]))) return null;
  // The channel pairs a move can take to the other side: within two channels of an edge.
  let [lx0, lx1, ly0, ly1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [x, y] of lattice) {
    if (x < lx0) lx0 = x;
    if (x > lx1) lx1 = x;
    if (y < ly0) ly0 = y;
    if (y > ly1) ly1 = y;
  }
  [lx0, lx1, ly0, ly1] = [lx0 - 3, lx1 + 3, ly0 - 3, ly1 + 3];
  const boxed: number[] = [];
  for (let s = 0; s < r.cx.length; s++) if (r.cx[s] >= lx0 && r.cx[s] <= lx1 && r.cy[s] >= ly0 && r.cy[s] <= ly1) boxed.push(s);
  if (boxed.length * n > SNAP_NEAR_BUDGET) return null;
  const nearEdge = (px: number, py: number): boolean => {
    for (let i = 0; i < n; i++) {
      const [ax, ay] = lattice[i];
      const [bx, by] = lattice[(i + 1) % n];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      if (ex * ex + ey * ey <= 4) return true;
    }
    return false;
  };
  const near = boxed.filter((s) => nearEdge(r.cx[s], r.cy[s]));
  const inside = gateMaskPolygon(r.cx, r.cy, lattice);
  const isNear = new Uint8Array(r.cx.length);
  for (const s of near) isNear[s] = 1;
  for (let s = 0; s < r.cx.length; s++) if (!isNear[s] && (inside[s] ? r.other[s] : r.held[s])) return null;
  const nx = Float64Array.from(near, (s) => r.cx[s]);
  const ny = Float64Array.from(near, (s) => r.cy[s]);
  const differ = (l: Vertex[]): number => {
    const m = gateMaskPolygon(nx, ny, l);
    let d = 0;
    for (let j = 0; j < near.length; j++) d += m[j] ? r.other[near[j]] : r.held[near[j]];
    return d;
  };
  // One group per distinct coordinate value on each axis, with the channels it may move to.
  interface Group { k: 0 | 1; members: number[]; from: number; options: { cell: number; value: number; shift: number }[] }
  const groups: Group[] = [];
  for (const k of [0, 1] as const) {
    const spec = k === 0 ? r.sx : r.sy;
    const scale = k === 0 ? r.gx : r.gy;
    const cell = k === 0 ? r.vertexX : r.vertexY;
    const byValue = new Map<number, number[]>();
    ring.forEach((v, i) => {
      const list = byValue.get(v[k]);
      if (list) list.push(i);
      else byValue.set(v[k], [i]);
    });
    for (const [value, members] of byValue) {
      // FlowJo puts a log vertex at or below zero on the floor, which no nearby value moves.
      if (spec.axis.kind === "wsplog" && value <= 0) continue;
      const from = cell(value);
      const options: Group["options"] = [];
      for (const target of [from - 1, from + 1]) {
        if (spec.axis.kind === "biex" && (target < 0 || target > spec.channels)) continue;
        const moved = acrossBoundary(cell, scale, value, target);
        if (moved !== null) options.push({ cell: target, value: moved, shift: Math.abs(scale.channel(moved) - scale.channel(value)) });
      }
      options.sort((a, b) => a.shift - b.shift);
      if (options.length) groups.push({ k, members, from, options });
    }
  }
  if (!groups.length || near.length * n * groups.length * 2 * 4 > SNAP_SEARCH_BUDGET) return null;
  let current = lattice.map((v) => [v[0], v[1]] as Vertex);
  let count = differ(current);
  const chosen = new Array<number>(groups.length).fill(-1);
  for (let pass = 0; pass < 4 && count > 0; pass++) {
    let changed = false;
    for (let g = 0; g < groups.length && count > 0; g++) {
      const grp = groups[g];
      for (let o = -1; o < grp.options.length; o++) {
        if (o === chosen[g]) continue;
        const target = o < 0 ? grp.from : grp.options[o].cell;
        const trial = current.map((v) => [v[0], v[1]] as Vertex);
        for (const i of grp.members) trial[i][grp.k] = target;
        const c = differ(trial);
        if (c < count) {
          current = trial;
          count = c;
          chosen[g] = o;
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  if (count > 0) return null;
  const out = ring.map((v) => [v[0], v[1]] as Vertex);
  groups.forEach((grp, g) => {
    if (chosen[g] < 0) return;
    for (const i of grp.members) out[i][grp.k] = grp.options[chosen[g]].value;
  });
  return gridDiffers(r, latticeOf(r, out)).differ === 0 ? out : null;
}

/**
 * Whether a reader testing a written ring continuously on the declared axes, as FlowKit and GateLab's
 * import without its records and with the grid off do, holds the same events of the file inside ring
 * `a` as inside ring `b` (both in file values). A move onto the grid (snapOntoGrid) is kept only then,
 * so that it changes the reading of no one but FlowJo's grid.
 */
function continuousAlike(sample: Sample, gate: Gate, ax: Axis, ay: Axis, a: readonly Vertex[], b: readonly Vertex[]): boolean {
  const ix = sample.index(gate.x_channel);
  const iy = sample.index(gate.y_channel);
  if (ix === undefined || iy === undefined) return false;
  const rx = sample.rawColumnData(ix);
  const ry = sample.rawColumnData(iy);
  const dx = new Float64Array(rx.length);
  const dy = new Float64Array(ry.length);
  for (let i = 0; i < rx.length; i++) {
    dx[i] = ax.forward(rx[i] * ax.fileScale);
    dy[i] = ay.forward(ry[i] * ay.fileScale);
  }
  const shown = (ring: readonly Vertex[]): Vertex[] => ring.map(([x, y]) => [ax.forward(x), ay.forward(y)] as Vertex);
  return sameMask(gateMaskPolygon(dx, dy, shown(a)), gateMaskPolygon(dx, dy, shown(b)));
}

/**
 * What to write for a polygon FlowJo grids (see above): as written where the grid reads it as GateLab
 * holds it, a rectangle, moved coordinates, or as written and named. `out` is the ring as it would be
 * written, in file values; `held` the gate's own ring, in its space; `channels` the gateResolution.
 */
function gridOutcome(
  sample: Sample, gate: Gate, held: readonly Vertex[], out: readonly Vertex[], floorAxis: { k: 0 | 1; floor: number } | null,
  ax: Axis, ay: Axis, channels: number, memo?: GridMemo,
): GridOutcome {
  if (!declaredGridAxis(ax, channels) || !declaredGridAxis(ay, channels)) return { kind: "as-written" };
  const mask = getGateMask(gate, columnsForGate(sample.gateAssayData(), gate));
  const r = gridReadingOf(sample, gate, ax, ay, channels, mask, memo);
  if (!r) return { kind: "as-written" };
  const { differ, inside } = gridDiffers(r, latticeOf(r, out));
  if (!differ) return { kind: "as-written" };
  const rect = rectangleInstead(sample, gate, held, floorAxis, ax, ay, mask);
  if (rect) return { kind: "rectangle", ...rect };
  const moved = snapOntoGrid(r, out);
  if (moved && continuousAlike(sample, gate, ax, ay, out, moved)) return { kind: "moved", ring: moved };
  // What tells which events FlowJo reads otherwise, so that the warning can count them within a
  // population's parent (gridNote): the grid's reading is the ring's on the event's channel pair.
  return {
    kind: "named", differ, events: r.events, channels,
    reading: { ex: r.ex, ey: r.ey, nx: r.nx, slot: r.slot, inside, mask },
    shape: gate.gate_type === "ellipse" ? "an ellipse written as a polygon" : "a polygon",
  };
}

/** Whether a FlowJo axis a gate was saved on is the one declared. */
function sameFlowJoAxis(own: FlowJoGridAxis, decl: AxisDecl): boolean {
  if (own.kind === "linear") return decl.kind === "linear" && decl.minRange === own.minRange && decl.maxRange === own.maxRange;
  if (own.kind === "wsplog") return decl.kind === "log" && decl.offset === own.offset && decl.decades === own.decades;
  return decl.kind === "biex" && decl.params.maxValue === own.maxValue && decl.params.pos === own.pos
    && decl.params.neg === own.neg && decl.params.widthBasis === own.widthBasis && decl.params.channelRange === own.channelRange;
}

/**
 * Where FlowJo moves an event beyond a declared axis before it compares a rectangle's bounds, in
 * file values: both ends of a linear axis, the offset of a log axis and the bottom of a biex
 * table, and nothing above those two (the rectangle rule, flowjoWorkspace.ts).
 */
function clampEdges(decl: AxisDecl): [number, number] {
  if (decl.kind === "linear") return [decl.minRange, decl.maxRange];
  if (decl.kind === "log") return [decl.offset, Infinity];
  if (decl.kind === "biex") return [biexBreakpoints({ ...decl.params, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS }).raw[0], Infinity];
  return [-Infinity, Infinity];
}

function describeFlowJoAxis(a: FlowJoGridAxis): string {
  if (a.kind === "linear") return `a linear axis from ${fmtNum(a.minRange)} to ${fmtNum(a.maxRange)}`;
  if (a.kind === "wsplog") return `a log axis from ${fmtNum(a.offset)} over ${fmtNum(a.decades)} decades`;
  return `a biex axis to ${fmtNum(a.maxValue)}, width ${fmtNum(a.widthBasis)}`;
}

function describeAxisDecl(d: AxisDecl): string {
  if (d.kind === "linear") return `linear axis from ${fmtNum(d.minRange)} to ${fmtNum(d.maxRange)}`;
  if (d.kind === "log") return `log axis from ${fmtNum(d.offset)} over ${fmtNum(d.decades)} decades`;
  if (d.kind === "biex") return `biex axis to ${fmtNum(d.params.maxValue)}, width ${fmtNum(d.params.widthBasis)}`;
  return "arcsinh axis";
}

/**
 * One axis of a rectangle as file values, with an edge that has no bound left out: an edge GateLab
 * holds as unbounded (UNBOUNDED, an absent bound on a Gating-ML import), or one whose raw value is
 * beyond every number on its own side. Those were written as 0 until 2026-09 (fmtNum wrote any
 * non-finite value so), which emptied an open-top range. A dimension left with neither bound gets
 * min at −UNBOUNDED, below every value, as Gating-ML requires one (see gatingmlExport).
 */
function rectangleBounds(sample: Sample, gate: PolyRectGate, channel: string, k: 0 | 1, fileScale: number): { lo?: number; hi?: number } {
  const stored = gate.vertices.map((v) => v[k]);
  const edge = (v: number, side: "lo" | "hi"): number | undefined => {
    if (isUnbounded(v)) return undefined;
    const raw = sample.gateToRaw(gate, channel, v) * fileScale;
    if (Number.isFinite(raw) && !isUnbounded(raw)) return raw;
    if (side === "lo" ? raw <= -UNBOUNDED : raw >= UNBOUNDED) return undefined;
    throw new Error(`The gate "${gate.name}" has an edge at ${v} that cannot be written to a FlowJo workspace.`);
  };
  const b = { lo: edge(Math.min(...stored), "lo"), hi: edge(Math.max(...stored), "hi") };
  return b.lo === undefined && b.hi === undefined ? { lo: -UNBOUNDED } : b;
}

/**
 * A rectangle's element, its bounds in raw values (rectangleBounds: an edge with no bound left out).
 * `fmt` writes FlowJo's own saved bounds with every digit (fmtExact; feat/flowjo-grid).
 *
 * A range, a rectangle whose two axes are one channel (how GateLab holds a histogram gate), is
 * written as FlowJo writes one: a single dimension, its bounds the interval both axes hold. Written
 * with the dimension twice it was not FlowJo's range, and a reader that takes the first dimension
 * as x and the second as y read another gate (FlowKit refuses the repeated dimension).
 */
function rectangleXml(
  sample: Sample, gate: PolyRectGate, ax: Axis, ay: Axis, id: string, fmt: (x: number) => string = fmtNum,
): string[] {
  const x = rectangleBounds(sample, gate, gate.x_channel, 0, ax.fileScale);
  const y = rectangleBounds(sample, gate, gate.y_channel, 1, ay.fileScale);
  if (gate.x_channel === gate.y_channel) {
    const bound = (b: { lo?: number; hi?: number }) => ({ lo: b.lo !== undefined && b.lo <= -UNBOUNDED ? undefined : b.lo, hi: b.hi });
    const [bx, by] = [bound(x), bound(y)];
    const lo = bx.lo === undefined ? by.lo : by.lo === undefined ? bx.lo : Math.max(bx.lo, by.lo);
    const hi = bx.hi === undefined ? by.hi : by.hi === undefined ? bx.hi : Math.min(bx.hi, by.hi);
    return [
      `<gating:RectangleGate ${gateAttrs} percentX="0" percentY="0" gating:id="${id}">`,
      ...(lo === undefined && hi === undefined ? dimensionXml(ax, -UNBOUNDED, undefined, fmt) : dimensionXml(ax, lo, hi, fmt)),
      "</gating:RectangleGate>",
    ];
  }
  return [
    `<gating:RectangleGate ${gateAttrs} percentX="0" percentY="0" gating:id="${id}">`,
    ...dimensionXml(ax, x.lo, x.hi, fmt),
    ...dimensionXml(ay, y.lo, y.hi, fmt),
    "</gating:RectangleGate>",
  ];
}

/**
 * A rectangle as FlowJo should read it, plus GateLab's own record of it (rectangleRecord.ts).
 *
 * FlowJo holds both edges of a rectangle (WSP_RECT_BOUNDS_TAG), and CytoML's cytolib does too,
 * so a half-open GateLab rectangle is written with its upper bounds just below the edge
 * (upperBoundForReader), in raw values, and the events on the edge stay out; where GateLab's own
 * float32 decision of an event at an edge is not what that number gives FlowJo, the bound then goes
 * onto the file's events on GateLab's side (onGateLabSide), and the record keeps the bounds from
 * before (placedFrom), which the FlowJo import checks the geometry against. A zero-width
 * half-open rectangle selects nothing; its lower bound follows the moved upper one, because a
 * rectangle whose minimum exceeds its maximum is not a rectangle to every reader (cytolib refuses
 * it: "invalid vertices for rectgate!"). An edge with no bound, a coordinate at or beyond the
 * largest double, is left as it is for rectangleXml to write.
 *
 * rectangleXml writes the moved rectangle, handed to it in raw values, and the record rides as
 * one attribute on its gate element, beside FlowJo's own attributes there. The record's copy of
 * the written bounds is read off the lines rectangleXml produced, so it is always the file's own.
 * It gives GateLab back its rectangle exactly: the bounds above are raw values that come back into
 * a float32 display column, where an event on the edge can land on either side of them.
 *
 * A bound held as no bound (isOpenBound, the importer's ±1e9 included) is never moved or taken
 * through the axis's inverse: rectangleXml leaves it out. FlowJo's own rectangle, imported by
 * FlowJo's rule (raw, closed, with PolyRectGate.flowjo_axes or flowjo_bounds), goes back as FlowJo
 * saved it: every bound with every digit, no record, and a bound the rule opened as FlowJo's own
 * value (flowjo_bounds) where that value reaches the edge of the axis the file declares, so that an
 * import of the file reads it as FlowJo's rectangle again and the import's option decides how, as it
 * did the first time. Where FlowJo's value falls inside the declared axis it goes out as no bound,
 * which FlowJo reads as it read its own; an import with the option off then reads it open, not as
 * the source's rectangle (Time, whose declared axis ends at the data's last tick, wherever an event
 * lies past FlowJo's value: FR-FCM-Z2HV 1,060 events, FR-FCM-Z2WY 682; bde2d12, a decision in #351).
 */
function rectangleForFlowJo(
  sample: Sample, gate: PolyRectGate, ax: Axis, ay: Axis, id: string, warnings?: string[],
  /**
   * The bounds moved off this file's events (clearOfEvents), [x min, x max, y min, y max];
   * rectangleInstead's, which checks FlowJo's reading.
   */
  opts: { clearOfEvents?: ClearBounds } = {},
): string[] {
  const rule = rectangleRule(gate);
  const flowJoOwn = rule === "closed" && sample.gateSpace(gate) === "raw" && !!(gate.flowjo_axes || gate.flowjo_bounds);
  const notes: string[] = [];
  // Each axis's [min, max] as written, and as it was before being placed among this file's events
  // (clearOfDisplay, onGateLabSide), which GateLab's record keeps (placedFrom) so that an import of
  // the file holds the placed geometry to what the rectangle itself makes.
  const span = (channel: string, k: 0 | 1, a: Axis): [number, number, number, number] => {
    const fileScale = a.fileScale;
    const stored = gate.vertices.map((v) => v[k]);
    const [lo, hi] = [Math.min(...stored), Math.max(...stored)];
    let saved = flowJoOwn ? gate.flowjo_bounds?.[channel] : undefined;
    // FlowJo saved the rectangle on another axis for this channel than the one the file declares
    // (another gate on the channel holds it), or on an axis the gate does not record (Time, which
    // FlowJo saves at its Time axis's gain and the file declares in seconds over the data): FlowJo
    // moves an event beyond the declared axis onto its edge, then compares the bounds. A bound the
    // rule opened goes out as FlowJo's own value only where that value lies at or beyond the
    // declared edge, which takes every event beyond it as GateLab's open bound does, and is left
    // out otherwise; a bound GateLab holds is written as it is, which the clamp keeps exactly while
    // it lies inside the declared axis. FlowJo's Time bound, in ticks (flowjo_bounds), reached past
    // a declared Time axis ending at the data's last tick only where no event lies beyond it: left
    // in, it dropped the events FlowJo moves onto the axis's edge.
    const own = flowJoOwn ? gate.flowjo_axes?.[channel] : undefined;
    if (saved && (!own || !sameFlowJoAxis(own, a.decl))) {
      const [edgeLo, edgeHi] = clampEdges(a.decl);
      saved = [
        saved[0] !== null && saved[0] * fileScale <= edgeLo ? saved[0] : null,
        saved[1] !== null && saved[1] * fileScale >= edgeHi ? saved[1] : null,
      ];
    }
    if (own && !sameFlowJoAxis(own, a.decl)) {
      const [edgeLo, edgeHi] = clampEdges(a.decl);
      const column = columnsForGate(sample.gateAssayData(), gate).column(channel);
      const beyond = (test: (v: number) => boolean): number => {
        let n = 0;
        if (column) for (let i = 0; i < column.length; i++) if (test(column[i])) n++;
        return n;
      };
      const rawLo = isOpenBound(lo) ? null : sample.gateToRaw(gate, channel, lo);
      const rawHi = isOpenBound(hi) ? null : sample.gateToRaw(gate, channel, hi);
      const below = rawLo !== null && rawLo * fileScale <= edgeLo ? beyond((v) => v < rawLo) : 0;
      const above = rawHi !== null && rawHi * fileScale >= edgeHi ? beyond((v) => v > rawHi) : 0;
      const kept = below + above === 0
        ? "where FlowJo's clamp keeps GateLab's events"
        : `where FlowJo moves the ${below + above} events of this file ${below ? `below ${fmtNum(rawLo!)}` : ""}${below && above ? " and " : ""}${above ? `above ${fmtNum(rawHi!)}` : ""} onto the axis's edge and counts them inside it, as GateLab does not`;
      notes.push(`${a.name}: saved on ${describeFlowJoAxis(own)}, written against the declared ${describeAxisDecl(a.decl)}, ${kept}`);
    }
    // Moved in raw values, the events' own, so that no float32 event lies between the edge and the
    // moved bound (gates.ts, float32Side); rectangleXml scales it into the file's units.
    let top = isOpenBound(hi) ? saved?.[1] ?? hi : upperBoundForReader(sample.gateToRaw(gate, channel, hi), rule, "closed");
    const topBefore = top;
    if (!isOpenBound(hi) && rule === "half-open") top = clearOfDisplay(sample, channel, sample.gateToRaw(gate, channel, hi), top, a);
    // On this file's events, where GateLab's own decision at the edge and the written number part.
    if (!flowJoOwn && !isOpenBound(hi)) top = onGateLabSide(sample, gate, channel, "hi", hi, rule, top);
    // GateLab puts every event below a FlowJo log's offset, a floored flog's or a biex table's first
    // entry on the display's floor (floorOf). On an axis that does not move them onto that very value
    // (clampsAtFloor: a channel declared otherwise, logMisreadsOtherGates, biexMisreadsOtherGates, or
    // a biex on FlowJo's own table), a rectangle holding the floor goes out with no lower bound, and
    // one below the floor, which holds none of them nor any other event, where no event lies for any
    // reader (emptyAt).
    const clamp = floorOf(gateSpec(sample, gate, channel));
    if (clamp !== null && !clampsAtFloor(a.decl, clamp * fileScale)) {
      const floor = sample.rawToGate(gate, channel, clamp);
      const holdsFloor = (isOpenBound(lo) || lo <= floor) && (isOpenBound(hi) || (rule === "half-open" ? floor < hi : floor <= hi));
      if (!holdsFloor && !isOpenBound(hi) && hi <= floor) {
        const empty = emptyAt(sample, channel, a);
        return [empty, empty, empty, empty];
      }
      if (holdsFloor && !isOpenBound(lo)) return [-UNBOUNDED, top, -UNBOUNDED, topBefore];
    }
    let bottom = isOpenBound(lo) ? saved?.[0] ?? lo : Math.min(sample.gateToRaw(gate, channel, lo), top);
    const bottomBefore = isOpenBound(lo) ? bottom : Math.min(sample.gateToRaw(gate, channel, lo), topBefore);
    if (!flowJoOwn && !isOpenBound(lo)) bottom = Math.min(onGateLabSide(sample, gate, channel, "lo", lo, rule, bottom), top);
    return [bottom, top, bottomBefore, topBefore];
  };
  const placed = (channel: string, k: 0 | 1, a: Axis): [number, number, number, number] => {
    const got = span(channel, k, a);
    const which = opts.clearOfEvents;
    return which && (which[2 * k] || which[2 * k + 1]) ? clearOfEvents(sample, channel, got, [which[2 * k], which[2 * k + 1]]) : got;
  };
  const [x0, x1, bx0, bx1] = placed(gate.x_channel, 0, ax);
  const [y0, y1, by0, by1] = placed(gate.y_channel, 1, ay);
  // A range's one channel is both axes; it is named once.
  if (notes.length) warnings?.push(`"${gate.name}" was saved by FlowJo on an axis this file declares differently (${[...new Set(notes)].join("; ")}).`);
  if (!flowJoOwn) {
    const moved = eventsFlowJoMoves(sample, gate, ax, ay, [x0, x1], [y0, y1]);
    if (moved) warnings?.push(moved);
  }
  const written: PolyRectGate = { ...gate, space: "raw", vertices: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
  delete written.transforms;
  if (flowJoOwn) return rectangleXml(sample, written, ax, ay, id, fmtExact);
  const lines = rectangleXml(sample, written, ax, ay, id);
  const moved = x0 !== bx0 || x1 !== bx1 || y0 !== by0 || y1 !== by1;
  const from = moved
    ? writtenRectangleBounds(rectangleXml(sample, { ...written, vertices: [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]] }, ax, ay, id)).get(id)
    : undefined;
  const record = { ...rectangleRecordOf(sample, gate), written: writtenRectangleBounds(lines).get(id) ?? [], ...(from ? { placedFrom: from } : {}) };
  lines[0] = lines[0].replace(/ gating:id="/, ` ${WSP_RECTANGLE_ATTR}="${escAttr(JSON.stringify(record))}" gating:id="`);
  return lines;
}

/** Which bounds of a rectangle go clear of the file's events: x min, x max, y min, y max. */
type ClearBounds = readonly [boolean, boolean, boolean, boolean];

/**
 * One axis of a rectangle as rectangleForFlowJo's span gives it, [min, max, min before, max before] in
 * raw values, with each finite bound `which` names ([min, max]) that lies on a value of this file's
 * channel, or on an axis whose two bounds are one value, moved halfway to the nearest value beyond it
 * (above a maximum, below a minimum), so that no event lies on the edge and, both named, never
 * min == max: a reader holds what GateLab holds whichever edges it keeps, as with floorOnlyRing's
 * strips and emptyAt's bands. A bound with no value beyond it goes past the value by its own magnitude
 * plus one; one left out (±UNBOUNDED) stays. rectangleInstead checks that FlowJo's rule still reads
 * the moved bounds as GateLab holds the gate (an event beyond the declared axis is moved onto its end
 * first) and keeps them only then.
 */
function clearOfEvents(
  sample: Sample, channel: string, [lo, hi, loBefore, hiBefore]: [number, number, number, number], which: readonly [boolean, boolean],
): [number, number, number, number] {
  const idx = sample.index(channel);
  const column = idx === undefined ? null : sample.rawColumnData(idx);
  if (!column) return [lo, hi, loBefore, hiBefore];
  const bounded = (v: number) => Number.isFinite(v) && Math.abs(v) < UNBOUNDED;
  const onValue = (v: number): boolean => {
    for (let i = 0; i < column.length; i++) if (column[i] === v) return true;
    return false;
  };
  // The nearest value of the channel beyond v, above (dir 1) or below (dir -1); NaN where none.
  const beyond = (v: number, dir: 1 | -1): number => {
    let best = NaN;
    for (let i = 0; i < column.length; i++) {
      const c = column[i];
      if (dir > 0 ? c > v && !(c >= best) : c < v && !(c <= best)) best = c;
    }
    return best;
  };
  const away = (v: number, dir: 1 | -1): number => {
    const next = beyond(v, dir);
    const mid = Number.isFinite(next) ? v + (next - v) / 2 : v + dir * (Math.abs(v) + 1);
    return dir > 0 ? (mid > v ? mid : v) : (mid < v ? mid : v);
  };
  const zeroWidth = bounded(lo) && bounded(hi) && lo === hi;
  const newHi = which[1] && bounded(hi) && (zeroWidth || onValue(hi)) ? away(hi, 1) : hi;
  const newLo = which[0] && bounded(lo) && (zeroWidth || onValue(lo)) ? away(lo, -1) : lo;
  return [newLo, newHi, loBefore, hiBefore];
}

/**
 * A rectangle's bound as written for FlowJo, in raw values, moved onto this file's own events where
 * GateLab's decision at the edge and FlowJo's closed reading of the written number part: every event
 * GateLab holds by that bound is held by the file, and no other. GateLab decides a gate on a display
 * on its own float32 column of the display's values, and FlowJo compares the event's raw value with
 * the written one, so an event lying on the edge in double precision is on whichever side float32
 * rounding put it for GateLab: at 192.0 on the public S8 file's V10 (590)-T, a half-open CD3−
 * rectangle held 18 events whose float32 display lies below the edge, and the bound went out at
 * 191.99999999998076, below them (upperBoundForReader); likewise 160 events at Event_length 60.0,
 * float32(asinh(4)) lying below asinh(4) (random-0026 "IFN-γ"). The bound goes onto the nearest of
 * this file's values that puts every event on GateLab's side of it: the greatest GateLab holds for an
 * upper bound written below it, the least it holds for a lower one written above it, where FlowJo's
 * closed rule holds an event on the bound. Left as it is where it already agrees with GateLab at every
 * event, and where GateLab's decision is no threshold on the raw values (it always is: a display is
 * monotone, and so is its float32 rounding). `edge` is the gate's own coordinate, `written` the bound
 * as it would be written.
 */
function onGateLabSide(
  sample: Sample, gate: PolyRectGate, channel: string, side: "lo" | "hi", edge: number, rule: "closed" | "half-open", written: number,
): number {
  const idx = sample.index(channel);
  const own = columnsForGate(sample.gateAssayData(), gate).column(channel);
  if (idx === undefined || !own || !Number.isFinite(written)) return written;
  const raw = sample.rawColumnData(idx);
  // GateLab's side of each event: the greatest raw value it holds and the least it leaves out (hi),
  // or the least it holds and the greatest it leaves out (lo).
  let inside = side === "hi" ? -Infinity : Infinity;
  let outside = side === "hi" ? Infinity : -Infinity;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const g = own[i];
    if (!Number.isFinite(r) || Number.isNaN(g)) continue;
    const held = side === "hi" ? (rule === "half-open" ? g < edge : g <= edge) : g >= edge;
    if (side === "hi") {
      if (held) { if (r > inside) inside = r; } else if (r < outside) outside = r;
    } else if (held) { if (r < inside) inside = r; } else if (r > outside) outside = r;
  }
  if (side === "hi") {
    if (!(inside < outside)) return written;
    if (written >= inside && written < outside) return written;
    if (written < inside) return inside;
    return Number.isFinite(inside) ? inside : below(outside);
  }
  if (!(outside < inside)) return written;
  if (written <= inside && written > outside) return written;
  if (written > inside) return inside;
  return Number.isFinite(inside) ? inside : above(outside);
}

/** The next double below (above) a finite x. */
function below(x: number): number {
  return nextDouble(x, -1);
}
function above(x: number): number {
  return nextDouble(x, 1);
}
function nextDouble(x: number, dir: 1 | -1): number {
  if (x === 0) return dir * Number.MIN_VALUE;
  const f = new Float64Array([x]);
  const b = new BigInt64Array(f.buffer);
  b[0] += (x > 0) === (dir > 0) ? 1n : -1n;
  return f[0];
}

/**
 * A half-open rectangle's upper bound, moved just below its edge for FlowJo's closed rule
 * (upperBoundForReader), where the declared axis's display cannot tell the moved bound from the edge
 * (a bound at 0 moved to -1e-300 on a FlowJo ArcSinh or biex axis, whose display of both is the same
 * double): halfway between the edge and the nearest of this file's values below it, where the display
 * tells them apart. FlowJo compares a rectangle's bounds in raw values on linear, log and biex axes
 * (feat/flowjo-grid, measured), and on an ArcSinh axis this is not established; a reader comparing in
 * the display, FlowKit among them, held every event on the edge (the interoperability sweep's
 * random-0026 "IFN-γ /  lead space", 2,503 zeros on Sm149Di). Placed so, both readings hold this
 * file's events as GateLab does, and no event lies between the edge and the bound. Left as it is
 * where the display already tells them apart, or no such place lies between the edge and the value
 * below it.
 */
function clearOfDisplay(sample: Sample, channel: string, edge: number, moved: number, a: Axis): number {
  if (!(moved < edge) || a.forward(moved * a.fileScale) !== a.forward(edge * a.fileScale)) return moved;
  const idx = sample.index(channel);
  if (idx === undefined) return moved;
  const column = sample.rawColumnData(idx);
  let below = -Infinity;
  for (let i = 0; i < column.length; i++) if (column[i] < edge && column[i] > below) below = column[i];
  if (!Number.isFinite(below)) return moved;
  const mid = below + (edge - below) / 2;
  return mid < edge && mid > below && a.forward(mid * a.fileScale) < a.forward(edge * a.fileScale) ? mid : moved;
}

/**
 * Where a rectangle GateLab holds has a bound at or beyond an edge FlowJo moves the events of the
 * declared axis onto before it compares a rectangle's bounds (clampEdges: a log axis's offset, a
 * biex table's bottom, both ends of a linear axis), the events of this file FlowJo so counts
 * otherwise than GateLab, named in one warning; null when there are none. `xs` and `ys` are the
 * bounds as written, in raw values.
 *
 * The declared axis is the channel's, not the gate's: a channel another gate holds on FlowJo's log
 * or on Gating-ML's flog is declared as FlowJo's log (declareAxis), and a rectangle of GateLab's on
 * logicle, arcsinh or raw values beside it keeps its bounds. FlowJo puts every event below the log
 * axis's offset on the offset, inside a rectangle whose lower bound lies at or below it, and a bound
 * below the offset holds nothing apart there. It went without a word, where a polygon's vertex in
 * the same place was named: the interoperability sweep's fail:flowjo-axis-range rows, 36 of 43 of
 * them on this candidate (the corpus's rect-edges-display "asinh" 3,785 events in GateLab and 5,366
 * read by FlowJo's rule; random-0059 "A&B", events on Comp-FL3-A below 0 on a log axis from 1; the
 * release candidate's verifier). GateLab's own reading of the file uses its record and is exact.
 */
function eventsFlowJoMoves(
  sample: Sample, gate: PolyRectGate, ax: Axis, ay: Axis, xs: [number, number], ys: [number, number],
): string | null {
  const lo = (v: number) => (isOpenBound(v) ? -Infinity : v);
  const hi = (v: number) => (isOpenBound(v) ? Infinity : v);
  const axes = [{ channel: gate.x_channel, a: ax, b: xs }, { channel: gate.y_channel, a: ay, b: ys }];
  const reach = axes.map(({ a, b }) => {
    const [edgeLo, edgeHi] = clampEdges(a.decl).map((e) => e / a.fileScale);
    const bounds = b.filter((v) => !isOpenBound(v));
    return {
      edgeLo, edgeHi, below: bounds.some((v) => v <= edgeLo), above: bounds.some((v) => v >= edgeHi),
      // No part of the rectangle inside the axis on this side: every event FlowJo moves lands on one
      // value at or beyond the bound, and FlowJo's count of that value is not established.
      wholly: hi(b[1]) <= edgeLo || lo(b[0]) >= edgeHi,
    };
  });
  if (!reach.some((r) => r.below || r.above)) return null;
  // The raw values the bounds are in, and GateLab's membership from the values it gates on.
  const columns = axes.map(({ channel }) => {
    const idx = sample.index(channel);
    return idx === undefined ? undefined : sample.rawColumnData(idx);
  });
  if (!columns[0] || !columns[1]) return null;
  const held = getGateMask(gate, columnsForGate(sample.gateAssayData(), gate));
  let differ = 0;
  let moved = 0;
  let heldMoved = 0;
  for (let i = 0; i < held.length; i++) {
    let beyond = false;
    let inside = true;
    for (let k = 0; k < 2; k++) {
      const v = columns[k]![i];
      const r = reach[k];
      if ((r.below && v < r.edgeLo) || (r.above && v > r.edgeHi)) beyond = true;
      const c = Math.min(Math.max(v, r.edgeLo), r.edgeHi);
      if (!(c >= lo(axes[k].b[0]) && c <= hi(axes[k].b[1]))) inside = false;
    }
    if (!beyond) continue;
    moved++;
    if (held[i] === 1) heldMoved++;
    if (inside !== (held[i] === 1)) differ++;
  }
  const wholly = reach.some((r) => r.wholly);
  if (wholly ? !heldMoved : !differ) return null;
  const where = [...new Set(axes.flatMap(({ a }, k) => [
    ...(reach[k].below ? [`${a.name} below ${fmtNum(reach[k].edgeLo * a.fileScale)}, the floor of the ${describeAxisDecl(a.decl)} declared for it`] : []),
    ...(reach[k].above ? [`${a.name} above ${fmtNum(reach[k].edgeHi * a.fileScale)}, the top of the ${describeAxisDecl(a.decl)} declared for it`] : []),
  ]))];
  const events = (n: number) => `${n} event${n === 1 ? "" : "s"}`;
  return wholly
    ? `"${gate.name}" lies at or beyond an edge FlowJo moves events onto before it compares a rectangle's bounds (${where.join("; ")}): FlowJo moves the ${events(moved)} of this file beyond it onto that edge, where the ${heldMoved} of them GateLab holds cannot be told from the rest.`
    : `"${gate.name}" has a bound at or beyond an edge FlowJo moves events onto before it compares a rectangle's bounds (${where.join("; ")}): FlowJo counts ${events(differ)} of this file otherwise than GateLab does.`;
}

/**
 * FlowJo's ellipsoid: two foci and four edge points in display channels, plus `distance`, the
 * major axis. Only when both axes map the gate's space affinely onto the display, because a
 * covariance through a nonlinear map is not a covariance; the caller samples the boundary
 * otherwise.
 */
function ellipsoidXml(sample: Sample, gate: EllipseGate, ax: Axis, ay: Axis, id: string): string[] | null {
  if (!ax.straightIn(gateSpec(sample, gate, gate.x_channel)) || !ay.straightIn(gateSpec(sample, gate, gate.y_channel))) return null;
  const mapX = (v: number): number => ax.forward(sample.gateToRaw(gate, gate.x_channel, v) * ax.fileScale);
  const mapY = (v: number): number => ay.forward(sample.gateToRaw(gate, gate.y_channel, v) * ay.fileScale);
  // Affine per axis, so two points give the scale exactly.
  const kx = mapX(gate.mean[0] + 1) - mapX(gate.mean[0]);
  const ky = mapY(gate.mean[1] + 1) - mapY(gate.mean[1]);
  if (!Number.isFinite(kx) || !Number.isFinite(ky) || kx === 0 || ky === 0) return null;
  const cx = mapX(gate.mean[0]);
  const cy = mapY(gate.mean[1]);
  const [[a, b], [, c]] = gate.covariance;
  const cov: [[number, number], [number, number]] = [[a * kx * kx, b * kx * ky], [b * kx * ky, c * ky * ky]];
  const { major, minor, angle } = axesFromCovariance(cov, gate.distance_square);
  if (!(major > 0) || !(minor > 0)) return null;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const f = Math.sqrt(Math.max(0, major * major - minor * minor));
  const foci: Vertex[] = [[cx - f * ux, cy - f * uy], [cx + f * ux, cy + f * uy]];
  const edge: Vertex[] = [
    [cx - major * ux, cy - major * uy], [cx + major * ux, cy + major * uy],
    [cx - minor * uy, cy + minor * ux], [cx + minor * uy, cy - minor * ux],
  ];
  return [
    `<gating:EllipsoidGate ${gateAttrs} gating:distance="${fmtNum(2 * major)}" gating:id="${id}">`,
    ...dimensionXml(ax), ...dimensionXml(ay),
    "  <gating:foci>", ...foci.flatMap(vertexXml).map((l) => `  ${l}`), "  </gating:foci>",
    "  <gating:edge>", ...edge.flatMap(vertexXml).map((l) => `  ${l}`), "  </gating:edge>",
    "</gating:EllipsoidGate>",
  ];
}

/**
 * One quadrant of a quadrant gate as the polygon FlowJo would write for it: the crosshair and
 * the axis limits, the arms bent as the gate bends them. In the gate's own space; polygonXml
 * densifies it wherever the declared display bends a bent arm.
 */
function quadrantRing(sample: Sample, gate: QuadrantGate, quadrant: number, ax: Axis, ay: Axis): { ring: Vertex[]; corners: number[] } {
  const toGateX = (file: number): number => sample.rawToGate(gate, gate.x_channel, file / ax.fileScale);
  const toGateY = (file: number): number => sample.rawToGate(gate, gate.y_channel, file / ay.fileScale);
  const [cx, cy] = gate.center;
  // Beyond the axis as FlowJo draws it AND beyond this file's data, so no event sits outside the
  // four polygons together: FlowJo clamps events to the axis, and a gate is unbounded in GateLab.
  const idxX = sample.index(gate.x_channel);
  const idxY = sample.index(gate.y_channel);
  const ex = idxX !== undefined ? columnExtent(sample, idxX) : null;
  const ey = idxY !== undefined ? columnExtent(sample, idxY) : null;
  const pad = (lo: number, hi: number): [number, number] => {
    const span = hi - lo || 1;
    return [lo - 0.01 * span, hi + 0.01 * span];
  };
  const [xlo0, xhi0] = pad(Math.min(toGateX(ax.range[0]), ex ? sample.rawToGate(gate, gate.x_channel, ex[0]) : Infinity, cx),
                          Math.max(toGateX(ax.range[1]), ex ? sample.rawToGate(gate, gate.x_channel, ex[1]) : -Infinity, cx));
  const [ylo0, yhi0] = pad(Math.min(toGateY(ay.range[0]), ey ? sample.rawToGate(gate, gate.y_channel, ey[0]) : Infinity, cy),
                          Math.max(toGateY(ay.range[1]), ey ? sample.rawToGate(gate, gate.y_channel, ey[1]) : -Infinity, cy));
  const xlo = Number.isFinite(xlo0) ? xlo0 : cx - 1;
  const xhi = Number.isFinite(xhi0) ? xhi0 : cx + 1;
  const ylo = Number.isFinite(ylo0) ? ylo0 : cy - 1;
  const yhi = Number.isFinite(yhi0) ? yhi0 : cy + 1;
  const curl = gate.curl && gate.curl.power > 0 && (gate.curl.kx !== 0 || gate.curl.ky !== 0) ? gate.curl : null;
  // The horizontal arm runs from the crosshair to the right, the vertical one upward; the arms
  // to the left and below stay straight (gates.ts, gateMaskQuadrant).
  // Sampled finely; polygonXml collapses the samples in the display to what tolerance needs.
  const ARM_STEPS = 256;
  // Each arm is held to the box: no event lies beyond it, so an event keeps its side of the arm
  // (gateMaskQuadrant compares it with the arm at its own x or y), and a bend that leaves the box
  // is not written. On an axis whose display grows slowly the bend can leave every finite raw
  // value -- 1.8e6 asinh units on a cofactor-150 axis -- and such a vertex cannot be written.
  const inBox = (lo: number, hi: number, v: number) => Math.min(hi, Math.max(lo, v));
  const hArm: Vertex[] = curl
    ? quadrantArmPoints(gate.center, curl, "h", xhi, ARM_STEPS).map(([x, y]): Vertex => [x, inBox(ylo, yhi, y)])
    : [[cx, cy], [xhi, cy]];
  const vArm: Vertex[] = curl
    ? quadrantArmPoints(gate.center, curl, "v", yhi, ARM_STEPS).map(([x, y]): Vertex => [inBox(xlo, xhi, x), y])
    : [[cx, cy], [cx, yhi]];
  const hEnd = hArm[hArm.length - 1];
  const vEnd = vArm[vArm.length - 1];
  const dropFirst = (r: Vertex[]): Vertex[] => r.slice(1);
  const crossed = curl ? crossedArmsRing(gate.center, curl, hArm, vArm, quadrant, [xlo, xhi, ylo, yhi]) : null;
  if (crossed) return crossed;
  // The true corners: the crosshair, the axis corners and the arm ends; everything between is
  // a sample of an arm.
  switch (quadrant) {
    case 1: { // x−/y+: left of the vertical arm, above the crosshair
      const ring: Vertex[] = [[xlo, cy], [cx, cy], ...dropFirst(vArm), [xlo, vEnd[1]]];
      return { ring, corners: [0, 1, ring.length - 2, ring.length - 1] };
    }
    case 2: { // x+/y+: right of the vertical arm, above the horizontal one
      const top = Math.max(vEnd[1], hEnd[1]);
      const ring: Vertex[] = [[cx, cy], ...dropFirst(hArm), [hEnd[0], top], [vEnd[0], top], ...[...vArm].reverse().slice(1, -1)];
      const hEndAt = hArm.length - 1;
      return { ring, corners: [0, hEndAt, hEndAt + 1, hEndAt + 2, hEndAt + 3] };
    }
    case 3: { // x+/y−: below the horizontal arm, right of the crosshair
      const ring: Vertex[] = [[cx, ylo], [hEnd[0], ylo], ...[...hArm].reverse()];
      return { ring, corners: [0, 1, 2, ring.length - 1] };
    }
    default: // 4, x−/y−
      return { ring: [[xlo, ylo], [cx, ylo], [cx, cy], [xlo, cy]], corners: [0, 1, 2, 3] };
  }
}

/**
 * A quadrant divider in file values, and where the four quadrants' shared edge on it goes: halfway
 * between the divider and the nearest of this file's values below it, where no event lies, so that
 * every reader puts an event on the divider above or right of it, as GateLab does, and one below it
 * below, whatever display it compares the edge in and whatever it does with an event on an edge (a
 * move by a unit in the last place is lost in a biex or log display's rounding). With no value
 * below, a millionth of the divider's magnitude below it.
 *
 * GateLab decides the side on its own column, float32 values of the gate's display for a gate on
 * one, and there an event lying on the divider in double precision is on whichever side float32
 * rounding put it: at Event_length 60.0 on a divider at asinh(60 / 15) = asinh(4), float32(asinh(4))
 * lies below the divider, and GateLab holds the 160 such events of random-0026 in quadrant 3, which
 * the edge placed below 60 gave to quadrant 2. Where the file's events on the divider's straight part
 * (all of it, or the part a curl does not bend: left of the crosshair for the horizontal divider,
 * below it for the vertical one) are not so divided at that place, the edge goes halfway between the
 * greatest value GateLab puts below or left of the divider and the least it puts above or right.
 */
function quadrantPullIn(sample: Sample, gate: QuadrantGate, channel: string, center: number, fileScale: number, k: 0 | 1 = 0): [number, number] {
  const divider = sample.gateToRaw(gate, channel, center);
  const idx = sample.index(channel);
  let below = -Infinity;
  if (idx !== undefined) {
    const column = sample.rawColumnData(idx);
    for (let i = 0; i < column.length; i++) if (column[i] < divider && column[i] > below) below = column[i];
  }
  let mid = Number.isFinite(below) ? below + (divider - below) / 2 : divider - 1e-6 * Math.max(1, Math.abs(divider));
  if (!(mid < divider)) mid = below;
  if (idx !== undefined) {
    const raw = sample.rawColumnData(idx);
    const cols = columnsForGate(sample.gateAssayData(), gate);
    const own = cols.column(channel);
    const other = cols.column(k === 0 ? gate.y_channel : gate.x_channel);
    const bent = !!gate.curl && gate.curl.power > 0 && (gate.curl.kx !== 0 || gate.curl.ky !== 0);
    const across = gate.center[k === 0 ? 1 : 0];
    let lowMax = -Infinity;
    let highMin = Infinity;
    if (own && other) {
      for (let i = 0; i < raw.length; i++) {
        if (bent && !(other[i] <= across)) continue;
        const r = raw[i];
        if (!Number.isFinite(r) || Number.isNaN(own[i])) continue;
        if (own[i] >= center) { if (r < highMin) highMin = r; } else if (r > lowMax) lowMax = r;
      }
    }
    if (!(lowMax < mid && mid < highMin) && lowMax < highMin) {
      // With no value on one side, a millionth of the other's magnitude beyond it.
      const m = Number.isFinite(lowMax) && Number.isFinite(highMin) ? lowMax + (highMin - lowMax) / 2
        : Number.isFinite(lowMax) ? lowMax + 1e-6 * Math.max(1, Math.abs(lowMax))
          : highMin - 1e-6 * Math.max(1, Math.abs(highMin));
      if (lowMax < m && m < highMin) mid = m;
    }
  }
  return [divider * fileScale, mid * fileScale];
}

/** Where segment a–b meets segment c–d: the point and its fraction along a–b, or null (parallel ones never). */
function segmentCrossing(a: Vertex, b: Vertex, c: Vertex, d: Vertex): { t: number; at: Vertex } | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (den === 0 || !Number.isFinite(den)) return null;
  const qx = c[0] - a[0];
  const qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (!(t >= 0 && t <= 1 && u >= 0 && u <= 1)) return null;
  return { t, at: [a[0] + t * rx, a[1] + t * ry] };
}

/**
 * A curled quadrant's ring where its two arms cross inside the box, or null where they do not.
 *
 * gateMaskQuadrant tests an event against each arm at the event's own x or y: to the right of the
 * vertical arm where x is at or beyond it, above the horizontal one where y is. When both arms
 * curl into the upper right (kx and ky positive) they cross once, at X, and the arms swap places
 * there: on one side of X the region between them is quadrant 2 (right of the one, above the
 * other), on the other side it is quadrant 4 (left of the one, below the other), and quadrants 1
 * and 3 lie above the upper and below the lower of the two arms. The four polygons written as if
 * the arms did not cross gave that region between the arms to quadrant 2 and left it out of
 * quadrant 4, where GateLab counts it (the interoperability sweep's fail:curly-quadrant-export,
 * random-0016 "T cells" and random-0052 "CD3-", and every population beneath them). Each ring here
 * follows the arm that bounds the quadrant on each side of X. Quadrant 4, the lower-left box and
 * the region between the arms beyond the crosshair, is one ring joined along the arm from the
 * crosshair (a seam of no width, which holds only the events exactly on that arm).
 */
function crossedArmsRing(
  center: [number, number], curl: NonNullable<QuadrantGate["curl"]>, hArm: readonly Vertex[], vArm: readonly Vertex[],
  quadrant: number, box: [number, number, number, number],
): { ring: Vertex[]; corners: number[] } | null {
  const [xlo, , ylo] = box;
  let hit: { i: number; j: number; at: Vertex } | null = null;
  for (let i = 0; i + 1 < hArm.length && !hit; i++) {
    let best: { j: number; t: number; at: Vertex } | null = null;
    for (let j = 0; j + 1 < vArm.length; j++) {
      if (i === 0 && j === 0) continue; // both arms start at the crosshair
      const c = segmentCrossing(hArm[i], hArm[i + 1], vArm[j], vArm[j + 1]);
      if (c && (!best || c.t < best.t)) best = { j, t: c.t, at: c.at };
    }
    if (best) hit = { i, j: best.j, at: best.at };
  }
  if (!hit) return null;
  const [cx, cy] = center;
  const X = hit.at;
  // Each arm from the crosshair to X, and from X to its end, X on both.
  const hHead: Vertex[] = [...hArm.slice(0, hit.i + 1), X];
  const hTail: Vertex[] = [X, ...hArm.slice(hit.i + 1)];
  const vHead: Vertex[] = [...vArm.slice(0, hit.j + 1), X];
  const vTail: Vertex[] = [X, ...vArm.slice(hit.j + 1)];
  const hEnd = hArm[hArm.length - 1];
  const vEnd = vArm[vArm.length - 1];
  // Which quadrant the region between the arms before X is: the horizontal arm's first sample
  // after the crosshair lies on it, above the horizontal arm; to the right of the vertical arm
  // (gateMaskQuadrant's test) it is quadrant 2 there, and quadrant 4 beyond X, else the reverse.
  const [px, py] = hArm[1];
  const xdiv = py > cy ? cx + curl.ky * Math.pow(py - cy, curl.power) : cx;
  const twoFirst = px >= xdiv;
  // A ring built from pieces: a corner is one point that must stay, an arm run a sample of an arm.
  const ring: Vertex[] = [];
  const corners: number[] = [];
  const corner = (p: Vertex) => { corners.push(ring.length); ring.push(p); };
  const run = (pts: readonly Vertex[]) => { for (const p of pts) ring.push(p); };
  const rev = (pts: readonly Vertex[]) => [...pts].reverse();
  const top = Math.max(vEnd[1], hEnd[1]);
  const right = Math.max(vEnd[0], hEnd[0]);
  // The upper arm before X and after it, and the lower; the lens between them (C to X), and the
  // region between them beyond X (X to the arms' ends).
  const [upHead, lowHead] = twoFirst ? [vHead, hHead] : [hHead, vHead];
  const [upTail, lowTail] = twoFirst ? [hTail, vTail] : [vTail, hTail];
  // The quadrant GateLab puts a point in (gateMaskQuadrant's test), for the box's top-right corner,
  // which the region between the arms beyond X reaches where one arm ends on the box's right edge
  // and the other on its top.
  const quadrantOf = (x: number, y: number): number => {
    const xd = y > cy ? cx + curl.ky * Math.pow(y - cy, curl.power) : cx;
    const yd = x > cx ? cy + curl.kx * Math.pow(x - cx, curl.power) : cy;
    return x >= xd ? (y >= yd ? 2 : 3) : (y >= yd ? 1 : 4);
  };
  const lens = (): void => { corner(center); run(hHead.slice(1, -1)); corner(X); run(rev(vHead.slice(1, -1))); };
  const beyond = (): void => {
    corner(X); run(hTail.slice(1, -1)); corner(hEnd);
    if (quadrantOf(right, top) === (quadrant === 2 ? 2 : 4)) corner([right, top]);
    corner(vEnd); run(rev(vTail.slice(1, -1)));
  };
  switch (quadrant) {
    case 1: // above the upper envelope
      corner([xlo, cy]); corner(center); run(upHead.slice(1, -1)); corner(X); run(upTail.slice(1, -1));
      corner(upTail[upTail.length - 1]); corner([upTail[upTail.length - 1][0], top]); corner([xlo, top]);
      break;
    case 3: // below the lower envelope
      corner([cx, ylo]); corner([right, ylo]); corner([right, lowTail[lowTail.length - 1][1]]);
      corner(lowTail[lowTail.length - 1]); run(rev(lowTail.slice(1, -1))); corner(X); run(rev(lowHead.slice(1, -1)));
      corner(center);
      break;
    case 2:
      if (twoFirst) lens(); else beyond();
      break;
    default: // 4: the lower-left box, and the region between the arms that is not quadrant 2
      corner([xlo, ylo]); corner([cx, ylo]);
      if (twoFirst) {
        // Out along the horizontal arm to X, round the region beyond it, and back.
        corner(center); run(hHead.slice(1, -1)); beyond(); corner(X); run(rev(hHead.slice(1, -1))); corner(center);
      } else {
        lens(); corner(center);
      }
      corner([xlo, cy]);
  }
  return { ring, corners };
}

// ── Populations → FlowJo nodes ──────────────────────────────────────────────────────────────

const graphXml = (x: string, y: string): string[] => [
  '<Graph smoothing="0" backColor="#ffffff" foreColor="#000000" type="Pseudocolor" fast="1">',
  `  <Axis dimension="x" name="${escAttr(x)}" label="" auto="auto" />`,
  `  <Axis dimension="y" name="${escAttr(y)}" label="" auto="auto" />`,
  '  <GraphSettings level="5%" smoothingHighResolution="1" contourHighResolution="1" histogramSmoothingCount="0" graphResolution="256" showOutliers="0" drawLargeDots="0" dotsToDraw="8000" tint="le.chartfill.tinted.40" lineWeight="le.lineweight.normal" lineStyle="le.linestyle.solid" />',
  '  <GraphEnvironment showGrid="0" showAxes="tnlTNL" showGates="1" showFreqOnPlots="1" showGateNameOnPlots="1" showMedians="0" showUncomped="0" addEventParam="0" lastYAxisName="">',
  ...["Labels", "LayoutGates", "Numbers", "Legend"].map((n) =>
    `    <TextTraits font="Arial" size="14" name="${n}" style="plain" color="#000000" background="#00ffffff" just="left" />`),
  "  </GraphEnvironment>",
  "</Graph>",
];

const indent = (lines: string[], by: string): string[] => lines.map((l) => by + l);

/**
 * `lines` appended to `out` one at a time. `out.push(...lines)` passes every line as an argument,
 * and a subtree past about 120,000 lines is more than V8 takes: a quadrant gate whose four panels
 * came back from Gating-ML as polygons of 5,000 to 6,600 vertices each (four lines a vertex) made
 * "Export FlowJo workspace" fail with "Maximum call stack size exceeded" (FR-FCM-Z2HV and
 * FR-FCM-Z282, through the standard and the Cytobank format).
 */
function append(out: string[], lines: readonly string[]): void {
  for (const line of lines) out.push(line);
}

/**
 * The name a helper population is written under (WSP_OPERAND_ATTR): its gate's, each "/" written
 * as WSP_OPERAND_SLASH, since the nodes naming it do so by a path that "/" separates.
 */
const operandName = (name: string): string => name.split("/").join(WSP_OPERAND_SLASH);

const popcount = (mask: Uint8Array | null): number | null => {
  if (!mask) return null;
  let n = 0;
  for (const v of mask) n += v;
  return n;
};

const and = (a: Uint8Array, b: Uint8Array, negateB = false): Uint8Array => {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] && (negateB ? !b[i] : b[i]) ? 1 : 0;
  return out;
};

interface SampleContext {
  sample: Sample;
  gates: Record<string, Gate>;
  populations: PopulationMap;
  axes: Map<string, Axis>;
  masks: Record<string, Uint8Array> | null;
  gateMask(ref: GateRef): Uint8Array | null;
  nextId(): string;
  warnings: string[];
  counters: { gates: number; densified: number; ellipses: number; quadrants: number; helpers: number };
  /** Each population's path in the file, its names as written ("A/B"), from exportedPaths. */
  paths: Map<string, string>;
  /** The grid check's work for this sample (gridOutcome): each polygon's outcome, and its events on the grid. */
  gridMemo: GridMemo;
}

/**
 * The name FlowJo gave a population the FlowJo importer qualified. A name that recurs in FlowJo's
 * tree is imported with as many of its parents' names as it takes to be unique, joined with "/"
 * ("Lymphocytes/Single Cells" and "Single Cells/Single Cells" for two nested "Single Cells";
 * flowjoWorkspace.ts, qualifiedPopulationNames). Written back as it stands, FlowJo showed the
 * qualified name, with the "/" it separates a path with, so FlowJo to GateLab to FlowJo renamed
 * every such population. A name whose leading parts are exactly the names its nearest ancestors
 * are written under is that qualification, and is written as its last part, which the importer
 * qualifies the same way again; any other name is written as it stands.
 */
function flowJoName(populations: PopulationMap, id: string): string {
  const pop = populations[id];
  if (!pop) return "";
  const parts = pop.name.split("/");
  if (parts.length < 2) return pop.name;
  const prefix = parts.slice(0, -1);
  const ancestors: string[] = [];
  for (let at = pop.parent_id; at && ancestors.length < prefix.length; at = populations[at]?.parent_id ?? null) {
    // The root, which has no parent, is the sample and names no population.
    if (!populations[at] || populations[at].parent_id === null) break;
    ancestors.unshift(flowJoName(populations, at));
  }
  return ancestors.length === prefix.length && ancestors.every((a, i) => a === prefix[i]) ? parts[parts.length - 1] : pop.name;
}

/**
 * Every population's path in the file: the names subpopulations writes (flowJoName), a repeated
 * name among siblings made unique the same way and in the same order, joined with "/" from the top.
 */
function exportedPaths(populations: PopulationMap, rootId: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (children: readonly string[], prefix: string): void => {
    const taken = new Set<string>();
    for (const id of children) {
      const pop = populations[id];
      if (!pop) continue;
      const path = `${prefix}${uniqueName(flowJoName(populations, id), taken)}`;
      out.set(id, path);
      visit(pop.children, `${path}/`);
    }
  };
  visit(populations[rootId]?.children ?? [], "");
  return out;
}

/**
 * A population anywhere in the tree that IS the given reference (one included gate, the same
 * quadrant), other than `self` and its descendants: what a NOT can name by its path, as FlowJo's
 * own NotNodes name a population in another branch.
 */
function populationHolding(ctx: SampleContext, ref: GateRef, self: string): string | null {
  const inside = (id: string): boolean => {
    for (let at: string | null = id; at; at = ctx.populations[at]?.parent_id ?? null) if (at === self) return true;
    return false;
  };
  for (const [id, pop] of Object.entries(ctx.populations)) {
    if (!ctx.paths.has(id) || inside(id) || pop.gate_refs.length !== 1 || pop.gate_logic === "or") continue;
    const r = pop.gate_refs[0];
    if (r.gate_id === ref.gate_id && r.include && (r.quadrant ?? 1) === (ref.quadrant ?? 1)) return id;
  }
  return null;
}

/** The gate element for one reference, in the file's terms, or null when it cannot be placed. */
function gateFor(ctx: SampleContext, ref: GateRef, id: string, scope: GridScope | null = null): GateSpec | null {
  const gate = ctx.gates[ref.gate_id];
  if (!gate) return null;
  const ax = ctx.axes.get(gate.x_channel);
  const ay = ctx.axes.get(gate.y_channel);
  if (!ax || !ay) {
    ctx.warnings.push(`"${gate.name}" is drawn on a channel this file does not have (${!ax ? gate.x_channel : gate.y_channel}); the populations it defines were left out.`);
    return null;
  }
  // A Gating-ML boundMin or boundMax holds a value at the bound before the gate is tested; a
  // FlowJo axis has no such thing, so the gate would select other events there.
  const bounded = [gate.x_channel, gate.y_channel].find((ch) => {
    const spec = gateSpec(ctx.sample, gate, ch);
    return "bounds" in spec && spec.bounds !== undefined && (spec.bounds.min !== undefined || spec.bounds.max !== undefined);
  });
  if (bounded) {
    ctx.warnings.push(`"${gate.name}" holds ${bounded} to a Gating-ML bound, which a FlowJo workspace cannot carry; the populations it defines were left out.`);
    return null;
  }
  if (gate.gate_type === "rectangle") {
    return { lines: rectangleForFlowJo(ctx.sample, gate, ax, ay, id, ctx.warnings), densified: false, recast: null };
  }
  if (gate.gate_type === "polygon") {
    const { lines, densified } = polygonXml(ctx.sample, gate, gate.vertices, ax, ay, id, -1, undefined, ctx.warnings, undefined, ctx.gridMemo, scope);
    return { lines, densified, recast: null };
  }
  if (gate.gate_type === "ellipse") {
    const exact = ellipsoidXml(ctx.sample, gate, ax, ay, id);
    if (exact) return { lines: exact, densified: false, recast: null };
    const { lines, densified, rectangle } = polygonXml(ctx.sample, gate, ellipseBoundary(gate, 128), ax, ay, id, -1, [0], ctx.warnings, undefined, ctx.gridMemo, scope);
    return { lines, densified, recast: rectangle ? null : "ellipse" };
  }
  if (gate.gate_type !== "quadrant") return null;
  const q = ref.quadrant ?? 1;
  const { ring, corners } = quadrantRing(ctx.sample, gate, q, ax, ay);
  const pullIn = {
    x: quadrantPullIn(ctx.sample, gate, gate.x_channel, gate.center[0], ax.fileScale, 0),
    y: quadrantPullIn(ctx.sample, gate, gate.y_channel, gate.center[1], ay.fileScale, 1),
  };
  const { lines, densified } = polygonXml(ctx.sample, gate, ring, ax, ay, id, FLOWJO_QUAD_ID[q] ?? -1, corners, ctx.warnings, pullIn);
  return { lines, densified, recast: "quadrant" };
}

function noteGate(ctx: SampleContext, spec: GateSpec): void {
  ctx.counters.gates++;
  if (spec.densified) ctx.counters.densified++;
  if (spec.recast === "ellipse") ctx.counters.ellipses++;
  if (spec.recast === "quadrant") ctx.counters.quadrants++;
}

function refLabel(ctx: SampleContext, ref: GateRef): string {
  const gate = ctx.gates[ref.gate_id];
  const name = gate?.name ?? ref.gate_id;
  return gate?.gate_type === "quadrant" ? `${name} Q${ref.quadrant ?? 1}` : name;
}

/** A name no sibling uses: "CD3+", "CD3+ (2)", … */
function uniqueName(base: string, taken: Set<string>, looks?: (name: string) => string): string {
  const used = (name: string): boolean => taken.has(name) || (!!looks && [...taken].some((t) => looks(t) === looks(name)));
  let name = base;
  for (let i = 2; used(name); i++) name = `${base} (${i})`;
  taken.add(name);
  return name;
}

/**
 * A name as it looks, WSP_OPERAND_SLASH drawn as the "/" it stands for. A helper is kept apart from
 * its siblings by this, not by its text: written "CD8∕CD4" beside a population "CD8/CD4" (a NOT of
 * the gate the helper holds), it looked the same in FlowJo, and a reader writing every "/" in a name
 * as that character read the NOT as naming itself (FlowKit through the interoperability tester's
 * repair, random-0009: "Graph contains a cycle"). It is "CD8∕CD4 (2)" instead.
 */
const looksLike = (name: string): string => name.split(WSP_OPERAND_SLASH).join("/");

interface Node {
  lines: string[];
  /** The gate id children name as their parent_id, when the node carries a gate. */
  gateId: string | null;
}

/**
 * A FlowJo `<Population>`: one gate, and the subtree beneath it. `mask` is the population's own
 * membership for the count; `children` its GateLab children, written into `<Subpopulations>`.
 */
function populationNode(
  ctx: SampleContext, name: string, ref: GateRef, parentGateId: string | null, mask: Uint8Array | null,
  children: readonly string[], path: readonly string[],
  /** The population a warning about the gate names, and its parent's events (gridNote). */
  scope: GridScope | null = null,
): Node | null {
  const id = ctx.nextId();
  const spec = gateFor(ctx, ref, id, scope);
  if (!spec) return null;
  noteGate(ctx, spec);
  const gate = ctx.gates[ref.gate_id];
  const firstChildGate = children.map((c) => ctx.gates[ctx.populations[c]?.gate_refs[0]?.gate_id ?? ""]).find(Boolean);
  const axesOf = (g: Gate | undefined): [string, string] => g
    ? [ctx.axes.get(g.x_channel)?.name ?? g.x_channel, ctx.axes.get(g.y_channel)?.name ?? g.y_channel]
    : [ctx.axes.get(gate.x_channel)?.name ?? gate.x_channel, ctx.axes.get(gate.y_channel)?.name ?? gate.y_channel];
  const count = popcount(mask);
  const parent = parentGateId ? ` gating:parent_id="${parentGateId}"` : "";
  const lines = [
    `<Population name="${escAttr(name)}" annotation="" owningGroup="" expanded="1" sortPriority="10"${count === null ? "" : ` count="${count}"`}>`,
    ...indent(graphXml(...axesOf(firstChildGate)), "  "),
    `  <Gate gating:id="${id}"${parent}>`,
    ...indent(spec.lines, "    "),
    "  </Gate>",
    ...subpopulations(ctx, children, id, mask, [...path, name]),
    "</Population>",
  ];
  return { lines, gateId: id };
}

/** `<Subpopulations>` holding the given GateLab children, or nothing when there are none. */
function subpopulations(
  ctx: SampleContext, children: readonly string[], parentGateId: string | null, parentMask: Uint8Array | null,
  path: readonly string[],
): string[] {
  // Every child is named before any is written, so a Boolean node can name a sibling by the
  // name it will actually carry, wherever that sibling sits in the order.
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const childId of children) {
    const pop = ctx.populations[childId];
    if (!pop) continue;
    const own = flowJoName(ctx.populations, childId);
    const name = uniqueName(own, taken);
    names.set(childId, name);
    if (name !== own) {
      ctx.warnings.push(`Two populations beside each other are both called "${own}"; the second was written as "${name}", because FlowJo names populations by their path.`);
    }
  }
  const out: string[] = [];
  for (const childId of children) {
    if (!names.has(childId)) continue;
    append(out, emitPopulation(ctx, childId, parentGateId, parentMask, path, taken, names, children));
  }
  return out.length ? ["  <Subpopulations>", ...indent(out, "    "), "  </Subpopulations>"] : [];
}

/** A sibling population that IS the given reference — one included gate, the same quadrant. */
function siblingHolding(ctx: SampleContext, siblings: readonly string[], ref: GateRef, self: string): string | null {
  for (const id of siblings) {
    if (id === self) continue;
    const pop = ctx.populations[id];
    if (!pop || pop.gate_refs.length !== 1 || pop.gate_logic === "or") continue;
    const r = pop.gate_refs[0];
    if (r.gate_id === ref.gate_id && r.include && (r.quadrant ?? 1) === (ref.quadrant ?? 1)) return id;
  }
  return null;
}

/**
 * One GateLab population as FlowJo nodes. A single included gate is a `<Population>`. An
 * excluded gate is a `<NotNode>` naming a helper population that holds the gate. Several gates
 * are an `<AndNode>` (or `<OrNode>`) naming one helper per gate, an excluded gate's helper being
 * a NotNode of its own. Helpers are written beside the node, as FlowJo's own tool writes them,
 * and are what the importer resolves the node from.
 */
function emitPopulation(
  ctx: SampleContext, popId: string, parentGateId: string | null, parentMask: Uint8Array | null,
  path: readonly string[], taken: Set<string>, names: Map<string, string>, siblings: readonly string[],
): string[] {
  const pop = ctx.populations[popId];
  if (!pop) return [];
  const refs = pop.gate_refs.filter((r) => ctx.gates[r.gate_id]);
  if (!refs.length) {
    ctx.warnings.push(`"${pop.name}" has no gate; it and the populations beneath it were left out.`);
    return [];
  }
  const mask = ctx.masks?.[popId] ?? null;
  const name = names.get(popId) ?? flowJoName(ctx.populations, popId);
  if (name.includes("/")) {
    ctx.warnings.push(`"${name}" contains "/", which FlowJo uses to separate a population path; a Boolean population naming it may not resolve in FlowJo.`);
  }

  // A warning about one of the population's gates counts within its parent (gridNote).
  const scope: GridScope = { population: name, parent: ctx.masks ? parentMask : null };
  if (refs.length === 1 && refs[0].include && pop.gate_logic !== "or") {
    const node = populationNode(ctx, name, refs[0], parentGateId, mask, pop.children, path, scope);
    return node ? node.lines : [];
  }

  const count = popcount(mask);
  const countAttr = count === null ? "" : ` count="${count}"`;
  const notNode = (
    notName: string, ref: GateRef, dependent: string, notMask: Uint8Array | null, children: readonly string[],
  ): string[] | null => {
    const notId = ctx.nextId();
    const copy = gateFor(ctx, { ...ref, include: true }, notId, scope);
    if (!copy) return null;
    const n = popcount(notMask);
    return [
      `<NotNode name="${escAttr(notName)}" annotation="" owningGroup="" expanded="1" sortPriority="10"${n === null ? "" : ` count="${n}"`}>`,
      ...indent(graphXml(...gateAxes(ctx, ref)), "  "),
      "  <Dependents>",
      `    <Dependent name="${escAttr(dependent)}" />`,
      "  </Dependents>",
      // The copy of the gate FlowJo stores inside a NotNode, which readers fall back on when
      // the named population cannot be resolved.
      `  <Gate gating:id="${notId}">`,
      ...indent(copy.lines, "    "),
      "  </Gate>",
      ...subpopulations(ctx, children, null, notMask, [...path, notName]),
      "</NotNode>",
    ];
  };

  // One population per reference, beside the node: a sibling that already is that gate, as
  // FlowJo's own NOT tool names one, else a helper written here, whose count is the gate within
  // the parent, which is what FlowJo would show for it.
  const lines: string[] = [];
  const dependents: string[] = [];
  for (const ref of refs) {
    const gateMask = parentMask ? ctx.gateMask(ref) : null;
    const within = parentMask && gateMask ? and(parentMask, gateMask) : null;
    const existing = siblingHolding(ctx, siblings, ref, popId);
    // One excluded gate that a population elsewhere IS: the NOT names that population by its path,
    // as FlowJo's own NotNodes do, and FlowJo excludes its gate alone (flowjoWorkspace.ts). A helper
    // written here under that population's name made the importer qualify the real one's name
    // ("CD45, CD123 subset/Basophils" for "Basophils") on the way back.
    const elsewhere = !existing && refs.length === 1 && !ref.include ? populationHolding(ctx, ref, popId) : null;
    if (elsewhere) {
      const node = notNode(name, ref, ctx.paths.get(elsewhere)!, mask ?? (parentMask && gateMask ? and(parentMask, gateMask, true) : null), pop.children);
      return node ?? [];
    }
    let helperName: string;
    if (existing) {
      helperName = names.get(existing) ?? ctx.populations[existing].name;
    } else {
      helperName = uniqueName(operandName(refLabel(ctx, ref)), taken, looksLike);
      const helper = populationNode(ctx, helperName, { ...ref, include: true }, parentGateId, within, [], path, scope);
      if (!helper) return [];
      ctx.counters.helpers++;
      append(lines, operandOnly(helper.lines));
    }
    const helperPath = [...path, helperName].join("/");
    if (ref.include) {
      dependents.push(helperPath);
      continue;
    }
    const notMask = parentMask && gateMask ? and(parentMask, gateMask, true) : null;
    if (refs.length === 1) {
      // One excluded gate: the population IS the complement of the helper.
      const node = notNode(name, ref, helperPath, mask ?? notMask, pop.children);
      return node ? [...lines, ...node] : [];
    }
    const notName = uniqueName(operandName(`NOT ${helperName}`), taken, looksLike);
    const node = notNode(notName, ref, helperPath, notMask, []);
    if (!node) return [];
    ctx.counters.helpers++;
    append(lines, operandOnly(node));
    dependents.push([...path, notName].join("/"));
  }

  const tag = pop.gate_logic === "or" ? "OrNode" : "AndNode";
  return [
    ...lines,
    `<${tag} name="${escAttr(name)}" annotation="" owningGroup="" expanded="1" sortPriority="10"${countAttr}>`,
    ...indent(graphXml(...gateAxes(ctx, refs[0])), "  "),
    "  <Dependents>",
    ...dependents.map((d) => `    <Dependent name="${escAttr(d)}" />`),
    "  </Dependents>",
    ...subpopulations(ctx, pop.children, null, mask, [...path, name]),
    `</${tag}>`,
  ];
}

/**
 * A helper node's lines, its element marked as an operand only (WSP_OPERAND_ATTR): FlowJo shows it
 * as the population its own tool would write, and GateLab reads it back as no population.
 */
function operandOnly(lines: string[]): string[] {
  if (!lines.length) return lines;
  return [lines[0].replace(/^(\s*<(?:Population|NotNode) name="[^"]*")/, `$1 ${WSP_OPERAND_ATTR}="1"`), ...lines.slice(1)];
}

function gateAxes(ctx: SampleContext, ref: GateRef): [string, string] {
  const g = ctx.gates[ref.gate_id];
  return [ctx.axes.get(g.x_channel)?.name ?? g.x_channel, ctx.axes.get(g.y_channel)?.name ?? g.y_channel];
}

// ── The sample block ────────────────────────────────────────────────────────────────────────

/** Java's Date.toString(), which is what FlowJo writes as modDate. */
function javaDate(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
}

function spilloverXml(sample: Sample, pnnOf: (key: string) => string, id: string): string[] | null {
  const spill = sample.instrument === "flow" && sample.compensationEnabled ? sample.spillover : null;
  if (!spill) return null;
  const names = spill.channels.map(pnnOf);
  const label = sample.spilloverOrigin.kind === "external" ? sample.spilloverOrigin.label : "Acquisition-defined";
  // A matrix in FlowJo's spectral convention, each row's largest coefficient 1 but not every one on
  // the diagonal, came from a FlowJo spectral matrix (flowjoWorkspace.ts, readSpilloverMatrix) and
  // goes back as one: written spectral="0", GateLab's import declines its diagonal and refuses the
  // gates drawn on it. Any other matrix goes as a conventional one, as before.
  const near1 = (v: number) => Math.abs(v - 1) < 1e-3;
  const spectral = !spill.matrix.every((row, i) => near1(row[i])) && spill.matrix.every((row) => near1(Math.max(...row)));
  return [
    `<transforms:spilloverMatrix spectral="${spectral ? 1 : 0}" prefix="Comp-" name="${escAttr(label)}" editable="1" color="#c0c0c0" version="FlowJo-${FLOWJO_VERSION}" status="FINALIZED" transforms:id="${id}" suffix="">`,
    "  <data-type:parameters>",
    ...names.map((n) => `    <data-type:parameter data-type:name="${escAttr(n)}" userProvidedCompInfix="Comp-${escAttr(n)}" />`),
    "  </data-type:parameters>",
    ...spill.matrix.flatMap((row, i) => [
      `  <transforms:spillover data-type:parameter="${escAttr(names[i])}" userProvidedCompInfix="Comp-${escAttr(names[i])}">`,
      ...row.map((v, j) => `    <transforms:coefficient data-type:parameter="${escAttr(names[j])}" transforms:value="${fmtNum(v)}" />`),
      "  </transforms:spillover>",
    ]),
    "</transforms:spilloverMatrix>",
  ];
}

interface SampleBlock {
  lines: string[];
  matrix: string[] | null;
}

/**
 * Each parameter's name as FlowJo writes it in a workspace, by channel key: the FCS `$PnN` with
 * every "/" written as "_", as FlowJo writes it in a gate's dimensions, the Transformations and
 * the spillover matrix ("LIVE_DEAD Aqua-A" for the file's "LIVE/DEAD Aqua-A", Sample.
 * externalSpilloverPreview). A reader that loads the file's parameters under FlowJo's names found
 * no parameter "APC/Fire-A", and every gate on it was unevaluable (FlowKit, the interoperability
 * tester's `fail:flowjo-parameter-name`: 207 checks in the release candidate's sweep, 66 on
 * 0.8.3). GateLab's own FlowJo import finds the parameter either way (gatingml.ts resolveChannel).
 * A name whose "_" form another parameter already has keeps its "/", and the export says so:
 * FlowJo's rewriting would make the two parameters one.
 */
function flowJoParameterNames(sample: Sample, warnings: string[]): Map<string, string> {
  const pnns = sample.channels.map((c) => c.pnn || c.key);
  const swapped = pnns.map((p) => p.split("/").join("_"));
  const out = new Map<string, string>();
  sample.channels.forEach((c, i) => {
    const clash = swapped[i] !== pnns[i] && pnns.some((p, j) => j !== i && (p === swapped[i] || swapped[j] === swapped[i]));
    if (clash) {
      warnings.push(`${pnns[i]} keeps its "/" in the workspace: FlowJo writes "/" in a parameter name as "_", and ${swapped[i]} would name another parameter of the file.`);
    }
    out.set(c.key, clash ? pnns[i] : swapped[i]);
  });
  return out;
}

function sampleBlock(entry: FlowJoExportSample, sampleId: number, opts: FlowJoExportOpts, warnings: string[], counters: SampleContext["counters"]): SampleBlock {
  const { sample, fileName } = entry;
  const writtenNames = flowJoParameterNames(sample, warnings);
  const pnnOf = (key: string): string => writtenNames.get(key) ?? key;
  const rawTimestep = Number(sample.fcs.keywords["$TIMESTEP"]);
  const timestep = Number.isFinite(rawTimestep) && rawTimestep > 0 && rawTimestep !== 1 ? rawTimestep : null;
  const compensated = new Set(
    sample.instrument === "flow" && sample.compensationEnabled ? sample.spillover?.channels ?? [] : [],
  );

  // Every display-space gate's recorded transform, per channel, so an imported axis is kept; and
  // the axes a FlowJo rectangle was saved on (PolyRectGate.flowjo_axes), declared as the grid's
  // axes are, so FlowJo pins below a biex table at the same bottom it did.
  const displaySpecs = new Map<string, TransformSpec[]>();
  /** The first grid polygon's axis on each channel it is on, in gate order. */
  const gridPolygonAxes = new Map<string, TransformSpec>();
  for (const gid of entry.gate_order.length ? entry.gate_order : Object.keys(entry.gates)) {
    const g = entry.gates[gid];
    if (!g) continue;
    if (g.gate_type === "rectangle" && g.flowjo_axes) {
      for (const [ch, axis] of Object.entries(g.flowjo_axes)) {
        displaySpecs.set(ch, [...(displaySpecs.get(ch) ?? []), { kind: "flowjoChannels", channels: FLOWJO_CHANNELS, axis }]);
      }
    }
    if (sample.gateSpace(g) !== "display") continue;
    for (const ch of [g.x_channel, g.y_channel]) {
      const spec = g.transforms?.[ch];
      if (spec) displaySpecs.set(ch, [...(displaySpecs.get(ch) ?? []), spec]);
      if (isFlowJoGridSpec(spec) && !gridPolygonAxes.has(ch)) gridPolygonAxes.set(ch, spec);
    }
  }
  // FlowJo rectangles on one channel saved on different linear axes, as after two imports are
  // merged: a FlowJo file declares one axis per parameter, and FlowJo moves an event beyond it
  // onto its edge before it compares a rectangle's bounds. Declared on the first rectangle's axis,
  // a bound of another inside its own axis but beyond the declared one took the events beyond it
  // (a bound of 500,000 on a 0 to 1,048,576 axis, declared 0 to 262,144, took events at 520,000
  // and 2e6). Every bound such a rectangle holds lies inside its own axis, so on the widest of
  // them FlowJo's clamp keeps GateLab's events for each (rectangleForFlowJo). A channel a grid
  // polygon is on keeps the polygon's axis, which FlowJo grids it on: it is put first, where
  // declareAxis takes it, since a rectangle ahead of the polygon in gate order had its own axis
  // declared and the polygon gridded on that.
  for (const [ch, specs] of displaySpecs) {
    const polygonAxis = gridPolygonAxes.get(ch);
    if (polygonAxis) {
      displaySpecs.set(ch, [polygonAxis, ...specs.filter((s) => s !== polygonAxis)]);
      continue;
    }
    const saved = specs.filter(isFlowJoGridSpec).map((s) => s.axis);
    if (saved.length < 2 || !saved.every((a) => a.kind === "linear")) continue;
    const lo = Math.min(...saved.map((a) => (a.kind === "linear" ? a.minRange : Infinity)));
    const hi = Math.max(...saved.map((a) => (a.kind === "linear" ? a.maxRange : -Infinity)));
    const first = specs.findIndex(isFlowJoGridSpec);
    displaySpecs.set(ch, specs.map((s, i) => (i === first
      ? { kind: "flowjoChannels", channels: FLOWJO_CHANNELS, axis: { kind: "linear", minRange: lo, maxRange: hi } }
      : s)));
  }

  // The lowest raw value each channel's gates reach, so a declared biex is built to show it; and
  // every coordinate they state, open bounds left out, which a linear axis may need to reach past.
  const gateMins = new Map<string, number>();
  const gateValues = new Map<string, number[]>();
  const noteMin = (ch: string, v: number) => {
    if (!Number.isFinite(v)) return;
    const cur = gateMins.get(ch);
    if (cur === undefined || v < cur) gateMins.set(ch, v);
    if (isOpenBound(v)) return;
    const list = gateValues.get(ch);
    if (list) list.push(v);
    else gateValues.set(ch, [v]);
  };
  for (const g of Object.values(entry.gates)) {
    if (!g) continue;
    const points: readonly Vertex[] = g.gate_type === "quadrant"
      ? [g.center]
      : g.gate_type === "ellipse"
        ? ellipseReach(g)
        : g.vertices;
    for (const pt of points) {
      // An unbounded rectangle edge is written as no bound, so the axis need not reach it.
      if (!isUnbounded(pt[0])) noteMin(g.x_channel, sample.gateToRaw(g, g.x_channel, pt[0]));
      if (!isUnbounded(pt[1])) noteMin(g.y_channel, sample.gateToRaw(g, g.y_channel, pt[1]));
    }
  }

  const axes = new Map<string, Axis>();
  const transformLines: string[] = [];
  sample.channels.forEach((ch, idx) => {
    const onChannel = Object.values(entry.gates).filter((g): g is Gate => !!g && (g.x_channel === ch.key || g.y_channel === ch.key));
    const { decl, fileScale } = declareAxis(sample, idx, displaySpecs.get(ch.key) ?? [], timestep, warnings, gateMins.get(ch.key), gateValues.get(ch.key), onChannel);
    const maps = axisMaps(decl);
    const written = pnnOf(ch.key);
    const name = compensated.has(ch.key) ? `Comp-${written}` : written;
    axes.set(ch.key, { key: ch.key, name, decl, fileScale, straightIn: (s) => straightIn(decl, s), ...maps });
    // FlowJo declares the compensated parameter beside the raw one, under the same transform.
    transformLines.push(...transformXml(decl, written));
    if (compensated.has(ch.key)) transformLines.push(...transformXml(decl, name));
  });

  const data = sample.gateAssayData();
  const masks = opts.withoutCounts
    ? null
    : applyGatingStrategy(entry.gates, entry.populations, entry.root_population_id, data).masks;
  let serial = 0;
  const ctx: SampleContext = {
    sample, gates: entry.gates, populations: entry.populations, axes, masks,
    gateMask: (ref) => {
      const g = entry.gates[ref.gate_id];
      return g ? getGateMask(g, columnsForGate(data, g), ref.quadrant) : null;
    },
    nextId: () => `ID${sampleId * 1000000 + ++serial}`,
    warnings, counters,
    paths: exportedPaths(entry.populations, entry.root_population_id),
    gridMemo: { outcomes: new Map(), cells: new Map() },
  };

  const root = entry.populations[entry.root_population_id];
  const rootMask = masks?.[entry.root_population_id] ?? (masks ? new Uint8Array(sample.fcs.nEvents).fill(1) : null);
  const tree = root ? subpopulations(ctx, root.children, null, rootMask, []) : [];

  const matrixId = `gatelab-matrix-${sampleId}`;
  const matrix = spilloverXml(sample, pnnOf, matrixId);
  const total = sample.fcs.nEvents;
  const firstGate = root?.children.map((c) => entry.gates[entry.populations[c]?.gate_refs[0]?.gate_id ?? ""]).find(Boolean);
  const rootAxes: [string, string] = firstGate
    ? [axes.get(firstGate.x_channel)?.name ?? firstGate.x_channel, axes.get(firstGate.y_channel)?.name ?? firstGate.y_channel]
    : [axes.get(sample.channels[0]?.key ?? "")?.name ?? "", axes.get(sample.channels[1]?.key ?? "")?.name ?? ""];
  const keywords = Object.entries({ FJ_FCS_VERSION: sample.fcs.version, ...sample.fcs.keywords });

  const lines = [
    "<Sample>",
    // encodeURI leaves "&" as it is, which unescaped made the whole file malformed XML.
    `  <DataSet uri="${escAttr(entry.folderPath === undefined ? `file:${encodeURI(fileName)}` : flowJoFolderUri(entry.folderPath))}" sampleID="${sampleId}" />`,
    ...(matrix ? indent(matrix, "  ") : []),
    "  <Transformations>",
    ...indent(transformLines, "    "),
    "  </Transformations>",
    "  <Keywords>",
    ...keywords.map(([k, v]) => `    <Keyword name="${escAttr(k)}" value="${escAttr(v)}" />`),
    "  </Keywords>",
    // One GateLab tree, whatever it holds at the top level (WSP_ONE_TREE_ATTR): its root's
    // populations and the helpers beside its intersections are not FlowJo's independent trees.
    `  <SampleNode name="${escAttr(entry.folderPath === undefined ? fileName : entry.folderPath.slice(entry.folderPath.lastIndexOf("/") + 1))}" annotation="" owningGroup="" expanded="1" sortPriority="10" count="${total}" sampleID="${sampleId}" ${WSP_ONE_TREE_ATTR}="1">`,
    ...indent(graphXml(...rootAxes), "    "),
    ...indent(tree, "  "),
    "  </SampleNode>",
    "</Sample>",
  ];
  return { lines, matrix };
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────

export function exportFlowJoWorkspace(opts: FlowJoExportOpts): FlowJoExportResult {
  const { samples } = opts;
  if (!samples.length) throw new Error("No samples to export.");
  if (!samples.some((s) => Object.keys(s.gates).length && s.populations[s.root_population_id]?.children.length)) {
    throw new Error("No gates to export.");
  }
  const now = opts.now ?? new Date();
  const warnings: string[] = [];
  const counters: SampleContext["counters"] = { gates: 0, densified: 0, ellipses: 0, quadrants: 0, helpers: 0 };

  const blocks = samples.map((entry, i) => sampleBlock(entry, i + 1, opts, warnings, counters));

  if (counters.densified) {
    warnings.push(
      `${counters.densified} polygon gate(s) were written with extra vertices: their edges are straight in ` +
      "GateLab's space and not in the axis FlowJo will display them on, so the boundary was traced there " +
      "to within 0.2% of each gate's extent.",
    );
  }
  if (counters.ellipses) {
    warnings.push(`${counters.ellipses} ellipse gate(s) were written as their boundary polygon, because the axis FlowJo will display them on bends an ellipse out of shape.`);
  }
  if (counters.quadrants) {
    warnings.push(`${counters.quadrants} quadrant population(s) were written as FlowJo writes its own quadrants: one polygon per quadrant, reaching the axis limits.`);
  }
  if (counters.helpers) {
    warnings.push(`${counters.helpers} helper population(s) were added beside NOT and AND populations, which FlowJo defines by naming sibling populations rather than gates.`);
  }

  const matrices = blocks.map((b) => b.matrix).filter((m): m is string[] => m !== null);
  const schemaLoc = [
    `${GATING_NS} ${GATING_NS}/Gating-ML.v2.0.xsd`,
    `${TRANSFORMS_NS} ${GATING_NS}/Transformations.v2.0.xsd`,
    `${DATATYPE_NS} ${GATING_NS}/DataTypes.v2.0.xsd`,
  ].join(" ");
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Workspace version="20.0" modDate="${javaDate(now)}" clientTimestamp="${now.getTime()}" flowJoVersion="${FLOWJO_VERSION}" curGroup="All Samples"` +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ` xmlns:gating="${GATING_NS}" xmlns:transforms="${TRANSFORMS_NS}" xmlns:data-type="${DATATYPE_NS}"` +
      ` xsi:schemaLocation="${schemaLoc}">`,
    `  <!-- Written by ${escAttr(opts.producer ?? "GateLab")} in the layout of a FlowJo ${FLOWJO_VERSION} workspace: one Sample per file, gates in raw values, axes declared per parameter. -->`,
    ...(matrices.length ? ["  <Matrices>", ...matrices.flatMap((m) => indent(m, "    ")), "  </Matrices>"] : []),
    "  <Groups>",
    '    <GroupNode name="All Samples" annotation="" owningGroup="All Samples" expanded="1" sortPriority="10" count="-1">',
    ...indent(graphXml("", ""), "      "),
    '      <Group name="All Samples" live="1" role="ws.group.dlog.test" key="" synchronized="0" foreground="#000000" fontStyle="bold">',
    "        <Criteria/>",
    "        <SampleRefs>",
    ...samples.map((_, i) => `          <SampleRef sampleID="${i + 1}" />`),
    "        </SampleRefs>",
    "        <Keywords/>",
    "      </Group>",
    "    </GroupNode>",
    // GateLab's groups, as FlowJo groups over the same samples: membership only, since each
    // sample's own tree already carries the group's coordinates.
    ...(opts.groups ?? []).flatMap((group) => {
      const refs = samples.flatMap((s, i) => (group.fileNames.includes(s.fileName) ? [`          <SampleRef sampleID="${i + 1}" />`] : []));
      if (!refs.length) return [];
      return [
        `    <GroupNode name="${escAttr(group.name)}" annotation="" owningGroup="${escAttr(group.name)}" expanded="1" sortPriority="10" count="-1">`,
        `      <Group name="${escAttr(group.name)}" live="0" role="ws.group.standard" key="" synchronized="0" foreground="#000000" fontStyle="plain">`,
        "        <Criteria/>",
        "        <SampleRefs>",
        ...refs,
        "        </SampleRefs>",
        "        <Keywords/>",
        "      </Group>",
        "    </GroupNode>",
      ];
    }),
    "  </Groups>",
    "  <SampleList>",
    ...blocks.flatMap((b) => indent(b.lines, "    ")),
    "  </SampleList>",
    "</Workspace>",
  ];
  // A gate a file refers to more than once (a population and the helpers beside it, a NOT's copy of
  // it, every sample of one tree) is written, and named, as often; each warning is said once.
  return { xml: lines.join("\n") + "\n", warnings: [...new Set(warnings)], sampleCount: samples.length, gateCount: counters.gates };
}

/** The warnings an export would carry, without evaluating a single population. */
export function planFlowJoExport(samples: FlowJoExportSample[]): Omit<FlowJoExportResult, "xml"> {
  const { warnings, sampleCount, gateCount } = exportFlowJoWorkspace({ samples, withoutCounts: true, now: new Date(0) });
  return { warnings, sampleCount, gateCount };
}

/**
 * The most bytes the .wsp exportFlowJoWorkspace writes for `opts` can take, found without
 * evaluating a population: the file written without counts, and for each Population, NotNode,
 * AndNode and OrNode the room a count attribute takes at the event count of the largest file,
 * which no population's count exceeds. The export dialog states the .zip's size with this.
 */
export function flowJoWorkspaceBytesAtMost(opts: FlowJoExportOpts): number {
  // The timestamps are as wide now as when the file is written.
  const { xml } = exportFlowJoWorkspace({ ...opts, withoutCounts: true, now: opts.now ?? new Date() });
  const nodes = xml.match(/<(?:Population|NotNode|AndNode|OrNode) name="/g)?.length ?? 0;
  const events = Math.max(0, ...opts.samples.map((s) => s.sample.fcs.nEvents));
  return new TextEncoder().encode(xml).byteLength + nodes * ` count="${events}"`.length;
}
