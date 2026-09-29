// gateSpaceBadge.ts — the two-letter space badge shown on a gate label and in the gate list.
//
// A workspace can hold raw-space and display-space gates side by side, and on screen they look
// identical. Without a visible marker that is a silent footgun of exactly the kind this whole
// design exists to prevent — so the badge is not optional polish. See
// LabNotes/Coding/GateLab/GateLab — gating space (raw vs display) design.md §2.5.
//
// One letter per axis, x then y: R raw · A arcsinh · L logicle · N linear.
// `N` and `R` agree numerically on that axis — a linear display axis IS raw — which the badge
// shows honestly rather than papering over.

import type { Gate, TransformSpec } from "./models";
import type { Sample } from "./sample";
import { describeFlowJoGridAxis, isFlowJoGridSpec, sameFlowJoGridSpec } from "./flowjoGrid";

// B and G only ever appear on gates imported from a FlowJo workspace: GateLab does not display
// on either, it only holds gates in those spaces so they evaluate the way FlowJo evaluates them.
// F is FlowJo's gate grid (flowjoGrid.ts), on a polygon imported with "Evaluate gates as FlowJo
// does": the gate is tested on FlowJo's channels, not on the drawn lines.
const LETTER: Record<TransformSpec["kind"], string> = {
  identity: "N",
  asinh: "A",
  logicle: "L",
  biex: "B",
  wsplog: "G",
  flog: "O",
  flowjoChannels: "F",
};

function describe(spec: TransformSpec | undefined): string {
  if (!spec) return "current display transform";
  if (spec.kind === "identity") return "linear";
  if (spec.kind === "asinh") return `arcsinh (cofactor ${spec.cofactor})`;
  if (spec.kind === "logicle") return `logicle (T ${spec.T.toPrecision(4)}, W ${spec.W.toPrecision(3)})`;
  if (spec.kind === "biex") {
    // Which table: two gates on the same biex parameters draw the same and can hold different
    // events near their edges, so the tooltip says which one this gate is evaluated on (biex.ts).
    const table = spec.tableChannels === undefined
      ? "on the 256-channel table GateLab used before 2026-09-24, which this gate was saved on"
      : `on FlowJo's ${spec.tableChannels}-channel table`;
    return `FlowJo biex (width ${spec.widthBasis.toPrecision(4)}, neg ${spec.neg}, pos ${spec.pos}), ${table}`;
  }
  if (spec.kind === "flog") return `log (T ${spec.T.toPrecision(4)}, M ${spec.M.toPrecision(4)})`;
  if (spec.kind === "flowjoChannels") return describeFlowJoGridAxis(spec);
  return `FlowJo log (offset ${spec.offset.toPrecision(4)}, ${spec.decades.toPrecision(4)} decades)`;
}

/**
 * A transform named for a sentence a user reads ("…drawn on {name}, which the file cannot name"),
 * with its article: never the code identifier a spec carries.
 */
export function transformPhrase(spec: TransformSpec): string {
  switch (spec.kind) {
    case "identity": return "a linear axis";
    case "asinh": return "an arcsinh axis";
    case "logicle": return "a logicle axis";
    case "biex": return "a FlowJo biex axis";
    case "wsplog": return "a FlowJo log axis";
    case "flog": return "a Gating-ML log axis";
    case "flowjoChannels": return `FlowJo's ${spec.channels}-channel grid`;
  }
}

export interface GateSpaceBadge {
  /** Two letters, x then y, with a trailing `*` when the view differs from the gate's space. */
  text: string;
  /** Full prose for the tooltip. */
  hint: string;
}

function sameSpec(a: TransformSpec, b: TransformSpec): boolean {
  if (a.kind !== b.kind) return false;
  // Compared field by field rather than by JSON, so key order can never make two identical
  // transforms look different and star a gate that has not drifted.
  if (a.kind === "asinh" && b.kind === "asinh") return a.cofactor === b.cofactor;
  if (a.kind === "logicle" && b.kind === "logicle") {
    return a.T === b.T && a.W === b.W && a.M === b.M && a.A === b.A;
  }
  if (a.kind === "biex" && b.kind === "biex") {
    return a.maxValue === b.maxValue && a.pos === b.pos && a.neg === b.neg
      && a.widthBasis === b.widthBasis && a.channelRange === b.channelRange
      && a.tableChannels === b.tableChannels;
  }
  if (a.kind === "flowjoChannels" && b.kind === "flowjoChannels") return sameFlowJoGridSpec(a, b);
  if (a.kind === "wsplog" && b.kind === "wsplog") {
    return a.offset === b.offset && a.decades === b.decades;
  }
  if (a.kind === "flog" && b.kind === "flog") return a.T === b.T && a.M === b.M;
  return true; // identity
}

/**
 * True when dragging this gate right now would change its shape in its OWN space.
 *
 * Dragging is only rigid in the space you drag in: translating in one space adds a constant to
 * the raw values, which is a different distance at every point in any other. So a long drag under
 * a transform the gate was not drawn in reshapes it — visible only once you switch back.
 *
 * Restricted to polygons on purpose. A rectangle's corners also move nonlinearly, but it stays an
 * axis-aligned box, so nothing about its shape surprises anyone; a quadrant is a single point.
 * Starring those would be noise on gates that cannot exhibit the problem.
 */
function viewDiffersFromGate(sample: Sample, gate: Gate): boolean {
  if (gate.gate_type !== "polygon") return false;
  const space = sample.gateSpace(gate);
  for (const ch of [gate.x_channel, gate.y_channel]) {
    const current = sample.transformSpec(ch);
    const own: TransformSpec = space === "raw"
      ? { kind: "identity" }
      : (gate.transforms?.[ch] ?? current);
    if (!sameSpec(current, own)) return true;
  }
  return false;
}

/**
 * The badge for one gate, or null when it should not be shown.
 *
 * Null on CyTOF: every channel is arcsinh at cofactor 5, so the badge would read the same on every
 * gate forever. The distinction is a flow problem, so the badge is a flow feature.
 */
export function gateSpaceBadge(sample: Sample, gate: Gate): GateSpaceBadge | null {
  if (sample.instrument === "cytof") return null;
  const { x_channel: x, y_channel: y } = gate;
  const drifted = viewDiffersFromGate(sample, gate);
  const star = drifted ? "*" : "";
  const warn = drifted
    ? " ⚠ You are viewing it through a different transform, so its edges are not straight as shown"
      + " and dragging it far will change its shape. Small nudges are near-harmless."
    : "";
  if (sample.gateSpace(gate) === "raw") {
    return {
      text: `RR${star}`,
      hint: "Raw space — straight in raw values on both axes. Moving a display control cannot change"
        + " which events are in this gate." + warn,
    };
  }
  const tx = gate.transforms?.[x];
  const ty = gate.transforms?.[y];
  const text = `${tx ? LETTER[tx.kind] : "?"}${ty ? LETTER[ty.kind] : "?"}${star}`;
  if (isFlowJoGridSpec(tx) || isFlowJoGridSpec(ty)) {
    return {
      text,
      hint: `FlowJo's grid — tested as FlowJo tests it: each event on its channel of FlowJo's grid, `
        + `against the polygon's vertices on the same channels, edge included. x: ${describe(tx)} · `
        + `y: ${describe(ty)}. Edited vertices stay on channels. Changing the axis scale redraws it `
        + "but cannot move it." + warn,
    };
  }
  return {
    text,
    hint: `Display space — straight as drawn. x: ${describe(tx)} · y: ${describe(ty)}. `
      + "The gate keeps these transforms, so changing the axis scale redraws it but cannot move it."
      + warn,
  };
}
