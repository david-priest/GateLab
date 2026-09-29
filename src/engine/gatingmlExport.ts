// gatingmlExport.ts — export the GateLab workspace as Gating-ML 2.0 XML.
// Ported 1:1 from GateLabR inst/app/R/gatingml_export.R (export_gatingml_to_cytobank).
//
// Two formats, both valid against the ISAC Gating-ML 2.0 schema and both naming dimensions by
// the FCS $PnN (or, for a dimension compensated by a matrix the file defines, by that matrix's
// fluorochrome name):
//   • "cytobank": a BooleanGate per non-root population that ANDs its whole ancestor chain of
//     gates, with a Cytobank definition JSON, and no parent_id: Cytobank reads nothing else. The
//     tree rides in the root custom_info for GateLab (GATELAB_FORMAT_TAG).
//   • "standard": a BooleanGate per non-root population, placed in the tree by gating:parent_id,
//     as Gating-ML 2.0 defines it. GateLab-only detail rides in data-type:custom_info. Round-trips
//     back into GateLab.
//
// Coordinate space: each gate is written in the space it is stored in, with that space's
// transform declared (see buildGateExportPlan). Logicle is on Gating-ML 2.0's own scale, T at 1,
// which is also GateLab's. Scatter/CyTOF use the natural arcsinh value.

import { generateBiexLut } from "./biex";
import { transformFromSpec, type Sample } from "./sample";
import { otherRectangleRule, rangeForReader } from "./gates";
import { rectangleRule } from "./models";
import {
  GATINGML_EDGE_RULE_TAG, GATINGML_RECTANGLES_TAG, rectangleRecordOf, writtenRectangleBounds, type RectangleRecord,
} from "./rectangleRecord";
import { fcsTimestep, gatingMLFasinh, isTimeParameter } from "./gatingml";
import { axesFromCovariance, ellipseBoundary, ellipseQuadraticForm } from "./ellipse";
import { gateMaskEllipse, gateMaskPolygon, getGateMask, polygonTestScale } from "./gates";
import { UNBOUNDED, isUnbounded, type EllipseGate, type Gate, type PolyRectGate, type PopulationMap, type TransformSpec } from "./models";
import { isScatterChannel } from "./transforms";
import { robustAxisRange } from "./axisRange";
import { WSP_FLOWJO_AXES_TAG, WSP_FLOWJO_POLYGON_TAG } from "./flowjoWorkspace";
import {
  GATINGML_GRID_TAG, RING_OUTER, RING_OUTER_FLOAT64, fingerprintRing, flowJoGridCells, flowJoGridEdges, flowJoGridRing, flowJoGridScale,
  type GridEdgeValues,
  type FlowJoGridMark, type FlowJoGridSpec,
} from "./flowjoGrid";
import { gatingMlGains } from "./gatingmlGain";

const SINH1 = Math.sinh(1); // sinh(log10(e)·ln10) = sinh(1)
const LOG10E = Math.log10(Math.E); // GatingML fasinh M

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

/**
 * Root custom_info element that says how a GateLab file is to be read where Gating-ML alone
 * leaves room. Both formats write it:
 *   • `logicle: "gating-ml"`: logicle coordinates are on the standard's own scale, T at 1. Files
 *     written before the mark existed used flowCore's, where T is at M (see gatingml.ts
 *     parseGatelabFormat for how those are recognised).
 *   • standard format, `hierarchy: "parent_id"`: every BooleanGate not marked
 *     GATELAB_OPERAND_TAG is a population, placed by its gating:parent_id.
 *   • Cytobank format, `hierarchy: "tree"`: every population's BooleanGate ANDs its whole ancestor
 *     chain, because Cytobank cannot reference one population from another, so the file alone does
 *     not say which population is whose parent. `tree` lists each population's BooleanGate id with
 *     its parent's (null at the root), parents before children and siblings in GateLab's order.
 *     It sits in the ROOT custom_info because that is the one place Cytobank has accepted
 *     GateLab-only content (gatelabr_scales has always been there).
 */
export const GATELAB_FORMAT_TAG = "gatelab_format";
/**
 * Version 3 adds `time`, the unit a Time dimension is written in: "seconds" (ticks times
 * $TIMESTEP) in the standard format, "ticks" (as stored) in the Cytobank format. It also says that
 * the file's flog is Gating-ML's own, undefined at or below zero; version 2 files were written for
 * GateLab's older flog, which pins everything below T·10^−M at 0, and are read that way.
 * `gain`: the standard format's coordinates are Gating-ML scale values, stored value / $PnG
 * (gatingmlGain.ts); the Cytobank format keeps stored values and does not say so.
 */
const STANDARD_FORMAT = { version: 3, logicle: "gating-ml", hierarchy: "parent_id", time: "seconds", gain: "gating-ml" } as const;

/**
 * custom_info element marking a BooleanGate the standard format writes as an operand only (the
 * NOT of one gate), so the importer does not take it for a population. With
 * `hierarchy: "parent_id"`, every other BooleanGate is a population.
 */
export const GATELAB_OPERAND_TAG = "gatelab_operand";

/**
 * Words the standard format's about text carries, saying its logicle coordinates are on Gating-ML
 * 2.0's own scale (T at 1). The text lives in Cytobank's custom_info, which a rewriter that drops
 * GATELAB_FORMAT_TAG and gatelabr_scales can keep, and GateLab and GateLabR wrote the same text
 * before 2026-09 on flowCore's scale: such a file was read on that scale, and every logicle gate
 * 4.5 times too low (T cells 0 of 47,255 on the public PBMC file). The about text of earlier files
 * lacks these words, so they are still read as they were written.
 */
export const GATELAB_ABOUT_LOGICLE_SCALE = "logicle on the Gating-ML 2.0 scale, T at 1";

/** Non-root populations, each after its parent, siblings in stored order; unreachable ones last. */
function treeOrder(populations: PopulationMap, rootId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([rootId]);
  const visit = (id: string): void => {
    for (const child of populations[id]?.children ?? []) {
      if (seen.has(child) || !populations[child]) continue;
      seen.add(child);
      out.push(child);
      visit(child);
    }
  };
  visit(rootId);
  for (const id of Object.keys(populations)) if (!seen.has(id)) out.push(id);
  return out;
}

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
  /**
   * Filled, when given, with population id → the id of the BooleanGate written for it, so a
   * harness can ask another reader for the same population (scripts/gatingml-flowkit-check.ts).
   */
  populationElementIds?: Map<string, string>;
  /** Filled, when given, with a sentence for each population the format left out, by name. */
  warnings?: string[];
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

/**
 * What the Cytobank format leaves out beneath an OR population: everything beneath it, in tree
 * order, and the names of the populations directly beneath one (`names`), which the export
 * dialog and the export's warnings name.
 *
 * The Cytobank format writes each population as the AND of its whole ancestry, since Cytobank
 * cannot reference one population from another. An AND of an OR population's references with a
 * child's own gate is not the child, and was written anyway: on the public PBMC file a child of a
 * top-level OR held 213 events for FlowKit where GateLab holds 10,802, and a file back from
 * Cytobank, without GateLab's tree, was re-imported with the child re-homed and holding those 213.
 * An OR population beneath another population is refused outright (see exportGatingML).
 */
export function analyzeCytobankOrOmissions(
  populations: PopulationMap,
  rootId: string,
): { populationIds: string[]; names: string[] } {
  const populationIds: string[] = [];
  const names: string[] = [];
  const visit = (id: string, beneathOr: boolean): void => {
    for (const child of populations[id]?.children ?? []) {
      const pop = populations[child];
      if (!pop) continue;
      if (beneathOr) populationIds.push(child);
      if (beneathOr && !(id !== rootId && populationIds.includes(id))) names.push(pop.name);
      const isOr = pop.gate_logic === "or" && pop.gate_refs.length > 1;
      visit(child, beneathOr || isOr);
    }
  };
  visit(rootId, false);
  return { populationIds, names };
}

/**
 * Whether the Cytobank format leaves out a population whose chain includes and excludes one gate
 * (analyzeCytobankContradictions; fix/gatingml-transforms), rather than write it as the AND of the
 * gate and its complement, which holds nothing for every reader of the geometry, and which GateLab's
 * own Cytobank reader reads as written since it keeps each reference with whether it is included
 * (fix/gatingml-hardening, f6a2af8). The two branches chose differently; the release candidate
 * writes such a population (false), so the tree keeps it and every file holds it empty. Whether
 * Cytobank itself accepts a definition naming one gate in both gates and negGates is not measured.
 * Set to true to leave it out again, with the export's warnings and the export dialog's notice.
 */
export const CYTOBANK_OMITS_CONTRADICTIONS = false;

/**
 * What the Cytobank format leaves out, when CYTOBANK_OMITS_CONTRADICTIONS, because a population
 * excludes a gate that a population above it includes, or the other way round: that population,
 * everything beneath it, and a sentence for each population where it starts (`warnings`).
 *
 * The format writes each population as the AND of its whole ancestry. Such a population is empty
 * in GateLab (its events pass the gate and fail it), and the chain would have to AND a gate with
 * its own complement. It kept the first reference to each gate instead, so it was written as its
 * ancestor's gate alone, and(g, g): a reader took it for that ancestor's events, and GateLab, back
 * from its own file, took it for nothing. The format's definition JSON has no way to state the
 * contradiction, so the population is left out by name; the standard format writes it.
 */
export function analyzeCytobankContradictions(
  gates: Record<string, Gate>,
  populations: PopulationMap,
  rootId: string,
): { populationIds: string[]; names: string[]; warnings: string[] } {
  const populationIds: string[] = [];
  const names: string[] = [];
  const warnings: string[] = [];
  const gateName = (id: string) => gates[id]?.name ?? id;
  /** gate id → [included?, the population that references it] down the chain. */
  const visit = (id: string, chain: Map<string, { include: boolean; by: string }>, beneath: boolean): void => {
    for (const child of populations[id]?.children ?? []) {
      const pop = populations[child];
      if (!pop) continue;
      if (beneath) {
        populationIds.push(child);
        visit(child, chain, true);
        continue;
      }
      const mine = new Map(chain);
      let clash: { gate: string; include: boolean; by: string } | null = null;
      // An OR's references are not one AND; what sits beneath one is left out anyway
      // (analyzeCytobankOrOmissions), and an OR at the top is written as it is.
      const isOr = pop.gate_logic === "or" && (pop.gate_refs ?? []).length > 1;
      for (const ref of isOr ? [] : pop.gate_refs ?? []) {
        const g = gates[ref.gate_id];
        if (!g || g.gate_type === "quadrant") continue;
        const seen = mine.get(ref.gate_id);
        if (seen && seen.include !== ref.include) {
          clash ??= { gate: ref.gate_id, include: ref.include, by: seen.by };
        } else if (!seen) {
          mine.set(ref.gate_id, { include: ref.include, by: pop.name });
        }
      }
      if (clash) {
        populationIds.push(child);
        names.push(pop.name);
        const other = clash.by === pop.name ? "it" : `"${clash.by}" above it`;
        warnings.push(
          `"${pop.name}" ${clash.include ? "includes" : "excludes"} the gate "${gateName(clash.gate)}", which ${other} ` +
          `${clash.include ? "excludes" : "includes"}, so it holds no events. The Cytobank-compatible format writes every ` +
          "population as the AND of its whole ancestry and cannot write that, so it and anything below it were left out. " +
          "The standard format writes it, and the .gatelab workspace keeps it.",
        );
        visit(child, mine, true);
        continue;
      }
      visit(child, mine, false);
    }
  };
  visit(rootId, new Map(), false);
  return { populationIds, names, warnings };
}

// ── Low-level formatting ─────────────────────────────────────────────────────
const escAttr = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Text content: & < > only (Cytobank stores raw JSON here; " must stay literal).
const escText = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Base64 of a name (UTF-8 bytes) in the alphabet Cytobank uses for its own gate ids: '+' → '_',
 * '/' → '-', '=' padding → '.'.
 *
 * A gate id is an xs:ID, which admits letters, digits, '.', '-' and '_' but not '+' or '/'. The
 * standard alphabet gave any name ending in U+2212 an id ending `…+KIkg..`, which fails the
 * Gating-ML 2.0 schema, and FlowKit validates against the schema before reading anything.
 * Cytobank's own exports write such a name as `…_KIkg..`, so '+' → '_' is read off them. None of
 * its exports on hand contains a '/', so '/' → '-' is a choice that keeps the mapping one-to-one.
 * The id is opaque to every reader, GateLab's included, so files written with the old alphabet
 * still import.
 */
function b64id(name: string): string {
  const bytes = new TextEncoder().encode(String(name));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "_").replace(/\//g, "-").replace(/=/g, ".");
}

/**
 * A number as the shortest decimal that reads back as the same double (at most 17 significant
 * figures). It was sprintf("%.15g", x) until 2026-09, which moved a gate edge by up to half a unit
 * in the 15th figure: an event lying on the edge, as integer-valued data puts it on an edge drawn at
 * an integer, then fell outside it on re-import (6 of 1,316 events of a log rectangle on the public
 * S8 file).
 *
 * Anything not finite is refused: this wrote "0" for it until 2026-09, which put an unbounded
 * logicle edge at 0 (an open-top range became max="0", and empty). Callers write an unbounded edge
 * as no bound.
 */
export function fmtNum(x: number): string {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new Error(`A number to be written is not finite (${n}); nothing was exported.`);
  if (n === 0) return "0";
  return String(n);
}

/** The next double above (dir 1) or below (dir −1) a finite x. */
function nextDouble(x: number, dir: 1 | -1): number {
  if (x === 0) return dir * Number.MIN_VALUE;
  const f = new Float64Array([x]);
  const b = new BigInt64Array(f.buffer);
  b[0] += (x > 0) === (dir > 0) ? 1n : -1n;
  return f[0];
}

/**
 * A written rectangle bound moved, by no more than rounding's width, so that the exported file's
 * own events are decided on it as GateLab decides them, both by a reader that follows the standard
 * (FlowKit: min inclusive, max exclusive, in double precision) and by GateLab reading the file back
 * without its record of the rectangle (on the event's value in single precision when the dimension
 * declares a transform; Sample.pinnedColumn). An event lies exactly on an edge when integer-valued
 * data meets an edge drawn at an integer, as on the public S8 file, and rounding v and a flog bound
 * v + 1 differently put 6 such events of a log rectangle on the other side.
 *
 * The two readings cannot always both be met. A written space whose single-precision values are
 * coarser than the gate's own (FlowJo's log, written as flog one decade up: 1.169 where GateLab
 * holds 0.169) puts events GateLab decides apart onto one single-precision value, and no bound
 * separates them there. The bound is then placed for the reader in double precision alone, which
 * is every other program; GateLab reading its own file uses the record, which does not depend on
 * the bound's last digits. Placed for neither, as until 2026-09-25, a FlowJo log rectangle's lower
 * edge at 7 lost its events to FlowKit. Where no bound within rounding's width separates the events
 * even in double precision, the bound is left as it was.
 *
 * `gate` holds each event's value in the gate's own space, `v` the stored edge, `written` each
 * event's value as the file writes it. `pad` keeps an event left out that far from the bound when
 * GateLab reads it back: a polygon edge, unlike a rectangle's, holds an event within 1e-9 of it
 * (gateMaskPolygon), so a skirt strip's end is kept that far from what it leaves out.
 */
function tieBreak(
  w: number, side: "lo" | "hi", gate: ArrayLike<number>, v: number, written: (i: number) => number, singlePrecision: boolean,
  pad = 0,
  openTop = false,
  /**
   * How far a standard reader's own value for event i may lie from `written(i)`: FlowKit's logicle
   * differs from GateLab's by up to 2.2e-16, and its arcsinh by a few units in the last place, and it
   * compensates in double precision where GateLab holds the result in single. A bound one double
   * from an event's value, as this placed it until 2026-09, was on the other side for FlowKit: 7 of
   * 3,005 events of a logicle rectangle on the public S8 file, whose width channels hold integers.
   * The bound keeps this far from every event's value when it can, and falls back to without.
   */
  unc?: (i: number) => number,
): number {
  // The interval a bound must lie in: (lo, hi] for a low bound, (lo, hi) for a high one. Only events
  // near the edge in the gate's own space can constrain a move within rounding's width.
  const near = 1e-4 * Math.max(1, Math.abs(v));
  const interval = (margin: boolean, single: boolean): [number, number] => {
    let lo = -Infinity;
    let hi = Infinity;
    for (let i = 0; i < gate.length; i++) {
      if (!(Math.abs(gate[i] - v) <= near)) continue;
      const r = written(i);
      if (!Number.isFinite(r)) continue;
      const q = single ? Math.fround(r) : r;
      const e = margin && unc ? unc(i) : 0;
      // `openTop`: the upper edge of a half-open rectangle, which holds what lies below it only.
      const inside = side === "lo" ? gate[i] >= v : openTop ? gate[i] < v : gate[i] <= v;
      if (side === "lo") {
        if (inside) hi = Math.min(hi, r - e, q); else lo = Math.max(lo, r + e, q + pad);
      } else if (inside) lo = Math.max(lo, r + e, q); else hi = Math.min(hi, r - e, q - pad);
    }
    return [lo, hi];
  };
  const place = ([lo, hi]: [number, number]): number | null => {
    const ok = (u: number) => lo < u && (side === "lo" ? u <= hi : u < hi);
    if (ok(w)) return w;
    if (!(lo < hi)) return null;
    const candidates = [nextDouble(lo, 1), side === "lo" ? hi : nextDouble(hi, -1)].filter(ok);
    let best = w;
    for (const c of candidates) if (best === w || Math.abs(c - w) < Math.abs(best - w)) best = c;
    return best !== w && Math.abs(best - w) <= 1e-6 * Math.max(1, Math.abs(w)) ? best : null;
  };
  const placed = (single: boolean) => (unc ? place(interval(true, single)) : null) ?? place(interval(false, single));
  return placed(singlePrecision) ?? (singlePrecision ? placed(false) : null) ?? w;
}

/** The spacing of single-precision values at x. */
function ulp32(x: number): number {
  const a = Math.abs(x);
  return a < 1.1754943508222875e-38 ? 1.401298464324817e-45 : 2 ** (Math.floor(Math.log2(a)) - 23);
}

/**
 * An ellipse's distanceSquare, moved by no more than 1e-6 of it, so that each reader decides the
 * exported file's own events on its boundary as GateLab decides them.
 *
 * GateLab holds an event when the quadratic form of its value in the gate's space, held in single
 * precision, is at most distanceSquare (gateMaskEllipse). A reader computes the value and the form
 * itself, in double precision, and an event whose form lies within rounding of distanceSquare, as a
 * stack of events on one quantized value puts it when the boundary is drawn through them, was decided
 * by that rounding: FlowKit placed 78 to 95 events of 24 to 29 of the r4 verifier's ellipses through a
 * stack differently from GateLab on the public files, and GateLab's own re-import 27 to 53.
 *
 * `readers` gives each reader's form for each event and how far a reader's own may lie from it (an
 * absolute amount, per event); `inside` is GateLab's decision. The distance is kept where it already
 * decides them all, and otherwise moved to the nearest value that does, clear of each reader's form by
 * its slack, or by a thousandth of it, or by none. Where no value within 1e-6 does, it is kept.
 */
export function ellipseDistanceFor(
  d2: number,
  inside: ArrayLike<number>,
  readers: { q: ArrayLike<number>; slack?: (i: number) => number }[],
): number {
  if (!(d2 > 0) || !Number.isFinite(d2)) return d2;
  // Up to 1e-6 of the distance where that settles them, and up to 1e-5 or 1e-4 where it does not:
  // GateLab reads a FlowJo log ellipse back from flog, whose values sit near 1 where FlowJo log's sit
  // near 0, so it holds them in single precision up to a hundred times more coarsely, and for a small
  // ellipse that is more than 1e-6 of its form. Within 1e-6, 2 to 6 events of the r4 verifier's
  // FlowJo log ellipses through a stack on the public GvHD and S8 files were left to it.
  const windows = [1e-6, 1e-5, 1e-4].map((w) => w * d2);
  const widest = windows[windows.length - 1];
  // Each reader's form for each event within the widest window, held or not, and its slack.
  const cons: { v: number; e: number; held: boolean }[] = [];
  for (const { q, slack } of readers) {
    for (let i = 0; i < q.length; i++) {
      const v = q[i];
      if (Math.abs(v - d2) <= widest) cons.push({ v, e: slack ? slack(i) : 0, held: !!inside[i] });
    }
  }
  // A reader holds an event when its form is at most the distance: the events a distance leaves on the
  // wrong side, and those it leaves within their slack of it.
  const wrong = (d: number, scale: number) =>
    cons.reduce((n, c) => n + ((c.held ? c.v + scale * c.e <= d : c.v - scale * c.e > d) ? 0 : 1), 0);
  const score = (d: number): [number, number] => [wrong(d, 0), wrong(d, 1)];
  let best = d2;
  let bestScore = score(d2);
  for (const window of windows) {
    for (const scale of [1, 1e-3, 0]) {
      // The distance is in [lo, hi) for every form within the window, each clear by its scaled slack.
      let lo = -Infinity;
      let hi = Infinity;
      for (const c of cons) {
        if (!(Math.abs(c.v - d2) <= window)) continue;
        const e = scale * c.e;
        if (c.held) { if (c.v + e > lo) lo = c.v + e; } else if (c.v - e < hi) hi = c.v - e;
      }
      if (!(lo < hi)) continue;
      const d = lo <= d2 && d2 < hi ? d2 : lo > d2 ? lo : nextDouble(hi, -1);
      if (!(d >= lo && d < hi && Math.abs(d - d2) <= window)) continue;
      const sc = score(d);
      if (sc[0] < bestScore[0] || (sc[0] === bestScore[0] && sc[1] < bestScore[1])) { best = d; bestScore = sc; }
    }
  }
  return best;
}

/**
 * A rectangle bound written in a space other than the gate's own, exact for GateLab's decision: the
 * written value from which on (a low bound) or up to which (a high bound) an event is inside the
 * stored edge `v` as GateLab decides it, which is on its value in the gate's own space held in
 * single precision (Sample.pinnedColumn). `back` maps the written space to the gate's own.
 * Converting the edge by the inverse transform alone lands a little to either side of it (a biex
 * table inverts 3,000 to a hair above 3,000), so an event on the edge's own value, which
 * integer-valued data puts there, fell outside on re-import and for FlowKit.
 */
function exactBound(
  w: number, v: number, back: (u: number) => number, side: "lo" | "hi",
  /** GateLab's own decision on a value in the gate's space, where it is not simply "≥ v" or "≤ v". */
  holds?: (gateValue: number) => boolean,
  openTop = false,
): number {
  if (!Number.isFinite(w)) return w;
  // For a low bound: the least u GateLab holds inside. For a high bound: the greatest.
  const inside = holds
    ? (u: number) => holds(Math.fround(back(u)))
    : (u: number) => (side === "lo" ? Math.fround(back(u)) >= v
      : openTop ? Math.fround(back(u)) < v : Math.fround(back(u)) <= v);
  const toward = side === "lo" ? -1 : 1;   // the direction that leaves the gate
  let good = w;
  let bad = w;
  let step = Math.max(Math.abs(w), 1e-300) * 1e-15;
  if (inside(w)) {
    // Out from w until outside, then bisect back.
    for (let i = 0; i < 80 && inside(bad); i++) { good = bad; bad = w + toward * step; step *= 2; }
    if (inside(bad)) return w;
  } else {
    for (let i = 0; i < 80 && !inside(good); i++) { bad = good; good = w - toward * step; step *= 2; }
    if (!inside(good)) return w;
  }
  for (let i = 0; i < 200; i++) {
    const mid = good + (bad - good) / 2;
    if (mid === good || mid === bad) break;
    if (inside(mid)) good = mid; else bad = mid;
  }
  return good;
}

const gateIdStr = (numericId: number, name: string): string => `Gate_${numericId}_${b64id(name)}`;

/**
 * A negated gateReference. Gating-ML 2.0 names the attribute `use-as-complement`. This exporter
 * wrote `gating:complement`, which the schema rejects (GateReference_Type admits no other
 * attribute) and which a schema-following reader ignores, taking the reference as included.
 * GateLab's importer reads both spellings, so files written the old way still import.
 */
const COMPLEMENT_ATTR = ' gating:use-as-complement="true"';

// ── Transform registry ───────────────────────────────────────────────────────
type TrDef = (
  | { type: "fasinh"; T: number; M: number; A: number }
  | { type: "flog"; T: number; M: number }
  | { type: "logicle"; T: number; W: number; M: number; A: number }
  | { type: "flin"; T: number; A: number }
) & {
  /** A gate's Gating-ML bounds (TransformSpec bounds), written back as the transformation's. */
  boundMin?: number;
  boundMax?: number;
};

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
   * The written coordinate → the gate's own stored coordinate: `convert`'s inverse. Given where
   * `convert` bends, so densifyForExport can measure a written edge where GateLab evaluates it.
   */
  back?(v: number): number;
  /**
   * The stored coordinates in [lo, hi] at which `convert` changes slope, when it is piecewise
   * linear between them. FlowJo's biex is, in GateLab and in FlowJo: it is DEFINED by linear
   * interpolation of a table with one entry per display channel (biex.ts), so `convert`, the
   * table's inverse, is straight between integer channels. A polygon edge split at every integer
   * channel it crosses, on each axis that has them, is straight in raw space piece by piece, and the
   * raw polygon is then the same set of events as the one GateLab evaluates, for any file.
   */
  knots?(lo: number, hi: number): number[];
  /**
   * Where the gate's own transform clamps, in stored coordinates, and the raw value a stored
   * coordinate stands for. GateLab evaluates an event beyond a clamp AT the clamp, as FlowJo piles
   * it on the axis edge: FlowJo's log pins everything below its offset to 0, GateLab's flog pins
   * everything below T·10^−M to 0, and FlowJo's biex pins everything beyond its table to the
   * table's ends. A gate edge at a clamp therefore holds every event beyond it. Declared as flog, a
   * standard reader cannot keep them at all (flog of a value <= 0 is undefined, and FlowKit drops
   * the event); written in raw space with the bound at the clamp's raw value, it drops the events
   * beyond. See clampedAxis and skirtRing.
   */
  clamp?: {
    lo?: number; hi?: number; toRaw(v: number): number; fromRaw(v: number): number;
    /**
     * $PnG where the file's coordinates are Gating-ML scale values (stored value / gain; withGain
     * in buildGateExportPlan): an axis written in raw space at the clamp writes toRaw's value
     * divided by it. toRaw and fromRaw stay on the stored raw values GateLab gates. Absent: 1.
     */
    gain?: number;
  };
  /**
   * RAW value → the coordinate written to the file. Distinct from `convert`, which starts from
   * the gate's own stored space. Needed to state the axis range Cytobank should draw, which is a
   * property of the DATA and cannot be recovered from the gate's vertices alone.
   */
  rawToExport(v: number): number;
  /**
   * FlowJo's gate grid, when the gate's axis is on it. A polygon on the grid is written as the
   * union of its grid cells (exportGridPolygon), not through `convert`.
   */
  grid?: FlowJoGridSpec;
  /**
   * On an axis with a declared transform, what a reader multiplies a stored value by before the
   * transform: 1 / $PnG where the file writes Gating-ML scale values (withGain), $TIMESTEP where it
   * writes Time in seconds (onTime). GateLab reading the file back restates the transform on stored
   * values instead (gatesFromGatingMlScale, inTicks), which comes to the same. Absent: 1.
   */
  readScale?: number;
}

interface GateExportPlan {
  axis(gateId: string, channelKey: string): GateAxisExport;
  trDefs: Map<string, TrDef>; // ordered by first appearance
}

/**
 * Stable id fragment for a number: 150 → "150", 150.25 → "150_25", 1.5e+35 → "1_5ep35". An xs:ID
 * has no "+", which a number of 1e21 or more is written with: a fasinh with a small M is held as
 * GateLab's asinh with such a cofactor (1.1e35 at M = 1e-30), and its export failed validation.
 */
function idNum(x: number): string {
  return String(round(x, 4)).replace(/[.+-]/g, (c) => (c === "." ? "_" : c === "+" ? "p" : "m"));
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
  /** Channel key → $PnG where the file's Gating-ML scale values are stored values / gain. */
  gains: ReadonlyMap<string, number> = new Map(),
): GateExportPlan {
  const trDefs = new Map<string, TrDef>();
  const byKey = new Map<string, GateAxisExport>();
  const isCytof = sample.instrument === "cytof";

  /**
   * The id a transform is declared under, one per exact parameter set. The readable base names
   * round their numbers, so two transforms that differ only past that rounding, or in a parameter
   * the name leaves out, get the base name with a counter rather than sharing a declaration: a
   * shared id declared the second gate with the first gate's parameters.
   */
  const idsByDef = new Map<string, string>();
  const declare = (base: string, def: TrDef): string => {
    const key = JSON.stringify(def);
    const hit = idsByDef.get(key);
    if (hit) return hit;
    let trId = base;
    for (let k = 2; trDefs.has(trId); k++) trId = `${base}_${k}`;
    trDefs.set(trId, def);
    idsByDef.set(key, trId);
    return trId;
  };

  /** A gate's Gating-ML bounds as a TrDef's, in the declared transform's own units. */
  const boundsOf = (spec: TransformSpec): { boundMin?: number; boundMax?: number } => {
    const b = "bounds" in spec ? spec.bounds : undefined;
    return {
      ...(b?.min !== undefined ? { boundMin: b.min } : {}),
      ...(b?.max !== undefined ? { boundMax: b.max } : {}),
    };
  };

  const fasinh = (cf: number, bounds: { boundMin?: number; boundMax?: number } = {}): string =>
    declare(
      isCytof ? `Tr_Arcsinh_${idNum(cf)}${bounds.boundMin !== undefined || bounds.boundMax !== undefined ? "_bounded" : ""}`
        : `Tr_Fasinh_${idNum(cf)}${bounds.boundMin !== undefined || bounds.boundMax !== undefined ? "_bounded" : ""}`,
      { type: "fasinh", T: cf * SINH1, M: LOG10E, A: 0, ...bounds },
    );

  /** A raw value as a reader computes the fasinh `fasinh(cf)` declares (gatingMLFasinh). */
  const readerFasinh = (cf: number): ((v: number) => number) => gatingMLFasinh(cf * SINH1, LOG10E, 0).forward;

  /** Gating-ML flog for a FlowJo log axis. See the wsplog branch for why this is exact. */
  const flog = (T: number, M: number, bounds: { boundMin?: number; boundMax?: number } = {}): string =>
    declare(`Tr_Log_${idNum(T)}_${idNum(M)}${bounds.boundMin !== undefined || bounds.boundMax !== undefined ? "_bounded" : ""}`,
      { type: "flog", T, M, ...bounds });

  const plan = (gate: Gate, channelKey: string): GateAxisExport => {
    const space = sample.gateSpace(gate);
    const own: TransformSpec = space === "raw"
      ? { kind: "identity" }
      : (gate.transforms?.[channelKey] ?? sample.transformSpec(channelKey));
    const bounds = boundsOf(own);
    const bounded = bounds.boundMin !== undefined || bounds.boundMax !== undefined;
    if (bounded && cytobankMode) {
      // Cytobank's scales are Linear, Log and Arcsinh, with nothing that holds a value at a bound,
      // and its own exports never write one; the standard format writes the bound as it came.
      throw new Error(
        `The gate "${gate.name}" bounds ${channelKey} (a Gating-ML boundMin or boundMax), which the ` +
        "Cytobank-compatible format cannot carry. The standard format writes it.",
      );
    }
    /** What a reader of the file tests the gate on: the declared transform, then its bounds. */
    const clampTo = (f: (v: number) => number) => bounded
      ? (v: number) => {
          const y = f(v);
          return bounds.boundMin !== undefined && y < bounds.boundMin ? bounds.boundMin
            : bounds.boundMax !== undefined && y > bounds.boundMax ? bounds.boundMax : y;
        }
      : f;

    if (own.kind === "identity") {
      if (bounded) {
        // Raw values held to a bound: Gating-ML's flin with T = 1 and A = 0 is x itself, and the
        // one transformation a bound can be written on without moving the coordinates.
        const trId = declare("Tr_Linear_bounded", { type: "flin", T: 1, A: 0, ...bounds });
        return { trId, cofactor: sample.arcsinhCofactor, convert: (v) => v, rawToExport: clampTo((v) => v) };
      }
      // No transform to declare, and the values are already what a reader should use.
      return { trId: null, cofactor: sample.arcsinhCofactor, convert: (v) => v, rawToExport: (v) => v };
    }
    if (own.kind === "asinh") {
      // GateLab's arcsinh display coordinate IS fasinh(T = cf·sinh(1), M = log10 e, A = 0).
      const cf0 = own.cofactor;
      return {
        trId: fasinh(cf0, bounds), cofactor: cf0, convert: (v) => v,
        // What a reader computes from that declaration (FlowKit, operation for operation), which is
        // one unit in the last place from asinh(x / cf) for some x. Modelled as asinh(x / cf), a
        // bound placed on an event GateLab holds (tieBreak) left it out for FlowKit: 46 events of a
        // re-exported range on the public LSR-II file.
        rawToExport: clampTo(readerFasinh(cf0)),
      };
    }
    // FlowJo's own transforms, which arrive on gates imported from a .wsp. Gating-ML has no way
    // to express either, so the gate is written in RAW space with no transformation-ref. That is
    // exact for a rectangle (a monotonic transform maps an axis-aligned box to an axis-aligned
    // box) and for a quadrant's single point; a polygon's edges are densified instead — see
    // densifyAxes below — so the boundary survives to well under a pixel.
    if (own.kind === "wsplog") {
      // FlowJo's log IS Gating-ML's flog, so this is a declaration rather than an approximation.
      //   FlowJo  y  = log10(v / offset) / decades          (biex.ts wspLogTransform)
      //   flog    y' = log10(x / T) / M + 1                 (Gating-ML 2.0)
      // With T = offset and M = decades the two agree exactly, differing only by the constant
      // 1: y' = y + 1. That offset is AFFINE, which is what makes this worth doing — a straight
      // edge stays straight, so nothing is densified, a rectangle survives as a rectangle, and
      // an ellipse keeps its covariance (the caller's linearity factor convert(1) − convert(0)
      // comes out at exactly 1). The importer already inverts flog as x = T·10^((y−1)·M), so a
      // GateLab round trip is exact by construction.
      //
      // FlowJo's clamp is the one thing the declaration alone does not carry: wspLogTransform
      // pins values below `offset` to y = 0 rather than letting them go to −Infinity, and flog
      // has no such rule, so a reader places sub-offset EVENTS below the axis floor, or, at or
      // below zero, nowhere (flog is undefined there, and FlowKit drops them), where FlowJo piles
      // them on it. A rectangle with its lower edge on the floor is written in raw space instead,
      // with no lower bound (see `clamp`), and every reader keeps them. It used to be written as
      // flog with the lower bound left out, which kept them for GateLab alone: FlowKit
      // dropped 36,480 of 67,751 events of such a rectangle on the public PBMC file. A polygon
      // with a vertex on the floor still loses them on a standard reader, since no flog polygon
      // can hold a value flog does not define, and re-expressing it in raw would bend every
      // edge; on the Aria fixture that was 424 of 1,074 events for a corner at (0, 0).
      // Every gate type, not just rectangles. This was restricted to rectangles when the
      // importer still inverted a flog gate into raw: a polygon's edges are straight in the space
      // it was drawn in, so straight-in-log came back straight-in-raw and the boundary bowed by
      // 20 events on the Aria fixture. Now that flog is a gate space GateLab can hold, the
      // vertices come back where they left and a polygon survives exactly.
      const { offset, decades } = own;
      if (offset > 0 && decades > 0) {
        return {
          trId: flog(offset, decades),
          cofactor: sample.arcsinhCofactor,
          convert: (v) => v + 1,
          rawToExport: (v) => Math.log10(Math.max(v, offset) / offset) / decades + 1,
          clamp: { lo: 0, toRaw: transformFromSpec(own).inverse, fromRaw: transformFromSpec(own).forward },
        };
      }
      // Degenerate parameters cannot describe a log axis; fall through to the raw path below.
    }

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
      //
      // Biex is a table, and GateLab, like FlowJo, clamps an event beyond either end of it to that
      // end, so a gate edge on the table's end holds every event beyond it (see `clamp`). A
      // maxValue below the data's range puts many there: the table ends at −93.5 for maxValue
      // 262144, and on the public S8 file a rectangle whose lower edge sat there held 6,253
      // events in GateLab and 3,494 in FlowKit, which applied the bound at −93.5.
      const { forward, inverse: inv } = transformFromSpec(own);
      return {
        trId: null, cofactor: sample.arcsinhCofactor, convert: inv, needsDensify: true, back: forward,
        rawToExport: (v) => v,   // written in RAW space, so raw values need no mapping
        ...(own.kind === "biex"
          ? {
              clamp: { lo: forward(-Number.MAX_VALUE), hi: forward(Number.MAX_VALUE), toRaw: inv, fromRaw: forward },
              knots: tableEntries(generateBiexLut(own).y),
            }
          : {}),
      };
    }

    if (own.kind === "flog") {
      // A gate already living in Gating-ML's own log space: declare it and write the vertices
      // verbatim. Nothing to convert and nothing to densify — this IS the export space, and
      // Cytobank reads flog (its own flow exports declare it), so both formats take this path.
      // This block sat BELOW the Cytobank logicle branch until 2026-09-11, so in Cytobank format
      // a flog gate was treated as logicle: its coordinates scaled by the logicle span and
      // inverted, which put every such gate far off the top of the axis.
      if (own.T > 0 && own.M > 0 && own.standard) {
        // Gating-ML's own flog, as read from another tool's file: the file means what the gate does,
        // bounds and all, with nothing pinned at a floor.
        return {
          trId: flog(own.T, own.M, bounds),
          cofactor: sample.arcsinhCofactor,
          convert: (v) => v,
          rawToExport: transformFromSpec(own).forward,
        };
      }
      if (own.T > 0 && own.M > 0) {
        return {
          trId: flog(own.T, own.M),
          cofactor: sample.arcsinhCofactor,
          convert: (v) => v,
          rawToExport: transformFromSpec(own).forward,
          // GateLab's flog pins values below T·10^−M at 0 (biex.ts flogTransform); a standard
          // reader does not, so a rectangle edge there is written in raw space, as for wsplog.
          clamp: { lo: 0, toRaw: transformFromSpec(own).inverse, fromRaw: transformFromSpec(own).forward },
        };
      }
      const { forward: fwd0, inverse: inv0 } = transformFromSpec(own);
      return {
        trId: null, cofactor: sample.arcsinhCofactor, convert: inv0, back: fwd0,
        needsDensify: true, rawToExport: (v) => v,
      };
    }

    if (own.kind === "flowjoChannels") {
      // FlowJo's grid. Gating-ML cannot quantise an axis, so a grid polygon is written as the
      // union of its cells in raw units (exportGridPolygon below), which selects exactly its
      // events; `convert` takes a channel to the middle of its events, for anything that asks.
      const g = flowJoGridScale(own);
      return {
        trId: null, cofactor: sample.arcsinhCofactor, convert: g.centre, needsDensify: true,
        rawToExport: (v) => v, grid: own,
      };
    }

    // Logicle.
    if (cytobankMode) {
      // Cytobank knows Linear (1), Log (2) and Arcsinh (4) only — there is no logicle to declare,
      // so the gate is re-expressed as arcsinh of the RAW value. This is the one lossy path in
      // the exporter: the re-expressed gate is not the gate GateLab applies.
      //
      // The stored coordinate is GateLab's own logicle, which spans [0, 1], and that is what the
      // inverse takes. It was multiplied by the flowCore span (4.5) first until 2026-09, which put
      // every logicle gate far above the data: a rectangle holding 1,069 of 4,000 synthetic events
      // came back holding none. The map is nonlinear, so a polygon's edges are densified and an
      // ellipse goes out as its densified boundary, as for biex.
      const { forward: lgFwd, inverse: inv } = transformFromSpec(own);
      const cf = CYTOBANK_FLOW_COFACTOR;
      return {
        trId: fasinh(cf),
        cofactor: cf,
        convert: (v) => Math.asinh(inv(v) / cf),
        back: (u) => lgFwd(cf * Math.sinh(u)),
        needsDensify: true,
        rawToExport: readerFasinh(cf),
      };
    }

    // The gate's own parameters, exactly: GateLab evaluates the gate with them, whatever the
    // channel's display does. This wrote clampW(W) until 2026-09, which is the range the channel
    // slider keeps a display W in, not a property of the gate, so a gate with W = 0 was declared
    // with 0.1 and one with 2.2 with 2; and it keyed the transform by channel and W alone, so a
    // second gate with another T, M or A was declared with the first gate's.
    const trId = declare(`Tr_Logicle_${channelKey.replace(/[^A-Za-z0-9]/g, "_")}_W${idNum(own.W)}${bounded ? "_bounded" : ""}`,
      { type: "logicle", T: own.T, W: own.W, M: own.M, A: own.A, ...bounds });
    // Gating-ML 2.0's logicle maps T to 1, exactly as GateLab's own does, so the stored
    // coordinate is already the one the file declares. It was multiplied by M + A until 2026-09,
    // onto flowCore's logicleTransform scale, which put every vertex 4.5 times too high for a
    // reader that follows the standard. Files written that way carry no GATELAB_FORMAT_TAG, which
    // is how the importer still reads them on the old scale.
    const fwd = transformFromSpec(own).forward;
    return {
      trId, cofactor: sample.arcsinhCofactor, convert: (v) => v,
      rawToExport: (v) => fwd(v),
    };
  };

  /**
   * The same axis on Gating-ML's scale values, stored value / $PnG (gatingmlGain.ts). Raw and
   * identity coordinates are divided by the gain; a coordinate under a declared transform stays
   * and the transform's T is divided instead, which is the same transform of the stored value.
   * An unbounded edge (models.ts, UNBOUNDED) is not a coordinate and is left as it is.
   *
   * Everything the export derives from a written coordinate goes through the gain too: `back`,
   * with which exactBound, tieBreak and densifyForExport find where GateLab decides an event, and
   * the clamp, whose axis is written in raw space where a gate reaches it (clampedAxis,
   * polygonAxis, the skirts). Until 2026-09-25 only `convert` and `rawToExport` were, and a
   * biex, flog or FlowJo log gate on a channel with a gain was placed, densified and skirted in
   * stored units while written in scale values: a standard round trip on a synthetic file with
   * $PnG 2, 0.5 and 3.67 moved 133,640 events in 38 of 100 rows.
   */
  const withGain = (axis: GateAxisExport, g: number | undefined): GateAxisExport => {
    if (g === undefined || g === 1) return axis;
    const clamp = axis.clamp ? { ...axis.clamp, gain: (axis.clamp.gain ?? 1) * g } : undefined;
    if (axis.trId === null) {
      const back = axis.back;
      return {
        ...axis,
        convert: (v) => (isUnbounded(v) ? v : axis.convert(v) / g),
        ...(back ? { back: (u: number) => back(u * g) } : {}),
        rawToExport: (v) => axis.rawToExport(v) / g,
        ...(clamp ? { clamp } : {}),
      };
    }
    const def = trDefs.get(axis.trId);
    if (!def) return axis;
    const trId = `${axis.trId}_gain_${idNum(g)}`;
    // flin, (x + A) / (T + A), is the same of x / g with both T and A divided (as onTime does).
    if (!trDefs.has(trId)) trDefs.set(trId, def.type === "flin" ? { ...def, T: def.T / g, A: def.A / g } : { ...def, T: def.T / g });
    return { ...axis, trId, cofactor: axis.cofactor / g, readScale: (axis.readScale ?? 1) / g, ...(clamp ? { clamp } : {}) };
  };

  /**
   * The standard format writes Time in seconds, stored ticks times $TIMESTEP, as FlowKit and FlowJo
   * read it; the Cytobank format writes it as stored, as Cytobank does (gatingml.ts timeUnitOf).
   * A raw coordinate is multiplied by the timestep; a transformed one stays, and the transform is
   * declared on seconds instead, its T times the timestep, which is the same transform of the same
   * event. Written in ticks, a Time gate holding 29,194 events of the public FACSDiva file holds
   * none for FlowKit.
   */
  const timestep = cytobankMode ? null : fcsTimestep(sample.fcs.keywords);
  const onTime = (gate: Gate, channelKey: string, axis: GateAxisExport): GateAxisExport => {
    const idx = sample.index(channelKey);
    const pnn = idx === undefined ? channelKey : sample.channels[idx].pnn;
    if (timestep === null || !isTimeParameter(pnn)) return axis;
    if (axis.clamp || axis.knots || axis.needsDensify) {
      // A FlowJo log or biex axis on Time, whose events beyond a clamp are written in raw space:
      // not something FlowJo draws Time on, and not carried into seconds here.
      throw new Error(
        `The gate "${gate.name}" holds Time on a FlowJo log or biex axis, which the standard format, ` +
        "writing Time in seconds, cannot carry. The Cytobank-compatible format writes Time as stored.",
      );
    }
    if (axis.trId === null) {
      const back = axis.back ?? ((u: number) => u);
      return {
        ...axis,
        convert: (v) => (isUnbounded(v) ? v : axis.convert(v) * timestep),
        back: (u) => back(u / timestep),
        rawToExport: (v) => axis.rawToExport(v) * timestep,
      };
    }
    const def = trDefs.get(axis.trId);
    if (!def) return axis;
    const inSeconds: TrDef = def.type === "flin"
      ? { ...def, T: def.T * timestep, A: def.A * timestep }
      : { ...def, T: def.T * timestep };
    return {
      ...axis, trId: declare(`${axis.trId}_seconds`, inSeconds), cofactor: axis.cofactor * timestep,
      readScale: (axis.readScale ?? 1) * timestep,
    };
  };

  for (const gid of gateOrder.length ? gateOrder : Object.keys(gates)) {
    const gate = gates[gid];
    if (!gate) continue;
    for (const ch of [gate.x_channel, gate.y_channel]) {
      const k = `${gid}|${ch}`;
      // Time in seconds (never a gain on it: gatingMlGains leaves Time out), then the gain.
      if (!byKey.has(k)) byKey.set(k, withGain(onTime(gate, ch, plan(gate, ch)), gains.get(ch)));
    }
  }
  // A transform restated on scale values or in seconds replaces the one it was made from; drop
  // any declaration no axis refers to any more. Without a gain or a Time gate every declaration
  // is in use.
  const used = new Set([...byKey.values()].map((axis) => axis.trId));
  for (const id of [...trDefs.keys()]) if (!used.has(id)) trDefs.delete(id);

  return {
    trDefs,
    axis: (gateId, channelKey) =>
      byKey.get(`${gateId}|${channelKey}`)
        ?? { trId: null, cofactor: sample.arcsinhCofactor, convert: (v) => v, rawToExport: (v) => v },
  };
}

/** A table's entries in [lo, hi], in order: a biex table's display channels, for knots. */
function tableEntries(table: ArrayLike<number>): (lo: number, hi: number) => number[] {
  return (lo, hi) => {
    const out: number[] = [];
    for (let j = 0; j < table.length; j++) if (table[j] >= lo && table[j] <= hi) out.push(table[j]);
    return out;
  };
}

/**
 * A polygon's vertices with every point added at which an edge crosses a knot of either axis
 * (GateAxisExport.knots), in order, each knotted coordinate set exactly on its knot. Between two
 * such points both axes are affine, so each piece stays straight in the written space.
 *
 * An edge along one axis is straight in the written space whatever the other axis crosses, since
 * each axis is written by a monotonic map of its own coordinate, and is not split: split at every
 * entry of a biex table, an edge a polygon lays along the table's end (clipToClamps) was a third of
 * the vertices of the verifier's PBMC strategy, 5,116 of 15,421, each exactly on the line between
 * its neighbours.
 */
export function splitAtKnots(
  verts: readonly [number, number][],
  kx?: (lo: number, hi: number) => number[],
  ky?: (lo: number, hi: number) => number[],
): [number, number][] {
  if (!kx && !ky) return verts.map((v) => [v[0], v[1]]);
  const out: [number, number][] = [];
  const at = (k: ((lo: number, hi: number) => number[]) | undefined, a: number, b: number): [number, number][] => {
    if (!k || a === b) return [];
    const res: [number, number][] = [];
    for (const c of k(Math.min(a, b), Math.max(a, b))) {
      const t = (c - a) / (b - a);
      if (t > 0 && t < 1) res.push([t, c]);
    }
    return res;
  };
  for (let e = 0; e < verts.length; e++) {
    const a = verts[e];
    const b = verts[(e + 1) % verts.length];
    out.push([a[0], a[1]]);
    if (a[0] === b[0] || a[1] === b[1]) continue;
    const cuts = [
      ...at(kx, a[0], b[0]).map(([t, c]) => ({ t, x: c as number | null, y: null as number | null })),
      ...at(ky, a[1], b[1]).map(([t, c]) => ({ t, x: null as number | null, y: c as number | null })),
    ].sort((p, q) => p.t - q.t);
    for (let i = 0; i < cuts.length; i++) {
      const { t } = cuts[i];
      let x = cuts[i].x ?? a[0] + (b[0] - a[0]) * t;
      let y = cuts[i].y ?? a[1] + (b[1] - a[1]) * t;
      // Both axes on a knot at the same point: one point, on both.
      while (i + 1 < cuts.length && cuts[i + 1].t - t <= 1e-12) {
        i++;
        if (cuts[i].x !== null) x = cuts[i].x!;
        if (cuts[i].y !== null) y = cuts[i].y!;
      }
      const last = out[out.length - 1];
      if (last[0] !== x || last[1] !== y) out.push([x, y]);
    }
  }
  return out;
}

/**
 * Douglas-Peucker over a densified ring, per edge, keeping every ORIGINAL vertex.
 *
 * subdivideEdge bisects, so it lays points down uniformly along an edge even when the curvature
 * is concentrated in one stretch of it -- a real laboratory export carried 25 to 67 vertices per gate,
 * which is unusable to hand-edit in the receiving tool. Collapse drops the interior points a
 * straight chord already represents within `tol` (span-normalised, the same metric subdivision
 * uses). The exporter subdivides at HALF the documented tolerance and collapses at the other
 * half, so the two stages together keep the same 0.2% total bound rather than doubling it.
 * Original vertices are forced anchors: a true corner can never be simplified away.
 */
export function collapseDensifiedRing(
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

/**
 * A gate's boundary as pieces, each a curve over t ∈ [0, 1] in the gate's own space: a polygon's
 * edges, which are straight there, or an ellipse's arcs.
 */
export interface BoundaryCurve {
  pieces: number;
  at(piece: number, t: number): [number, number];
  /** Every piece is a straight segment in the gate's own space. */
  straight: boolean;
  /**
   * The curve is one point, on its axes' clamps, where a gate that lies beyond them touches them or
   * comes nearest (clipToClamps): it holds nothing within them but what GateLab places there.
   */
  point?: boolean;
}

/** A polygon's edges, vertex i to vertex i + 1. */
export function polygonCurve(verts: readonly [number, number][]): BoundaryCurve {
  return {
    pieces: verts.length,
    straight: true,
    at: (e, t) => {
      const a = verts[e];
      const b = verts[(e + 1) % verts.length];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    },
  };
}

/** An ellipse's boundary as `n` arcs, the first starting at the end of its major axis. */
export function ellipseCurve(g: EllipseGate, n = 64): BoundaryCurve {
  const { major, minor, angle } = axesFromCovariance(g.covariance, g.distance_square);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  return {
    pieces: n,
    straight: false,
    at: (e, t) => {
      const th = (2 * Math.PI * (e + t)) / n;
      const px = major * Math.cos(th);
      const py = minor * Math.sin(th);
      return [g.mean[0] + px * ca - py * sa, g.mean[1] + px * sa + py * ca];
    },
  };
}

/** Where GateLab's own space clamps each axis (GateAxisExport.clamp): the ends of a biex table, a log floor. */
export interface ClampBox {
  x: { lo?: number; hi?: number };
  y: { lo?: number; hi?: number };
}

/**
 * A gate's boundary within the box its axes clamp to, in the gate's own space: the part of the gate
 * inside the box, with the box's side as its edge where the gate reaches past it.
 *
 * GateLab places every event beyond a clamp on the clamp, so the part of a gate past a clamp holds
 * no event, and an event on the clamp is held exactly when the gate holds that point: the clipped
 * gate holds the same events. The app never draws past a clamp (a drawn vertex goes through the
 * biex table), but a workspace or the API can carry a polygon vertex there, and a FlowJo workspace
 * an ellipse crossing a table's end. Written as it stood, such a boundary was one no written point
 * could reach, since a written point maps back onto the clamp, and densifying it failed with
 * "Maximum call stack size exceeded". Clipped, the part along the clamp is an ordinary edge on it,
 * which the skirts carry out past every event (skirtRing).
 *
 * Each side of the box is clipped in turn (Sutherland-Hodgman, on the pieces of the curve): the
 * pieces inside are kept, and each run outside is replaced by the straight edge along the side
 * from where the curve leaves to where it comes back. A gate that leaves one side more than once is
 * refused by name: the edges along the side would join its parts past the end across stretches of
 * the side GateLab holds no event on. The curve is returned as it was when nothing lies beyond.
 *
 * A gate with nothing of any extent within a side, one that lies wholly beyond it or reaches it
 * only at a point, is that point (`point`): the point on the side where it touches, or the one
 * nearest it, and the export writes what GateLab holds there, the events it places on the side at
 * that point or none (displayGate). Such a gate was refused, and the whole export with it, since it
 * holds no event GateLab places within the box: an ellipse below a FlowJo log floor, which the
 * export wrote as flog until the fifth round (FlowKit read 224 of its events where GateLab holds 0),
 * and a biex polygon with a vertex on the table's end and the rest beyond it. With that vertex
 * twice, the run of no length between the two was kept as the part inside, and the gate was written
 * as a PolygonGate of two vertices, which the schema refuses, and every reader with it. A run inside
 * that never comes more than 1e-12 inside the side is taken for a touch, as a tangent's is: an
 * ellipse tangent to a flog floor from below was written as a sliver of 14,671 vertices (3.1 MB).
 * A gate that touches the side at more than one point and lies beyond it elsewhere is refused by
 * name, as one that leaves it more than once is.
 */
export function clipToClamps(curve: BoundaryCurve, box: ClampBox, name: string): BoundaryCurve {
  type Seg = { at(t: number): [number, number]; straight: boolean };
  let segs: Seg[] = Array.from({ length: curve.pieces }, (_, e) => ({ at: (t: number) => curve.at(e, t), straight: curve.straight }));
  const SAMPLES = 32;
  const sidesOf: { k: 0 | 1; side: "lo" | "hi"; c: number }[] = [];
  for (const k of [0, 1] as const) {
    for (const side of ["lo", "hi"] as const) {
      const c = (k === 0 ? box.x : box.y)[side];
      if (c !== undefined && Number.isFinite(c)) sidesOf.push({ k, side, c });
    }
  }
  let clipped = false;
  for (const { k, side, c } of sidesOf) {
    // Distance inside the side: >= 0 inside (on it included), < 0 beyond.
    const f = (p: [number, number]) => (side === "lo" ? p[k] - c : c - p[k]);
    // A curved piece is sampled evenly, and at the point of it nearest the side: an ellipse that
    // passes a hair beyond the side, as one tangent to a biex table's end does, may do so between
    // two samples, and was then taken to lie wholly inside. Its boundary kept the part beyond,
    // which maps back onto the side, no edge ran along the side, and so no skirt carried it out
    // past the events GateLab places there: FlowKit left out 231 of 5,227 events of a rotated
    // logicle-by-biex ellipse on the public S8 file, all of them below the table, once
    // ellipseDistanceFor (01bacb2) had moved its distance by 7e-14 and its one sample on the side
    // to 2.4e-12 inside it. A piece of 1/64 of an ellipse has one such point at most.
    const sampled = new Map<Seg, number[]>();
    const params = (s: Seg): number[] => {
      if (s.straight) return [0, 1];
      const hit = sampled.get(s);
      if (hit) return hit;
      const ts = Array.from({ length: SAMPLES + 1 }, (_, j) => j / SAMPLES);
      let j = 0;
      for (let m = 1; m < ts.length; m++) if (f(s.at(ts[m])) < f(s.at(ts[j]))) j = m;
      let a = ts[Math.max(0, j - 1)];
      let b = ts[Math.min(ts.length - 1, j + 1)];
      const g = (Math.sqrt(5) - 1) / 2;
      for (let it = 0; it < 80 && b - a > 1e-15; it++) {
        const m1 = b - g * (b - a);
        const m2 = a + g * (b - a);
        if (f(s.at(m1)) < f(s.at(m2))) b = m2; else a = m1;
      }
      const t = (a + b) / 2;
      const out = f(s.at(t)) < f(s.at(ts[j])) && t > 0 && t < 1 && !ts.includes(t)
        ? [...ts, t].sort((u, v) => u - v)
        : ts;
      sampled.set(s, out);
      return out;
    };
    if (segs.every((s) => params(s).every((t) => f(s.at(t)) >= 0))) continue;
    clipped = true;
    /** Where a piece crosses the side, in order, strictly within it. */
    const crossings = (s: Seg): number[] => {
      const ts = params(s);
      const out: number[] = [];
      for (let j = 0; j + 1 < ts.length; j++) {
        let a = ts[j];
        let b = ts[j + 1];
        const fa = f(s.at(a));
        const fb = f(s.at(b));
        if ((fa < 0) === (fb < 0)) continue;
        if (s.straight) { out.push(a + ((b - a) * fa) / (fa - fb)); continue; }
        for (let it = 0; it < 80; it++) {
          const m = (a + b) / 2;
          if ((f(s.at(m)) < 0) === (fa < 0)) a = m; else b = m;
        }
        out.push((a + b) / 2);
      }
      return out.filter((t) => t > 0 && t < 1);
    };
    // Every stretch of every piece between crossings, inside or beyond.
    // A stretch's end at a crossing lies on the side, and is put exactly on it.
    type Run = { s: Seg; a: number; b: number; inside: boolean; aOn: boolean; bOn: boolean };
    const runs: Run[] = [];
    for (const s of segs) {
      const cuts = [0, ...crossings(s), 1];
      for (let j = 0; j + 1 < cuts.length; j++) {
        if (!(cuts[j + 1] > cuts[j])) continue;
        runs.push({
          s, a: cuts[j], b: cuts[j + 1], inside: f(s.at((cuts[j] + cuts[j + 1]) / 2)) >= 0,
          aOn: j > 0, bOn: j + 2 < cuts.length,
        });
      }
    }
    const onSide = (p: [number, number]): [number, number] => { const q: [number, number] = [p[0], p[1]]; q[k] = c; return q; };
    // A run inside has extent where it comes more than rounding inside the side, or runs along it: a
    // straight piece for any length, since its ends are exact (a polygon's edge on the side, however
    // short, holds what lies on the side along it), a curved one for more than rounding. A vertex
    // repeated on the side, or a tangent, makes one of neither.
    const depth = 1e-12 * Math.max(1, Math.abs(c));
    const along = 1e-6 * Math.max(1, Math.abs(c));
    const hasExtent = (r: Run): boolean => {
      const p = r.s.at(r.a);
      const q = r.s.at(r.b);
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (r.s.straight ? len > 0 : len > along) return true;
      for (let j = 0; j <= SAMPLES; j++) if (f(r.s.at(r.a + ((r.b - r.a) * j) / SAMPLES)) > depth) return true;
      return false;
    };
    if (!runs.some((r) => r.inside && hasExtent(r))) {
      // Nothing of any extent inside: the point where the gate touches the side, or comes nearest.
      const touches: [number, number][] = [];
      let nearest: [number, number] = segs[0].at(0);
      let most = -Infinity;
      for (const s of segs) {
        for (const t of params(s)) {
          const p = s.at(t);
          const v = f(p);
          if (v > most) { most = v; nearest = p; }
          if (v >= -depth) {
            const q = onSide(p);
            if (!touches.some((u) => Math.hypot(u[0] - q[0], u[1] - q[1]) <= along)) touches.push(q);
          }
        }
      }
      for (const r of runs) {
        if (!r.inside) continue;
        const q = onSide(r.s.at(r.a));
        if (!touches.some((u) => Math.hypot(u[0] - q[0], u[1] - q[1]) <= along)) touches.push(q);
      }
      if (touches.length > 1) {
        throw new Error(
          `The gate "${name}" lies beyond the end of its axis but for ${touches.length} points on it, where GateLab places every ` +
            "event beyond that end. Move its vertices onto the axis and export again; nothing was exported.",
        );
      }
      const at = touches[0] ?? onSide(nearest);
      segs = [{ at: () => [at[0], at[1]], straight: true }];
      clipped = true;
      continue;
    }
    const first = runs.findIndex((r) => r.inside);
    const next: Seg[] = [];
    let exits = 0;
    let leftAt: [number, number] | null = null;
    for (let j = 0; j < runs.length; j++) {
      const r = runs[(first + j) % runs.length];
      if (!r.inside) {
        if (!leftAt) { leftAt = onSide(r.s.at(r.a)); exits++; }
        continue;
      }
      const start = r.s.at(r.a);
      if (leftAt) {
        const from = leftAt;
        const to = onSide(start);
        if (from[0] !== to[0] || from[1] !== to[1]) next.push({ at: (t) => [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t], straight: true });
        leftAt = null;
      }
      const { s, a, b, aOn, bOn } = r;
      next.push({
        at: (t) => {
          const p = s.at(a + (b - a) * t);
          return (t === 0 && aOn) || (t === 1 && bOn) ? onSide(p) : p;
        },
        straight: s.straight,
      });
    }
    if (leftAt) {
      const from = leftAt;
      const to = onSide(next[0].at(0));
      if (from[0] !== to[0] || from[1] !== to[1]) next.push({ at: (t) => [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t], straight: true });
    }
    if (exits > 1) {
      throw new Error(
        `The gate "${name}" leaves the end of its axis more than once on one side, where GateLab places every event beyond ` +
          "that end on it. Move its vertices onto the axis and export again; nothing was exported.",
      );
    }
    segs = next;
  }
  if (!clipped) return curve;
  const out = segs;
  const p0 = out[0].at(0);
  const point = out.every((s) => [0, 0.5, 1].every((t) => { const p = s.at(t); return p[0] === p0[0] && p[1] === p0[1]; }));
  return { pieces: out.length, straight: out.every((s) => s.straight), at: (e, t) => out[e].at(t), ...(point ? { point: true } : {}) };
}

/**
 * The events of the file being exported, to hold a densified gate to: each event's coordinates as
 * the file writes them (GateAxisExport.rawToExport of its raw value), GateLab's own decision for
 * it, and how the written ring is finished (its skirts), since that is what a reader evaluates.
 */
export interface ExportEventCheck {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  inside: ArrayLike<number>;
  finish(ring: [number, number][]): [number, number][];
  /**
   * Each event's coordinates as GateLab reads the file back, where they differ from `x` and `y`:
   * a declared transform's value held in single precision (Sample.pinnedColumn). The written ring is
   * held to them too.
   */
  back?: { x: ArrayLike<number>; y: ArrayLike<number> };
}

/**
 * Even-odd point in polygon over many points, as a Gating-ML reader evaluates a PolygonGate. The
 * edges are sorted into horizontal bands over the ring's finite extent (one band below it and one
 * above catch the skirts), so each point is tested only against the edges its own y can cross.
 */
function evenOddMask(ring: readonly [number, number][], x: ArrayLike<number>, y: ArrayLike<number>): Uint8Array {
  const n = x.length;
  const out = new Uint8Array(n);
  const m = ring.length;
  const ex = new Float64Array(m);
  const ey = new Float64Array(m);
  for (let k = 0; k < m; k++) { ex[k] = ring[k][0]; ey[k] = ring[k][1]; }
  const finiteY = [...ey].filter((v) => Math.abs(v) < SKIRT_FAR);
  const lo = finiteY.length ? Math.min(...finiteY) : -1;
  const hi = finiteY.length ? Math.max(...finiteY) : 1;
  const B = 128;
  const bandOf = (v: number) => (v < lo ? 0 : v >= hi ? B + 1 : 1 + Math.min(B - 1, Math.floor(((v - lo) / (hi - lo || 1)) * B)));
  const bands: number[][] = Array.from({ length: B + 2 }, () => []);
  for (let a = 0, b = m - 1; a < m; b = a++) {
    for (let k = bandOf(Math.min(ey[a], ey[b])); k <= bandOf(Math.max(ey[a], ey[b])); k++) bands[k].push(a);
  }
  for (let i = 0; i < n; i++) {
    const px = x[i];
    const py = y[i];
    let inside = false;
    for (const a of bands[bandOf(py)] ?? []) {
      const b = a === 0 ? m - 1 : a - 1;
      if ((ey[a] > py) !== (ey[b] > py) && px < ((ex[b] - ex[a]) * (py - ey[a])) / (ey[b] - ey[a]) + ex[a]) inside = !inside;
    }
    out[i] = inside ? 1 : 0;
  }
  return out;
}

/**
 * A gate carried into a space its edges bend in, measured where GateLab evaluates it, and, when
 * the file's events are given, held to them.
 *
 * Each piece is subdivided until the written chord between two points, mapped back into the gate's
 * own space, lies within `tol` of the boundary there, as a fraction of the gate's extent on each
 * axis; then, for a polygon, the points a chord already covers within `tol` are dropped
 * (Douglas-Peucker in the same measure), keeping every original vertex. Each chord is tested at a
 * quarter, half and three quarters of its length.
 *
 * polygonOutline, which this replaced for raw export, measures in the written space instead, as a
 * fraction of the gate's extent there. That is right for drawing and wrong for a raw export of
 * biex: biex spreads the data near zero, where raw coordinates are small beside a raw extent of
 * 10^5 or more, so 0.1% of the extent was hundreds of raw units exactly where events are densest.
 * On the public PBMC file one biex polygon lost 56 of 16,868 events that way, and 237 of 18,117
 * with the table ending at 262144. `back` maps a written point to the gate's own space
 * (GateAxisExport.back).
 *
 * A bound on the boundary's distance is not a bound on events: an edge through the dense cloud near
 * zero still moved 8 of 1,122 events of a biex polygon on the public Fortessa file at 0.05% of the
 * extent. So when `check` is given, the written ring is then evaluated as a reader evaluates it,
 * and every chord nearest an event it places differently from GateLab is split at its middle, on
 * the true boundary, until none is left or 40 rounds have passed. Splitting a chord changes a
 * reader's decision exactly inside the triangle it removes, so only those events are re-tested.
 */
export function densifyForExport(
  boundary: [number, number][] | BoundaryCurve,
  toOut: (p: [number, number]) => [number, number],
  back: (p: [number, number]) => [number, number],
  tol: number,
  check?: ExportEventCheck,
): [number, number][] {
  const curve = Array.isArray(boundary) ? polygonCurve(boundary) : boundary;
  const corners: [number, number][] = [];
  for (let e = 0; e < curve.pieces; e++) corners.push(curve.at(e, 0), curve.at(e, 0.5));
  const spanOf = (a: number[]) => { const d = Math.max(...a) - Math.min(...a); return d > 0 ? d : Infinity; };
  const span: [number, number] = [spanOf(corners.map((v) => v[0])), spanOf(corners.map((v) => v[1]))];
  /** How far a written point lies from the gate-space line a→b, as a fraction of the gate's extent. */
  const off = (p: [number, number], a: [number, number], b: [number, number]): number => {
    const q = back(p);
    const dx = (b[0] - a[0]) / span[0];
    const dy = (b[1] - a[1]) / span[1];
    const qx = (q[0] - a[0]) / span[0];
    const qy = (q[1] - a[1]) / span[1];
    const len = Math.hypot(dx, dy);
    const d = len > 0 ? Math.abs(dx * qy - dy * qx) / len : Math.hypot(qx, qy);
    return Number.isFinite(d) ? d : 0;
  };
  const along = (p0: [number, number], p1: [number, number], t: number): [number, number] =>
    [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
  const chordOff = (p0: [number, number], p1: [number, number], a: [number, number], b: [number, number]) =>
    Math.max(off(along(p0, p1, 0.25), a, b), off(along(p0, p1, 0.5), a, b), off(along(p0, p1, 0.75), a, b));

  /** A written point, with the piece and the parameter along it that it stands for. */
  type Pt = { e: number; t: number; out: [number, number] };
  const ring: Pt[] = [];
  for (let e = 0; e < curve.pieces; e++) {
    const a = curve.at(e, 0);
    const b = curve.at(e, 1);
    // Subdivide: points of this piece from its start, in order, ending at its end. A chord is
    // measured against the boundary's own chord between the same two parameters, which for a
    // straight piece is the piece itself.
    const pts: Pt[] = [{ e, t: 0, out: toOut(a) }];
    /**
     * How far an arc strays from its own chord between two parameters, in the same measure. A
     * written chord is measured against that chord, which for an arc is not the boundary: an
     * ellipse kept its 64 starting arcs wherever the export space barely bent them, and so strayed
     * from itself by 0.12% of its radius whatever the tolerance.
     */
    const sagitta = (t0: number, t1: number): number => {
      if (curve.straight) return 0;
      const c0 = curve.at(e, t0);
      const c1 = curve.at(e, t1);
      const m = curve.at(e, (t0 + t1) / 2);
      const dx = (c1[0] - c0[0]) / span[0];
      const dy = (c1[1] - c0[1]) / span[1];
      const qx = (m[0] - c0[0]) / span[0];
      const qy = (m[1] - c0[1]) / span[1];
      const len = Math.hypot(dx, dy);
      const d = len > 0 ? Math.abs(dx * qy - dy * qx) / len : Math.hypot(qx, qy);
      return Number.isFinite(d) ? d : 0;
    };
    const split = (t0: number, t1: number, p0: [number, number], p1: [number, number], depth: number) => {
      if (depth >= 14 || chordOff(p0, p1, curve.at(e, t0), curve.at(e, t1)) + sagitta(t0, t1) <= tol) { pts.push({ e, t: t1, out: p1 }); return; }
      const tm = (t0 + t1) / 2;
      const pm = toOut(curve.at(e, tm));
      split(t0, tm, p0, pm, depth + 1);
      split(tm, t1, pm, p1, depth + 1);
    };
    split(0, 1, pts[0].out, toOut(b), 0);
    // Thin a straight piece: keep a point only where the chord that would replace it strays from
    // the edge. An arc keeps every point, each of which lies on it.
    const keep = new Array<boolean>(pts.length).fill(!curve.straight);
    keep[0] = keep[pts.length - 1] = true;
    // Each span is decided on its own two ends, so the spans are worked from a list rather than by
    // recursion: a piece that never comes within tol (a legacy flog floor, which maps every raw
    // value below it to one coordinate) is split to 2^14 points, and splitting it one point at a
    // time recursed that deep and overflowed the stack (RangeError on export).
    const thin = (first: number, last: number) => {
      const spans: [number, number][] = [[first, last]];
      while (spans.length) {
        const [i0, i1] = spans.pop()!;
        if (i1 - i0 < 2) continue;
        let worst = -1;
        let worstOff = tol;
        for (let i = i0 + 1; i < i1; i++) {
          // The chord at the point's own position along it, measured where GateLab evaluates.
          const d = off(along(pts[i0].out, pts[i1].out, (i - i0) / (i1 - i0)), a, b);
          if (d > worstOff) { worstOff = d; worst = i; }
        }
        // Straying only between the points: split at the middle one.
        if (worst < 0 && chordOff(pts[i0].out, pts[i1].out, a, b) > tol) worst = (i0 + i1) >> 1;
        if (worst >= 0) {
          keep[worst] = true;
          spans.push([worst, i1], [i0, worst]);
        }
      }
    };
    if (curve.straight) thin(0, pts.length - 1);
    for (let i = 0; i < pts.length - 1; i++) if (keep[i]) ring.push(pts[i]);
  }
  if (check) holdToEvents(ring, curve, toOut, check);
  return ring.map((p) => p.out);
}

/**
 * Split the chords of `ring` nearest the events a reader of the finished ring places differently
 * from GateLab, at the middle of their piece, until none is left (densifyForExport).
 */
function holdToEvents(
  ring: { e: number; t: number; out: [number, number] }[],
  curve: BoundaryCurve,
  toOut: (p: [number, number]) => [number, number],
  check: ExportEventCheck,
): void {
  const n = check.x.length;
  const closedOut = () => { const r = ring.map((p) => p.out); r.push(r[0]); return check.finish(r); };
  const reader = evenOddMask(closedOut(), check.x, check.y);
  // GateLab reading the file back, on its own single-precision values: the Cytobank format's
  // logicle re-expression, held to a reader in double precision alone, left 2 of 4,264 events of a
  // logicle polygon on the public Fortessa file to that rounding.
  const bx = check.back?.x;
  const by = check.back?.y;
  const readerBack = bx && by ? evenOddMask(closedOut(), bx, by) : null;
  const want = (i: number) => (check.inside[i] ? 1 : 0);
  const isWrong = (i: number) => reader[i] !== want(i) || (readerBack !== null && readerBack[i] !== want(i));
  const wrong = new Set<number>();
  for (let i = 0; i < n; i++) if (isWrong(i)) wrong.add(i);
  if (!wrong.size) return;

  // A grid over the written ring's own extent, for the events a split can affect: a split's
  // triangle lies between a chord and the boundary, within that extent (with a margin).
  const xs = ring.map((p) => p.out[0]);
  const ys = ring.map((p) => p.out[1]);
  const pad = (lo: number, hi: number): [number, number] => { const d = (hi - lo) || Math.abs(hi) || 1; return [lo - 0.25 * d, hi + 0.25 * d]; };
  const [gx0, gx1] = pad(Math.min(...xs), Math.max(...xs));
  const [gy0, gy1] = pad(Math.min(...ys), Math.max(...ys));
  const G = 128;
  const cellOf = (v: number, lo: number, hi: number) => Math.min(G - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * G)));
  const buckets: number[][] = Array.from({ length: G * G }, () => []);
  for (let i = 0; i < n; i++) {
    const px = check.x[i];
    const py = check.y[i];
    if (!(px >= gx0 && px <= gx1 && py >= gy0 && py <= gy1)) continue;
    buckets[cellOf(py, gy0, gy1) * G + cellOf(px, gx0, gx1)].push(i);
  }
  const sx = gx1 - gx0;
  const sy = gy1 - gy0;
  const sign = (ax: number, ay: number, bx: number, by: number, px: number, py: number) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  /** Flip the reader's decision for every event inside the triangle P, M, Q. */
  const flipTriangle = (P: [number, number], M: [number, number], Q: [number, number]) => {
    const minX = Math.min(P[0], M[0], Q[0]);
    const maxX = Math.max(P[0], M[0], Q[0]);
    const minY = Math.min(P[1], M[1], Q[1]);
    const maxY = Math.max(P[1], M[1], Q[1]);
    const within = minX >= gx0 && maxX <= gx1 && minY >= gy0 && maxY <= gy1;
    const inTriangle = (px: number, py: number) => {
      if (px < minX || px > maxX || py < minY || py > maxY) return false;
      const d1 = sign(P[0], P[1], M[0], M[1], px, py);
      const d2 = sign(M[0], M[1], Q[0], Q[1], px, py);
      const d3 = sign(Q[0], Q[1], P[0], P[1], px, py);
      return (d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0);
    };
    const test = (i: number) => {
      let changed = false;
      if (inTriangle(check.x[i], check.y[i])) { reader[i] ^= 1; changed = true; }
      if (readerBack && inTriangle(bx![i], by![i])) { readerBack[i] ^= 1; changed = true; }
      if (!changed) return;
      if (isWrong(i)) wrong.add(i); else wrong.delete(i);
    };
    if (!within) { for (let i = 0; i < n; i++) test(i); return; }
    // A cell either side as well, for an event whose value read back lies a rounding from its own.
    const c0 = (v: number, lo: number, hi: number) => Math.max(0, cellOf(v, lo, hi) - 1);
    const c1 = (v: number, lo: number, hi: number) => Math.min(G - 1, cellOf(v, lo, hi) + 1);
    for (let cy = c0(minY, gy0, gy1); cy <= c1(maxY, gy0, gy1); cy++) {
      for (let cx = c0(minX, gx0, gx1); cx <= c1(maxX, gx0, gx1); cx++) for (const i of buckets[cy * G + cx]) test(i);
    }
  };
  // Rounds stop when nothing is left, after 40, or after three that leave as many as before (an
  // event on the boundary itself, which no split moves).
  let stalled = 0;
  let before = wrong.size;
  for (let round = 0; round < 40 && wrong.size && stalled < 3; round++) {
    // The chord nearest each such event, in the ring's own extent on each axis.
    const chords = new Set<number>();
    for (const i of wrong) {
      const px = (check.x[i] - gx0) / sx;
      const py = (check.y[i] - gy0) / sy;
      let best = -1;
      let bestD = Infinity;
      for (let j = 0; j < ring.length; j++) {
        const a = ring[j].out;
        const b = ring[(j + 1) % ring.length].out;
        const ax = (a[0] - gx0) / sx; const ay = (a[1] - gy0) / sy;
        const bx = (b[0] - gx0) / sx; const by = (b[1] - gy0) / sy;
        const dx = bx - ax; const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const u = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
        const d = Math.hypot(px - ax - u * dx, py - ay - u * dy);
        if (d < bestD) { bestD = d; best = j; }
      }
      if (best >= 0) chords.add(best);
    }
    let split = false;
    for (const j of [...chords].sort((a, b) => b - a)) {
      const P = ring[j];
      const Q = ring[(j + 1) % ring.length];
      // Q ends P's piece when it begins the next one.
      const tq = Q.e === P.e && Q.t > P.t ? Q.t : 1;
      if (Q.e !== P.e && !(Q.t === 0 && Q.e === (P.e + 1) % curve.pieces)) continue;
      if (!(tq - P.t > 1e-9)) continue;
      const tm = (P.t + tq) / 2;
      const M = toOut(curve.at(P.e, tm));
      if (!Number.isFinite(M[0]) || !Number.isFinite(M[1])) continue;
      ring.splice(j + 1, 0, { e: P.e, t: tm, out: M });
      flipTriangle(P.out, M, Q.out);
      split = true;
    }
    if (!split) break;
    stalled = wrong.size >= before ? stalled + 1 : 0;
    before = wrong.size;
  }
}

/**
 * How close to a polygon's boundary an event of the exported file lies, as a fraction of its own
 * magnitude on each axis (tieBreakPolygon), to count as on it. The notch that settles it passes
 * twice this far beyond the event.
 */
const TIE_MARGIN = 1e-6;

/**
 * A polygon's vertices, in the gate's own space, with the boundary moved a hair past each event of
 * the exported file that lies on it, to the side GateLab decides that event on.
 *
 * GateLab decides on an event's value in the gate's own space held in single precision
 * (Sample.pinnedColumn), and holds it when it lies within 1e-9 of an edge. A reader computes the
 * value itself, in double precision and through its own transform and compensation, and decides an
 * event on an edge by its own rule: FlowKit holds it on some edges and not on others, as a plain
 * even-odd test does. A vertex drawn on an event's own value, as quantized data invites, so left
 * such events to rounding. A rectangle's edge is moved by tieBreak; a polygon gets notches.
 *
 * An event is on the boundary when it lies within TIE_MARGIN of it, measured on each axis as a
 * fraction of the event's own magnitude there, which is what single-precision rounding moves it by a
 * fraction of (or of a thousandth of the file's typical magnitude on that axis, for a value near 0).
 * Such events decided alike and consecutive along the boundary, less than 4 × 50 × TIE_MARGIN
 * apart and with no sharp vertex between them, make a run, and a run makes a notch: the boundary
 * from 50 × TIE_MARGIN before its first event to as far after its last is replaced by the same
 * stretch moved 2 × TIE_MARGIN beyond its events, out of the gate for events GateLab holds and into
 * it for events it leaves out, with its vertices mitred and joined to the boundary half that far
 * before and after. Where GateLab leaves out the events at a sharp vertex's tip, the tip is cut off
 * instead. Each notch is kept only when GateLab, deciding the notched polygon on the file's own
 * events, decides every one of them as before and the events it was made for lie at least
 * TIE_MARGIN / 2 from the new boundary; one that is refused is tried at twice and four times the
 * depth, then split where its events lie farthest apart.
 *
 * Each of these was learnt on the public files. The margin was a fraction of the polygon's own
 * magnitude, which a vertex at a sentinel value made enormous: at −2^31 on the S8 file, where 113
 * events lie, every notch was thousands of units deep, none was kept, and FlowKit left out 47 events
 * on the polygon's edge. A vertex's events were settled by moving it between two points a fixed
 * 50 × TIE_MARGIN along its edges, while events up to twice that far counted as its own, and any
 * such event refused the notch: at a vertex on the GvHD file's lowest value, 1.0, where 181 events
 * lie, FlowKit read 805 events of a logicle polygon GateLab holds 619 of. And a notch is where
 * another file's events are decided by it rather than by GateLab: one reaching from an event on one
 * edge to an event six channels away on the next, around a mitred vertex, moved that stretch of a
 * biex polygon by 0.34% of its raw value, and 7 of 1,918 events of another GvHD file lay in it.
 *
 * `x`, `y` and `inside` are GateLab's own: each event's value in the gate's space and its decision.
 * Events on a clamp (`clamps`, in the gate's space) are the skirts' (skirtRing), and are left out.
 *
 * A polygon GateLab tests at a scale of its own (polygonTestScale: one whose vertices stay below 1/16
 * on an axis, as on a fasinh with a small M) is settled at that scale, its events, clamps and
 * `written` scaled with it by the same power of two, which rounds nothing, and its vertices brought
 * back. The least scale below, FLOOR, is in the gate's units, and at M = 1e-4 the whole scale
 * reached 2.3e-4: every event lay within TIE_MARGIN of it of an edge and near every notch, so the
 * export of one four-vertex polygon on the public PBMC file took 45 s, and at M = 1e-6 did not end.
 */
export function tieBreakPolygon(
  vertices: readonly [number, number][],
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  inside: ArrayLike<number>,
  clamps: { x?: { lo?: number; hi?: number }; y?: { lo?: number; hi?: number } } = {},
  /**
   * Per axis, where the file writes the gate in another space whose values GateLab reads back in
   * single precision (a declared transform other than the gate's own): the written value's magnitude
   * over its rate of change, in the gate's units. A margin that fraction of it is as wide there as a
   * margin of the written value itself, and the scale is at least that. The Cytobank format's
   * logicle, written as arcsinh, carried a notch 1.8e-9 deep in arcsinh, a fraction of its rounding,
   * and GateLab reading it back held 2 of 4,264 events of a polygon on the public Fortessa file it
   * leaves out.
   */
  written: [((v: number) => number) | undefined, ((v: number) => number) | undefined] = [undefined, undefined],
): [number, number][] {
  const [fx, fy] = polygonTestScale(vertices, x, y);
  if (fx === 1 && fy === 1) return tieBreakPolygonAtScale(vertices, x, y, inside, clamps, written);
  const clamp = (c: { lo?: number; hi?: number } | undefined, f: number) => c && {
    ...(c.lo !== undefined ? { lo: c.lo * f } : {}),
    ...(c.hi !== undefined ? { hi: c.hi * f } : {}),
  };
  const scaled = (w: ((v: number) => number) | undefined, f: number) => w && ((v: number) => w(v / f) * f);
  const out = tieBreakPolygonAtScale(
    vertices.map(([vx, vy]) => [vx * fx, vy * fy] as [number, number]),
    Float64Array.from(x, (v) => v * fx),
    Float64Array.from(y, (v) => v * fy),
    inside,
    { x: clamp(clamps.x, fx), y: clamp(clamps.y, fy) },
    [scaled(written[0], fx), scaled(written[1], fy)],
  );
  return out.map(([vx, vy]) => [vx / fx, vy / fy]);
}

function tieBreakPolygonAtScale(
  vertices: readonly [number, number][],
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  inside: ArrayLike<number>,
  clamps: { x?: { lo?: number; hi?: number }; y?: { lo?: number; hi?: number } },
  written: [((v: number) => number) | undefined, ((v: number) => number) | undefined],
): [number, number][] {
  const asGiven = (): [number, number][] => vertices.map((v) => [v[0], v[1]] as [number, number]);
  // A vertex repeated, as a double-click leaves it or a writer that closes its rings explicitly
  // (FlowKit among them) writes the first vertex again last, is an edge of no length, which GateLab's
  // polygon test passes over and which has no side to notch: an event on the repeated vertex was left
  // to rounding. With (1, 1) twice in the GvHD s6a01 logicle polygon, where 181 events lie, FlowKit
  // read 805 events against GateLab's 619, as it did before any notch. The ring is settled without
  // the repeats, which bound the same region for GateLab and for any reader.
  const orig: [number, number][] = [];
  for (const v of vertices) {
    const last = orig[orig.length - 1];
    if (!last || last[0] !== v[0] || last[1] !== v[1]) orig.push([v[0], v[1]]);
  }
  while (orig.length > 1 && orig[0][0] === orig[orig.length - 1][0] && orig[0][1] === orig[orig.length - 1][1]) orig.pop();
  const m = orig.length;
  if (m < 3) return asGiven();
  const beyond = (v: number, c?: { lo?: number; hi?: number }) =>
    !!c && ((c.lo !== undefined && v <= c.lo) || (c.hi !== undefined && v >= c.hi));
  const usable = (v: number, c?: { lo?: number; hi?: number }) => Number.isFinite(v) && Math.abs(v) < SKIRT_FAR && !beyond(v, c);
  /** The magnitude of the file's values on one axis, or, with no event to measure, the polygon's. */
  const scaleOf = (vals: ArrayLike<number>, k: 0 | 1): number => {
    const c = k === 0 ? clamps.x : clamps.y;
    const step = Math.max(1, Math.floor(vals.length / 8192));
    const s: number[] = [];
    for (let i = 0; i < vals.length; i += step) if (usable(vals[i], c)) s.push(vals[i]);
    s.sort((a, b) => a - b);
    const a = s.length ? [s[Math.floor(0.05 * (s.length - 1))], s[Math.ceil(0.95 * (s.length - 1))]]
      : orig.map((v) => v[k]).filter((v) => usable(v, c));
    if (a.length < 2) return 0;
    const lo = Math.min(...a);
    const hi = Math.max(...a);
    return Math.max(hi - lo, Math.abs(lo), Math.abs(hi));
  };
  const sx = scaleOf(x, 0);
  const sy = scaleOf(y, 1);
  if (!(sx > 0) || !(sy > 0)) return asGiven();
  const eps = TIE_MARGIN;
  const lam = 50 * eps;
  // The least scale, whatever the magnitudes: TIE_MARGIN of it is ten times the 1e-9 within which
  // GateLab holds an event on an edge when it reads the file back.
  const FLOOR = 1e-2;
  // How near the boundary an event lies for a notch to reach it, far more than a notch's depth (at
  // most 12 × TIE_MARGIN, 4 times that at a mitred vertex), which are the events it is checked against.
  const NEAR = 4096 * eps;

  const evenOdd = (w: readonly [number, number][], px: number, py: number): boolean => {
    let c = false;
    for (let a = 0, b = w.length - 1; a < w.length; b = a++) {
      const [ax, ay] = w[a];
      const [bx, by] = w[b];
      if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) c = !c;
    }
    return c;
  };
  /**
   * The unit normal of edge j (from vertex j to j + 1) pointing out of the gate, at scale R, where it
   * is at the fraction u along the edge. An edge of a polygon that crosses itself has the gate on one
   * side before a crossing and on the other after it, so the side is found on the stretch of the edge
   * between crossings that holds u, either side of that stretch's middle. Found at the edge's middle,
   * a notch at a vertex of a bowtie was sent into the gate where it should have left it, and refused,
   * and the stack of events on that vertex was left to rounding: 2 to 58 events of the verifier's
   * bowties and crossed quadrilaterals on the public GvHD, S8 and Bodenmiller files.
   */
  const outward = (j: number, R: [number, number], u = 0.5): [number, number] | null => {
    const a = orig[j];
    const b = orig[(j + 1) % m];
    const dx = (b[0] - a[0]) / R[0];
    const dy = (b[1] - a[1]) / R[1];
    const len = Math.hypot(dx, dy);
    if (!(len > 0) || !Number.isFinite(len)) return null;
    const nx = -dy / len;
    const ny = dx / len;
    // Where the other edges cross this one, and the stretch between them that holds u.
    let t0 = 0;
    let t1 = 1;
    for (let k = 0; k < m; k++) {
      if (k === j) continue;
      const c = orig[k];
      const e = orig[(k + 1) % m];
      const den = (b[0] - a[0]) * (e[1] - c[1]) - (b[1] - a[1]) * (e[0] - c[0]);
      if (!(den !== 0) || !Number.isFinite(den)) continue;
      const t = ((c[0] - a[0]) * (e[1] - c[1]) - (c[1] - a[1]) * (e[0] - c[0])) / den;
      const s = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
      if (!(t > 0 && t < 1 && s > 0 && s < 1)) continue;
      if (t < u && t > t0) t0 = t;
      if (t > u && t < t1) t1 = t;
    }
    const mid = (t0 + t1) / 2;
    const span = t1 - t0;
    const mx = a[0] + mid * (b[0] - a[0]);
    const my = a[1] + mid * (b[1] - a[1]);
    // Probed either side, nearer and nearer for a sliver narrower than the probe.
    for (let d = Math.min(1e-4 * len * span, 1e-3); d > 1e-13 * Math.min(1, len * span); d /= 1000) {
      const inL = evenOdd(orig, mx + d * nx * R[0], my + d * ny * R[1]);
      const inR = evenOdd(orig, mx - d * nx * R[0], my - d * ny * R[1]);
      if (inL !== inR) return inL ? [-nx, -ny] : [nx, ny];
    }
    return null;
  };
  /** Where a point lies from segment a→b at scale R: its distance and parameter along it. */
  const toSegment = (px: number, py: number, a: readonly number[], b: readonly number[], R: [number, number]) => {
    const dx = (b[0] - a[0]) / R[0];
    const dy = (b[1] - a[1]) / R[1];
    const qx = (px - a[0]) / R[0];
    const qy = (py - a[1]) / R[1];
    const len2 = dx * dx + dy * dy;
    const u = len2 > 0 ? Math.max(0, Math.min(1, (qx * dx + qy * dy) / len2)) : 0;
    return { d: Math.hypot(qx - u * dx, qy - u * dy), u, len: Math.sqrt(len2) };
  };
  // Horizontal bands over the vertices' extent, each listing the edges an event in it can lie within
  // eps of, so an event is measured against a few edges however many the polygon has.
  const B = m > 64 ? Math.min(1024, m >> 2) : 1;
  const ys = orig.map((v) => v[1]).filter((v) => Number.isFinite(v) && Math.abs(v) < SKIRT_FAR);
  const bLo = ys.length ? Math.min(...ys) : 0;
  const bHi = ys.length ? Math.max(...ys) : 1;
  const bandW = (bHi - bLo) / B;
  const bandOf = (v: number) => (B === 1 || !(bandW > 0) ? 1 : v < bLo ? 0 : v >= bHi ? B + 1 : 1 + Math.min(B - 1, Math.floor((v - bLo) / bandW)));
  const bands: number[][] = Array.from({ length: B + 2 }, () => []);
  orig.forEach((a, j) => {
    const b = orig[(j + 1) % m];
    if ((a[0] === b[0] && a[1] === b[1]) || ![a[0], a[1], b[0], b[1]].every(Number.isFinite)) return;
    const pad = 2 * NEAR * Math.max(1e-3 * sy, ...[a[1], b[1]].map((v) => Math.min(Math.abs(v), SKIRT_FAR)));
    for (let k = bandOf(Math.min(a[1], b[1]) - pad); k <= bandOf(Math.max(a[1], b[1]) + pad); k++) bands[k].push(j);
  });

  // The events on the boundary, one per value (events at one value are decided alike), each with
  // the edge it lies on, how far along it and the scale it was measured at.
  type Tie = { x: number; y: number; want: boolean; edge: number; u: number; R: [number, number] };
  const ties = new Map<string, Tie>();
  // Each edge's extent, to pass over the edges an event lies nowhere near before measuring.
  const ex0 = new Float64Array(m);
  const ex1 = new Float64Array(m);
  for (let j = 0; j < m; j++) {
    const a = orig[j];
    const b = orig[(j + 1) % m];
    ex0[j] = Math.min(a[0], b[0]);
    ex1[j] = Math.max(a[0], b[0]);
  }
  const nearby: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const X = x[i];
    const Y = y[i];
    if (!Number.isFinite(X) || !Number.isFinite(Y)) continue;
    const Rx = Math.max(Math.abs(X), 1e-3 * sx, FLOOR, written[0]?.(X) ?? 0);
    const Ry = Math.max(Math.abs(Y), 1e-3 * sy, FLOOR, written[1]?.(Y) ?? 0);
    const padX = 2 * NEAR * Rx;
    let best = NEAR;
    let hj = -1;
    let hu = 0;
    for (const j of bands[bandOf(Y)]) {
      if (X < ex0[j] - padX || X > ex1[j] + padX) continue;
      const a = orig[j];
      const b = orig[(j + 1) % m];
      const dx = (b[0] - a[0]) / Rx;
      const dy = (b[1] - a[1]) / Ry;
      const qx = (X - a[0]) / Rx;
      const qy = (Y - a[1]) / Ry;
      const len2 = dx * dx + dy * dy;
      const u = len2 > 0 ? Math.max(0, Math.min(1, (qx * dx + qy * dy) / len2)) : 0;
      const d = Math.hypot(qx - u * dx, qy - u * dy);
      if (d < best) { best = d; hj = j; hu = u; }
    }
    if (hj < 0) continue;
    nearby.push(i);
    if (!(best < eps) || !usable(X, clamps.x) || !usable(Y, clamps.y)) continue;
    const key = `${X},${Y}`;
    if (!ties.has(key)) ties.set(key, { x: X, y: Y, want: !!inside[i], edge: hj, u: hu, R: [Rx, Ry] });
  }
  if (!ties.size) return asGiven();

  // A polygon of no area, its vertices on one line: GateLab holds the events on it, within 1e-9 of
  // its edges, and a reader holds none by even-odd, since it crosses each edge twice, or all of them,
  // by a rule that holds an event on an edge; no edge has an outside to notch towards. Where GateLab
  // holds the events on it, it is written as the thinnest box about the line, 2, 1, 4 or 8 ×
  // TIE_MARGIN either side and beyond its ends, that holds them at least TIE_MARGIN / 2 inside and
  // decides every other event near it as GateLab does: on the public S8 file, where the r4 verifier's
  // triangle, quadrilateral and bowtie through four stacked points of an integer width channel lay on
  // one line, FlowKit read none of the 58 events GateLab holds. Where GateLab holds none of them, it
  // is written as the same line moved as far to one side, clear of every event.
  {
    const all = [...ties.values()];
    const R: [number, number] = [Math.max(...all.map((t) => t.R[0])), Math.max(...all.map((t) => t.R[1]))];
    const a = orig[0];
    const b = orig.find((v) => v[0] !== a[0] || v[1] !== a[1]);
    if (b && (all.every((t) => t.want) || all.every((t) => !t.want))) {
      const holdsThem = all[0].want;
      const ux = (b[0] - a[0]) / R[0];
      const uy = (b[1] - a[1]) / R[1];
      const len = Math.hypot(ux, uy);
      const [dx, dy] = [ux / len, uy / len];
      const across = (v: readonly number[]) => ((v[0] - a[0]) / R[0]) * dy - ((v[1] - a[1]) / R[1]) * dx;
      const along = (v: readonly number[]) => ((v[0] - a[0]) / R[0]) * dx + ((v[1] - a[1]) / R[1]) * dy;
      if (len > 0 && orig.every((v) => across(v) === 0)) {
        const ts = orig.map(along);
        const t0 = Math.min(...ts);
        const t1 = Math.max(...ts);
        const at = (t: number, sAcross: number): [number, number] =>
          [a[0] + (t * dx - sAcross * dy) * R[0], a[1] + (t * dy + sAcross * dx) * R[1]];
        const shapes: [number, number][][] = [];
        for (const k of [2, 1, 4, 8]) {
          const d = k * eps;
          if (holdsThem) shapes.push([at(t0 - d, -d), at(t1 + d, -d), at(t1 + d, d), at(t0 - d, d)]);
          else for (const side of [1, -1]) shapes.push(orig.map((v) => at(along(v), side * d)));
        }
        for (const box of shapes) {
          const x0 = Math.min(...box.map((p) => p[0])) - 4 * eps * R[0];
          const x1 = Math.max(...box.map((p) => p[0])) + 4 * eps * R[0];
          const y0 = Math.min(...box.map((p) => p[1])) - 4 * eps * R[1];
          const y1 = Math.max(...box.map((p) => p[1])) + 4 * eps * R[1];
          const near = nearby.filter((i) => x[i] >= x0 && x[i] <= x1 && y[i] >= y0 && y[i] <= y1);
          const got = gateMaskPolygon(near.map((i) => x[i]), near.map((i) => y[i]), box, [1, 1]);
          if (near.some((i, j) => !!got[j] !== !!inside[i])) continue;
          const clear = near.every((i) => {
            const Ri: [number, number] = [Math.max(Math.abs(x[i]), 1e-3 * sx, FLOOR), Math.max(Math.abs(y[i]), 1e-3 * sy, FLOOR)];
            let dmin = Infinity;
            for (let j = 0; j < box.length; j++) dmin = Math.min(dmin, toSegment(x[i], y[i], box[j], box[(j + 1) % box.length], Ri).d);
            return dmin >= eps / 2;
          });
          if (clear) return box;
        }
      }
    }
  }

  // Runs of events decided alike, in order along the boundary, whatever edges and vertices lie
  // between; a run shares the gap to the runs decided the other way either side of it. Positions
  // along the boundary are an edge's index plus the fraction along it.
  const posOf = (t: Tie) => (t.u >= 1 ? t.edge + 1 : t.edge + t.u) % m;
  const maxScale = (ts: Tie[]): [number, number] => [Math.max(...ts.map((t) => t.R[0])), Math.max(...ts.map((t) => t.R[1]))];
  const mod = (k: number) => ((k % m) + m) % m;
  const lenAt = (j: number, R: [number, number]) => {
    const a = orig[mod(j)];
    const b = orig[mod(j + 1)];
    return Math.hypot((b[0] - a[0]) / R[0], (b[1] - a[1]) / R[1]);
  };
  /** Boundary distance at scale R from position p forward to q (positions are edge + u, unwrapped). */
  const between = (p: number, q: number, R: [number, number]): number => {
    let d = 0;
    for (let pos = p; pos < q;) {
      const e = Math.floor(pos);
      const end = Math.min(q, e + 1);
      d += (end - pos) * lenAt(e, R);
      pos = end;
    }
    return d;
  };
  /** The position a boundary distance d at scale R from P, forward (dir 1) or back. */
  const advance = (P: number, d: number, R: [number, number], dir: 1 | -1): number | null => {
    let pos = P;
    let rem = d;
    for (let step = 0; step <= 2 * m; step++) {
      const e = dir > 0 ? Math.floor(pos) : Math.ceil(pos) - 1;
      const L = lenAt(e, R);
      const avail = dir > 0 ? e + 1 - pos : pos - e;
      if (avail * L >= rem) return L > 0 ? pos + (dir * rem) / L : pos;
      rem -= avail * L;
      pos = dir > 0 ? e + 1 : e;
    }
    return null;
  };
  const pointAt = (pos: number): [number, number] => {
    const e = Math.floor(pos);
    const u = pos - e;
    return u === 0 ? orig[mod(e)] : onEdgeAt(mod(e), u);
  };
  function onEdgeAt(j: number, u: number): [number, number] {
    const a = orig[j];
    const b = orig[(j + 1) % m];
    return [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])];
  }

  const sorted = [...ties.values()].sort((p, q) => posOf(p) - posOf(q));
  const pairScale = (a: Tie, b: Tie): [number, number] => [Math.max(a.R[0], b.R[0]), Math.max(a.R[1], b.R[1])];
  /** A run: its events in order, the positions they span, and the positions its notch must stay within. */
  type Run = { ties: Tie[]; a: number; b: number; lo: number; hi: number };
  /** Position p moved by whole turns into [ref, ref + m). */
  const unwrap = (p: number, ref: number) => { let q = p; while (q < ref) q += m; while (q >= ref + m) q -= m; return q; };
  const runs: Run[] = [];
  for (const t of sorted) {
    const c = runs[runs.length - 1];
    if (c && c.ties[c.ties.length - 1].want === t.want) { c.ties.push(t); c.b = posOf(t); }
    else runs.push({ ties: [t], a: posOf(t), b: posOf(t), lo: -Infinity, hi: Infinity });
  }
  // The last run continues into the first across vertex 0.
  if (runs.length > 1 && runs[0].ties[0].want === runs[runs.length - 1].ties[0].want) {
    const l = runs.pop()!;
    runs[0] = { ties: [...l.ties, ...runs[0].ties], a: l.a, b: runs[0].b + m, lo: -Infinity, hi: Infinity };
  }
  // A single run goes round from the widest gap between its events, which bounds it on both sides.
  if (runs.length === 1) {
    const ts = runs[0].ties;
    let w = ts.length - 1;
    let widest = -1;
    for (let i = 0; i < ts.length; i++) {
      const p = posOf(ts[i]);
      const q = unwrap(posOf(ts[(i + 1) % ts.length]), p + (ts.length === 1 ? 1e-9 : 0));
      const g = between(p, q, pairScale(ts[i], ts[(i + 1) % ts.length]));
      if (g > widest) { widest = g; w = i; }
    }
    const rot = [...ts.slice(w + 1), ...ts.slice(0, w + 1)];
    const a = posOf(rot[0]);
    const before = unwrap(posOf(ts[w]), a - m);
    const lo = ts.length === 1 ? a - m / 2 : (before + a) / 2;
    runs[0] = { ties: rot, a, b: unwrap(posOf(rot[rot.length - 1]), a), lo, hi: lo + m };
  }
  // Runs decided the other way share the gap between them.
  if (runs.length > 1) {
    runs.forEach((c, ci) => {
      const prev = runs[(ci + runs.length - 1) % runs.length];
      const next = runs[(ci + 1) % runs.length];
      const pb = unwrap(prev.b, c.a - m);
      c.lo = (pb + c.a) / 2;
      c.hi = (c.b + unwrap(next.a, c.b)) / 2;
    });
  }
  // A notch stays a hair deep and near its events: a run is cut where two of its events lie more
  // than GAP apart along the boundary, unless both lie on one edge along an axis, where the events a
  // notch passes near are the ones on the edge's own value, decided alike; and at a vertex between
  // two of them too sharp to mitre within SHARP times the notch's depth, which keeps its place.
  const GAP = 4 * lam;
  const alongAxis = (j: number) => { const a = orig[mod(j)]; const b = orig[mod(j + 1)]; return a[0] === b[0] || a[1] === b[1]; };
  const SHARP = 4;
  const sharp = (k: number, R: [number, number]): boolean => {
    const n1 = outward(mod(k - 1), R, 1);
    const n2 = outward(mod(k), R, 0);
    if (!n1 || !n2) return true;
    const den = 1 + n1[0] * n2[0] + n1[1] * n2[1];
    return !(Math.hypot(n1[0] + n2[0], n1[1] + n2[1]) / den <= SHARP);
  };
  // Events at a sharp vertex's tip, all decided alike, are settled on their own: GateLab leaving
  // them out, the tip is cut off (notchesOf), and nothing else goes near it.
  const tipRange = new Map<number, [number, number]>();
  const tips: Run[] = [];
  const tipOf = (t: Tie): number | null => {
    for (const k of [t.edge, t.edge + 1]) {
      const V = orig[mod(k)];
      if (Math.hypot((t.x - V[0]) / t.R[0], (t.y - V[1]) / t.R[1]) < lam && sharp(k, t.R)) return mod(k);
    }
    return null;
  };
  const atTip = new Map<number, Tie[]>();
  for (const c of runs) for (const t of c.ties) { const k = tipOf(t); if (k !== null) (atTip.get(k) ?? atTip.set(k, []).get(k)!).push(t); }
  for (const [k, ts] of atTip) {
    if (ts.some((t) => t.want !== ts[0].want)) { atTip.delete(k); continue; }
    const R = maxScale(ts);
    const lo = advance(k, 2 * lam, R, -1);
    const hi = advance(k, 2 * lam, R, 1);
    if (lo === null || hi === null) { atTip.delete(k); continue; }
    const pos = ts.map((t) => unwrap(posOf(t), k - m / 2));
    tipRange.set(k, [lo, hi]);
    tips.push({ ties: ts, a: Math.min(...pos), b: Math.max(...pos), lo, hi });
  }
  const tipTies = new Set([...atTip.values()].flat());
  const pieces: Run[] = [...tips];
  for (const c0 of runs) {
    const ties = c0.ties.filter((t) => !tipTies.has(t));
    if (!ties.length) continue;
    const c = { ...c0, ties, a: unwrap(posOf(ties[0]), c0.a) };
    let cur: Tie[] = [c.ties[0]];
    let a = c.a;
    let lo = c.lo;
    let p = c.a;
    const close = (end: number, hi: number) => pieces.push({ ties: cur, a, b: end, lo, hi });
    for (let i = 1; i < c.ties.length; i++) {
      const t = c.ties[i];
      const q = unwrap(posOf(t), p);
      const R = pairScale(c.ties[i - 1], t);
      const oneEdge = Math.floor(p) === Math.floor(q) && p !== Math.floor(p) && alongAxis(Math.floor(p));
      let cut: [number, number] | null = !oneEdge && between(p, q, R) > GAP ? [(p + q) / 2, (p + q) / 2] : null;
      for (let k = Math.floor(p) + 1; cut === null && k < q; k++) {
        const r = tipRange.get(mod(k));
        if (r) cut = [r[0] + (k - mod(k)), r[1] + (k - mod(k))];
        else if (sharp(k, R)) cut = [k, k];
      }
      if (cut !== null) {
        close(p, cut[0]);
        cur = [t];
        a = q;
        lo = cut[1];
      } else cur.push(t);
      p = q;
    }
    close(p, c.hi);
  }
  // No notch reaches into a tip's.
  for (const c of pieces) {
    if (tips.includes(c)) continue;
    for (const [tl, th] of tipRange.values()) {
      for (const j of [-1, 0, 1]) {
        if (th + j * m <= c.a && th + j * m > c.lo) c.lo = th + j * m;
        if (tl + j * m >= c.b && tl + j * m < c.hi) c.hi = tl + j * m;
      }
    }
  }

  /** A notch: the points replacing the boundary from position s0 to e0 (unwrapped, e0 > s0). */
  type Feature = { s0: number; e0: number; pts: [number, number][]; ties: Tie[]; R: [number, number] };
  /** A run's notch, at one, two and four times its depth, or none where it cannot be drawn. */
  const notchesOf = (c: Run): Feature[] => {
    const R = maxScale(c.ties);
    const reachB = advance(c.a, lam, R, -1);
    const reachA = advance(c.b, lam, R, 1);
    if (reachB === null || reachA === null) return [];
    const s0 = Math.max(reachB, c.lo);
    const e0 = Math.min(reachA, c.hi);
    if (!(s0 < c.a) || !(e0 > c.b) || !(e0 - s0 < m)) return [];
    const s1 = (s0 + c.a) / 2;
    const e1 = (c.b + e0) / 2;
    // How far beyond the boundary each event lies, on its own edge's outward normal.
    const normals = new Map<string, [number, number] | null>();
    /** Edge j's outward normal where it is at the fraction u along it (outward). */
    const normal = (j: number, u: number) => {
      const k = mod(j);
      const key = `${k}|${u}`;
      if (!normals.has(key)) normals.set(key, outward(k, R, u));
      return normals.get(key)!;
    };
    const d: number[] = [];
    for (const t of c.ties) {
      const n = normal(t.edge, t.u);
      if (!n) return [];
      const a = orig[t.edge];
      d.push(((t.x - a[0]) / R[0]) * n[0] + ((t.y - a[1]) / R[1]) * n[1]);
    }
    // 2 × TIE_MARGIN beyond the farthest of them, or 1, 4 or 8 times, where that is refused.
    const depth = (k: number) => (c.ties[0].want ? Math.max(...d) + k * eps : Math.min(...d) - k * eps);
    const out: Feature[] = [];
    // Events left out at a vertex too sharp to mitre (a thin triangle's tip, whose inner offsets
    // cross beyond it) are cut off with the tip instead: a chord across both edges, far enough from
    // the vertex that every such event lies beyond it.
    const tip = Math.round((c.a + c.b) / 2);
    if (!c.ties[0].want && c.ties.every((t) => Math.hypot((t.x - orig[mod(tip)][0]) / R[0], (t.y - orig[mod(tip)][1]) / R[1]) < lam)) {
      const k = tip;
      const V = orig[mod(k)];
      const P = orig[mod(k - 1)];
      const N = orig[mod(k + 1)];
      const toP = [(P[0] - V[0]) / R[0], (P[1] - V[1]) / R[1]];
      const toN = [(N[0] - V[0]) / R[0], (N[1] - V[1]) / R[1]];
      const L1 = Math.hypot(toP[0], toP[1]);
      const L2 = Math.hypot(toN[0], toN[1]);
      const cos2 = L1 > 0 && L2 > 0 ? (toP[0] * toN[0] + toP[1] * toN[1]) / (L1 * L2) : -1;
      if (cos2 > 0.5) {
        const reach = Math.max(...c.ties.map((t) => Math.hypot((t.x - V[0]) / R[0], (t.y - V[1]) / R[1])));
        const cosA = Math.sqrt((1 + cos2) / 2);
        for (const s of [1, 2, 4]) {
          const T = (s * (reach + 2 * eps)) / cosA;
          if (!(T < 0.45 * Math.min(L1, L2))) break;
          const s0t = k - T / L1;
          const e0t = k + T / L2;
          if (!(s0t > c.lo) || !(e0t < c.hi)) break;
          out.push({ s0: s0t, e0: e0t, pts: [pointAt(s0t), pointAt(e0t)], ties: c.ties, R });
        }
      }
    }
    for (const k of [2, 1, 4, 8]) {
      const off = depth(k);
      const at = (p: [number, number], dx: number, dy: number): [number, number] => [p[0] + dx * R[0], p[1] + dy * R[1]];
      const lifted = (pos: number): [number, number][] | null => {
        const e = Math.floor(pos);
        const p = pointAt(pos);
        if (pos !== e) {
          const n = normal(e, pos - e);
          return n ? [at(p, off * n[0], off * n[1])] : null;
        }
        // A vertex, mitred: the point `off` beyond both of its edges, which lies off × |n1 + n2| / den
        // from it. Moved in, only within SHARP times `off` (runs are cut at a sharper vertex); moved
        // out past a sharp vertex, it is capped instead: `off` beyond each edge and beyond the vertex.
        const n1 = normal(e - 1, 1);
        const n2 = normal(e, 0);
        if (!n1 || !n2) return null;
        const den = 1 + n1[0] * n2[0] + n1[1] * n2[1];
        const reach = Math.hypot(n1[0] + n2[0], n1[1] + n2[1]) / den;
        if (off < 0 ? reach <= SHARP : den > 0.5) return [at(p, (off * (n1[0] + n2[0])) / den, (off * (n1[1] + n2[1])) / den)];
        if (off < 0) return null;
        const tx = n1[0] + n2[0];
        const ty = n1[1] + n2[1];
        const tl = Math.hypot(tx, ty);
        // Beyond the vertex: along the bisector, or, for edges that fold back, along the edge's line.
        const [ux, uy] = tl > 1e-9 ? [tx / tl, ty / tl] : [n1[1], -n1[0]];
        return [at(p, off * n1[0], off * n1[1]), at(p, off * (n1[0] + ux), off * (n1[1] + uy)),
          at(p, off * (n2[0] + ux), off * (n2[1] + uy)), at(p, off * n2[0], off * n2[1])];
      };
      // Vertices within the joins stay where they are.
      const kept = (from: number, to: number) => {
        const pts: [number, number][] = [];
        for (let k = Math.floor(from) + 1; k < to; k++) pts.push(orig[mod(k)]);
        return [pts];
      };
      const chain: ([number, number][] | null)[] = [[pointAt(s0)], ...kept(s0, s1), lifted(s1)];
      for (let k = Math.floor(s1) + 1; k < e1; k++) chain.push(lifted(k));
      chain.push(lifted(e1), ...kept(e1, e0), [pointAt(e0)]);
      if (chain.some((p) => p === null)) break;
      out.push({ s0, e0, pts: (chain as [number, number][][]).flat(), ties: c.ties, R });
    }
    return out;
  };

  const build = (kept: Feature[]): [number, number][] => {
    if (!kept.length) return orig;
    // Walk once round from the end of a notch, which no other notch overlaps.
    const covered = (k: number) => kept.some((f) => [k, k + m, k - m, k + 2 * m].some((q) => q >= f.s0 && q <= f.e0));
    const p0 = ((kept[0].e0 % m) + m) % m;
    const items: { pos: number; pts: [number, number][] }[] = [];
    for (let k = Math.floor(p0) + 1; k <= Math.floor(p0) + m; k++) if (!covered(k)) items.push({ pos: k, pts: [orig[mod(k)]] });
    for (const f of kept) items.push({ pos: unwrap(f.s0, p0), pts: f.pts });
    items.sort((p, q) => p.pos - q.pos);
    const out: [number, number][] = [];
    for (const it of items) {
      for (const p of it.pts) {
        const last = out[out.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
      }
    }
    while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
    return out;
  };
  /** A point's distance from a ring, at scale R. */
  const distTo = (w: [number, number][], px: number, py: number, R: [number, number]) => {
    let best = Infinity;
    for (let a = 0, b = w.length - 1; a < w.length; b = a++) best = Math.min(best, toSegment(px, py, w[b], w[a], R).d);
    return best;
  };
  const accepts = (f: Feature, kept: Feature[]): boolean => {
    const pts = [...f.pts];
    for (let k = Math.ceil(f.s0); k <= f.e0; k++) pts.push(orig[mod(k)]);
    if (pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || beyond(p[0], clamps.x) || beyond(p[1], clamps.y))) return false;
    const trial = build([...kept, f]);
    // Only events near the notch can be decided differently by it.
    const x0 = Math.min(...pts.map((p) => p[0])) - 4 * eps * f.R[0];
    const x1 = Math.max(...pts.map((p) => p[0])) + 4 * eps * f.R[0];
    const y0 = Math.min(...pts.map((p) => p[1])) - 4 * eps * f.R[1];
    const y1 = Math.max(...pts.map((p) => p[1])) + 4 * eps * f.R[1];
    const near = nearby.filter((i) => x[i] >= x0 && x[i] <= x1 && y[i] >= y0 && y[i] <= y1);
    const got = gateMaskPolygon(near.map((i) => x[i]), near.map((i) => y[i]), trial, [1, 1]);
    if (near.some((i, k) => !!got[k] !== !!inside[i])) return false;
    if (f.ties.some((t) => distTo(trial, t.x, t.y, f.R) < eps / 2)) return false;
    // Nor does it pass within TIE_MARGIN / 2 of any other event, which a reader's rounding could then
    // put on the other side: an event 3.4 TIE_MARGIN from a flog polygon's edge on the public PBMC
    // file was left 3e-8 from a neighbouring notch, and FlowKit read it on the other side.
    const own = new Set(f.ties.map((t) => `${t.x},${t.y}`));
    for (const i of near) {
      if (own.has(`${x[i]},${y[i]}`)) continue;
      const R: [number, number] = [Math.max(Math.abs(x[i]), 1e-3 * sx, FLOOR, written[0]?.(x[i]) ?? 0), Math.max(Math.abs(y[i]), 1e-3 * sy, FLOOR, written[1]?.(y[i]) ?? 0)];
      for (let j = 0; j + 1 < f.pts.length; j++) if (toSegment(x[i], y[i], f.pts[j], f.pts[j + 1], R).d < eps / 2) return false;
    }
    return true;
  };
  // A run whose notch is refused is split where its events lie farthest apart, and each part tried
  // on its own, down to single events.
  const kept: Feature[] = [];
  const queue = [...pieces];
  while (queue.length) {
    const c = queue.shift()!;
    const f = notchesOf(c).find((alt) => accepts(alt, kept));
    if (f) { kept.push(f); continue; }
    if (c.ties.length < 2) continue;
    let at = 0;
    let widest = -1;
    for (let i = 0; i + 1 < c.ties.length; i++) {
      const p = posOf(c.ties[i]);
      let q = posOf(c.ties[i + 1]);
      while (q < p) q += m;
      const g = between(p, q, pairScale(c.ties[i], c.ties[i + 1]));
      if (g > widest) { widest = g; at = i; }
    }
    const first = c.ties.slice(0, at + 1);
    const second = c.ties.slice(at + 1);
    const bFirst = unwrap(posOf(first[first.length - 1]), c.a);
    const aSecond = unwrap(posOf(second[0]), bFirst);
    const mid = (bFirst + aSecond) / 2;
    queue.unshift(
      { ties: first, a: c.a, b: bFirst, lo: c.lo, hi: mid },
      { ties: second, a: aSecond, b: c.b, lo: mid, hi: c.hi },
    );
  }
  return kept.length ? build(kept) : asGiven();
}

/**
 * How far a densified edge may stray from the gate where GateLab evaluates it, as a fraction of the
 * gate's extent there (densifyForExport), where the export space bends smoothly: a FlowJo log or
 * GateLab flog polygon on its floor written in raw space, and an ellipse on one of those or on
 * biex. Logicle re-expressed as arcsinh for Cytobank takes REEXPRESS_TOLERANCE. A biex polygon
 * needs none, being split at its table's entries.
 *
 * Holding to the exporting file's events leaves another file's events within this distance of the
 * boundary to chance. At 0.05% a log floor polygon exported from one of the public GvHD files
 * moved up to 17 of 16,316 events (0.104%) on another, and 29 of 26,205 for a flog one; at 0.01%
 * the most was 1 of 1,099, for 35% more vertices on those gates.
 */
const DENSIFY_TOLERANCE = 0.0001;

/**
 * DENSIFY_TOLERANCE for a gate re-expressed in a transform the file declares, which is logicle
 * written as arcsinh for Cytobank, the format having no logicle, and an ellipse on it.
 *
 * At 0.01% of the gate's extent, a logicle polygon exported from one of the public GvHD files and
 * read on the other 34 moved more than 0.1% of its events on 24 of them (67 of 3,701 at most), and
 * on 3 of the 16 Bodenmiller files, in FlowKit and in GateLab's re-import: GvHD's values sit on a
 * lattice, and every lattice point the exporting file has no event on is left to the tolerance. At
 * 0.001% the GvHD count was 3 files (12 of 3,701), and at 0.0001% none, on either dataset or the
 * PBMC FMO controls. The cost is vertices: the Cytobank format of the verifier's PBMC strategy grew
 * from 5.4 to 7.1 MB, GvHD's from 1.7 to 2.8 MB.
 */
const REEXPRESS_TOLERANCE = 0.000001;

/**
 * The raw value that stands for "beyond any event" on a skirt's outer edge (skirtRing): far past
 * anything a cytometer records, and still finite in single precision and when squared, since
 * readers (GateLab's own point-in-polygon among them) square edge lengths.
 */
const SKIRT_FAR = 1e15;

/** An ellipse's extent on each axis, [lo, hi], in its own space. */
function ellipseExtent(g: EllipseGate): [number[], number[]] {
  const rx = Math.sqrt(Math.max(0, g.distance_square * g.covariance[0][0]));
  const ry = Math.sqrt(Math.max(0, g.distance_square * g.covariance[1][1]));
  return [[g.mean[0] - rx, g.mean[0] + rx], [g.mean[1] - ry, g.mean[1] + ry]];
}

/** The same axis written in raw space, for a rectangle edge at its clamp (GateAxisExport.clamp). */
function clampedAxis(a: GateAxisExport): GateAxisExport {
  const c = a.clamp!;
  const g = c.gain ?? 1;
  return {
    trId: null, cofactor: a.cofactor, convert: (v) => c.toRaw(v) / g, back: (u) => c.fromRaw(u * g), rawToExport: (v) => v / g,
  };
}

/**
 * The axis a polygon is written on: the same axis, or, when the polygon reaches the axis's clamp
 * and the axis declares a transform (a FlowJo log or a GateLab flog floor), that axis in raw space,
 * densified and skirted as a biex polygon is. Declared as flog, a polygon cannot hold the events
 * below the floor, which GateLab puts on it: on the public PBMC file a log polygon on the floor
 * kept 9,101 of 54,784 events in FlowKit and in GateLab's own re-import, and a FlowJo log by biex
 * polygon differed by 36,739 of 54,541. Off the floor it stays flog, which is exact.
 */
function polygonAxis(a: GateAxisExport, [lo, hi]: number[]): GateAxisExport {
  const c = a.clamp;
  if (!c || a.trId === null) return a;
  const reaches = (c.lo !== undefined && lo <= c.lo) || (c.hi !== undefined && hi >= c.hi);
  if (!reaches) return a;
  const g = c.gain ?? 1;
  return {
    trId: null, cofactor: a.cofactor, convert: (v) => c.toRaw(v) / g, back: (u) => c.fromRaw(u * g), needsDensify: true,
    rawToExport: (v) => v / g, clamp: c,
  };
}

/**
 * A strip's end on one axis, for a strip beyond the other axis's clamp on side `strip`. For a lone
 * vertex on the clamp (`alone`), NaN when GateLab holds nothing beyond the clamp there.
 */
type StripEnd = (w: number, side: "lo" | "hi", strip: "lo" | "hi", alone?: boolean) => number;

/**
 * A polygon written in raw space, extended past its axes' clamps so that a standard reader keeps
 * what GateLab keeps there.
 *
 * GateLab evaluates an event beyond a clamp at the clamp (GateAxisExport.clamp), and its
 * point-in-polygon counts the boundary as inside. So an event below the lower clamp of y is in the
 * gate when its x falls along a polygon edge lying ON that clamp, and an event beyond both clamps
 * of a corner is in the gate when the polygon has a vertex at that corner. In raw space those are,
 * exactly, a strip below each such edge and the quadrant beyond each such corner. Each is added to
 * the ring where it touches: an edge v→w on a clamp becomes v, v', w', w with v' and w' carried out
 * to ±SKIRT_FAR, and a corner vertex gains a loop out round its quadrant and back. The loops retrace
 * a segment of the ring, which even-odd and nonzero point-in-polygon tests both read as the union.
 *
 * `x` and `y` give each axis's clamps as RAW values; a vertex lies on a clamp when its coordinate
 * is at or beyond it, which is where a clamped inverse puts every coordinate beyond the table.
 */
export function skirtRing(
  ring: [number, number][],
  x: { lo?: number; hi?: number },
  y: { lo?: number; hi?: number },
  /**
   * Where a strip along one axis's clamp ends on the OTHER axis, from the written end of the
   * stretch (`ends[0]` for x values, the ends of a strip beyond a y clamp; `ends[1]` for y values).
   * A reader holds a strip from its low end up to, not including, its high end; GateLab holds an
   * event beyond the clamp exactly when its own coordinate on the other axis lies on the stretch.
   * Without this, an event whose value is the stretch's end, as a vertex drawn on an event puts
   * it, was decided by which way the end rounded: 54 of 7,905 events on the public Fortessa file.
   */
  ends?: [StripEnd | undefined, StripEnd | undefined],
  /**
   * Where each axis's skirted clamp edge is written, per side: a hair inside the clamp, so that an
   * event exactly at the clamp's own raw value lies strictly within the skirt for every reader.
   * One double inside when not given.
   */
  inset?: [{ lo?: number; hi?: number } | undefined, { lo?: number; hi?: number } | undefined],
  /**
   * Whether GateLab holds the corner of the x clamp on side `sx` and the y clamp on side `sy`, the
   * point at which it places every event beyond both. Given, it decides which corners are skirted,
   * and a corner GateLab holds is skirted from the vertex on it, or from the vertex on one of its
   * clamps within rounding of it: a gate whose boundary runs through the corner comes out of the clip
   * a hair to one side of it, and the events there went to no reader (2,601 of 3,929 events of an
   * ellipse through the corner of FlowJo log's floors on the public Fortessa file, 8,385 of 11,698 on
   * the DiVa file, and 89,057 of a polygon through a biex table's top corner on the PBMC file). Not
   * given, a corner is skirted where a vertex on it ends an edge.
   */
  corner?: (sx: "lo" | "hi", sy: "lo" | "hi") => boolean,
): [number, number][] {
  const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring;
  const on = (v: [number, number], k: 0 | 1, side: "lo" | "hi"): boolean => {
    const c = (k === 0 ? x : y)[side];
    return c !== undefined && (side === "lo" ? v[k] <= c : v[k] >= c);
  };
  const far = (side: "lo" | "hi") => (side === "lo" ? -SKIRT_FAR : SKIRT_FAR);
  // The stretches of each clamp the polygon's edges lie along, merged. One strip per edge made two
  // edges along the same stretch, a polygon retracing its floor, cancel each other there under
  // even-odd, and a reader lost what GateLab holds (57 of 379 events on the public Aurora file).
  type Side = "lo" | "hi";
  const strips: { k: 0 | 1; side: Side; iv: [number, number]; alone?: boolean }[] = [];
  for (const k of [0, 1] as const) {
    for (const side of ["lo", "hi"] as const) {
      const o = 1 - k;
      const ivs: [number, number][] = [];
      for (let i = 0; i < pts.length; i++) {
        const v = pts[i];
        const w = pts[(i + 1) % pts.length];
        if (on(v, k, side) && on(w, k, side) && v[o] !== w[o]) ivs.push([Math.min(v[o], w[o]), Math.max(v[o], w[o])]);
      }
      ivs.sort((a, b) => a[0] - b[0]);
      for (const iv of ivs) {
        const last = strips.length && strips[strips.length - 1].k === k && strips[strips.length - 1].side === side
          ? strips[strips.length - 1] : null;
        if (last && iv[0] <= last.iv[1]) last.iv[1] = Math.max(last.iv[1], iv[1]);
        else strips.push({ k, side, iv: [iv[0], iv[1]] });
      }
    }
  }
  // Each corner a vertex lies beyond both clamps of, once, where GateLab holds the corner's point,
  // at which it holds the events beyond the corner: where that vertex ends an edge of some length,
  // and where the whole ring is that one point (below). A ring of several points that reaches the
  // corner only through a repeated vertex ending no edge was skirted too, and held every event beyond
  // the corner where GateLab held none.
  const endsEdge = (i: number) => {
    const v = pts[i];
    return [pts[(i + pts.length - 1) % pts.length], pts[(i + 1) % pts.length]].some((w) => w[0] !== v[0] || w[1] !== v[1]);
  };
  // A ring collapsed onto the one point, every vertex the same: GateLab's polygon test holds that
  // point since feat/flowjo-grid (gates.ts, gateMaskPolygon), as FlowJo's grid holds a polygon all
  // on one channel, so its corner is skirted too. fix/gatingml-hardening (a54cb59) had dropped the
  // skirt for such a ring when GateLab held nothing for it.
  const onePoint = pts.every((w) => w[0] === pts[0][0] && w[1] === pts[0][1]);
  const corners: { sx: Side; sy: Side; at: number }[] = [];
  for (const sx of ["lo", "hi"] as const) {
    for (const sy of ["lo", "hi"] as const) {
      const cx = x[sx];
      const cy = y[sy];
      if (cx === undefined || cy === undefined) continue;
      if (!corner) {
        const at = pts.findIndex((v, i) => on(v, 0, sx) && on(v, 1, sy) && (onePoint || endsEdge(i)));
        if (at >= 0) corners.push({ sx, sy, at });
        continue;
      }
      if (!corner(sx, sy)) continue;
      let at = -1;
      let best = Infinity;
      pts.forEach((v, i) => {
        const onX = on(v, 0, sx);
        const onY = on(v, 1, sy);
        if (!onX && !onY) return;
        const d = Math.max(onX ? 0 : Math.abs(v[0] - cx) / Math.max(1, Math.abs(cx)), onY ? 0 : Math.abs(v[1] - cy) / Math.max(1, Math.abs(cy)));
        if (d <= 1e-9 && d < best) { best = d; at = i; }
      });
      if (at >= 0) corners.push({ sx, sy, at });
    }
  }
  // A vertex on a clamp that no stretch runs through, whose edges leave the clamp at once. GateLab
  // holds the events beyond the clamp there whose other value it decides onto the vertex, a stack
  // of events at the value the vertex was drawn on: 23 of 883 events of a FlowJo log polygon on the
  // public S8 file, with a vertex on the floor at an event's value, went to no reader. Its strip is
  // as wide as the values GateLab holds there (`ends`), and there is none where it holds nothing.
  for (const k of [0, 1] as const) {
    for (const side of ["lo", "hi"] as const) {
      const o = (1 - k) as 0 | 1;
      pts.forEach((v, i) => {
        // With `ends`, GateLab's own decision says whether it holds anything there, and a point the
        // clip left alone of a gate beyond the clamp, which ends no edge, is skirted where it does.
        if (!on(v, k, side) || on(v, o, "lo") || on(v, o, "hi") || (!ends && !endsEdge(i))) return;
        if (strips.some((st) => st.k === k && st.side === side && v[o] >= st.iv[0] && v[o] <= st.iv[1])) return;
        strips.push({ k, side, iv: [v[o], v[o]], alone: true });
      });
    }
  }
  if (!strips.length && !corners.length && !inset) return ring;
  // Each region is a loop out from a vertex on it and back, so the ring holds the union.
  const loopsAt = new Map<number, [number, number][][]>();
  const attach = (i: number, loop: [number, number][]) => loopsAt.set(i, [...(loopsAt.get(i) ?? []), loop]);
  const drawn: typeof strips = [];
  for (const strip of strips) {
    const { k, side, iv: stretch, alone } = strip;
    const i = pts.findIndex((v) => on(v, k, side) && v[1 - k] >= stretch[0] && v[1 - k] <= stretch[1]);
    const v = pts[i];
    const end = ends?.[1 - k];
    const iv: [number, number] = end ? [end(stretch[0], "lo", side, alone), end(stretch[1], "hi", side, alone)] : stretch;
    if (alone && !(iv[0] < iv[1])) continue;
    drawn.push(strip);
    // Along the clamp to the stretch's far end, out past every event, back, and along to v.
    attach(i, k === 0
      ? [[v[0], iv[1]], [far(side), iv[1]], [far(side), iv[0]], [v[0], iv[0]], v]
      : [[iv[1], v[1]], [iv[1], far(side)], [iv[0], far(side)], [iv[0], v[1]], v]);
  }
  for (const { sx, sy, at } of corners) {
    const v = pts[at];
    attach(at, [[v[0], far(sy)], [far(sx), far(sy)], [far(sx), v[1]], v]);
  }
  if (!drawn.length && !corners.length && !inset) return ring;
  // An event exactly at a clamp's own raw value, as FlowJo log's offset of 1 puts the lowest
  // values of some files, is on the clamp for GateLab, and so held when its other value lies on a
  // stretch; written at that value, the stretch and its skirt shared the edge the event lies on,
  // which each reader decides by its own edge rule (29 of 8,158 events of a FlowJo log polygon on a
  // public GvHD file). So that edge is written inside the clamp (`inset`), and the event lies
  // strictly within the skirt, with no value an event takes between. One double inside, as it was
  // until 2026-09, is within GateLab's own edge tolerance of 1e-9, and GateLab reading the file back
  // held such an event where it ended a stretch: 7 of 1,267 events of a FlowJo log polygon on a
  // public GvHD file. A vertex on a clamp with no skirt, where GateLab holds nothing beyond it, is
  // written there too, so that such an event lies strictly outside it.
  const inward = (p: [number, number]): [number, number] => {
    const q: [number, number] = [p[0], p[1]];
    for (const k of [0, 1] as const) {
      const c = k === 0 ? x : y;
      const skirted = (side: Side) => !!inset?.[k]?.[side] || drawn.some((s) => s.k === k && s.side === side) ||
        corners.some((cn) => (k === 0 ? cn.sx : cn.sy) === side);
      if (c.lo !== undefined && q[k] === c.lo && skirted("lo")) q[k] = inset?.[k]?.lo ?? nextDouble(c.lo, 1);
      else if (c.hi !== undefined && q[k] === c.hi && skirted("hi")) q[k] = inset?.[k]?.hi ?? nextDouble(c.hi, -1);
    }
    return q;
  };
  // Nothing to skirt: the ring as it was, with its points on a clamp written at the inset.
  if (!drawn.length && !corners.length) return ring.map(inward);
  const out: [number, number][] = [];
  const push = (p0: [number, number]) => {
    const p = inward(p0);
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  };
  for (let i = 0; i < pts.length; i++) {
    push(pts[i]);
    for (const loop of loopsAt.get(i) ?? []) for (const p of loop) push(p);
  }
  if (closed) push(out[0]);
  return out;
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
  } else if (trId.startsWith("Tr_Log_")) {
    // Cytobank's own flow exports pair transforms:flog with Log (2), argument "1". Saying
    // Arcsinh here, with the CyTOF cofactor, told Cytobank to read log coordinates as arcsinh.
    flag = 2; arg = "1";
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

/** A rectangle's bounds in export space, per axis; an absent bound is unbounded on that side. */
interface RectBounds {
  x: { lo?: number; hi?: number };
  y: { lo?: number; hi?: number };
}

/**
 * Cytobank definition JSON — vertices already in export (display) space. A rectangle is written
 * from `rect`, its dimensions' own bounds, so the two cannot disagree: an unbounded edge is
 * ∓UNBOUNDED in the definition, where it had kept the clamp's raw value (a FlowJo log rectangle
 * at the floor was bounded at 1 there, holding 8,765 events against the dimension's 51,849).
 */
function definitionJson(
  gate: PolyRectGate,
  xTr: string | null | undefined,
  yTr: string | null | undefined,
  isFlow: boolean,
  xCofactor: number,
  yCofactor: number,
  xRange: [number, number],
  yRange: [number, number],
  rect?: RectBounds,
): string {
  const xs = gate.vertices.map((v) => v[0]);
  const ys = gate.vertices.map((v) => v[1]);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  // The label sits among the gate's own vertices, not out on a skirt (skirtRing), and a rectangle's
  // within the axis range on an unbounded side.
  const labelled = gate.vertices.filter((v) => Math.abs(v[0]) < SKIRT_FAR && Math.abs(v[1]) < SKIRT_FAR);
  const within = (b: { lo?: number; hi?: number }, range: [number, number]) =>
    ((b.lo ?? range[0]) + (b.hi ?? range[1])) / 2;
  const cx = rect ? within(rect.x, xRange) : mean(labelled.length ? labelled.map((v) => v[0]) : xs);
  const cy = rect ? within(rect.y, yRange) : mean(labelled.length ? labelled.map((v) => v[1]) : ys);
  const sx = scaleJson(xTr, isFlow, xCofactor, xRange);
  const sy = scaleJson(yTr, isFlow, yCofactor, yRange);
  const header = `"scale":{"x":${sx},"y":${sy}},"positive":false,"negative":false,"locked":false,"label":[${fmtNum(cx)},${fmtNum(cy)}]`;
  let geom: string;
  if (rect) {
    geom = `"rectangle":{"x1":${fmtNum(rect.x.lo ?? -UNBOUNDED)},"y1":${fmtNum(rect.y.lo ?? -UNBOUNDED)},` +
      `"x2":${fmtNum(rect.x.hi ?? UNBOUNDED)},"y2":${fmtNum(rect.y.hi ?? UNBOUNDED)}}`;
  } else if (gate.gate_type === "rectangle") {
    geom = `"rectangle":{"x1":${fmtNum(Math.min(...xs))},"y1":${fmtNum(Math.min(...ys))},"x2":${fmtNum(Math.max(...xs))},"y2":${fmtNum(Math.max(...ys))}}`;
  } else {
    const vstr = gate.vertices.map((v) => `[${fmtNum(v[0])},${fmtNum(v[1])}]`).join(",");
    geom = `"polygon":{"vertices":[${vstr}]}`;
  }
  return `{${header},${geom}}`;
}

// ── Ellipse emission ─────────────────────────────────────────────────────────
/**
 * EllipsoidGate in the export space: mean/covariance/distanceSquare, in exactly the shape
 * Cytobank's own exports use (distanceSquare as an element with data-type:value). Only called
 * when both axes convert LINEARLY into the export space — identity, the same transformed space
 * (fasinh), or logicle's span scaling — because a covariance through a nonlinear map is not a
 * covariance. Nonlinear cases (biex/wsplog) are densified to a polygon by the caller instead.
 */
function ellipseXml(
  gate: import("./models").EllipseGate, gmlId: string, numId: number, seq: number,
  xTr: string | null | undefined, yTr: string | null | undefined,
  isFlow: boolean, xCofactor: number, yCofactor: number, xName: string, yName: string,
  xCompRef: CompensationRef, yCompRef: CompensationRef,
  xRange: [number, number], yRange: [number, number],
  compensationId: number,
  mean: [number, number], cov: [[number, number], [number, number]],
): string[] {
  const { major, minor, angle } = axesFromCovariance(cov, gate.distance_square);
  const sx = scaleJson(xTr, isFlow, xCofactor, xRange);
  const sy = scaleJson(yTr, isFlow, yCofactor, yRange);
  const def = `{"scale":{"x":${sx},"y":${sy}},"positive":false,"negative":false,"locked":false,` +
    `"label":[${fmtNum(mean[0])},${fmtNum(mean[1])}],` +
    `"ellipse":{"center":[${fmtNum(mean[0])},${fmtNum(mean[1])}],"major":${fmtNum(major)},"minor":${fmtNum(minor)},"angle":${fmtNum(angle)}}}`;
  return [
    `  <gating:EllipsoidGate gating:id="${gmlId}">`,
    ...customInfo(gate.name, numId, seq, "EllipseGate", def, compensationId),
    ...dimXml(xName, xTr, xCompRef),
    ...dimXml(yName, yTr, yCompRef),
    "    <gating:mean>",
    `      <gating:coordinate data-type:value="${fmtNum(mean[0])}" />`,
    `      <gating:coordinate data-type:value="${fmtNum(mean[1])}" />`,
    "    </gating:mean>",
    "    <gating:covarianceMatrix>",
    ...cov.flatMap((row) => [
      "      <gating:row>",
      ...row.map((v) => `        <gating:entry data-type:value="${fmtNum(v)}" />`),
      "      </gating:row>",
    ]),
    "    </gating:covarianceMatrix>",
    `    <gating:distanceSquare data-type:value="${fmtNum(gate.distance_square)}" />`,
    "  </gating:EllipsoidGate>",
  ];
}

// ── Rectangle edge rules ─────────────────────────────────────────────────────
/**
 * A gate as a Gating-ML reader of either edge rule should see it. Gating-ML 2.0 reads a rectangle
 * half-open, min <= x < max (section 5.1.1), and so does FlowKit; flowCore, flowUtils and CytoML
 * read one closed, and so does Cytobank as far as is known, and GateLab a file it cannot tell from
 * those (gatingml.ts, writerRectangleBounds). So each rectangle is written for the reader whose rule
 * is not its own, in its own space before any conversion (gates.ts, rangeForReader): a closed one
 * with its upper bounds just above the edge, a half-open one with them just below, its lower bound
 * following one moved below it. The moved bounds are the ones both the dimension's gating:min and
 * gating:max and Cytobank's definition JSON are written from, so the two agree. Only the upper bound
 * moves unless it passes the lower: a zero-width closed rectangle keeps its minimum where it is.
 * Every other gate is written as it is.
 *
 * What a reader of either rule then holds of a Gating-ML export, without GateLab's record of the
 * rectangle (the FlowJo workspace export moves its bounds for FlowJo's closed rule and places none
 * of them among the file's events; rectangleRecord.ts):
 *   • on a raw or identity axis of float32 data, exactly the rectangle's own events, those on its
 *     edges included: the 1e-13 move stops short of any float32 value it would cross (gates.ts,
 *     float32Side; a bound one double above a float32 event was once moved past it), and every
 *     bound is written as the double it is (fmtNum, the shortest decimal that reads back as that
 *     double; a lower bound on float32(7.1) is 7.099999904632568). Written to 15 significant
 *     digits, as before 2026-09, a lower bound needing 16 or 17 rounded up past the event on it,
 *     and the event fell out;
 *   • on float64 data, the same except for a value lying within the move of an edge, which only
 *     the placement among the exporting file's own events below decides;
 *   • on an axis the file declares a transform for, the exporting file's own events, for a reader
 *     working in double precision from the raw value (FlowKit, flowCore), where a bound within
 *     rounding's width can separate them: GateLab decides an event's transformed value in single
 *     precision, and exactBound and tieBreak place each written bound within that width so that
 *     the reader decides those events alike. Where no bound within it can (events GateLab's
 *     single-precision values put on one side and their double-precision values straddle, or a
 *     bound GateLab's own rule puts through a stack another reader's rule splits), the reader can
 *     differ at the edge; the interoperability sweep's remaining rows of a transformed axis
 *     (fail:flowjo-log-offset among them) are such events. GateLab reading the file back
 *     without the record, in single precision on the written scale, is met too where one bound
 *     can meet both; where it cannot (FlowJo's log, written as flog one decade up, whose single-
 *     precision values are coarser than the gate's own), the bound is placed for the double-
 *     precision reader, and that reading can differ at an edge. Another file's events lying
 *     within float32 rounding of an edge can fall either side for any reader. GateLab's own
 *     reading uses the record.
 */
function forEveryReader(gate: Gate | undefined): Gate | undefined {
  if (!gate || gate.gate_type !== "rectangle") return gate;
  const rule = rectangleRule(gate);
  const range = (vs: number[]) => rangeForReader(Math.min(...vs), Math.max(...vs), rule, otherRectangleRule(rule));
  const [x0, x1] = range(gate.vertices.map((v) => v[0]));
  const [y0, y1] = range(gate.vertices.map((v) => v[1]));
  return { ...gate, vertices: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
}

/**
 * GateLab's own record of every rectangle in the file (rectangleRecord.ts), in the document's
 * custom_info, where Cytobank already accepts GateLab's scales block. It states each rectangle's
 * edge rule, so the file keeps its meaning, and its exact bounds in its own space, which GateLab
 * restores when the bounds the file states are still the ones written here. Before it, the file's
 * own rule for a rectangle without a record: half-open, the standard's, which is what the geometry
 * above was written for (GATINGML_EDGE_RULE_TAG).
 */
function rectangleRecordLines(
  sample: Sample,
  gates: Record<string, Gate>,
  gateOrder: string[],
  gateToGmlId: Map<string, string>,
  gateLines: readonly string[],
  placedFrom: ReadonlyMap<string, string[]> = new Map(),
): string[] {
  const written = writtenRectangleBounds(gateLines);
  const rectangles: Record<string, RectangleRecord> = {};
  for (const gid of gateOrder) {
    const gate = gates[gid];
    const gmlId = gateToGmlId.get(gid);
    if (!gate || gate.gate_type !== "rectangle" || !gmlId || !written.has(gmlId)) continue;
    const from = placedFrom.get(gmlId);
    const moved = from !== undefined && from.some((dim, i) => dim !== written.get(gmlId)![i]);
    rectangles[gmlId] = { ...rectangleRecordOf(sample, gate), written: written.get(gmlId), ...(moved ? { placedFrom: from } : {}) };
  }
  if (!Object.keys(rectangles).length) return [];
  return [
    `    <${GATINGML_EDGE_RULE_TAG}>half-open</${GATINGML_EDGE_RULE_TAG}>`,
    `    <${GATINGML_RECTANGLES_TAG}>`,
    `      <definition>${escText(JSON.stringify({ version: 1, rectangles }))}</definition>`,
    `    </${GATINGML_RECTANGLES_TAG}>`,
  ];
}

/**
 * A polygon on FlowJo's grid, written exactly: the union of the grid cells it selects, as a
 * rectilinear ring in raw units (flowjoGrid.ts, flowJoGridRing), with GateLab's mark carrying the
 * grid, the vertices on their channels and FlowJo's raw vertices, from which GateLab restores the
 * grid gate itself. Null for a gate not on the grid on both axes, which the ordinary path writes.
 * A polygon that selects no cell is written as a degenerate ring at the float32 range's corner,
 * which no event reaches.
 *
 * `gains`: $PnG per axis where the file's coordinates are Gating-ML scale values, stored value /
 * $PnG (the standard format, buildGateExportPlan's withGain). The cells are FlowJo's, on stored
 * values; their edges are written divided by the gain, as every other gate's coordinates are. They
 * were written as stored values until 2026-09-26, which FlowKit read on scale values: on FR-FCM-Z2KY
 * Panel_M_pegi.wsp (FS-A and FS-H at $PnG 2) "Single Cells-1" held 9,670 events for FlowKit and
 * 39,901 in GateLab. An edge lies halfway between two values the column can hold (or, on a float64
 * column, on the first of a channel), and dividing both it and them by the gain keeps it between
 * them in double precision. An outer edge stands for no bound and stays beyond every value: as it
 * is for a gain of 1 or more, divided by the gain below 1, up to half the largest double.
 */
function exportGridPolygon(
  gate: PolyRectGate, gx: FlowJoGridSpec | undefined, gy: FlowJoGridSpec | undefined,
  values: { x: GridEdgeValues; y: GridEdgeValues } = { x: "float32", y: "float32" },
  gains: { x: number; y: number } = { x: 1, y: 1 },
): { gate: PolyRectGate; mark: string[] } | null {
  if (!gx || !gy) return null;
  // The cells are the lattice points the evaluator itself selects: gateMaskPolygon on the
  // polygon's integer vertices, as getGateMask runs it on events' channels. A biex axis has one
  // channel more than its resolution (flowjoGrid.ts: the table's last entry is a channel).
  const nx = flowJoGridScale(gx).cells;
  const ny = flowJoGridScale(gy).cells;
  const px = new Float64Array(nx * ny);
  const py = new Float64Array(nx * ny);
  for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) { px[cy * nx + cx] = cx; py[cy * nx + cx] = cy; }
  const selected = gateMaskPolygon(px, py, gate.vertices);
  const cells = flowJoGridCells(nx, ny, (cx, cy) => selected[cy * nx + cx] === 1);
  const onScale = (edges: Float64Array, v: GridEdgeValues, g: number): Float64Array => {
    if (g === 1) return edges;
    const outer = v === "float64" ? RING_OUTER_FLOAT64 : RING_OUTER;
    const beyond = g < 1 ? Math.min(outer / g, RING_OUTER_FLOAT64) : outer;
    return Float64Array.from(edges, (e) => (Math.abs(e) === outer ? Math.sign(e) * beyond : e / g));
  };
  const xEdges = onScale(flowJoGridEdges(gx, values.x), values.x, gains.x);
  const yEdges = onScale(flowJoGridEdges(gy, values.y), values.y, gains.y);
  const ring = flowJoGridRing(cells, nx, ny, xEdges, yEdges)
    ?? [[xEdges[0], yEdges[0]], [xEdges[0], yEdges[0]], [xEdges[0], yEdges[0]]];
  const mark: FlowJoGridMark = {
    version: 1, x: gx, y: gy,
    vertices: gate.vertices.map(([a, b]) => [a, b]),
    ...(gate.flowjo_vertices?.length === gate.vertices.length ? { raw: gate.flowjo_vertices.map(([a, b]) => [a, b]) } : {}),
    written: fingerprintRing(ring),
  };
  return {
    gate: { ...gate, vertices: ring },
    mark: [`      <${GATINGML_GRID_TAG}>${escText(JSON.stringify(mark))}</${GATINGML_GRID_TAG}>`],
  };
}

/**
 * What the FlowJo export needs of a FlowJo gate, in GateLab's own custom_info elements, as the FlowJo
 * importer hands them over (flowjoWorkspace.ts): a rule-imported rectangle's axes and the bounds
 * FlowJo saved where the rule opened one (PolyRectGate.flowjo_axes, flowjo_bounds), and a continuous
 * FlowJo polygon's own quadId and gateResolution (flowjo_polygon). Evaluation reads none of it;
 * without it, a FlowJo export after a trip through Gating-ML declared other axes and wrote the
 * rule's open bound.
 */
function flowJoInfoLines(gate: PolyRectGate): string[] {
  if (gate.gate_type === "rectangle" && (gate.flowjo_axes || gate.flowjo_bounds)) {
    const axis = (ch: string) => gate.flowjo_axes?.[ch] ?? null;
    const opened = [gate.x_channel, gate.y_channel].map((ch) => gate.flowjo_bounds?.[ch] ?? [null, null]);
    const any = opened.some(([lo, hi]) => lo !== null || hi !== null);
    const value = { x: axis(gate.x_channel), y: axis(gate.y_channel), ...(any ? { opened } : {}) };
    return [`      <${WSP_FLOWJO_AXES_TAG}>${escText(JSON.stringify(value))}</${WSP_FLOWJO_AXES_TAG}>`];
  }
  if (gate.gate_type === "polygon" && gate.flowjo_polygon) {
    return [`      <${WSP_FLOWJO_POLYGON_TAG}>${escText(JSON.stringify(gate.flowjo_polygon))}</${WSP_FLOWJO_POLYGON_TAG}>`];
  }
  return [];
}

// ── XML fragments ────────────────────────────────────────────────────────────
/** A dimension's compensation-ref: the FCS file's own matrix, none, or a spectrumMatrix id. */
type CompensationRef = "FCS" | "uncompensated" | `Spill_${number}`;

function customInfo(
  name: string, numericId: number, gateSeq: number, typeStr: string, defJson: string,
  compensationId: number,
  /** GateLab's own elements beside Cytobank's block, e.g. a grid polygon's mark. */
  extra: readonly string[] = [],
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
    ...extra,
    "    </data-type:custom_info>",
  ];
}

function dimXml(
  dimName: string,
  trId: string | null | undefined,
  compensationRef: CompensationRef,
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

/**
 * A rectangle's dimension bounds, as rectBounds gives them. Gating-ML 2.0 requires at least one of
 * min and max on every dimension (§5.1.1), so a dimension unbounded on both sides, a rectangle
 * spanning both ends of a biex table on that axis, is given gating:min at −UNBOUNDED, below every
 * value: the schema, FlowKit and GateLab read that exactly, and GateLab reads it back as no bound.
 * It had neither until 2026-09.
 */
const oneBoundAtLeast = (b: { lo?: number; hi?: number }): { lo?: number; hi?: number } =>
  b.lo === undefined && b.hi === undefined ? { lo: -UNBOUNDED } : b;

function rectangleXml(
  gate: PolyRectGate, gmlId: string, numId: number, seq: number,
  xTr: string | null | undefined, yTr: string | null | undefined,
  isFlow: boolean, xCofactor: number, yCofactor: number, xName: string, yName: string,
  xCompRef: CompensationRef, yCompRef: CompensationRef,
  xRange: [number, number], yRange: [number, number],
  compensationId: number,
  /** Each axis's bounds in export space; an absent bound is unbounded (see rectBounds). */
  bounds: RectBounds,
  /**
   * A range on one parameter, written as a one-dimensional RectangleGate with the x bounds.
   * GateLab holds a range gate as a rectangle with the same channel on both axes, and a dimension
   * named twice is not a gate other readers evaluate: FlowKit fails on the whole file.
   */
  isRange = false,
  /** GateLab's own elements beside Cytobank's block: a FlowJo rectangle's axes and bounds. */
  extraInfo: readonly string[] = [],
): string[] {
  const def = definitionJson(gate, xTr, yTr, isFlow, xCofactor, yCofactor, xRange, yRange, bounds);
  const x = oneBoundAtLeast(bounds.x);
  const y = oneBoundAtLeast(bounds.y);
  return [
    `  <gating:RectangleGate gating:id="${gmlId}">`,
    ...customInfo(gate.name, numId, seq, "RectangleGate", def, compensationId, extraInfo),
    ...dimXml(xName, xTr, xCompRef, x.lo, x.hi),
    ...(isRange ? [] : dimXml(yName, yTr, yCompRef, y.lo, y.hi)),
    "  </gating:RectangleGate>",
  ];
}

function polygonXml(
  gate: PolyRectGate, gmlId: string, numId: number, seq: number,
  xTr: string | null | undefined, yTr: string | null | undefined,
  isFlow: boolean, xCofactor: number, yCofactor: number, xName: string, yName: string,
  xCompRef: CompensationRef, yCompRef: CompensationRef,
  xRange: [number, number], yRange: [number, number],
  compensationId: number,
  extraInfo: readonly string[] = [],
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
    ...customInfo(gate.name, numId, seq, "PolygonGate", def, compensationId, extraInfo),
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
      : tr.type === "flog"
      ? `    <transforms:flog transforms:T="${fmtNum(tr.T)}" transforms:M="${fmtNum(tr.M)}" />`
      : tr.type === "flin"
      ? `    <transforms:flin transforms:T="${fmtNum(tr.T)}" transforms:A="${fmtNum(tr.A)}" />`
      : `    <transforms:logicle transforms:T="${fmtNum(tr.T)}" transforms:W="${fmtNum(tr.W)}" transforms:M="${fmtNum(tr.M)}" transforms:A="${fmtNum(tr.A)}" />`;
  const bounds =
    (tr.boundMin !== undefined ? ` transforms:boundMin="${fmtNum(tr.boundMin)}"` : "") +
    (tr.boundMax !== undefined ? ` transforms:boundMax="${fmtNum(tr.boundMax)}"` : "");
  return [`  <transforms:transformation transforms:id="${trId}"${bounds}>`, body, "  </transforms:transformation>"];
}

/**
 * The gatelabr_scales compensation `reference` every file has carried since version 4: each
 * dimension's compensation-ref names the matrix its gate was drawn under (FCS, uncompensated, or a
 * spectrumMatrix the file defines, directly or through a Cytobank gate's compensation_id), and
 * `matrix` is that matrix when compensation is on, whether or not it is the FCS file's own.
 *
 * It exists to be refused. Readers written between 2026-07-15 and version 4 accept only "FCS" and
 * "uncompensated" here and stop on anything else, before changing anything: GateLab 0.2.0 to
 * 0.8.3, and the GateLab build GateLabR 1.4.0 to 1.4.7 embed, say "Invalid embedded GateLab scale
 * or compensation metadata.", and GateLabR 1.3.0 to 1.4.7's R importer says "Invalid embedded
 * GateLab compensation state: unsupported matrix reference." Those readers cannot read these files
 * correctly and would otherwise not say so: they take a Cytobank-format exclusion
 * (use-as-complement) as an inclusion, and read a standard-format logicle coordinate on flowCore's
 * scale (T at M), which puts the gate 4.5 times too low on the axis. On the public PBMC strategy,
 * GateLab 0.8.3 read a Cytobank-format export with every event of "Not cells" and 70,717 of
 * "neither A nor B" placed wrongly, and a standard-format export with every logicle population
 * emptied or nearly so.
 *
 * GateLab 0.1.0 and GateLabR 1.0.0 to 1.2.2 predate the check. Their only explicit refusals are of
 * XML that does not parse (GateLab 0.1.0) and of a missing file, xml2 or data (GateLabR), so we
 * know of no construct a valid file could carry to make them refuse. Built or sourced from their
 * tags and run on the public data, they import these files and say nothing, and read them the same
 * way in both formats. They leave out every range gate, written as a one-dimensional RectangleGate,
 * with the populations it defines (GateLab 0.1.0 and GateLabR 1.2.2 on the Bodenmiller file: 279,
 * 816 and 2,022 events, 0 warnings; GateLabR's importer at its 1.0.0, 1.1.0, 1.2.1 and 1.2.2 tags
 * returns nothing for a RectangleGate of fewer than two dimensions). Files of flow data they read
 * wrongly (T cells 0 of 47,255 on the PBMC standard export, Live cells 0 of 79,839 on its Cytobank
 * export), except GateLabR 1.0.0, which cannot load those files' fluorescence channels and stops
 * with an R error. Files of mass cytometry data they read correctly only while every gate is on an
 * arcsinh or linear axis and no population excludes a gate. GateLab 0.1.0 and GateLabR 1.2.2
 * misread gates on logicle, FlowJo biex, FlowJo log or flog axes, which a FlowJo workspace can
 * carry, by 700 to 1,850 of 2,838 events of every population of a generated Bodenmiller strategy.
 * Each exclusion is read as an inclusion ("not B" 137 events against 2,701 on the Bodenmiller
 * file), a population excluding two gates is left out of the standard format and wrongly filled
 * from the Cytobank format, and the populations beneath an excluded gate are moved under a
 * population named Not_Gate_ and the gate's id (standard) or under the excluding population
 * (Cytobank). The release notes state this. Files written before version 4 still say "FCS" or
 * "uncompensated", and still import.
 */
export const COMPENSATION_REFERENCE = "dimensions";

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
    version: 4,
    ...(sample.instrument === "cytof" ? { cytof_cofactor: sample.arcsinhCofactor } : {}),
    channels,
    compensation: {
      enabled: compensationEnabled,
      // COMPENSATION_REFERENCE, in every file whether compensated or not: it is what stops a
      // reader that cannot read this file correctly from reading it at all.
      reference: COMPENSATION_REFERENCE,
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

  // display channel name → dimension name: the FCS $PnN in both formats. Gating-ML's
  // fcs-dimension names a parameter of the FCS file, and $PnN is the name a third-party reader
  // matches against that file. The standard format wrote the display key ("CD3" where the file
  // says "BUV395-A") until 2026-09, which only GateLab could resolve; the importer resolves
  // either.
  const pnnFor = (key: string): string => {
    const idx = sample.index(key);
    const pnn = idx !== undefined ? sample.channels[idx].pnn : undefined;
    return pnn && pnn.length ? pnn : key;
  };

  // The standard format states coordinates on the FCS scale values Gating-ML is defined on
  // (stored value / $PnG); the Cytobank format keeps stored values, as it always has, since
  // whether Cytobank divides by $PnG is not established (gatingmlGain.ts).
  const exportGains: ReadonlyMap<string, number> = cytobankMode ? new Map() : gatingMlGains(sample);
  const exportPlan = buildGateExportPlan(sample, gates, gate_order, cytobankMode, exportGains);
  const trDefs = exportPlan.trDefs;
  const scalesJson = buildScalesJson(sample, opts.globalScales);

  // ── Compensation ──────────────────────────────────────────────────────────────────────────
  //
  // A compensated dimension says which matrix it was compensated with. When that is the FCS
  // file's own, "FCS" says so, and every reader takes the matrix from the file. When it is not
  // (the S6 case: gates drawn under the FlowJo workspace's hand-adjusted DivaCompMtx while the FCS
  // carries the acquisition matrix, 48 of 49 coefficients different), "FCS" hands a reader the
  // wrong matrix. The standard format then writes the matrix itself as a Gating-ML 2.0
  // spectrumMatrix and points each compensated dimension at it by id, naming the dimension by the
  // matrix's fluorochrome (row) name, as §4.2.2 requires of a dimension compensated by a matrix
  // the file defines. The Cytobank format keeps "FCS" on every dimension, as Cytobank's own
  // exports do, and says which matrix in each gate's custom_info compensation_id instead.
  const EXPORTED_MATRIX_ID = 1;
  const SPECTRUM_ID = `Spill_${EXPORTED_MATRIX_ID}` as const;
  const exportCompensationOn = sample.instrument === "flow" && sample.embeddedCompensationEnabled;
  const exportSpillover = exportCompensationOn ? sample.spillover : null;
  const referencesSpectrum = !cytobankMode && exportSpillover !== null && sample.spilloverOrigin.kind === "external";
  // A fluorochrome name must differ from every detector name (§7.2 f) and should not name any
  // other parameter of the FCS either, or a reader resolving names against the file first would
  // take that parameter instead. FlowJo, for one, writes compensated parameters as "Comp-<PnN>".
  const taken = new Set(sample.channels.flatMap((c) => [c.pnn, c.key]));
  let fluorPrefix = "Comp_";
  while (exportSpillover?.channels.some((c) => taken.has(`${fluorPrefix}${pnnFor(c)}`))) fluorPrefix = `_${fluorPrefix}`;
  const fluorochromeOf = (detector: string): string => `${fluorPrefix}${detector}`;
  const isCompensated = (channelKey: string): boolean =>
    isFlow && sample.embeddedCompensationEnabled && !!sample.spillover?.channels.includes(channelKey);
  const compensationRefFor = (channelKey: string): CompensationRef =>
    !isCompensated(channelKey) ? "uncompensated" : referencesSpectrum ? SPECTRUM_ID : "FCS";
  /** The name a dimension gives its parameter: the $PnN, or its fluorochrome name in the matrix. */
  const dimNameFor = (channelKey: string): string =>
    referencesSpectrum && isCompensated(channelKey) ? fluorochromeOf(pnnFor(channelKey)) : pnnFor(channelKey);
  /**
   * How far a standard reader's value for each event may lie from the value this file's own
   * transform gives it, in the written space (tieBreak's `unc`): a few units in the last place of a
   * declared transform, which FlowKit computes its own way, and, on a compensated channel, the
   * rounding of GateLab's compensated value, which FlowKit computes in double precision.
   */
  const readerSlack = (axis: GateAxisExport, channel: string): ((i: number) => number) | undefined => {
    const idx = sample.index(channel);
    if (idx === undefined) return undefined;
    const raw = sample.rawColumnData(idx);
    const compensated = isCompensated(channel);
    if (axis.trId === null && !compensated) return undefined;
    const single = raw instanceof Float32Array;
    return (i) => {
      const r = raw[i];
      const w = axis.rawToExport(r);
      let e = axis.trId !== null ? 8e-15 * Math.max(1, Math.abs(w)) : 0;
      if (compensated) {
        const d = single ? ulp32(r) : 1e-9 * (1 + Math.abs(r));
        const a = Math.abs(axis.rawToExport(r + d) - w);
        const b = Math.abs(axis.rawToExport(r - d) - w);
        e += Number.isFinite(a) && Number.isFinite(b) ? Math.max(a, b) : 0;
      }
      return e;
    };
  };
  /**
   * tieBreakPolygon's `written` scale for an axis written in a declared transform other than the
   * gate's own space: |w| / |dw/dv| at a gate value v, read off a table over the events' range.
   */
  const writtenScale = (a: GateAxisExport, own: ArrayLike<number> | undefined): ((v: number) => number) | undefined => {
    if (a.trId === null || !own || a.convert(0.5) === 0.5 && a.convert(0.25) === 0.25) return undefined;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < own.length; i++) { const v = own[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    if (!(hi > lo)) return undefined;
    const N = 512;
    const at = (v: number) => {
      const h = 1e-4 * (hi - lo);
      const w = a.convert(v);
      const slope = Math.abs(a.convert(v + h) - a.convert(v - h)) / (2 * h);
      const r = Math.abs(w) / slope;
      return Number.isFinite(r) ? r : 0;
    };
    const table = Float64Array.from({ length: N + 1 }, (_, k) => at(lo + ((hi - lo) * k) / N));
    return (v) => {
      const t = Math.max(0, Math.min(N, ((v - lo) / (hi - lo)) * N));
      const k = Math.min(N - 1, Math.floor(t));
      return Math.max(table[k], table[k + 1]);
    };
  };
  /**
   * Each event's value on an axis as GateLab reads the file back (densifyForExport's check.back): a
   * declared transform, as the importer holds it (specFromGmlTransform), in single precision; null on
   * a raw axis, which is read as it is written. The importer holds a flog as the standard's in a
   * file of this mark's version (flogIsStandard), and restates a transform declared on scale values
   * or seconds on stored values (gatesFromGatingMlScale, inTicks): its scale parameter divided by
   * the axis's readScale. Taken on the declaration as written, a channel with $PnG 2 was read back
   * at twice its values, and the check held a densified polygon to events where GateLab does not
   * read them: 2,496 vertices written where 371 hold the same events.
   */
  const readBack = (axis: GateAxisExport, raw: ArrayLike<number>): Float32Array | null => {
    const def = axis.trId !== null ? trDefs.get(axis.trId) : undefined;
    if (!def) return null;
    const k = axis.readScale ?? 1;
    const spec: TransformSpec | null = def.type === "logicle" ? { kind: "logicle", T: def.T / k, W: def.W, M: def.M, A: def.A }
      : def.type === "flog" ? { kind: "flog", T: def.T / k, M: def.M, standard: true }
      : def.type === "fasinh" && def.A === 0 ? { kind: "asinh", cofactor: def.T / Math.sinh(def.M * Math.log(10)) / k }
      : null;
    if (!spec) return null;
    const f = transformFromSpec(spec).forward;
    return Float32Array.from(raw, (v) => f(v));
  };
  // Each gate's vertices are written in the space that gate declares, so the file describes the
  // gate GateLab actually applies rather than a transformed lookalike.
  const displayGate = (
    g: PolyRectGate,
    ax = exportPlan.axis(g.gate_id, g.x_channel),
    ay = exportPlan.axis(g.gate_id, g.y_channel),
    /** The gate as stored: an ellipse written as its boundary is held to the ellipse itself. */
    source: Gate = g,
  ): PolyRectGate => {
    const toOut = (vv: [number, number]): [number, number] => [ax.convert(vv[0]), ay.convert(vv[1])];
    // The part of the gate within its axes' clamps, which holds the same events (clipToClamps).
    const box: ClampBox = { x: { lo: ax.clamp?.lo, hi: ax.clamp?.hi }, y: { lo: ay.clamp?.lo, hi: ay.clamp?.hi } };
    // An ellipse is clipped as itself, not as the polygon it is sampled into, which can miss a cap of
    // it within the box.
    const asDrawn = source.gate_type === "ellipse" ? ellipseCurve(source) : polygonCurve(g.vertices);
    const inTable = clipToClamps(asDrawn, box, g.name);
    const within: [number, number][] = inTable === asDrawn
      ? g.vertices
      : Array.from({ length: inTable.pieces }, (_, e) => inTable.at(e, 0));
    // GateLab's own reading of the file's events for a polygon: each one's value in the gate's
    // space and whether GateLab holds it. An event on the boundary is settled by a notch
    // (tieBreakPolygon), and a densified ring is held to the rest (densifyForExport).
    const ownData = g.gate_type === "polygon" ? sample.gatingDataFor(source) : null;
    const ownMask = ownData ? getGateMask(source, ownData) : null;
    const ownX = ownData?.column(source.x_channel);
    const ownY = ownData?.column(source.y_channel);
    // The scale GateLab tests the polygon at on all of its events (polygonTestScale), for the checks
    // below of its decision on one event.
    const sourceScale = source.gate_type === "polygon" && ownX && ownY ? polygonTestScale(source.vertices, ownX, ownY) : undefined;
    const stored = ownMask && ownX && ownY && source.gate_type === "polygon"
      ? tieBreakPolygon(within, ownX, ownY, ownMask, { x: ax.clamp, y: ay.clamp }, [writtenScale(ax, ownX), writtenScale(ay, ownY)])
      : within;
    const vertices = stored.map(toOut);

    // Writing a gate into a space its edges are not straight in turns each edge into a curve, and
    // a straight segment between the transformed endpoints is no longer the same boundary. Only
    // polygons are affected: a rectangle stays an axis-aligned box under any monotonic transform.
    // A polygon written in raw space keeps what lies beyond its axes' clamps (skirtRing).
    // In the written ring's own units: raw values, or scale values where a gain divides them.
    const rawClamps = (a: GateAxisExport) => a.clamp && a.trId === null
      ? {
          ...(a.clamp.lo !== undefined ? { lo: a.clamp.toRaw(a.clamp.lo) / (a.clamp.gain ?? 1) } : {}),
          ...(a.clamp.hi !== undefined ? { hi: a.clamp.toRaw(a.clamp.hi) / (a.clamp.gain ?? 1) } : {}),
        }
      : {};
    // A strip's end, as GateLab decides it: where the least value it holds is written (a low end),
    // or the next double above where the greatest is (a high end, which a reader leaves out).
    // GateLab decides on the event's value in the gate's own space held in single precision, as
    // exactBound finds for a rectangle's edge. On a raw axis that is the written value's own
    // `back` (none is the identity); on an axis written in a declared transform, a flog axis beside
    // a floor, the event's raw value is found first and then written as a reader computes it.
    //
    // Then, as tieBreak moves a rectangle's edge, the end is moved by no more than rounding's width
    // to decide the file's own events beyond the other axis's clamp as GateLab does, for a reader
    // and for GateLab reading the file back, which takes a declared transform's value in single
    // precision: written as a reader computes it, the low end of a FlowJo log polygon's floor
    // stretch left out 1 of 196 events on the public Aurora file in GateLab's re-import.
    const rawOf = (channel: string) => {
      const idx = sample.index(channel);
      return idx === undefined ? undefined : sample.rawColumnData(idx);
    };
    const stripEnd = (
      a: GateAxisExport, own: ArrayLike<number> | undefined, raw: ArrayLike<number> | undefined,
      other: GateAxisExport, otherOwn: ArrayLike<number> | undefined, isX: boolean, channel: string,
    ) => (w: number, side: "lo" | "hi", strip: "lo" | "hi", alone = false) => {
      if (!Number.isFinite(w) || Math.abs(w) >= SKIRT_FAR) return alone ? NaN : w;
      const c = other.clamp?.[strip];
      // GateLab's own decision on an event beyond the other axis's clamp, which it evaluates on the
      // clamp. Its polygon test holds a point within 1e-9 of an edge, and on axes of very different
      // scales (FlowJo log beside a biex on 256 channels) the edge leaving the end vertex can run so
      // close to the clamp that an event whose value rounds just past the end is held: comparing
      // with the vertex alone put the end short of 63 of 40,041 events on a public GvHD file the
      // export never saw. The end is where GateLab stops holding them, however far that is from the
      // vertex: beside a nearly flat edge leaving the end it is well beyond it, and the comparison
      // with the vertex, which stood where the two differed by more than 0.01%, left 6 and 7 of
      // 5,564 events of the r4 verifier's FlowJo log and flog polygons on the public Fortessa file
      // to no reader.
      const holds = c === undefined ? undefined
        : source.gate_type === "polygon"
          ? (gv: number) => {
              const cf = Math.fround(c);
              return gateMaskPolygon(isX ? [gv] : [cf], isX ? [cf] : [gv], source.vertices, sourceScale)[0] === 1;
            }
          : source.gate_type === "ellipse"
            ? (gv: number) => {
                const cf = Math.fround(c);
                return gateMaskEllipse(isX ? [gv] : [cf], isX ? [cf] : [gv], source)[0] === 1;
              }
            : undefined;
      // A lone vertex's strip is as wide as the values GateLab holds there, and there is none where
      // it holds nothing, however close the vertex's own value comes.
      if (alone && !holds) return NaN;
      const bound = (w0: number, v0: number, back: (u: number) => number, toW: (g: number) => number) => {
        if (alone) {
          // GateLab decides on single-precision values, and the vertex's own value can round to one it
          // leaves out while it holds those beside it: a vertex on a FlowJo log floor at the end of a
          // nearly flat edge holds, within GateLab's 1e-9 edge tolerance, the floor's events a few
          // millionths below it, and its own value rounded above it, where it holds nothing. That
          // left the strip out, and 2 of 2,494 events of a polygon on the public PBMC file to no
          // reader. The strip starts from the nearest value within 64 single-precision steps of the
          // vertex's that GateLab holds.
          const g0 = Math.fround(back(w0));
          const step = ulp32(g0);
          for (let j = 0; j <= 128; j++) {
            const g = g0 + (j % 2 ? 1 : -1) * Math.ceil(j / 2) * step;
            if (!holds!(Math.fround(g))) continue;
            const w1 = j === 0 ? w0 : toW(g);
            return Number.isFinite(w1) && holds!(Math.fround(back(w1))) ? exactBound(w1, v0, back, side, holds) : NaN;
          }
          return NaN;
        }
        const plain = exactBound(w0, v0, back, side);
        const held = holds ? exactBound(w0, v0, back, side, holds) : plain;
        return Number.isFinite(held) ? held : plain;
      };
      let v: number;
      let end: number;
      // Raw, or in a declared transform that does not clamp (logicle, arcsinh, and the Cytobank format's
      // logicle re-expressed as arcsinh): the end is found on the written values themselves. Returned
      // as written, the end of a floor stretch on a biex table's end beside a logicle axis left the
      // events stacked on the vertex there to rounding: 3 and 4 of 288 to 9,223 events of the r4
      // verifier's polygons on the public S8 file in the Cytobank format, 1 of 10 and of 303 on the
      // Aurora file in the standard format.
      if (a.trId === null || !a.clamp) {
        const c0 = a.convert(0);
        const k = a.convert(1) - c0;
        const back = a.back ?? ((u: number) => (k !== 0 ? (u - c0) / k : u));
        v = back(w);
        const u = bound(w, v, back, (g) => a.convert(g));
        if (!Number.isFinite(u)) return NaN;
        end = side === "lo" ? u : nextDouble(u, 1);
      } else {
        const c0 = a.convert(0);
        const k = a.convert(1) - c0;
        const back = a.back ?? ((u: number) => (k !== 0 ? (u - c0) / k : u));
        v = back(w);
        const ofRaw = (r: number) => back(a.rawToExport(r));
        const toRaw = a.clamp.toRaw;
        const u = bound(toRaw(v), v, ofRaw, (g) => toRaw(g));
        if (!Number.isFinite(u)) return NaN;
        const e = a.rawToExport(u);
        if (!Number.isFinite(e)) return alone ? NaN : w;
        end = side === "lo" ? e : nextDouble(e, 1);
      }
      if (!ownMask || !own || !raw || !otherOwn || c === undefined) return end;
      // The events this end decides, as tieBreak reads them: at the end's own value when GateLab
      // holds them, just beyond it when it does not.
      const near = 1e-4 * Math.max(1, Math.abs(v));
      const gate = new Float64Array(own.length).fill(NaN);
      for (let i = 0; i < own.length; i++) {
        if (!(strip === "lo" ? otherOwn[i] <= c : otherOwn[i] >= c) || !(Math.abs(own[i] - v) <= near)) continue;
        gate[i] = ownMask[i] ? v : side === "lo" ? v - near / 2 : v + near / 2;
      }
      // GateLab reading the file back holds an event within 1e-9 of a strip's edge (gateMaskPolygon).
      return tieBreak(end, side, gate, v, (i) => a.rawToExport(raw[i]), a.trId !== null, 4e-9 * Math.max(1, Math.abs(end)), false, readerSlack(a, channel));
    };
    // A skirted clamp edge is written a hair inside the clamp: 1e-8 of its value, or half the way to
    // the file's nearest event inside it where that is nearer, so that no event lies between and an
    // event at the clamp's own raw value is beyond GateLab's 1e-9 edge tolerance when it reads the
    // file back.
    //
    // Inside it as GateLab decides it, on the event's own value: the clamp's raw value is its
    // transform's inverse, which need not be the greatest raw value GateLab places on the clamp.
    // FlowJo log's inverse of its floor with an offset of 49 is 48.99999999999999, and the events at
    // 49 itself, which GateLab places on the floor, were taken for the nearest inside it: no inset
    // was left room for, the edge was written one double inside the clamp, at 49, through them, and
    // FlowKit read 34 of 597 events of polygons with a vertex on that corner of a public GvHD file on
    // the other side. The edge is now written beyond every event GateLab places on the clamp.
    //
    // And, on a compensated channel, beyond what a reader's own compensation may put the events on the
    // clamp at, where there is room before the next event: FlowKit compensates in double precision
    // where GateLab rounds to single, and an event at a FlowJo log offset of 290,885.90625, on the
    // clamp for GateLab, was read 0.003 above an inset 1e-8 of the offset beyond it: 1 of 87,721
    // events of a polygon with a vertex on that corner on the public PBMC file, 2 of 4,907 on the
    // Fortessa file. The inset is then at least half of that difference, up to half the way to the
    // next event.
    const insetOf = (a: GateAxisExport, raw: ArrayLike<number> | undefined, own: ArrayLike<number> | undefined, channel: string) => {
      const c = rawClamps(a);
      const out: { lo?: number; hi?: number } = {};
      const slack = readerSlack(a, channel);
      for (const side of ["lo", "hi"] as const) {
        const cv = c[side];
        const cg = a.clamp?.[side];
        if (cv === undefined || cg === undefined || !raw) continue;
        const inward = side === "lo" ? 1 : -1;
        const cf = Math.fround(cg);
        // The farthest in of the raw values GateLab places on the clamp, and the nearest beyond it.
        let edge = cv;
        let gap = Infinity;
        const onClamp = (i: number) => (own ? (side === "lo" ? own[i] <= cf : own[i] >= cf) : (raw[i] - cv) * inward <= 0);
        for (let i = 0; i < raw.length; i++) if (onClamp(i) && (raw[i] - edge) * inward > 0) edge = raw[i];
        // How far past the edge a reader may read an event GateLab places on the clamp: half the
        // difference readerSlack allows, from the event's own value.
        let reach = 0;
        for (let i = 0; i < raw.length; i++) {
          const d = (raw[i] - edge) * inward;
          if (d > 0 && d < gap && !onClamp(i)) gap = d;
          if (slack && onClamp(i)) reach = Math.max(reach, d + slack(i) / 2);
        }
        const d = Math.min(Math.max(1e-8 * Math.max(1, Math.abs(cv)), reach), gap / 2);
        if (d > 2e-9) out[side] = edge + inward * d;
      }
      return out;
    };
    const insets: [{ lo?: number; hi?: number }, { lo?: number; hi?: number }] =
      [insetOf(ax, rawOf(g.x_channel), ownX, g.x_channel), insetOf(ay, rawOf(g.y_channel), ownY, g.y_channel)];
    // GateLab's own decision at a corner of the clamps, on the value it places events beyond both at.
    const holdsCorner = (sx: "lo" | "hi", sy: "lo" | "hi"): boolean => {
      const cx = ax.clamp?.[sx];
      const cy = ay.clamp?.[sy];
      if (cx === undefined || cy === undefined) return false;
      const px = [Math.fround(cx)];
      const py = [Math.fround(cy)];
      return source.gate_type === "polygon" ? gateMaskPolygon(px, py, source.vertices, sourceScale)[0] === 1
        : source.gate_type === "ellipse" ? gateMaskEllipse(px, py, source)[0] === 1
        : false;
    };
    const skirted = (ring: [number, number][]) =>
      g.gate_type === "polygon"
        ? skirtRing(ring, rawClamps(ax), rawClamps(ay), [
            stripEnd(ax, ownX, rawOf(g.x_channel), ay, ownY, true, g.x_channel),
            stripEnd(ay, ownY, rawOf(g.y_channel), ax, ownX, false, g.y_channel),
          ], insets, holdsCorner)
        : ring;
    if (inTable.point) {
      // Nothing of the gate lies within its axes' clamps but one point on them (clipToClamps).
      // GateLab holds the events it places on a clamp there when its gate holds that point, and
      // nothing else: the point is written skirted where it holds some, and three times over, a
      // polygon no reader holds anything in, where it holds none.
      const P = toOut(inTable.at(0, 0));
      const ring = skirted([P, P]);
      return { ...g, vertices: ring.length >= 3 ? ring : [ring[0], ring[0], ring[0]] };
    }
    if (g.gate_type === "polygon" && [ax, ay].some((a) => a.needsDensify)) {
      // Written in a space that bends it: raw from biex or a log floor, or arcsinh from logicle for
      // Cytobank. Measured where GateLab evaluates it, within DENSIFY_TOLERANCE of the gate's own
      // extent there, and then held to the exported file's own events, so that a reader of the file
      // places none of them differently from GateLab (see densifyForExport). The Cytobank format's
      // logicle re-expression was measured in arcsinh at 0.1% until 2026-09, and moved up to 33
      // events of a population on the public PBMC file.
      // An axis that does not bend is affine (identity, or flog's +1), so its inverse is too.
      const backOf = (a: GateAxisExport) => a.back ?? ((v: number) => {
        const c0 = a.convert(0);
        const k = a.convert(1) - c0;
        return k !== 0 ? (v - c0) / k : v;
      });
      const bx = backOf(ax);
      const by = backOf(ay);
      // A polygon on a knotted axis (biex) is first split at every knot its edges cross, which makes
      // it exact there; the tolerance below then only has an axis that bends smoothly left to follow.
      const xIdx = sample.index(g.x_channel);
      const yIdx = sample.index(g.y_channel);
      const cx = xIdx !== undefined ? Float64Array.from(sample.rawColumnData(xIdx), (v) => ax.rawToExport(v)) : undefined;
      const cy = yIdx !== undefined ? Float64Array.from(sample.rawColumnData(yIdx), (v) => ay.rawToExport(v)) : undefined;
      const backX = xIdx !== undefined ? readBack(ax, sample.rawColumnData(xIdx)) : null;
      const backY = yIdx !== undefined ? readBack(ay, sample.rawColumnData(yIdx)) : null;
      // An ellipse's boundary is kept off the file's events on it (ellipseDistanceFor), each event's
      // value in the gate's space found from its written value in double precision, and from the
      // single-precision value GateLab reads the written value back as, so that holding the densified
      // ring to them (densifyForExport) has a side to put each of them on for both.
      const ellipse = source.gate_type === "ellipse" && cx && cy && ownMask
        ? (() => {
            const f = ellipseQuadraticForm(source);
            if (!f.valid) return source;
            const [mx, my] = source.mean;
            const qOf = (X: ArrayLike<number>, Y: ArrayLike<number>) => Float64Array.from(X, (wx, i) => {
              const dx = bx(wx) - mx;
              const dy = by(Y[i]) - my;
              return f.ia * dx * dx + 2 * f.ib * dx * dy + f.ic * dy * dy;
            });
            const d2 = source.distance_square;
            const slack = () => 3e-7 * d2;
            const readers = [{ q: qOf(cx, cy), slack }];
            if (backX || backY) readers.push({ q: qOf(backX ?? cx, backY ?? cy), slack });
            return { ...source, distance_square: ellipseDistanceFor(d2, ownMask, readers) };
          })()
        : source;
      const curve = ellipse.gate_type === "ellipse"
        ? clipToClamps(ellipseCurve(ellipse), box, g.name)
        : polygonCurve(splitAtKnots(stored, ax.knots, ay.knots));
      const check: ExportEventCheck | undefined = cx && cy
        ? {
            x: cx,
            y: cy,
            inside: ownMask ?? getGateMask(source, sample.gatingDataFor(source)),
            finish: skirted,
            ...(backX || backY ? { back: { x: backX ?? cx, y: backY ?? cy } } : {}),
          }
        : undefined;
      // Re-expressed in a declared transform (logicle as arcsinh, for Cytobank): REEXPRESS_TOLERANCE.
      const tol = [ax, ay].some((a) => a.needsDensify && a.trId !== null) ? REEXPRESS_TOLERANCE : DENSIFY_TOLERANCE;
      const dense = densifyForExport(curve, toOut, (p) => [bx(p[0]), by(p[1])], tol, check);
      return { ...g, vertices: skirted([...dense, dense[0]]) };
    }
    return { ...g, vertices: skirted(vertices) };
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

  // The values a grid gate's column holds, which decide where its ring's edges can go
  // (flowjoGrid.ts): float32 for a float32 column; otherwise integers when every value is one
  // within ±2^53 (an FCS $DATATYPE I channel), and any double when one is not.
  const gridValuesCache = new Map<string, GridEdgeValues>();
  const gridEdgeValues = (channelKey: string): GridEdgeValues => {
    const hit = gridValuesCache.get(channelKey);
    if (hit) return hit;
    let out: GridEdgeValues = "float64";
    const idx = sample.channels.findIndex((c) => c.key === channelKey);
    if (idx >= 0 && sample.rawPrecision(channelKey) === "float32") out = "float32";
    else if (idx >= 0) {
      const raw = sample.rawColumnData(idx);
      let integral = true;
      for (let j = 0; j < raw.length && integral; j++) {
        const v = raw[j];
        integral = Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
      }
      out = integral ? "integer" : "float64";
    }
    gridValuesCache.set(channelKey, out);
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
  // ("We have parsed out a spectrum matrix"). The Cytobank format writes it whenever it
  // compensates; the standard format when the matrix is not the FCS file's own, and then its
  // compensated dimensions reference it (see referencesSpectrum above).
  const spectrumLines: string[] = [];
  if (exportSpillover && (cytobankMode || referencesSpectrum)) {
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
      ...detectors.map((d: string) => `      <data-type:fcs-dimension data-type:name="${escAttr(fluorochromeOf(d))}" />`),
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
  // Each rectangle's bounds as its geometry was written before exactBound and tieBreak placed them
  // among the file's own events, by gating:id, for GateLab's record (rectangleRecord.ts, placedFrom).
  const placedFrom = new Map<string, string[]>();
  gate_order.forEach((gid, i) => {
    const gOrig = forEveryReader(gates[gid]);
    if (!gOrig || gOrig.gate_type === "quadrant") return;
    // An ellipse on axes that convert nonlinearly into the export space (biex/wsplog) has no
    // EllipsoidGate representation — a covariance through a nonlinear map is not a covariance —
    // so it exports as its sampled boundary, and displayGate then densifies that polygon like
    // any other. Linear-converting ellipses take the exact EllipsoidGate path further down.
    //
    // So does an ellipse that reaches a FlowJo log or GateLab flog floor. GateLab holds the events
    // below the floor on it, and an EllipsoidGate in flog holds none of them for any reader, GateLab
    // reading it back included, since flog is not pinned at the floor: 674 of 679 events of such an
    // ellipse on the public PBMC file were lost in GateLab's own round trip. Written as its boundary
    // in raw space, skirted like a polygon on the floor, it keeps them (polygonAxis, skirtRing).
    const gAxes = { x: exportPlan.axis(gid, gOrig.x_channel), y: exportPlan.axis(gid, gOrig.y_channel) };
    const ellExtent = gOrig.gate_type === "ellipse" ? ellipseExtent(gOrig) : null;
    const reachesFloor = !!ellExtent &&
      (polygonAxis(gAxes.x, ellExtent[0]) !== gAxes.x || polygonAxis(gAxes.y, ellExtent[1]) !== gAxes.y);
    const g: Gate = gOrig.gate_type === "ellipse" && (gAxes.x.needsDensify || gAxes.y.needsDensify || reachesFloor)
      ? { ...gOrig, gate_type: "polygon", vertices: ellipseBoundary(gOrig) } as unknown as Gate
      : gOrig;
    if (g.gate_type === "ellipse") {
      const gmlId = gateToGmlId.get(gid)!;
      const numId = gateNumericId.get(gid)!;
      const xTr = gAxes.x.trId;
      const yTr = gAxes.y.trId;
      const kx = gAxes.x.convert(1) - gAxes.x.convert(0);
      const ky = gAxes.y.convert(1) - gAxes.y.convert(0);
      const mean: [number, number] = [gAxes.x.convert(g.mean[0]), gAxes.y.convert(g.mean[1])];
      const cov: [[number, number], [number, number]] = [
        [g.covariance[0][0] * kx * kx, g.covariance[0][1] * kx * ky],
        [g.covariance[1][0] * ky * kx, g.covariance[1][1] * ky * ky],
      ];
      const bnd = ellipseBoundary(g).map(([bx, by]) => [gAxes.x.convert(bx), gAxes.y.convert(by)]);
      const exs = bnd.map((v) => v[0]);
      const eys = bnd.map((v) => v[1]);
      const xRange = axisScaleRange(dataRangeFor(g.x_channel, gAxes.x), Math.min(...exs), Math.max(...exs));
      const yRange = axisScaleRange(dataRangeFor(g.y_channel, gAxes.y), Math.min(...eys), Math.max(...eys));
      const xCompRef = compensationRefFor(g.x_channel);
      const yCompRef = compensationRefFor(g.y_channel);
      const compensated = xCompRef !== "uncompensated" || yCompRef !== "uncompensated";
      const compId = !compensated ? -2
        : !cytobankMode ? -2
        : sample.spilloverOrigin.kind === "fcs" ? 0
        : EXPORTED_MATRIX_ID;
      // The distance, held to the file's own events on the boundary (ellipseDistanceFor), for a reader
      // of the written mean and covariance in double precision, whose values may differ from these by
      // what its own transform and compensation differ by (readerSlack), and for GateLab reading them
      // back on its single-precision values.
      const xi = sample.index(g.x_channel);
      const yi = sample.index(g.y_channel);
      const form = ellipseQuadraticForm({ ...g, covariance: cov });
      let d2 = g.distance_square;
      if (xi !== undefined && yi !== undefined && form.valid) {
        const rx = sample.rawColumnData(xi);
        const ry = sample.rawColumnData(yi);
        const wx = Float64Array.from(rx, (v) => gAxes.x.rawToExport(v));
        const wy = Float64Array.from(ry, (v) => gAxes.y.rawToExport(v));
        const backX = readBack(gAxes.x, rx) ?? wx;
        const backY = readBack(gAxes.y, ry) ?? wy;
        const qOf = (X: ArrayLike<number>, Y: ArrayLike<number>) => Float64Array.from(X, (vx, k) => {
          const dx = vx - mean[0];
          const dy = Y[k] - mean[1];
          return form.ia * dx * dx + 2 * form.ib * dx * dy + form.ic * dy * dy;
        });
        const ux = readerSlack(gAxes.x, g.x_channel);
        const uy = readerSlack(gAxes.y, g.y_channel);
        const q = qOf(wx, wy);
        const slack = (k: number) => {
          const dx = wx[k] - mean[0];
          const dy = wy[k] - mean[1];
          return 2 * Math.abs(form.ia * dx + form.ib * dy) * (ux?.(k) ?? 0) + 2 * Math.abs(form.ib * dx + form.ic * dy) * (uy?.(k) ?? 0) +
            1e-12 * Math.max(Math.abs(q[k]), g.distance_square);
        };
        d2 = ellipseDistanceFor(g.distance_square, getGateMask(g, sample.gatingDataFor(g)), [{ q, slack }, { q: qOf(backX, backY) }]);
      }
      gateLines.push(...ellipseXml(
        { ...g, distance_square: d2 }, gmlId, numId, i + 1, xTr, yTr, isFlow, gAxes.x.cofactor, gAxes.y.cofactor,
        dimNameFor(g.x_channel), dimNameFor(g.y_channel), xCompRef, yCompRef, xRange, yRange, compId,
        mean, cov,
      ));
      return;
    }
    // A polygon on FlowJo's grid goes out as the set of events it selects, with GateLab's mark;
    // its cell edges go where no value of the gate's own columns can lie (flowjoGrid.ts).
    const grid = g.gate_type === "polygon"
      ? exportGridPolygon(
        g as PolyRectGate, gAxes.x.grid, gAxes.y.grid, { x: gridEdgeValues(g.x_channel), y: gridEdgeValues(g.y_channel) },
        { x: exportGains.get(g.x_channel) ?? 1, y: exportGains.get(g.y_channel) ?? 1 },
      )
      : null;
    const gmlId = gateToGmlId.get(gid)!;
    const numId = gateNumericId.get(gid)!;
    const stored = (g as PolyRectGate).vertices as [number, number][];
    // A rectangle edge at or beyond its axis's clamp holds every event beyond it, which only a
    // raw bound left out keeps for every reader (see GateAxisExport.clamp). Judged on the STORED
    // vertices: the clamp is a property of the gate's own space. A range is judged on its interval.
    const isRange = g.gate_type === "rectangle" && g.x_channel === g.y_channel;
    // An ellipse written as its boundary is judged on its own extent, not on its sampled boundary's.
    const span = (k: 0 | 1) => ellExtent
      ? ellExtent[k]
      : [Math.min(...stored.map((v) => v[k])), Math.max(...stored.map((v) => v[k]))];
    const rangeLo = Math.max(span(0)[0], span(1)[0]);
    const rangeHi = Math.min(span(0)[1], span(1)[1]);
    // The rectangle as GateLab holds it, before forEveryReader moved its bounds for another
    // reader: which events it holds, and so where each written bound must fall among the file's
    // own events (exactBound, tieBreak) and whether an edge at a clamp holds the events piled
    // there, is decided on these edges under the rectangle's own rule (models.ts, RectangleBounds).
    const source = gates[gid];
    const openTop = source?.gate_type === "rectangle" && rectangleRule(source) === "half-open";
    const edgeSpan = (k: 0 | 1) => {
      const vs = source && source.gate_type === "rectangle" ? source.vertices : stored;
      return [Math.min(...vs.map((v) => v[k])), Math.max(...vs.map((v) => v[k]))];
    };
    const edgeLo = Math.max(edgeSpan(0)[0], edgeSpan(1)[0]);
    const edgeHi = Math.min(edgeSpan(0)[1], edgeSpan(1)[1]);
    // An edge at a clamp holds the events piled on the clamp only where the rectangle holds the
    // clamp's value at all: a half-open rectangle whose upper edge is at the lower clamp, or at
    // the upper one, holds none of them, and one lying wholly beyond a clamp holds nothing.
    const holds = (lo: number, hi: number, at: number) => lo <= at && (openTop ? at < hi : at <= hi);
    const openAt = (a: GateAxisExport, [lo, hi]: number[]) => g.gate_type !== "rectangle"
      ? { lo: false, hi: false }
      : {
        lo: a.clamp?.lo !== undefined && lo <= a.clamp.lo && holds(lo, hi, a.clamp.lo),
        hi: a.clamp?.hi !== undefined && (openTop ? hi > a.clamp.hi : hi >= a.clamp.hi) && lo <= a.clamp.hi,
      };
    const baseX = exportPlan.axis(gid, g.x_channel);
    const baseY = exportPlan.axis(gid, g.y_channel);
    const openX = openAt(baseX, isRange ? [edgeLo, edgeHi] : edgeSpan(0));
    const openY = isRange ? openX : openAt(baseY, edgeSpan(1));
    const xAxis = g.gate_type === "polygon" ? polygonAxis(baseX, span(0))
      : openX.lo || openX.hi ? clampedAxis(baseX) : baseX;
    const yAxis = g.gate_type === "polygon" ? polygonAxis(baseY, span(1))
      : openY.lo || openY.hi ? clampedAxis(baseY) : baseY;
    /**
     * One bound of a rectangle in export space, or undefined for none: an edge at a clamp, an edge
     * GateLab holds as unbounded (UNBOUNDED, an absent bound on import), and an edge the export
     * space cannot reach on its own side (a logicle edge far off the top, re-expressed as arcsinh
     * for Cytobank, is +Infinity) all hold every value beyond them. Those edges were written as 0.
     */
    // Each event's value in the gate's own space and as the file writes it, for tieBreak.
    const eventsOn = (axis: GateAxisExport, channel: string) => {
      const idx = sample.index(channel);
      const own = gOrig.gate_type === "rectangle" ? sample.gatingDataFor(gOrig).column(channel) : undefined;
      if (idx === undefined || !own) return null;
      const raw = sample.rawColumnData(idx);
      return { own, written: (i: number) => axis.rawToExport(raw[i]), slack: readerSlack(axis, channel) };
    };
    // `v` is the bound forEveryReader wrote, `edge` the rectangle's own edge it was moved from.
    const boundOn = (
      axis: GateAxisExport, v: number, edge: number, side: "lo" | "hi", atClamp: boolean, channel: string,
      unplaced = false,
    ): number | undefined => {
      if (atClamp || isUnbounded(v)) return undefined;
      if (unplaced) {
        const w0 = axis.convert(v);
        return Number.isFinite(w0) && !isUnbounded(w0) ? w0 : undefined;
      }
      const top = side === "hi" && openTop;
      const w0 = axis.convert(v);
      const w1 = axis.back ? exactBound(w0, edge, axis.back, side, undefined, top) : w0;
      const ev = Number.isFinite(w1) && !isUnbounded(w1) ? eventsOn(axis, channel) : null;
      const w = ev ? tieBreak(w1, side, ev.own, edge, ev.written, axis.trId !== null, 0, top, ev.slack) : w1;
      if (Number.isFinite(w) && !isUnbounded(w)) return w;
      if (side === "lo" ? w <= -UNBOUNDED : w >= UNBOUNDED) return undefined;
      throw new Error(`The gate "${g.name}" has an edge at ${v} that cannot be written in this format.`);
    };
    const rectBounds = (unplaced: boolean): RectBounds | null => g.gate_type !== "rectangle" ? null
      : isRange
        ? (() => {
            const b = {
              lo: boundOn(xAxis, rangeLo, edgeLo, "lo", openX.lo, g.x_channel, unplaced),
              hi: boundOn(xAxis, rangeHi, edgeHi, "hi", openX.hi, g.x_channel, unplaced),
            };
            return { x: b, y: b };
          })()
        : {
            x: {
              lo: boundOn(xAxis, span(0)[0], edgeSpan(0)[0], "lo", openX.lo, g.x_channel, unplaced),
              hi: boundOn(xAxis, span(0)[1], edgeSpan(0)[1], "hi", openX.hi, g.x_channel, unplaced),
            },
            y: {
              lo: boundOn(yAxis, span(1)[0], edgeSpan(1)[0], "lo", openY.lo, g.y_channel, unplaced),
              hi: boundOn(yAxis, span(1)[1], edgeSpan(1)[1], "hi", openY.hi, g.y_channel, unplaced),
            },
          };
    const rect = rectBounds(false);
    if (rect) {
      // A zero-width half-open rectangle holds nothing, and no bound lies between its events to
      // place: placed one bound at a time, its lower bound can pass its upper one, which is not a
      // rectangle to any reader. That axis keeps the bounds forEveryReader wrote, at one value.
      const unplaced = rectBounds(true)!;
      for (const k of ["x", "y"] as const) {
        const b = rect[k];
        if (b.lo !== undefined && b.hi !== undefined && b.lo > b.hi) rect[k] = unplaced[k];
      }
    }
    const finiteOf = (b: { lo?: number; hi?: number }) => [b.lo, b.hi].filter((v): v is number => v !== undefined);
    const dg = rect
      ? { ...(g as PolyRectGate), vertices: [] as [number, number][] }
      : grid?.gate ?? displayGate(g as PolyRectGate, xAxis, yAxis, gOrig);
    if (dg.vertices.some((v) => !Number.isFinite(v[0]) || !Number.isFinite(v[1]))) {
      throw new Error(`The gate "${g.name}" has a vertex that cannot be written in this format.`);
    }
    const xTr = xAxis.trId;
    const yTr = yAxis.trId;
    const xName = dimNameFor(g.x_channel);
    const yName = dimNameFor(g.y_channel);
    const xCompRef = compensationRefFor(g.x_channel);
    const yCompRef = compensationRefFor(g.y_channel);
    const xCofactor = xAxis.cofactor;
    const yCofactor = yAxis.cofactor;
    // Derived from the exported geometry, so it holds for a densified polygon too, but not from
    // the skirts that carry a clamp out past the data (skirtRing), which would stretch the axis, nor
    // from a grid ring's outer edges, which stand for no bound at all (flowjoGrid.ts, the largest
    // float32): a scale stretched to them spanned about 1e38. Both lie beyond SKIRT_FAR.
    const inData = dg.vertices.filter((v) => Math.abs(v[0]) < SKIRT_FAR && Math.abs(v[1]) < SKIRT_FAR);
    const exs = rect ? finiteOf(rect.x) : inData.map((v) => v[0]);
    const eys = rect ? finiteOf(rect.y) : inData.map((v) => v[1]);
    const xRange = axisScaleRange(dataRangeFor(g.x_channel, xAxis), Math.min(...exs), Math.max(...exs));
    const yRange = axisScaleRange(dataRangeFor(g.y_channel, yAxis), Math.min(...eys), Math.max(...eys));
    // Cytobank's ids, read off its own exports: -2 = uncompensated, 0 = the file's internal
    // matrix, positive = a named compensation. A compensated gate points at the matrix this file
    // DECLARES below when the active matrix is not the FCS's own (the S6 case: gates drawn under
    // the workspace's hand-adjusted matrix, which the FCS does not carry); at the file-internal
    // one (0) when it is. In the Cytobank format compensation-ref stays "FCS"/"uncompensated":
    // Cytobank's own exports never reference a matrix from a dimension.
    const compensated = xCompRef !== "uncompensated" || yCompRef !== "uncompensated";
    const compId = !compensated ? -2
      : !cytobankMode ? -2
      : sample.spilloverOrigin.kind === "fcs" ? 0
      : EXPORTED_MATRIX_ID;
    if (rect) {
      // A range: both axes on one channel, so the gate is the intersection of the two intervals,
      // written as one dimension. Both formats: the two-axis form names one parameter twice, which
      // FlowKit cannot gate at all. Whether Cytobank accepts a one-dimensional RectangleGate has
      // not been tried; its custom_info definition still describes the same interval on both axes.
      gateLines.push(...rectangleXml(
        dg, gmlId, numId, i + 1, xTr, yTr, isFlow, xCofactor, yCofactor,
        xName, yName, xCompRef, yCompRef, xRange, yRange, compId, rect, isRange, flowJoInfoLines(g as PolyRectGate),
      ));
      // The same rectangle before its bounds were placed among the file's events, in the same text.
      const unplacedLines = rectangleXml(
        dg, gmlId, numId, i + 1, xTr, yTr, isFlow, xCofactor, yCofactor,
        xName, yName, xCompRef, yCompRef, xRange, yRange, compId, rectBounds(true)!, isRange,
      );
      const from = writtenRectangleBounds(unplacedLines).get(gmlId);
      if (from) placedFrom.set(gmlId, from);
    } else {
      // One line at a time: push(...lines) takes a line an argument, and a polygon of more than
      // about 30,000 vertices is more lines than V8 takes ("Maximum call stack size exceeded").
      const lines = polygonXml(
        dg, gmlId, numId, i + 1, xTr, yTr, isFlow, xCofactor, yCofactor,
        xName, yName, xCompRef, yCompRef, xRange, yRange, compId, [...(grid?.mark ?? []), ...flowJoInfoLines(g as PolyRectGate)],
      );
      for (const line of lines) gateLines.push(line);
    }
  });

  // Populations pass 1: assign GateSet ids to every non-root population with a valid gate ref.
  // The standard format lists populations parent first and siblings in their stored order, so a
  // reader that builds the tree in document order gets GateLab's order back.
  const popBoolNum = new Map<string, number>();
  const popBoolGmlId = new Map<string, string>();
  let nextBoolId = 36000000;
  const omittedPopulationIds = new Set(quadrantOmissions.populationIds);
  if (cytobankMode) {
    // Beneath an OR population the Cytobank format's AND of the whole ancestry is not the
    // population, so it is left out with everything beneath it, by name (see
    // analyzeCytobankOrOmissions).
    const orOmissions = analyzeCytobankOrOmissions(populations, root_population_id);
    for (const pid of orOmissions.populationIds) {
      if (omittedPopulationIds.has(pid)) continue;
      omittedPopulationIds.add(pid);
      const pop = populations[pid];
      const parent = pop.parent_id ? populations[pop.parent_id] : null;
      if (parent && parent.gate_logic === "or" && parent.gate_refs.length > 1) {
        opts.warnings?.push(
          `"${pop.name}" sits beneath the OR population "${parent.name}", which the Cytobank-compatible format ` +
          "cannot hold anything beneath; it and anything below it were left out. The standard format writes " +
          "them for other Gating-ML readers, and the .gatelab workspace keeps them.",
        );
      }
    }
  }
  if (cytobankMode && CYTOBANK_OMITS_CONTRADICTIONS) {
    // A population that both includes and excludes one gate down its chain (see
    // analyzeCytobankContradictions): left out with everything beneath it, by name.
    const contradictions = analyzeCytobankContradictions(gates, populations, root_population_id);
    for (const pid of contradictions.populationIds) omittedPopulationIds.add(pid);
    opts.warnings?.push(...contradictions.warnings);
  }
  const popIds = (cytobankMode ? Object.keys(populations) : treeOrder(populations, root_population_id))
    .filter((pid) => !omittedPopulationIds.has(pid));
  for (const pid of popIds) {
    if (pid === root_population_id) continue;
    const pop = populations[pid];
    const valid = (pop.gate_refs ?? []).filter((r) => gateToGmlId.has(r.gate_id));
    if (valid.length === 0) continue;
    const boolNum = nextBoolId++;
    popBoolNum.set(pid, boolNum);
    popBoolGmlId.set(pid, `GateSet_${boolNum}`);
    opts.populationElementIds?.set(pid, `GateSet_${boolNum}`);
  }

  // Standard format: a NOT gate per gate that is excluded within a multi-reference population.
  // See the standard branch below for why this is not use-as-complement.
  const notGateLines: string[] = [];
  const notGateIds = new Map<string, string>();
  const notGateFor = (gateId: string): string => {
    const hit = notGateIds.get(gateId);
    if (hit) return hit;
    const target = gateToGmlId.get(gateId)!;
    const id = `Not_${target}`;
    notGateIds.set(gateId, id);
    notGateLines.push(
      `  <gating:BooleanGate gating:id="${id}">`,
      "    <data-type:custom_info>",
      `      <${GATELAB_OPERAND_TAG}>not</${GATELAB_OPERAND_TAG}>`,
      "    </data-type:custom_info>",
      "    <gating:not>",
      `      <gating:gateReference gating:ref="${target}" />`,
      "    </gating:not>",
      "  </gating:BooleanGate>",
    );
    return id;
  };

  // Populations pass 2: BooleanGates (+ Cytobank definition JSON / parent refs).
  const boolLines: string[] = [];
  /** Cytobank format: each population's BooleanGate id and its parent's, for GATELAB_FORMAT_TAG. */
  const cytobankParents = new Map<string, string | null>();
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
    let parentPid: string | null = null;
    let walk: string | null = pop.parent_id;
    while (walk && walk !== root_population_id) {
      if (popBoolGmlId.has(walk)) {
        parentBoolGmlId = popBoolGmlId.get(walk)!;
        parentPid = walk;
        break;
      }
      walk = populations[walk]?.parent_id ?? null;
    }

    if (cytobankMode) {
      cytobankParents.set(boolGmlId, parentBoolGmlId);
      const operation = pop.gate_logic === "or" && valid.length > 1 ? "or" : "and";
      if (operation === "or" && parentBoolGmlId) {
        // The standard format writes it, but GateLab does not read an OR population back (it is
        // left out on import), so pointing at that format as the way to keep it would mislead.
        throw new Error(
          `The Cytobank-compatible format cannot represent the OR population "${pop.name}" beneath ` +
            "another population, because it ANDs every population with its whole ancestry. The standard " +
            "format writes it for other Gating-ML readers, but GateLab leaves OR populations out when it " +
            "imports Gating-ML; the .gatelab workspace keeps it.",
        );
      }
      // Cytobank has no concept of one population referencing another: every GateSet is the
      // AND of its WHOLE ancestor chain of primitive gates. Referencing a GateSet is legal
      // Gating-ML, and GateLab reads its own files back that way, but Cytobank's importer has
      // no such construct and rejects the file with no explanation. Its own exports never
      // reference a GateSet — not once — so the ancestry is flattened here instead.
      // One reference per gate AND whether it is included: a population excluding a gate its
      // ancestry includes (or the reverse, or both within itself) holds no event, and that needs
      // both references. Kept once per gate, the exclusion was dropped and the population written
      // as the AND of the included gates: FlowKit read 85,232 events of such a population on the
      // public PBMC file, and GateLab's own re-import 63,153 of another, where GateLab holds none.
      const chain: typeof valid = [];
      const seenRefs = new Set<string>();
      const pushRef = (gr: (typeof valid)[number]) => {
        const key = `${gr.gate_id}|${gr.include}`;
        if (seenRefs.has(key)) return;
        seenRefs.add(key);
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
        const comp = gr.include ? "" : COMPLEMENT_ATTR;
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
    } else {
      // Standard. Every population is a BooleanGate, and its place in the tree is its
      // gating:parent_id. Gating-ML 2.0 applies a gate only to the events of its parent, so the
      // population is its parent's events that pass its own references, which is exactly what
      // GateLab evaluates. The geometric gates carry no parent_id and serve as operands, which is
      // what lets one gate serve several populations, under different parents or negated.
      //
      // and/or take at least two operands, so a single included reference is ANDed with itself
      // (Cytobank pads its own the same way), and a single excluded one is a NOT. An excluded
      // reference among several goes through a NOT gate of its own rather than
      // use-as-complement: GateLabR's importer does not know use-as-complement and would take the
      // reference as included, where a NOT gate is something it refuses.
      //
      // Until 2026-09 this format wrote a <GatingHierarchy> of <PopulationGatePair>s instead,
      // which is not a Gating-ML 2.0 element; the importer still reads those files.
      const operation = valid.length === 1
        ? (valid[0].include ? "and" : "not")
        : (pop.gate_logic === "or" ? "or" : "and");
      let operands = valid.map((gr) =>
        valid.length > 1 && !gr.include ? notGateFor(gr.gate_id) : gateToGmlId.get(gr.gate_id)!);
      if (operation === "and" && operands.length === 1) operands = [operands[0], operands[0]];
      const parentAttr = parentBoolGmlId ? ` gating:parent_id="${parentBoolGmlId}"` : "";

      // For GateLab and GateLabR only. gate_set_id and the pop_N token give GateLabR, whose
      // importer predates parent_id, the same tree; GateLab reads parent_id itself.
      const gateSetId = boolNum - 36000000 + 1;
      const terms = valid.map((gr) => `${gr.include ? "" : "NOT "}gate_${gateSeq.get(gr.gate_id)!}`);
      const own = terms.length > 1 && operation === "or" ? `(${terms.join(" OR ")})` : terms.join(" AND ");
      const expr = parentPid ? `pop_${popBoolNum.get(parentPid)! - 36000000 + 1} AND ${own}` : own;
      const defJson = JSON.stringify({
        gates: valid.map((gr) => gateSeq.get(gr.gate_id)!),
        negGates: valid.filter((gr) => !gr.include).map((gr) => gateSeq.get(gr.gate_id)!),
        booleanExpression: expr,
      });
      boolLines.push(
        `  <gating:BooleanGate gating:id="${boolGmlId}"${parentAttr}>`,
        "    <data-type:custom_info>",
        "      <cytobank>",
        `        <name>${escAttr(pop.name)}</name>`,
        `        <id>${boolNum}</id>`,
        `        <gate_set_id>${gateSetId}</gate_set_id>`,
        "        <version>-1</version>",
        `        <definition>${escText(defJson)}</definition>`,
        "      </cytobank>",
        "    </data-type:custom_info>",
        `    <gating:${operation}>`,
        ...operands.map((id) => `      <gating:gateReference gating:ref="${id}" />`),
        `    </gating:${operation}>`,
        "  </gating:BooleanGate>",
      );
    }
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
    : `Gating-ML 2.0 export from GateLab (standard / re-importable; ${GATELAB_ABOUT_LOGICLE_SCALE})`;
  const timestamp = opts.timestamp ?? new Date().toISOString().slice(0, 19);
  // The Cytobank format's tree, parents before children and siblings in stored order, whatever
  // order its BooleanGates were written in.
  const formatMark = cytobankMode
    ? {
        version: 3, logicle: "gating-ml", hierarchy: "tree", time: "ticks",
        tree: treeOrder(populations, root_population_id)
          .filter((pid) => cytobankParents.has(popBoolGmlId.get(pid) ?? ""))
          .map((pid) => ({ id: popBoolGmlId.get(pid)!, parent: cytobankParents.get(popBoolGmlId.get(pid)!) ?? null })),
      }
    : STANDARD_FORMAT;

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
    ...rectangleRecordLines(sample, gates, gate_order, gateToGmlId, gateLines, placedFrom),
    "    <gatelabr_scales>",
    `      <definition>${escText(scalesJson)}</definition>`,
    "    </gatelabr_scales>",
    `    <${GATELAB_FORMAT_TAG}>${escText(JSON.stringify(formatMark))}</${GATELAB_FORMAT_TAG}>`,
    "  </data-type:custom_info>",
    ...[...trDefs.entries()].flatMap(([id, tr]) => transformXml(id, tr)),
    ...spectrumLines,
    ...gateLines,
    ...notGateLines,
    ...boolLines,
    "</gating:Gating-ML>",
  ];
  return lines.join("\n") + "\n";
}
