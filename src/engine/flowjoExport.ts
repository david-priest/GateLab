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
 *     biex verbatim — because the readers were built against that vocabulary and nothing else.
 *   • A gate whose vertices are straight in the declared space is written verbatim and is exact.
 *     A polygon straight in some other space (GateLab's default raw space for flow, or a logicle
 *     display) is densified: its boundary is sampled in the declared display until a straight
 *     chord between samples stays within 0.1% of the gate's extent, so the file's gate is the
 *     same boundary to well under a pixel, at the cost of vertices. Rectangles need nothing —
 *     an axis-aligned box is a box under any monotonic axis. An ellipse is written in FlowJo's
 *     foci form when the gate's space maps affinely onto the declared display, and as its
 *     sampled boundary otherwise. A quadrant gate is written the way FlowJo writes its own:
 *     four polygons reaching the axis limits, `quadId` 0–3; bent arms follow the curl.
 *   • A population that excludes a gate, or intersects several, is written as FlowJo's
 *     `<NotNode>` / `<AndNode>` (`<OrNode>` for OR), which name sibling populations rather
 *     than gates, so a helper population holding each referenced gate is written beside it.
 *   • Compensation: with a matrix active, gates on its channels name `Comp-` parameters and the
 *     matrix is written into the sample, in FlowJo's `<transforms:spilloverMatrix>` form.
 *   • Time is written in seconds, `$TIMESTEP` applied, because that is how FlowJo stores it.
 *
 * What is not carried, and is reported: nothing silently. Every densified polygon, ellipse
 * written as a polygon, quadrant written as four, helper population and skipped population is
 * named in the warnings the caller shows before the file is saved.
 *
 * Verified by round trip (flowjoExport.test.ts): export → the FlowJo importer → the same engine
 * assigns the same events, exactly for rectangles, quadrants, declared-space gates and FlowJo's
 * own re-exported gates, and within the densification bound for the rest. FACSChorus itself is
 * not on this machine; what it accepts beyond what FlowJo writes is not documented.
 */

import type { Sample } from "./sample";
import type { EllipseGate, Gate, GateRef, PolyRectGate, PopulationMap, QuadrantGate, TransformSpec, Vertex } from "./models";
import { biexTransform, wspLogTransform, type BiexParams } from "./biex";
import { axesFromCovariance, ellipseBoundary } from "./ellipse";
import { columnsForGate, getGateMask, quadrantArmPoints } from "./gates";
import { applyGatingStrategy } from "./populations";
import { collapseDensifiedRing, fmtNum } from "./gatingmlExport";
import { polygonOutline } from "../plots/gatePayload";

/** One loaded file and the tree it is gated under. */
export interface FlowJoExportSample {
  sample: Sample;
  /** The FCS file name FlowJo and FACSChorus will look for. */
  fileName: string;
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

// ── Axes: what the file declares for each parameter ─────────────────────────────────────────

type AxisDecl =
  | { kind: "linear"; minRange: number; maxRange: number }
  | { kind: "log"; offset: number; decades: number }
  | { kind: "biex"; params: BiexParams }
  | { kind: "fasinh"; T: number; M: number; A: number };

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
  switch (decl.kind) {
    case "linear":
      return [
        `<transforms:linear transforms:minRange="${fmtNum(decl.minRange)}" transforms:maxRange="${fmtNum(decl.maxRange)}" gain="1">`,
        `  ${p}`, "</transforms:linear>",
      ];
    case "log":
      return [
        `<transforms:log transforms:offset="${fmtNum(decl.offset)}" transforms:decades="${fmtNum(decl.decades)}">`,
        `  ${p}`, "</transforms:log>",
      ];
    case "biex": {
      const b = decl.params;
      return [
        `<transforms:biex transforms:length="${b.channelRange}" transforms:maxRange="${fmtNum(b.maxValue)}" transforms:neg="${fmtNum(b.neg)}" transforms:width="${fmtNum(b.widthBasis)}" transforms:pos="${fmtNum(b.pos)}">`,
        `  ${p}`, "</transforms:biex>",
      ];
    }
    case "fasinh":
      // FlowJo writes maxRange = T and W = -T beside Gating-ML's T, M and A.
      return [
        `<transforms:fasinh transforms:length="${FLOWJO_CHANNELS}" transforms:maxRange="${fmtNum(decl.T)}" transforms:T="${fmtNum(decl.T)}" transforms:A="${fmtNum(decl.A)}" transforms:M="${fmtNum(decl.M)}" transforms:W="${fmtNum(-decl.T)}">`,
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
      return spec.kind === "identity";
    case "log":
      // FlowJo's log IS Gating-ML's flog with T = offset and M = decades, offset by the
      // constant 1 (gatingmlExport.ts, the wsplog branch): affine, so straight stays straight.
      return (spec.kind === "wsplog" && near(spec.offset, decl.offset) && near(spec.decades, decl.decades))
        || (spec.kind === "flog" && near(spec.T, decl.offset) && near(spec.M, decl.decades));
    case "biex": {
      if (spec.kind !== "biex") return false;
      const b = decl.params;
      return near(spec.maxValue, b.maxValue) && near(spec.pos, b.pos) && near(spec.neg, b.neg)
        && near(spec.widthBasis, b.widthBasis) && spec.channelRange === b.channelRange;
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
    return { maxValue: 9999999.999999998, pos: 5, neg: 0, widthBasis: -100, channelRange: FLOWJO_CHANNELS };
  }
  return { maxValue: halfDecadeCeil(range), pos: 4.5, neg: 0, widthBasis: -10, channelRange: FLOWJO_CHANNELS };
}

/**
 * The candidate width bases for a default biex, FlowJo's -10 first. FlowJo itself writes any
 * negative value here (-22.68, -36.91, -60.32 on one published workspace), so nothing about the
 * ladder is special beyond covering four decades of negative range.
 */
const WIDTH_BASIS_LADDER = [-10, -20, -50, -100, -200, -500, -1000, -2000, -5000, -10000, -20000, -50000, -100000];

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
  let last = base;
  for (const widthBasis of ladder) {
    const params = { ...base, widthBasis };
    try {
      if (biexTransform(params).inverse(0) <= target) return { params, covered: true };
    } catch {
      break;
    }
    last = params;
  }
  return { params: last, covered: false };
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
 * What to declare for one parameter.
 *
 * A gate that arrived from FlowJo or from Gating-ML with an axis FlowJo can name (biex, log)
 * keeps it, so a FlowJo workspace that passed through GateLab goes back the shape it came. Every
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
): { decl: AxisDecl; fileScale: number } {
  const ch = sample.channels[idx];
  const fileScale = timestep !== null && isTimeAxis(ch.pnn) ? timestep : 1;
  const imported = displaySpecs.find((s) => s.kind === "biex")
    ?? displaySpecs.find((s) => s.kind === "wsplog")
    ?? displaySpecs.find((s) => s.kind === "flog");
  if (imported?.kind === "biex") {
    try {
      biexTransform(imported);
      return { decl: { kind: "biex", params: { ...imported } }, fileScale };
    } catch {
      warnings.push(`The biex axis a gate recorded for ${ch.pnn} could not be rebuilt; the parameter is declared linear and that gate densified.`);
    }
  } else if (imported?.kind === "wsplog") {
    return { decl: { kind: "log", offset: imported.offset, decades: imported.decades }, fileScale };
  } else if (imported?.kind === "flog") {
    return { decl: { kind: "log", offset: imported.T, decades: imported.M }, fileScale };
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
    const { params, covered } = coveringBiex(defaultBiex(sample, ch.range), gateMin);
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
  const lo = Math.min(0, extent ? extent[0] : 0);
  const hi = Math.max(ch.range > 1 ? ch.range - 1 : 1, extent ? extent[1] : 1, lo + 1);
  return { decl: { kind: "linear", minRange: lo, maxRange: hi }, fileScale };
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

function dimensionXml(ax: Axis, min?: number, max?: number): string[] {
  const mn = min !== undefined ? ` gating:min="${fmtNum(min)}"` : "";
  const mx = max !== undefined ? ` gating:max="${fmtNum(max)}"` : "";
  return [
    `  <gating:dimension${mn}${mx}>`,
    `    <data-type:fcs-dimension data-type:name="${escAttr(ax.name)}" />`,
    "  </gating:dimension>",
  ];
}

function vertexXml(v: Vertex): string[] {
  return [
    "  <gating:vertex>",
    `    <gating:coordinate data-type:value="${fmtNum(v[0])}" />`,
    `    <gating:coordinate data-type:value="${fmtNum(v[1])}" />`,
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
): { lines: string[]; densified: boolean } {
  const toFile = (p: Vertex): Vertex => [
    sample.gateToRaw(gate, gate.x_channel, p[0]) * ax.fileScale,
    sample.gateToRaw(gate, gate.y_channel, p[1]) * ay.fileScale,
  ];
  const straight = ax.straightIn(gateSpec(sample, gate, gate.x_channel))
    && ay.straightIn(gateSpec(sample, gate, gate.y_channel));
  let out: Vertex[] = ring.map(toFile);
  let densified = false;
  if ((!straight || corners) && ring.length >= 3) {
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
    for (const p of ring) {
      const f = toFile(p);
      const back: Vertex = [ax.inverse(ax.forward(f[0])), ay.inverse(ay.forward(f[1]))];
      for (const k of [0, 1] as const) {
        if (Math.abs(back[k] - f[k]) > 1e-6 * Math.max(1, Math.abs(f[k]))) {
          const axis = k === 0 ? ax : ay;
          warnings?.push(`${gate.name}: a vertex at ${fmtNum(f[k])} on ${axis.name} lies outside the declared axis and is written at its edge.`);
          break;
        }
      }
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
    }
  }
  return {
    densified,
    lines: [
      `<gating:PolygonGate ${gateAttrs} quadId="${quadId}" gateResolution="${FLOWJO_CHANNELS}" gating:id="${id}">`,
      ...dimensionXml(ax), ...dimensionXml(ay),
      ...out.flatMap(vertexXml),
      "</gating:PolygonGate>",
    ],
  };
}

function rectangleXml(sample: Sample, gate: PolyRectGate, ax: Axis, ay: Axis, id: string): string[] {
  const xs = gate.vertices.map((v) => sample.gateToRaw(gate, gate.x_channel, v[0]) * ax.fileScale);
  const ys = gate.vertices.map((v) => sample.gateToRaw(gate, gate.y_channel, v[1]) * ay.fileScale);
  return [
    `<gating:RectangleGate ${gateAttrs} percentX="0" percentY="0" gating:id="${id}">`,
    ...dimensionXml(ax, Math.min(...xs), Math.max(...xs)),
    ...dimensionXml(ay, Math.min(...ys), Math.max(...ys)),
    "</gating:RectangleGate>",
  ];
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
  const hArm: Vertex[] = curl ? quadrantArmPoints(gate.center, curl, "h", xhi, ARM_STEPS) : [[cx, cy], [xhi, cy]];
  const vArm: Vertex[] = curl ? quadrantArmPoints(gate.center, curl, "v", yhi, ARM_STEPS) : [[cx, cy], [cx, yhi]];
  const hEnd = hArm[hArm.length - 1];
  const vEnd = vArm[vArm.length - 1];
  const dropFirst = (r: Vertex[]): Vertex[] => r.slice(1);
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
}

/** The gate element for one reference, in the file's terms, or null when it cannot be placed. */
function gateFor(ctx: SampleContext, ref: GateRef, id: string): GateSpec | null {
  const gate = ctx.gates[ref.gate_id];
  if (!gate) return null;
  const ax = ctx.axes.get(gate.x_channel);
  const ay = ctx.axes.get(gate.y_channel);
  if (!ax || !ay) {
    ctx.warnings.push(`"${gate.name}" is drawn on a channel this file does not have (${!ax ? gate.x_channel : gate.y_channel}); the populations it defines were left out.`);
    return null;
  }
  if (gate.gate_type === "rectangle") {
    return { lines: rectangleXml(ctx.sample, gate, ax, ay, id), densified: false, recast: null };
  }
  if (gate.gate_type === "polygon") {
    const { lines, densified } = polygonXml(ctx.sample, gate, gate.vertices, ax, ay, id, -1, undefined, ctx.warnings);
    return { lines, densified, recast: null };
  }
  if (gate.gate_type === "ellipse") {
    const exact = ellipsoidXml(ctx.sample, gate, ax, ay, id);
    if (exact) return { lines: exact, densified: false, recast: null };
    const { lines, densified } = polygonXml(ctx.sample, gate, ellipseBoundary(gate, 128), ax, ay, id, -1, [0], ctx.warnings);
    return { lines, densified, recast: "ellipse" };
  }
  if (gate.gate_type !== "quadrant") return null;
  const q = ref.quadrant ?? 1;
  const { ring, corners } = quadrantRing(ctx.sample, gate, q, ax, ay);
  const { lines, densified } = polygonXml(ctx.sample, gate, ring, ax, ay, id, FLOWJO_QUAD_ID[q] ?? -1, corners, ctx.warnings);
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
function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base} (${i})`;
  taken.add(name);
  return name;
}

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
): Node | null {
  const id = ctx.nextId();
  const spec = gateFor(ctx, ref, id);
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
    const name = uniqueName(pop.name, taken);
    names.set(childId, name);
    if (name !== pop.name) {
      ctx.warnings.push(`Two populations beside each other are both called "${pop.name}"; the second was written as "${name}", because FlowJo names populations by their path.`);
    }
  }
  const out: string[] = [];
  for (const childId of children) {
    if (!names.has(childId)) continue;
    out.push(...emitPopulation(ctx, childId, parentGateId, parentMask, path, taken, names, children));
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
  const name = names.get(popId) ?? pop.name;
  if (pop.name.includes("/")) {
    ctx.warnings.push(`"${pop.name}" contains "/", which FlowJo uses to separate a population path; a Boolean population naming it may not resolve in FlowJo.`);
  }

  if (refs.length === 1 && refs[0].include && pop.gate_logic !== "or") {
    const node = populationNode(ctx, name, refs[0], parentGateId, mask, pop.children, path);
    return node ? node.lines : [];
  }

  const count = popcount(mask);
  const countAttr = count === null ? "" : ` count="${count}"`;
  const notNode = (
    notName: string, ref: GateRef, dependent: string, notMask: Uint8Array | null, children: readonly string[],
  ): string[] | null => {
    const notId = ctx.nextId();
    const copy = gateFor(ctx, { ...ref, include: true }, notId);
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
    let helperName: string;
    if (existing) {
      helperName = names.get(existing) ?? ctx.populations[existing].name;
    } else {
      helperName = uniqueName(refLabel(ctx, ref), taken);
      const helper = populationNode(ctx, helperName, { ...ref, include: true }, parentGateId, within, [], path);
      if (!helper) return [];
      ctx.counters.helpers++;
      lines.push(...helper.lines);
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
    const notName = uniqueName(`NOT ${helperName}`, taken);
    const node = notNode(notName, ref, helperPath, notMask, []);
    if (!node) return [];
    ctx.counters.helpers++;
    lines.push(...node);
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
  return [
    `<transforms:spilloverMatrix spectral="0" prefix="Comp-" name="${escAttr(label)}" editable="1" color="#c0c0c0" version="FlowJo-${FLOWJO_VERSION}" status="FINALIZED" transforms:id="${id}" suffix="">`,
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

function sampleBlock(entry: FlowJoExportSample, sampleId: number, opts: FlowJoExportOpts, warnings: string[], counters: SampleContext["counters"]): SampleBlock {
  const { sample, fileName } = entry;
  const pnnOf = (key: string): string => {
    const idx = sample.index(key);
    const pnn = idx !== undefined ? sample.channels[idx].pnn : "";
    return pnn || key;
  };
  const rawTimestep = Number(sample.fcs.keywords["$TIMESTEP"]);
  const timestep = Number.isFinite(rawTimestep) && rawTimestep > 0 && rawTimestep !== 1 ? rawTimestep : null;
  const compensated = new Set(
    sample.instrument === "flow" && sample.compensationEnabled ? sample.spillover?.channels ?? [] : [],
  );

  // Every display-space gate's recorded transform, per channel, so an imported axis is kept.
  const displaySpecs = new Map<string, TransformSpec[]>();
  for (const gid of entry.gate_order.length ? entry.gate_order : Object.keys(entry.gates)) {
    const g = entry.gates[gid];
    if (!g || sample.gateSpace(g) !== "display") continue;
    for (const ch of [g.x_channel, g.y_channel]) {
      const spec = g.transforms?.[ch];
      if (spec) displaySpecs.set(ch, [...(displaySpecs.get(ch) ?? []), spec]);
    }
  }

  // The lowest raw value each channel's gates reach, so a declared biex is built to show it.
  const gateMins = new Map<string, number>();
  const noteMin = (ch: string, v: number) => {
    if (!Number.isFinite(v)) return;
    const cur = gateMins.get(ch);
    if (cur === undefined || v < cur) gateMins.set(ch, v);
  };
  for (const g of Object.values(entry.gates)) {
    if (!g) continue;
    const points: readonly Vertex[] = g.gate_type === "quadrant"
      ? [g.center]
      : g.gate_type === "ellipse"
        ? ellipseBoundary(g, 32)
        : g.vertices;
    for (const pt of points) {
      noteMin(g.x_channel, sample.gateToRaw(g, g.x_channel, pt[0]));
      noteMin(g.y_channel, sample.gateToRaw(g, g.y_channel, pt[1]));
    }
  }

  const axes = new Map<string, Axis>();
  const transformLines: string[] = [];
  sample.channels.forEach((ch, idx) => {
    const { decl, fileScale } = declareAxis(sample, idx, displaySpecs.get(ch.key) ?? [], timestep, warnings, gateMins.get(ch.key));
    const maps = axisMaps(decl);
    const name = compensated.has(ch.key) ? `Comp-${ch.pnn || ch.key}` : (ch.pnn || ch.key);
    axes.set(ch.key, { key: ch.key, name, decl, fileScale, straightIn: (s) => straightIn(decl, s), ...maps });
    // FlowJo declares the compensated parameter beside the raw one, under the same transform.
    transformLines.push(...transformXml(decl, ch.pnn || ch.key));
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
    `  <DataSet uri="file:${encodeURI(fileName)}" sampleID="${sampleId}" />`,
    ...(matrix ? indent(matrix, "  ") : []),
    "  <Transformations>",
    ...indent(transformLines, "    "),
    "  </Transformations>",
    "  <Keywords>",
    ...keywords.map(([k, v]) => `    <Keyword name="${escAttr(k)}" value="${escAttr(v)}" />`),
    "  </Keywords>",
    `  <SampleNode name="${escAttr(fileName)}" annotation="" owningGroup="" expanded="1" sortPriority="10" count="${total}" sampleID="${sampleId}">`,
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
  return { xml: lines.join("\n") + "\n", warnings, sampleCount: samples.length, gateCount: counters.gates };
}

/** The warnings an export would carry, without evaluating a single population. */
export function planFlowJoExport(samples: FlowJoExportSample[]): Omit<FlowJoExportResult, "xml"> {
  const { warnings, sampleCount, gateCount } = exportFlowJoWorkspace({ samples, withoutCounts: true, now: new Date(0) });
  return { warnings, sampleCount, gateCount };
}
