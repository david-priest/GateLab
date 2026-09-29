/**
 * GateLab's own record of a rectangle, written beside the geometry another program reads.
 *
 * A rectangle leaves GateLab in a form built for the reader: Gating-ML writes it in the file's
 * declared space with its upper bound moved for a reader of the rule it does not follow, so that
 * a reader of either rule holds its events (on a raw or identity axis of float32 data, every event
 * on an edge; on a transformed axis, the exporting file's own events for a reader in double
 * precision, with the exceptions gatingmlExport.ts's forEveryReader names), FlowJo's workspace
 * writes raw values with the bound moved for FlowJo's closed rule, each number written in full
 * (gatingmlExport.ts, fmtNum), and places a bound among the file's events where GateLab's float32
 * decision there and the written number part (flowjoExport.ts, onGateLabSide; until 2026-09-26 it
 * placed none, and on a transformed axis, and on an identity axis over float64 data, a reader of raw
 * values under FlowJo's rule held otherwise than GateLab where GateLab's float32 values tie: the
 * release candidate's verifier, 105 to 3,176 of 16,000 events on stacked synthetic files, and the
 * same on 0.8.3). Another program needs exactly that. GateLab reading its own file
 * back does not: the events lying exactly on an edge are decided in a float32 column, and a bound
 * brought back through a transform and its inverse, or moved by 1e-13 of itself, can land on
 * either side of them by far more than the move (6e-8 of the value is float32's own spacing). So the file
 * also carries the rectangle as GateLab holds it: its edge rule, its own space and transforms,
 * and its bounds as exact numbers. The importer restores that when the geometry in the file is
 * still the geometry GateLab wrote (`written`) and the file's bounds, taken back through the
 * transform the file declares, are the ones the record says were written, the move for the
 * reader's rule included, to within what the file's own digits can round away (`statesRecord`).
 * Otherwise it reads the file's geometry under the recorded rule, so an edit made in another
 * program is never overridden, and an exporter that wrote the geometry wrongly by as little as the
 * reader's move is not hidden from GateLab's own reading of its file: the record settles the rule
 * and the last digits of a bound, never where the rectangle is.
 *
 * Where each format keeps it: Gating-ML in the document's custom_info (gatingmlExport.ts), where
 * Cytobank already accepts GateLab's scales block; a FlowJo workspace as one attribute on the
 * gate element (flowjoExport.ts), FlowJo's own vocabulary being attributes on that element.
 */

import type { Gate, GateSpace, PolyRectGate, RectangleBounds, TransformBounds, TransformSpec, Vertex } from "./models";
import { isRectangleBounds, rectangleRule } from "./models";
import { transformFromSpec } from "./sample";
import { otherRectangleRule, rangeForReader } from "./gates";
import { parseFlowJoGridSpec } from "./flowjoGrid";

export interface RectangleRecord {
  bounds: RectangleBounds;
  space: GateSpace;
  /** Per axis, the transform the bounds are in; present only when `space` is display. */
  transforms?: { x: TransformSpec; y: TransformSpec };
  x: [number, number];
  y: [number, number];
  /**
   * The bounds as the file states them, one "min|max" per dimension in document order, an absent
   * bound as the empty string. Restoring is refused when the file no longer says this.
   */
  written?: string[];
  /**
   * Where an exporter placed a bound among the file's own events after writing it for the reader
   * (fix/gatingml-hardening's exactBound and tieBreak, within float32 rounding's width; the FlowJo
   * export's clearOfDisplay and onGateLabSide, onto a value of the file, flowjoWorkspace.ts), the
   * bounds as they were before, in the form `written` takes. The check that the file's geometry is
   * the record's is made on these: the placement is the exporter's deliberate step, and the
   * geometry it started from is what a fault in writing the rectangle would show in.
   */
  placedFrom?: string[];
}

/** Gating-ML: the custom_info element holding every rectangle's record, keyed by gating:id. */
export const GATINGML_RECTANGLES_TAG = "gatelab_rectangles";
/**
 * Gating-ML: the custom_info element stating the rule a rectangle in the file follows when it has
 * no record, "half-open" in every file GateLab writes from 2026-09 on, the standard's rule. Each
 * rectangle's geometry is written for a reader of either rule, every bound in full
 * (gatingmlExport.ts, forEveryReader), so on a raw or identity axis of float32 data the rule
 * decides only a value within 1e-13 of an edge, and no float32 event lies there: the move stops
 * short of any float32 value it would cross (gates.ts, float32Side). On float64 data, and
 * on a transformed axis, where GateLab decides an event's value in single precision and the
 * written bound is placed for a reader in double precision first, an event within rounding of an
 * edge can still be decided differently without the record. It is what tells
 * such a file from one GateLab 0.8.3 or earlier wrote, whose rectangles are closed and which
 * carries neither element, when a program has kept the file's custom_info but dropped the records,
 * or GateLab cannot use one.
 */
export const GATINGML_EDGE_RULE_TAG = "gatelab_edge_rule";
/** FlowJo workspace: the attribute on a RectangleGate element that holds its record. */
export const WSP_RECTANGLE_ATTR = "gatelabRectangle";

/** What resolves a gate's own space: the loaded Sample, or a stand-in for tests. */
export interface GateSpaceResolver {
  gateSpace(gate: Gate): GateSpace;
  transformSpec(channel: string): TransformSpec;
}

/** The record of a rectangle as GateLab holds it. */
export function rectangleRecordOf(resolver: GateSpaceResolver, gate: PolyRectGate): RectangleRecord {
  const xs = gate.vertices.map((v) => v[0]);
  const ys = gate.vertices.map((v) => v[1]);
  const space = resolver.gateSpace(gate);
  const spec = (ch: string): TransformSpec => gate.transforms?.[ch] ?? resolver.transformSpec(ch);
  return {
    bounds: rectangleRule(gate),
    space,
    ...(space === "display" ? { transforms: { x: spec(gate.x_channel), y: spec(gate.y_channel) } } : {}),
    x: [Math.min(...xs), Math.max(...xs)],
    y: [Math.min(...ys), Math.max(...ys)],
  };
}

/** The four corners, in the order every GateLab rectangle stores them. */
export function recordVertices(rec: RectangleRecord): Vertex[] {
  const [x0, x1] = rec.x;
  const [y0, y1] = rec.y;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const finitePair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) && v[0] <= v[1];

/** A transform read from a file, or null if it is not one GateLab can hold exactly. */
/**
 * A Gating-ML transformation's boundMin and boundMax as a spec carries them (models.ts,
 * TransformBounds): undefined when absent, null when malformed.
 */
function parseTransformBounds(value: unknown): TransformBounds | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const out: TransformBounds = {};
  for (const side of ["min", "max"] as const) {
    if (v[side] === undefined) continue;
    if (!finite(v[side])) return null;
    out[side] = v[side] as number;
  }
  if (out.min !== undefined && out.max !== undefined && out.min > out.max) return null;
  return out;
}

export function parseTransformSpec(value: unknown): TransformSpec | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const all = (...keys: string[]) => keys.every((k) => finite(v[k]));
  // A transformation's bounds (fix/gatingml-transforms) change which events the gate holds, so the
  // record carries them; a spec restored without them held other events than the one written.
  const bounds = parseTransformBounds(v.bounds);
  if (bounds === null) return null;
  const withBounds = bounds ? { bounds } : {};
  switch (v.kind) {
    case "identity": return { kind: "identity", ...withBounds };
    case "asinh": return all("cofactor") ? { kind: "asinh", cofactor: v.cofactor as number, ...withBounds } : null;
    case "logicle":
      return all("T", "W", "M", "A")
        ? { kind: "logicle", T: v.T as number, W: v.W as number, M: v.M as number, A: v.A as number, ...withBounds }
        : null;
    case "biex": {
      if (!all("maxValue", "pos", "neg", "widthBasis", "channelRange")) return null;
      // Absent keeps the table a spec saved before FlowJo's own was adopted (biex.ts); a value
      // this build cannot build a table at is refused rather than read as that default.
      const table = v.tableChannels;
      if (table !== undefined && !(finite(table) && Number.isInteger(table) && table > 1)) return null;
      return {
        kind: "biex", maxValue: v.maxValue as number, pos: v.pos as number, neg: v.neg as number,
        widthBasis: v.widthBasis as number, channelRange: v.channelRange as number,
        ...(table !== undefined ? { tableChannels: table as number } : {}),
      };
    }
    case "flowjoChannels": return parseFlowJoGridSpec(v);
    case "wsplog":
      return all("offset", "decades") ? { kind: "wsplog", offset: v.offset as number, decades: v.decades as number } : null;
    case "flog":
      // `standard`: Gating-ML's own flog, with no floor (models.ts); absent keeps GateLab's older one.
      if (v.standard !== undefined && typeof v.standard !== "boolean") return null;
      return all("T", "M")
        ? { kind: "flog", T: v.T as number, M: v.M as number, ...(v.standard === true ? { standard: true } : {}), ...withBounds }
        : null;
    default: return null;
  }
}

/** A record read from a file, or null when any part of it is missing or malformed. */
export function parseRectangleRecord(value: unknown): RectangleRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isRectangleBounds(v.bounds) || !finitePair(v.x) || !finitePair(v.y)) return null;
  const strings = (w: unknown) => w === undefined || (Array.isArray(w) && w.every((d) => typeof d === "string"));
  if (!strings(v.written) || !strings(v.placedFrom)) return null;
  const written = v.written as string[] | undefined;
  const placedFrom = v.placedFrom as string[] | undefined;
  const texts = { ...(written ? { written: [...written] } : {}), ...(placedFrom ? { placedFrom: [...placedFrom] } : {}) };
  if (v.space === "raw") {
    return { bounds: v.bounds, space: "raw", x: [...v.x], y: [...v.y], ...texts };
  }
  if (v.space !== "display" || !v.transforms || typeof v.transforms !== "object") return null;
  const t = v.transforms as Record<string, unknown>;
  const tx = parseTransformSpec(t.x);
  const ty = parseTransformSpec(t.y);
  if (!tx || !ty) return null;
  return {
    bounds: v.bounds, space: "display", transforms: { x: tx, y: ty },
    x: [...v.x], y: [...v.y], ...texts,
  };
}

/** One dimension's bounds as a file states them, in the form `written` holds. */
export function writtenBound(min: string | null | undefined, max: string | null | undefined): string {
  return `${min ?? ""}|${max ?? ""}`;
}

/**
 * The bounds of every RectangleGate in generated Gating-ML lines, by gating:id, read off the
 * text the file will hold rather than recomputed, so the record's check is on the file itself.
 */
export function writtenRectangleBounds(lines: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines) {
    const open = /<gating:RectangleGate\b[^>]*\bgating:id="([^"]+)"/.exec(line);
    if (open) {
      current = [];
      out.set(open[1], current);
      continue;
    }
    if (!current) continue;
    if (/<\/gating:RectangleGate>/.test(line)) {
      current = null;
      continue;
    }
    if (/<gating:dimension\b/.test(line)) {
      const min = /\bgating:min="([^"]*)"/.exec(line)?.[1];
      const max = /\bgating:max="([^"]*)"/.exec(line)?.[1];
      current.push(writtenBound(min, max));
    }
  }
  return out;
}

/**
 * How far a bound the file states may lie from the one GateLab wrote, relative to it, in the space
 * the file states it in. GateLab writes every number in full (fmtNum) since 2026-09; 15
 * significant digits, which it wrote before, round a number by at most 5e-15 of itself, and a
 * conversion into GateLab's space and back, or a gain restated on import, adds a few 1e-16; the move for another reader's
 * rule is 1e-13 (gates.ts, upperBoundForReader). So a bound written wrongly by as little as that
 * move, on either side, is not the record's, and the record does not cover it, wherever the
 * file's own precision can show it: on an axis compressed where the file states the bound (the
 * top of a log axis written in raw values), less than the move is left to see.
 */
const RECORD_TOLERANCE = 3e-14;

function sameBound(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) <= RECORD_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
}

const IDENTITY_SPEC: TransformSpec = { kind: "identity" };

/**
 * Whether two transforms are the same one to within what a file's writing of a transform's
 * parameters, and the importer's reading of them, can change: an arcsinh cofactor recomputed from T
 * and M, or a T restated by a gain, 15 significant digits in a file written before 2026-09.
 */
function sameTransform(a: TransformSpec, b: TransformSpec): boolean {
  if (a.kind !== b.kind) return false;
  // Every field the record's spec carries, nested ones (a transformation's bounds) included.
  const same = (u: unknown, v: unknown): boolean => {
    if (typeof u === "number" && typeof v === "number") {
      return u === v || Math.abs(u - v) <= 1e-12 * Math.max(Math.abs(u), Math.abs(v));
    }
    if (u && v && typeof u === "object" && typeof v === "object") {
      const pu = u as Record<string, unknown>;
      const pv = v as Record<string, unknown>;
      return Object.keys(pu).every((k) => same(pu[k], pv[k]));
    }
    return u === v;
  };
  return same(a, b);
}

/**
 * How a format wrote a record's bounds: for a reader of which rule, and where the upper bound was
 * moved for it, the lower bound following an upper one moved below it (gates.ts, rangeForReader).
 * Gating-ML moves it in the rectangle's own coordinates, for a reader of the rule the rectangle
 * does not follow ("other"; gatingmlExport.ts, forEveryReader); a FlowJo workspace in raw values,
 * for FlowJo's closed rule (flowjoExport.ts).
 */
export interface RecordWriting {
  reader: RectangleBounds | "other";
  movedIn: "own" | "raw";
}
export const GATINGML_WRITING: RecordWriting = { reader: "other", movedIn: "own" };
export const WSP_WRITING: RecordWriting = { reader: "closed", movedIn: "raw" };

/**
 * Whether the bounds a file states are the ones GateLab wrote from this record. `x` and `y` are
 * each axis's [min, max] as the file states them (null where it states none, which leaves that
 * side unbounded), in the space `fileSpace` names for each axis (identity: raw values). Each is
 * compared with the bound the record says was written, the reader's move included, to within
 * RECORD_TOLERANCE. A geometry an exporter got wrong by that move or more, or one another program
 * moved, is not the record's.
 *
 * Where the file states an axis in the record's own space, as GateLab's Gating-ML does for every
 * transform it can declare, the exporter wrote the record's own number there, and it is compared
 * as it is. No transform is applied, so the comparison holds where a log or logicle display nears
 * 0 or lies below its floor: there the display is 1 plus a logarithm near -1, the transform and
 * its inverse keep an error of about 1e-16 of a display unit however small the value, and every
 * flog value below 0 comes back as 0 (flog's forward(inverse(1e-12)) is 9.9987e-13), so no
 * relative comparison through raw values holds. Anywhere else the written bound is carried into
 * the file's space: raw values for a FlowJo workspace, and arcsinh for a logicle rectangle in the
 * Cytobank format, where the conversion is well conditioned.
 */
export function statesRecord(
  rec: RectangleRecord,
  x: [number | null, number | null],
  y: [number | null, number | null],
  writing: RecordWriting,
  fileSpace: { x: TransformSpec; y: TransformSpec } = { x: IDENTITY_SPEC, y: IDENTITY_SPEC },
): boolean {
  const ownSpec = (axis: "x" | "y"): TransformSpec =>
    (rec.space === "display" ? rec.transforms?.[axis] : undefined) ?? IDENTITY_SPEC;
  const axes: Array<["x" | "y", [number | null, number | null]]> = [["x", x], ["y", y]];
  return axes.every(([axis, file]) => {
    const own = ownSpec(axis);
    const toRaw = transformFromSpec(own).inverse;
    const fileSpec = fileSpace[axis];
    const [lo, hi] = rec[axis];
    const reader = writing.reader === "other" ? otherRectangleRule(rec.bounds) : writing.reader;
    let expected: [number, number];
    if (writing.movedIn === "own" && sameTransform(own, fileSpec)) {
      expected = rangeForReader(lo, hi, rec.bounds, reader);
    } else {
      const raw: [number, number] = writing.movedIn === "own"
        ? rangeForReader(lo, hi, rec.bounds, reader).map(toRaw) as [number, number]
        : rangeForReader(toRaw(lo), toRaw(hi), rec.bounds, reader);
      const toFile = transformFromSpec(fileSpec).forward;
      expected = [toFile(raw[0]), toFile(raw[1])];
    }
    return file.every((v, i) => v === null || sameBound(v, expected[i]));
  });
}

/** The record restored onto a gate: its rule always, its own geometry and space when it applies. */
export function applyRectangleRecord(
  gate: PolyRectGate,
  rec: RectangleRecord,
  written: readonly string[] | undefined,
): void {
  // The file's reading of the rectangle, in the space the importer put it in, taken before
  // anything is changed.
  const xs = gate.vertices.map((v) => v[0]);
  const ys = gate.vertices.map((v) => v[1]);
  const stated = (dim: string | undefined, lo: number, hi: number): [number | null, number | null] => {
    const [min, max] = (dim ?? "|").split("|");
    return [min === "" ? null : lo, max === "" ? null : hi];
  };
  const fileSpec = (ch: string): TransformSpec =>
    (gate.space === "raw" ? undefined : gate.transforms?.[ch]) ?? IDENTITY_SPEC;
  gate.bounds = rec.bounds;
  const unchanged = rec.written !== undefined && written !== undefined
    && rec.written.length === written.length && rec.written.every((w, i) => w === written[i]);
  if (!unchanged) return;
  // A one-dimensional range states its one dimension for both axes.
  let fileX = stated(written![0], Math.min(...xs), Math.max(...xs));
  let fileY = stated(written![1] ?? written![0], Math.min(...ys), Math.max(...ys));
  if (rec.placedFrom) {
    // The bounds before the exporter placed them among the file's events, carried into the
    // importer's units as the file's own bounds were: GateLab's declared transforms scale a
    // coordinate through 0 (identity, or logicle's division by its span), so each axis's factor is
    // the file's bound in the importer's units over the same bound as the file states it.
    const before = (dims: [string | undefined, string | undefined], file: [number | null, number | null]) => {
      const now = (dims[0] ?? "|").split("|").map((t) => (t === "" ? null : Number(t)));
      const was = (dims[1] ?? "|").split("|").map((t) => (t === "" ? null : Number(t)));
      const k = [0, 1].map((j) => (file[j] !== null && now[j] ? file[j]! / now[j]! : null)).find((f) => f !== null) ?? 1;
      return [0, 1].map((j) => (was[j] === null || file[j] === null ? null : was[j]! * k)) as [number | null, number | null];
    };
    fileX = before([written![0], rec.placedFrom[0]], fileX);
    fileY = before([written![1] ?? written![0], rec.placedFrom[1] ?? rec.placedFrom[0]], fileY);
  }
  const space = { x: fileSpec(gate.x_channel), y: fileSpec(gate.y_channel) };
  if (!statesRecord(rec, fileX, fileY, GATINGML_WRITING, space)) return;
  gate.vertices = recordVertices(rec);
  gate.space = rec.space;
  if (rec.space === "display" && rec.transforms) {
    gate.transforms = { [gate.x_channel]: rec.transforms.x, [gate.y_channel]: rec.transforms.y };
  } else {
    delete gate.transforms;
  }
}
