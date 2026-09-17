// gateSpace.ts — the space a gate's vertices are read in, resolved the way evaluation resolves
// it. A gate drawn before the per-gate `space` field existed carries neither `space` nor
// `transforms`: its vertices are in the sample's default space ("raw" for flow, "display" for
// CyTOF) and, when display, in the sample's current display transform (Sample.gateToRaw reads
// them that way). An exporter that read the field directly wrote such a gate as raw, and the
// re-import then moved it by one arcsinh.

import type { GateSpace, PolyRectGate, TransformSpec } from "./models";
import { transformFromSpec } from "./sample";

/** What resolves a gate that lacks the per-gate fields: a Sample, or anything shaped like one. */
export interface GateSpaceContext {
  readonly gatingSpace: GateSpace;
  transformSpec(channel: string): TransformSpec;
}

/** A gate's space with the transform of each axis; both identity for a raw gate. */
export interface ResolvedGateSpace {
  space: GateSpace;
  x: TransformSpec;
  y: TransformSpec;
}

/**
 * The space and per-axis transforms a gate's vertices are in: the gate's own fields first, then
 * the context's default space and current display transforms, and for a display gate with
 * neither, arcsinh at `cofactor`, which is what a CyTOF workspace displays.
 */
export function resolveGateSpace(
  gate: Pick<PolyRectGate, "x_channel" | "y_channel" | "space" | "transforms">,
  context: GateSpaceContext | undefined,
  cofactor: number,
): ResolvedGateSpace {
  const space = gate.space ?? context?.gatingSpace ?? "raw";
  if (space === "raw") return { space, x: { kind: "identity" }, y: { kind: "identity" } };
  const axis = (channel: string): TransformSpec =>
    gate.transforms?.[channel] ?? context?.transformSpec(channel) ?? { kind: "asinh", cofactor };
  return { space, x: axis(gate.x_channel), y: axis(gate.y_channel) };
}

/** A coordinate in `spec`'s units → arcsinh display units at `cofactor`; unchanged when it already is. */
export function toAsinhUnits(spec: TransformSpec, v: number, cofactor: number): number {
  if (spec.kind === "asinh") return spec.cofactor === cofactor ? v : Math.asinh((Math.sinh(v) * spec.cofactor) / cofactor);
  if (spec.kind === "identity") return Math.asinh(v / cofactor);
  return Math.asinh(transformFromSpec(spec).inverse(v) / cofactor);
}

/** A coordinate in `spec`'s units → raw. */
export function toRawUnits(spec: TransformSpec, v: number): number {
  return spec.kind === "identity" ? v : transformFromSpec(spec).inverse(v);
}

/** A rectangle's two stored corners as four, clockwise from the first; other shapes as stored. */
export function gateCorners(gate: Pick<PolyRectGate, "gate_type" | "vertices">): [number, number][] {
  if (gate.gate_type === "rectangle" && gate.vertices.length === 2) {
    const [[x0, y0], [x1, y1]] = gate.vertices;
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }
  return gate.vertices.map(([x, y]) => [x, y]);
}
