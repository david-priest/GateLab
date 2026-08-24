// gatingmlExport.ts — export the GateLab workspace as Gating-ML 2.0 XML.
// Ported 1:1 from GateLabR inst/app/R/gatingml_export.R (export_gatingml_to_cytobank).
//
// Two formats:
//   • "cytobank": FCS $PnN dimension names, a BooleanGate per non-root population (with a
//     Cytobank definition JSON + parent GateSet ref), no <GatingHierarchy>. For Cytobank.
//   • "standard": display channel names, a <GatingHierarchy> of <PopulationGatePair>s,
//     BooleanGates only for multi-gate populations. Round-trips back into GateLab/GateLabR.
//
// Coordinate space: gates are exported in DISPLAY space. Flow gates are stored in RAW
// space → forward-transformed here; the logicle branch multiplies by (M+A)=4.5 so the
// vertices land in flowCore's [0, M] logicle space (GateLab's own Logicle is the [0,1]
// normalization), matching GateLabR and round-tripping through importGatingML (which
// divides by (M+A) before inverting). Scatter/CyTOF use the natural arcsinh value.

import { transformFromSpec, type Sample } from "./sample";
import type { Gate, PolyRectGate, PopulationMap, TransformSpec } from "./models";
import { isScatterChannel } from "./transforms";
import { polygonOutline } from "../plots/gatePayload";
import { robustAxisRange } from "./axisRange";

const SINH1 = Math.sinh(1); // sinh(log10(e)·ln10) = sinh(1)
const LOG10E = Math.log10(Math.E); // GatingML fasinh M
const LOGICLE_SPAN = 4.5; // M + A for exported logicle vertices (flowCore [0, M])

/**
 * Cofactor for flow fluorescence in the CYTOBANK format only.
 *
 * Cytobank has exactly three scale types — Linear (flag 1), Log (2) and Arcsinh (4) — and no
 * concept of logicle. Its own exports of both CyTOF and flow data confirm it: they carry
 * transforms:fasinh and transforms:flog, never transforms:logicle. Emitting logicle produced a
 * file Cytobank rejects, which went unnoticed because every earlier test of this format used
 * CyTOF data, where everything is arcsinh already and the logicle branch is never reached.
 *
 * 150 matches the cofactor GateLab already uses for flow scatter and is the usual flow default.
 * Arcsinh is an approximation of logicle, so gate boundaries shift slightly near zero; that is
 * the price of a representation Cytobank can read, and Cytobank's own documentation makes the
 * same trade.
 */
const CYTOBANK_FLOW_COFACTOR = 150;

export type GatingMLFormat = "cytobank" | "standard";

export interface GatingMLExportOpts {
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string;
  sample: Sample;
  /** Per-channel display-range overrides (the GateLab equivalent of R's rv$global_scale_ranges)
   *  → emitted as gatelabr_scales lo/hi so the Scales-tab view window round-trips. */
  globalScales?: Record<string, [number, number]>;
  format?: GatingMLFormat;
  /** Timestamp for the export_timestamp field (injectable for deterministic tests). */
  timestamp?: string;
  /** Explicit acknowledgement that quadrant gates and every dependent population branch are omitted. */
  allowQuadrantOmission?: boolean;
}

export interface GatingMLQuadrantOmissions {
  gateIds: string[];
  populationIds: string[];
}

/** Identify the full semantic branch that must be omitted with unsupported quadrant gates. */
export function analyzeGatingMLQuadrantOmissions(
  gates: Record<string, Gate>,
  populations: PopulationMap,
): GatingMLQuadrantOmissions {
  const gateIds = Object.values(gates)
    .filter((gate) => gate.gate_type === "quadrant")
    .map((gate) => gate.gate_id);
  const quadrantIds = new Set(gateIds);
  const populationIds = new Set<string>();
  const addBranch = (populationId: string): void => {
    if (populationIds.has(populationId)) return;
    populationIds.add(populationId);
    for (const childId of populations[populationId]?.children ?? []) addBranch(childId);
  };
  for (const population of Object.values(populations)) {
    if (population.gate_refs.some((ref) => quadrantIds.has(ref.gate_id))) {
      addBranch(population.population_id);
    }
  }
  return { gateIds, populationIds: [...populationIds] };
}

// ── Low-level formatting ─────────────────────────────────────────────────────
const escAttr = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Text content: & < > only (Cytobank stores raw JSON here; " must stay literal).
const escText = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Base64 of a name (UTF-8 bytes), '=' padding → '.' to match Cytobank ids. */
function b64id(name: string): string {
  const bytes = new TextEncoder().encode(String(name));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, ".");
}

/** sprintf("%.15g", x): 15 significant figures, trailing zeros trimmed. */
function fmtNum(x: number): string {
  const n = Number(x);
  if (!Number.isFinite(n)) return "0";
  if (n === 0) return "0";
  let s = n.toPrecision(15);
  if (s.indexOf("e") === -1 && s.indexOf("E") === -1 && s.indexOf(".") !== -1) {
    s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  return s;
}

const gateIdStr = (numericId: number, name: string): string => `Gate_${numericId}_${b64id(name)}`;

// ── Transform registry ───────────────────────────────────────────────────────
type TrDef =
  | { type: "fasinh"; T: number; M: number; A: number }
  | { type: "logicle"; T: number; W: number; M: number; A: number };

interface GateAxisExport {
  /** Transform id to declare on the dimension; null = no transformation-ref (raw values). */
  trId: string | null;
  /** Cofactor the vertices were actually built with, for the Cytobank definition JSON. */
  cofactor: number;
  /** Stored coordinate → the coordinate written to the file. */
  convert(v: number): number;
  /** True when `convert` bends straight edges, so a polygon must be subdivided to stay faithful. */
  needsDensify?: boolean;
  /**
   * RAW value → the coordinate written to the file. Distinct from `convert`, which starts from
   * the gate's own stored space. Needed to state the axis range Cytobank should draw, which is a
   * property of the DATA and cannot be recovered from the gate's vertices alone.
   */
  rawToExport(v: number): number;
}

interface GateExportPlan {
  axis(gateId: string, channelKey: string): GateAxisExport;
  trDefs: Map<string, TrDef>; // ordered by first appearance
}

/** Stable id fragment for a number: 150 → "150", 150.25 → "150_25". */
function idNum(x: number): string {
  return String(round(x, 4)).replace(/[.-]/g, (c) => (c === "." ? "_" : "m"));
}

/**
 * What to declare, and what to write, for every (gate, axis) pair.
 *
 * Per gate rather than per channel because a gate's coordinate space is a property of the gate:
 * two gates on the same channel can legitimately be in different spaces, and only the gate knows
 * which. Getting this from the channel is what made the exporter describe a gate GateLab does not
 * apply — measured at Jaccard 0.984–0.997 against a compliant reader on the S6 scatter gates.
 *
 * The rule is simply: declare the transform the gate's own vertices are straight in.
 *   • raw gate      → no transformation-ref, raw vertices. Exact.
 *   • display gate  → its recorded transform, vertices verbatim. Exact.
 * The only inexact case is Cytobank + logicle, which Cytobank cannot represent at all.
 */
function buildGateExportPlan(
  sample: Sample,
  gates: Record<string, Gate>,
  gateOrder: string[],
  cytobankMode: boolean,
): GateExportPlan {
  const trDefs = new Map<string, TrDef>();
  const byKey = new Map<string, GateAxisExport>();
  const isCytof = sample.instrument === "cytof";

  const fasinh = (cf: number): string => {
    const trId = isCytof ? `Tr_Arcsinh_${idNum(cf)}` : `Tr_Fasinh_${idNum(cf)}`;
    if (!trDefs.has(trId)) trDefs.set(trId, { type: "fasinh", T: cf * SINH1, M: LOG10E, A: 0 });
    return trId;
  };

  const plan = (gate: Gate, channelKey: string): GateAxisExport => {
    const space = sample.gateSpace(gate);
    const own: TransformSpec = space === "raw"
      ? { kind: "identity" }
      : (gate.transforms?.[channelKey] ?? sample.transformSpec(channelKey));

    if (own.kind === "identity") {
      // No transform to declare, and the values are already what a reader should use.
      return { trId: null, cofactor: sample.arcsinhCofactor, convert: (v) => v, rawToExport: (v) => v };
    }
    if (own.kind === "asinh") {
      // GateLab's arcsinh display coordinate IS fasinh(T = cf·sinh(1), M = log10 e, A = 0).
      const cf0 = own.cofactor;
      return {
        trId: fasinh(cf0), cofactor: cf0, convert: (v) => v,
        rawToExport: (v) => Math.asinh(v / cf0),
      };
    }
    // FlowJo's own transforms, which arrive on gates imported from a .wsp. Gating-ML has no way
    // to express either, so the gate is written in RAW space with no transformation-ref. That is
    // exact for a rectangle (a monotonic transform maps an axis-aligned box to an axis-aligned
    // box) and for a quadrant's single point; a polygon's edges are densified instead — see
    // densifyAxes below — so the boundary survives to well under a pixel.
    if (own.kind === "biex" || own.kind === "wsplog") {
      // RAW, for BOTH flavours, and measured rather than assumed.
      //
      // Re-expressing into arcsinh instead was tried on 2026-08-24 to make Cytobank's plots
      // readable, and it failed twice over. It did not help the display at all -- Cytobank takes
      // its axis from the EXPERIMENT's channel scale settings, not from a gate's scale block --
      // and it made the gate materially less faithful: uploading the same LP4 strategy, total
      // absolute disagreement with GateLab's own counts went from 180 events to 803, with the
      // log-displayed scatter chain alone going from -43 to +272.
      //
      // The reason is the densification tolerance, which is 0.2% of the gate's extent IN THE
      // TARGET SPACE. Arcsinh compresses a channel spanning 1.8e8 into about 15 units, so the
      // same relative tolerance buys a far coarser boundary in raw terms near the top of the
      // range. Raw keeps the tolerance where the data actually lives.
      //
      // Cytobank's plots are fixed in Cytobank, by setting the channel scale on the experiment.
      const inv = transformFromSpec(own).inverse;
      return {
        trId: null, cofactor: sample.arcsinhCofactor, convert: inv, needsDensify: true,
        rawToExport: (v) => v,   // written in RAW space, so raw values need no mapping
      };
    }

    // Logicle.
    if (cytobankMode) {
      // Cytobank knows Linear (1), Log (2) and Arcsinh (4) only — there is no logicle to declare,
      // so the gate is re-expressed as arcsinh of the RAW value. This is the one lossy path in
      // the exporter: the re-expressed gate is not the gate GateLab applies.
      const inv = transformFromSpec(own).inverse;
      const cf = CYTOBANK_FLOW_COFACTOR;
      return {
        trId: fasinh(cf),
        cofactor: cf,
        convert: (v) => Math.asinh(inv(v * LOGICLE_SPAN) / cf),
        rawToExport: (v) => Math.asinh(v / cf),
      };
    }
    const W = clampW(own.W);
    const trId = `Tr_Logicle_${channelKey.replace(/[^A-Za-z0-9]/g, "_")}_W${idNum(W)}`;
    if (!trDefs.has(trId)) trDefs.set(trId, { type: "logicle", T: own.T, W, M: own.M, A: own.A });
    // GateLab's logicle display spans [0, 1]; flowCore/Gating-ML logicle spans [0, M + A].
    const span = own.M + own.A;
    const fwd = transformFromSpec(own).forward;
    return {
      trId, cofactor: sample.arcsinhCofactor, convert: (v) => v * span,
      rawToExport: (v) => fwd(v) * span,
    };
  };

  for (const gid of gateOrder.length ? gateOrder : Object.keys(gates)) {
    const gate = gates[gid];
    if (!gate) continue;
    for (const ch of [gate.x_channel, gate.y_channel]) {
      const k = `${gid}|${ch}`;
      if (!byKey.has(k)) byKey.set(k, plan(gate, ch));
    }
  }

  return {
    trDefs,
    axis: (gateId, channelKey) =>
      byKey.get(`${gateId}|${channelKey}`)
        ?? { trId: null, cofactor: sample.arcsinhCofactor, convert: (v) => v, rawToExport: (v) => v },
  };
}

/**
 * Douglas-Peucker over a densified ring, per edge, keeping every ORIGINAL vertex.
 *
 * subdivideEdge bisects, so it lays points down uniformly along an edge even when the curvature
 * is concentrated in one stretch of it -- a real LP4 export carried 25 to 67 vertices per gate,
 * which is unusable to hand-edit in the receiving tool. Collapse drops the interior points a
 * straight chord already represents within `tol` (span-normalised, the same metric subdivision
 * uses). The exporter subdivides at HALF the documented tolerance and collapses at the other
 * half, so the two stages together keep the same 0.2% total bound rather than doubling it.
 * Original vertices are forced anchors: a true corner can never be simplified away.
 */
function collapseDensifiedRing(
  ring: [number, number][],
  edgeBreaks: number[],
  span: [number, number],
  tol: number,
): [number, number][] {
  const keep = new Array<boolean>(ring.length).fill(false);
  keep[0] = true;
  const dp = (i0: number, i1: number): void => {
    if (i1 - i0 < 2) return;
    const [ax, ay] = ring[i0];
    const [bx, by] = ring[i1];
    const dx = (bx - ax) / span[0];
    const dy = (by - ay) / span[1];
    const len = Math.hypot(dx, dy);
    let worst = -1;
    let worstD = tol;
    for (let i = i0 + 1; i < i1; i++) {
      const px = (ring[i][0] - ax) / span[0];
      const py = (ring[i][1] - ay) / span[1];
      // Perpendicular distance to the chord; degenerate chord falls back to point distance.
      const d = len > 0 ? Math.abs(dx * py - dy * px) / len : Math.hypot(px, py);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) {
      keep[worst] = true;
      dp(i0, worst);
      dp(worst, i1);
    }
  };
  for (let e = 0; e < edgeBreaks.length; e++) {
    // Edge e's appended points end at the next edge's break (ring end for the last edge); the
    // final appended point is the edge's endpoint, an original vertex.
    const end = (e + 1 < edgeBreaks.length ? edgeBreaks[e + 1] : ring.length) - 1;
    keep[end] = true;
    const start = edgeBreaks[e] - 1; // the previous edge's endpoint anchors this one
    dp(Math.max(0, start), end);
  }
  return ring.filter((_, i) => keep[i]);
}

const round = (x: number, d: number): number => {
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
};
const clampW = (w: number): number => Math.max(0.1, Math.min(Number.isFinite(w) ? w : 0.5, 2.0));

// ── Scale JSON (per gate dimension) ──────────────────────────────────────────
/**
 * The axis range Cytobank should draw, in the space the vertices are written in.
 *
 * This used to be four hardcoded constants -- linear got `1 … 1570900`, flow arcsinh got
 * `-2 … 12` -- chosen to look plausible and derived from nothing. They routinely excluded the
 * gate's OWN vertices: 17 of LP4's axis/gate combinations had vertices outside the range the same
 * file declared, the worst by a factor of 100 (a raw vertex at 1.5e8 against a declared max of
 * 1.57e6). Cytobank draws the axis from this block and recomputes membership from the vertices,
 * so a gate outside its own axis imports invisible, which is exactly the failure that stalled the
 * Cytobank arm.
 *
 * Derived instead: the channel's own robust data range mapped into the export space, unioned with
 * the gate's exported vertices so the gate is always inside, then padded. Cytobank's own exports
 * use the full instrument range (`1 … 262144` on a 2^18 instrument) for every gate on a channel;
 * the union keeps that per-channel consistency wherever two gates share a space, while still
 * guaranteeing containment for a gate drawn outside the bulk of the data.
 */
function scaleJson(
  trId: string | null | undefined, isFlow: boolean, cofactor: number,
  range: [number, number],
): string {
  let flag: number, arg: string;
  if (trId == null) {
    flag = 1; arg = "1";
  } else if (trId.startsWith("Tr_Logicle_")) {
    // Only reachable in the standard format, which Cytobank never reads. Cytobank knows
    // Linear (1), Log (2) and Arcsinh (4) only; flag 5 is not one of its scale types.
    flag = 5; arg = "4.5";
  } else {
    flag = 4; arg = String(cofactor);
  }
  void isFlow;   // the range no longer depends on instrument class; it comes from the data
  const [mn, mx] = range;
  return `{"flag":${flag},"argument":"${arg}","min":${fmtNum(mn)},"max":${fmtNum(mx)},"bins":256,"size":256}`;
}

/** Union of a data range and the gate's own extent, padded so the gate is strictly inside. */
function axisScaleRange(
  dataRange: [number, number] | null, vertLo: number, vertHi: number,
): [number, number] {
  let lo = vertLo, hi = vertHi;
  if (dataRange && Number.isFinite(dataRange[0]) && Number.isFinite(dataRange[1])) {
    lo = Math.min(lo, dataRange[0]);
    hi = Math.max(hi, dataRange[1]);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  const span = hi - lo;
  const pad = (span > 0 ? span : Math.abs(hi) || 1) * 0.02;
  return [lo - pad, hi + pad];
}

/** Cytobank definition JSON — vertices already in export (display) space. */
function definitionJson(
  gate: PolyRectGate,
  xTr: string | null | undefined,
  yTr: string | null | undefined,
  isFlow: boolean,
  xCofactor: number,
  yCofactor: number,
  xRange: [number, number],
  yRange: [number, number],
): string {
  const xs = gate.vertices.map((v) => v[0]);
  const ys = gate.vertices.map((v) => v[1]);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const cx = mean(xs);
  const cy = mean(ys);
  const sx = scaleJson(xTr, isFlow, xCofactor, xRange);
  const sy = scaleJson(yTr, isFlow, yCofactor, yRange);
  const header = `"scale":{"x":${sx},"y":${sy}},"positive":false,"negative":false,"locked":false,"label":[${fmtNum(cx)},${fmtNum(cy)}]`;
  let geom: string;
  if (gate.gate_type === "rectangle") {
    geom = `"rectangle":{"x1":${fmtNum(Math.min(...xs))},"y1":${fmtNum(Math.min(...ys))},"x2":${fmtNum(Math.max(...xs))},"y2":${fmtNum(Math.max(...ys))}}`;
  } else {
    const vstr = gate.vertices.map((v) => `[${fmtNum(v[0])},${fmtNum(v[1])}]`).join(",");
    geom = `"polygon":{"vertices":[${vstr}]}`;
  }
  return `{${header},${geom}}`;
}

// ── XML fragments ────────────────────────────────────────────────────────────
function customInfo(
  name: string, numericId: number, gateSeq: number, typeStr: string, defJson: string,
  compensationId: number,
): string[] {
  return [
    "    <data-type:custom_info>",
    "      <cytobank>",
    `        <name>${escAttr(name)}</name>`,
    `        <id>${numericId}</id>`,
    `        <gate_id>${gateSeq}</gate_id>`,
    `        <type>${typeStr}</type>`,
    "        <version>-1</version>",
    // Cytobank's semantics, read off its own exports: -2 = uncompensated, 0 = the file's
    // internal matrix, a positive id = a named Cytobank compensation. Every gate used to say -2
    // even when its dimensions declared compensation-ref="FCS".
    `        <compensation_id>${compensationId}</compensation_id>`,
    "        <fcs_file_id />",
    "        <tailored>false</tailored>",
    "        <tailored_per_population>false</tailored_per_population>",
    "        <tailored_per_population_gateset_id />",
    "        <fcs_file_filename />",
    "        <gating_group_id>-1</gating_group_id>",
    "        <gating_group_name>Default group</gating_group_name>",
    "        <file_sync_mode>0</file_sync_mode>",
    "        <pop_sync_mode>0</pop_sync_mode>",
    `        <definition>${escText(defJson)}</definition>`,
    "      </cytobank>",
    "    </data-type:custom_info>",
  ];
}

function dimXml(
  dimName: string,
  trId: string | null | undefined,
  compensationRef: "FCS" | "uncompensated",
  minVal?: number,
  maxVal?: number,
): string[] {
  const tr = trId != null ? ` gating:transformation-ref="${trId}"` : "";
  const mn = minVal !== undefined ? ` gating:min="${fmtNum(minVal)}"` : "";
  const mx = maxVal !== undefined ? ` gating:max="${fmtNum(maxVal)}"` : "";
  return [
    `    <gating:dimension gating:compensation-ref="${compensationRef}"${mn}${mx}${tr}>`,
    `      <data-type:fcs-dimension data-type:name="${escAttr(dimName)}" />`,
    "    </gating:dimension>",
  ];
}

function rectangleXml(
  gate: PolyRectGate, gmlId: string, numId: number, seq: number,
  xTr: string | null | undefined, yTr: string | null | undefined,
  isFlow: boolean, xCofactor: number, yCofactor: number, xName: string, yName: string,
  xCompRef: "FCS" | "uncompensated", yCompRef: "FCS" | "uncompensated",
  xRange: [number, number], yRange: [number, number],
  compensationId: number,
): string[] {
  const xs = gate.vertices.map((v) => v[0]);
  const ys = gate.vertices.map((v) => v[1]);
  const def = definitionJson(gate, xTr, yTr, isFlow, xCofactor, yCofactor, xRange, yRange);
  return [
    `  <gating:RectangleGate gating:id="${gmlId}">`,
    ...customInfo(gate.name, numId, seq, "RectangleGate", def, compensationId),
    ...dimXml(xName, xTr, xCompRef, Math.min(...xs), Math.max(...xs)),
    ...dimXml(yName, yTr, yCompRef, Math.min(...ys), Math.max(...ys)),
    "  </gating:RectangleGate>",
  ];
}

function polygonXml(
  gate: PolyRectGate, gmlId: string, numId: number, seq: number,
  xTr: string | null | undefined, yTr: string | null | undefined,
  isFlow: boolean, xCofactor: number, yCofactor: number, xName: string, yName: string,
  xCompRef: "FCS" | "uncompensated", yCompRef: "FCS" | "uncompensated",
  xRange: [number, number], yRange: [number, number],
  compensationId: number,
): string[] {
  const def = definitionJson(gate, xTr, yTr, isFlow, xCofactor, yCofactor, xRange, yRange);
  const vertLines = gate.vertices.flatMap((v) => [
    "    <gating:vertex>",
    `      <gating:coordinate data-type:value="${fmtNum(v[0])}" />`,
    `      <gating:coordinate data-type:value="${fmtNum(v[1])}" />`,
    "    </gating:vertex>",
  ]);
  return [
    `  <gating:PolygonGate gating:id="${gmlId}">`,
    ...customInfo(gate.name, numId, seq, "PolygonGate", def, compensationId),
    ...dimXml(xName, xTr, xCompRef),
    ...dimXml(yName, yTr, yCompRef),
    ...vertLines,
    "  </gating:PolygonGate>",
  ];
}

function transformXml(trId: string, tr: TrDef): string[] {
  const body =
    tr.type === "fasinh"
      ? `    <transforms:fasinh transforms:T="${fmtNum(tr.T)}" transforms:M="${fmtNum(tr.M)}" transforms:A="${fmtNum(tr.A)}" />`
      : `    <transforms:logicle transforms:T="${fmtNum(tr.T)}" transforms:W="${fmtNum(tr.W)}" transforms:M="${fmtNum(tr.M)}" transforms:A="${fmtNum(tr.A)}" />`;
  return [`  <transforms:transformation transforms:id="${trId}">`, body, "  </transforms:transformation>"];
}

/** gatelabr_scales JSON — per-channel transforms + axis windows. Version 3 adds raw_lo/raw_hi in
 *  compensated linear space, because GateLab's normalized logicle display is not numerically the
 *  same as GateLabR/flowCore's display scale. Legacy lo/hi remain for older readers. */
function buildScalesJson(sample: Sample, globalScales: Record<string, [number, number]> = {}): string {
  type ScaleEntry = {
    w?: number;
    cofactor?: number;
    lo?: number;
    hi?: number;
    raw_lo?: number;
    raw_hi?: number;
  };
  const channels: Record<string, ScaleEntry> = {};
  sample.channels.forEach((c, idx) => {
    const kind = sample.transformKind(idx);
    const entry: ScaleEntry = {};
    if (kind === "logicle") {
      entry.w = round(clampW(sample.currentLogicleW(idx)), 6);
    } else if (kind === "asinh" && sample.instrument === "flow") {
      // Any arcsinh flow axis, scatter or fluorescence. Keying this on isScatterChannel() left a
      // fluorescence channel shown with arcsinh carrying neither a W nor a cofactor, so a reader
      // could not reproduce the axis it was drawn on.
      entry.cofactor = round(
        isScatterChannel(c.key) ? sample.currentScatterCofactor(idx) : sample.currentFluorCofactor(idx),
        6,
      );
    }
    const gs = globalScales[c.key];
    if (gs && Number.isFinite(gs[0]) && Number.isFinite(gs[1]) && gs[1] > gs[0]) {
      entry.lo = round(gs[0], 6);
      entry.hi = round(gs[1], 6);
      const rawLo = sample.displayToRaw(c.key, gs[0]);
      const rawHi = sample.displayToRaw(c.key, gs[1]);
      if (Number.isFinite(rawLo) && Number.isFinite(rawHi) && rawHi > rawLo) {
        entry.raw_lo = round(rawLo, 9);
        entry.raw_hi = round(rawHi, 9);
      }
    }
    if (Object.keys(entry).length) channels[c.key] = entry;
  });
  const compensationEnabled = sample.instrument === "flow" && sample.embeddedCompensationEnabled;
  const spillover = compensationEnabled ? sample.spillover : null;
  return JSON.stringify({
    version: 3,
    ...(sample.instrument === "cytof" ? { cytof_cofactor: sample.arcsinhCofactor } : {}),
    channels,
    compensation: {
      enabled: compensationEnabled,
      reference: compensationEnabled ? "FCS" : "uncompensated",
      channels: spillover?.channels ?? [],
      ...(spillover ? { matrix: spillover.matrix } : {}),
    },
  });
}

// ── Main export ──────────────────────────────────────────────────────────────
export function exportGatingML(opts: GatingMLExportOpts): string {
  const { gates, gate_order, populations, root_population_id, sample } = opts;
  const format = opts.format ?? "cytobank";
  const cytobankMode = format === "cytobank";
  if (!gates || Object.keys(gates).length === 0) throw new Error("No gates to export.");
  if (sample.compensationEnabled && !sample.embeddedCompensationEnabled) {
    throw new Error(
      "Gating-ML export for an uploaded or edited compensation profile is not available yet; " +
      "switch to Original or use the embedded FCS spillover layer.",
    );
  }

  const quadrantOmissions = analyzeGatingMLQuadrantOmissions(gates, populations);
  if (quadrantOmissions.gateIds.length > 0 && !opts.allowQuadrantOmission) {
    throw new Error(
      `This workspace contains ${quadrantOmissions.gateIds.length} unsupported quadrant gate(s) and ` +
      `${quadrantOmissions.populationIds.length} dependent population(s). ` +
      "Export again only after explicitly accepting their omission; the .gatelab workspace preserves them in full.",
    );
  }

  const isFlow = sample.instrument === "flow";

  // display channel name → dimension name (Cytobank uses $PnN, standard uses the display key).
  const pnnFor = (key: string): string => {
    if (!cytobankMode) return key;
    const idx = sample.index(key);
    const pnn = idx !== undefined ? sample.channels[idx].pnn : undefined;
    return pnn && pnn.length ? pnn : key;
  };

  const exportPlan = buildGateExportPlan(sample, gates, gate_order, cytobankMode);
  const trDefs = exportPlan.trDefs;
  const scalesJson = buildScalesJson(sample, opts.globalScales);
  const compensationRefFor = (channelKey: string): "FCS" | "uncompensated" =>
    isFlow && sample.embeddedCompensationEnabled && sample.spillover?.channels.includes(channelKey)
      ? "FCS"
      : "uncompensated";
  // Each gate's vertices are written in the space that gate declares, so the file describes the
  // gate GateLab actually applies rather than a transformed lookalike.
  const displayGate = (g: PolyRectGate): PolyRectGate => {
    const ax = exportPlan.axis(g.gate_id, g.x_channel);
    const ay = exportPlan.axis(g.gate_id, g.y_channel);
    const toOut = (vv: [number, number]): [number, number] => [ax.convert(vv[0]), ay.convert(vv[1])];
    const vertices = g.vertices.map(toOut);

    // Writing a gate into a space its edges are not straight in turns each edge into a curve, and
    // a straight segment between the transformed endpoints is no longer the same boundary. Only
    // polygons are affected: a rectangle stays an axis-aligned box under any monotonic transform.
    if ((ax.needsDensify || ay.needsDensify) && g.gate_type === "polygon") {
      const detail: { span?: [number, number]; edgeBreaks?: number[] } = {};
      // Half the 0.2% documented tolerance on subdivision, half on collapse: same total bound,
      // far fewer vertices. See collapseDensifiedRing.
      const dense = polygonOutline(g.vertices, toOut, vertices, { tol: 0.001, detail });
      if (dense && detail.span && detail.edgeBreaks) {
        return { ...g, vertices: collapseDensifiedRing(dense, detail.edgeBreaks, detail.span, 0.001) };
      }
      if (dense) return { ...g, vertices: dense };
    }
    return { ...g, vertices };
  };

  // Assign numeric ids / seq to non-quadrant gates (quadrant gates have no GatingML rep).
  const gateToGmlId = new Map<string, string>();
  const gateNumericId = new Map<string, number>();
  const gateSeq = new Map<string, number>();
  gate_order.forEach((gid, i) => {
    const g = gates[gid];
    if (!g) return;
    if (g.gate_type === "quadrant") {
      return;
    }
    const numId = 180000000 + (i + 1);
    gateNumericId.set(gid, numId);
    gateToGmlId.set(gid, gateIdStr(numId, g.name));
    gateSeq.set(gid, i + 1);
  });

  // The data range each channel occupies in the space its gates are written in, memoised by
  // (channel, transform) because a workspace can hold gates on one channel in different spaces.
  // Cheap: robustAxisRange samples rather than sorting the whole column.
  const dataRangeCache = new Map<string, [number, number] | null>();
  const dataRangeFor = (channelKey: string, ax: GateAxisExport): [number, number] | null => {
    const key = `${channelKey}|${ax.trId ?? "raw"}`;
    const hit = dataRangeCache.get(key);
    if (hit !== undefined) return hit;
    let out: [number, number] | null = null;
    const idx = sample.channels.findIndex((c) => c.key === channelKey);
    if (idx >= 0) {
      const raw = sample.rawColumnData(idx);
      const n = raw.length;
      if (n > 0) {
        // Sample rather than map the whole column: a range only needs a representative subset,
        // and an export must not walk millions of events per channel.
        const step = Math.max(1, Math.floor(n / 20000));
        const buf = new Float64Array(Math.ceil(n / step));
        let k = 0;
        for (let j = 0; j < n; j += step) buf[k++] = ax.rawToExport(raw[j]);
        out = robustAxisRange(buf.subarray(0, k));
      }
    }
    dataRangeCache.set(key, out);
    return out;
  };

  // ── The compensation matrix, as Cytobank's own exports carry it ─────────────────────────
  //
  // The export used to write compensation-ref="FCS" and no matrix, leaving the receiving tool
  // to find one itself. When the gates were computed under a matrix that is NOT in the FCS —
  // S6: FlowJo gated with the workspace's hand-adjusted DivaCompMtx while the FCS carries the
  // acquisition matrix, 48 of 49 coefficients different — the receiver silently compensates
  // with the wrong one. Measured on Cytobank: the 3 uncompensated scatter gates matched GateLab
  // exactly while all 15 compensated gates drifted, 1,437 events in total. Emitting the ACTIVE
  // matrix makes the file self-contained; Cytobank parses these blocks from its own exports
  // ("We have parsed out a spectrum matrix"). Cytobank flavour only: the standard flavour must
  // stay free of transforms: elements, which is what proves its vertices are raw.
  const EXPORTED_MATRIX_ID = 1;
  const exportCompensationOn = sample.instrument === "flow" && sample.embeddedCompensationEnabled;
  const exportSpillover = exportCompensationOn ? sample.spillover : null;
  const spectrumLines: string[] = [];
  if (cytobankMode && exportSpillover) {
    const detectors = exportSpillover.channels.map((c: string) => pnnFor(c));
    const matrixName = sample.spilloverOrigin.kind === "external"
      ? sample.spilloverOrigin.label
      : "FCS $SPILLOVER";
    spectrumLines.push(
      `  <transforms:spectrumMatrix transforms:id="Spill_${EXPORTED_MATRIX_ID}">`,
      "    <data-type:custom_info>",
      "      <cytobank>",
      `        <cytobank_compensation_id>${EXPORTED_MATRIX_ID}</cytobank_compensation_id>`,
      `        <cytobank_compensation_name>${escAttr(matrixName)}</cytobank_compensation_name>`,
      "      </cytobank>",
      "    </data-type:custom_info>",
      "    <transforms:fluorochromes>",
      ...detectors.map((d: string) => `      <data-type:fcs-dimension data-type:name="Comp_${escAttr(d)}" />`),
      "    </transforms:fluorochromes>",
      "    <transforms:detectors>",
      ...detectors.map((d: string) => `      <data-type:fcs-dimension data-type:name="${escAttr(d)}" />`),
      "    </transforms:detectors>",
      ...exportSpillover.matrix.flatMap((row: number[]) => [
        "    <transforms:spectrum>",
        ...row.map((v: number) => `      <transforms:coefficient transforms:value="${fmtNum(v)}" />`),
        "    </transforms:spectrum>",
      ]),
      "  </transforms:spectrumMatrix>",
    );
  }

  // Gate elements.
  const gateLines: string[] = [];
  gate_order.forEach((gid, i) => {
    const g = gates[gid];
    if (!g || g.gate_type === "quadrant") return;
    const dg = displayGate(g as PolyRectGate);
    const gmlId = gateToGmlId.get(gid)!;
    const numId = gateNumericId.get(gid)!;
    const xAxis = exportPlan.axis(gid, g.x_channel);
    const yAxis = exportPlan.axis(gid, g.y_channel);
    const xTr = xAxis.trId;
    const yTr = yAxis.trId;
    const xName = pnnFor(g.x_channel);
    const yName = pnnFor(g.y_channel);
    const xCompRef = compensationRefFor(g.x_channel);
    const yCompRef = compensationRefFor(g.y_channel);
    const xCofactor = xAxis.cofactor;
    const yCofactor = yAxis.cofactor;
    // Derived from the exported geometry, so it holds for a densified polygon too.
    const exs = dg.vertices.map((v) => v[0]);
    const eys = dg.vertices.map((v) => v[1]);
    const xRange = axisScaleRange(dataRangeFor(g.x_channel, xAxis), Math.min(...exs), Math.max(...exs));
    const yRange = axisScaleRange(dataRangeFor(g.y_channel, yAxis), Math.min(...eys), Math.max(...eys));
    // Cytobank's ids, read off its own exports: -2 = uncompensated, 0 = the file's internal
    // matrix, positive = a named compensation. A compensated gate points at the matrix this file
    // DECLARES below when the active matrix is not the FCS's own (the S6 case: gates drawn under
    // the workspace's hand-adjusted matrix, which the FCS does not carry); at the file-internal
    // one (0) when it is. compensation-ref stays "FCS"/"uncompensated" — Cytobank's own exports
    // never reference a matrix from a dimension, and GateLab's importer refuses anything else.
    const compensated = xCompRef === "FCS" || yCompRef === "FCS";
    const compId = !compensated ? -2
      : !cytobankMode ? -2
      : sample.spilloverOrigin.kind === "fcs" ? 0
      : EXPORTED_MATRIX_ID;
    if (g.gate_type === "rectangle") {
      gateLines.push(...rectangleXml(
        dg, gmlId, numId, i + 1, xTr, yTr, isFlow, xCofactor, yCofactor,
        xName, yName, xCompRef, yCompRef, xRange, yRange, compId,
      ));
    } else {
      gateLines.push(...polygonXml(
        dg, gmlId, numId, i + 1, xTr, yTr, isFlow, xCofactor, yCofactor,
        xName, yName, xCompRef, yCompRef, xRange, yRange, compId,
      ));
    }
  });

  // Populations pass 1: assign GateSet ids to every non-root population with a valid gate ref.
  const popBoolNum = new Map<string, number>();
  const popBoolGmlId = new Map<string, string>();
  const popToGml = new Map<string, string>(); // for the standard-mode hierarchy
  let nextBoolId = 36000000;
  const omittedPopulationIds = new Set(quadrantOmissions.populationIds);
  const popIds = Object.keys(populations).filter((pid) => !omittedPopulationIds.has(pid));
  for (const pid of popIds) {
    if (pid === root_population_id) continue;
    const pop = populations[pid];
    const valid = (pop.gate_refs ?? []).filter((r) => gateToGmlId.has(r.gate_id));
    if (valid.length === 0) continue;
    const boolNum = nextBoolId++;
    popBoolNum.set(pid, boolNum);
    popBoolGmlId.set(pid, `GateSet_${boolNum}`);
    popToGml.set(pid, `GateSet_${boolNum}`);
  }

  // Populations pass 2: BooleanGates (+ Cytobank definition JSON / parent refs).
  const boolLines: string[] = [];
  for (const pid of popIds) {
    if (pid === root_population_id) continue;
    const pop = populations[pid];
    const valid = (pop.gate_refs ?? []).filter((r) => gateToGmlId.has(r.gate_id));
    if (valid.length === 0) continue;

    const boolNum = popBoolNum.get(pid)!;
    const boolGmlId = popBoolGmlId.get(pid)!;

    // Nearest non-root ancestor that itself has a GateSet. Used by the standard format's
    // hierarchy; the Cytobank format flattens the ancestry instead (see below).
    let parentBoolGmlId: string | null = null;
    let walk: string | null = pop.parent_id;
    while (walk && walk !== root_population_id) {
      if (popBoolGmlId.has(walk)) {
        parentBoolGmlId = popBoolGmlId.get(walk)!;
        break;
      }
      walk = populations[walk]?.parent_id ?? null;
    }

    if (cytobankMode) {
      const operation = pop.gate_logic === "or" && valid.length > 1 ? "or" : "and";
      if (operation === "or" && parentBoolGmlId) {
        throw new Error(
          `The Cytobank-compatible format cannot safely represent the nested OR population ` +
            `"${pop.name}". Export the standard GateLab/GateLabR format instead.`,
        );
      }
      // Cytobank has no concept of one population referencing another: every GateSet is the
      // AND of its WHOLE ancestor chain of primitive gates. Referencing a GateSet is legal
      // Gating-ML, and GateLab reads its own files back that way, but Cytobank's importer has
      // no such construct and rejects the file with no explanation. Its own exports never
      // reference a GateSet — not once — so the ancestry is flattened here instead.
      const chain: typeof valid = [];
      const seenGateIds = new Set<string>();
      const pushRef = (gr: (typeof valid)[number]) => {
        if (seenGateIds.has(gr.gate_id)) return;
        seenGateIds.add(gr.gate_id);
        chain.push(gr);
      };
      const ancestry: string[] = [];
      for (let w: string | null = pop.parent_id; w && w !== root_population_id;
           w = populations[w]?.parent_id ?? null) {
        ancestry.unshift(w);
      }
      for (const aid of ancestry) {
        for (const gr of (populations[aid]?.gate_refs ?? [])) {
          if (gateToGmlId.has(gr.gate_id)) pushRef(gr);
        }
      }
      for (const gr of valid) pushRef(gr);

      let refLines = chain.map((gr) => {
        const comp = gr.include ? "" : ' gating:complement="true"';
        return `      <gating:gateReference gating:ref="${gateToGmlId.get(gr.gate_id)}"${comp} />`;
      });
      // GatingML Boolean operations need ≥2 refs — pad single-ref lists.
      if (refLines.length === 1) {
        refLines = [
          refLines[0],
          `      <!-- Single-gate population: ref twice (GatingML requires ≥2 args for "${operation}") -->`,
          refLines[0],
        ];
      }

      const allSeq = chain.map((gr) => gateSeq.get(gr.gate_id)!);
      const negSeq = chain.filter((gr) => !gr.include).map((gr) => gateSeq.get(gr.gate_id)!);
      const boolExpr = chain
        .map((gr) => (gr.include ? `gate_${gateSeq.get(gr.gate_id)!}` : `NOT gate_${gateSeq.get(gr.gate_id)!}`))
        .join(operation === "or" ? " OR " : " AND ");
      const boolDefJson = `{"gates":[${allSeq.join(",")}],"negGates":[${negSeq.join(",")}],"tailoredPerPopulation":{},"booleanExpression":"${boolExpr}"}`;

      boolLines.push(
        `  <gating:BooleanGate gating:id="${boolGmlId}">`,
        "    <data-type:custom_info>",
        "      <cytobank>",
        `        <name>${escAttr(pop.name)}</name>`,
        `        <id>${boolNum}</id>`,
        `        <gate_set_id>${boolNum - 36000000 + 1}</gate_set_id>`,
        "        <version>-1</version>",
        "        <tailored>false</tailored>",
        "        <tailored_per_population>false</tailored_per_population>",
        "        <compensation_id>0</compensation_id>",
        "        <gating_group_id>-1</gating_group_id>",
        "        <gating_group_name>Default group</gating_group_name>",
        `        <definition>${escText(boolDefJson)}</definition>`,
        "      </cytobank>",
        "    </data-type:custom_info>",
        `    <gating:${operation}>`,
        ...refLines,
        `    </gating:${operation}>`,
        "  </gating:BooleanGate>",
      );
    } else if (valid.length > 1) {
      // Standard: BooleanGate only for multi-gate populations.
      const operation = pop.gate_logic === "or" ? "or" : "and";
      const refLines = valid.map((gr) => {
        const comp = gr.include ? "" : ' gating:complement="true"';
        return `      <gating:gateReference gating:ref="${gateToGmlId.get(gr.gate_id)}"${comp} />`;
      });
      boolLines.push(
        `  <gating:BooleanGate gating:id="${boolGmlId}">`,
        "    <data-type:custom_info>",
        "      <cytobank>",
        `        <name>${escAttr(pop.name)}</name>`,
        `        <id>${boolNum}</id>`,
        "        <version>-1</version>",
        "      </cytobank>",
        "    </data-type:custom_info>",
        `    <gating:${operation}>`,
        ...refLines,
        `    </gating:${operation}>`,
        "  </gating:BooleanGate>",
      );
    } else {
      // Standard single-gate: point the hierarchy straight at the gate element.
      const gr = valid[0];
      popToGml.set(pid, gateToGmlId.get(gr.gate_id)! + (gr.include ? "" : "|complement"));
    }
  }

  // GatingHierarchy (standard mode only).
  const hierLines: string[] = [];
  if (!cytobankMode) {
    const buildPair = (pid: string, indent: string): string[] => {
      const refRaw = popToGml.get(pid);
      if (!refRaw) return [];
      const pop = populations[pid];
      const comp = refRaw.endsWith("|complement") ? ' gating:complement="true"' : "";
      const gref = refRaw.replace(/\|complement$/, "");
      const out = [
        `${indent}<gating:PopulationGatePair gating:gate-ref="${gref}"${comp}>`,
        `${indent}  <gating:name>${escAttr(pop.name)}</gating:name>`,
      ];
      for (const childId of pop.children ?? []) out.push(...buildPair(childId, indent + "  "));
      out.push(`${indent}</gating:PopulationGatePair>`);
      return out;
    };
    const rootPop = populations[root_population_id];
    for (const childId of rootPop?.children ?? []) hierLines.push(...buildPair(childId, "    "));
  }

  // Assemble.
  const schemaLoc = [
    "http://www.isac-net.org/std/Gating-ML/v2.0/gating",
    "http://flowcyt.sourceforge.net/gating/2.0/xsd/Gating-ML.v2.0.xsd",
    "http://www.isac-net.org/std/Gating-ML/v2.0/transformations",
    "http://flowcyt.sourceforge.net/gating/2.0/xsd/Transformations.v2.0.xsd",
    "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes",
    "http://flowcyt.sourceforge.net/gating/2.0/xsd/DataTypes.v2.0.xsd",
  ].join(" ");
  const aboutStr = cytobankMode
    ? "Gating-ML 2.0 export from GateLab (Cytobank-compatible)"
    : "Gating-ML 2.0 export from GateLab (standard / re-importable)";
  const timestamp = opts.timestamp ?? new Date().toISOString().slice(0, 19);

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gating:Gating-ML' +
      ' xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ' xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations"' +
      ' xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"' +
      ` xsi:schemaLocation="${schemaLoc}">`,
    "  <data-type:custom_info>",
    "    <cytobank>",
    `      <about>${escAttr(aboutStr)}</about>`,
    // Cytobank states the gating version in its own exports and we did not. The remaining fields
    // it writes -- experiment_number, experiment_title, experiment_url -- identify a specific
    // Cytobank experiment and are deliberately NOT invented here: the file is imported into an
    // experiment the user already has open, and a fabricated number could name someone else's.
    ...(cytobankMode ? ["      <cytobank_gating_version>2.0</cytobank_gating_version>"] : []),
    `      <export_timestamp>${timestamp}</export_timestamp>`,
    "    </cytobank>",
    "    <gatelabr_scales>",
    `      <definition>${escText(scalesJson)}</definition>`,
    "    </gatelabr_scales>",
    "  </data-type:custom_info>",
    ...[...trDefs.entries()].flatMap(([id, tr]) => transformXml(id, tr)),
    ...spectrumLines,
    ...gateLines,
    ...boolLines,
    ...(hierLines.length ? ["  <gating:GatingHierarchy>", ...hierLines, "  </gating:GatingHierarchy>"] : []),
    "</gating:Gating-ML>",
  ];
  return lines.join("\n") + "\n";
}
