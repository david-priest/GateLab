// barcodeTemplate.ts — the shapes of a debarcoding strategy, independent of any workspace.
//
// A CyTOF debarcoding strategy has two parts, and a template records both:
//
// 1. The QC chain above the samples: a few populations, each the AND of standard gates
//    (Gaussian parameters against Time, singlets on event length against DNA, a DNA-positive
//    bead-negative gate, a live gate). These are much the same from one CyTOF experiment to the
//    next, so the template carries them in exactly the form the lab draws them: rectangles for
//    the Gaussian and singlets gates, polygons for the rest.
// 2. The barcode planes: four polygons per plane, one per state of the isotope pair ("--" a
//    small box at the origin, "+-" and "-+" wedges hugging one axis, "++" a diagonal band), in
//    arcsinh display units. Every barcode gate is a polygon of seven or eight vertices, so it
//    can be bent into shape rather than only resized.
//
// The built-in default is taken from the nPhos4 debarcoding workspace (2026-08-28, CyTOF XT,
// arcsinh cofactor 5): its QC chain, with the B-cell-specific live gate generalised to a live
// gate on DNA, and its three barcode planes averaged. A template can also be learned from a
// workspace that already holds a debarcoding strategy, in which case the exact QC chain above
// the sample populations and the per-plane shapes are kept.

import type { Gate, PolyRectGate, Population, PopulationMap, Vertex } from "./models";
import { isDnaChannel, massLabel } from "./barcodeMass";

/** x state then y state: "+-" is x positive, y negative. */
export type BarcodeStateKey = "--" | "+-" | "-+" | "++";
export const BARCODE_STATE_KEYS: readonly BarcodeStateKey[] = ["--", "+-", "-+", "++"];

export interface BarcodePlaneShapes {
  /** Polygon per state, in arcsinh display units; x first, y second. */
  states: Record<BarcodeStateKey, Vertex[]>;
}

/** How a QC gate's axis is transformed: identity (raw values) or arcsinh with the sample's cofactor. */
export type QcAxisTransform = "identity" | "asinh";

export interface QcGateTemplate {
  name: string;
  /** Channel names as the template's source named them; resolved by name, isotope or role. */
  x: string;
  y: string;
  gate_type: "rectangle" | "polygon";
  /** In the gate's own space: raw values for a raw gate, display units for a display gate. */
  vertices: Vertex[];
  space: "raw" | "display";
  /** Present when space is display. */
  transforms?: { x: QcAxisTransform; y: QcAxisTransform };
  /**
   * Stretch the x extent to the loaded sample's full range of that channel. Used for gates
   * drawn against Time, whose span differs from file to file while the y limits do not.
   */
  xFull?: boolean;
}

export interface QcPopulationTemplate {
  name: string;
  /** All gates are intersected (AND, include). */
  gates: QcGateTemplate[];
}

export interface BarcodeTemplate {
  format: "gatelab-barcode-template";
  version: 1;
  units: "asinh";
  /** The cofactor the shapes were drawn under. Shapes are reused as-is under another cofactor. */
  cofactor: number;
  /** Negative/positive boundary on either axis, arcsinh units. */
  boundary: number;
  /** Extent of a display-only axis covered by the two gates of a one-barcode plane. */
  displayRange: [number, number];
  /** Generic shapes, used for any plane without its own entry. */
  states: Record<BarcodeStateKey, Vertex[]>;
  /**
   * Per-plane shapes keyed by "<x mass label>x<y mass label>" ("195Ptx194Pt"). A plane in the
   * reverse orientation is served by swapping coordinates.
   */
  planes: Record<string, BarcodePlaneShapes>;
  /** The chain of QC populations above the samples, outermost first. */
  qc: QcPopulationTemplate[];
  /** Where the template came from, for the user's information only. */
  source?: string;
}

const RAW_RECT = (yLo: number, yHi: number): Vertex[] => [[0, yLo], [1, yLo], [1, yHi], [0, yHi]];

/** nPhos4's QC chain. Time-axis rectangles are stretched to the sample's Time range on import. */
export const DEFAULT_QC_CHAIN: QcPopulationTemplate[] = [
  {
    name: "Cells",
    gates: [
      { name: "AmplitudeGate", x: "Time", y: "Amplitude", gate_type: "rectangle", space: "raw", xFull: true, vertices: RAW_RECT(13.595, 1254.272) },
      { name: "CenterGate", x: "Time", y: "Center", gate_type: "rectangle", space: "raw", xFull: true, vertices: RAW_RECT(321.283, 615.828) },
      { name: "OffsetGate", x: "Time", y: "Offset", gate_type: "rectangle", space: "raw", xFull: true, vertices: RAW_RECT(-0.647, 13.344) },
      { name: "ResidualGate", x: "Time", y: "Residual", gate_type: "rectangle", space: "raw", xFull: true, vertices: RAW_RECT(23.116, 178.316) },
      { name: "WidthGate", x: "Time", y: "Width", gate_type: "rectangle", space: "raw", xFull: true, vertices: RAW_RECT(110.794, 797.945) },
      {
        name: "SingletsGate", x: "Event_length", y: "DNA", gate_type: "rectangle", space: "display",
        transforms: { x: "identity", y: "asinh" },
        vertices: [[-3.458, 1.043], [55.468, 1.043], [55.468, 8.508], [-3.458, 8.508]],
      },
      {
        name: "DNA+Bead-Gate", x: "140Ce", y: "DNA", gate_type: "polygon", space: "display",
        transforms: { x: "asinh", y: "asinh" },
        vertices: [[-0.475, 4.3], [2.078, 4.509], [4.227, 5.428], [5.063, 7.973], [-0.432, 7.651]],
      },
    ],
  },
  {
    name: "Live",
    gates: [
      {
        // nPhos4 gates CD19+ and 198Pt- in one polygon; the generic form keeps the 198Pt extent
        // and spans the DNA-positive band instead of a lineage marker.
        name: "Live", x: "DNA", y: "Live", gate_type: "polygon", space: "display",
        transforms: { x: "asinh", y: "asinh" },
        vertices: [[4.2, -0.35], [6.0, -0.35], [7.9, -0.35], [7.9, 1.3], [7.4, 2.7], [6.0, 3.0], [4.6, 2.9], [4.2, 1.5]],
      },
    ],
  },
];

/** Mean of the nPhos4 planes, rounded to 0.1 arcsinh units; every polygon has 7 vertices. */
export const DEFAULT_BARCODE_TEMPLATE: BarcodeTemplate = {
  format: "gatelab-barcode-template",
  version: 1,
  units: "asinh",
  cofactor: 5,
  boundary: 1.5,
  displayRange: [-0.6, 8.5],
  states: {
    "--": [[-0.5, -0.4], [1.5, -0.4], [1.5, 0.45], [1.4, 1.05], [1.0, 1.4], [0.4, 1.55], [-0.5, 1.5]],
    "+-": [[1.8, -0.4], [6.2, -0.4], [6.2, 2.2], [3.8, 1.8], [2.7, 1.2], [2.1, 0.6], [1.8, 0.0]],
    "-+": [[-0.4, 1.8], [0.0, 1.8], [0.6, 2.1], [1.2, 2.7], [1.8, 3.8], [2.2, 6.2], [-0.4, 6.2]],
    "++": [[1.5, 2.3], [2.3, 1.5], [4.0, 2.6], [6.0, 4.5], [6.0, 5.8], [4.5, 6.0], [2.6, 4.1]],
  },
  planes: {},
  qc: DEFAULT_QC_CHAIN,
  source: "GateLab default (nPhos4 2026-08-28: its QC chain, three planes averaged)",
};

export function isBarcodeTemplate(value: unknown): value is BarcodeTemplate {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.format !== "gatelab-barcode-template" || v.version !== 1 || v.units !== "asinh") return false;
  if (typeof v.cofactor !== "number" || typeof v.boundary !== "number") return false;
  const states = v.states as Record<string, unknown> | undefined;
  if (!states || typeof states !== "object") return false;
  if (!BARCODE_STATE_KEYS.every((k) => Array.isArray(states[k]) && (states[k] as unknown[]).length >= 3)) return false;
  return v.qc === undefined || Array.isArray(v.qc);
}

/** A template read from a file may predate the QC chain; give it an empty one. */
export function normalizeBarcodeTemplate(t: BarcodeTemplate): BarcodeTemplate {
  return { ...t, planes: t.planes ?? {}, qc: t.qc ?? [] };
}

/** Vertices for a plane, in the orientation (x = `xLabel`, y = `yLabel`) the caller draws. */
export function templateShapesFor(
  template: BarcodeTemplate,
  xLabel: string,
  yLabel: string,
): Record<BarcodeStateKey, Vertex[]> {
  const direct = template.planes[`${xLabel}x${yLabel}`];
  if (direct) return direct.states;
  const reversed = template.planes[`${yLabel}x${xLabel}`];
  if (reversed) {
    const swap = (vs: Vertex[]): Vertex[] => vs.map(([x, y]) => [y, x]);
    return {
      "--": swap(reversed.states["--"]),
      "+-": swap(reversed.states["-+"]),
      "-+": swap(reversed.states["+-"]),
      "++": swap(reversed.states["++"]),
    };
  }
  return template.states;
}

function centroid(vs: Vertex[]): [number, number] {
  const n = vs.length || 1;
  return [vs.reduce((s, v) => s + v[0], 0) / n, vs.reduce((s, v) => s + v[1], 0) / n];
}

function asinhVertices(gate: PolyRectGate, cofactor: number): Vertex[] {
  const raw = gate.space !== "display";
  const f = (v: number): number => (raw ? Math.asinh(v / cofactor) : v);
  if (gate.gate_type === "rectangle" && gate.vertices.length === 2) {
    const [[x0, y0], [x1, y1]] = gate.vertices;
    return [[f(x0), f(y0)], [f(x1), f(y0)], [f(x1), f(y1)], [f(x0), f(y1)]];
  }
  return gate.vertices.map(([x, y]) => [f(x), f(y)]);
}

/** A one-barcode plane: the barcode channel drawn against an intercalator, two gates. */
export interface DisplayPlanePair {
  x: string;
  y: string;
  /** Which axis carries the barcode channel. */
  barcodeAxis: 0 | 1;
  channel: string;
  negId: string;
  posId: string;
}

/**
 * Display-only planes: channel pairs carrying exactly two polygon or rectangle gates where one
 * axis is an intercalator and the other is not already a two-barcode plane axis. The gate with
 * the lower centroid on the barcode axis is the negative one.
 */
export function findDisplayPlanes(gates: Gate[], cofactor: number, takenChannels: ReadonlySet<string>): DisplayPlanePair[] {
  const byPair = new Map<string, PolyRectGate[]>();
  for (const g of gates) {
    if (g.gate_type !== "polygon" && g.gate_type !== "rectangle") continue;
    const key = `${g.x_channel}\u0000${g.y_channel}`;
    byPair.set(key, [...(byPair.get(key) ?? []), g]);
  }
  const out: DisplayPlanePair[] = [];
  for (const [key, pair] of byPair) {
    if (pair.length !== 2) continue;
    const [x, y] = key.split("\u0000");
    const xDna = isDnaChannel(x);
    const yDna = isDnaChannel(y);
    if (xDna === yDna) continue;
    const barcodeAxis: 0 | 1 = xDna ? 1 : 0;
    const channel = barcodeAxis ? y : x;
    if (takenChannels.has(channel)) continue;
    const centroid = (g: PolyRectGate): number => {
      const vs = g.vertices.map((v) => (g.space === "display" ? v[barcodeAxis] : Math.asinh(v[barcodeAxis] / cofactor)));
      return vs.reduce((s, v) => s + v, 0) / (vs.length || 1);
    };
    const [neg, pos] = centroid(pair[0]) <= centroid(pair[1]) ? [pair[0], pair[1]] : [pair[1], pair[0]];
    out.push({ x, y, barcodeAxis, channel, negId: neg.gate_id, posId: pos.gate_id });
  }
  return out;
}

export interface LearnedBarcodePlane {
  x: string;
  y: string;
  xLabel: string;
  yLabel: string;
  /** Gate names by state, for the report. */
  gateNames: Partial<Record<BarcodeStateKey, string>>;
  /** Gate ids by state, for writing the scheme table back out. */
  gateIds: Record<BarcodeStateKey, string>;
}

export interface LearnedBarcodeTemplate {
  template: BarcodeTemplate;
  planes: LearnedBarcodePlane[];
  /** QC populations captured above the sample populations, outermost first. */
  qcNames: string[];
  notes: string[];
}

/** A stored gate as a QC template entry, in its own space. */
function qcGateFromGate(gate: PolyRectGate): QcGateTemplate {
  const kindOf = (ch: string): QcAxisTransform =>
    gate.transforms?.[ch]?.kind === "identity" ? "identity" : "asinh";
  const display = gate.space === "display";
  const vertices: Vertex[] = gate.gate_type === "rectangle" && gate.vertices.length === 2
    ? [[gate.vertices[0][0], gate.vertices[0][1]], [gate.vertices[1][0], gate.vertices[0][1]],
       [gate.vertices[1][0], gate.vertices[1][1]], [gate.vertices[0][0], gate.vertices[1][1]]]
    : gate.vertices.map(([x, y]) => [x, y]);
  return {
    name: gate.name,
    x: gate.x_channel,
    y: gate.y_channel,
    gate_type: gate.gate_type,
    space: display ? "display" : "raw",
    ...(display ? { transforms: { x: kindOf(gate.x_channel), y: kindOf(gate.y_channel) } } : {}),
    ...(gate.gate_type === "rectangle" && /^time$/i.test(gate.x_channel) ? { xFull: true } : {}),
    vertices,
  };
}

/**
 * Learn a template from a workspace.
 *
 * A barcode plane is a pair of channels carrying exactly four polygon or rectangle gates whose
 * centroids fall one in each quadrant about the mean centroid. Gates in raw space are converted
 * with the given cofactor. When the populations are given, the QC chain is the path of
 * populations from the root down to the common parent of the populations that reference the
 * plane gates, each recorded with its gates as drawn. Returns null when no plane exists.
 */
export function learnBarcodeTemplate(
  gates: Gate[],
  cofactor: number,
  source = "learned from the current workspace",
  populations?: PopulationMap,
  rootPopulationId?: string | null,
): LearnedBarcodeTemplate | null {
  const byPlane = new Map<string, PolyRectGate[]>();
  for (const g of gates) {
    if (g.gate_type !== "polygon" && g.gate_type !== "rectangle") continue;
    const key = `${g.x_channel} ${g.y_channel}`;
    byPlane.set(key, [...(byPlane.get(key) ?? []), g]);
  }
  const learned: { plane: LearnedBarcodePlane; shapes: BarcodePlaneShapes; boxSize: number; gateIds: string[] }[] = [];
  for (const [key, planeGates] of byPlane) {
    if (planeGates.length !== 4) continue;
    const [x, y] = key.split(" ");
    const verts = planeGates.map((g) => asinhVertices(g, cofactor));
    const cs = verts.map(centroid);
    const mx = cs.reduce((s, c) => s + c[0], 0) / 4;
    const my = cs.reduce((s, c) => s + c[1], 0) / 4;
    const states: Partial<Record<BarcodeStateKey, Vertex[]>> = {};
    const names: Partial<Record<BarcodeStateKey, string>> = {};
    const ids: Partial<Record<BarcodeStateKey, string>> = {};
    let ok = true;
    planeGates.forEach((g, i) => {
      const k = `${cs[i][0] > mx ? "+" : "-"}${cs[i][1] > my ? "+" : "-"}` as BarcodeStateKey;
      if (states[k]) ok = false;
      states[k] = verts[i];
      names[k] = g.name;
      ids[k] = g.gate_id;
    });
    if (!ok || BARCODE_STATE_KEYS.some((k) => !states[k])) continue;
    const box = states["--"]!;
    const boxSize = (Math.max(...box.map((v) => v[0])) - Math.min(...box.map((v) => v[0]))) *
      (Math.max(...box.map((v) => v[1])) - Math.min(...box.map((v) => v[1])));
    learned.push({
      plane: { x, y, xLabel: massLabel(x) ?? x, yLabel: massLabel(y) ?? y, gateNames: names, gateIds: ids as Record<BarcodeStateKey, string> },
      shapes: { states: states as Record<BarcodeStateKey, Vertex[]> },
      boxSize,
      gateIds: planeGates.map((g) => g.gate_id),
    });
  }
  if (!learned.length) return null;
  const sorted = [...learned].sort((a, b) => a.boxSize - b.boxSize);
  const generic = sorted[Math.floor(sorted.length / 2)].shapes.states;
  const planes: Record<string, BarcodePlaneShapes> = {};
  for (const l of learned) planes[`${l.plane.xLabel}x${l.plane.yLabel}`] = l.shapes;
  const negEnd = (vs: Vertex[], i: 0 | 1) => Math.max(...vs.map((v) => v[i]));
  const posStart = (vs: Vertex[], i: 0 | 1) => Math.min(...vs.map((v) => v[i]));
  const boundary = learned.reduce((s, l) =>
    s + (negEnd(l.shapes.states["--"], 0) + posStart(l.shapes.states["+-"], 0) +
         negEnd(l.shapes.states["--"], 1) + posStart(l.shapes.states["-+"], 1)) / 4, 0) / learned.length;

  // The QC chain: from the root down to the common parent of the sample populations, which
  // are the populations built only from plane gates, display-only planes included.
  const notes: string[] = [];
  const qc: QcPopulationTemplate[] = [];
  if (populations && rootPopulationId) {
    const taken = new Set(learned.flatMap((l) => [l.plane.x, l.plane.y]));
    const planeGateIds = new Set([
      ...learned.flatMap((l) => l.gateIds),
      ...findDisplayPlanes(gates, cofactor, taken).flatMap((d) => [d.negId, d.posId]),
    ]);
    const gateById = new Map(gates.map((g) => [g.gate_id, g]));
    const samplePops = Object.values(populations).filter(
      (p) => p.gate_refs.length > 0 && p.gate_refs.every((r) => planeGateIds.has(r.gate_id)),
    );
    const parents = new Set(samplePops.map((p) => p.parent_id));
    if (samplePops.length && parents.size === 1) {
      const chain: Population[] = [];
      let cur: Population | undefined = populations[[...parents][0] ?? ""];
      while (cur && cur.population_id !== rootPopulationId) {
        chain.unshift(cur);
        cur = cur.parent_id ? populations[cur.parent_id] : undefined;
      }
      for (const pop of chain) {
        const entry: QcPopulationTemplate = { name: pop.name, gates: [] };
        for (const ref of pop.gate_refs) {
          const g = gateById.get(ref.gate_id);
          if (!g || (g.gate_type !== "polygon" && g.gate_type !== "rectangle")) {
            notes.push(`${pop.name}: a ${g?.gate_type ?? "missing"} gate was not captured.`);
            continue;
          }
          if (!ref.include) {
            notes.push(`${pop.name}: the negated reference to ${g.name} was not captured.`);
            continue;
          }
          entry.gates.push(qcGateFromGate(g));
        }
        if (entry.gates.length) qc.push(entry);
      }
    } else if (samplePops.length) {
      notes.push("The sample populations have more than one parent, so no QC chain was captured.");
    }
  }

  return {
    template: {
      format: "gatelab-barcode-template",
      version: 1,
      units: "asinh",
      cofactor,
      boundary: Math.round(boundary * 100) / 100,
      displayRange: DEFAULT_BARCODE_TEMPLATE.displayRange,
      states: generic,
      planes,
      qc,
      source,
    },
    planes: learned.map((l) => l.plane),
    qcNames: qc.map((q) => q.name),
    notes,
  };
}
