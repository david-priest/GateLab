// gatingml.ts — Gating-ML 2.0 import (Cytobank / GateLabR / FlowJo exports).
// Ported 1:1 from GateLabR inst/app/R/gatingml_import.R.
//
// GateLab's standard format places each population, a <BooleanGate>, in the tree with
// gating:parent_id, as Gating-ML 2.0 defines it. Older GateLab and GateLabR exports encode the
// hierarchy as a <GatingHierarchy> of nested <PopulationGatePair>s; Cytobank exports use flat
// <BooleanGate>s + custom_info (gate_set_id, booleanExpression "pop_X"); any other file, FlowKit's,
// flowUtils' or FlowJo's, makes every gate a population placed by its parent_id. All are handled. NOT is
// supported: a complemented reference becomes a GateRef with include = false. An OR population
// is left out with everything beneath it and named in a warning, and the rest of the file is
// imported, as the FlowJo workspace import does with an OrNode (see PopulationSkips.warnOr).
// Gate vertices live in TRANSFORMED (display) space with a transformation-ref; we
// invert them back to the gating space GateLab masks in (raw for flow, arcsinh for
// CyTOF).

import {
  newRootPopulation,
  newPopulation,
  newGateRef,
  linkChildToParent,
  nextGateColor,
  UNBOUNDED,
  isUnbounded,
  type Gate,
  type GateRef,
  type GateTransforms,
  type PopulationMap,
  type TransformSpec,
  type Vertex,
} from "./models";
import { COMPENSATED_FCS_MARK, WSP_GATE_SPACE_TAG, WSP_COMPLEMENT_TAG, WSP_DERIVED_TAG, WSP_CURLY_TAG, WSP_OPERAND_TAG, WSP_RECT_BOUNDS_TAG, WSP_FLOWJO_AXES_TAG, WSP_FLOWJO_POLYGON_TAG } from "./flowjoWorkspace";
import { isRectangleBounds, type PolyRectGate, type RectangleBounds } from "./models";
import { gatingMLWriter, writerRectangleBounds, type GatingMLWriter } from "./gatingmlWriter";
import { gainConventionOf, gatesFromGatingMlScale } from "./gatingmlGain";
import {
  GATINGML_EDGE_RULE_TAG, GATINGML_RECTANGLES_TAG, applyRectangleRecord, parseRectangleRecord, parseTransformSpec,
  writtenBound, type RectangleRecord,
} from "./rectangleRecord";
import {
  GATINGML_GRID_TAG, fingerprintRing, isFlowJoGridSpec, parseFlowJoGridAxis, parseFlowJoGridMark, type FlowJoGridMark,
} from "./flowjoGrid";
import type { FlowJoGridAxis } from "./models";
import { validCurl, type QuadrantCurl } from "./models";
import type { WspDerivedPopulation } from "./flowjoWorkspace";
import { invertMatrix, type DisplaySpillover } from "./compensation";
import { DEFAULT_FLOW_SOLVER_SETTINGS, prepareFlowCompensation } from "./flowCompensationEngine";
import type { Sample } from "./sample";
import type { FcsFile, NumericColumn } from "./fcs";
import { isQcChannel, isScatterChannel, withinLogicleBound } from "./transforms";
import { metalOf, punctuationInsensitive } from "./channelMatch";
import { COMPENSATION_REFERENCE, GATELAB_ABOUT_LOGICLE_SCALE, GATELAB_FORMAT_TAG, GATELAB_OPERAND_TAG } from "./gatingmlExport";

const LN10 = Math.log(10);
const uuid = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Namespace-agnostic DOM helpers (match on localName, ignore prefixes)
// ---------------------------------------------------------------------------

function attrLocal(el: Element, name: string): string | null {
  for (const a of Array.from(el.attributes)) if (a.localName === name) return a.value;
  return null;
}
function childrenLocal(el: Element, name: string): Element[] {
  const out: Element[] = [];
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) out.push(c);
  return out;
}

/**
 * Every element below `el`, in document order. Walked by sibling links rather than read off
 * getElementsByTagName("*"): indexing that live collection costs jsdom far more than a walk, and
 * an exported polygon can carry thousands of vertices, three elements each. Reading every mark of
 * such a file that way took 24 s in node (the test suite, the headless harnesses) for a file
 * whose gates GateLab evaluates in a fraction of that.
 */
function descendants(el: Element): Element[] {
  const out: Element[] = [];
  const walk = (e: Element) => {
    for (let c = e.firstElementChild; c; c = c.nextElementSibling) { out.push(c); walk(c); }
  };
  walk(el);
  return out;
}
function firstChildLocal(el: Element, name: string): Element | null {
  return childrenLocal(el, name)[0] ?? null;
}
function num(x: string | null): number {
  if (x == null) return NaN;
  // xs:double spells infinity INF and -INF, which Number() does not read.
  const t = x.trim();
  if (/^\+?INF$/.test(t)) return Infinity;
  if (t === "-INF") return -Infinity;
  const v = Number(x);
  return v;
}
const hasNum = (x: number): boolean => Number.isFinite(x);
/** A finite xs:double as the schema spells one, with the whitespace it collapses around it. */
const XS_DOUBLE_FINITE = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;
/** Any xs:double, INF, -INF and NaN included. */
const XS_DOUBLE = /^\s*([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|[+-]?INF|NaN)\s*$/;
/**
 * A number the file writes, read as xs:double: its value (±Infinity for INF and -INF), or NaN for
 * NaN, for text that is no xs:double and for none. num() reads with Number(), which takes "" and
 * " " for 0, "0x10" for 16 and "Infinity" for infinity, none of which the schema reads.
 */
function xsNum(x: string | null): number {
  return x !== null && XS_DOUBLE.test(x) ? num(x) : NaN;
}

// ---------------------------------------------------------------------------
// custom_info (Cytobank name / definition / ids)
// ---------------------------------------------------------------------------

function cytobankNode(node: Element): Element | null {
  const ci = firstChildLocal(node, "custom_info");
  return ci ? firstChildLocal(ci, "cytobank") : null;
}
/**
 * A name as its element holds it. Spaces are the name's own and are kept: GateLab writes a
 * population's name here, and read trimmed, "CD4+ Tx " came back as "CD4+ Tx", another
 * population (a public FlowRepository workspace). Only the line break and indentation a formatter
 * puts between the tags and the name are dropped.
 */
function nameText(text: string): string {
  return text.replace(/^[ \t]*[\r\n]\s*/, "").replace(/\s*[\r\n][ \t]*$/, "");
}
function parseCytobankName(node: Element): string | null {
  const cb = cytobankNode(node);
  const nm = cb ? firstChildLocal(cb, "name") : null;
  const txt = nameText(nm?.textContent ?? "");
  return txt.trim() ? txt : null;
}
function parseCytobankDefinition(node: Element): Record<string, unknown> | null {
  const cb = cytobankNode(node);
  const def = cb ? firstChildLocal(cb, "definition") : null;
  const txt = def?.textContent?.trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}
function parseCytobankIds(node: Element): { gate_id?: number; gate_set_id?: number; compensation_id?: number } {
  const cb = cytobankNode(node);
  if (!cb) return {};
  const out: { gate_id?: number; gate_set_id?: number; compensation_id?: number } = {};
  const cid = firstChildLocal(cb, "compensation_id");
  if (cid) {
    const v = parseInt((cid.textContent ?? "").trim(), 10);
    if (Number.isFinite(v)) out.compensation_id = v;
  }
  const gid = firstChildLocal(cb, "gate_id");
  if (gid) {
    const v = parseInt((gid.textContent ?? "").trim(), 10);
    if (Number.isFinite(v)) out.gate_id = v;
  }
  const gsid = firstChildLocal(cb, "gate_set_id");
  if (gsid) {
    const v = parseInt((gsid.textContent ?? "").trim(), 10);
    if (Number.isFinite(v)) out.gate_set_id = v;
  }
  return out;
}
/**
 * The FCS file a Cytobank gate element was tailored for: Cytobank writes each file's tailored
 * version of a gate as a further element with the same gate_id, `<tailored>true</tailored>` and the
 * file's `<fcs_file_filename>`. Null for the experiment's own gate.
 */
function cytobankTailoredFor(node: Element): string | null {
  const cb = cytobankNode(node);
  const name = cb ? firstChildLocal(cb, "fcs_file_filename")?.textContent?.trim() : "";
  return name ? name : null;
}

const GEOMETRIC_GATES = new Set(["RectangleGate", "PolygonGate", "EllipsoidGate"]);

/** The files a Cytobank Gating-ML file tailors gates for, each with how many of its gates. */
export interface CytobankTailoredFile {
  fileName: string;
  gates: number;
}

/**
 * The files a Cytobank export tailors gates for. Their per-file gates are not part of the
 * experiment's tree: importGatingML leaves them out, and cytobankDocumentForFile gives a file's
 * tree with its own coordinates, so each can go onto the file it was tailored for and no other.
 */
export function cytobankTailoredFiles(xmlText: string): CytobankTailoredFile[] {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return [];
  const counts = new Map<string, number>();
  for (const el of Array.from(doc.documentElement.children)) {
    if (!GEOMETRIC_GATES.has(el.localName)) continue;
    const file = cytobankTailoredFor(el);
    if (file) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts].map(([fileName, gates]) => ({ fileName, gates }));
}

/**
 * A Cytobank Gating-ML document holding one tree: the experiment's (fileName null), or the one
 * Cytobank used for `fileName`, where each gate tailored for that file takes that file's
 * coordinates under the experiment gate's id. Every per-file element is removed either way, so
 * no file's tailored geometry is imported as another gate of the tree -- it used to be, onto
 * whichever file was loaded, as a second gate of the same name.
 */
export function cytobankDocumentForFile(xmlText: string, fileName: string | null): string {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return xmlText;
  const root = doc.documentElement;
  const gateIdOf = (el: Element) => parseCytobankIds(el).gate_id;
  const perFile = Array.from(root.children).filter((el) => GEOMETRIC_GATES.has(el.localName) && cytobankTailoredFor(el));
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  for (const tailored of perFile) {
    if (fileName !== null && same(cytobankTailoredFor(tailored)!, fileName)) {
      const gid = gateIdOf(tailored);
      const base = gid === undefined ? undefined : Array.from(root.children).find((el) =>
        el.localName === tailored.localName && !cytobankTailoredFor(el) && gateIdOf(el) === gid);
      if (base) {
        // The file's geometry, under the experiment gate's id, name and place in the tree.
        for (const child of Array.from(base.children)) if (child.localName !== "custom_info") base.removeChild(child);
        for (const child of Array.from(tailored.children)) {
          if (child.localName !== "custom_info") base.appendChild(child.cloneNode(true));
        }
      }
    }
    root.removeChild(tailored);
  }
  return new XMLSerializer().serializeToString(doc);
}

function parsePopParentIndices(node: Element): number[] {
  const defn = parseCytobankDefinition(node);
  const expr = defn?.booleanExpression;
  if (typeof expr !== "string" || !expr) return [];
  const hits = expr.match(/\bpop_([0-9]+)\b/g);
  if (!hits) return [];
  return hits.map((h) => parseInt(h.replace(/^pop_/, ""), 10)).filter(Number.isFinite);
}
function parseExplicitRoot(node: Element): boolean {
  return parseCytobankDefinition(node)?.gatelabParent === "root";
}
/**
 * How a GateLab file asks to be read where Gating-ML alone leaves room, from the root custom_info
 * element the exporter writes (GATELAB_FORMAT_TAG). Absent in every file written before 2026-09 and
 * in every third-party file.
 */
interface GatelabFormat {
  /** Logicle coordinates are on Gating-ML 2.0's own scale (T at 1) rather than flowCore's (T at M). */
  logicleUnit: boolean;
  /**
   * Every BooleanGate not marked GATELAB_OPERAND_TAG is a population, placed by its
   * gating:parent_id; geometric gates are operands only. See buildPopulationsFromParentIds.
   */
  parentIdHierarchy: boolean;
  /**
   * The Cytobank format's population tree (`hierarchy: "tree"`): each population's BooleanGate
   * with its parent's, null at the root, parents first and siblings in order. That format ANDs
   * every ancestor's gates into each population, so without this the parent has to be inferred,
   * and a population can come back under a different parent with the same events. Null when the
   * file carries none, as Cytobank's own exports do not.
   */
  tree: { id: string; parent: string | null }[] | null;
  /**
   * The unit a Time dimension's coordinates are in: "seconds", stored ticks times $TIMESTEP, as
   * FlowKit and FlowJo read Time, or "ticks", the stored value, as Cytobank and GateLab before
   * version 3 wrote it. See timeUnitOf.
   */
  time: "seconds" | "ticks" | null;
  /** The mark's version, or null when the file carries none. */
  version: number | null;
  /**
   * The FlowJo converter's document (COMPENSATED_FCS_MARK): each dimension declaring "FCS" was drawn
   * on compensated values and is evaluated only where the matrix the import applies covers it.
   */
  fcsCompensated: boolean;
  /** Why the mark cannot be read; the import is refused, naming each. */
  problems: string[];
}

/** The mark versions this reader knows. 2: logicle, hierarchy, tree. 3: also time, and standard flog. */
const KNOWN_FORMAT_VERSIONS = new Set([2, 3]);

/** The mark's `tree`, or null unless it is a list of {id, parent} with string ids. */
function parseTree(value: unknown): GatelabFormat["tree"] {
  if (!Array.isArray(value)) return null;
  const out: { id: string; parent: string | null }[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { id, parent } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || !(parent === null || (typeof parent === "string" && parent))) return null;
    out.push({ id, parent: parent as string | null });
  }
  return out;
}

/**
 * Whether a file without GATELAB_FORMAT_TAG was written by GateLab or GateLabR.
 *
 * Any one of three things marks it, and no other tool writes any of them:
 *   • the root custom_info's cytobank/about text, "Gating-ML 2.0 export from GateLab (…)" or
 *     "… from GateLabR (…)", which every GateLab export since the first (2026-07-10) and every
 *     GateLabR export carries, in both formats;
 *   • a root custom_info gatelabr_scales element, which both write whenever a channel has a W,
 *     a cofactor or a display range, so in every file with a logicle axis;
 *   • a GatingHierarchy element. It is not a Gating-ML 2.0 element; GateLab's standard format
 *     wrote it until 2026-09 and GateLabR's still does.
 */
function writtenByGatelab(root: Element): boolean {
  const ci = firstChildLocal(root, "custom_info");
  if (ci && firstChildLocal(ci, "gatelabr_scales")) return true;
  if (/^\s*Gating-ML 2\.0 export from GateLab/.test(aboutText(root))) return true;
  return Array.from(root.children).some((el) => el.localName === "GatingHierarchy");
}

/** The root custom_info's cytobank/about text, which GateLab and GateLabR write, or "". */
function aboutText(root: Element): string {
  const ci = firstChildLocal(root, "custom_info");
  const about = ci ? firstChildLocal(firstChildLocal(ci, "cytobank") ?? ci, "about") : null;
  return about?.textContent ?? "";
}

/**
 * The version of a file's gatelabr_scales, or 0 when it has none that says.
 *
 * Version 4 is written only by GateLab since 2026-09, whose logicle coordinates are on Gating-ML's
 * own scale and whose files carry GATELAB_FORMAT_TAG; GateLabR writes version 3 and earlier, as did
 * GateLab before it. So a version 4 file without the mark has lost it, not been written on
 * flowCore's scale: read that way, a standard file with the mark removed placed every logicle gate
 * 4.5 times too low (T cells 0 of 47,255 on the public PBMC file).
 */
function gatelabrScalesVersion(root: Element): number {
  const ci = firstChildLocal(root, "custom_info");
  const gs = ci ? firstChildLocal(ci, "gatelabr_scales") : null;
  const def = gs ? firstChildLocal(gs, "definition") : null;
  try {
    const v: unknown = JSON.parse(def?.textContent ?? "null");
    const version = v && typeof v === "object" ? (v as Record<string, unknown>).version : undefined;
    return typeof version === "number" && Number.isFinite(version) ? version : 0;
  } catch {
    return 0;
  }
}

/**
 * Which scale a file's logicle coordinates are on, and how its tree is encoded.
 *
 * Gating-ML 2.0 defines logicle on [0, 1], with the top of scale T mapped to 1 (specification
 * §6.4.1: "maps scale values onto the [0, 1] interval such that the data value T is mapped to
 * 1"; Spidlen et al. 2015, Cytometry A 87:683, "The top of scale value T is always mapped to the
 * value 1"). That is also GateLab's own scale. flowCore's logicleTransform maps T to M instead,
 * which makes its coordinate Gating-ML's times M for every A, and GateLabR, and GateLab until
 * 2026-09, wrote logicle coordinates on it: 4.5 times the standard value at the usual M = 4.5. So:
 *   1. a file carrying GATELAB_FORMAT_TAG says which, as logicle "gating-ml" or "flowcore";
 *   2. otherwise a file GateLab or GateLabR wrote (writtenByGatelab) is on flowCore's scale,
 *      unless its gatelabr_scales is version 4 or later (gatelabrScalesVersion) or its about text
 *      says it is on Gating-ML's (GATELAB_ABOUT_LOGICLE_SCALE), as every standard export since
 *      2026-09 does;
 *   3. any other file is on the standard's scale, as the specification defines it.
 * Reading every unmarked file on flowCore's scale, as GateLab did until 2026-09, put a logicle
 * gate from any other Gating-ML writer 4.5 times too low.
 */
function parseGatelabFormat(root: Element): GatelabFormat {
  const ci = firstChildLocal(root, "custom_info");
  const tag = ci ? firstChildLocal(ci, GATELAB_FORMAT_TAG) : null;
  const problems: string[] = [];
  let parsed: Record<string, unknown> = {};
  if (tag) {
    // A mark that is there but cannot be read is refused rather than read as no mark: read as
    // none, a GateLab file's logicle is taken on flowCore's scale, 4.5 times too low, its tree is
    // inferred, and its Time is read in the wrong unit, each without a word.
    const text = (tag.textContent ?? "").trim();
    let v: unknown;
    try {
      v = text ? JSON.parse(text) : undefined;
    } catch {
      v = undefined;
    }
    if (!text) {
      problems.push(`The file's ${GATELAB_FORMAT_TAG} mark is empty.`);
    } else if (v === undefined) {
      problems.push(`The file's ${GATELAB_FORMAT_TAG} mark is not readable JSON.`);
    } else if (!v || typeof v !== "object" || Array.isArray(v)) {
      problems.push(`The file's ${GATELAB_FORMAT_TAG} mark is not a JSON object.`);
    } else {
      parsed = v as Record<string, unknown>;
      if (typeof parsed.version !== "number" || !KNOWN_FORMAT_VERSIONS.has(parsed.version)) {
        problems.push(
          `The file's ${GATELAB_FORMAT_TAG} mark has version ${JSON.stringify(parsed.version ?? null)}, which this ` +
          `GateLab does not read (it reads ${[...KNOWN_FORMAT_VERSIONS].join(" and ")}).`,
        );
      }
      if (parsed.logicle !== undefined && parsed.logicle !== "gating-ml" && parsed.logicle !== "flowcore") {
        problems.push(`The file's ${GATELAB_FORMAT_TAG} mark names an unknown logicle scale ${JSON.stringify(parsed.logicle)}.`);
      }
      if (parsed.hierarchy !== undefined && parsed.hierarchy !== "parent_id" && parsed.hierarchy !== "tree") {
        problems.push(`The file's ${GATELAB_FORMAT_TAG} mark names an unknown hierarchy ${JSON.stringify(parsed.hierarchy)}.`);
      }
      if (parsed.hierarchy === "tree" && parseTree(parsed.tree) === null) {
        problems.push(`The file's ${GATELAB_FORMAT_TAG} mark carries a tree that is not a list of populations with their parents.`);
      }
      if (parsed.time !== undefined && parsed.time !== "seconds" && parsed.time !== "ticks") {
        problems.push(`The file's ${GATELAB_FORMAT_TAG} mark names an unknown Time unit ${JSON.stringify(parsed.time)}.`);
      }
      if (parsed[COMPENSATED_FCS_MARK] !== undefined && parsed[COMPENSATED_FCS_MARK] !== "compensated") {
        problems.push(`The file's ${GATELAB_FORMAT_TAG} mark names an unknown "${COMPENSATED_FCS_MARK}" ${JSON.stringify(parsed[COMPENSATED_FCS_MARK])}.`);
      }
      if (problems.length) parsed = {};
    }
  }
  const logicleUnit = parsed.logicle === "gating-ml" ? true
    : parsed.logicle === "flowcore" ? false
    : !writtenByGatelab(root) || gatelabrScalesVersion(root) >= 4 || aboutText(root).includes(GATELAB_ABOUT_LOGICLE_SCALE);
  return {
    logicleUnit,
    parentIdHierarchy: parsed.hierarchy === "parent_id",
    tree: parsed.hierarchy === "tree" ? parseTree(parsed.tree) : null,
    time: parsed.time === "seconds" || parsed.time === "ticks" ? parsed.time : null,
    version: typeof parsed.version === "number" ? parsed.version : null,
    fcsCompensated: parsed[COMPENSATED_FCS_MARK] === "compensated",
    problems,
  };
}

/**
 * The unit a file's Time coordinates are in.
 *
 * GateLab keeps Time as the FCS stores it, in ticks of $TIMESTEP seconds. Gating-ML does not say
 * which unit a Time dimension is in, and readers differ: FlowKit (flowio) multiplies Time by
 * $TIMESTEP as FCS 3.1 describes, and FlowJo stores and shows it in seconds, while Cytobank and
 * flowCore keep ticks. So:
 *   • a GateLab mark with `time` says which (the standard format writes seconds, the Cytobank
 *     format ticks, and the FlowJo, FACSDiva and FACSChorus converters ticks, having converted);
 *   • any other file GateLab or GateLabR wrote, marked or not, is in ticks, as they wrote it;
 *   • a Cytobank file (Cytobank's custom_info) is in ticks;
 *   • every other file is in seconds, as FlowKit and FlowJo read it.
 * A default, 2026-09, for David to confirm; see the PR's decisions.
 */
function timeUnitOf(root: Element, format: GatelabFormat): "seconds" | "ticks" {
  if (format.time) return format.time;
  if (format.version !== null || writtenByGatelab(root) || carriesCytobankInfo(root)) return "ticks";
  return "seconds";
}

/**
 * Whether a file's flog is Gating-ML's own (undefined at or below zero), or the flog GateLab held
 * until 2026-09, which pins everything below T·10^−M at y = 0. GateLab wrote files by the second
 * rule until its mark reached version 3: they are read the way they were written. Every other
 * file is read as the standard defines flog.
 */
function flogIsStandard(root: Element, format: GatelabFormat): boolean {
  if (format.version !== null) return format.version >= 3;
  return !writtenByGatelab(root);
}

/**
 * Whether a file carries Cytobank's custom_info (a `cytobank` element in any custom_info), as
 * Cytobank's own exports and GateLab's Cytobank format do. Only such a file, and only when no gate
 * in it places itself with parent_id (placesByParentId), is read by Cytobank's model, in which
 * every population's BooleanGate ANDs its whole ancestry and parent_id is absent. Any other file is
 * read by Gating-ML 2.0's own: every gate is a population placed by its parent_id
 * (buildPopulationsFromBooleans).
 */
/**
 * Whether any gate places itself with gating:parent_id. Cytobank's model has no use for it, and
 * Cytobank's exports, like GateLab's Cytobank format, never write it; a file that does is laid out
 * as Gating-ML 2.0 lays it out, whatever custom_info it carries. GateLab's standard format writes a
 * `cytobank` element in each gate's custom_info, so without this, a standard file that had lost
 * GATELAB_FORMAT_TAG was read by Cytobank's model and refused.
 */
function placesByParentId(root: Element): boolean {
  for (let c = root.firstElementChild; c; c = c.nextElementSibling) if (attrLocal(c, "parent_id")) return true;
  return false;
}

function carriesCytobankInfo(root: Element): boolean {
  for (const el of descendants(root)) {
    if (el.localName === "cytobank" && el.parentElement?.localName === "custom_info") return true;
  }
  return false;
}

function detectSource(root: Element): "gatelabr" | "cytobank" | "generic" {
  const ci = firstChildLocal(root, "custom_info");
  if (ci && firstChildLocal(ci, "gatelabr_scales")) return "gatelabr";
  // any descendant <cytobank>
  for (const el of descendants(root)) {
    if (el.localName === "cytobank") return "cytobank";
  }
  return "generic";
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

type TransformDef = (
  | { type: "logicle"; T: number; W: number; M: number; A: number }
  | { type: "fasinh"; T: number; M: number; A: number }
  | { type: "flog"; T: number; M: number }
  | { type: "flin"; T: number; A: number }
) & {
  /** The transformation's boundMin and boundMax, in its own output units, when it declares them. */
  boundMin?: number;
  boundMax?: number;
};

interface ParsedTransforms {
  defs: Record<string, TransformDef>;
  /** Transformations declared with parameters no transform has, by id, with why. */
  invalid: Record<string, string>;
}

/**
 * Every top-level transformation GateLab can read, by id, and the ones whose parameters are
 * invalid. An invalid transformation used to be dropped here, and then refused as "unsupported or
 * missing", or, for a fasinh, inverted into raw with a gate of 0 events and no message; it is now
 * refused by name with what is wrong with it. Anything else (fratio, hyperlog) is left out and
 * refused as unsupported where a dimension references it.
 *
 * A parameter the file writes and GateLab cannot read as a finite number ("abc", "", INF, NaN) is
 * invalid. It was read as absent until 2026-09, and a default put in its place: logicle M 4.5 and
 * A 0, fasinh M log10 e and A 0, flin A 0, so a file saying M="abc" was evaluated on a scale it
 * does not declare. A parameter the file leaves out is still given that default, although the
 * schema requires every one, as GateLabR gives it.
 */
function parseTransforms(root: Element): ParsedTransforms {
  const defs: Record<string, TransformDef> = {};
  const invalid: Record<string, string> = {};
  /**
   * The parameters of `node` the file writes but GateLab cannot read as finite numbers, or null.
   * Read by xs:double's own spelling, since Number() takes "" and "  " for 0 and "0x10" for 16.
   */
  const unreadable = (node: Element, names: string[]): string | null => {
    const out = names.flatMap((name) => {
      const text = attrLocal(node, name);
      return text !== null && !(XS_DOUBLE_FINITE.test(text) && hasNum(num(text))) ? [`${name} = ${JSON.stringify(text)}`] : [];
    });
    return out.length ? `${out.join(" and ")}, ${out.length === 1 ? "which is not a finite number" : "which are not finite numbers"}` : null;
  };
  for (const el of Array.from(root.children)) {
    if (el.localName !== "transformation") continue;
    const id = attrLocal(el, "id");
    if (!id) continue;
    const bad = (why: string) => { invalid[id] = why; };

    // Transformations.v2.0.xsd: boundMin / boundMax on the transformation itself. A bound that is
    // no xs:double was read by Number(), "" and " " as 0 and "0x1" as 1 (verifier).
    const bMinText = attrLocal(el, "boundMin");
    const bMaxText = attrLocal(el, "boundMax");
    const bMin = bMinText === null ? undefined : xsNum(bMinText);
    const bMax = bMaxText === null ? undefined : xsNum(bMaxText);
    const notANumber = [["boundMin", bMinText, bMin], ["boundMax", bMaxText, bMax]]
      .filter(([, , v]) => v !== undefined && Number.isNaN(v))
      .map(([name, text]) => `its ${name} = ${JSON.stringify(text)}`);
    if (notANumber.length) {
      bad(`${notANumber.join(" and ")}, ${notANumber.length === 1 ? "which is not a number" : "which are not numbers"}`);
      continue;
    }
    if (bMin !== undefined && bMax !== undefined && bMin > bMax) {
      bad(`its boundMin ${bMin} is above its boundMax ${bMax}`);
      continue;
    }
    const bounds = {
      ...(bMin !== undefined && bMin !== -Infinity ? { boundMin: bMin } : {}),
      ...(bMax !== undefined && bMax !== Infinity ? { boundMax: bMax } : {}),
    };

    const lg = firstChildLocal(el, "logicle");
    if (lg) {
      const unread = unreadable(lg, ["T", "W", "M", "A"]);
      if (unread) {
        bad(`logicle with ${unread}`);
        continue;
      }
      const t = num(attrLocal(lg, "T"));
      const w = num(attrLocal(lg, "W"));
      const m0 = num(attrLocal(lg, "M"));
      const a0 = num(attrLocal(lg, "A"));
      const m = hasNum(m0) ? m0 : 4.5;
      const a = hasNum(a0) ? a0 : 0;
      // Gating-ML 2.0 logicle (Transformations.v2.0.xsd and §6.4): T > 0, M > 0, 0 <= W <= M/2,
      // and A <= M - 2W, which the schema states in a comment and leaves the reader to check;
      // GateLab evaluated a larger A until 2026-09, and GateLabR refuses it. GateLab's logicle,
      // like Parks et al.'s, takes A >= 0. The two upper bounds allow for rounding
      // (withinLogicleBound): compared exactly, a logicle written in decimal with A at M - 2W,
      // such as M = 4.42, W = 0.87 and A = 2.68, was refused as above it.
      if (!hasNum(t) || !hasNum(w)) bad("logicle without a numeric T and W");
      else if (!(t > 0)) bad(`logicle with T = ${t}; T must be positive`);
      else if (!(m > 0)) bad(`logicle with M = ${m}; M must be positive`);
      else if (w < 0) bad(`logicle with W = ${w}; W cannot be negative`);
      else if (!withinLogicleBound(w, m / 2, m)) bad(`logicle with W = ${w} above M/2 = ${m / 2}`);
      else if (a < 0) bad(`logicle with A = ${a}; A cannot be negative`);
      else if (!withinLogicleBound(a, m - 2 * w, m)) bad(`logicle with A = ${a} above M - 2W = ${m - 2 * w}`);
      else defs[id] = { type: "logicle", T: t, W: w, M: m, A: a, ...bounds };
      continue;
    }

    // Cytobank writes flog for a Log scale, which is what a flow experiment gets by default.
    // Without this the whole file is rejected as "unsupported transformation" — safe, but it
    // makes a Cytobank flow strategy unreadable.
    const lo = firstChildLocal(el, "flog") ?? firstChildLocal(el, "log");
    if (lo) {
      // M = "0x4" was read by Number() as 4 (verifier).
      const unread = unreadable(lo, ["T", "M"]);
      if (unread) {
        bad(`flog with ${unread}`);
        continue;
      }
      const t = num(attrLocal(lo, "T"));
      const m = num(attrLocal(lo, "M"));
      if (!(hasNum(t) && t > 0)) bad(`flog with T = ${attrLocal(lo, "T")}; T must be positive`);
      else if (!(hasNum(m) && m > 0)) bad(`flog with M = ${attrLocal(lo, "M")}; M must be positive`);
      else defs[id] = { type: "flog", T: t, M: m, ...bounds };
      continue;
    }

    const fa = firstChildLocal(el, "fasinh") ?? firstChildLocal(el, "arcsinh");
    if (fa) {
      const unread = unreadable(fa, ["T", "M", "A"]);
      if (unread) {
        bad(`fasinh with ${unread}`);
        continue;
      }
      const t = num(attrLocal(fa, "T"));
      const m0 = num(attrLocal(fa, "M"));
      const a0 = num(attrLocal(fa, "A"));
      const m = hasNum(m0) ? m0 : Math.log10(Math.E);
      const a = hasNum(a0) ? a0 : 0;
      // fasinh(x) = (asinh(x·sinh(M ln10)/T) + A ln10) / ((M + A) ln10): T and M positive, and
      // A not negative (Transformations.v2.0.xsd types it UFloat64; FlowKit refuses A < 0).
      //
      // GateLab holds it as asinh(x / c) with c = T / sinh(M ln10) (specFromGmlTransform), so
      // sinh(M ln10), above M of about 308.55, and c must be finite; each was refused as a
      // transform GateLab "cannot hold exactly", without saying why. An event whose
      // x sinh(M ln10) / T overflows (at M = 300 and T = 262144, one above about 9.4e13) lies at
      // ±Infinity, where FlowKit places it too: in a range open on that side, and in no polygon,
      // ellipse or bounded range. From 5f2de9c this refused every M at which a single-precision
      // value could overflow so, about 275 with T = 262144, and so M from 276 to 308.5, which
      // GateLab had read equal to FlowKit on the public PBMC file (verifier).
      const sinhM = Math.sinh(m * LN10);
      if (!(hasNum(t) && t > 0)) bad(`fasinh with T = ${attrLocal(fa, "T")}; T must be positive`);
      else if (!(m > 0)) bad(`fasinh with M = ${m}; M must be positive`);
      else if (!(a >= 0)) bad(`fasinh with A = ${a}; A cannot be negative`);
      else if (!hasNum(sinhM)) bad(`fasinh with M = ${m}; sinh(M ln 10) overflows double precision`);
      else if (!(hasNum(t / sinhM) && t / sinhM > 0)) {
        bad(`fasinh with T = ${t} and M = ${m}; T / sinh(M ln 10) ${t / sinhM > 0 ? "overflows" : "underflows"} double precision`);
      } else if (!hasNum((m + a) * LN10)) bad(`fasinh with M + A = ${m + a}, which overflows double precision`);
      else defs[id] = { type: "fasinh", T: t, M: m, A: a, ...bounds };
      continue;
    }

    // Gating-ML 2.0 flin: (x + A) / (T + A), T positive.
    const li = firstChildLocal(el, "flin");
    if (li) {
      const unread = unreadable(li, ["T", "A"]);
      if (unread) {
        bad(`flin with ${unread}`);
        continue;
      }
      const t = num(attrLocal(li, "T"));
      const a0 = num(attrLocal(li, "A"));
      const a = hasNum(a0) ? a0 : 0;
      if (!(hasNum(t) && t > 0)) bad(`flin with T = ${attrLocal(li, "T")}; T must be positive`);
      else if (!(t + a > 0)) bad(`flin with T + A = ${t + a}; it must be positive`);
      else defs[id] = { type: "flin", T: t, A: a, ...bounds };
      continue;
    }
  }
  return { defs, invalid };
}

// ---------------------------------------------------------------------------
// Dimensions + channel resolution
// ---------------------------------------------------------------------------

interface GmlDim {
  channel: string;
  transformation_ref?: string;
  compensation_ref?: string;
  min?: number;
  max?: number;
}

function parseDimensions(gate: Element): GmlDim[] {
  const dims: GmlDim[] = [];
  for (const dim of childrenLocal(gate, "dimension")) {
    const param = firstChildLocal(dim, "fcs-dimension") ?? firstChildLocal(dim, "parameter");
    const ch = param ? attrLocal(param, "name") : null;
    if (!ch) continue;
    const d: GmlDim = { channel: ch };
    const tr = attrLocal(dim, "transformation-ref");
    if (tr) d.transformation_ref = tr;
    const comp = attrLocal(dim, "compensation-ref");
    if (comp) d.compensation_ref = comp;
    // A bound of INF or -INF is no bound on that side, and the importer's no-bound value on the
    // other; either way it is held as ±UNBOUNDED.
    const bound = (v: number): number | undefined =>
      hasNum(v) ? v : v === Infinity ? UNBOUNDED : v === -Infinity ? -UNBOUNDED : undefined;
    const mn = bound(num(attrLocal(dim, "min")));
    const mx = bound(num(attrLocal(dim, "max")));
    if (mn !== undefined) d.min = mn;
    if (mx !== undefined) d.max = mx;
    if (d.min === undefined || d.max === undefined) {
      for (const sub of Array.from(dim.children)) {
        if (sub.localName !== "min" && sub.localName !== "max") continue;
        const val = num(attrLocal(sub, "value"));
        if (!hasNum(val)) continue;
        if (sub.localName === "min" && d.min === undefined) d.min = val;
        if (sub.localName === "max" && d.max === undefined) d.max = val;
      }
    }
    dims.push(d);
  }
  return dims;
}

/**
 * The dimensions of a gate that name no FCS channel, described: a Gating-ML 2.0 new-dimension
 * (a ratio of two channels through an fratio transformation), or a dimension naming nothing.
 * parseDimensions leaves them out, and a gate reduced that way is a different gate: a rectangle on
 * a channel and a ratio became a range on the channel alone (5,384 events where FlowKit counts
 * 2,905, on a FlowKit-written singlet gate over the public LSR-II file). Such a gate is left out,
 * by name, with what depends on it.
 */
function unnamedDimensions(gate: Element): string[] {
  const out: string[] = [];
  for (const dim of childrenLocal(gate, "dimension")) {
    const param = firstChildLocal(dim, "fcs-dimension") ?? firstChildLocal(dim, "parameter");
    if (param && attrLocal(param, "name")) continue;
    const nd = firstChildLocal(dim, "new-dimension");
    const ref = nd ? attrLocal(nd, "transformation-ref") : null;
    out.push(nd ? `the ratio dimension ${ref ?? "(unnamed)"}` : "a dimension that names no channel");
  }
  return out;
}

/**
 * The numbers a gate writes that GateLab cannot read as the file means them, described: a
 * dimension's min or max that is no xs:double, or NaN (INF and -INF are no bound on that side);
 * a vertex's coordinate, an ellipse's mean, a covariance entry or its distanceSquare that is no
 * finite xs:double; a vertex without two coordinates. Each was given a value without a word:
 * Number() read "" and " " as 0 and "0x1" as 1, a min read as NaN was taken for no bound, a vertex
 * that did not read was dropped, and a distanceSquare that did not read became 1. On the public
 * PBMC file a range with min="NaN" held 37,405 events where FlowKit holds none, and a vertex "abc"
 * or "" turned a polygon of 50,482 events into one of 40,375 or 76,037 (verifier). The gate is
 * refused, as xmllint and FlowKit refuse the file (FlowKit reads NaN, and holds nothing in it).
 */
function unreadableGateNumbers(gate: Element): string[] {
  const out: string[] = [];
  /** A number the gate must carry; `text` undefined where it may leave it out. */
  const finite = (what: string, text: string | null | undefined) => {
    if (text === null) out.push(`${what} with no value`);
    else if (text !== undefined && !hasNum(xsNum(text))) out.push(`${what} = ${JSON.stringify(text)}, which is not a finite number`);
  };
  for (const dim of childrenLocal(gate, "dimension")) {
    const param = firstChildLocal(dim, "fcs-dimension") ?? firstChildLocal(dim, "parameter");
    const ch = (param && attrLocal(param, "name")) ?? "a dimension";
    const edge = (side: string, text: string | null) => {
      if (text !== null && Number.isNaN(xsNum(text))) out.push(`${side} = ${JSON.stringify(text)} on ${ch}, which is not a number`);
    };
    edge("min", attrLocal(dim, "min"));
    edge("max", attrLocal(dim, "max"));
    for (const sub of Array.from(dim.children)) {
      if (sub.localName === "min" || sub.localName === "max") edge(sub.localName, attrLocal(sub, "value"));
    }
  }
  childrenLocal(gate, "vertex").forEach((v, i) => {
    const coords = childrenLocal(v, "coordinate");
    if (coords.length < 2) out.push(`vertex ${i + 1} with ${coords.length} coordinate${coords.length === 1 ? "" : "s"}`);
    coords.slice(0, 2).forEach((c, k) => finite(`vertex ${i + 1} with ${k ? "y" : "x"}`, attrLocal(c, "value")));
  });
  const mean = firstChildLocal(gate, "mean");
  if (mean) childrenLocal(mean, "coordinate").slice(0, 2).forEach((c, k) => finite(`mean ${k ? "y" : "x"}`, attrLocal(c, "value")));
  const cov = firstChildLocal(gate, "covarianceMatrix");
  if (cov) {
    childrenLocal(cov, "row").forEach((r, i) =>
      childrenLocal(r, "entry").forEach((e, j) => finite(`covariance entry ${i + 1}, ${j + 1}`, attrLocal(e, "value"))));
  }
  const d2El = firstChildLocal(gate, "distanceSquare");
  // Left out, it is 1, as GateLab has read it.
  finite("distanceSquare", attrLocal(gate, "distanceSquare") ?? (d2El ? attrLocal(d2El, "value") : undefined));
  return out;
}

/**
 * The metal a mass cytometry channel name spells (channelMatch.metalOf), as the element in lower
 * case followed by the mass: "CD3 (Y89Di)" gives "y89" and "141Pr" "pr141"; a name that spells no
 * metal gives "". Until 2026-09 it kept any name's first one to three letters and two or three
 * digits, whatever the name was, so "CD11c" and "CD11b" both gave "cd11", and on mass cytometry
 * data a gate on CD11c, over data without it, was read on CD11b without a word; so was CD62L on
 * CD62P. A name now spells a metal only as an element's symbol in its own case with a mass within
 * that element's natural isotopes, as GateLabR reads it.
 */
export function normalizeChannel(ch: string): string {
  return metalOf(ch);
}

/**
 * The session channel a name in the file refers to, or null when it refers to none or to more than
 * one. A name is taken in this order, and at the first way that finds anything:
 *   1. a session channel, exactly;
 *   2. a $PnN of the loaded file, exactly (pnnToChannel maps it to its session channel);
 *   3. a $PnN with case and punctuation ignored (channelMatch.punctuationInsensitive);
 *   4. a session channel with case ignored;
 *   5. a session channel with case and punctuation ignored;
 *   6. on mass cytometry data only, and only for a name that spells a metal (channelMatch.metalOf),
 *      the channel whose $PnN, or else whose session name, spells the same metal: "141Pr" for
 *      "Pr141Di".
 * A way that finds two channels refuses the name rather than take the first, and so does a name
 * that is one channel's session name and another's $PnN. These are GateLabR's ways (PR #63,
 * .gml_resolve_channel), which refuses no ambiguity at steps 3 to 5 but takes the first channel.
 *
 * Ignoring case and punctuation kept a-z and 0-9 only until 2026-09, and so every other letter and
 * every sign: over data with TCRαβ and no TCRγδ a gate on TCRγδ was read on TCRαβ, and over CD3+ a
 * gate on CD3- was read on CD3+, without a word.
 */
export function resolveChannel(
  ch: string,
  sessionChannels: string[],
  pnnToChannel: Record<string, string>,
  instrument: "flow" | "cytof" = "cytof",
): string | null {
  const pnnKeys = Object.keys(pnnToChannel);
  const viaPnn = (key: string): string | null =>
    sessionChannels.includes(pnnToChannel[key]) ? pnnToChannel[key] : null;
  /** The one channel the names found, null for none, undefined for more than one. */
  const one = (found: (string | null)[]): string | null | undefined => {
    const distinct = [...new Set(found.filter((c): c is string => c !== null))];
    return distinct.length === 0 ? null : distinct.length === 1 ? distinct[0] : undefined;
  };

  if (sessionChannels.includes(ch)) {
    // A name that is one channel's session key AND another channel's $PnN names two channels
    // at once (a $PnS equal to a neighbour's $PnN). Taking the key would put a gate written
    // against the $PnN on the wrong detector, so it is refused as ambiguous.
    const viaPnnHit = ch in pnnToChannel ? viaPnn(ch) : null;
    if (viaPnnHit && viaPnnHit !== ch) return null;
    return ch;
  }

  if (pnnKeys.length && ch in pnnToChannel) {
    const hit = viaPnn(ch);
    if (hit) return hit;
  }

  // Exact on every letter, digit and sign, so it cannot conflate two detectors or two markers --
  // tried before any step that reads less of the name.
  const punct = punctuationInsensitive(ch);
  const steps: (() => (string | null)[])[] = [
    () => (punct ? pnnKeys.filter((k) => punctuationInsensitive(k) === punct).map(viaPnn) : []),
    () => sessionChannels.filter((s) => s.toLowerCase() === ch.toLowerCase()),
    () => (punct ? sessionChannels.filter((s) => punctuationInsensitive(s) === punct) : []),
  ];
  for (const step of steps) {
    const hit = one(step());
    if (hit !== null) return hit ?? null;
  }

  /*
   * Last resort, for mass cytometry only, for a name that spells a metal, and only when it names
   * ONE channel.
   *
   * On conventional flow detectors a metal step that kept any name's first letters and number
   * discarded the laser prefix, so `b-FLT525/30-B-A` and `v-FLT525/30-E-A` both reduced to
   * `flt525` -- and taking the first match silently evaluated a violet-laser viability gate
   * against the blue laser's detector. The gate resolved, drew, and reported a plausible count;
   * nothing failed. Refusing an ambiguous match (2026-09-10) covered a file holding BOTH
   * detectors; a file holding only the blue one still resolved the violet gate onto it, with
   * nothing reported, which is why the step is left to mass cytometry. There, whose session
   * channels are marker names, the same reduction read CD11c on CD11b until the step took only a
   * metal (normalizeChannel). A flow name that survives every exact and punctuation-insensitive
   * test above is not present, and the import says so.
   */
  if (instrument !== "cytof") return null;
  const metal = metalOf(ch);
  if (!metal) return null;
  const byPnn = one(pnnKeys.filter((k) => metalOf(k) === metal).map(viaPnn));
  if (byPnn !== null) return byPnn ?? null;
  const bySession = one(sessionChannels.filter((s) => metalOf(s) === metal));
  return bySession ?? null;
}

// ---------------------------------------------------------------------------
// Declared transform → the space a gate is held in
// ---------------------------------------------------------------------------

/** A declared transform as a GateLab TransformSpec, and the map from file coordinates to it. */
interface GateAxisSpec {
  spec: TransformSpec;
  /** A coordinate as the file writes it → the gate's own coordinate. Affine and increasing. */
  toGateUnits: (v: number) => number;
  /**
   * For an axis held on raw values (identity or flin, with no bounds): a stored value → its
   * coordinate as the file writes it, computed as the standard's reader computes it (FlowKit, in
   * double precision). What rectEdge searches with.
   */
  fileOf?: (raw: number) => number;
  /**
   * A rectangle edge as the stored value from which on ("lo") or up to which ("hi") an event is
   * inside, exactly, where toGateUnits rounds: set only where the conversion is not the identity.
   */
  rectEdge?: (v: number, side: "lo" | "hi") => number;
  /** Made by rawRectangleAxis, which inTicks rebuilds on ticks. */
  rawRectangle?: true;
  /** How far rectEdge widens an edge, in doubles (rawRectangleAxis). */
  edgeUlps?: number;
  /**
   * The same axis held on raw values, for a rectangle from another writer (rectanglesOnRaw in
   * importGatingML): identity, with each edge placed on the stored values exactly (rectEdge) by the
   * file's transform, bounds and all, as the standard's reader computes it. Held in the declared
   * space instead, the rectangle is decided on each event's value there in single precision
   * (Sample.pinnedColumn), which puts an event whose value is the edge on either side of it. Set
   * for a fasinh other than GateLab's own asinh, which was held on raw values until 2026-09, and
   * for a bounded raw or flin axis; GateLab's asinh, logicle and flog are held as declared, as
   * they always were, ties and all.
   */
  rawRect?: GateAxisSpec;
}

/** How far a fasinh rectangle edge is widened for readers' own asinh (rawRectangleAxis). */
const FASINH_EDGE_ULPS = 4;

/**
 * Gating-ML 2.0's fasinh and its inverse as FlowKit computes them (flowutils.transforms.asinh and
 * asinh_inverse, 1.3.1), operation for operation, so that an edge a writer placed on an event's own
 * value is decided for that event as the writer's reader decides it. GateLab's own asinh(x / c) is
 * the same function, differently rounded.
 */
export function gatingMLFasinh(T: number, M: number, A: number): { forward: (x: number) => number; inverse: (y: number) => number } {
  const preScale = Math.sinh(M * LN10) / T;
  const transpose = A * LN10;
  const divisor = (M + A) * LN10;
  return {
    forward: (x) => (Math.asinh(x * preScale) + transpose) / divisor,
    inverse: (y) => Math.sinh(y * divisor - transpose) / preScale,
  };
}

/**
 * An axis held on raw values for a rectangle (GateAxisSpec.rawRect): `fileOf` is a stored value's
 * coordinate as the file writes it, `rawOf` its inverse, which only starts the search. Its rectEdge
 * is NaN for an edge no stored value can be placed at: one beyond every coordinate the transform
 * reaches, as a bound puts it, where the axis is held as declared instead.
 *
 * `edgeUlps` widens each edge by that many doubles, so that a coordinate that close to it is taken
 * to lie on it: set where fileOf goes through a function each reader computes with its own
 * library. V8's Math.asinh is fdlibm's, and the C library's, which NumPy and R use, differs from it
 * in the last place for some values (42 of the 2,193 distinct FITC-A values of the public LSR-II
 * file under fasinh M = 4.2, A = 0.5; 16 of 498 Time values of the public FACSCalibur file under
 * M = 4.5), so an edge FlowKit put on such an event's own value was a unit above it in V8. Distinct
 * stored values lie far further apart in any coordinate than a few units in the last place.
 */
function rawRectangleAxis(fileOf: (raw: number) => number, rawOf: (v: number) => number, edgeUlps = 0): GateAxisSpec {
  const guess = (v: number): number => {
    const x = rawOf(v);
    return Number.isNaN(x) ? 0 : Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, x));
  };
  const widen = (v: number, side: "lo" | "hi"): number =>
    edgeUlps ? keyDouble(doubleKey(v) + BigInt(side === "lo" ? -edgeUlps : edgeUlps)) : v;
  return {
    spec: { kind: "identity" },
    toGateUnits: guess,
    fileOf,
    rectEdge: (v, side) => {
      // Every transform held this way gives every stored value a coordinate, so an edge with no
      // bound has none on raw values either.
      if (isUnbounded(v)) return v;
      const w = widen(v, side);
      const t = exactStoredEdge(w, side, fileOf, guess(v));
      // The search gives back its starting point when no stored value passes the edge.
      const y = fileOf(t);
      return (side === "lo" ? y >= w : y <= w) ? t : NaN;
    },
    rawRectangle: true,
    ...(edgeUlps ? { edgeUlps } : {}),
  };
}

const EDGE_F64 = new Float64Array(1);
const EDGE_I64 = new BigInt64Array(EDGE_F64.buffer);
const EDGE_MAG = (1n << 63n) - 1n;
const EDGE_MAX_KEY = 0x7fefffffffffffffn; // the largest finite double's key
/** A double's position in order: adjacent doubles have adjacent keys, and −0 and +0 share 0. */
function doubleKey(x: number): bigint {
  EDGE_F64[0] = x;
  const b = EDGE_I64[0];
  return b >= 0n ? b : -(b & EDGE_MAG);
}
function keyDouble(k: bigint): number {
  EDGE_I64[0] = k >= 0n ? k : BigInt.asIntN(64, -k | (1n << 63n));
  return EDGE_F64[0];
}

/**
 * The stored value at which a rectangle edge `v`, a coordinate as the file writes it, falls: exact
 * for every value a column can hold, where converting `v` itself rounds. For "lo", the least double
 * t with fileOf(t) >= v, so that x >= t exactly when fileOf(x) >= v; for "hi", the greatest t with
 * fileOf(t) <= v, so that x <= t exactly when fileOf(x) <= v, which is GateLab's closed upper edge.
 * A half-open upper edge (x < t exactly when fileOf(x) < v) is the "lo" value of the same edge.
 * `fileOf` must not decrease; `guess` is the converted edge, a step or two from the answer.
 *
 * Dividing a Time edge in seconds by $TIMESTEP, or taking a flin edge back to raw, can land one
 * step past a value whose own coordinate is the edge: 10.052100219726563 s / 0.01 is one step
 * above the tick 1005.2100219726562, whose seconds, as FlowKit computes them, are exactly that
 * edge. A writer that puts an edge on an event's own value, as FlowKit-written ranges on the
 * public FACSDiva, PBMC17 and Fortessa files do, lost that event.
 */
function exactStoredEdge(v: number, side: "lo" | "hi", fileOf: (raw: number) => number, guess: number): number {
  if (!Number.isFinite(guess)) return guess;
  // The least key whose value's coordinate passes the edge: >= v for "lo", > v for "hi".
  const pass = side === "lo" ? (k: bigint) => fileOf(keyDouble(k)) >= v : (k: bigint) => fileOf(keyDouble(k)) > v;
  const clamp = (k: bigint) => (k < -EDGE_MAX_KEY ? -EDGE_MAX_KEY : k > EDGE_MAX_KEY ? EDGE_MAX_KEY : k);
  let lo: bigint; // does not pass
  let hi: bigint; // passes
  const k0 = clamp(doubleKey(guess));
  if (pass(k0)) {
    hi = k0;
    for (let step = 1n; ; step *= 2n) {
      const k = clamp(hi - step);
      if (!pass(k)) { lo = k; break; }
      if (k === -EDGE_MAX_KEY) return side === "lo" ? -UNBOUNDED : guess; // every value passes
      hi = k;
    }
  } else {
    lo = k0;
    for (let step = 1n; ; step *= 2n) {
      const k = clamp(lo + step);
      if (pass(k)) { hi = k; break; }
      if (k === EDGE_MAX_KEY) return side === "hi" ? UNBOUNDED : guess; // no value passes
      lo = k;
    }
  }
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    if (pass(mid)) hi = mid;
    else lo = mid;
  }
  return keyDouble(side === "lo" ? hi : lo);
}

/**
 * A declared Gating-ML transform expressed exactly as a GateLab TransformSpec, or null when
 * GateLab cannot hold it (which parseTransforms refuses before a gate is built).
 *
 * Gating-ML §4.2.3 makes the transform part of the GATE: a polygon is straight in the space its
 * dimension's transformation-ref declares. So the faithful import is to keep the vertices in that
 * space and record the transform on the gate — not to invert them into raw, which yields a
 * different gate (§2.3.2 works the example and calls that substitution naive).
 *
 * Every transform GateLab reads is held exactly, through a per-axis map that is affine and
 * increasing, so a straight edge stays straight, an ellipse stays an ellipse, and a bound stays a
 * bound:
 *   • logicle: GateLab's own logicle, on Gating-ML's scale or flowCore's (v / M);
 *   • fasinh: (asinh(x / c) + A ln10) / ((M + A) ln10) with c = T / sinh(M ln10), for ANY M and A,
 *     is affine in GateLab's asinh(x / c), so it is held as that, with v → v(M + A) ln10 − A ln10.
 *     Until 2026-09 only M = log10 e with A = 0 was, and every other fasinh was inverted into raw
 *     with the sign of A reversed (ISAC ScaleRange1: 1 event where the suite expects 8,425), or,
 *     on CyTOF, not inverted at all and labelled raw (a FlowKit-written B-cell gate on the public
 *     Bodenmiller file: FlowKit 131 events, GateLab 117);
 *   • flog: held as a log space, Gating-ML's own flog unless the file is GateLab's older one;
 *   • flin: (x + A) / (T + A) is affine in x, so it is raw, with v → v(T + A) − A.
 * boundMin and boundMax ride on the spec in the gate's own units.
 */
function specFromGmlTransform(
  tr: TransformDef | undefined,
  /** False only for logicle coordinates on flowCore's scale (T at M); see parseGatelabFormat. */
  logicleUnit = true,
  /** False only for flog in a file GateLab wrote before its mark reached version 3; see flogIsStandard. */
  flogStandard = true,
): GateAxisSpec | null {
  if (!tr) return { spec: { kind: "identity" }, toGateUnits: (v) => v, fileOf: (x) => x };
  const withBounds = (out: GateAxisSpec): GateAxisSpec => {
    if (tr.boundMin === undefined && tr.boundMax === undefined) return out;
    // A bounded axis is tested on its pinned column, not on raw values (Sample.pinnedColumn); a
    // rectangle from another writer on raw values, with the bounds applied to the file's
    // coordinate first, as its reader applies them (NaN kept).
    const { fileOf: _f, rectEdge: _e, rawRectangle: _r, rawRect, ...rest } = out;
    const plainFileOf = rawRect?.fileOf ?? out.fileOf;
    const plainRawOf = rawRect?.toGateUnits ?? out.toGateUnits;
    const [bMin, bMax] = [tr.boundMin, tr.boundMax];
    const bounded = plainFileOf
      ? (x: number) => {
          const y = plainFileOf(x);
          return bMin !== undefined && y < bMin ? bMin : bMax !== undefined && y > bMax ? bMax : y;
        }
      : null;
    return {
      ...rest,
      ...(bounded ? { rawRect: rawRectangleAxis(bounded, plainRawOf, rawRect?.edgeUlps ?? 0) } : {}),
      spec: {
        ...out.spec,
        bounds: {
          ...(tr.boundMin !== undefined ? { min: out.toGateUnits(tr.boundMin) } : {}),
          ...(tr.boundMax !== undefined ? { max: out.toGateUnits(tr.boundMax) } : {}),
        },
      } as TransformSpec,
    };
  };

  if (tr.type === "logicle") {
    const { T, W, M, A } = tr;
    if (!(T > 0) || !(W >= 0) || !(M > 0) || !(A >= 0) || !withinLogicleBound(W, M / 2, M)) return null;
    // GateLab's logicle spans [0, 1], as Gating-ML 2.0's does. GateLabR, and GateLab until
    // 2026-09, wrote flowCore's scale instead, which is Gating-ML's times M for every A (flowCore
    // maps T to M); parseGatelabFormat says which a file uses. This divided by M + A until
    // 2026-09, which agrees only at the A = 0 both write.
    return withBounds({ spec: { kind: "logicle", T, W, M, A }, toGateUnits: logicleUnit ? (v) => v : (v) => v / M });
  }

  if (tr.type === "fasinh") {
    const { T, M, A } = tr;
    if (!(T > 0) || !(M > 0) || !(M + A > 0)) return null;
    const cofactor = T / Math.sinh(M * LN10);
    if (!Number.isFinite(cofactor) || cofactor <= 0) return null;
    // M = log10 e with A = 0 is asinh(x / c) itself, taken as it is so that a coordinate comes
    // back to the last bit (log10 e · ln 10 is not exactly 1 in floating point).
    if (Math.abs(M - Math.log10(Math.E)) <= 1e-9 && A === 0) {
      return withBounds({ spec: { kind: "asinh", cofactor }, toGateUnits: (v) => v });
    }
    const scale = (M + A) * LN10;
    const shift = A * LN10;
    // Any other fasinh was held on raw values until 2026-09 (inverted, with the sign of A reversed),
    // where a rectangle's edges are exact. A rectangle from another writer still is, with its edges
    // placed where the file's reader puts them (rawRect): held as asinh instead, an event whose
    // value is its lower edge fell out of it, in single precision (a FlowKit-written TimeAsinh
    // range on the public FACSCalibur file: 75 events).
    const file = gatingMLFasinh(T, M, A);
    return withBounds({
      spec: { kind: "asinh", cofactor }, toGateUnits: (v) => v * scale - shift,
      rawRect: rawRectangleAxis(file.forward, file.inverse, FASINH_EDGE_ULPS),
    });
  }

  if (tr.type === "flog") {
    // Held as a gate space rather than inverted to raw. §4.2.3 makes the transform part of the
    // gate, so a polygon declared under flog is straight in LOG coordinates; inverting its
    // vertices into raw and joining them with straight raw edges gives a different, bowed gate.
    // GateLab does not draw a log axis, but it does not need to — a gate can live in a space the
    // app never displays on, exactly as biex and wsplog already do (models.ts).
    const { T, M } = tr;
    if (!(T > 0) || !(M > 0)) return null;
    return withBounds({
      spec: flogStandard ? { kind: "flog", T, M, standard: true } : { kind: "flog", T, M },
      toGateUnits: (v) => v,
    });
  }

  if (tr.type === "flin") {
    const { T, A } = tr;
    if (!(T > 0) || !(T + A > 0)) return null;
    const toGateUnits = (v: number) => v * (T + A) - A;
    // (x + A) / (T + A), as FlowKit computes it.
    const fileOf = (x: number) => (x + A) / (T + A);
    return withBounds({
      spec: { kind: "identity" }, toGateUnits, fileOf,
      rectEdge: (v, side) => exactStoredEdge(v, side, fileOf, toGateUnits(v)),
    });
  }

  return null;
}

/**
 * Why a gate GateLab would hold on a fasinh's own scale cannot be held there, or null.
 *
 * Such a gate, a polygon, an ellipse or GateLab's own rectangle, is tested on each event's value on
 * the scale in single precision (Sample.pinnedColumn), where a fasinh is GateLab's asinh(x / c) with
 * c = T / sinh(M ln 10). At x = T / 2^24 that value is about sinh(M ln 10) / 2^24, and where it falls
 * below single precision's least normal number, 2^-126, the values an FCS parameter holds within
 * 24 bits of T lose bits and then become 0: below M of about 8.6e-32. At M = 1e-45 every event of
 * the public PBMC file was 0 there, and a FlowKit-written polygon held none of the 30,464 events
 * FlowKit counts. A rectangle from another writer is held on raw values (rawRectangleAxis), where
 * any M is exact.
 */
function fasinhBeyondSinglePrecision(tr: TransformDef | undefined): string | null {
  if (tr?.type !== "fasinh" || !(Math.sinh(tr.M * LN10) < 2 ** -102)) return null;
  return `is declared on a fasinh with M = ${tr.M}, whose values GateLab cannot hold in the single ` +
    "precision it tests this gate in (M below about 8.6e-32)";
}

/**
 * The same axis on stored Time ticks, for a Time coordinate the file writes in seconds (ticks
 * times $TIMESTEP; see timeUnitOf). Each transform GateLab holds, of x times a constant, is the
 * same transform of x with its scale parameter divided by that constant, so a transformed axis
 * keeps its coordinates and bounds and has its T (or cofactor) divided, and a raw one has its
 * coordinates divided.
 *
 * Dividing rounds, so a raw axis's rectangle edges are found by search instead (exactStoredEdge):
 * the tick from which on, or up to which, tick × $TIMESTEP, as FlowKit computes it, is inside. A
 * transformed axis decides an event on an edge on its value in single precision
 * (Sample.pinnedColumn), which is not exact at a tie, on Time as on any other channel.
 */
function inTicks(axis: GateAxisSpec, timestep: number): GateAxisSpec {
  const s = axis.spec;
  switch (s.kind) {
    case "identity": {
      const toGateUnits = (v: number) => axis.toGateUnits(v) / timestep;
      const fileOf = axis.fileOf;
      if (axis.rawRectangle && fileOf) return rawRectangleAxis((t) => fileOf(t * timestep), toGateUnits, axis.edgeUlps ?? 0);
      return {
        spec: s.bounds
          ? {
              kind: "identity",
              bounds: {
                ...(s.bounds.min !== undefined ? { min: s.bounds.min / timestep } : {}),
                ...(s.bounds.max !== undefined ? { max: s.bounds.max / timestep } : {}),
              },
            }
          : s,
        toGateUnits,
        ...(fileOf
          ? {
              fileOf: (t: number) => fileOf(t * timestep),
              rectEdge: (v: number, side: "lo" | "hi") => exactStoredEdge(v, side, (t) => fileOf(t * timestep), toGateUnits(v)),
            }
          : {}),
        ...(axis.rawRect ? { rawRect: inTicks(axis.rawRect, timestep) } : {}),
      };
    }
    case "asinh":
      return {
        spec: { ...s, cofactor: s.cofactor / timestep }, toGateUnits: axis.toGateUnits,
        ...(axis.rawRect ? { rawRect: inTicks(axis.rawRect, timestep) } : {}),
      };
    case "logicle":
    case "flog":
      return {
        spec: { ...s, T: s.T / timestep }, toGateUnits: axis.toGateUnits,
        ...(axis.rawRect ? { rawRect: inTicks(axis.rawRect, timestep) } : {}),
      };
    default:
      return axis; // biex and wsplog never come from a Gating-ML transformation
  }
}

/** The FCS $TIMESTEP a Time coordinate in seconds is divided by, or null when it is absent or 1. */
export function fcsTimestep(keywords: Record<string, string | undefined>): number | null {
  const ts = Number(keywords["$TIMESTEP"]);
  return Number.isFinite(ts) && ts > 0 && ts !== 1 ? ts : null;
}

/** FlowKit (flowio) and FlowJo find the Time parameter by its $PnN, "Time" in any case. */
export const isTimeParameter = (name: string): boolean => /^time$/i.test(name.trim());

// ---------------------------------------------------------------------------
// Gate node parsing
// ---------------------------------------------------------------------------

/** The space a FlowJo workspace gate was converted into; see flowjoWorkspace.WSP_GATE_SPACE_TAG. */
interface WspGateSpace {
  space: "display";
  x: TransformSpec;
  y: TransformSpec;
  /** A grid polygon's vertices as FlowJo saved them (PolyRectGate.flowjo_vertices). */
  raw?: Vertex[];
}

/**
 * Read the space the .wsp converter recorded on this gate, if any.
 *
 * Keyed by axis position rather than channel name, because the names in the document still have
 * to be resolved to session channels and x/y are what survive that resolution unchanged.
 */
/**
 * A gate colour a converter recorded, as "#rrggbb". Gating-ML has no colour, and FlowJo's own
 * export carries none, but a FACSChorus experiment records the colour every gate was drawn in,
 * and a strategy that comes back in its own colours is recognisable at a glance.
 */
export const GATE_COLOR_TAG = "gatelab_gate_color";

function parseGateColor(node: Element): string | undefined {
  for (const info of descendants(node)) {
    if (info.localName !== GATE_COLOR_TAG) continue;
    const v = (info.textContent ?? "").trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined;
  }
  return undefined;
}

/** True when the FlowJo converter marked this gate's POPULATION as its complement (a NotNode). */
function parseWspComplement(node: Element): boolean {
  for (const info of descendants(node)) {
    if (info.localName === WSP_COMPLEMENT_TAG) return (info.textContent ?? "").trim() === "true";
  }
  return false;
}

/**
 * The edge rule a converter recorded on this rectangle (WSP_RECT_BOUNDS_TAG): "closed" on a
 * FlowJo, FACSDiva or FACSChorus rectangle, or the rule GateLab recorded for its own rectangle
 * written to a FlowJo workspace. A mark always wins over the rule of the file's writer.
 */
function parseWspRectBounds(node: Element): RectangleBounds | undefined {
  for (const info of descendants(node)) {
    if (info.localName !== WSP_RECT_BOUNDS_TAG) continue;
    const v = (info.textContent ?? "").trim();
    return isRectangleBounds(v) ? v : undefined;
  }
  return undefined;
}

/** Each dimension's bounds as the file states them, for checking GateLab's own record against. */
function parseWrittenBounds(node: Element): string[] {
  return childrenLocal(node, "dimension").map((d) => writtenBound(attrLocal(d, "min"), attrLocal(d, "max")));
}

// Who wrote a document, and the edge rule that follows from it: one identification for the edge
// rule and the gain convention alike (gatingmlWriter.ts).
export { gatingMLWriter, writerRectangleBounds, type GatingMLWriter } from "./gatingmlWriter";

/** GateLab's own record of each rectangle in a file it wrote, by gating:id (rectangleRecord.ts). */
function parseRectangleRecords(root: Element): Map<string, RectangleRecord> {
  const out = new Map<string, RectangleRecord>();
  const ci = firstChildLocal(root, "custom_info");
  const holder = ci ? firstChildLocal(ci, GATINGML_RECTANGLES_TAG) : null;
  const def = holder ? firstChildLocal(holder, "definition") : null;
  if (!def) return out;
  try {
    const parsed = JSON.parse(def.textContent ?? "") as { rectangles?: Record<string, unknown> };
    for (const [id, value] of Object.entries(parsed.rectangles ?? {})) {
      const rec = parseRectangleRecord(value);
      if (rec) out.set(id, rec);
    }
  } catch {
    // A malformed record is ignored: every rectangle then reads as GateLab's older files do.
  }
  return out;
}

/**
 * The rule GateLab stated for the file's rectangles without a record (GATINGML_EDGE_RULE_TAG), if
 * it did: every file it writes from 2026-09 on does, and no file 0.8.3 or earlier wrote.
 */
function parseEdgeRuleMark(root: Element): RectangleBounds | undefined {
  const ci = firstChildLocal(root, "custom_info");
  const v = ci ? (firstChildLocal(ci, GATINGML_EDGE_RULE_TAG)?.textContent ?? "").trim() : "";
  return isRectangleBounds(v) ? v : undefined;
}

/** Each document's writer, its rule and GateLab's records, read once however many rectangles it holds. */
const rectangleRulesOf = new WeakMap<Element, {
  writer: GatingMLWriter; rule: RectangleBounds; records: Map<string, RectangleRecord>;
}>();

/**
 * Whether flowCore, which wrote a flowUtils file's gates and evaluates them, selects nothing with
 * this rectangle: its %in% for a rectangleGate returns FALSE for every event on a dimension whose
 * min equals its max, and holds [min, max] otherwise, by cut(include.lowest = TRUE, right = FALSE)
 * (flowCore 2.16 R/in-methods.R). cytolib, which CytoML evaluates with, keeps the events at that
 * value instead (measured 2026-09-25 on a zero-width rectangle: cytolib 106 events, flowCore 0).
 */
function flowCoreHoldsNothing(written: readonly string[] | undefined): boolean {
  return (written ?? []).some((dim) => {
    const [min, max] = dim.split("|");
    return min !== "" && max !== "" && Number(min) === Number(max);
  });
}

/**
 * The rule a rectangle was written under (models.ts, RectangleBounds): a converter's mark, else
 * GateLab's own record of it, else the rule GateLab stated for the file, else the rule of
 * whoever wrote the file.
 */
function setRectangleRule(gate: PolyRectGate, g: RawGate, root: Element): void {
  let rules = rectangleRulesOf.get(root);
  if (!rules) {
    const writer = gatingMLWriter(root);
    rules = {
      writer,
      rule: parseEdgeRuleMark(root) ?? writerRectangleBounds(writer),
      records: parseRectangleRecords(root),
    };
    rectangleRulesOf.set(root, rules);
  }
  const rec = rules.records.get(g.gml_id);
  if (g.rect_bounds) gate.bounds = g.rect_bounds;
  else if (rec) applyRectangleRecord(gate, rec, g.rect_written);
  // flowCore's empty zero-width rectangle is held as the half-open one, which holds nothing.
  else if (rules.writer === "flowutils" && flowCoreHoldsNothing(g.rect_written)) gate.bounds = "half-open";
  else gate.bounds = rules.rule;
}

/** The curly-quadrant mark on a rectangle, if any: the bend to give the arms, or null for straight. */
function parseWspCurly(node: Element): { curl: QuadrantCurl | null } | undefined {
  for (const info of descendants(node)) {
    if (info.localName !== WSP_CURLY_TAG) continue;
    try {
      const v = JSON.parse(info.textContent ?? "") as { curl?: unknown };
      return { curl: validCurl(v?.curl) ? v.curl : null };
    } catch {
      return { curl: null }; // a malformed mark still makes it a quadrant gate, just a straight one
    }
  }
  return undefined;
}

function parseWspGateSpace(node: Element): WspGateSpace | null {
  for (const info of descendants(node)) {
    if (info.localName !== WSP_GATE_SPACE_TAG) continue;
    try {
      const v = JSON.parse(info.textContent ?? "") as Record<string, unknown>;
      if (!v || v.space !== "display") return null;
      // Each transform held to the checks every file reader applies, so a malformed one (or a
      // grid whose axis cannot be built) imports raw rather than evaluating as a default.
      const x = parseTransformSpec(v.x);
      const y = parseTransformSpec(v.y);
      if (!x || !y) return null;
      const raw = Array.isArray(v.raw) && v.raw.every((p) => Array.isArray(p) && p.length === 2
        && p.every((n) => typeof n === "number" && Number.isFinite(n)))
        ? (v.raw as number[][]).map(([a, b]) => [a, b] as Vertex)
        : undefined;
      return { space: "display", x, y, ...(raw ? { raw } : {}) };
    } catch {
      return null; // a malformed marker is ignored; the gate imports raw, as it would have before
    }
  }
  return null;
}

/** A bound pair read from a file: finite numbers or null, anything else refused. */
function boundPair(v: unknown): [number | null, number | null] | null {
  const ok = (n: unknown): n is number | null => n === null || (typeof n === "number" && Number.isFinite(n));
  return Array.isArray(v) && v.length === 2 && ok(v[0]) && ok(v[1]) ? [v[0], v[1]] : null;
}

/**
 * A rule-imported FlowJo rectangle's saved axes (WSP_FLOWJO_AXES_TAG), x then y, null where none,
 * and the bounds FlowJo saved where the rule opened one, per dimension.
 */
function parseWspFlowJoAxes(node: Element): FlowJoRectangleAxes | undefined {
  for (const info of descendants(node)) {
    if (info.localName !== WSP_FLOWJO_AXES_TAG) continue;
    try {
      const v = JSON.parse(info.textContent ?? "") as Record<string, unknown>;
      const opened = Array.isArray(v?.opened) ? v.opened.map(boundPair) : null;
      return {
        x: parseFlowJoGridAxis(v?.x), y: parseFlowJoGridAxis(v?.y),
        ...(opened && opened.length >= 1 && opened.length <= 2 && opened.every((p) => p !== null)
          ? { opened: opened as [number | null, number | null][] }
          : {}),
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

interface FlowJoRectangleAxes {
  x: FlowJoGridAxis | null;
  y: FlowJoGridAxis | null;
  /** FlowJo's own bounds where the rule opened one, per dimension (PolyRectGate.flowjo_bounds). */
  opened?: [number | null, number | null][];
}

/**
 * PolyRectGate.flowjo_bounds from a rectangle's opened bounds, by channel: a one-dimensional range
 * states its one dimension for both axes, which are the same channel.
 */
function flowJoBoundsField(
  opened: readonly [number | null, number | null][] | undefined, xCh: string, yCh: string,
): { flowjo_bounds?: Record<string, [number | null, number | null]> } {
  if (!opened?.length) return {};
  const out: Record<string, [number | null, number | null]> = {};
  const put = (ch: string, pair: [number | null, number | null] | undefined) => {
    if (pair && (pair[0] !== null || pair[1] !== null)) out[ch] = [pair[0], pair[1]];
  };
  put(xCh, opened[0]);
  if (opened.length > 1) put(yCh, opened[1]);
  return Object.keys(out).length ? { flowjo_bounds: out } : {};
}

/** A FlowJo polygon's own attributes, as PolyRectGate.flowjo_polygon holds them. */
type FlowJoPolygonAttributes = { quadId: number; gateResolution: number | null };

/** A continuous FlowJo polygon's own attributes (WSP_FLOWJO_POLYGON_TAG), when valid. */
function parseWspFlowJoPolygon(node: Element): FlowJoPolygonAttributes | undefined {
  for (const info of descendants(node)) {
    if (info.localName !== WSP_FLOWJO_POLYGON_TAG) continue;
    try {
      const v = JSON.parse(info.textContent ?? "") as Record<string, unknown>;
      const quadId = v?.quadId;
      const res = v?.gateResolution;
      if (typeof quadId === "number" && Number.isInteger(quadId) && (res === null || (typeof res === "number" && Number.isInteger(res)))) {
        return { quadId, gateResolution: res as number | null };
      }
    } catch {
      // a malformed record is ignored; the polygon exports as an ordinary one
    }
    return undefined;
  }
  return undefined;
}

/**
 * GateLab's mark on a FlowJo grid polygon it exported (flowjoGrid.ts, GATINGML_GRID_TAG), when it
 * still describes the ring the file holds; null otherwise, and the ring is read as written.
 */
function parseGridMark(node: Element, written: readonly Vertex[]): FlowJoGridMark | null {
  for (const info of descendants(node)) {
    if (info.localName !== GATINGML_GRID_TAG) continue;
    const mark = parseFlowJoGridMark(info.textContent ?? "");
    return mark && mark.written === fingerprintRing(written) ? mark : null;
  }
  return null;
}

interface RawGate {
  wsp_complement?: boolean;
  /** A colour a converter recorded (GATE_COLOR_TAG); the palette is used when absent. */
  color?: string;
  /** Present on the rectangle that stands for a whole curly quadrant gate (WSP_CURLY_TAG). */
  wsp_curly?: { curl: QuadrantCurl | null };
  /** The edge rule a converter recorded on this rectangle (WSP_RECT_BOUNDS_TAG), if any. */
  rect_bounds?: RectangleBounds;
  /** Each dimension's bounds as the file states them (rectangleRecord.ts, `written`). */
  rect_written?: string[];
  gml_id: string;
  name: string;
  gate_type: "rectangle" | "polygon" | "ellipse" | "boolean";
  x_channel?: string;
  y_channel?: string;
  vertices?: Vertex[];
  /** EllipsoidGate payload, in the space its dimensions declare. */
  ellipse?: { mean: [number, number]; covariance: [[number, number], [number, number]]; distance_square: number };
  channels: string[];
  dims?: GmlDim[];
  operation?: "and" | "or" | "not";
  refs?: { gate_id: string; complement: boolean }[];
  pop_parent_indices?: number[];
  gate_set_id?: number;
  explicit_root?: boolean;
  /** A BooleanGate the standard format writes only as an operand (GATELAB_OPERAND_TAG). */
  operand_helper?: boolean;
  parent_id?: string;
  wsp_space?: WspGateSpace | null;
  /**
   * Why this geometric gate cannot be imported as the file declares it, when it cannot: it is
   * left out, by name, with every population that needs it (PopulationSkips).
   */
  lost_reason?: string;
  /**
   * Cytobank's compensation_id for a geometric gate: -2 uncompensated, 0 the FCS file's own
   * matrix, a positive id a named compensation, which the file carries as a spectrumMatrix with
   * that cytobank_compensation_id. See adoptCytobankCompensationIds.
   */
  compensation_id?: number;
  /** GateLab's own mark on a FlowJo grid polygon it exported, still matching the written ring. */
  grid_mark?: FlowJoGridMark | null;
  /** A rule-imported FlowJo rectangle's saved axes (PolyRectGate.flowjo_axes and flowjo_bounds). */
  flowjo_axes?: FlowJoRectangleAxes;
  /** A continuous FlowJo polygon's own quadId and gateResolution (PolyRectGate.flowjo_polygon). */
  flowjo_polygon?: FlowJoPolygonAttributes;
}

function parseGateNode(node: Element): RawGate | null {
  const loc = node.localName;
  const gmlId = attrLocal(node, "id");
  let nm = attrLocal(node, "name");
  if (!nm) nm = parseCytobankName(node);
  if (!nm) nm = gmlId ?? uuid();

  if (loc === "RectangleGate") {
    const dims = parseDimensions(node);
    if (dims.length < 1 || dims.length > 2) return null;
    // Gating-ML range gates are encoded as a one-dimensional RectangleGate.
    // The app's rectangle mask is two-dimensional, so repeating the same
    // channel on both axes preserves the exact interval membership semantics.
    // An absent bound is no bound: ±UNBOUNDED, which holds every value on that side, in any space.
    const x = dims[0];
    const y = dims[1] ?? dims[0];
    const xlo = x.min ?? -UNBOUNDED;
    const xhi = x.max ?? UNBOUNDED;
    const ylo = y.min ?? -UNBOUNDED;
    const yhi = y.max ?? UNBOUNDED;
    return {
      gml_id: gmlId ?? uuid(),
      name: nm,
      gate_type: "rectangle",
      x_channel: x.channel,
      y_channel: y.channel,
      vertices: [
        [xlo, ylo],
        [xhi, ylo],
        [xhi, yhi],
        [xlo, yhi],
      ],
      channels: [x.channel, y.channel],
      dims: [x, y],
      wsp_space: parseWspGateSpace(node),
      wsp_complement: parseWspComplement(node),
      color: parseGateColor(node),
      wsp_curly: parseWspCurly(node),
      flowjo_axes: parseWspFlowJoAxes(node),
      rect_bounds: parseWspRectBounds(node),
      rect_written: parseWrittenBounds(node),
    };
  }

  if (loc === "PolygonGate") {
    const dims = parseDimensions(node);
    if (dims.length < 2) return null;
    const verts: Vertex[] = [];
    for (const v of childrenLocal(node, "vertex")) {
      const coords = childrenLocal(v, "coordinate");
      if (coords.length < 2) continue;
      const xv = num(attrLocal(coords[0], "value"));
      const yv = num(attrLocal(coords[1], "value"));
      if (hasNum(xv) && hasNum(yv)) verts.push([xv, yv]);
    }
    if (verts.length < 3) return null;
    return {
      gml_id: gmlId ?? uuid(),
      name: nm,
      gate_type: "polygon",
      x_channel: dims[0].channel,
      y_channel: dims[1].channel,
      vertices: verts,
      channels: [dims[0].channel, dims[1].channel],
      dims,
      wsp_space: parseWspGateSpace(node),
      grid_mark: parseGridMark(node, verts),
      flowjo_polygon: parseWspFlowJoPolygon(node),
      // Read for every gate kind: a NotNode's copy can be a polygon or an ellipse as easily as
      // a rectangle, and reading the mark on rectangles alone imported the other two as the
      // gate itself -- exactly the events the user had excluded.
      wsp_complement: parseWspComplement(node),
      color: parseGateColor(node),
    };
  }

  if (loc === "EllipsoidGate") {
    // Gating-ML 2.0 §5.5: mean, symmetric covarianceMatrix (rows of entries), distanceSquare.
    // Cytobank writes these natively; the parameters live in whatever space the dimensions'
    // transformation-refs declare, exactly like polygon vertices.
    const dims = parseDimensions(node);
    if (dims.length !== 2) return null;
    const meanEl = firstChildLocal(node, "mean");
    const covEl = firstChildLocal(node, "covarianceMatrix");
    // distanceSquare is an ELEMENT carrying data-type:value (Cytobank writes exactly that);
    // the attribute form is accepted too.
    const d2El = firstChildLocal(node, "distanceSquare");
    const d2 = num(attrLocal(node, "distanceSquare") ?? (d2El ? attrLocal(d2El, "value") : null));
    if (!meanEl || !covEl) return null;
    const meanCoords = childrenLocal(meanEl, "coordinate");
    if (meanCoords.length < 2) return null;
    const mx = num(attrLocal(meanCoords[0], "value"));
    const my = num(attrLocal(meanCoords[1], "value"));
    const rows = childrenLocal(covEl, "row").map((r) =>
      childrenLocal(r, "entry").map((e) => num(attrLocal(e, "value"))));
    if (!hasNum(mx) || !hasNum(my) || rows.length !== 2 || rows.some((r) => r.length !== 2 || r.some((v) => !hasNum(v)))) {
      return null;
    }
    const dsq = hasNum(d2) ? d2 : 1; // Gating-ML default when distanceSquare is omitted
    return {
      gml_id: gmlId ?? uuid(),
      name: nm,
      gate_type: "ellipse",
      x_channel: dims[0].channel,
      y_channel: dims[1].channel,
      ellipse: {
        mean: [mx, my],
        covariance: [[rows[0][0] as number, rows[0][1] as number], [rows[1][0] as number, rows[1][1] as number]],
        distance_square: dsq,
      },
      channels: [dims[0].channel, dims[1].channel],
      dims,
      wsp_space: parseWspGateSpace(node),
      wsp_complement: parseWspComplement(node),
      color: parseGateColor(node),
    };
  }

  if (loc === "BooleanGate") {
    let op: "and" | "or" | "not" | null = null;
    let opEl: Element | null = null;
    for (const kid of Array.from(node.children)) {
      if (kid.localName === "and" || kid.localName === "or" || kid.localName === "not") {
        op = kid.localName;
        opEl = kid;
        break;
      }
    }
    if (!op || !opEl) return null;
    const refs: { gate_id: string; complement: boolean }[] = [];
    for (const r of childrenLocal(opEl, "gateReference")) {
      const rid = attrLocal(r, "ref");
      if (!rid) continue; // refused before any gate is built (see importGatingML)
      refs.push({ gate_id: rid, complement: complementOf(r).value });
    }
    return {
      gml_id: gmlId ?? uuid(),
      name: nm,
      gate_type: "boolean",
      operation: op,
      refs,
      channels: [],
      pop_parent_indices: parsePopParentIndices(node),
      gate_set_id: parseCytobankIds(node).gate_set_id,
      explicit_root: parseExplicitRoot(node),
      operand_helper: (() => {
        const ci = firstChildLocal(node, "custom_info");
        return !!ci && firstChildLocal(ci, GATELAB_OPERAND_TAG) !== null;
      })(),
    };
  }

  return null;
}

/** An xs:boolean: "true", "false", "1" or "0", surrounded by any whitespace; undefined if none. */
function xsBoolean(text: string): boolean | undefined {
  const t = text.trim();
  if (t === "true" || t === "1") return true;
  if (t === "false" || t === "0") return false;
  return undefined;
}

/**
 * Whether a gateReference or PopulationGatePair is used as its complement, and why it cannot be
 * read when it cannot. Gating-ML 2.0 spells the attribute use-as-complement; GateLab wrote
 * `complement` until 2026-09, and those files still have to read as they were written. Both are
 * xs:boolean, so "1" and " true" are true; a value that is not one, or the two attributes saying
 * different things, is refused rather than taken as "false", which would import the gate's
 * events as the population's where the file says the events outside it.
 */
function complementOf(el: Element): { value: boolean; problem: string | null } {
  const standard = attrLocal(el, "use-as-complement");
  const legacy = attrLocal(el, "complement");
  const a = standard === null ? undefined : xsBoolean(standard);
  const b = legacy === null ? undefined : xsBoolean(legacy);
  if (standard !== null && a === undefined) {
    return { value: false, problem: `use-as-complement="${standard}" is not true or false` };
  }
  if (legacy !== null && b === undefined) {
    return { value: false, problem: `complement="${legacy}" is not true or false` };
  }
  if (a !== undefined && b !== undefined && a !== b) {
    return { value: false, problem: `use-as-complement="${standard}" and complement="${legacy}" disagree` };
  }
  return { value: a ?? b ?? false, problem: null };
}

function gateLabel(node: Element): string {
  const id = attrLocal(node, "id");
  const name = attrLocal(node, "name") ?? parseCytobankName(node);
  const suffix = name && name !== id ? ` (${name})` : "";
  return `${node.localName}${id ? ` ${id}` : ""}${suffix}`;
}

function throwImportProblems(problems: string[]): never {
  const unique = [...new Set(problems)];
  throw new Error(
    "Gating-ML import cancelled because unsupported or invalid features were found:\n" +
      unique.map((problem) => `- ${problem}`).join("\n") +
      "\nNo gates or populations were imported; the current workspace was not changed.",
  );
}

function missingChannelProblems(
  rawGates: Record<string, RawGate>,
  sessionChannels: string[],
  pnnToChannel: Record<string, string>,
  instrument: "flow" | "cytof",
): string[] {
  const problems: string[] = [];
  for (const gate of Object.values(rawGates)) {
    if (gate.gate_type === "boolean") continue;
    const missing = [...new Set(gate.channels)].filter(
      (channel) => resolveChannel(channel, sessionChannels, pnnToChannel, instrument) == null,
    );
    if (missing.length) {
      problems.push(
        `Gate ${JSON.stringify(gate.name)} (${gate.gml_id}) references channel(s) not present in the loaded data: ` +
          missing.map((channel) => JSON.stringify(channel)).join(", ") + ".",
      );
    }
  }
  if (problems.length) {
    problems.push(
      "Partial Gating-ML imports are not allowed because dropping a gate can change population membership.",
    );
  }
  return problems;
}


// ---------------------------------------------------------------------------
// Main import
// ---------------------------------------------------------------------------

export interface GatingMLResult {
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string;
  n_gates_imported: number;
  n_gates_skipped: number;
  skipped_channels: string[];
  /**
   * The gates restated from Gating-ML scale values by $PnG (GatingMLImportOptions.gains), by name,
   * and those that could not be (an axis whose transform has no gain restatement, left as they
   * are). Absent when nothing was asked or the document is on stored values.
   */
  gain?: { converted: string[]; unconverted: string[] };
  /**
   * Populations left out of an otherwise complete import, each named with the reason, as the
   * FlowJo workspace import names its own. A population is left out, with everything beneath it,
   * when one of its gates could not be imported: importing it without that gate would give it
   * more events than it has, and at worst all of its parent's.
   */
  warnings: string[];
  source: "gatelabr" | "cytobank" | "generic";
  n_pops_imported: number;
  scales: Record<string, GatingMLScaleEntry> | null;
  cytof_cofactor: number | null;
  compensation: GatingMLCompensationState | null;
  /**
   * What the gates' dimensions compensate with; "matrix" is spectrum_matrix. "FCS" declared only
   * on channels the matrix leaves alone, beside uncompensated gates on channels it covers, is
   * given as "uncompensated": compensation changes nothing it asks for, and off holds every gate.
   */
  compensation_refs: GatingMLDimensionCompensation[];
  /**
   * The spillover matrix the file defines and its compensated dimensions reference (a Gating-ML
   * 2.0 spectrumMatrix), in FCS $SPILLOVER orientation over the detectors' $PnN; null when every
   * dimension says "FCS" or "uncompensated". The gates are evaluated only once this matrix is
   * installed on the sample (Sample.installExternalSpillover), as a FlowJo workspace's is.
   */
  spectrum_matrix: GatingMLSpectrumMatrix | null;
  /**
   * A Cytobank compensation, by its compensation_id, that gates were drawn under and the file does
   * not carry, with those gates' names; null when there is none. Their compensated dimensions are
   * "missing", never "FCS": the matrix has to come from the user, or the user has to choose the
   * FCS file's own knowing that it is not the one the gates were drawn under.
   */
  missing_compensation: { id: number; gates: string[] } | null;
}

export interface GatingMLSpectrumMatrix {
  id: string;
  /** The name the file gives it (custom_info), or its id. */
  name: string;
  /** The detectors ($PnN), which are also the compensated channels. */
  channels: string[];
  matrix: number[][];
}

export interface GatingMLScaleEntry {
  w?: number;
  cofactor?: number;
  lo?: number;
  hi?: number;
  /** Axis endpoints in compensated linear measurement space (portable across display implementations). */
  raw_lo?: number;
  raw_hi?: number;
}

export type GatingMLCompensationRef = "FCS" | "uncompensated";
/**
 * A dimension's compensation: the FCS file's matrix, none, the matrix the file defines, or a
 * matrix a Cytobank gate names that the file does not carry (GatingMLResult.missing_compensation).
 */
export type GatingMLDimensionCompensation = GatingMLCompensationRef | "matrix" | "missing";

export interface GatingMLCompensationState {
  enabled: boolean;
  reference: GatingMLCompensationRef;
  channels: string[];
  matrix?: number[][];
}

export interface GatingMLCompensationResolution {
  target: boolean | null;
  source: "embedded" | "dimensions" | "none";
  requiresConfirmation: boolean;
  /** Something the import dialog should say about the resolution, when there is. */
  note?: string;
}

/** What importGatingML needs to know about the sample beyond its channels. */
export interface GatingMLImportOptions {
  /**
   * The sample's $TIMESTEP (fcsTimestep), which a Time coordinate in seconds is divided by; see
   * timeUnitOf. Absent or null: none, so seconds and ticks are the same.
   */
  timestep?: number | null;
  /**
   * The session keys of the channels whose values the matrix that would compensate the gates
   * changes: the FCS file's own matrix, or a FlowJo workspace's when the import installs that one
   * instead (gatingMLImportOptionsFor, channelsCompensationChanges). A channel the matrix lists but
   * leaves as stored is not one of them. An empty list when no matrix would be applied. Absent: not
   * known, and every channel that is not scatter or QC is taken as compensated.
   *
   * GateLab evaluates a sample on one compensation. A gate whose dimension on one of these
   * channels declares "uncompensated", in a file whose other gates are compensated, would be
   * evaluated on compensated values it was not drawn on: it is left out, by name, instead.
   */
  compensatedChannels?: readonly string[] | null;
  /**
   * The session keys of every channel the matrix that would compensate the gates covers (the same
   * matrix as compensatedChannels', whether or not compensation changes a channel's values); an
   * empty list when no matrix would be applied. Absent: not known. A FlowJo converter's document
   * (COMPENSATED_FCS_MARK) whose "FCS" dimension is on a channel outside it is refused: FlowJo drew
   * the gate on compensated values, and nothing here can compute them.
   */
  matrixChannels?: readonly string[] | null;
  /**
   * The sample's $PnG by channel key (gatingmlGain.ts, gatingMlGains), for a document whose
   * coordinates are Gating-ML scale values, stored value / gain (gainConventionOf: GateLab's mark,
   * else its writer). Each gate is restated on the stored values GateLab gates as it is built, before
   * GateLab's own record of a rectangle is checked against it, so the record restores a rectangle on
   * a channel with a gain exactly, as on any other. Until 2026-09-25 the app restated the gates after
   * the import, and the record, checked against scale values, was refused on every such channel.
   * Absent, or a document on stored values: nothing is restated.
   */
  gains?: ReadonlyMap<string, number> | null;
}

interface GatelabrState {
  scales: GatingMLResult["scales"];
  cytofCofactor: number | null;
  compensation: GatingMLCompensationState | null;
}

function isNumericMatrix(value: unknown, size: number): value is number[][] {
  return Array.isArray(value) && value.length === size && value.every(
    (row) => Array.isArray(row) && row.length === size && row.every(
      (entry) => typeof entry === "number" && Number.isFinite(entry),
    ),
  );
}

function parseScaleChannels(value: unknown): Record<string, GatingMLScaleEntry> | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length === 0) return null; // legacy GateLabR encoded empty lists as []
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Channel scale settings are malformed.");
  }
  const out: Record<string, GatingMLScaleEntry> = {};
  const numericKeys: (keyof GatingMLScaleEntry)[] = ["w", "cofactor", "lo", "hi", "raw_lo", "raw_hi"];
  for (const [channel, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    if (!channel || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      throw new Error("A channel scale entry is malformed.");
    }
    const record = rawEntry as Record<string, unknown>;
    const entry: GatingMLScaleEntry = {};
    for (const key of numericKeys) {
      if (record[key] === undefined) continue;
      if (typeof record[key] !== "number" || !Number.isFinite(record[key])) {
        throw new Error(`Scale ${key} for ${channel} is not finite.`);
      }
      entry[key] = record[key] as number;
    }
    if (entry.cofactor !== undefined && entry.cofactor <= 0) {
      throw new Error(`Scale cofactor for ${channel} must be positive.`);
    }
    if ((entry.raw_lo === undefined) !== (entry.raw_hi === undefined) ||
        (entry.raw_lo !== undefined && entry.raw_hi! <= entry.raw_lo)) {
      throw new Error(`Raw scale range for ${channel} is malformed.`);
    }
    out[channel] = entry;
  }
  return out;
}

function parseGatelabrState(root: Element): GatelabrState {
  const ci = firstChildLocal(root, "custom_info");
  const gs = ci ? firstChildLocal(ci, "gatelabr_scales") : null;
  const def = gs ? firstChildLocal(gs, "definition") : null;
  const txt = def?.textContent?.trim();
  if (!txt) return { scales: null, cytofCofactor: null, compensation: null };
  try {
    const parsed: unknown = JSON.parse(txt);
    if (!parsed || typeof parsed !== "object") {
      return { scales: null, cytofCofactor: null, compensation: null };
    }
    const record = parsed as Record<string, unknown>;
    const scales = parseScaleChannels(record.channels);
    let cytofCofactor: number | null = null;
    if (record.cytof_cofactor !== undefined) {
      if (typeof record.cytof_cofactor !== "number" || !Number.isFinite(record.cytof_cofactor) ||
          record.cytof_cofactor <= 0) {
        throw new Error("CyTOF cofactor must be positive.");
      }
      cytofCofactor = record.cytof_cofactor;
    }
    if (record.compensation === undefined) return { scales, cytofCofactor, compensation: null };

    const raw = record.compensation;
    if (!raw || typeof raw !== "object") {
      throw new Error("Invalid embedded GateLab compensation state.");
    }
    const comp = raw as Record<string, unknown>;
    if (typeof comp.enabled !== "boolean") {
      throw new Error("Invalid embedded GateLab compensation state: enabled must be true or false.");
    }
    // COMPENSATION_REFERENCE is what files have written since version 4, precisely so that a
    // reader older than it refuses them; it records the same state as "FCS" (compensated with
    // `matrix`, which need not be the FCS file's own) or "uncompensated".
    const current = comp.reference === COMPENSATION_REFERENCE;
    if (comp.reference !== "FCS" && comp.reference !== "uncompensated" && !current) {
      throw new Error("Invalid embedded GateLab compensation state: unsupported matrix reference.");
    }
    const reference: GatingMLCompensationRef = current
      ? (comp.enabled ? "FCS" : "uncompensated")
      : comp.reference as GatingMLCompensationRef;
    if (!Array.isArray(comp.channels) || !comp.channels.every((ch) => typeof ch === "string")) {
      throw new Error("Invalid embedded GateLab compensation state: channel list is malformed.");
    }
    const channels = [...comp.channels] as string[];
    if (new Set(channels).size !== channels.length) {
      throw new Error("Invalid embedded GateLab compensation state: channel names are duplicated.");
    }
    let matrix: number[][] | undefined;
    if (comp.matrix !== undefined) {
      if (!isNumericMatrix(comp.matrix, channels.length)) {
        throw new Error("Invalid embedded GateLab compensation state: spillover matrix is malformed.");
      }
      matrix = comp.matrix.map((row) => [...row]);
    }
    if (comp.enabled && (reference !== "FCS" || channels.length < 2 || !matrix)) {
      throw new Error("Invalid embedded GateLab compensation state: enabled compensation requires an FCS spillover matrix.");
    }
    return {
      scales,
      cytofCofactor,
      compensation: { enabled: comp.enabled, reference, channels, ...(matrix ? { matrix } : {}) },
    };
  } catch {
    throw new Error("Invalid embedded GateLab scale or compensation metadata.");
  }
}

/** Restore portable transform/display state after Gating-ML compensation has been resolved. */
export function restoreGatingMLScaleState(
  sample: Sample,
  scales: Record<string, GatingMLScaleEntry> | null,
  cytofCofactor: number | null,
): { ranges: Record<string, [number, number]>; transformsChanged: boolean } {
  let transformsChanged = false;
  if (sample.instrument === "cytof" && cytofCofactor !== null &&
      sample.arcsinhCofactor !== cytofCofactor) {
    sample.setCytofCofactor(cytofCofactor);
    transformsChanged = true;
  }

  for (const [key, state] of Object.entries(scales ?? {})) {
    const idx = sample.index(key);
    if (idx === undefined) continue;
    if (sample.instrument === "flow" && !isQcChannel(key) && !isScatterChannel(key) &&
        state.w !== undefined && sample.currentLogicleW(idx) !== state.w) {
      sample.setLogicleW(idx, state.w);
      transformsChanged = true;
    }
    // A fluorescence entry carrying a cofactor and no W was written for an ARCSINH axis --
    // buildScalesJson writes w for logicle and cofactor for asinh, never both -- so this is
    // how the channel's scale choice comes back. Older files wrote neither and are unaffected.
    if (sample.instrument === "flow" && sample.isFluorChannel(idx) &&
        state.cofactor !== undefined && state.w === undefined) {
      if (sample.fluorScale(idx) !== "arcsinh") {
        sample.setFluorScale(idx, "arcsinh");
        transformsChanged = true;
      }
      if (sample.currentFluorCofactor(idx) !== state.cofactor) {
        sample.setFluorCofactor(idx, state.cofactor);
        transformsChanged = true;
      }
    }
    // A scatter entry carries a cofactor only when the axis was shown with arcsinh (buildScalesJson
    // writes one for any arcsinh flow axis), so the cofactor is both the choice and its parameter;
    // an entry without one is a linear axis, which scatter opens on. Files written before linear
    // was the default carried a cofactor on every scatter entry, and open as they were drawn.
    if (sample.instrument === "flow" && sample.isScatterAxis(idx)) {
      const cofactor = state.w === undefined ? state.cofactor : undefined;
      if ((sample.scatterScale(idx) === "arcsinh") !== (cofactor !== undefined)) {
        sample.setScatterScale(idx, cofactor !== undefined ? "arcsinh" : "linear");
        transformsChanged = true;
      }
      if (cofactor !== undefined && sample.currentScatterCofactor(idx) !== cofactor) {
        sample.setScatterCofactor(idx, cofactor);
        transformsChanged = true;
      }
    }
    // An imaging geometry feature is linear by default and writes a cofactor only when shown
    // with arcsinh, so a cofactor is both the choice and its parameter.
    if (sample.instrument === "flow" && sample.isImagingFeatureAxis(idx) &&
        state.cofactor !== undefined && state.w === undefined) {
      if (sample.featureScale(idx) !== "arcsinh") {
        sample.setFeatureScale(idx, "arcsinh");
        transformsChanged = true;
      }
      if (sample.currentScatterCofactor(idx) !== state.cofactor) {
        sample.setScatterCofactor(idx, state.cofactor);
        transformsChanged = true;
      }
    }
  }

  const ranges: Record<string, [number, number]> = {};
  for (const [key, state] of Object.entries(scales ?? {})) {
    if (sample.index(key) === undefined || state.raw_lo === undefined || state.raw_hi === undefined) continue;
    const lo = sample.rawToDisplay(key, state.raw_lo);
    const hi = sample.rawToDisplay(key, state.raw_hi);
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) ranges[key] = [lo, hi];
  }
  return { ranges, transformsChanged };
}

interface ParsedSpectrum extends GatingMLSpectrumMatrix {
  fluorochromes: string[];
  /** Its cytobank_compensation_id, the id Cytobank's gates name it by (compensation_id). */
  cytobankId: number | null;
  /** Why GateLab cannot apply it, if it cannot; raised only when a dimension references it. */
  problem: string | null;
}

/**
 * Every Gating-ML 2.0 spectrumMatrix at the top level of the file (specification §7), by id.
 *
 * A matrix is n fluorochromes (rows) by m detectors (columns). GateLab compensates with a square
 * spillover matrix whose i-th fluorochrome is the i-th detector compensated, which is how FlowKit
 * reads one too, so an unmixing matrix (n < m) is recorded as a problem, and so is one the file
 * says is already inverted when it cannot be inverted back. A problem stops the import only when
 * a dimension references that matrix: Cytobank-format files carry one no dimension references.
 */
function parseSpectrumMatrices(root: Element): Record<string, ParsedSpectrum> {
  const out: Record<string, ParsedSpectrum> = {};
  for (const el of Array.from(root.children)) {
    if (el.localName !== "spectrumMatrix") continue;
    const id = attrLocal(el, "id");
    if (!id) continue;
    const names = (group: string) => {
      const g = firstChildLocal(el, group);
      return g ? childrenLocal(g, "fcs-dimension").map((d) => attrLocal(d, "name") ?? "") : [];
    };
    const fluorochromes = names("fluorochromes");
    const detectors = names("detectors");
    let matrix = childrenLocal(el, "spectrum").map((row) =>
      // Read as xs:double: Number() took "" for 0 and "0x1" for 1.
      childrenLocal(row, "coefficient").map((c) => xsNum(attrLocal(c, "value"))));
    const cb = cytobankNode(el);
    const label = (cb ? firstChildLocal(cb, "cytobank_compensation_name")?.textContent : null)?.trim();
    const cytobankId = parseInt((cb ? firstChildLocal(cb, "cytobank_compensation_id")?.textContent : null)?.trim() ?? "", 10);
    let problem: string | null = null;
    if (detectors.some((d) => !d)) {
      problem = `Spillover matrix ${id} has an unnamed detector.`;
    } else if (fluorochromes.length !== detectors.length) {
      problem = `Spillover matrix ${id} unmixes ${fluorochromes.length} fluorochromes from ${detectors.length} detectors; ` +
        "GateLab compensates with a square spillover matrix only.";
    } else if (matrix.length !== detectors.length || matrix.some((r) => r.length !== detectors.length || r.some((v) => !hasNum(v)))) {
      problem = `Spillover matrix ${id} is not a complete ${detectors.length} by ${detectors.length} matrix of numbers.`;
    } else if ((attrLocal(el, "matrix-inverted-already") ?? "false").trim().toLowerCase() === "true") {
      // The file gives the compensation matrix itself; GateLab holds the spillover, its inverse.
      const spill = invertMatrix(matrix);
      if (spill) matrix = spill;
      else problem = `Spillover matrix ${id} is marked as already inverted but cannot be inverted back.`;
    }
    out[id] = {
      id, name: label || id, channels: detectors, fluorochromes, matrix, problem,
      cytobankId: Number.isFinite(cytobankId) ? cytobankId : null,
    };
  }
  return out;
}

/**
 * Take a Cytobank gate's named compensation as its dimensions' matrix.
 *
 * Cytobank writes compensation-ref="FCS" on every compensated dimension, whatever matrix the gate
 * was drawn under, and says which in the gate's custom_info compensation_id: 0 is the FCS file's
 * own matrix, and a positive id is a named compensation, which the export carries as a
 * spectrumMatrix with that cytobank_compensation_id. GateLab's Cytobank format does the same when
 * its gates were drawn under a matrix that is not the FCS file's own. Read as "FCS", such a file
 * was evaluated with the wrong matrix, and GateLab's own export of it was refused on import as a
 * matrix mismatch; read this way, it imports as the standard format does, with that matrix
 * installed. A positive id with no matching spectrumMatrix is left as the dimension says.
 */
function adoptCytobankCompensationIds(
  rawGates: Record<string, RawGate>,
  spectra: Record<string, ParsedSpectrum>,
  /** Filled with why the file cannot be imported, beside every other reason (importProblems). */
  problems: string[],
): GatingMLResult["missing_compensation"] {
  const byCytobankId = new Map<number, string>();
  for (const sp of Object.values(spectra)) if (sp.cytobankId !== null && sp.cytobankId > 0) byCytobankId.set(sp.cytobankId, sp.id);
  // A positive id with no such spectrumMatrix names a compensation the file does not carry. Its
  // compensated dimensions were left at "FCS" until 2026-09, which evaluated the gates with the FCS
  // file's own matrix and said nothing (754 to 1,990 events moved on the public Fortessa file).
  // They are marked MISSING_MATRIX_REF instead, and the gates are named (missing_compensation).
  const missing = new Map<number, string[]>();
  for (const gate of Object.values(rawGates)) {
    if (gate.gate_type === "boolean" || gate.compensation_id === undefined || gate.compensation_id <= 0) continue;
    const matrixId = byCytobankId.get(gate.compensation_id);
    let compensated = false;
    for (const dim of new Set(gate.dims ?? [])) {
      if (dim.compensation_ref?.trim().toLowerCase() !== "fcs") continue;
      compensated = true;
      dim.compensation_ref = matrixId ?? `${MISSING_MATRIX_REF}${gate.compensation_id}`;
    }
    if (compensated && !matrixId) missing.set(gate.compensation_id, [...(missing.get(gate.compensation_id) ?? []), gate.name]);
  }
  if (missing.size > 1) {
    problems.push(
      `This Gating-ML file's gates name ${missing.size} Cytobank compensations it does not carry ` +
      `(${[...missing.keys()].join(", ")}); GateLab applies one matrix per sample.`,
    );
    return null;
  }
  const [only] = [...missing.entries()];
  return only ? { id: only[0], gates: [...new Set(only[1])].sort() } : null;
}

/**
 * The compensation-ref a Cytobank gate's compensated dimension is given when its compensation_id
 * names a matrix the file does not carry, followed by that id. Read as the "missing" reference.
 */
const MISSING_MATRIX_REF = "cytobank-compensation-not-in-file:";

/**
 * Name each dimension compensated by a matrix the file defines by its detector ($PnN), the name
 * GateLab's channels answer to. Gating-ML names such a dimension by the matrix's fluorochrome
 * (§4.2.2); fluorochrome i is detector i compensated. A detector name is taken as it is, first, as
 * FlowKit takes it, so a file whose fluorochromes are unnamed or repeat the detectors still reads.
 */
function resolveSpectrumDimensions(rawGates: Record<string, RawGate>, spectra: Record<string, ParsedSpectrum>): void {
  for (const gate of Object.values(rawGates)) {
    if (gate.gate_type === "boolean" || !gate.dims?.length) continue;
    for (const dim of new Set(gate.dims)) {
      const sp = dim.compensation_ref ? spectra[dim.compensation_ref.trim()] : undefined;
      if (!sp || sp.problem || sp.channels.includes(dim.channel)) continue;
      const i = sp.fluorochromes.indexOf(dim.channel);
      if (i >= 0) dim.channel = sp.channels[i];
    }
    gate.x_channel = gate.dims[0].channel;
    gate.y_channel = (gate.dims[1] ?? gate.dims[0]).channel;
    gate.channels = [gate.x_channel, gate.y_channel];
  }
}

/**
 * What the gates compensate with, and the matrix when the file defines it. GateLab holds one
 * matrix per sample, so a file whose dimensions reference two matrices, or the FCS file's and one
 * of its own, cannot be evaluated as written and is refused. FlowKit refuses the same.
 *
 * Every reason is collected, with the file's other problems (importProblems), and the import is
 * refused naming all of them. This threw on the first until 2026-09, so the refusal of ISAC set 1
 * named its matrix alone and hid the file's quadrant, ratio and hyperlog gates.
 */
function parseCompensationRefs(
  rawGates: Record<string, RawGate>,
  spectra: Record<string, ParsedSpectrum>,
  problems: string[],
): { refs: GatingMLDimensionCompensation[]; spectrum: GatingMLSpectrumMatrix | null } {
  const refs = new Set<GatingMLDimensionCompensation>();
  const unsupported = new Set<string>();
  const used = new Set<string>();
  for (const gate of Object.values(rawGates)) {
    if (gate.gate_type === "boolean") continue;
    for (const dim of gate.dims ?? []) {
      const value = dim.compensation_ref?.trim();
      if (!value) continue;
      if (value.toLowerCase() === "fcs") refs.add("FCS");
      else if (value.toLowerCase() === "uncompensated") refs.add("uncompensated");
      else if (value.startsWith(MISSING_MATRIX_REF)) refs.add("missing");
      else if (spectra[value]) { refs.add("matrix"); used.add(value); }
      else unsupported.add(value);
    }
  }
  if (unsupported.size) {
    problems.push(
      `This Gating-ML file references unsupported compensation matrix ${[...unsupported].map((x) => `"${x}"`).join(", ")}. ` +
      "GateLab can import FCS or uncompensated dimensions, or dimensions compensated by a spillover matrix the file defines.",
    );
  }
  for (const id of used) if (spectra[id].problem) problems.push(spectra[id].problem!);
  const matrices = used.size + (refs.has("FCS") ? 1 : 0) + (refs.has("missing") ? 1 : 0);
  if (matrices > 1) {
    problems.push(
      "This Gating-ML file compensates its gates with more than one spillover matrix " +
      `(${[...(refs.has("FCS") ? ["FCS"] : []), ...used, ...(refs.has("missing") ? ["one it does not carry"] : [])].join(", ")}); ` +
      "GateLab applies one matrix per sample.",
    );
  }
  const sp = used.size ? spectra[[...used][0]] : null;
  return { refs: [...refs], spectrum: sp && { id: sp.id, name: sp.name, channels: sp.channels, matrix: sp.matrix } };
}

function matricesMatch(expected: GatingMLCompensationState, actual: DisplaySpillover): boolean {
  if (!expected.matrix || expected.channels.length !== actual.channels.length) return false;
  const actualIndex = new Map(actual.channels.map((ch, i) => [ch, i]));
  if (expected.channels.some((ch) => !actualIndex.has(ch))) return false;
  for (let i = 0; i < expected.channels.length; i++) {
    for (let j = 0; j < expected.channels.length; j++) {
      const ai = actualIndex.get(expected.channels[i])!;
      const aj = actualIndex.get(expected.channels[j])!;
      const a = expected.matrix[i][j];
      const b = actual.matrix[ai]?.[aj];
      if (!Number.isFinite(b) || Math.abs(a - b) > 1e-8 * Math.max(1, Math.abs(a), Math.abs(b))) {
        return false;
      }
    }
  }
  return true;
}

/**
 * What importGatingML needs from the loaded sample beyond its channels: its $TIMESTEP, and the
 * channels of the matrix the gates will be evaluated with. That is `appliedMatrix` when the import
 * installs one in place of the sample's own (a FlowJo workspace's, as Sample.externalSpilloverPreview
 * maps it), and the sample's own otherwise. The caller passes the one its matrix choice installs.
 *
 * Only that matrix's channels, not both matrices' together: installed, the workspace's matrix
 * replaces the FCS file's, so a detector only the FCS matrix covers is left uncompensated, and a
 * gate drawn uncompensated on it is evaluated exactly. Taken together, 7 of the 16 populations of
 * the public FR-FCM-Z2TQ deposit were left out that the import evaluates as FlowJo drew them
 * ("Macrophages", Comp-BV711-A x AmCyan-A, 5,166 events against FlowJo's 5,200).
 */
export function gatingMLImportOptionsFor(
  sample: Sample,
  appliedMatrix: DisplaySpillover | null = null,
): GatingMLImportOptions {
  const matrix = appliedMatrix ?? sample.spillover;
  const stored = (key: string): NumericColumn | null => {
    const idx = sample.index(key);
    return idx === undefined ? null : sample.originalColumnData(idx);
  };
  return {
    timestep: fcsTimestep(sample.fcs.keywords),
    compensatedChannels: matrix ? channelsCompensationChanges(matrix, stored) : [],
    matrixChannels: matrix ? [...matrix.channels] : [],
  };
}

/**
 * The channels of a spillover matrix whose values compensation changes, as Sample.setCompensation
 * computes them: the matrix's inverse from prepareFlowCompensation, each compensated value the sum
 * of the stored values times one column of it, kept in single precision. A channel whose column of
 * the inverse is exactly the unit vector is its own stored value times 1 plus the others times 0,
 * which is the stored value, and it is left unchanged when single precision holds every stored
 * value exactly: a float or 8- or 16-bit integer parameter always, a double or 32-bit one when each
 * of its values is a single-precision number. In exact arithmetic that column is the unit vector
 * when the matrix's own is, that is when no other fluorochrome spills into that detector; it is
 * tested on the inverse itself, which is what the compensated values are computed with.
 *
 * A gate that declares "uncompensated" on such a channel is evaluated on the same values
 * compensated or not. Taking every channel of the matrix as changed, GateLab left such gates out
 * although base had evaluated them exactly: on the public FR-FCM-ZZRQ workspace, whose matrix's
 * PerCP-H column is (0, ..., 0, 1), "dead, FSC-H subset" and its 8 descendants.
 *
 * `stored` gives a channel's stored values, or null when the sample has no such channel, which is
 * then taken as changed. A matrix that cannot be applied changes every channel it lists: its
 * compensation fails, and the import with it.
 */
export function channelsCompensationChanges(
  matrix: DisplaySpillover,
  stored: (key: string) => ArrayLike<number> | null,
): string[] {
  let inverse: readonly (readonly number[])[];
  try {
    inverse = prepareFlowCompensation(matrix.matrix, DEFAULT_FLOW_SOLVER_SETTINGS).inverse;
  } catch {
    return [...matrix.channels];
  }
  return matrix.channels.filter((key, j) => {
    if (!inverse.every((row, k) => row[j] === (k === j ? 1 : 0))) return true;
    const values = stored(key);
    return values === null || !singlePrecisionHolds(values);
  });
}

/** Whether every value of a stored column is a single-precision number (NaN aside). */
function singlePrecisionHolds(values: ArrayLike<number>): boolean {
  if (values instanceof Float32Array || values instanceof Uint8Array || values instanceof Uint16Array) return true;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Math.fround(v) !== v && !Number.isNaN(v)) return false;
  }
  return true;
}

/**
 * Whether the loaded FCS declares a compensation of its own, for a dimension that asks for it
 * ("FCS"; resolveGatingMLCompensation's fcsHasSpillover). The FCS reader gives no matrix
 * (FcsFile.spillover null) for three things: no $SPILLOVER, $SPILL or SPILL keyword (or a blank
 * one), an identity matrix, which compensates nothing, and a keyword it cannot read as a matrix.
 * Only the first two declare none. The third says the file was compensated with something GateLab
 * cannot read, and "FCS" is refused, as it was for every file before 2026-09; taken for none, a
 * file whose $SPILLOVER was "2,FITC-A,PE-A,1,0.2" (three of four coefficients) was evaluated
 * uncompensated, with a note saying it carries no matrix.
 */
export function fcsDeclaresCompensation(fcs: Pick<FcsFile, "keywords" | "spillover">): boolean {
  if (fcs.spillover !== null) return true;
  const kw = fcs.keywords;
  // The keywords and their order as the FCS reader takes them.
  const raw = kw["$SPILLOVER"] || kw["$SPILL"] || kw["SPILL"];
  if (raw === undefined || raw.trim() === "") return false;
  const parts = raw.split(",").map((p) => p.trim());
  const n = Number(parts[0]);
  if (!Number.isInteger(n) || n < 1 || parts.length < 1 + n + n * n) return true;
  if (parts.slice(1, 1 + n).some((name) => name === "")) return true;
  const values = parts.slice(1 + n, 1 + n + n * n).map(Number);
  if (values.some((v) => !Number.isFinite(v))) return true;
  // Tested as the FCS reader tests an identity matrix.
  return !values.every((v, k) => (Math.floor(k / n) === k % n ? Math.abs(v - 1) < 1e-9 : Math.abs(v) < 1e-9));
}

/** Determine the data state required to evaluate imported gates without changing membership. */
export function resolveGatingMLCompensation(
  embedded: GatingMLCompensationState | null,
  dimensionRefs: GatingMLDimensionCompensation[],
  isFlow: boolean,
  /**
   * The matrix the gates will be evaluated with: the sample's own, or, when the file defines one
   * (GatingMLResult.spectrum_matrix) or a FlowJo workspace brings one, that matrix as
   * Sample.externalSpilloverPreview maps it onto the sample.
   */
  available: DisplaySpillover | null,
  opts: {
    /**
     * False when the loaded FCS carries no $SPILLOVER, or an identity one, which the FCS reader
     * drops (fcsDeclaresCompensation, which tells these from a $SPILLOVER the reader could not
     * read). A dimension that says "FCS" then asks for the file's own compensation, which is none:
     * the ISAC suite evaluates such gates on uncompensated values, and so do FlowKit and flowCore.
     * Absent: not known, and "FCS" with no usable matrix is refused, as it was before 2026-09 for
     * every file.
     */
    fcsHasSpillover?: boolean;
  } = {},
): GatingMLCompensationResolution {
  if (!isFlow) return { target: null, source: "none", requiresConfirmation: false };

  if (embedded) {
    if (!embedded.enabled) {
      if (dimensionRefs.includes("FCS") || dimensionRefs.includes("matrix") || dimensionRefs.includes("missing")) {
        throw new Error("The embedded GateLab compensation state contradicts the Gating-ML dimension references.");
      }
      return { target: false, source: "embedded", requiresConfirmation: false };
    }
    if (!available) {
      throw new Error(
        "This gating strategy was created with FCS spillover compensation enabled, but the loaded FCS has no usable spillover matrix.",
      );
    }
    if (!matricesMatch(embedded, available)) {
      throw new Error(
        "This gating strategy was created with a different FCS spillover matrix. Import was stopped to prevent changed population membership.",
      );
    }
    return { target: true, source: "embedded", requiresConfirmation: false };
  }

  if (dimensionRefs.includes("missing")) {
    // Compensated with a matrix the file names and does not carry: the import has to ask for it
    // (GatingMLResult.missing_compensation), so this is compensated and never assumed.
    return { target: true, source: "dimensions", requiresConfirmation: true };
  }
  if (dimensionRefs.includes("matrix")) {
    if (!available) {
      throw new Error(
        "This Gating-ML file compensates with a spillover matrix it defines, but fewer than two of " +
        "that matrix's detectors are fluorescence channels of the loaded FCS.",
      );
    }
    return { target: true, source: "dimensions", requiresConfirmation: true };
  }
  if (dimensionRefs.includes("FCS")) {
    if (!available && opts.fcsHasSpillover === false) {
      return {
        target: false,
        source: "dimensions",
        requiresConfirmation: false,
        note: "This file's gates ask for the FCS file's own compensation, and the loaded FCS carries no " +
          "spillover matrix (or an identity one), so they are evaluated on uncompensated values, as " +
          "the ISAC Gating-ML test suite and FlowKit evaluate them.",
      };
    }
    if (!available) {
      throw new Error(
        "This Gating-ML file requires FCS spillover compensation, but the loaded FCS has no usable spillover matrix.",
      );
    }
    return { target: true, source: "dimensions", requiresConfirmation: true };
  }
  if (dimensionRefs.includes("uncompensated")) {
    return { target: false, source: "dimensions", requiresConfirmation: false };
  }
  return { target: null, source: "none", requiresConfirmation: false };
}

export function importGatingML(
  xmlText: string,
  sessionChannels: string[],
  pnnToChannel: Record<string, string> = {},
  /** How this app stores gates for the loaded sample; decides whether arcsinh is inverted. */
  instrument: "flow" | "cytof" = "cytof",
  options: GatingMLImportOptions = {},
): GatingMLResult {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const parseErr = doc.getElementsByTagName("parsererror");
  if (parseErr.length) throw new Error("Invalid Gating-ML XML (could not parse).");
  const root = doc.documentElement;

  const { defs: transforms, invalid: invalidTransforms } = parseTransforms(root);
  const format = parseGatelabFormat(root);
  const cytobankModel = format.tree !== null || (carriesCytobankInfo(root) && !placesByParentId(root));
  const flogStandard = flogIsStandard(root, format);
  // A rectangle from another writer is decided on raw values, its edges placed where the file's
  // reader puts them (GateAxisSpec.rawRect); GateLab's own files keep the space GateLab wrote them
  // in, whose bounds its exporter placed for GateLab's own reading (tieBreak).
  const rectanglesOnRaw = format.version === null && !writtenByGatelab(root);
  const timeInSeconds = timeUnitOf(root, format) === "seconds";
  const timestep = options.timestep != null && Number.isFinite(options.timestep) && options.timestep > 0
    ? options.timestep : null;
  const gains = options.gains?.size && gainConventionOf(root) === "scale" ? options.gains : null;
  const gainConverted: string[] = [];
  const gainUnconverted: string[] = [];

  const rawGates: Record<string, RawGate> = {};
  const boolOrder: string[] = [];
  let hierarchyNode: Element | null = null;
  const importProblems: string[] = [...format.problems];
  const supportedGateTypes = new Set(["RectangleGate", "PolygonGate", "EllipsoidGate", "BooleanGate"]);

  for (const el of Array.from(root.children)) {
    if (el.localName === "GatingHierarchy" && !hierarchyNode) {
      hierarchyNode = el;
      continue;
    }

    if (el.localName.endsWith("Gate") && !supportedGateTypes.has(el.localName)) {
      importProblems.push(`${gateLabel(el)} is not supported.`);
      continue;
    }
    if (!supportedGateTypes.has(el.localName)) continue;
    // A gate Cytobank tailored for one FCS file is that file's, not another gate of the tree:
    // cytobankDocumentForFile puts it on its own file.
    if (GEOMETRIC_GATES.has(el.localName) && cytobankTailoredFor(el)) continue;

    const id = attrLocal(el, "id");
    if (!id) {
      importProblems.push(`${el.localName} is missing its required id.`);
      continue;
    }
    if (rawGates[id]) {
      importProblems.push(`${el.localName} has duplicate id ${id}.`);
      continue;
    }

    // A geometric gate with a dimension that names no channel (a ratio) cannot be held; it is
    // left out by name, with what depends on it, and the rest of the file is imported.
    const unnamed = el.localName === "BooleanGate" ? [] : unnamedDimensions(el);
    if (unnamed.length) {
      const name = attrLocal(el, "name") ?? parseCytobankName(el) ?? id;
      const placeholder: RawGate = {
        gml_id: id,
        name,
        gate_type: el.localName === "PolygonGate" ? "polygon" : el.localName === "EllipsoidGate" ? "ellipse" : "rectangle",
        channels: [],
        dims: [],
        lost_reason: `has ${unnamed.join(" and ")}, which GateLab cannot hold`,
      };
      const parentRef = attrLocal(el, "parent_id");
      if (parentRef) placeholder.parent_id = parentRef;
      rawGates[id] = placeholder;
      continue;
    }

    const unreadNumbers = el.localName === "BooleanGate" ? [] : unreadableGateNumbers(el);
    if (unreadNumbers.length) {
      importProblems.push(`${gateLabel(el)} has ${unreadNumbers.join("; ")}.`);
      continue;
    }

    if (el.localName === "RectangleGate") {
      const nDims = parseDimensions(el).length;
      if (nDims < 1 || nDims > 2) {
        importProblems.push(`${gateLabel(el)} has ${nDims} dimensions; only 1D ranges and 2D rectangles are supported.`);
        continue;
      }
    } else if (el.localName === "PolygonGate") {
      const nDims = parseDimensions(el).length;
      const nVertices = childrenLocal(el, "vertex").length;
      if (nDims !== 2 || nVertices < 3) {
        importProblems.push(`${gateLabel(el)} must contain exactly 2 dimensions and at least 3 vertices.`);
        continue;
      }
    } else if (el.localName === "BooleanGate") {
      const operations = Array.from(el.children).filter((child) =>
        child.localName === "and" || child.localName === "or" || child.localName === "not",
      );
      const refs = operations.length === 1 ? childrenLocal(operations[0], "gateReference") : [];
      if (operations.length !== 1 || refs.length === 0) {
        importProblems.push(`${gateLabel(el)} must contain one non-empty Boolean operation.`);
        continue;
      }
      if (operations[0].localName === "not" && refs.length !== 1) {
        importProblems.push(`${gateLabel(el)} uses NOT with ${refs.length} references; unary NOT requires exactly one.`);
        continue;
      }
      // A reference that names no gate was dropped, which left an AND wider than the file says
      // and an OR narrower; one whose complement cannot be read was taken as included.
      let unreadable = false;
      for (const r of refs) {
        // A blank ref names no gate either (an xs:IDREF has no spaces); it was refused as a
        // reference to a missing gate named " ".
        if (!attrLocal(r, "ref")?.trim()) {
          importProblems.push(`${gateLabel(el)} has a gateReference with no ref.`);
          unreadable = true;
          continue;
        }
        const { problem } = complementOf(r);
        if (problem) {
          importProblems.push(`${gateLabel(el)} references ${attrLocal(r, "ref")} with ${problem}.`);
          unreadable = true;
        }
      }
      if (unreadable) continue;
    }

    const g = parseGateNode(el);
    if (!g || !g.gml_id) {
      importProblems.push(`${gateLabel(el)} could not be parsed.`);
      continue;
    }
    const parentRef = attrLocal(el, "parent_id");
    if (parentRef) g.parent_id = parentRef;
    if (g.gate_type !== "boolean") {
      const cid = parseCytobankIds(el).compensation_id;
      if (cid !== undefined) g.compensation_id = cid;
    }
    rawGates[g.gml_id] = g;
    if (g.gate_type === "boolean") boolOrder.push(g.gml_id);
  }
  const spectra = parseSpectrumMatrices(root);
  const missingCompensation = adoptCytobankCompensationIds(rawGates, spectra, importProblems);
  resolveSpectrumDimensions(rawGates, spectra);
  importProblems.push(...missingChannelProblems(rawGates, sessionChannels, pnnToChannel, instrument));
  let gatelabrState: GatelabrState = { scales: null, cytofCofactor: null, compensation: null };
  try {
    gatelabrState = parseGatelabrState(root);
  } catch (e) {
    importProblems.push(e instanceof Error ? e.message : String(e));
  }
  const { refs: compensationRefs, spectrum: spectrumMatrix } = parseCompensationRefs(rawGates, spectra, importProblems);
  // The FlowJo converter's document: an "FCS" dimension is a parameter FlowJo drew on compensated
  // values, and one no matrix here covers is refused with its gates named, never evaluated on the
  // stored values (COMPENSATED_FCS_MARK). A scatter or QC channel is not one: GateLab compensates
  // neither under any matrix (compensation.ts, extractDisplaySpillover), and a FlowJo matrix listing
  // one leaves it as stored (FR-FCM-Z2C8 elifeFig7C.wsp's Comp-FSC-A, whose row and column are
  // the identity's, where 7dc41c1 refused a tree GateLab counted as FlowJo does).
  if (format.fcsCompensated && instrument === "flow" && options.matrixChannels != null) {
    const covered = new Set(options.matrixChannels);
    const gatesOn = new Map<string, string[]>();
    for (const gate of Object.values(rawGates)) {
      if (gate.gate_type === "boolean") continue;
      for (const dim of new Set(gate.dims ?? [])) {
        if (dim.compensation_ref?.trim().toLowerCase() !== "fcs") continue;
        const key = resolveChannel(dim.channel, sessionChannels, pnnToChannel, instrument);
        if (key === null || covered.has(key) || isScatterChannel(key) || isQcChannel(key)) continue;
        const names = gatesOn.get(key) ?? [];
        if (!names.includes(gate.name)) names.push(gate.name);
        gatesOn.set(key, names);
      }
    }
    if (gatesOn.size) {
      const gates = [...new Set([...gatesOn.values()].flat())];
      const channels = [...gatesOn.keys()];
      importProblems.push(
        `${gates.length === 1 ? "The gate" : "The gates"} ${gates.slice(0, 3).map((g) => `"${g}"`).join(", ")}` +
        `${gates.length > 3 ? `, and ${gates.length - 3} more,` : ""} ${gates.length === 1 ? "was" : "were"} drawn in FlowJo on ` +
        `compensated values of ${channels.join(", ")}, and no spillover matrix that applies to this file covers ` +
        `${channels.length === 1 ? "it" : "them"}: neither the workspace's nor the FCS file's own. Evaluated on the stored ` +
        "values, they would not hold the events FlowJo's hold.",
      );
    }
  }
  const derivedPopulations = parseDerivedPopulations(root);
  // A FlowJo intersection is a parent too. It is declared in custom_info, not as a gate.
  const intersectionIds = new Set(derivedPopulations.map((d) => d.id));

  for (const gate of Object.values(rawGates)) {
    for (const dim of gate.dims ?? []) {
      const ref = dim.transformation_ref;
      if (ref && invalidTransforms[ref]) {
        importProblems.push(`${gate.gml_id} (${gate.name}) references transformation ${ref}, which is invalid: ${invalidTransforms[ref]}.`);
      } else if (ref && !transforms[ref]) {
        importProblems.push(`${gate.gml_id} references unsupported or missing transformation ${ref}.`);
      } else if (ref && !specFromGmlTransform(transforms[ref], format.logicleUnit, flogStandard)) {
        importProblems.push(`${gate.gml_id} (${gate.name}) references transformation ${ref}, which GateLab cannot hold exactly.`);
      }
    }
    if (gate.parent_id && !rawGates[gate.parent_id] && !intersectionIds.has(gate.parent_id)) {
      importProblems.push(`${gate.gml_id} references missing parent gate ${gate.parent_id}.`);
    }
    if (format.parentIdHierarchy && !hierarchyNode) {
      importProblems.push(...parentIdHierarchyProblems(gate, rawGates));
    }
    if (gate.gate_type === "boolean") {
      for (const ref of gate.refs ?? []) {
        const target = rawGates[ref.gate_id];
        if (!target) importProblems.push(`${gate.gml_id} references missing gate ${ref.gate_id}.`);
        else if (target.gate_type === "boolean" && format.parentIdHierarchy && !hierarchyNode) {
          // Checked by parentIdHierarchyProblems: only an operand NOT gate may be referenced.
        } else if (target.gate_type === "boolean" && (hierarchyNode || cytobankModel || format.parentIdHierarchy)) {
          // In a Gating-ML 2.0 file a Boolean operand is an ordinary gate, read by
          // buildPopulationsFromBooleans, which leaves out by name what it cannot represent.
          // Cytobank/GateLab flat exports encode ancestry as a Boolean reference
          // plus a matching pop_X parent in custom_info. That pattern is
          // representable as a parent population followed by incremental gates.
          const parentIndices = gate.pop_parent_indices ?? [];
          const targetPosition = boolOrder.indexOf(ref.gate_id) + 1;
          const targetGateSetId = target.gate_set_id;
          const isFlatParentReference = !hierarchyNode && parentIndices.some((index) =>
            index === targetPosition || (targetGateSetId != null && index === targetGateSetId),
          );
          if (!isFlatParentReference) {
            importProblems.push(
              `${gate.gml_id} contains a nested Boolean reference to ${ref.gate_id} that cannot be represented safely.`,
            );
          }
        }
      }
    }
  }

  if (format.tree && !hierarchyNode && !format.parentIdHierarchy) {
    importProblems.push(...treeProblems(format.tree, rawGates, boolOrder));
  }

  if (hierarchyNode) {
    for (const pair of Array.from(hierarchyNode.getElementsByTagName("*"))) {
      if (pair.localName !== "PopulationGatePair") continue;
      const ref = attrLocal(pair, "gate-ref");
      if (!ref) importProblems.push("A PopulationGatePair is missing gate-ref.");
      else if (!rawGates[ref]) importProblems.push(`A PopulationGatePair references missing gate ${ref}.`);
      const { problem } = complementOf(pair);
      if (problem) importProblems.push(`The PopulationGatePair for ${ref ?? "(no gate-ref)"} has ${problem}.`);
    }
  }

  if (importProblems.length) throwImportProblems(importProblems);

  const gmlToApp: Record<string, string> = {};
  const appGates: Record<string, Gate> = {};
  const gateOrder: string[] = [];
  let nSkipped = 0;
  /** Geometric gates the file declares but GateLab could not import, with the reason. */
  const lostGates = new Map<string, string>();
  const unresolved: string[] = [];

  /** The dimensions' compensation as the import evaluates it (see compensationImmaterial). */
  let compensationRefsHeld = compensationRefs;
  // GateLab evaluates a sample on one compensation, so a gate that declares uncompensated values
  // on a channel the file's other gates compensate cannot be evaluated as drawn. It was evaluated
  // on the compensated values until 2026-09, with nothing said (FlowKit 37,118 events, GateLab
  // 24,014 on the public FACSDiva file); it is left out, by name, with what depends on it.
  if (instrument === "flow") {
    const refs = new Set(compensationRefs);
    const fcsOrMissing = refs.has("FCS") || refs.has("missing") || gatelabrState.compensation?.enabled === true;
    if (fcsOrMissing || refs.has("matrix")) {
      const known = options.compensatedChannels;
      const compensated = new Set<string>(fcsOrMissing && known && !refs.has("missing") ? known : []);
      // Not knowing which channels the matrix covers, every channel a matrix could cover is.
      const anyFluor = fcsOrMissing && (!known || refs.has("missing"));
      for (const pnn of spectrumMatrix?.channels ?? []) {
        const key = resolveChannel(pnn, sessionChannels, pnnToChannel, instrument);
        if (key) compensated.add(key);
      }
      const isCompensated = (key: string) =>
        compensated.has(key) || (anyFluor && !isScatterChannel(key) && !isQcChannel(key));
      // "FCS" only on channels the matrix leaves alone (scatter, a detector outside it) asks for
      // nothing compensation changes. Where the uncompensated gates are on channels it covers,
      // compensation off holds every gate exactly, and the file is evaluated so; the uncompensated
      // gate was left out instead (a FlowKit-written file on the public FACSDiva data: FlowKit
      // 36,759 events of "UncompFluor", GateLab none).
      const channelsDeclaring = (ref: string): string[] => Object.values(rawGates)
        .filter((g) => g.gate_type !== "boolean" && !g.lost_reason)
        .flatMap((g) => (g.dims ?? [])
          .filter((d) => d.compensation_ref?.trim().toLowerCase() === ref)
          .map((d) => resolveChannel(d.channel, sessionChannels, pnnToChannel, instrument))
          .filter((key): key is string => key !== null));
      const compensationImmaterial = refs.has("FCS") && !refs.has("matrix") && !refs.has("missing") &&
        !gatelabrState.compensation && !channelsDeclaring("fcs").some(isCompensated) &&
        channelsDeclaring("uncompensated").some(isCompensated);
      if (compensationImmaterial) {
        compensationRefsHeld = [...compensationRefs.filter((r) => r !== "FCS"), ...(refs.has("uncompensated") ? [] : ["uncompensated" as const])];
      }
      for (const g of compensationImmaterial ? [] : Object.values(rawGates)) {
        if (g.gate_type === "boolean" || g.lost_reason) continue;
        // Named as the file names them, as every other import problem is.
        const clash = [...new Set(g.dims ?? [])]
          .filter((d) => d.compensation_ref?.trim().toLowerCase() === "uncompensated")
          .filter((d) => {
            const key = resolveChannel(d.channel, sessionChannels, pnnToChannel, instrument);
            return key !== null && isCompensated(key);
          })
          .map((d) => d.channel);
        if (clash.length) {
          g.lost_reason = `declares uncompensated values on ${[...new Set(clash)].join(", ")}, which the file's ` +
            "other gates compensate; GateLab evaluates a sample on one compensation";
        }
      }
    }
  }

  // Which session channels are Time, found the way FlowKit and FlowJo find it: by $PnN.
  const timeKeys = new Set<string>();
  for (const [pnn, key] of Object.entries(pnnToChannel)) if (isTimeParameter(pnn)) timeKeys.add(key);
  for (const ch of sessionChannels) if (isTimeParameter(ch)) timeKeys.add(ch);

  // Primitive gates → app gates (resolve channels, hold each in the space its dimensions declare).
  for (const gmlId of Object.keys(rawGates)) {
    const g = rawGates[gmlId];
    if (g.gate_type === "boolean") continue;
    if (g.lost_reason) {
      nSkipped++;
      lostGates.set(gmlId, g.lost_reason);
      continue;
    }

    const channels = [...new Set(g.channels)];
    const resolved: Record<string, string | null> = {};
    for (const ch of channels) resolved[ch] = resolveChannel(ch, sessionChannels, pnnToChannel, instrument);
    const missing = channels.filter((ch) => resolved[ch] == null);
    if (missing.length) {
      unresolved.push(...missing);
      nSkipped++;
      lostGates.set(gmlId, `names a channel not in the loaded data (${missing.join(", ")})`);
      continue;
    }
    const xCh = resolved[g.x_channel!];
    const yCh = resolved[g.y_channel!];
    if (!xCh || !yCh) {
      nSkipped++;
      lostGates.set(gmlId, "names a channel not in the loaded data");
      continue;
    }

    const xTr = g.dims?.[0]?.transformation_ref;
    const yTr = g.dims?.[1]?.transformation_ref;

    // Gating-ML puts the transform on the GATE, so the faithful import keeps each vertex in the
    // space its dimension declares and records that transform; every transform GateLab reads is
    // held exactly (specFromGmlTransform), on every channel. Time, Event_length and the other
    // channels GateLab shows linear kept raw vertices "whatever a file claims" until 2026-09, but
    // a file declares a transform on them only when its coordinates are in it, as GateLab's own
    // export of a FlowJo ArcSinh gate on Event_length does: read as raw, such a gate lost every
    // event (a FlowKit-written arcsinh gate on Cell_length of the public Bodenmiller file: FlowKit
    // 2,061 events, GateLab 0).
    const axisSpec = (ch: string, ref: string | undefined): GateAxisSpec | null => {
      const held = ref ? specFromGmlTransform(transforms[ref], format.logicleUnit, flogStandard) : specFromGmlTransform(undefined);
      // A Time coordinate in seconds is held on the stored ticks (timeUnitOf).
      return held && timeInSeconds && timestep !== null && timeKeys.has(ch) ? inTicks(held, timestep) : held;
    };
    const sx = axisSpec(xCh, xTr);
    const sy = axisSpec(yCh, yTr);
    // A gate keeps one transform per channel, so one channel on both axes under two different
    // transforms has no place to keep the second: the second was put on both axes, silently
    // (51,950 events of a FlowKit polygon on the public DiVa file, where FlowKit counts none).
    if (!g.wsp_space && xCh === yCh && sx && sy && JSON.stringify(sx.spec) !== JSON.stringify(sy.spec)) {
      nSkipped++;
      lostGates.set(gmlId, "puts one channel on both axes under two different transforms, which GateLab cannot hold on one gate");
      continue;
    }

    let verts: Vertex[];
    let spaceFields: { space?: "raw" | "display"; transforms?: GateTransforms };
    /** A FlowJo grid polygon's raw vertices, carried for the FlowJo export. */
    let flowJoVertices: Vertex[] | undefined;
    if (g.wsp_space) {
      // A FlowJo workspace gate arrives already moved into the space FlowJo evaluates it in, with
      // that space recorded on the element. Gating-ML cannot express biex or FlowJo's log, so the
      // converter carries them here rather than through a transformation-ref.
      verts = (g.vertices ?? []).map((v) => [v[0], v[1]] as Vertex);
      spaceFields = {
        space: "display",
        transforms: { [xCh]: g.wsp_space.x, [yCh]: g.wsp_space.y },
      };
      // A grid is a pair or nothing: one grid axis without the other is not FlowJo's rule.
      const gx = isFlowJoGridSpec(g.wsp_space.x);
      if (gx !== isFlowJoGridSpec(g.wsp_space.y) || (gx && g.gate_type !== "polygon")) {
        // Left out by name, as every gate GateLab cannot hold as declared is (fix/gatingml-transforms).
        nSkipped++;
        lostGates.set(gmlId, "is on FlowJo's channel grid on one axis only, or is not a polygon; FlowJo grids a polygon on both axes");
        continue;
      }
      if (gx && g.wsp_space.raw?.length === verts.length) flowJoVertices = g.wsp_space.raw;
    } else if (g.grid_mark && g.gate_type === "polygon") {
      // A grid polygon GateLab exported: the file holds the union of its grid cells, which selects
      // the same events, and the mark gives back the gate itself -- its grid, its vertices on
      // their channels and FlowJo's raw vertices.
      verts = g.grid_mark.vertices.map(([a, b]) => [a, b] as Vertex);
      spaceFields = { space: "display", transforms: { [xCh]: g.grid_mark.x, [yCh]: g.grid_mark.y } };
      flowJoVertices = g.grid_mark.raw;
    } else if (sx && sy) {
      // A rectangle from another writer is held on raw values where its axis can be (rawRect),
      // with both of its edges placed; one channel on both axes, as a range is, on both or neither.
      const rawEdges = (a: GateAxisSpec, k: 0 | 1): [number, number] | null => {
        const r = g.gate_type === "rectangle" && rectanglesOnRaw ? a.rawRect : undefined;
        const vs = (g.vertices ?? []).map((v) => v[k]);
        if (!r?.rectEdge || !vs.length) return null;
        const e: [number, number] = [r.rectEdge(Math.min(...vs), "lo"), r.rectEdge(Math.max(...vs), "hi")];
        return e[0] <= e[1] ? e : null;
      };
      let rx = rawEdges(sx, 0);
      let ry = rawEdges(sy, 1);
      if (xCh === yCh && !rx !== !ry) rx = ry = null;
      const beyondSingle = (!rx && fasinhBeyondSinglePrecision(xTr ? transforms[xTr] : undefined))
        || (!ry && fasinhBeyondSinglePrecision(yTr ? transforms[yTr] : undefined));
      if (beyondSingle) {
        nSkipped++;
        lostGates.set(gmlId, beyondSingle);
        continue;
      }
      const ax = rx ? sx.rawRect! : sx;
      const ay = ry ? sy.rawRect! : sy;
      // An unbounded edge stays unbounded in any space; converting it would give a finite number.
      const kx = (v: number) => (isUnbounded(v) ? v : ax.toGateUnits(v));
      const ky = (v: number) => (isUnbounded(v) ? v : ay.toGateUnits(v));
      verts = (g.vertices ?? []).map((v) => [kx(v[0]), ky(v[1])]);
      if (g.gate_type === "rectangle" && (ax.rectEdge || ay.rectEdge) && verts.length) {
        // Each edge where converting it rounds is placed exactly (exactStoredEdge). A range no
        // stored value lies in at all keeps the converted edges.
        const edges = (k: 0 | 1, a: GateAxisSpec, conv: (v: number) => number): [number, number] => {
          const placed = k === 0 ? rx : ry;
          if (placed) return placed;
          const vs = (g.vertices ?? []).map((v) => v[k]);
          const [lo, hi] = [Math.min(...vs), Math.max(...vs)];
          const plain: [number, number] = [conv(lo), conv(hi)];
          if (!a.rectEdge) return plain;
          const exact: [number, number] = [
            isUnbounded(lo) ? lo : a.rectEdge(lo, "lo"),
            isUnbounded(hi) ? hi : a.rectEdge(hi, "hi"),
          ];
          return exact[0] <= exact[1] ? exact : plain;
        };
        const [xlo, xhi] = edges(0, ax, kx);
        const [ylo, yhi] = edges(1, ay, ky);
        verts = [[xlo, ylo], [xhi, ylo], [xhi, yhi], [xlo, yhi]];
      }
      // Raw only when neither axis transforms or bounds its values: a bound is applied to the
      // values a gate is tested on, which only a display-space gate's pinned columns carry.
      const plain = (s: TransformSpec) => s.kind === "identity" && !s.bounds;
      spaceFields = plain(ax.spec) && plain(ay.spec)
        ? { space: "raw" }
        : { space: "display", transforms: { [xCh]: ax.spec, [yCh]: ay.spec } };
    } else {
      // Refused before any gate is built (importProblems); kept so that no path imports a gate
      // other than the one the file declares.
      nSkipped++;
      lostGates.set(gmlId, "is declared on a scale GateLab cannot hold exactly");
      continue;
    }
    if (verts.length < 3 && g.gate_type === "polygon") {
      nSkipped++;
      lostGates.set(gmlId, "has fewer than three vertices");
      continue;
    }

    const appId = uuid();
    if (g.wsp_curly) {
      // The rectangle stands for a whole curly quadrant gate: its minima are the crosshair,
      // and the four FlowJo populations that share it arrive as derived populations naming one
      // quadrant each. The bend is a shape in the display space the converter carried, so a
      // crosshair that could not be carried imports straight (the converter has said so).
      const curl = spaceFields.space === "display" && validCurl(g.wsp_curly.curl) ? g.wsp_curly.curl : null;
      appGates[appId] = {
        gate_id: appId,
        name: g.name,
        gate_type: "quadrant",
        x_channel: xCh,
        y_channel: yCh,
        center: [verts[0][0], verts[0][1]],
        ...(curl ? { curl: { ...curl } } : {}),
        color: g.color ?? nextGateColor(Object.keys(appGates).length),
        label_offset: null,
        ...spaceFields,
      };
      gateOrder.push(appId);
      gmlToApp[gmlId] = appId;
      continue;
    }
    if (g.gate_type === "ellipse" && g.ellipse) {
      // An ellipse's parameters live in the space its dimensions declare, exactly like polygon
      // vertices. The per-axis unit change (toGateUnits) is affine for every transform GateLab
      // holds, so it acts on the mean through the whole map and on the covariance through its
      // slope, C'ij = Cij·ki·kj.
      if (!(sx && sy)) continue; // cannot happen: the branch above has left such a gate out
      const kx = sx.toGateUnits(1) - sx.toGateUnits(0);
      const ky = sy.toGateUnits(1) - sy.toGateUnits(0);
      const e = g.ellipse;
      appGates[appId] = {
        gate_id: appId,
        name: g.name,
        gate_type: "ellipse",
        x_channel: xCh,
        y_channel: yCh,
        mean: [sx.toGateUnits(e.mean[0]), sy.toGateUnits(e.mean[1])],
        covariance: [
          [e.covariance[0][0] * kx * kx, e.covariance[0][1] * kx * ky],
          [e.covariance[1][0] * ky * kx, e.covariance[1][1] * ky * ky],
        ],
        distance_square: e.distance_square,
        color: g.color ?? nextGateColor(Object.keys(appGates).length),
        label_offset: null,
        ...spaceFields,
      };
    } else {
      appGates[appId] = {
        gate_id: appId,
        name: g.name,
        gate_type: g.gate_type as "polygon" | "rectangle",
        x_channel: xCh,
        y_channel: yCh,
        vertices: verts,
        ...(flowJoVertices ? { flowjo_vertices: flowJoVertices.map(([a, b]) => [a, b] as Vertex) } : {}),
        ...(g.gate_type === "rectangle" && g.flowjo_axes && (g.flowjo_axes.x || g.flowjo_axes.y)
          ? {
            flowjo_axes: {
              ...(g.flowjo_axes.x ? { [xCh]: g.flowjo_axes.x } : {}),
              ...(g.flowjo_axes.y ? { [yCh]: g.flowjo_axes.y } : {}),
            },
          }
          : {}),
        ...(g.gate_type === "rectangle" ? flowJoBoundsField(g.flowjo_axes?.opened, xCh, yCh) : {}),
        ...(g.gate_type === "polygon" && g.flowjo_polygon ? { flowjo_polygon: { ...g.flowjo_polygon } } : {}),
        color: g.color ?? nextGateColor(Object.keys(appGates).length),
        label_offset: null, // auto-position (buildPlotGates computes it in display space)
        ...spaceFields,
      };
    }
    if (gains) {
      // On the stored values GateLab gates, before its own record of a rectangle is checked.
      const restated = gatesFromGatingMlScale({ [appId]: appGates[appId] }, gains);
      appGates[appId] = restated.gates[appId];
      gainConverted.push(...restated.converted);
      gainUnconverted.push(...restated.unconverted);
    }
    if (g.gate_type === "rectangle") setRectangleRule(appGates[appId] as PolyRectGate, g, root);
    gateOrder.push(appId);
    gmlToApp[gmlId] = appId;
  }

  // Mark boolean gates as resolvable once all their refs resolve (for hierarchy expansion).
  const boolIds = Object.keys(rawGates).filter((id) => rawGates[id].gate_type === "boolean");
  for (let iter = 0; iter < 12; iter++) {
    let changed = false;
    for (const bid of boolIds) {
      if (gmlToApp[bid]) continue;
      const refs = rawGates[bid].refs ?? [];
      if (refs.length === 0) continue;
      const ok = refs.every((r) => gmlToApp[r.gate_id] || boolIds.includes(r.gate_id));
      if (ok) {
        gmlToApp[bid] = bid;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const rootPop = newRootPopulation();
  const rootPopId = rootPop.population_id;
  let populations: PopulationMap = { [rootPopId]: rootPop };
  const warnings: string[] = [];
  const skips: PopulationSkips = {
    lostGates,
    lostOperand: (bid) => {
      for (const r of rawGates[bid]?.refs ?? []) {
        const target = rawGates[r.gate_id];
        if (!target) continue;
        if (target.gate_type !== "boolean") {
          if (lostGates.has(r.gate_id)) return r.gate_id;
        } else if (target.operand_helper) {
          const inner = target.refs?.[0]?.gate_id;
          if (inner && lostGates.has(inner)) return inner;
        }
      }
      return null;
    },
    warnOr: (popName) => {
      warnings.push(`"${popName}" combines its references with OR, which GateLab cannot represent; it and anything below it were skipped.`);
    },
    warnNoGates: (popName) => {
      warnings.push(`"${popName}" references no gate GateLab could read; it and anything below it were skipped.`);
    },
    warnNotAnd: (popName) => {
      warnings.push(`"${popName}" negates or combines gates in a way that is not one AND of gates, each included or excluded, which GateLab cannot represent; it and anything below it were skipped.`);
    },
    warnOutside: (popName, gateGml, parentGml) => {
      const name = (gml: string) => rawGates[gml]?.name ?? gml;
      warnings.push(`"${popName}" uses the gate "${name(gateGml)}", which sits beneath "${name(parentGml)}", not above "${popName}"; ` +
        "GateLab cannot represent that as a population within one parent, so it and anything below it were skipped.");
    },
    warnLost: (popName, gateGml) => {
      const gateName = rawGates[gateGml]?.name ?? gateGml;
      const why = lostGates.get(gateGml) ?? "could not be imported";
      warnings.push(popName === gateName
        ? `"${popName}" ${why}; it and anything below it were skipped.`
        : `"${popName}" uses the gate "${gateName}", which ${why}; it and anything below it were skipped.`);
    },
  };

  if (hierarchyNode) {
    // Written by GateLab before 2026-09, and by GateLabR.
    const processPair = (pairNode: Element, parentId: string): void => {
      const gateRefGml = attrLocal(pairNode, "gate-ref");
      const complement = complementOf(pairNode).value;

      const nameNode = firstChildLocal(pairNode, "name");
      let popName = nameNode ? nameText(nameNode.textContent ?? "") : "";
      if (!popName.trim()) popName = "";
      if (!popName && gateRefGml && rawGates[gateRefGml]) popName = rawGates[gateRefGml].name;
      if (!popName) popName = "Population";

      // A gate the population needs was not imported: without it the population would be
      // wider than the file says, so it and its subtree are left out, by name.
      const lost = !gateRefGml ? null
        : lostGates.has(gateRefGml) ? gateRefGml
        : rawGates[gateRefGml]?.gate_type === "boolean" ? skips.lostOperand(gateRefGml)
        : null;
      if (lost) {
        skips.warnLost(popName, lost);
        return;
      }
      if (gateRefGml && rawGates[gateRefGml]?.operation === "or") {
        skips.warnOr(popName);
        return;
      }

      let gateRefs: GateRef[] = [];
      let gateLogic: "and" | "or" = "and";
      if (gateRefGml && gmlToApp[gateRefGml]) {
        const refGate = rawGates[gateRefGml];
        if (refGate && refGate.gate_type === "boolean") {
          if (refGate.operation === "or") gateLogic = "or";
          const seen = new Set<string>();
          for (const r of refGate.refs ?? []) {
            const aid = gmlToApp[r.gate_id];
            if (!aid || aid === r.gate_id || seen.has(aid)) continue;
            seen.add(aid);
            let include = refGate.operation === "not" ? r.complement : !r.complement;
            gateRefs.push(newGateRef(aid, include));
          }
          if (complement) {
            gateRefs = gateRefs.map((ref) => newGateRef(ref.gate_id, !ref.include, ref.quadrant));
            if (refGate.operation !== "not") gateLogic = gateLogic === "and" ? "or" : "and";
          }
        } else {
          gateRefs = [newGateRef(gmlToApp[gateRefGml], !complement)];
        }
      }

      // Never left out without a word: a population that reads as no gate is named, with what
      // sits beneath it, as the other readers name theirs.
      if (gateRefs.length === 0) {
        skips.warnNoGates(popName);
        return;
      }

      const pop = newPopulation(popName, gateRefs, parentId, gateLogic);
      populations[pop.population_id] = pop;
      populations = linkChildToParent(populations, pop.population_id, parentId);

      for (const child of childrenLocal(pairNode, "PopulationGatePair")) processPair(child, pop.population_id);
    };

    for (const top of childrenLocal(hierarchyNode, "PopulationGatePair")) processPair(top, rootPopId);
  } else if (format.parentIdHierarchy) {
    populations = buildPopulationsFromParentIds(rawGates, boolOrder, gmlToApp, populations, rootPopId, skips);
  } else {
    buildPopulationsFromBooleans(rawGates, boolOrder, gmlToApp, appGates, gateOrder, populations,
      rootPopId, derivedPopulations, format.tree, skips, cytobankModel, parseOperandGates(root));
  }

  return {
    gates: appGates,
    gate_order: gateOrder,
    populations,
    root_population_id: rootPopId,
    n_gates_imported: Object.keys(appGates).length,
    n_gates_skipped: nSkipped,
    ...(gains ? { gain: { converted: gainConverted, unconverted: gainUnconverted } } : {}),
    skipped_channels: [...new Set(unresolved)].sort(),
    warnings: [...new Set(warnings)],
    source: detectSource(root),
    n_pops_imported: Math.max(0, Object.keys(populations).length - 1),
    scales: gatelabrState.scales,
    cytof_cofactor: gatelabrState.cytofCofactor,
    compensation: gatelabrState.compensation,
    compensation_refs: compensationRefsHeld,
    spectrum_matrix: spectrumMatrix,
    missing_compensation: missingCompensation,
  };
}

/**
 * What a GateLab standard-format file (`hierarchy: "parent_id"`) must satisfy for
 * buildPopulationsFromParentIds to reproduce it exactly. A third-party reader evaluates the same
 * file by Gating-ML's rules, so anything GateLab would read differently is refused, not guessed:
 *   • only a population carries parent_id, and its parent is another population. On a geometric
 *     gate, parent_id would narrow every population that uses it as an operand, which GateLab
 *     would not do;
 *   • a population references geometric gates, or the operand NOT of one geometric gate;
 *   • the parent chain ends at the root.
 */
function parentIdHierarchyProblems(gate: RawGate, rawGates: Record<string, RawGate>): string[] {
  const problems: string[] = [];
  const isPopulation = (g: RawGate | undefined) => !!g && g.gate_type === "boolean" && !g.operand_helper;
  if (gate.parent_id && rawGates[gate.parent_id]) {
    if (!isPopulation(gate)) {
      problems.push(`${gate.gml_id} has a parent_id, but only a population may have one in a GateLab file.`);
    } else if (!isPopulation(rawGates[gate.parent_id])) {
      problems.push(`${gate.gml_id} names ${gate.parent_id} as its parent, which is not a population.`);
    } else {
      const seen = new Set<string>([gate.gml_id]);
      for (let p: string | undefined = gate.parent_id; p; p = rawGates[p]?.parent_id) {
        if (seen.has(p)) {
          problems.push(`${gate.gml_id} is its own ancestor through parent_id.`);
          break;
        }
        seen.add(p);
      }
    }
  }
  if (gate.gate_type !== "boolean") return problems;
  const primitive = (id: string) => rawGates[id] && rawGates[id].gate_type !== "boolean";
  if (gate.operand_helper) {
    if (gate.operation !== "not" || (gate.refs ?? []).length !== 1 || !primitive(gate.refs![0].gate_id)) {
      problems.push(`${gate.gml_id} is marked as an operand but is not the NOT of one gate.`);
    }
    return problems;
  }
  for (const ref of gate.refs ?? []) {
    const target = rawGates[ref.gate_id];
    if (target && target.gate_type === "boolean" && !target.operand_helper) {
      problems.push(
        `${gate.gml_id} contains a nested Boolean reference to ${ref.gate_id} that cannot be represented safely.`,
      );
    }
  }
  return problems;
}

/**
 * What a Cytobank-format tree (GatelabFormat.tree) must satisfy to be taken as the file's tree:
 * it lists every BooleanGate in the file once, and each parent is a population listed before it.
 * One that does not describes some other file, so the import is refused rather than half-applied.
 */
function treeProblems(
  tree: NonNullable<GatelabFormat["tree"]>,
  rawGates: Record<string, RawGate>,
  boolOrder: string[],
): string[] {
  const problems: string[] = [];
  const listed = new Set<string>();
  /** A population's references as "gate|included"; null for an OR, which nothing sits beneath. */
  const literals = (bid: string): Set<string> | null => {
    const g = rawGates[bid];
    if (!g || g.gate_type !== "boolean" || g.operation === "or") return null;
    return new Set((g.refs ?? []).map((r) => `${r.gate_id}|${g.operation === "not" ? r.complement : !r.complement}`));
  };
  for (const { id, parent } of tree) {
    if (listed.has(id)) problems.push(`The file's GateLab tree lists ${id} twice.`);
    else if (rawGates[id]?.gate_type !== "boolean") problems.push(`The file's GateLab tree lists ${id}, which is not a Boolean gate in the file.`);
    if (parent !== null && !listed.has(parent)) {
      problems.push(`The file's GateLab tree places ${id} under ${parent}, which is not a population listed before it.`);
    } else if (parent !== null) {
      // The format ANDs every ancestor's gates into each population, so a population's chain holds
      // its parent's, each with the same sign. One that does not is not beneath that parent for any
      // other reader, and GateLab would read it as that parent's events passing its own gates.
      const mine = literals(id);
      const theirs = literals(parent);
      if (mine && (!theirs || [...theirs].some((l) => !mine.has(l)))) {
        problems.push(
          `The file's GateLab tree places ${id} under ${parent}, but ${id}'s Boolean gate does not hold ` +
          `${parent}'s gates as the Cytobank format writes every ancestor's, so the tree and the gates disagree.`,
        );
      }
    }
    listed.add(id);
  }
  for (const bid of boolOrder) {
    if (!listed.has(bid)) problems.push(`The file's GateLab tree does not list the population ${bid}.`);
  }
  return problems;
}

/**
 * What the population builders need to leave out a population whose gate was not imported, and
 * to say so. A population missing one of its gates is not the population the file describes: an
 * AND without an operand holds more events than it should, and with none left it holds all of its
 * parent's (a logicle ellipse on a scale GateLab cannot hold came back as 23,300 events instead of
 * 8,397 that way). So it is left out with everything beneath it, and named.
 */
interface PopulationSkips {
  /** Geometric gates not imported, with the reason. */
  lostGates: Map<string, string>;
  /** The first not-imported geometric gate a BooleanGate references, through an operand NOT gate. */
  lostOperand(booleanGml: string): string | null;
  /** Record that a population was left out because of that gate. */
  warnLost(populationName: string, gateGml: string): void;
  /**
   * Record that an OR population was left out. GateLab imports AND populations, with NOT on
   * individual references; an OR has no faithful form once it is combined with anything else.
   * The whole file used to be refused for one; now that population and its subtree are left out
   * and named, and the rest is imported, as the FlowJo workspace import does with an OrNode.
   */
  warnOr(populationName: string): void;
  /** Record that a population was left out because it references no gate GateLab could read. */
  warnNoGates(populationName: string): void;
  /** Record that a Boolean population was left out because it is not one AND of single gates. */
  warnNotAnd(populationName: string): void;
  /**
   * Record that a Boolean population was left out because a gate it uses sits beneath a gate that
   * is not its own ancestor, so the gate's membership carries a parent the population's does not.
   */
  warnOutside(populationName: string, gateGml: string, parentGml: string): void;
}

/**
 * Populations of a GateLab standard-format file: one per BooleanGate that is not an operand, its
 * parent the population its gating:parent_id names (the root when it has none), its references
 * the gates it combines.
 *
 * A NOT gate stands for its one gate excluded, and a reference repeated to meet and/or's two
 * operands is one reference. Parents precede children in the file, and each is placed once its
 * parent is, so sibling order survives either way.
 */
function buildPopulationsFromParentIds(
  rawGates: Record<string, RawGate>,
  boolOrder: string[],
  gmlToApp: Record<string, string>,
  populations: PopulationMap,
  rootPopId: string,
  skips: PopulationSkips,
): PopulationMap {
  /** A gate reference as (gate, included), seeing through an operand NOT gate. */
  const literal = (ref: { gate_id: string; complement: boolean }): { gate: string; include: boolean } | null => {
    const target = rawGates[ref.gate_id];
    if (!target) return null;
    if (target.gate_type !== "boolean") {
      const app = gmlToApp[ref.gate_id];
      return app ? { gate: app, include: !ref.complement } : null;
    }
    const inner = target.refs?.[0];
    const app = inner ? gmlToApp[inner.gate_id] : undefined;
    if (!inner || !app) return null;
    const helperIncludes = inner.complement; // NOT(gate) excludes it; NOT(NOT gate) includes it
    return { gate: app, include: ref.complement ? !helperIncludes : helperIncludes };
  };

  const popIds: Record<string, string> = {};
  /** Populations left out; a population beneath one is left out with it. */
  const skipped = new Set<string>();
  let waiting = boolOrder.filter((bid) => rawGates[bid]?.gate_type === "boolean" && !rawGates[bid].operand_helper);
  while (waiting.length) {
    const next: string[] = [];
    for (const bid of waiting) {
      const g = rawGates[bid];
      if (g.parent_id && skipped.has(g.parent_id)) { skipped.add(bid); continue; }
      const parentPid = g.parent_id ? popIds[g.parent_id] : rootPopId;
      if (parentPid === undefined) { next.push(bid); continue; }
      const lost = skips.lostOperand(bid);
      if (lost || g.operation === "or") {
        if (lost) skips.warnLost(g.name, lost);
        else skips.warnOr(g.name);
        skipped.add(bid);
        continue;
      }
      const lits = (g.refs ?? []).map(literal).filter((l): l is { gate: string; include: boolean } => l !== null);
      let refs: GateRef[];
      if (g.operation === "not") {
        refs = lits.slice(0, 1).map((l) => newGateRef(l.gate, !l.include));
      } else {
        const seen = new Set<string>();
        refs = [];
        for (const l of lits) {
          const k = `${l.gate}|${l.include}`;
          if (seen.has(k)) continue;
          seen.add(k);
          refs.push(newGateRef(l.gate, l.include));
        }
      }
      const pop = newPopulation(g.name, refs, parentPid, "and");
      populations[pop.population_id] = pop;
      populations = linkChildToParent(populations, pop.population_id, parentPid);
      popIds[bid] = pop.population_id;
    }
    // parentIdHierarchyProblems has refused cycles and missing parents, and a population beneath
    // a skipped one is skipped as soon as its parent is, so this always shrinks.
    if (next.length === waiting.length) break;
    waiting = next;
  }
  return populations;
}

/** Cytobank flat-boolean → population hierarchy (no <GatingHierarchy> present). */
/**
 * Gate-less populations carried across from FlowJo `<AndNode>`s: an intersection of other
 * populations. See WSP_DERIVED_TAG for why they ride in custom_info rather than as BooleanGates.
 */
function parseDerivedPopulations(root: Element): WspDerivedPopulation[] {
  for (const el of Array.from(root.children)) {
    if (el.localName !== "custom_info") continue;
    for (const info of Array.from(el.children)) {
      if (info.localName !== WSP_DERIVED_TAG) continue;
      try {
        const parsed = JSON.parse(info.textContent ?? "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return []; // a malformed block loses the intersections, never the tree
      }
    }
  }
  return [];
}

/**
 * The gates a FlowJo conversion lists as operands only (WSP_OPERAND_TAG): GateLab's own helpers,
 * imported for the intersections that name them, holding no population of their own.
 */
function parseOperandGates(root: Element): Set<string> {
  for (const el of Array.from(root.children)) {
    if (el.localName !== "custom_info") continue;
    for (const info of Array.from(el.children)) {
      if (info.localName !== WSP_OPERAND_TAG) continue;
      try {
        const parsed = JSON.parse(info.textContent ?? "[]");
        return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
      } catch {
        return new Set(); // a malformed list keeps the helpers as populations, as before
      }
    }
  }
  return new Set();
}

function buildPopulationsFromBooleans(
  rawGates: Record<string, RawGate>,
  boolOrder: string[],
  gmlToApp: Record<string, string>,
  appGates: Record<string, Gate>,
  gateOrder: string[],
  populations: PopulationMap,
  rootPopId: string,
  derived: WspDerivedPopulation[] = [],
  /** The tree a GateLab Cytobank-format file carries; when given, no parent is inferred. */
  tree: GatelabFormat["tree"] = null,
  skips?: PopulationSkips,
  /** Read the Boolean gates by Cytobank's model (see carriesCytobankInfo), not Gating-ML 2.0's. */
  cytobankModel = true,
  /** Gates that hold no population of their own (parseOperandGates), by gating:id. */
  operandGates: ReadonlySet<string> = new Set(),
): void {
  const boolNames: Record<string, string> = {};
  /**
   * Each Boolean gate's references to geometric gates, once per gate AND whether it is included: a
   * population that includes and excludes one gate, as the Cytobank format writes a population
   * excluding a gate its ancestry includes, holds no event, and kept once per gate it was read as
   * the inclusion alone.
   */
  const boolLits: Record<string, { rid: string; include: boolean }[]> = {};
  const boolPopIndices: Record<string, number[]> = {};
  const gsidToGml: Record<string, string> = {};
  /** A population's first gate that was not imported; see PopulationSkips. */
  const boolLost: Record<string, string> = {};

  for (const bid of boolOrder) {
    const g = rawGates[bid];
    if (!g || g.gate_type !== "boolean") continue;
    if (g.gate_set_id != null && Number.isFinite(g.gate_set_id)) gsidToGml[String(g.gate_set_id)] = bid;
  }

  for (const bid of boolOrder) {
    const g = rawGates[bid];
    if (!g || g.gate_type !== "boolean") continue;
    const lits: { rid: string; include: boolean }[] = [];
    const seen = new Set<string>();
    for (const r of g.refs ?? []) {
      const rid = r.gate_id;
      const include = g.operation === "not" ? r.complement : !r.complement;
      if (seen.has(`${rid}|${include}`)) continue;
      seen.add(`${rid}|${include}`);
      const rg = rawGates[rid];
      if (rg && rg.gate_type === "boolean") continue;
      if (!gmlToApp[rid]) {
        if (skips?.lostGates.has(rid) && !boolLost[bid]) boolLost[bid] = rid;
        continue;
      }
      lits.push({ rid, include });
    }
    boolNames[bid] = g.name;
    boolLits[bid] = lits;
    boolPopIndices[bid] = g.pop_parent_indices ?? [];
  }

  // GateLab's Cytobank format lists its populations in its tree mark, so a file of that format
  // with no Boolean gate has none, whatever geometric gates it carries: every population having
  // been left out (by a quadrant, or as a contradiction; CYTOBANK_OMITS_CONTRADICTIONS), each gate
  // was read as a population the user never had.
  if (!cytobankModel || (Object.keys(boolNames).length === 0 && !tree)) {
    // Standard Gating-ML 2.0 — and therefore FlowJo's export, FlowKit's and flowUtils' —
    // expresses ancestry as a parent_id attribute on each gate, and every gate, geometric or
    // Boolean, is a population. Without this every gate parents to root and each population is
    // measured against All Events, which silently inflates every child count. Until 2026-09 a
    // file with any BooleanGate was read by Cytobank's model instead, which ignores parent_id and
    // makes no population of a geometric gate: a FlowKit file with Cells, CD4, CD8 and their AND
    // came back as the AND alone, at the top level.
    //
    // Nodes are keyed by app gate id for a geometric gate and by gml id for a Boolean one.
    const nodeOf = (gml: string): string | undefined =>
      rawGates[gml]?.gate_type === "boolean" ? gml : gmlToApp[gml];
    const appToGml: Record<string, string> = {};
    for (const [gmlId, appId] of Object.entries(gmlToApp)) appToGml[appId] = gmlId;
    for (const bid of boolOrder) appToGml[bid] = bid;

    const parentAppOf = (gid: string): string | null => {
      const gmlId = appToGml[gid];
      const parentGml = gmlId ? rawGates[gmlId]?.parent_id : undefined;
      if (!parentGml) return null;
      const parentApp = nodeOf(parentGml);
      return parentApp && parentApp !== gid ? parentApp : null;
    };

    // Depth orders parents before children; the seen set makes a malformed
    // cycle terminate instead of hanging the import.
    const depthOf = (gid: string): number => {
      let d = 0;
      let cur: string | null = gid;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const parent: string | null = parentAppOf(cur);
        if (!parent) break;
        cur = parent;
        d++;
      }
      return d;
    };

    // The file's order, geometric and Boolean gates together, parents before children.
    const nodes = Object.keys(rawGates)
      .map((gml) => (rawGates[gml].gate_type === "boolean" ? gml : gateOrder.includes(gmlToApp[gml]) ? gmlToApp[gml] : undefined))
      .filter((n): n is string => n !== undefined);
    const ordered = nodes.sort((a, b) => depthOf(a) - depthOf(b));
    const gidToPid: Record<string, string> = {};
    for (const gid of ordered) gidToPid[gid] = uuid();

    /** A Boolean gate's ancestors, by gml id (gates and intersections). */
    const derivedParent = new Map(derived.map((d) => [d.id, d.parent ?? undefined]));
    const chainOf = (gml: string): Set<string> => {
      const out = new Set<string>();
      for (let p = rawGates[gml]?.parent_id; p && !out.has(p); p = rawGates[p]?.parent_id ?? derivedParent.get(p) ?? undefined) out.add(p);
      return out;
    };
    type Literal = { gml: string; include: boolean };
    /**
     * A reference as one AND of single gates, each included or excluded, or null when it is not
     * one (an OR, or the NOT of several gates), or the first gate it needs that was not imported.
     * `used` collects every gate it references, at every level, for the parent check below.
     */
    const reduce = (gml: string, complement: boolean, used: string[], depth = 0): Literal[] | { lost: string } | null => {
      const g = rawGates[gml];
      if (!g || depth > 64) return null;
      used.push(gml);
      if (g.gate_type !== "boolean") {
        if (skips?.lostGates.has(gml)) return { lost: gml };
        const app = gmlToApp[gml];
        if (!app || !appGates[app] || g.wsp_curly || g.wsp_complement) return null;
        return [{ gml, include: !complement }];
      }
      if (g.operation === "or") return null;
      const parts: Literal[] = [];
      for (const r of g.refs ?? []) {
        const inner = reduce(r.gate_id, r.complement, used, depth + 1);
        if (!Array.isArray(inner)) return inner;
        for (const l of inner) if (!parts.some((q) => q.gml === l.gml && q.include === l.include)) parts.push(l);
      }
      // NOT of one gate is that gate excluded; NOT of an AND of several is an OR.
      const negate = (g.operation === "not") !== complement;
      if (!negate) return parts;
      return parts.length === 1 ? [{ gml: parts[0].gml, include: !parts[0].include }] : null;
    };
    /**
     * A Boolean gate's population references, or null after naming why it is left out. A gate it
     * uses is that gate's events within the gate's own parent chain; within the Boolean's parent
     * that is the gate alone exactly when the gate's parent is the Boolean's parent or one of its
     * ancestors, which is the AND-with-NOT within a parent GateLab holds.
     */
    const booleanRefs = (bid: string): GateRef[] | null => {
      const g = rawGates[bid];
      if (g.operation === "or") { skips?.warnOr(g.name); return null; }
      const used: string[] = [];
      const lits = reduce(bid, false, used);
      if (lits && !Array.isArray(lits)) { skips?.warnLost(g.name, lits.lost); return null; }
      if (!lits || lits.length === 0) { skips?.warnNotAnd(g.name); return null; }
      const chain = chainOf(bid);
      for (const u of used.slice(1)) {
        const parent = rawGates[u]?.parent_id;
        if (parent && !chain.has(parent)) { skips?.warnOutside(g.name, u, parent); return null; }
      }
      return lits.map((l) => newGateRef(gmlToApp[l.gml], l.include));
    };

    // An intersection is a population with SEVERAL gate refs, which is what Population already
    // is, parented by the node it was written under so it is measured inside that parent. It has
    // an id of its own, and what FlowJo gated beneath it names that id as its parent. So gates and
    // intersections are placed in passes, each once what contains it exists: the root, a gate's
    // population, or an intersection's. A workspace with nothing beneath an intersection places
    // every gate in the first pass, in the order it always had, and every intersection after them.
    const derivedIds = new Set(derived.map((d) => d.id));
    const derivedPid: Record<string, string> = {};
    const placed = new Set<string>();
    /** The population to parent under, or undefined while that is still to be placed. */
    const containerOf = (parentGml: string | null | undefined, self: string | null): string | undefined => {
      if (parentGml && derivedIds.has(parentGml)) return derivedPid[parentGml];
      // Beneath a gate that was not imported: never placed, rather than moved to the top level,
      // where it would be measured against every event. The gate itself is named below.
      if (parentGml && skips?.lostGates.has(parentGml)) return undefined;
      const parentApp = parentGml ? nodeOf(parentGml) : undefined;
      if (!parentApp || parentApp === self || !gidToPid[parentApp]) return rootPopId;
      return placed.has(parentApp) ? gidToPid[parentApp] : undefined;
    };

    // Each gate here is its own population, so a gate that was not imported is a population
    // left out, with what the file places beneath it.
    for (const [gml] of skips?.lostGates ?? []) {
      if (rawGates[gml] && !rawGates[gml].wsp_curly && !operandGates.has(gml)) skips!.warnLost(rawGates[gml].name, gml);
    }
    let gatesLeft = ordered;
    let derivedLeft = derived;
    while (gatesLeft.length || derivedLeft.length) {
      const gatesWaiting: string[] = [];
      for (const gid of gatesLeft) {
        // A curly quadrant's shared gate has no population of its own; its four populations
        // are the derived ones that name its quadrants.
        if (rawGates[appToGml[gid]]?.wsp_curly) { placed.add(gid); continue; }
        // GateLab's own operand helper: its gate serves the intersections that name it.
        if (operandGates.has(appToGml[gid])) { placed.add(gid); continue; }
        const parentPid = containerOf(rawGates[appToGml[gid]]?.parent_id, gid);
        if (parentPid === undefined) { gatesWaiting.push(gid); continue; }
        const pid = gidToPid[gid];
        let pop: ReturnType<typeof newPopulation>;
        if (rawGates[gid]?.gate_type === "boolean") {
          // Left out, by name, when GateLab cannot hold it; what sits beneath it waits for a
          // parent that is never placed, and is left out with it.
          const refs = booleanRefs(gid);
          if (!refs) continue;
          pop = newPopulation(rawGates[gid].name, refs, parentPid, "and");
        } else {
          // A NotNode's population is the complement of its gate: the events OUTSIDE it.
          // Importing it as an ordinary reference would select precisely the events the user
          // excluded.
          const complement = rawGates[appToGml[gid]]?.wsp_complement === true;
          pop = newPopulation(appGates[gid].name, [newGateRef(gid, !complement)], parentPid);
        }
        pop.population_id = pid; // preserve the id used for parent links
        populations[pid] = pop;
        linkChildToParent(populations, pid, parentPid);
        placed.add(gid);
      }
      const derivedWaiting: WspDerivedPopulation[] = [];
      for (const d of derivedLeft) {
        const parentPid = containerOf(d.parent, null);
        if (parentPid === undefined) { derivedWaiting.push(d); continue; }
        const refs: GateRef[] = [];
        for (const r of d.refs ?? []) {
          const app = gmlToApp[r.gate];
          if (!app || !appGates[app]) {
            if (skips?.lostGates.has(r.gate)) skips.warnLost(d.name, r.gate);
            refs.length = 0;
            break;
          }
          refs.push(newGateRef(app, r.include, r.quadrant));
        }
        if (!refs.length) continue;
        const pop = newPopulation(d.name, refs, parentPid);
        populations[pop.population_id] = pop;
        linkChildToParent(populations, pop.population_id, parentPid);
        derivedPid[d.id] = pop.population_id;
      }
      // Whatever still waits sits beneath something that was never placed, and never will be.
      if (gatesWaiting.length === gatesLeft.length && derivedWaiting.length === derivedLeft.length) break;
      gatesLeft = gatesWaiting;
      derivedLeft = derivedWaiting;
    }
    return;
  }

  /** A reference as "gate|included", so an inclusion and an exclusion of one gate differ. */
  const literal = (l: { rid: string; include: boolean }): string => `${l.rid}|${l.include}`;
  const literals = (bid: string): string[] => (boolLits[bid] ?? []).map(literal);

  // Resolve each boolean gate's parent: from the tree GateLab wrote, or inferred for Cytobank's
  // own files, which carry none.
  const parents: Record<string, string | null> = {};
  if (tree) for (const { id, parent } of tree) parents[id] = parent;
  for (const bid of tree ? [] : Object.keys(boolNames)) {
    const pidx = boolPopIndices[bid] ?? [];
    let parentBid: string | null = null;
    for (const idx of pidx) {
      if (!Number.isFinite(idx) || idx < 1) continue;
      const cand = gsidToGml[String(idx)];
      if (cand && cand !== bid) {
        parentBid = cand;
        break;
      }
    }
    if (!parentBid && !rawGates[bid]?.explicit_root) {
      for (const idx of pidx) {
        if (!Number.isFinite(idx) || idx < 1 || idx > boolOrder.length) continue;
        const cand = boolOrder[idx - 1];
        if (cand && cand !== bid) {
          parentBid = cand;
          break;
        }
      }
    }
    if (!parentBid && !rawGates[bid]?.explicit_root) {
      // The parent is the largest other population whose references are a strict subset of this
      // one's, compared as (gate, included or excluded). Compared by gate alone, "NOT A AND NOT B"
      // went under the population that INCLUDES A, and what it kept of its own references was
      // then "NOT B" there: on the public PBMC file 38,835 events moved, and a CyTOF "B not T"
      // went under T and emptied (385 events to 0 on Bodenmiller patient 1).
      const mySet = literals(bid);
      let best: string | null = null;
      let bestSize = -1;
      for (const oid of Object.keys(boolNames)) {
        // A population left out cannot hold another; in a flattened chain, what it would hold
        // needs the same missing gate and is left out too.
        if (oid === bid || boolLost[oid] || rawGates[oid]?.operation === "or") continue;
        const oset = literals(oid);
        if (oset.length === 0) continue;
        if (oset.every((x) => mySet.includes(x)) && oset.length < mySet.length && oset.length > bestSize) {
          best = oid;
          bestSize = oset.length;
        }
      }
      parentBid = best;
    }
    parents[bid] = parentBid;
  }

  const depth = (bid: string): number => {
    let d = 0;
    let cur: string | null = bid;
    const seen = new Set<string>();
    while (cur && parents[cur] && !seen.has(cur)) {
      seen.add(cur);
      cur = parents[cur];
      d++;
    }
    return d;
  };

  // The tree lists parents first and siblings in GateLab's order, which is the order to place them.
  const orderedBids = tree
    ? tree.map((t) => t.id).filter((id) => boolNames[id] !== undefined)
    : Object.keys(boolNames).sort((a, b) => depth(a) - depth(b));
  const bidToPid: Record<string, string> = {};
  for (const bid of orderedBids) bidToPid[bid] = uuid();

  /** Populations not placed; whatever sits beneath one is not placed either. */
  const unplaced = new Set<string>();
  for (const bid of orderedBids) {
    const pid = bidToPid[bid];
    const parentBid = parents[bid];
    if (parentBid && unplaced.has(parentBid)) { unplaced.add(bid); continue; }
    if (boolLost[bid]) {
      skips?.warnLost(boolNames[bid] ?? bid, boolLost[bid]);
      unplaced.add(bid);
      continue;
    }
    if (rawGates[bid]?.operation === "or") {
      skips?.warnOr(boolNames[bid] ?? bid);
      unplaced.add(bid);
      continue;
    }
    const parentPid = parentBid ? bidToPid[parentBid] ?? rootPopId : rootPopId;

    // What this population adds to its parent, as (gate, included or excluded): a gate the
    // parent includes and this population excludes is this population's own reference.
    const parentLits = parentBid ? literals(parentBid) : [];
    const incr = (boolLits[bid] ?? []).filter((l) => !parentLits.includes(literal(l)));

    const refsOf = (lits: { rid: string; include: boolean }[]): GateRef[] => {
      const out: GateRef[] = [];
      for (const l of lits) {
        const appId = gmlToApp[l.rid];
        if (!appId || appId === l.rid) continue;
        out.push(newGateRef(appId, l.include));
      }
      return out;
    };
    // A population whose gates all repeat its parent's adds nothing to it: it is its parent's
    // events. It keeps its own gates, which within its parent select exactly those. It was left
    // out with everything beneath it until 2026-09, silently, and what sat beneath it was left in
    // the map under a parent that did not exist.
    let refs = refsOf(incr);
    if (refs.length === 0) refs = refsOf(boolLits[bid] ?? []);
    if (refs.length === 0) {
      skips?.warnNoGates(boolNames[bid] ?? bid);
      unplaced.add(bid);
      continue;
    }

    const pop = newPopulation(boolNames[bid] ?? "Population", refs, parentPid, "and");
    pop.population_id = pid; // preserve the id used for parent links
    populations[pid] = pop;
    linkChildToParent(populations, pid, parentPid);
  }
}
