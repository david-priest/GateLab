/**
 * GateLab's own record of a polygon it evaluates continuously, written into a FlowJo workspace
 * beside the vertices FlowJo reads.
 *
 * FlowJo has no continuous polygon: it tests every PolygonGate on its gate grid (flowjoGrid.ts),
 * and so does GateLab's import with "Evaluate gates as FlowJo does" on. A polygon GateLab drew, or
 * one it imported from FlowJo with the option off, is evaluated continuously on its drawn
 * geometry, so reading the file back under the option put it on a grid it was never on, and moved
 * the events near its edges (168,507 across a saved bundle's 18 populations when the declared axis
 * was stretched by one outlier, 2026-09-25). A rectangle already carries GateLab's record
 * (rectangleRecord.ts); a polygon now does too: its space, its transforms and its vertices as
 * GateLab holds them, and the coordinates the file states for it (`written`). The importer
 * restores the polygon from the record, continuously and whatever the import's option, while the
 * file still states exactly those coordinates; a polygon FlowJo has moved or saved in other
 * digits reads as FlowJo's own again, under the option.
 *
 * A polygon on FlowJo's grid carries no record: it goes back as FlowJo saved it (FlowJo's raw
 * vertices and gateResolution), and an import reads it as FlowJo's polygon under whichever answer
 * it is given, as a rectangle imported under FlowJo's rule does.
 */

import type { Gate, GateSpace, TransformSpec, Vertex } from "./models";
import { parseTransformSpec, type GateSpaceResolver } from "./rectangleRecord";

/** FlowJo workspace: the attribute on a PolygonGate element that holds its record. */
export const WSP_POLYGON_ATTR = "gatelabPolygon";

export interface PolygonRecord {
  space: GateSpace;
  /** Per axis, the transform the vertices are in; present only when `space` is display. */
  transforms?: { x: TransformSpec; y: TransformSpec };
  /** The vertices as GateLab holds them, in `space`. */
  vertices: Vertex[];
  /**
   * Every coordinate as the file states it, x then y for each vertex in document order. Restoring
   * is refused when the file no longer says exactly this.
   */
  written: string[];
}

/** The record of a polygon (or of the ring an ellipse is written as) as GateLab holds it. */
export function polygonRecordOf(
  resolver: GateSpaceResolver, gate: Gate, ring: readonly Vertex[], written: readonly string[],
): PolygonRecord {
  const space = resolver.gateSpace(gate);
  const spec = (ch: string): TransformSpec => gate.transforms?.[ch] ?? resolver.transformSpec(ch);
  return {
    space,
    ...(space === "display" ? { transforms: { x: spec(gate.x_channel), y: spec(gate.y_channel) } } : {}),
    vertices: ring.map(([x, y]) => [x, y] as Vertex),
    written: [...written],
  };
}

const finitePair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/** A record read from a file, or null when any part of it is missing or malformed. */
export function parsePolygonRecord(value: unknown): PolygonRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.vertices) || v.vertices.length < 3 || !v.vertices.every(finitePair)) return null;
  if (!Array.isArray(v.written) || !v.written.every((w) => typeof w === "string")) return null;
  const vertices = (v.vertices as [number, number][]).map(([x, y]) => [x, y] as Vertex);
  const written = [...(v.written as string[])];
  if (v.space === "raw") return { space: "raw", vertices, written };
  if (v.space !== "display" || !v.transforms || typeof v.transforms !== "object") return null;
  const t = v.transforms as Record<string, unknown>;
  const tx = parseTransformSpec(t.x);
  const ty = parseTransformSpec(t.y);
  // A grid axis is never a continuous polygon's: such a record is not one GateLab wrote.
  if (!tx || !ty || tx.kind === "flowjoChannels" || ty.kind === "flowjoChannels") return null;
  return { space: "display", transforms: { x: tx, y: ty }, vertices, written };
}

/**
 * The coordinates of every PolygonGate in generated FlowJo workspace lines, by gating:id, read off
 * the text the file will hold, so the record's check is on the file itself.
 */
export function writtenPolygonCoordinates(lines: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines) {
    const open = /<gating:PolygonGate\b[^>]*\bgating:id="([^"]+)"/.exec(line);
    if (open) {
      current = [];
      out.set(open[1], current);
      continue;
    }
    if (!current) continue;
    if (/<\/gating:PolygonGate>/.test(line)) {
      current = null;
      continue;
    }
    const coord = /<gating:coordinate\b[^>]*\bdata-type:value="([^"]*)"/.exec(line);
    if (coord) current.push(coord[1]);
  }
  return out;
}
