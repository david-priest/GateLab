/**
 * Read gates directly from a FlowJo workspace (`.wsp`).
 *
 * FlowJo stores its gates as embedded ISAC Gating-ML: every gate element in a workspace is
 * `gating:PolygonGate` with `gating:vertex` / `data-type:value` children, in the same
 * namespaces GateLab already parses. Measured on a real 24-sample workspace, the vertices are
 * byte-identical to the ones FlowJo writes into its own Gating-ML export, and they are in raw
 * linear coordinates — the space gates are evaluated in — so nothing has to be un-transformed.
 *
 * What the workspace has that the export does not is population NAMES, the hierarchy, and
 * FlowJo's own event counts. FlowJo's Gating-ML export omits `gating:name` entirely, so an
 * imported strategy rebuilds as `ID1394212032` and cannot be read as a gating figure. That gap
 * is the only reason a separate name-recovery step ever existed.
 *
 * So this module does not re-implement gating: it rewrites the workspace's own gate elements
 * into a standard Gating-ML document, adding the `gating:name` and `gating:parent_id` that the
 * hierarchy implies, and hands that to `importGatingML`. Channel resolution, validation,
 * population building and the merge/replace flow are unchanged.
 *
 * Gate ids are used only within one parse. FlowJo reassigns them whenever a workspace is
 * saved — a workspace re-saved minutes after an export no longer shared a single id with it —
 * so nothing durable may be keyed on them.
 */

import { fcsDataSetLabelToken, parseFcsDataSetFileName, type SpilloverMatrix } from "./fcs";
import { FLOWJO_CURLY_QUAD_CURL, type FlowJoGridAxis, type QuadrantCurl, type RectangleBounds, type TransformSpec, type Vertex } from "./models";
import { WSP_RECTANGLE_ATTR, WSP_WRITING, parseRectangleRecord, statesRecord, writtenBound, type RectangleRecord } from "./rectangleRecord";
import { WSP_POLYGON_ATTR, parsePolygonRecord, type PolygonRecord } from "./polygonRecord";
import { transformFromSpec } from "./sample";
import { invertMatrix } from "./compensation";
import { withinLogicleBound } from "./transforms";
import { FLOWJO_BIEX_TABLE_CHANNELS, biexBreakpoints, biexTransform } from "./biex";
import { FLOWJO_GATE_RESOLUTION, flowJoGridScale, logVertexAtZeroOnFloor, parseFlowJoGridAxis, type FlowJoGridSpec } from "./flowjoGrid";
import {
  compareIdentity,
  identityKeywords,
  pairFile,
  sameFileName,
  verdictRank,
  type FilePairing,
  type IdentityComparison,
  type IdentityDifference,
  type RecordedIdentity,
} from "./fileIdentity";
import { GATELAB_FORMAT_TAG } from "./gatingmlExport";

/** Marker the converter writes and importGatingML reads back. Internal to that handoff. */
export const WSP_GATE_SPACE_TAG = "gatelab_gate_space";
/** Marks a population defined as the COMPLEMENT of its gate (FlowJo's <NotNode>). */
export const WSP_COMPLEMENT_TAG = "gatelab_population_complement";

/**
 * Marks a rectangle imported from a FlowJo workspace. It is evaluated with both edges in
 * (models.ts, RectangleBounds), not half-open as Gating-ML 2.0 defines a rectangle.
 *
 * FlowJo documents no edge rule, and an imported FlowJo gate is judged by whether it reproduces
 * the counts FlowJo recorded. Over the public FlowRepository corpus (455 workspaces with a
 * retrieved file, measured 2026-09-24), making FlowJo's rectangles half-open would change the
 * count of 66 populations in 33 workspaces of 24 deposits, and FlowJo's own counts side with the
 * closed rule. Of the 27 whose parent GateLab counts exactly as FlowJo does, 15 are top-level
 * populations, whose parent is the whole file; over all 27, FlowJo's count equals the closed
 * count in 14 and the half-open one in 1, and is nearer the closed one in 24. Of the 12 below
 * another population, it equals the closed count in 9 and the half-open one in none, and is
 * nearer the closed one in all 12. Summed over all 66, the counts differ from FlowJo's by 3,309
 * events closed and 44,296 half-open.
 *
 * Every one of those rectangles reaches the top of a biex axis. GateLab's biex table puts the
 * events at the top of such an axis, and every one beyond it, exactly on the top channel, which
 * is the rectangle's upper edge; FlowJo draws the same events piled on the axis limit and mostly
 * counts them in. No FlowJo rectangle in the corpus, or in the concordance datasets, has an
 * event on an upper edge anywhere else, so FlowJo's rule away from an axis limit is unmeasured.
 */
export const WSP_RECT_BOUNDS_TAG = "gatelab_rectangle_bounds";

/**
 * The FlowJo axes of a rectangle imported under FlowJo's rule (PolyRectGate.flowjo_axes), as
 * `{"x": axis | null, "y": axis | null}`: the rule compares it in raw units, so the axes it was
 * saved on ride here for the FlowJo export to declare again. `"opened"`, where the rule opened a
 * bound, holds FlowJo's own [min, max] per dimension, null for a bound left as it was
 * (PolyRectGate.flowjo_bounds).
 */
export const WSP_FLOWJO_AXES_TAG = "gatelab_flowjo_axes";

/**
 * A FlowJo polygon evaluated continuously whose own attributes are not an ordinary polygon's
 * (quadId -1, gateResolution 256): a quadrant panel's quadId, a missing or other gateResolution,
 * as `{"quadId": n, "gateResolution": n | null}` (PolyRectGate.flowjo_polygon). The FlowJo export
 * writes them back, so neither FlowJo nor an import puts the polygon on a grid it was not on.
 */
export const WSP_FLOWJO_POLYGON_TAG = "gatelab_flowjo_polygon";

/**
 * Populations that are an intersection of OTHER populations rather than a gate of their own.
 *
 * FlowJo's `<AndNode>` carries no `<Gate>`: it names its operands by path in `<Dependents>`, and
 * its population is their intersection within its parent. GateLab's Population already IS an
 * intersection -- `gate_refs` with an include flag each -- so the two models line up exactly, and
 * the only thing missing is a way to carry a gate-less population through a document whose every
 * other population is keyed by a gate.
 *
 * It rides in one top-level `data-type:custom_info` rather than as `<gating:BooleanGate>`
 * elements. Until 2026-09 a document containing BooleanGates was read as a Cytobank flat-Boolean
 * export, where populations are built from the Boolean gates ALONE -- which discards every
 * ordinary population of a FlowJo tree. That was tried; it collapsed a 34-gate strategy to two
 * populations. Only a file carrying Cytobank's custom_info is read that way now.
 *
 * Each intersection carries an id of its own, and whatever FlowJo gated beneath it names that id
 * as its parent -- a gate as its ordinary `parent_id` attribute, a nested intersection as its
 * `parent` here. The importer accepts those ids as parents because this block declares them.
 */
export const WSP_DERIVED_TAG = "gatelab_derived_populations";

/**
 * The attribute GateLab's FlowJo export writes ("1") on a population it adds only as an operand of
 * an intersection or a complement: an AndNode names its operands by path, so a gate no population
 * holds alone is written as a population of its own beside the node (flowjoExport.ts,
 * emitPopulation), as FlowJo's own tool writes one. Read back, each was a population GateLab never
 * had: "NK cells (2)" and "CD14 low" on the public PBMC bundle, 10 per file on the Bodenmiller one.
 */
export const WSP_OPERAND_ATTR = "gatelabOperand";
/**
 * What GateLab's FlowJo export writes for a "/" in the name of a helper it adds (WSP_OPERAND_ATTR):
 * U+2215, a division slash, drawn as "/". A helper is named after its gate, and an AndNode or a
 * NotNode names it by its path, "/" between the names, so a helper for a gate named "B cells:
 * CD20+/CD3-low" put two names into that path where there is one; a reader that splits the path
 * found no "CD3-low" and refused the whole file (FlowKit 1.3.1 on the public Bodenmiller bundle's
 * export: "Gate name CD3-low was not found in gating strategy"; 0.8.3 the same). GateLab resolves
 * a path by its whole text, and reads the character back as "/" in a helper's gate name, so the
 * gate keeps its name.
 */
export const WSP_OPERAND_SLASH = "\u2215";
/**
 * The converter's list of gates that are operands only (WSP_OPERAND_ATTR), by gating:id: the gate
 * is imported, for the intersections that name it, and holds no population of its own.
 */
export const WSP_OPERAND_TAG = "gatelab_operand_gates";

/**
 * The attribute GateLab's FlowJo export writes ("1") on a SampleNode: its top-level populations are
 * one GateLab tree, not FlowJo's independent trees. A GateLab tree may hold several populations at
 * its root, and every AndNode among them has its operands' helpers beside it (WSP_OPERAND_ATTR), so
 * the file has several top-level elements. Read as FlowJo's trees, one per top-level element, the
 * export reopened as up to one tree per population and helper ("20 gates · 15 trees" on the public
 * Bodenmiller bundle), and a single-file open imports one tree: an intersection at the root was
 * refused for its operand being "in another of this sample's trees", and nothing brought the tree
 * back. FlowJo's own workspaces never carry it; a workspace FlowJo re-saved without it reads as
 * FlowJo's trees again.
 */
export const WSP_ONE_TREE_ATTR = "gatelabTree";

/**
 * The field the FlowJo converter adds to its document's GateLab mark (markConverterDocument), with
 * the value "compensated": every dimension of the document that declares "FCS" is a parameter
 * FlowJo drew on compensated values (`Comp-FL1-A`), which exists in FlowJo only under a matrix.
 * Gating-ML's "FCS" asks for the FCS file's own compensation, which may be none, and the ISAC
 * suite, FlowKit and GateLab (resolveGatingMLCompensation, fcsHasSpillover) then evaluate the gate
 * on the stored values. A document carrying this field is refused instead when the matrix the
 * import applies (GatingMLImportOptions.matrixChannels) does not cover such a dimension's channel.
 * Until 2026-09-26 the converter relied on "FCS" with no matrix being refused, which since 2026-09
 * it was not where the FCS file declares no compensation of its own.
 */
export const COMPENSATED_FCS_MARK = "fcs";

/**
 * Mark a document a converter wrote (FlowJo, FACSDiva, FACSChorus) as GateLab's, holding Time as
 * the FCS stores it. Each converter writes Time in the FCS file's ticks: FlowJo's Time is divided
 * by the scale the workspace declares on the way in (sampleTimeScale). Gating-ML says no unit, and importGatingML
 * reads an unmarked file from another tool in seconds, as FlowKit and FlowJo do (gatingml.ts
 * timeUnitOf), so without this a Time gate would be divided by the timestep twice.
 */
export function markConverterDocument(doc: Document, opts: { fcsCompensated?: boolean } = {}): void {
  const info = doc.createElementNS(DATATYPE_NS, "data-type:custom_info");
  const tag = doc.createElementNS(DATATYPE_NS, `data-type:${GATELAB_FORMAT_TAG}`);
  tag.textContent = JSON.stringify({
    version: 3, time: "ticks", ...(opts.fcsCompensated ? { [COMPENSATED_FCS_MARK]: "compensated" } : {}),
  });
  info.appendChild(tag);
  // First, where importGatingML looks for the mark.
  doc.documentElement.insertBefore(info, doc.documentElement.firstChild);
}

/** One `<AndNode>`: an intersection of gates, each included or excluded. */
export interface WspDerivedPopulation {
  /** Its own id, which what FlowJo gated beneath the intersection names as its parent. */
  id: string;
  name: string;
  /** Gate or intersection whose population contains this one, or null at the top level. */
  parent: string | null;
  /** `quadrant` selects one quadrant (1–4) of a quadrant gate; absent for an ordinary gate. */
  refs: Array<{ gate: string; include: boolean; quadrant?: number }>;
}

/**
 * Marks a rectangle that stands for a whole curly quadrant gate: its two minima are the
 * crosshair, and the four FlowJo populations that share that crosshair are written as derived
 * populations naming one quadrant each. Carries the bend to give the arms, or null when the
 * axes' display could not be carried and the crosshair imports straight.
 */
export const WSP_CURLY_TAG = "gatelab_curly_quadrant";

const GATING_NS = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const DATATYPE_NS = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const TRANSFORMS_NS = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";

/**
 * The prefix FlowJo uses for a compensated parameter when a workspace does not name its own.
 * Only used to recognise that a dimension *looks* compensated while no matrix could be read,
 * which has to be reported rather than guessed at.
 */
const CONVENTIONAL_COMP_PREFIX = "Comp-";

/** Gate elements this importer can carry across. Anything else is reported, never dropped. */
const SUPPORTED_GATE_LOCAL_NAMES = new Set([
  "PolygonGate", "RectangleGate", "EllipsoidGate", "CurlyQuad",
]);

/**
 * How many display channels FlowJo divides an axis into.
 *
 * Not a guess: every `biex` transform in a 433-workspace corpus declares `length="256"`
 * (463,325 of them, no other value), and an ellipsoid on a linear axis reproduces FlowJo's own
 * event membership only at `maxRange/256` — every other scale selects essentially nothing.
 */
const FLOWJO_DISPLAY_CHANNELS = 256;

/** One independent gating tree within a sample. GateLab holds exactly one at a time. */
export interface FlowJoTreeSummary {
  /** Position among the sample's top-level populations; how a tree is selected. */
  index: number;
  /** The root population's name, which is what a user recognises the strategy by. */
  name: string;
  /** Events FlowJo recorded for the root, or null when absent. */
  rootCount: number | null;
  /** Gates in this tree that this importer can read. */
  gateCount: number;
  /** Gates it cannot; they and their descendants are skipped. */
  unsupportedCount: number;
  /** Population names in this tree, depth-first, so a picker can show the shape. */
  populations: string[];
}

export interface FlowJoSampleSummary {
  /**
   * Position in the workspace. Selection is by index, never by name: FlowJo allows the same
   * file to be added twice, and resolving a duplicate name by taking the first match would
   * import another sample's gates without saying so.
   */
  index: number;
  /** `SampleNode@name`, normally the FCS file name. */
  name: string;
  /** FlowJo group this sample is analysed under, for telling near-identical names apart. */
  owningGroup: string;
  /** Another sample in this workspace carries the same name. */
  duplicateName: boolean;
  /** Independent top-level trees. More than one means parallel strategies in one sample. */
  rootCount: number;
  /**
   * File names this sample may be stored under, best first.
   *
   * The `DataSet` URI's basename is the name the file actually had when FlowJo saw it, and is
   * the only one of the three that is reliably the on-disk name: a FACSDiva export names its
   * SampleNode after the acquisition's `$FIL` (`19319.fcs`) while the file is called something
   * else entirely. Older workspaces may carry no `$FIL` at all.
   */
  candidateFileNames: string[];
  /** The independent gating trees, for choosing one. */
  trees: FlowJoTreeSummary[];
  /** `SampleNode@count` — the events FlowJo had for the sample, or null when absent. */
  eventCount: number | null;
  /**
   * The well or specimen the sample's own keywords name ($WELLID, else $SMNO), or null. It tells
   * apart the samples a workspace holds for the data sets of one multi-data-set file, which all
   * carry that file's name (flowJoSampleNamesFile).
   */
  dataSetLabel?: string | null;
  /** Populations carrying a gate this importer understands. */
  gateCount: number;
  /** Populations whose gate type is not supported; they and their descendants are skipped. */
  unsupportedCount: number;
  /**
   * What FlowJo recorded about the acquisition ($TOT, $DATE, $BTIM, $ETIM, GUID), copied from the
   * file's TEXT segment into the sample's <Keywords>. A name only nominates a sample; these decide
   * whether a file is it (fileIdentity.ts). Empty, or absent, for a sample that records none.
   */
  recorded?: RecordedIdentity;
}

/**
 * A compensation matrix carried by the workspace rather than by the FCS.
 *
 * BD FACSDiva exports frequently have no `$SPILLOVER` at all: the matrix lives only in the
 * workspace, and FlowJo shows the compensated parameters under a prefix (`Comp-BV786-A`). Gates
 * drawn on those parameters cannot be evaluated without it.
 */
export interface FlowJoSpillover {
  /** FlowJo's name for the matrix, e.g. "DivaCompMtx_19319.fcs". */
  name: string;
  /** Prefix marking a compensated parameter; normally "Comp-", but the workspace decides. */
  prefix: string;
  suffix: string;
  /** Same shape and orientation as an FCS $SPILLOVER: row = source parameter, diagonal 1. */
  matrix: SpilloverMatrix;
}

export interface FlowJoConversion {
  /** A standard Gating-ML 2.0 document, ready for importGatingML. */
  gatingMl: string;
  sampleName: string;
  /** FlowJo's own event count per population name, for a concordance readout. */
  flowJoCounts: Record<string, number>;
  /** Anything skipped or altered, in the order encountered. Never silently discarded. */
  warnings: string[];
  /**
   * The matrix this sample's gates were drawn under, when the workspace carries one. Null when
   * the sample is uncompensated *or* when no matrix could be read; the two are distinguished by
   * whether `warnings` mentions unresolved compensated dimensions.
   */
  spillover: FlowJoSpillover | null;
  /** Polygons put on FlowJo's gate grid (flowjoGrid.ts); 0 with the option off. */
  gridPolygons: number;
  /**
   * Polygons GateLab wrote into the workspace and restored as it held them (polygonRecord.ts),
   * continuous whatever the option says.
   */
  gateLabPolygons: number;
}

/**
 * How the import evaluates FlowJo's gates.
 *
 * `flowJoGrid` (default true) is the open dialog's "Evaluate gates as FlowJo does": polygons on
 * FlowJo's 256-channel grid (flowjoGrid.ts), rectangles in raw units with FlowJo's axis rules --
 * a linear bound at or beyond its axis's range left open, a biex lower bound at or below the
 * bottom of FlowJo's table or a log one at or below the offset left open, and nothing pinned at
 * a biex axis's top. Off, every gate is
 * evaluated continuously on its drawn geometry, as FlowKit and Cytobank evaluate it: polygons and
 * rectangles as straight lines in the display FlowJo declares. FlowJo's corrected biex table
 * (biex.ts) is used either way. Ellipses, curly quadrants and gates on a Time axis or a linear
 * axis with a gain other than 1 are continuous in both, because no FlowJo rule for them has been
 * established.
 */
export interface FlowJoImportOptions {
  flowJoGrid?: boolean;
  /**
   * How the notes this importer writes about FlowJo's grid and rectangle rule are worded: given
   * the English template and its values, the text to show. The app passes its translation, so the
   * notes are in the language it is in; absent, they are in English.
   */
  translate?: NoteTranslator;
}

/** A note's text from its English template, with `{name}` placeholders, and their values. */
export type NoteTranslator = (source: string, values?: Readonly<Record<string, string | number>>) => string;

/** The template in English, its placeholders filled in. */
const inEnglish: NoteTranslator = (source, values = {}) =>
  source.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);

/**
 * Direct children with this local name.
 *
 * Walks siblings rather than materialising `node.children`: that is a live HTMLCollection which
 * indexes in linear time, so `Array.from` over it is quadratic. It never mattered while the only
 * callers were Subpopulations and Population lists of a handful of elements, but a `<Keywords>`
 * block holds thousands, and reading one keyword per sample took a 24-sample workspace from 2s
 * to 25s.
 */
function childrenByLocalName(node: Element, localName: string): Element[] {
  const out: Element[] = [];
  for (let c = node.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === localName) out.push(c);
  }
  return out;
}


/**
 * Which display transform the workspace declares for each parameter.
 *
 * FlowJo evaluates a gate as straight lines in the space the axis is CURRENTLY displayed in, and
 * the `<Transformations>` block is that display declaration — keyed by parameter name, never
 * referenced by the gates themselves. So the space a FlowJo gate is straight in is whatever this
 * block says for its two axes.
 */
function workspaceTransformKinds(node: Element): Map<string, string> {
  const out = new Map<string, string>();
  const block = transformsBlockFor(node);
  if (!block) return out;
  for (let el = block.firstElementChild; el; el = el.nextElementSibling) {
    for (const p of childrenByLocalName(el, "parameter")) {
      const name = p.getAttributeNS(DATATYPE_NS, "name") ?? p.getAttribute("data-type:name");
      if (name) out.set(name, el.localName);
    }
  }
  return out;
}


/** The two axis parameter names of a gate element, in dimension order (x, y). */
function gateAxisNames(el: Element): [string, string] | null {
  const names = dimensionNames(el);
  return names.length >= 2 ? [names[0], names[1]] : null;
}

/**
 * Every dimension's parameter name, in document order. Walked element by element rather than over
 * getElementsByTagName("*"), a live collection that jsdom (the test suite's and the interoperability
 * tester's document) walks again for every element taken from it: a workspace holding one polygon
 * of 8,000 vertices took 16 s to read there, and takes 1.1 s so.
 */
function dimensionNames(el: Element): string[] {
  const names: string[] = [];
  const walk = (node: Element): void => {
    for (let d = node.firstElementChild; d; d = d.nextElementSibling) {
      if (d.localName === "fcs-dimension") {
        const n = d.getAttributeNS(DATATYPE_NS, "name") ?? d.getAttribute("data-type:name");
        if (n) names.push(n);
      }
      walk(d);
    }
  };
  walk(el);
  return names;
}

/**
 * Rewrite a gate's coordinates from FlowJo's raw storage into the space FlowJo evaluates it in.
 *
 * FlowJo stores vertices raw but applies the gate as straight lines in the axis's DISPLAY space,
 * so reproducing it means forward-transforming the vertices and marking the gate as living there.
 * Both gate kinds are covered: a polygon's vertex coordinates, and a rectangle's min/max, which
 * stay a valid axis-aligned box because the transforms are monotonic.
 */
function applyForwardTransform(el: Element, fx: (v: number) => number, fy: (v: number) => number): void {
  const dims: Element[] = [];
  for (const d of el.getElementsByTagName("*")) if (d.localName === "dimension") dims.push(d);
  dims.forEach((d, i) => {
    const f = i === 0 ? fx : fy;
    for (const attr of ["min", "max"] as const) {
      const raw = d.getAttributeNS(GATING_NS, attr) ?? d.getAttribute(`gating:${attr}`);
      if (raw === null || raw === "") continue;
      const v = Number(raw);
      if (Number.isFinite(v)) d.setAttributeNS(GATING_NS, `gating:${attr}`, String(f(v)));
    }
  });
  for (const v of el.getElementsByTagName("*")) {
    if (v.localName !== "vertex") continue;
    const coords: Element[] = [];
    for (let c = v.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName === "coordinate") coords.push(c);
    }
    coords.forEach((c, i) => {
      const raw = c.getAttributeNS(DATATYPE_NS, "value") ?? c.getAttribute("data-type:value");
      const n = Number(raw);
      if (Number.isFinite(n)) c.setAttributeNS(DATATYPE_NS, "data-type:value", String((i === 0 ? fx : fy)(n)));
    });
  }
}

/**
 * Record the gate's space on the element for importGatingML to read back.
 *
 * Keyed by AXIS POSITION rather than channel name: the importer resolves dimension names to
 * session channels, so a name written here would have to survive a mapping this module cannot
 * see. x/y always survive it, because dimension order is what defines them.
 */
function writeGateSpace(doc: Document, el: Element, x: TransformSpec, y: TransformSpec, raw?: Vertex[]): void {
  const info = doc.createElementNS(DATATYPE_NS, "data-type:custom_info");
  const tag = doc.createElementNS(DATATYPE_NS, WSP_GATE_SPACE_TAG);
  // `raw` rides along for a grid polygon: the vertices as FlowJo saved them (PolyRectGate.flowjo_vertices).
  tag.textContent = JSON.stringify(raw ? { space: "display", x, y, raw } : { space: "display", x, y });
  info.appendChild(tag);
  el.insertBefore(info, el.firstChild);
}

/**
 * Mark a gate whose POPULATION is the complement of it.
 *
 * Written into the same data-type:custom_info the gate space uses, so the document stays in the
 * flat parent_id form the importer already builds a population per gate from. Emitting a
 * Gating-ML BooleanGate instead looked more faithful and was a trap: until 2026-09 a document
 * carrying one was read as a Cytobank flat-Boolean export, where populations come from the
 * BooleanGates alone, and the thirty-six ordinary populations of a FlowJo tree disappeared.
 */
function writeComplementMark(doc: Document, el: Element): void {
  const info = doc.createElementNS(DATATYPE_NS, "data-type:custom_info");
  const tag = doc.createElementNS(DATATYPE_NS, WSP_COMPLEMENT_TAG);
  tag.textContent = "true";
  info.appendChild(tag);
  el.insertBefore(info, el.firstChild);
}

/**
 * Mark a rectangle with the edge rule it is evaluated under; see WSP_RECT_BOUNDS_TAG. Exported
 * for the FACSDiva and FACSChorus converters, which hand their rectangles over the same way.
 */
export function writeRectBoundsMark(doc: Document, el: Element, bounds: RectangleBounds = "closed"): void {
  const info = doc.createElementNS(DATATYPE_NS, "data-type:custom_info");
  const tag = doc.createElementNS(DATATYPE_NS, WSP_RECT_BOUNDS_TAG);
  tag.textContent = bounds;
  info.appendChild(tag);
  el.insertBefore(info, el.firstChild);
}

/**
 * GateLab's record of a rectangle it wrote into this workspace (rectangleRecord.ts), when the
 * gate's bounds are still exactly the ones GateLab wrote and are, in raw values, the record's own
 * (`step` is each axis's file-to-raw factor, FlowJo's Time seconds). A workspace FlowJo has saved
 * since, or a gate moved there, reads as FlowJo's own.
 */
function gateLabRectangleRecord(el: Element, step: [number, number]): RectangleRecord | null {
  const attr = el.getAttribute(WSP_RECTANGLE_ATTR);
  if (!attr) return null;
  let rec: RectangleRecord | null;
  try {
    rec = parseRectangleRecord(JSON.parse(attr));
  } catch {
    return null;
  }
  if (!rec?.written) return null;
  const dims = childrenByLocalName(el, "dimension");
  const written = dims.map((d) => writtenBound(
    d.getAttributeNS(GATING_NS, "min") ?? d.getAttribute("gating:min"),
    d.getAttributeNS(GATING_NS, "max") ?? d.getAttribute("gating:max"),
  ));
  if (written.length !== rec.written.length || !written.every((w, i) => w === rec!.written![i])) return null;
  const raw = (d: Element | undefined, i: number): [number | null, number | null] => {
    if (!d) return [null, null];
    const v = (attr: string) => {
      const t = d.getAttributeNS(GATING_NS, attr) ?? d.getAttribute(`gating:${attr}`);
      return t === null || t === "" ? null : Number(t) / step[i];
    };
    return [v("min"), v("max")];
  };
  // Where the exporter placed a bound among the file's own events (flowjoExport.ts, onGateLabSide),
  // the geometry is checked as it was before, which the record keeps, as a Gating-ML record's is
  // (rectangleRecord.ts, placedFrom); the file must still state exactly what was written (above).
  const before = (text: string | undefined, i: number): [number | null, number | null] => {
    const [min, max] = (text ?? "|").split("|");
    return [min === "" ? null : Number(min) / step[i], max === "" ? null : Number(max) / step[i]];
  };
  const [fx, fy] = rec.placedFrom
    ? [before(rec.placedFrom[0], 0), before(rec.placedFrom[1] ?? rec.placedFrom[0], 1)]
    : [raw(dims[0], 0), raw(dims[1] ?? dims[0], 1)];
  return statesRecord(rec, fx, fy, WSP_WRITING) ? rec : null;
}

/**
 * Put a GateLab rectangle back as GateLab held it: its own bounds, exactly, in its own space,
 * under its own rule, in place of the raw bounds FlowJo reads and the display they were moved to.
 */
function restoreGateLabRectangle(doc: Document, copy: Element, rec: RectangleRecord): void {
  for (const info of childrenByLocalName(copy, "custom_info")) {
    if (childrenByLocalName(info, WSP_GATE_SPACE_TAG).length) copy.removeChild(info);
  }
  childrenByLocalName(copy, "dimension").forEach((d, i) => {
    const [lo, hi] = i === 0 ? rec.x : rec.y;
    d.setAttributeNS(GATING_NS, "gating:min", String(lo));
    d.setAttributeNS(GATING_NS, "gating:max", String(hi));
  });
  if (rec.space === "display" && rec.transforms) writeGateSpace(doc, copy, rec.transforms.x, rec.transforms.y);
  writeRectBoundsMark(doc, copy, rec.bounds);
}

/**
 * GateLab's record of a polygon it evaluates continuously and wrote into this workspace
 * (polygonRecord.ts), while the element's coordinates are still exactly the ones GateLab wrote. A
 * workspace FlowJo has saved since, or a polygon moved there, reads as FlowJo's own.
 */
function gateLabPolygonRecord(el: Element): PolygonRecord | null {
  const attr = el.getAttribute(WSP_POLYGON_ATTR);
  if (!attr) return null;
  let rec: PolygonRecord | null;
  try {
    rec = parsePolygonRecord(JSON.parse(attr));
  } catch {
    return null;
  }
  if (!rec) return null;
  const stated: string[] = [];
  for (const v of childrenByLocalName(el, "vertex")) {
    for (const c of childrenByLocalName(v, "coordinate")) {
      stated.push(c.getAttributeNS(DATATYPE_NS, "value") ?? c.getAttribute("data-type:value") ?? "");
    }
  }
  return stated.length === rec.written.length && stated.every((w, i) => w === rec!.written[i]) ? rec : null;
}

/**
 * Put a GateLab polygon back as GateLab held it: its own vertices, exactly, in its own space, never
 * on FlowJo's grid, in place of the raw vertices FlowJo reads.
 */
function restoreGateLabPolygon(doc: Document, copy: Element, rec: PolygonRecord): void {
  for (const info of childrenByLocalName(copy, "custom_info")) {
    if (childrenByLocalName(info, WSP_GATE_SPACE_TAG).length) copy.removeChild(info);
  }
  // The file may hold more vertices than GateLab's polygon: an edge straight in GateLab's space
  // and not in the declared one was written as a traced curve.
  for (const v of childrenByLocalName(copy, "vertex")) copy.removeChild(v);
  for (const [x, y] of rec.vertices) {
    const vertex = doc.createElementNS(GATING_NS, "gating:vertex");
    for (const value of [x, y]) {
      const c = doc.createElementNS(GATING_NS, "gating:coordinate");
      c.setAttributeNS(DATATYPE_NS, "data-type:value", String(value));
      vertex.appendChild(c);
    }
    copy.appendChild(vertex);
  }
  if (rec.space === "display" && rec.transforms) writeGateSpace(doc, copy, rec.transforms.x, rec.transforms.y);
}

/**
 * Record a rule-imported rectangle's FlowJo axes on the element, and the bounds FlowJo saved where
 * the rule opened one (`opened`, per dimension in document order, null for a bound left as it
 * was); see WSP_FLOWJO_AXES_TAG.
 */
function writeFlowJoAxes(
  doc: Document, el: Element, x: FlowJoGridAxis | null, y: FlowJoGridAxis | null,
  opened: [number | null, number | null][] | null = null,
): void {
  const info = doc.createElementNS(DATATYPE_NS, "data-type:custom_info");
  const tag = doc.createElementNS(DATATYPE_NS, WSP_FLOWJO_AXES_TAG);
  tag.textContent = JSON.stringify(opened ? { x, y, opened } : { x, y });
  info.appendChild(tag);
  el.insertBefore(info, el.firstChild);
}

/**
 * Record a continuous FlowJo polygon's own quadId and gateResolution where they are not an
 * ordinary polygon's; see WSP_FLOWJO_POLYGON_TAG.
 */
function writeFlowJoPolygonAttributes(doc: Document, copy: Element, el: Element): void {
  const quadText = el.getAttribute("quadId");
  const quadId = quadText === null || quadText === "" ? -1 : Number(quadText);
  const resText = el.getAttribute("gateResolution");
  const gateResolution = resText === null || resText === "" ? null : Number(resText);
  if (!Number.isInteger(quadId) || (gateResolution !== null && !Number.isInteger(gateResolution))) return;
  if (quadId === -1 && gateResolution === FLOWJO_GATE_RESOLUTION) return;
  const info = doc.createElementNS(DATATYPE_NS, "data-type:custom_info");
  const tag = doc.createElementNS(DATATYPE_NS, WSP_FLOWJO_POLYGON_TAG);
  tag.textContent = JSON.stringify({ quadId, gateResolution });
  info.appendChild(tag);
  copy.insertBefore(info, copy.firstChild);
}

/** Mark the rectangle that stands for a whole curly quadrant gate; see WSP_CURLY_TAG. */
function writeCurlyMark(doc: Document, el: Element, curl: QuadrantCurl | null): void {
  const info = doc.createElementNS(DATATYPE_NS, "data-type:custom_info");
  const tag = doc.createElementNS(DATATYPE_NS, WSP_CURLY_TAG);
  tag.textContent = JSON.stringify({ curl });
  info.appendChild(tag);
  el.insertBefore(info, el.firstChild);
}

/**
 * The <Transformations> block that governs a sample's axes.
 *
 * It is a SIBLING of <SampleNode>, not a descendant: FlowJo nests
 * <Sample><DataSet/><Transformations/><SampleNode/></Sample>. Searching the SampleNode's own
 * subtree therefore finds nothing, which silently left every imported gate in raw space — the
 * gates looked right and their counts were quietly FlowJo's straight-in-raw approximation.
 */
function transformsBlockFor(node: Element): Element | null {
  for (let el: Element | null = node; el; el = el.parentElement) {
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName === "Transformations") return c;
    }
    if (el.localName === "Sample") break;
  }
  return null;
}

/** FlowJo's declared display transform for one parameter, as a GateLab TransformSpec. */
function specForTransformElement(el: Element): TransformSpec | null {
  const n = (name: string): number => Number(el.getAttributeNS(TRANSFORMS_NS, name)
    ?? el.getAttribute(`transforms:${name}`));
  switch (el.localName) {
    case "linear":
      // A linear display axis IS raw, so there is nothing to hold and nothing to convert.
      return { kind: "identity" };
    case "biex": {
      // Evaluated on FlowJo's own table, 4096 channels with the exact root (biex.ts).
      const spec = {
        kind: "biex" as const,
        maxValue: n("maxRange"), pos: n("pos"), neg: n("neg"),
        widthBasis: n("width"), channelRange: Math.trunc(n("length")),
        tableChannels: FLOWJO_BIEX_TABLE_CHANNELS,
      };
      const ok = Number.isFinite(spec.maxValue) && Number.isFinite(spec.pos) && spec.pos > 0
        && Number.isFinite(spec.neg) && spec.widthBasis < 0 && spec.channelRange > 1;
      if (!ok) return null;
      // Attribute checks cannot prove the parameters produce a usable calibration table -- the
      // table IS the transform, so build it here, where a failure degrades this one parameter to
      // the warned straight-in-raw path instead of throwing later, mid-evaluation.
      try {
        biexTransform(spec);
      } catch {
        return null;
      }
      return spec;
    }
    case "log": {
      const spec = { kind: "wsplog" as const, offset: n("offset"), decades: n("decades") };
      return spec.offset > 0 && spec.decades > 0 ? spec : null;
    }
    case "fasinh": {
      // FlowJo's ArcSinh axis is Gating-ML's fasinh with FlowJo's length and maxRange beside it.
      // fasinh(x; T, M, A) = (asinh(x · sinh(M ln10) / T) + A ln10) / ((M + A) ln10) is affine
      // in asinh(x / cf) with cf = T / sinh(M ln10), whatever A is: A only shifts and scales the
      // axis, so a gate straight in FlowJo's display is straight in GateLab's asinh at that
      // cofactor. Thirty-three of the 433 corpus workspaces declare it, all mass cytometry.
      const T = n("T");
      const M = n("M");
      if (!(T > 0) || !(M > 0)) return null;
      // Where sinh(M ln10) overflows the cofactor is 0, and every event was placed at ±Infinity.
      const cofactor = T / Math.sinh(M * Math.LN10);
      return Number.isFinite(cofactor) && cofactor > 0 ? { kind: "asinh", cofactor } : null;
    }
    case "logicle": {
      // FlowJo can display an axis with logicle instead of biex. None of the workspaces this
      // importer was built against use it (seven files, 2016-2025, carry only linear/biex/log),
      // but the mapping is direct and GateLab's own logicle differs from Gating-ML's only by a
      // per-axis constant scale -- an affine change that maps straight lines to straight lines,
      // so gate membership is identical under either.
      //
      // The parameters are a logicle's only where the reference logicle has one: W at most M/2
      // and A from 0 to M − 2W, as GateLab's Gating-ML reader requires (parseTransforms). Any
      // other A was carried, and GateLab wrote the gate with it and refused its own export
      // (verifier); such an axis takes the warned straight-in-raw path, as a biex that cannot
      // build its table does. The upper bounds allow for rounding, as the reader's do
      // (withinLogicleBound): compared exactly, an A written in decimal at M − 2W, such as
      // M = 4.42, W = 0.87 and A = 2.68, was taken for one above it.
      const spec = { kind: "logicle" as const, T: n("T"), W: n("W"), M: n("M"), A: n("A") };
      const ok = Number.isFinite(spec.T) && spec.T > 0 && Number.isFinite(spec.W) && spec.W >= 0
        && Number.isFinite(spec.M) && spec.M > 0 && Number.isFinite(spec.A)
        && withinLogicleBound(spec.W, spec.M / 2, spec.M) && spec.A >= 0
        && withinLogicleBound(spec.A, spec.M - 2 * spec.W, spec.M);
      return ok ? spec : null;
    }
    default:
      return null;
  }
}

/** Every parameter's declared display transform, keyed by parameter name. */
export function workspaceTransformSpecs(node: Element): Map<string, TransformSpec> {
  const out = new Map<string, TransformSpec>();
  const block = transformsBlockFor(node);
  if (!block) return out;
  for (let el = block.firstElementChild; el; el = el.nextElementSibling) {
    const spec = specForTransformElement(el);
    if (!spec) continue;
    for (const p of childrenByLocalName(el, "parameter")) {
      const name = p.getAttributeNS(DATATYPE_NS, "name") ?? p.getAttribute("data-type:name");
      if (name) out.set(name, spec);
    }
  }
  return out;
}

/**
 * The affine map from FlowJo's 0-256 display channel space into the space GateLab holds a gate
 * in, for one parameter: `display = offset + scale * channel`.
 *
 * Only ellipsoids need this. FlowJo writes polygon and rectangle coordinates RAW, but writes
 * ellipsoid foci and edges in display channels -- in the same file, on the same axes. Measured
 * over a 433-workspace corpus: 99.3% of the 5,830 ellipsoid coordinates fall inside [0,256],
 * against 1.5% of polygon coordinates. Reading an ellipsoid as raw yields a gate a few hundred
 * units wide at the origin, which selects nothing and reports no error.
 *
 * The map is affine for every transform this importer reads, and that is what makes it safe:
 * an affine change of coordinates takes an ellipse to an ellipse, so the converted gate is
 * exact rather than resampled.
 *
 *   linear   GateLab's display IS raw               ->  min + channel * (max - min) / 256
 *   biex     forward(maxRange) == length == 256     ->  channel, the two spaces coincide
 *   log      forward spans 0..1 across the decades  ->  channel / 256
 *   logicle  forward spans 0..1                     ->  channel / 256
 */
interface ChannelMap {
  offset: number;
  scale: number;
}

function channelMapForTransformElement(el: Element): ChannelMap | null {
  const n = (name: string): number => Number(el.getAttributeNS(TRANSFORMS_NS, name)
    ?? el.getAttribute(`transforms:${name}`));
  switch (el.localName) {
    case "linear": {
      const min = n("minRange");
      const max = n("maxRange");
      if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return null;
      return { offset: min, scale: (max - min) / FLOWJO_DISPLAY_CHANNELS };
    }
    case "biex": {
      // biexTransform is built with channelRange = length, so its forward already returns
      // FlowJo channel numbers. The two spaces are the same one; nothing to convert.
      const length = Math.trunc(n("length"));
      return length > 1 ? { offset: 0, scale: FLOWJO_DISPLAY_CHANNELS / length } : null;
    }
    case "log":
    case "logicle":
      return { offset: 0, scale: 1 / FLOWJO_DISPLAY_CHANNELS };
    case "fasinh": {
      // GateLab's display is asinh(x / cf) = fasinh · (M + A) ln10 − A ln10, with fasinh spanning
      // 0..1 over the 256 channels.
      const M = n("M");
      const A = Number.isFinite(n("A")) ? n("A") : 0;
      if (!(M > 0)) return null;
      return { offset: -A * Math.LN10, scale: ((M + A) * Math.LN10) / FLOWJO_DISPLAY_CHANNELS };
    }
    default:
      return null;
  }
}

/**
 * A linear transform's gain, as written. FlowJo writes it without a namespace (`gain="1"` beside
 * `transforms:minRange`), so reading only `transforms:gain` took every gain for 1, and a gained
 * axis for one the linear rules were measured on.
 */
function linearGain(el: Element): string | null {
  return el.getAttributeNS(TRANSFORMS_NS, "gain") ?? el.getAttribute("transforms:gain") ?? el.getAttribute("gain");
}

/**
 * Each linear axis's range, [minRange, maxRange], keyed by parameter name.
 *
 * FlowJo moves an event that falls outside a linear axis's range onto the edge of that axis
 * before it tests a gate. The FCS of FR-FCM-Z2V4 d_021 holds 386 events with negative scatter,
 * down to FSC-A -5.8e6, all recorded in the last seconds of the run; FlowJo counts the 93 of them
 * with SSC-A below 0 inside a debris gate whose SSC edge is the axis floor (994, where testing the
 * raw values gives 901 -- as GateLab, FlowKit 1.3.1 and numpy all did). The range is fixed here,
 * once, from the workspace, so a later change of display scale still cannot move membership.
 * Only unit-gain linear axes: that is where the rule was measured.
 */
function workspaceLinearRanges(node: Element): Map<string, { min: number; max: number }> {
  const out = new Map<string, { min: number; max: number }>();
  const block = transformsBlockFor(node);
  if (!block) return out;
  for (let el = block.firstElementChild; el; el = el.nextElementSibling) {
    if (el.localName !== "linear") continue;
    const n = (name: string): number => Number(el.getAttributeNS(TRANSFORMS_NS, name) ?? el.getAttribute(`transforms:${name}`));
    // A Time axis whatever its gain: its range is in the units its gates are saved in, and a
    // bound at or beyond it opens as on any linear axis (sampleTimeScale: FR-FCM-Z2HV's "Time,
    // SSC-A subset", 28,033 as FlowJo counts it, 27,942 with the bound at 77.32 s kept).
    const gainText = linearGain(el);
    const gained = gainText !== null && gainText !== "" && Number(gainText) !== 1;
    const min = n("minRange");
    const max = n("maxRange");
    if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) continue;
    for (const p of childrenByLocalName(el, "parameter")) {
      const name = p.getAttributeNS(DATATYPE_NS, "name") ?? p.getAttribute("data-type:name");
      if (name && (!gained || isTimeAxis(name))) out.set(name, { min, max });
    }
  }
  return out;
}

/**
 * Each parameter's axis as FlowJo's gate grid reads it (flowjoGrid.ts), keyed by parameter name:
 * a unit-gain linear axis's range, a log axis's offset and decades, a biex axis's parameters.
 * Anything else (a gain other than 1, fasinh, logicle, an unknown kind) has no grid here, and a
 * polygon on it stays continuous.
 */
function workspaceGridAxes(node: Element): Map<string, FlowJoGridAxis> {
  const out = new Map<string, FlowJoGridAxis>();
  const block = transformsBlockFor(node);
  if (!block) return out;
  for (let el = block.firstElementChild; el; el = el.nextElementSibling) {
    const n = (name: string): number => Number(el.getAttributeNS(TRANSFORMS_NS, name) ?? el.getAttribute(`transforms:${name}`));
    let axis: FlowJoGridAxis | null = null;
    if (el.localName === "linear") {
      const gainText = linearGain(el);
      if (gainText !== null && gainText !== "" && Number(gainText) !== 1) continue;
      axis = parseFlowJoGridAxis({ kind: "linear", minRange: n("minRange"), maxRange: n("maxRange") });
    } else if (el.localName === "log") {
      axis = parseFlowJoGridAxis({ kind: "wsplog", offset: n("offset"), decades: n("decades") });
    } else if (el.localName === "biex") {
      axis = parseFlowJoGridAxis({
        kind: "biex", maxValue: n("maxRange"), pos: n("pos"), neg: n("neg"),
        widthBasis: n("width"), channelRange: Math.trunc(n("length")),
      });
    }
    if (!axis) continue;
    for (const p of childrenByLocalName(el, "parameter")) {
      const name = p.getAttributeNS(DATATYPE_NS, "name") ?? p.getAttribute("data-type:name");
      if (name) out.set(name, axis);
    }
  }
  return out;
}

/** A polygon's vertices as the element holds them, x then y. */
function polygonVertexValues(el: Element): Vertex[] {
  const out: Vertex[] = [];
  for (const v of childrenByLocalName(el, "vertex")) {
    const cs = childrenByLocalName(v, "coordinate").map((c) =>
      Number(c.getAttributeNS(DATATYPE_NS, "value") ?? c.getAttribute("data-type:value")));
    out.push([cs[0], cs[1]]);
  }
  return out;
}

/**
 * FlowJo pins an event below a biex axis's table onto the table's first entry, and one below a log
 * axis's offset onto the offset, and compares a rectangle's events in raw units; it pins nothing at
 * either axis's top. So a lower bound at or below the pin takes every event below the axis, and one
 * above it is unaffected by the pin (openLowerBoundAtOrBelow).
 *
 * Biex: nothing is pinned at the top, since an event past the table compared at its raw value
 * turns 11 of 11 corpus root populations that change into FlowJo's count; and the bottom is
 * FlowJo's 4096-channel table's, since 20 of the 21 corpus rectangles whose count depends on which
 * table's bottom is used match FlowJo with this one, none with the 256-channel one.
 *
 * Log: FR-FCM-Z466 "PE-A-", a histogram's range from the offset up, counted 73 of FlowJo's 2,256
 * without the pin.
 */

/** A rectangle's dimension bound as the element states it, null where it states none. */
function dimensionBound(dim: Element, attr: "min" | "max"): number | null {
  const raw = dim.getAttributeNS(GATING_NS, attr) ?? dim.getAttribute(`gating:${attr}`);
  const v = raw === null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(v) ? v : null;
}

/** Every dimension's [min, max] as the element states them. */
function rectangleBoundValues(rect: Element): [number | null, number | null][] {
  return childrenByLocalName(rect, "dimension").map((d) => [dimensionBound(d, "min"), dimensionBound(d, "max")]);
}

/**
 * Whether a rectangle's `index`th dimension lies wholly below `bottom`, where FlowJo pins: every
 * event is then at or above the pin, and so above the rectangle.
 */
function liesBelow(rect: Element, index: number, bottom: number): boolean {
  const dim = childrenByLocalName(rect, "dimension")[index];
  const hi = dim ? dimensionBound(dim, "max") : null;
  return hi !== null && hi < bottom;
}

/** A raw bound as a note states it: six significant digits. */
const fmtBound = (v: number): string => String(Number(v.toPrecision(6)));

/** Remove the lower bound of a rectangle's `index`th dimension when it lies at or below `bottom`. */
function openLowerBoundAtOrBelow(rect: Element, index: number, bottom: number): void {
  const dim = childrenByLocalName(rect, "dimension")[index];
  if (!dim) return;
  const lo = dimensionBound(dim, "min");
  if (lo === null || !(lo <= bottom)) return;
  dim.removeAttributeNS(GATING_NS, "min");
  dim.removeAttribute("gating:min");
}

/**
 * Open a rectangle's edges that reach its linear axis's range, as FlowJo evaluates them.
 *
 * FlowJo moves an event beyond the axis range onto the axis edge, so a rectangle whose min is at
 * or below minRange takes every event below the axis, and one whose max is at or above maxRange
 * every event above it. Removing that bound gives exactly FlowJo's event set; a bound inside the
 * range is unaffected by the move. Compared in FlowJo's stored units. Not for a compensated axis
 * or a Time axis, where the rule was not measured.
 *
 * A bound is opened only when the edge event lands inside the rectangle: a min at or below the
 * floor opens only if the max reaches the floor, and a max at or above the top only if the min
 * reaches the top. A rectangle lying wholly beyond the range on one axis holds no event under
 * FlowJo's rule, and opening its far edge made it take every raw event past its other bound (102
 * on a synthetic copy of FR-FCM-Z2V4 d_021, where FlowJo counts none). Such a rectangle is left
 * as drawn, and its axis is returned so the import can say so: GateLab tests the recorded values
 * and holds no gate that is empty by construction.
 */
function openLinearRangeEdges(
  rect: Element,
  ranges: Map<string, { min: number; max: number }>,
): { axis: string; min: number; max: number } | null {
  const plan: { dim: Element; attr: "min" | "max" }[] = [];
  for (const dim of childrenByLocalName(rect, "dimension")) {
    const fcs = childrenByLocalName(dim, "fcs-dimension")[0];
    const name = fcs ? (fcs.getAttributeNS(DATATYPE_NS, "name") ?? fcs.getAttribute("data-type:name")) : null;
    if (!name) continue;
    const comp = dim.getAttributeNS(GATING_NS, "compensation-ref") ?? dim.getAttribute("gating:compensation-ref");
    if (comp && comp !== "uncompensated") continue;
    const range = ranges.get(name);
    if (!range) continue;
    const bound = (attr: "min" | "max"): number | null => {
      const raw = dim.getAttributeNS(GATING_NS, attr) ?? dim.getAttribute(`gating:${attr}`);
      const v = raw === null || raw === "" ? NaN : Number(raw);
      return Number.isFinite(v) ? v : null;
    };
    const lo = bound("min"), hi = bound("max");
    // Wholly below the floor or wholly above the top: every event on this axis lands outside.
    if ((hi !== null && hi < range.min) || (lo !== null && lo > range.max)) return { axis: name, ...range };
    if (lo !== null && lo <= range.min) plan.push({ dim, attr: "min" });
    if (hi !== null && hi >= range.max) plan.push({ dim, attr: "max" });
  }
  for (const { dim, attr } of plan) {
    dim.removeAttributeNS(GATING_NS, attr);
    dim.removeAttribute(`gating:${attr}`);
  }
  return null;
}

/** Each parameter's channel-to-display map, keyed the same way as workspaceTransformSpecs. */
function workspaceChannelMaps(node: Element): Map<string, ChannelMap> {
  const out = new Map<string, ChannelMap>();
  const block = transformsBlockFor(node);
  if (!block) return out;
  for (let el = block.firstElementChild; el; el = el.nextElementSibling) {
    const map = channelMapForTransformElement(el);
    if (!map) continue;
    for (const p of childrenByLocalName(el, "parameter")) {
      const name = p.getAttributeNS(DATATYPE_NS, "name") ?? p.getAttribute("data-type:name");
      if (name) out.set(name, map);
    }
  }
  return out;
}

/** The (x, y) pairs under a `foci` or `edge` container, in document order. */
function ellipseVertices(parent: Element | null): Array<[number, number]> {
  if (!parent) return [];
  const out: Array<[number, number]> = [];
  for (const v of childrenByLocalName(parent, "vertex")) {
    const cs = childrenByLocalName(v, "coordinate").map((c) =>
      Number(c.getAttributeNS(DATATYPE_NS, "value") ?? c.getAttribute("data-type:value")));
    if (cs.length >= 2 && cs.every((n) => Number.isFinite(n))) out.push([cs[0], cs[1]]);
  }
  return out;
}

/**
 * Rewrite FlowJo's ellipsoid into the mean / covarianceMatrix / distanceSquare form Gating-ML
 * defines and GateLab's own parser already reads, moved into the axis's display space.
 *
 * FlowJo describes the ellipse by its two foci plus a `distance` attribute, which is the sum of
 * distances to the foci -- the major axis. The `edge` vertices are the axis endpoints but are
 * rounded to whole channels, so they are the fallback rather than the source: on the reference
 * workspace they place the boundary ~0.8% inside FlowJo's own, costing 8,450 events.
 *
 * Measured against 795,866 events FlowJo itself assigned to the gate: 794,031 selected, ZERO
 * false positives, 1,835 false negatives (Jaccard 0.9977). The residual is FlowJo quantising
 * events to display channels before it tests them, which GateLab deliberately does not do --
 * its gates are continuous in the data. Rounding mode, the semi-minor axis and bin-centre
 * offsets were each tested and are not the cause.
 */
function convertFlowJoEllipsoid(doc: Document, el: Element, mx: ChannelMap, my: ChannelMap): boolean {
  const foci = ellipseVertices(childrenByLocalName(el, "foci")[0] ?? null);
  if (foci.length !== 2) return false;
  const [f1, f2] = foci;
  const cx = (f1[0] + f2[0]) / 2;
  const cy = (f1[1] + f2[1]) / 2;
  const separation = Math.hypot(f2[0] - f1[0], f2[1] - f1[1]);
  // A circle has coincident foci and so no defined major axis; any orientation describes it.
  const ux = separation > 0 ? (f2[0] - f1[0]) / separation : 1;
  const uy = separation > 0 ? (f2[1] - f1[1]) / separation : 0;
  const halfFocal = separation / 2;

  const declared = Number(el.getAttributeNS(GATING_NS, "distance") ?? el.getAttribute("gating:distance"));
  let semiMajor = Number.isFinite(declared) && declared > 0 ? declared / 2 : NaN;
  if (!Number.isFinite(semiMajor)) {
    const edge = ellipseVertices(childrenByLocalName(el, "edge")[0] ?? null);
    if (!edge.length) return false;
    semiMajor = Math.max(...edge.map(([x, y]) => Math.hypot(x - cx, y - cy)));
  }
  if (!(semiMajor > halfFocal) || !Number.isFinite(semiMajor)) return false;
  const semiMinor = Math.sqrt(semiMajor * semiMajor - halfFocal * halfFocal);
  if (!(semiMinor > 0)) return false;

  // Covariance of the ellipse in channel space, then pushed through the per-axis affine map.
  // With distanceSquare = 1 the Mahalanobis boundary IS the ellipse with these semi-axes.
  const A = semiMajor * semiMajor;
  const B = semiMinor * semiMinor;
  const c00 = (A * ux * ux + B * uy * uy) * mx.scale * mx.scale;
  const c01 = (A - B) * ux * uy * mx.scale * my.scale;
  const c11 = (A * uy * uy + B * ux * ux) * my.scale * my.scale;

  for (const container of ["foci", "edge"]) {
    for (const n of childrenByLocalName(el, container)) el.removeChild(n);
  }
  el.removeAttributeNS(GATING_NS, "distance");

  const valued = (local: string, value: number): Element => {
    const node = doc.createElementNS(GATING_NS, `gating:${local}`);
    node.setAttributeNS(DATATYPE_NS, "data-type:value", String(value));
    return node;
  };
  const mean = doc.createElementNS(GATING_NS, "gating:mean");
  mean.appendChild(valued("coordinate", mx.offset + mx.scale * cx));
  mean.appendChild(valued("coordinate", my.offset + my.scale * cy));
  const cov = doc.createElementNS(GATING_NS, "gating:covarianceMatrix");
  for (const [p, q] of [[c00, c01], [c01, c11]]) {
    const row = doc.createElementNS(GATING_NS, "gating:row");
    row.appendChild(valued("entry", p));
    row.appendChild(valued("entry", q));
    cov.appendChild(row);
  }
  el.appendChild(mean);
  el.appendChild(cov);
  el.appendChild(valued("distanceSquare", 1));
  return true;
}

/**
 * Carry a CurlyQuad across as the rectangle it actually describes.
 *
 * FlowJo's curly quadrant stores nothing but two dimensions with a min or a max -- the same
 * content as a RectangleGate -- plus `percentX` / `percentY`, which bend the divider near the
 * crosshair. Every one of the 1,368 curly quadrants in the corpus declares both as 0, i.e. a
 * plain quadrant, and they arrive in complete sets of four. A non-zero percentage is reported
 * by the caller rather than silently straightened.
 */
function curlyQuadAsRectangle(doc: Document, el: Element): Element {
  const rect = doc.createElementNS(GATING_NS, "gating:RectangleGate");
  for (const attr of Array.from(el.attributes)) {
    if (attr.namespaceURI === "http://www.w3.org/2000/xmlns/") continue;
    if (attr.localName === "percentX" || attr.localName === "percentY") continue;
    if (attr.namespaceURI) rect.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
    else rect.setAttribute(attr.name, attr.value);
  }
  while (el.firstChild) rect.appendChild(el.firstChild);
  return rect;
}

/** A curly quadrant declaring a percentage FlowJo does not document; every one in the public corpus declares 0. */
function curlyQuadIsCurved(el: Element): boolean {
  return ["percentX", "percentY"].some((name) => {
    const raw = el.getAttribute(name);
    return raw !== null && raw !== "" && Number(raw) !== 0;
  });
}

/**
 * The crosshair a CurlyQuad declares, and which quadrant of it the population is.
 *
 * Each of the four populations carries one bound per dimension: a min on an axis puts the
 * population on that axis's positive side, a max on its negative side, and the bound's value is
 * the crosshair coordinate either way. Quadrants are numbered as GateLab's: 1 = x−/y+,
 * 2 = x+/y+, 3 = x+/y−, 4 = x−/y−.
 */
function curlyQuadCrosshair(el: Element): { cx: number; cy: number; quadrant: 1 | 2 | 3 | 4 } | null {
  const dims = childrenByLocalName(el, "dimension");
  if (dims.length !== 2) return null;
  const read = (d: Element): { value: number; plus: boolean } | null => {
    const min = d.getAttributeNS(GATING_NS, "min") ?? d.getAttribute("gating:min");
    const max = d.getAttributeNS(GATING_NS, "max") ?? d.getAttribute("gating:max");
    if (min !== null && min !== "") return Number.isFinite(Number(min)) ? { value: Number(min), plus: true } : null;
    if (max !== null && max !== "") return Number.isFinite(Number(max)) ? { value: Number(max), plus: false } : null;
    return null;
  };
  const x = read(dims[0]);
  const y = read(dims[1]);
  if (!x || !y) return null;
  const quadrant = x.plus ? (y.plus ? 2 : 3) : (y.plus ? 1 : 4);
  return { cx: x.value, cy: y.value, quadrant };
}

/** A RectangleGate whose two minima are the crosshair: the x+/y+ quadrant, standing for all four. */
function curlyQuadGroupRectangle(doc: Document, el: Element): Element {
  const rect = curlyQuadAsRectangle(doc, el);
  for (const d of childrenByLocalName(rect, "dimension")) {
    const min = d.getAttributeNS(GATING_NS, "min") ?? d.getAttribute("gating:min");
    const max = d.getAttributeNS(GATING_NS, "max") ?? d.getAttribute("gating:max");
    const value = min !== null && min !== "" ? min : max;
    d.removeAttributeNS(GATING_NS, "min");
    d.removeAttribute("gating:min");
    d.removeAttributeNS(GATING_NS, "max");
    d.removeAttribute("gating:max");
    if (value !== null) d.setAttributeNS(GATING_NS, "gating:min", value);
  }
  return rect;
}

/**
 * Transform kinds that bend nothing, so a gate on such an axis needs no carrying: a linear
 * display axis IS raw, and a gate straight in it is straight in raw.
 *
 * Everything else — biex, log, logicle — is handled by specForTransformElement returning a
 * TransformSpec, and gates on those axes are CARRIED into FlowJo's own space (Phase 4b(ii)).
 * This set only matters on the warning path, for a transform kind that produced no spec: such a
 * gate imports straight-in-raw, which is not the gate FlowJo evaluates, and is named as such.
 */
const REPRESENTABLE_FLOWJO_TRANSFORMS = new Set(["linear"]);

function parseWorkspace(xmlText: string): Document {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("This file is not valid XML, so it cannot be read as a FlowJo workspace.");
  }
  return doc;
}

/**
 * Refuse a workspace whose gates are in a Gating-ML other than 2.0: FlowJo 7 (7.6.1 to 7.6.5 in
 * FlowRepository, 37 workspaces of 9 datasets) writes Gating-ML 1.5's namespaces and names a
 * dimension's parameter by data-type:parameter. Every element FlowJo names itself (Sample,
 * SampleNode, Population, Keywords) reads as FlowJo 10's, so the sample list and the files'
 * pairing worked and every gate was silently missing: FR-FCM-ZYB7's T7_workspace.wsp opened its
 * confirmed sample with no population and said only that the other samples had no FCS. Reading
 * FlowJo 7's gates is not built (its axes are not stated as FlowJo 10's Transformations are, and
 * no count has been checked against it); the workspace is named for what it is instead.
 */
function refuseOlderGatingML(doc: Document, say: NoteTranslator = inEnglish): void {
  const root = doc.documentElement;
  if (!root) return;
  const older = Array.from(root.attributes).some((a) =>
    (a.name === "xmlns" || a.name.startsWith("xmlns:")) && /isac-net\.org\/std\/Gating-ML\/v(?!2\.0\/)/.test(a.value));
  if (!older) return;
  const version = root.getAttribute("flowJoVersion");
  throw new Error(version ? say(FLOWJO_OLDER_REFUSAL, { version }) : say(FLOWJO_OLDER_REFUSAL_UNSTATED));
}

/** The refusal of an older FlowJo's workspace, as the interface translates it (i18n.tsx). */
export const FLOWJO_OLDER_REFUSAL =
  "This workspace was saved by FlowJo {version}, which writes its gates in Gating-ML 1.5; GateLab reads the Gating-ML 2.0 " +
  "of FlowJo 10 and later. Open the workspace in FlowJo 10 or later, save it, and import that file. No gates were imported.";
export const FLOWJO_OLDER_REFUSAL_UNSTATED =
  "This workspace was saved by a FlowJo before version 10, which writes its gates in Gating-ML 1.5; GateLab reads the " +
  "Gating-ML 2.0 of FlowJo 10 and later. Open the workspace in FlowJo 10 or later, save it, and import that file. No gates were imported.";

/**
 * A population GateLab's FlowJo export added only as an operand (WSP_OPERAND_ATTR), with nothing
 * gated beneath it since: read back, its gate serves the nodes that name it, and it is no
 * population. One FlowJo has gated beneath is a population like any other.
 */
function isOperandHelper(pop: Element): boolean {
  if (pop.getAttribute(WSP_OPERAND_ATTR) !== "1") return false;
  const sub = childrenByLocalName(pop, "Subpopulations")[0];
  return !sub || !Array.from(sub.children).some((c) => POPULATION_NODES.has(c.localName));
}

/** True when the document looks like a FlowJo workspace rather than a Gating-ML file. */
export function isFlowJoWorkspace(xmlText: string): boolean {
  try {
    const doc = parseWorkspace(xmlText);
    return doc.getElementsByTagName("SampleNode").length > 0;
  } catch {
    return false;
  }
}

/** The gate element of one Population, if it carries one this importer understands. */
function gateElementOf(population: Element): { el: Element | null; unsupported: string | null } {
  const gate = childrenByLocalName(population, "Gate")[0];
  if (!gate) return { el: null, unsupported: null };
  // CurlyQuad is the one gate element FlowJo does not suffix with "Gate". Matching on the
  // suffix alone made 1,324 populations in the corpus report as "has no gate" -- the wrong
  // reason, and the wrong advice to anyone reading the warning.
  const candidates = Array.from(gate.children).filter(
    (c) => c.localName.endsWith("Gate") || c.localName === "CurlyQuad",
  );
  if (!candidates.length) return { el: null, unsupported: null };
  const supported = candidates.find((c) => SUPPORTED_GATE_LOCAL_NAMES.has(c.localName));
  return supported
    ? { el: supported, unsupported: null }
    : { el: null, unsupported: candidates[0].localName };
}

/**
 * Whether two FlowJo gate elements draw the same gate: the same kind, dimensions, bounds and
 * vertices. The gate element's own attributes are left out -- label offsets, tint, line weight --
 * since they are how FlowJo draws it, not which events it holds. Numbers are compared as numbers,
 * so "0" and "0.0" agree.
 */
function sameGateGeometry(a: Element, b: Element): boolean {
  const geometry = (el: Element): string[] => [
    el.localName,
    ...Array.from(el.getElementsByTagName("*")).map((d) => {
      const attrs = Array.from(d.attributes).map((attr) => {
        const n = Number(attr.value);
        return `${attr.localName}=${attr.value.trim() !== "" && Number.isFinite(n) ? n : attr.value}`;
      });
      return `${d.localName}[${attrs.sort().join(",")}]`;
    }),
  ];
  const ga = geometry(a);
  const gb = geometry(b);
  return ga.length === gb.length && ga.every((v, i) => v === gb[i]);
}

function eachPopulation(
  container: Element,
  visit: (population: Element, depth: number) => boolean,
  depth = 0,
): void {
  for (const pop of populationChildren(container)) {
    // visit() returns false when the subtree must not be descended into, which happens when
    // a gate could not be represented: its children's membership depends on it, so carrying
    // them over re-parented would silently change what they mean.
    if (visit(pop, depth)) eachPopulation(pop, visit, depth + 1);
  }
}

function sampleNodes(doc: Document): Element[] {
  return Array.from(doc.getElementsByTagName("SampleNode"));
}

/** Summarise every sample in the workspace, so the caller can choose one. */
/** The independent gating trees of a sample: its top-level Population elements. */
/**
 * The element names FlowJo uses for a node in a gating tree.
 *
 * A <NotNode> is a <Population> in every structural respect -- it carries a <Gate>, it has
 * <Subpopulations> beneath it, it has a count -- and differs only in meaning: it selects the
 * events OUTSIDE its gate. Reading only <Population> made every Boolean node invisible to the
 * walk, so its whole subtree vanished with it, and because the loop never saw the node there
 * was no "skipped" warning either. On FR-FCM-Z2V4 that turned 38 gates into 4, silently.
 */
const POPULATION_NODES = new Set(["Population", "NotNode", "AndNode", "OrNode"]);

function populationChildren(container: Element): Element[] {
  return childrenByLocalName(container, "Subpopulations")
    .flatMap((subs) => Array.from(subs.children).filter((el) => POPULATION_NODES.has(el.localName)));
}

function rootPopulations(sampleNode: Element): Element[] {
  return populationChildren(sampleNode);
}

/**
 * The sample's independent gating trees, each as its top-level elements: one per top-level
 * element, as FlowJo keeps them, or all of them as one where GateLab's export marked the sample as
 * one GateLab tree (WSP_ONE_TREE_ATTR). A tree is chosen by its position in this list.
 */
function sampleTrees(sampleNode: Element): Element[][] {
  const roots = rootPopulations(sampleNode);
  if (roots.length > 1 && sampleNode.getAttribute(WSP_ONE_TREE_ATTR) === "1") return [roots];
  return roots.map((root) => [root]);
}

/** Visit one tree, root included. `eachPopulation` starts below a container, not at it. */
function walkTree(root: Element, visit: (pop: Element, depth: number) => boolean): void {
  if (visit(root, 0)) eachPopulation(root, visit, 1);
}

function summariseTree(roots: Element[], index: number): FlowJoTreeSummary {
  let gateCount = 0;
  let unsupportedCount = 0;
  const populations: string[] = [];
  for (const root of roots) walkTree(root, (pop) => {
    // GateLab's own operand helpers are no population when read back (isOperandHelper); their
    // gates serve the intersections that name them, and are not counted as the tree's.
    if (isOperandHelper(pop)) return true;
    // A Boolean node is a population without a gate of its own; it counts, and the walk goes
    // on beneath it, as the converter does. Stopping at it made a sample gated only beneath a
    // root-level intersection look ungated.
    if (pop.localName === "AndNode" || pop.localName === "NotNode") {
      gateCount++;
      populations.push(pop.getAttribute("name") ?? "");
      return true;
    }
    const { el, unsupported } = gateElementOf(pop);
    if (el) {
      gateCount++;
      populations.push(pop.getAttribute("name") ?? "");
      return true;
    }
    if (unsupported) unsupportedCount++;
    return false;
  });
  // One FlowJo tree is known by its root population. A GateLab tree of several top-level
  // populations is known by them (helpers aside), and its root is the sample's.
  const shown = roots.filter((r) => !isOperandHelper(r));
  const first = shown[0] ?? roots[0];
  const counted = roots.length > 1 ? first.parentElement?.parentElement ?? first : first;
  const raw = Number(counted.getAttribute("count"));
  return {
    index,
    name: roots.length > 1
      ? shown.map((r) => r.getAttribute("name") ?? "").join(", ")
      : first.getAttribute("name") ?? `tree ${index + 1}`,
    rootCount: Number.isFinite(raw) ? raw : null,
    gateCount,
    unsupportedCount,
    populations,
  };
}

/**
 * What FlowJo multiplies a sample's stored Time by to get the values its Time gates are saved in,
 * or null when the workspace says nothing (Time is then taken as stored).
 *
 * FlowJo displays and stores the Time axis scaled, so a gate drawn on Time arrives here in those
 * units while the file holds ticks. Michaelis et al. 2025 (LSRFortessa X-20): `$TIMESTEP` 0.01,
 * Time column 20.8 to 2310.4, and the root rectangle's Time range 0.48 to 23.05, which selects
 * nothing in ticks and empties every population beneath it.
 *
 * The scale is the Time axis's linear `gain` in the sample's Transformations where the workspace
 * declares one other than 1, and `$TIMESTEP` otherwise. FlowJo 10 sets that gain to the recorded
 * duration over the Time column's span ($ETIM - $BTIM over its maximum less its minimum), close
 * to `$TIMESTEP` but not it: 0.0102350064 on FR-FCM-Z2HV's sample 14, where `$TIMESTEP` is 0.01.
 * Of the 27 Time rectangles at a sample's root on the corpus ladder's files, counted on the stored
 * values, `$TIMESTEP` (as until 2026-09-25) gives FlowJo's count for 5; the gain, with the axis's
 * range opening a bound at or beyond it as on any linear axis (openLinearRangeEdges), for 19:
 * FR-FCM-Z2HV 28,033 (27,832 at `$TIMESTEP`), Z2W3 22,891 (23,179), Z2C8 186,067 (186,561), and a
 * mass cytometry workspace stating no `$TIMESTEP`, FR-FCM-Z2MW, 396,964 (458, Time as stored). The
 * one that states a gain of 1, FR-FCM-Z282 (FlowJo 10.0.8, `$TIMESTEP` 0.001), counts as FlowJo
 * does at `$TIMESTEP` (186,922) and not at the gain (196). The other seven are Z2MW's gates nested
 * in one another, which that count on stored values does not model; the count oracle (GateLab
 * itself, every population of the 25 ladder rows whose workspace has a Time gate) gives FlowJo's
 * count for all eight of Z2MW's at the gain (for none at `$TIMESTEP`), and for 797 of 984
 * populations in all, against 547. GateLab's own FlowJo export writes a Time axis with a gain of 1
 * and its gates at `$TIMESTEP`, which reads back alike; a bound the range opened is kept in ticks
 * (flowjo_bounds), and goes back out at `$TIMESTEP` only where it reaches past the Time axis the
 * export declares, and as no bound otherwise (flowjoExport.ts, rectangleForFlowJo).
 */
function sampleTimeScale(sampleNode: Element): number | null {
  const block = transformsBlockFor(sampleNode);
  for (let el = block?.firstElementChild ?? null; el; el = el.nextElementSibling) {
    if (el.localName !== "linear") continue;
    const onTime = childrenByLocalName(el, "parameter")
      .some((p) => isTimeAxis(p.getAttributeNS(DATATYPE_NS, "name") ?? p.getAttribute("data-type:name") ?? ""));
    if (!onTime) continue;
    const gain = Number(linearGain(el));
    if (Number.isFinite(gain) && gain > 0 && gain !== 1) return gain;
    break;
  }
  const owner = sampleNode.parentElement;
  for (const keywords of owner ? childrenByLocalName(owner, "Keywords") : []) {
    for (const kw of childrenByLocalName(keywords, "Keyword")) {
      if (kw.getAttribute("name") !== "$TIMESTEP") continue;
      const v = Number(kw.getAttribute("value"));
      return Number.isFinite(v) && v > 0 ? v : null;
    }
  }
  return null;
}

/** FlowJo names the time parameter as the FCS does, and never compensates it. */
const isTimeAxis = (name: string): boolean => /^time$/i.test(name.trim());

/**
 * Population names, qualified with as many parents as it takes to be unique within the import.
 *
 * An intracellular-cytokine strategy gates "IFNy+" under "IL-4+" and "IL-4+" under "IFNy+", so
 * leaf names recur and everything keyed by name — FlowJo's counts, exported file names, the
 * notebooks that compare tools — collides. "IFNy+/IL-4+" is the shortest name that tells two such
 * populations apart, and a name that is unique already is left exactly as FlowJo wrote it.
 */
function qualifiedPopulationNames(roots: Element[]): Map<Element, string> {
  const items: { pop: Element; path: string[] }[] = [];
  for (const root of roots) {
    walkTree(root, (pop) => {
      // GateLab's own operand helpers hold no population when read back (isOperandHelper), so
      // their names qualify nothing.
      if (isOperandHelper(pop)) return true;
      const path: string[] = [];
      for (let el: Element | null = pop; el && POPULATION_NODES.has(el.localName);
           el = el.parentElement?.parentElement ?? null) {
        path.unshift(el.getAttribute("name") ?? "");
      }
      items.push({ pop, path });
      return true;
    });
  }
  const depth = items.map(() => 1);
  let names = items.map((it) => it.path[it.path.length - 1]);
  for (;;) {
    const counts = new Map<string, number>();
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    let progressed = false;
    items.forEach((it, i) => {
      if ((counts.get(names[i]) ?? 0) > 1 && depth[i] < it.path.length) {
        depth[i]++;
        progressed = true;
      }
    });
    if (!progressed) break;
    names = items.map((it, i) => it.path.slice(-depth[i]).join("/"));
  }
  return new Map(items.map((it, i) => [it.pop, names[i]]));
}

/**
 * The names this sample's FCS may be stored under, best first.
 *
 * Order matters. The `DataSet` URI is the path FlowJo actually read, so its basename is the
 * file's real name; `SampleNode@name` and `$FIL` can both be the acquisition's internal name
 * instead. All three are offered because no single one is present in every workspace: a
 * FACSDiscover export here carries no `$FIL` at all, and a FACSDiva export's node name is
 * `19319.fcs` while the file on disk is `Specimen_001_B cell presort.fcs`.
 */
function candidateFileNames(sampleNode: Element): string[] {
  const owner = sampleNode.parentElement;
  const out: string[] = [];
  const push = (value: string | null | undefined) => {
    const v = (value ?? "").trim();
    if (v && !out.includes(v)) out.push(v);
  };
  const uri = owner ? childrenByLocalName(owner, "DataSet")[0]?.getAttribute("uri") : null;
  if (uri) {
    const base = uri.split(/[\\/]/).pop() ?? "";
    let decoded = base;
    try {
      decoded = decodeURIComponent(base);
    } catch {
      // A malformed escape is not a reason to lose the name; use it as written.
    }
    push(decoded);
  }
  push(sampleNode.getAttribute("name"));
  // Direct children only. Scanning every descendant of a <Sample> means walking its whole gate
  // tree and graph settings for one keyword, which took the 24-sample workspace from 3s to 45s.
  for (const keywords of owner ? childrenByLocalName(owner, "Keywords") : []) {
    for (const kw of childrenByLocalName(keywords, "Keyword")) {
      if (kw.getAttribute("name") === "$FIL") push(kw.getAttribute("value"));
    }
  }
  return out;
}

/** The identity keywords FlowJo copied from the file into this sample's own <Keywords>. */
function recordedIdentity(sampleNode: Element): RecordedIdentity {
  const owner = sampleNode.parentElement;
  const out: Record<string, string> = {};
  // Direct children only, as for $FIL above: a sample's gate tree is no place to look.
  for (const keywords of owner ? childrenByLocalName(owner, "Keywords") : []) {
    for (const kw of childrenByLocalName(keywords, "Keyword")) {
      const name = kw.getAttribute("name");
      if (name && /^(\$TOT|\$DATE|\$BTIM|\$ETIM|GUID)$/i.test(name.trim())) out[name] = kw.getAttribute("value") ?? "";
    }
  }
  return identityKeywords(out);
}

/** The sample's well or specimen, from its own keywords: $WELLID, else $SMNO, as fcs.ts names a
 *  data set. */
function dataSetLabelOf(sampleNode: Element): string | null {
  const owner = sampleNode.parentElement;
  const found = new Map<string, string>();
  for (const keywords of owner ? childrenByLocalName(owner, "Keywords") : []) {
    for (const kw of childrenByLocalName(keywords, "Keyword")) {
      const name = (kw.getAttribute("name") ?? "").trim().toUpperCase();
      const value = (kw.getAttribute("value") ?? "").trim();
      if (value && !found.has(name)) found.set(name, value);
    }
  }
  for (const k of ["$WELLID", "WELLID", "$SMNO", "SMNO"]) {
    const v = found.get(k);
    if (v) return v;
  }
  return null;
}

export function listFlowJoWorkspaceSamples(xmlText: string, translate: NoteTranslator = inEnglish): FlowJoSampleSummary[] {
  const parsed = parseWorkspace(xmlText);
  refuseOlderGatingML(parsed, translate);
  const nodes = sampleNodes(parsed);
  const nameCounts = new Map<string, number>();
  for (const n of nodes) {
    const nm = n.getAttribute("name") ?? "";
    nameCounts.set(nm, (nameCounts.get(nm) ?? 0) + 1);
  }
  return nodes.map((node, index) => {
    let gateCount = 0;
    let unsupportedCount = 0;
    eachPopulation(node, (pop) => {
      if (isOperandHelper(pop)) return true;
      if (pop.localName === "AndNode" || pop.localName === "NotNode") {
        gateCount++;
        return true;
      }
      const { el, unsupported } = gateElementOf(pop);
      if (el) {
        gateCount++;
        return true;
      }
      if (unsupported) unsupportedCount++;
      return false;
    });
    const rawCount = Number(node.getAttribute("count"));
    const name = node.getAttribute("name") ?? "";
    const trees = sampleTrees(node).map(summariseTree);
    return {
      index,
      name,
      owningGroup: node.getAttribute("owningGroup") ?? "",
      duplicateName: (nameCounts.get(name) ?? 0) > 1,
      rootCount: trees.length,
      candidateFileNames: candidateFileNames(node),
      trees,
      eventCount: Number.isFinite(rawCount) ? rawCount : null,
      dataSetLabel: dataSetLabelOf(node),
      gateCount,
      unsupportedCount,
      recorded: recordedIdentity(node),
    };
  });
}

/** How a workspace sample was matched to the loaded file. */
export type FlowJoSampleMatchKey = "name" | "fil";

export interface FlowJoSampleMatch {
  /** The file's own sample, or the samples it could be when the keywords cannot tell. */
  matches: FlowJoSampleSummary[];
  /** Which key produced a unique match, or null when the result is not unique. */
  matchedOn: FlowJoSampleMatchKey | null;
  /** What the identity keywords said about each sample named like the file. */
  pairing: FilePairing<FlowJoSampleSummary>;
  /**
   * For one data set of a multi-data-set file whose own keywords cannot say which sample it is:
   * the other open data sets of that file that share what it was matched on (empty when only the
   * samples tie).
   */
  tiedWith?: string[];
  /** What the tie is on: the data set's event count, or a $FIL other data sets of its file carry. */
  tiedOn?: "count" | "fil";
  /** How many workspace samples without gates could be this data set too. */
  tiedUngated?: number;
  /**
   * How many other data sets the file holds ("data set k of N") that are not open. Their well
   * label, event count and $FIL are not known, so any of them could be the sample as well.
   */
  tiedUnopened?: number;
}

/** Any name the workspace records for a sample is a legitimate way to recognise it. */
const namesOfSample = (s: FlowJoSampleSummary): readonly string[] => s.candidateFileNames;
const recordedOfSample = (s: FlowJoSampleSummary): RecordedIdentity => s.recorded ?? {};

/** The $FIL a file's keywords carry, or undefined. */
const filOf = (keywords: Readonly<Record<string, string>> | null | undefined): string | undefined =>
  Object.entries(keywords ?? {}).find(([k]) => k.trim().toUpperCase() === "$FIL")?.[1]?.trim() || undefined;

/**
 * Find the workspace sample that IS the loaded file.
 *
 * A name nominates: `SampleNode@name` is usually the FCS file name, but a BD FACSDiva export
 * names its samples by the acquisition's `$FIL` keyword (`19319.fcs`) while the file on disk is
 * called something else entirely (`Specimen_001_B cell presort.fcs`), so the DataSet path, the
 * node name and `$FIL` are all tried, and the loaded file's own `$FIL` when its name matches none.
 *
 * The keywords decide. FlowJo records each sample's $TOT, $DATE, $BTIM, $ETIM and GUID, and a
 * sample whose record contradicts the file is not the file, however it is named: Diva names its
 * files Specimen_001_Tube_001.fcs in every experiment, and a same-named file from another
 * experiment imported this one's gates without a word. Of several samples named like the file,
 * the one the keywords confirm is taken; when they cannot tell, nothing is -- FlowJo permits the
 * same file twice, and taking the first imported another sample's gates.
 *
 * One data set of a multi-data-set file ("plate (data set 2 of 4, A02).fcs", fcsDataSetFileName)
 * that no sample is named after is the one exception: the workspace names it by its file, like
 * the file's other data sets, and the data set's own keywords say which one it is
 * (dataSetMatch). Its well label or event count says so only where no other data set of the
 * file, open or not, might be the sample too, and no other sample, gated or not, joins it;
 * otherwise the user chooses, as two data sets of one size, or of one well label, otherwise took
 * each other's gates. A sample whose recorded keywords contradict the data set's is not it there
 * either.
 */
export function matchFlowJoSamples(
  samples: FlowJoSampleSummary[],
  loaded: {
    fileName: string;
    fil?: string | null;
    keywords?: Readonly<Record<string, string>> | null;
    /** The loaded file's events, for telling data sets of one file apart. */
    events?: number | null;
    /**
     * The samples open, by name, events and $FIL (null where the file has none). Another open data
     * set of the same file with the same event count, or the same $FIL, means that key cannot say
     * which of the two a workspace sample is.
     */
    open?: readonly { name: string; events?: number | null; fil?: string | null }[];
    /**
     * The workspace's samples that carry no gates, where the caller passes only the gated ones in
     * `samples`. Never a match for a data set themselves, but one that could be this data set too
     * means a match on its event count or $FIL is not unique.
     */
    ungated?: readonly FlowJoSampleSummary[];
  },
): FlowJoSampleMatch {
  const keywords: Record<string, string> = { ...(loaded.keywords ?? {}) };
  const fil = loaded.fil?.trim();
  if (fil && !Object.keys(keywords).some((k) => k.trim().toUpperCase() === "$FIL")) keywords["$FIL"] = fil;
  const dataSet = parseFcsDataSetFileName(loaded.fileName);
  if (dataSet && !samples.some((s) => namesOfSample(s).some((n) => sameFileName(n, loaded.fileName)))) {
    return dataSetMatch(samples, { ...loaded, fil: fil ?? filOf(keywords) ?? null, keywords }, dataSet);
  }
  const pairing = pairFile({ name: loaded.fileName, keywords }, samples, namesOfSample, recordedOfSample);
  if (pairing.kind === "own") return { matches: [pairing.sample], matchedOn: pairing.matchedOn, pairing };
  if (pairing.kind === "ambiguous") return { matches: pairing.candidates.map((c) => c.sample), matchedOn: null, pairing };
  return { matches: [], matchedOn: null, pairing };
}

/**
 * matchFlowJoSamples for one data set of a multi-data-set file that no sample is named after
 * (fix/fcs-read-write's rule, with the identity keywords of fix/multitree-import ruling out a
 * sample whose record contradicts the data set). Gated samples are the candidates; one without
 * gates that could be the data set as well makes a match on the count or $FIL not unique. Where
 * only a sample without gates is the data set, it is the file's own, which carries no gates.
 */
function dataSetMatch(
  samples: readonly FlowJoSampleSummary[],
  loaded: {
    fileName: string;
    fil: string | null;
    keywords: Readonly<Record<string, string>>;
    events?: number | null;
    open?: readonly { name: string; events?: number | null; fil?: string | null }[];
    ungated?: readonly FlowJoSampleSummary[];
  },
  dataSet: NonNullable<ReturnType<typeof parseFcsDataSetFileName>>,
): FlowJoSampleMatch {
  const own = identityKeywords(loaded.keywords);
  const compared = (s: FlowJoSampleSummary) => ({ sample: s, comparison: compareIdentity(recordedOfSample(s), own) });
  const notContradicted = (s: FlowJoSampleSummary) => compared(s).comparison.verdict !== "contradicted";
  const gated = samples.filter((s) => s.gateCount > 0);
  const ungated = [
    ...samples.filter((s) => s.gateCount === 0),
    ...(loaded.ungated ?? []).filter((u) => !samples.some((s) => s.index === u.index)),
  ];
  const matchesFile = (s: FlowJoSampleSummary, candidate: string) => namesOfSample(s).some((c) => sameFileName(c, candidate));
  const siblings = (loaded.open ?? []).filter((o) =>
    o.name !== loaded.fileName && sameFileName(parseFcsDataSetFileName(o.name)?.fileName ?? "", dataSet.fileName));
  const unopened = unopenedDataSets(loaded.fileName, siblings.map((o) => o.name));
  const joinsLoaded = (s: FlowJoSampleSummary) =>
    flowJoSampleNamesFile(s, { name: loaded.fileName, events: loaded.events }) && notContradicted(s);
  const rejectedBy = (list: readonly FlowJoSampleSummary[]) =>
    list.filter((s) => flowJoSampleNamesFile(s, { name: loaded.fileName, events: loaded.events }) && !notContradicted(s)).map(compared);

  let tie: FlowJoSampleMatch | null = null;
  const bySet = gated.filter(joinsLoaded);
  const ungatedJoining = ungated.filter(joinsLoaded);
  if (bySet.length) {
    const elsewhere = bySet.map((s) => otherDataSetsItMightBe(s, loaded.fileName, siblings));
    const tiedWith = siblings.filter((o) => elsewhere.some((names) => names.includes(o.name))).map((o) => o.name);
    const tiedUngated = ungatedJoining.length;
    const tiedUnopened = unopened;
    const rejected = rejectedBy(gated);
    if (bySet.length === 1 && !tiedWith.length && !tiedUngated && !tiedUnopened) {
      const c = compared(bySet[0]);
      return { matches: bySet, matchedOn: "name", pairing: { kind: "own", sample: c.sample, comparison: c.comparison, matchedOn: "name", rejected } };
    }
    const onCount = tiedWith.length > 0 || tiedUngated > 0 || tiedUnopened > 0 ||
      bySet.some((s) => joinsOnCount(s, loaded.fileName));
    tie = {
      matches: bySet,
      matchedOn: null,
      pairing: { kind: "ambiguous", candidates: bySet.map(compared), matchedOn: "name", rejected },
      ...(onCount
        ? {
            tiedWith, tiedOn: "count" as const,
            ...(tiedUngated ? { tiedUngated } : {}), ...(tiedUnopened ? { tiedUnopened } : {}),
          }
        : {}),
    };
  } else if (ungatedJoining.length === 1 && !unopened &&
    !otherDataSetsItMightBe(ungatedJoining[0], loaded.fileName, siblings).length) {
    // The data set's own sample, which carries no gates: never a gated sample's tree on its count.
    const c = compared(ungatedJoining[0]);
    return { matches: [], matchedOn: null, pairing: { kind: "own", sample: c.sample, comparison: c.comparison, matchedOn: "name", rejected: [] } };
  }

  // A data set's $FIL identifies it only where no other data set of its file carries the same: the
  // file's own name, or an acquisition name every data set of the file shares, cannot say which
  // data set this is. Another data set whose $FIL is not known, open or not, might carry it, and a
  // sample without gates recorded under it is another data set it could be.
  const fil = sameFileName(loaded.fil ?? "", dataSet.fileName) ? "" : loaded.fil?.trim();
  if (fil) {
    const byFil = gated.filter((s) => matchesFile(s, fil) && notContradicted(s));
    const sharing = siblings.filter((o) => o.fil === undefined || sameFileName(o.fil ?? "", fil)).map((o) => o.name);
    const filUngated = ungated.filter((s) => matchesFile(s, fil) && notContradicted(s)).length;
    const shared = sharing.length > 0 || filUngated > 0 || unopened > 0;
    const rejected = gated.filter((s) => matchesFile(s, fil) && !notContradicted(s)).map(compared);
    if (byFil.length === 1 && !shared) {
      const c = compared(byFil[0]);
      return { matches: byFil, matchedOn: "fil", pairing: { kind: "own", sample: c.sample, comparison: c.comparison, matchedOn: "fil", rejected } };
    }
    if (!tie && byFil.length > 1) {
      return { matches: byFil, matchedOn: null, pairing: { kind: "ambiguous", candidates: byFil.map(compared), matchedOn: "fil", rejected } };
    }
    if (!tie && byFil.length === 1) {
      return {
        matches: byFil,
        matchedOn: null,
        pairing: { kind: "ambiguous", candidates: byFil.map(compared), matchedOn: "fil", rejected },
        tiedWith: sharing,
        tiedOn: "fil",
        ...(filUngated ? { tiedUngated: filUngated } : {}),
        ...(unopened ? { tiedUnopened: unopened } : {}),
      };
    }
  }
  if (tie) return tie;
  const contradicted = rejectedBy([...gated, ...ungated]);
  return {
    matches: [],
    matchedOn: null,
    pairing: contradicted.length ? { kind: "contradicted", candidates: contradicted, matchedOn: "name" } : { kind: "none" },
  };
}

/**
 * Whether a workspace sample is recorded under this file: by any of its names, or, for a loaded
 * sample that is one data set of a multi-data-set file ("plate (data set 2 of 4, A02).fcs",
 * fcsDataSetFileName), by the file's name together with that data set's identity. A workspace
 * over such a file records every data set under the file's name, so the name alone cannot say
 * which; the well label ($WELLID, else $SMNO) where both sides carry one, else the event count.
 * A label never overrides a count: where both sides know the count and it differs, the labels
 * agreeing does not make it a match. Neither known, it is not a match: taking the first would
 * import another well's gates. A match is only a candidate: the callers take it where no other
 * data set of the file might be the sample (otherDataSetsItMightBe) and no other sample joins it.
 */
export function flowJoSampleNamesFile(
  s: FlowJoSampleSummary,
  loaded: { name: string; events?: number | null },
): boolean {
  if (s.candidateFileNames.some((c) => sameFileName(c, loaded.name))) return true;
  const dataSet = parseFcsDataSetFileName(loaded.name);
  if (!dataSet || !s.candidateFileNames.some((c) => sameFileName(c, dataSet.fileName))) return false;
  const label = fcsDataSetLabelToken(s.dataSetLabel);
  const counted = s.eventCount !== null && loaded.events !== undefined && loaded.events !== null;
  if (label && dataSet.label) {
    return label.toLowerCase() === dataSet.label.toLowerCase() && (!counted || s.eventCount === loaded.events);
  }
  return counted && s.eventCount === loaded.events;
}

/** Whether a sample joins this data set on its event count alone, with no well label on both sides. */
function joinsOnCount(s: FlowJoSampleSummary, dataSetName: string): boolean {
  return !(fcsDataSetLabelToken(s.dataSetLabel) && parseFcsDataSetFileName(dataSetName)?.label);
}

/** The data set a name refers to, where it is one of the same file, of the same number of data sets. */
function sameFileDataSet(name: string, of: { fileName: string; count: number }) {
  const other = parseFcsDataSetFileName(name);
  return other && other.count === of.count && sameFileName(other.fileName, of.fileName) ? other : null;
}

/**
 * How many data sets of a data set's file are not open: the name says how many the file holds
 * ("data set k of N"), and `open` names the others that are. What such a data set carries -- its
 * well label, event count, $FIL -- is not known, so it might be any sample of the file.
 */
function unopenedDataSets(dataSetName: string, open: readonly string[]): number {
  const dataSet = parseFcsDataSetFileName(dataSetName);
  if (!dataSet) return 0;
  const indexes = new Set([dataSet.index]);
  for (const name of open) {
    const other = sameFileDataSet(name, dataSet);
    if (other) indexes.add(other.index);
  }
  return dataSet.count - indexes.size;
}

/**
 * The other open data sets of a data set's file that a sample recorded under the file might be as
 * well: those whose well label and event count do not rule it out where both sides know them. A
 * label or a count one side does not know is no evidence either way, so an open data set whose
 * count is not known might be any sample whose label it does not contradict.
 */
function otherDataSetsItMightBe(
  s: FlowJoSampleSummary,
  dataSetName: string,
  open: readonly { name: string; events?: number | null }[],
): string[] {
  const dataSet = parseFcsDataSetFileName(dataSetName);
  if (!dataSet) return [];
  const label = fcsDataSetLabelToken(s.dataSetLabel).toLowerCase();
  return open.filter((o) => {
    const other = o.name === dataSetName ? null : sameFileDataSet(o.name, dataSet);
    if (!other) return false;
    if (label && other.label && fcsDataSetLabelToken(other.label).toLowerCase() !== label) return false;
    return s.eventCount === null || o.events === undefined || o.events === null || o.events === s.eventCount;
  }).map((o) => o.name);
}

/** A file the open dialog could pair with a workspace sample: loaded already, or chosen for it. */
export interface FlowJoWorkspaceFile {
  /** Stable within the dialog: a loaded file's entry id, or a chosen file's name. */
  key: string;
  name: string;
  /** Its TEXT keywords, when read; null pairs by name alone. */
  keywords?: Readonly<Record<string, string>> | null;
  /** Where it was chosen from, and its event count, for telling it from a file of the same name. */
  path?: string | null;
  events?: number | null;
}

export interface FlowJoFileResolution {
  /** Index into the sample list this resolution is for. */
  sampleIndex: number;
  /** The provided file that is this sample, or null when none is. */
  fileName: string | null;
  /** That file's key (see FlowJoWorkspaceFile), or null. */
  fileKey: string | null;
  /** Which of the sample's recorded names matched, for explaining the choice. */
  matchedName: string | null;
  /**
   * - own: the file is this sample (named like it, and nothing it records contradicts it);
   * - chosen: the user said which of several samples the file is;
   * - contradicted: a file is named like it, but records another acquisition;
   * - ambiguous: a file named like it could be this sample or another, and the keywords cannot tell;
   * - missing: no file is named like it.
   */
  status: "own" | "chosen" | "contradicted" | "ambiguous" | "missing";
  /** What the keywords said, for a paired sample. */
  comparison?: IdentityComparison;
  /**
   * Further files that are this sample too: copies of the paired file, whose keywords confirm one
   * another as one acquisition (a file and a copy of it saved under another name, found by its
   * $FIL). Each is this sample and gets its tree. Two such files used to leave the sample with
   * neither, and both followed another sample's tree.
   */
  copies?: { fileKey: string; fileName: string }[];
  /** The file named like this sample that it was NOT paired with, and why. */
  near?: {
    fileKey: string;
    fileName: string;
    /** What this sample records that the file does not: it is another acquisition. */
    differ: IdentityDifference[];
    /** The other samples the file could be. */
    others: number[];
    /** The sample the user said the file is, when it is not this one. */
    chosenElsewhere?: number;
    /**
     * The sample the file IS by its $FIL and keywords, when this one is only named like it and
     * records nothing confirming it.
     */
    outrankedBy?: number;
    /**
     * Every file that could be this sample, when several could and neither the keywords nor a
     * choice tells which: the user says which (a file -> sample choice), once. One per acquisition:
     * a copy of a file (its keywords confirm it) goes with that file, as `copies`.
     */
    rivals?: { fileKey: string; fileName: string; copies?: { fileKey: string; fileName: string }[] }[];
    /**
     * Every file that could be this sample or another (`others`), where more than one could: the
     * row names each. It named only the last file read.
     */
    files?: { fileKey: string; fileName: string }[];
  };
  /**
   * Left unpaired because neither its well label nor its event count can say which data set it
   * is: the open data sets of one file it could be, where another data set of the file, open or
   * not, might be it too, or another sample joins the same data set.
   */
  tiedWith?: string[];
}

/** A file the dialog holds that no sample is: named here, so the result can say it follows the tree. */
export interface FlowJoUnpairedFile {
  fileKey: string;
  fileName: string;
  why: "contradicted" | "ambiguous" | "none";
  /** The samples named like it. */
  candidates: number[];
  /** What the one sample named like it records that the file does not, when there is one. */
  differ: IdentityDifference[];
  /**
   * A data set of a multi-data-set file left unpaired because an event count or well label that
   * another data set or sample shares cannot say which sample it is (FlowJoFileResolution.tiedWith).
   */
  tied?: boolean;
  /** The file that is its one candidate sample instead: chosen, or confirmed where it is not. */
  pairedWith?: string;
  /** That file's key, so a result can tell it from another of the same name. */
  pairedWithKey?: string;
  /** The other files that could each be its one candidate sample, when none was chosen. */
  rivals?: string[];
  /** Their keys, in the same order. */
  rivalKeys?: string[];
  /**
   * The file this one is a copy of (their keywords confirm one acquisition), when that file is
   * one of the files the sample could be: this one goes with it, and is not a choice of its own.
   */
  copyOf?: string;
  copyOfKey?: string;
}

export interface FlowJoWorkspacePairing {
  resolutions: FlowJoFileResolution[];
  /** Files several samples could be, still to be chosen, with the samples they could be. */
  ambiguous: { fileKey: string; fileName: string; candidates: number[] }[];
  /**
   * Samples several files could be, still to be chosen: files that are not copies of one
   * acquisition, and that nothing tells apart. The user says which file is the sample.
   */
  contested: { sampleIndex: number; files: { fileKey: string; fileName: string; copies?: { fileKey: string; fileName: string }[] }[] }[];
  unpaired: FlowJoUnpairedFile[];
}

/** How pairFlowJoWorkspaceFiles treats the data sets of a multi-data-set file. */
export interface FlowJoPairingOptions {
  /**
   * Events of a file, by name, for telling data sets of one file apart. A file's own $TOT is
   * used where this does not name it.
   */
  events?: ReadonlyMap<string, number>;
  /**
   * Let samples naming one file with DIFFERENT well labels share it. For files not yet read,
   * which may hold one data set per well; once read, each data set is a sample of its own
   * name and nothing is shared.
   */
  shareAcrossWells?: boolean;
  /**
   * Data sets open that are not among the files being paired (the viewed file, when the other
   * loaded files are paired with their own samples): each is open, so it is no data set of its
   * file that "might be" a sample unseen, and another sample of its count could be it.
   */
  alsoOpen?: readonly { name: string; events?: number | null }[];
}

const asWorkspaceFile = (f: string | FlowJoWorkspaceFile): FlowJoWorkspaceFile =>
  typeof f === "string" ? { key: f, name: f, keywords: null } : f;

/** Whether a file's first TEXT points to a further data set: $NEXTDATA other than 0. */
function holdsFurtherDataSets(keywords: Readonly<Record<string, string>> | null | undefined): boolean {
  const next = Object.entries(keywords ?? {}).find(([k]) => k.trim().toUpperCase() === "$NEXTDATA")?.[1];
  const n = next === undefined ? 0 : parseInt(next.trim() || "0", 10);
  return Number.isFinite(n) && n > 0;
}

/** A comparison that says nothing, for a pairing the keywords could not speak to. */
const UNCOMPARED: IdentityComparison = { verdict: "unconfirmed", agree: [], differ: [] };

/**
 * Pair a workspace's samples with the files the user has supplied, one FILE at a time.
 *
 * Each file goes to the sample it is (matchFlowJoSamples' rule), so the first sample in document
 * order no longer claims a file its keywords say belongs to another, and a gated sample no longer
 * takes a file whose own sample is ungated. A file several samples could be is left for the user
 * to choose (`choices`: file key -> sample index); a file whose named sample records another
 * acquisition is paired with nothing. Every sample is reported, found or not: a workspace whose
 * files are partly missing is a normal situation, and the ones that did resolve are still worth
 * importing. A file is never given to two samples, and two files claiming one sample go to the
 * one its keywords confirm, or to neither.
 *
 * Two exceptions come from multi-data-set files. A file not yet read that several samples name
 * with different well labels may hold one data set per well, and under `shareAcrossWells` it
 * stands for each of them; its keywords are its first data set's, so they decide nothing there.
 * And a data set open as a sample of its own ("plate (data set 2 of 4, A02).fcs") that no sample
 * is named after goes, once the named files are paired, to the waiting sample of its own well
 * label, else event count, where no other data set of the file, open or not, might be that sample
 * too and no other sample joins it; otherwise it is left unpaired, with the data sets the sample
 * could be (`tiedWith`), unless the user chose which sample it is.
 */
export function pairFlowJoWorkspaceFiles(
  samples: readonly FlowJoSampleSummary[],
  files: readonly (string | FlowJoWorkspaceFile)[],
  choices: Readonly<Record<string, number>> = {},
  opts: FlowJoPairingOptions = {},
): FlowJoWorkspacePairing {
  type Claim = { file: FlowJoWorkspaceFile; comparison: IdentityComparison; chosen: boolean };
  const claims = new Map<number, Claim[]>();
  const near = new Map<number, NonNullable<FlowJoFileResolution["near"]>>();
  /** Every file several samples could be, by sample: the row names each, not the last one read. */
  const couldBe = new Map<number, { files: { fileKey: string; fileName: string }[]; others: Set<number> }>();
  const ambiguous: FlowJoWorkspacePairing["ambiguous"] = [];
  const unpaired: FlowJoUnpairedFile[] = [];
  const claim = (index: number, file: FlowJoWorkspaceFile, comparison: IdentityComparison, chosen: boolean) =>
    claims.set(index, [...(claims.get(index) ?? []), { file, comparison, chosen }]);
  const namedLike = (name: string) => samples.filter((s) => namesOfSample(s).some((n) => sameFileName(n, name)));
  const wellOf = (s: FlowJoSampleSummary) => fcsDataSetLabelToken(s.dataSetLabel).toLowerCase() || null;
  const all = files.map(asWorkspaceFile);
  // Data sets no sample is named after, paired below once the named files are.
  const dataSetFiles = all.filter((f) => parseFcsDataSetFileName(f.name) !== null && namedLike(f.name).length === 0);
  for (const file of all) {
    if (dataSetFiles.includes(file)) continue;
    // A file that may hold one data set per well: one not yet read that samples name with
    // different well labels, or one whose first TEXT points to a further data set ($NEXTDATA). Its
    // keywords are its first data set's, so they decide nothing about the others' samples; it
    // stands for every sample named like it until it is read, and is then paired again, data set
    // by data set. A file read whose TEXT says it holds one data set is one acquisition, paired
    // by its keywords like any other: shared across wells, it went to each sample unconfirmed,
    // and the open dialog took another acquisition's tree for it by position.
    if (opts.shareAcrossWells && !parseFcsDataSetFileName(file.name)) {
      const named = namedLike(file.name);
      const wells = named.map(wellOf);
      const distinctWells = wells.every((w) => w !== null) && new Set(wells).size === wells.length;
      const mayHoldWells = file.keywords ? holdsFurtherDataSets(file.keywords) : distinctWells;
      if (named.length > 1 && mayHoldWells) {
        for (const s of named) claim(s.index, file, UNCOMPARED, false);
        continue;
      }
    }
    const pairing = pairFile(file, samples, namesOfSample, recordedOfSample);
    const chosen = choices[file.key];
    if (pairing.kind === "ambiguous" && chosen !== undefined) {
      const pick = pairing.candidates.find((c) => c.sample.index === chosen);
      if (pick) {
        claim(pick.sample.index, file, pick.comparison, true);
        for (const c of pairing.candidates) {
          if (c !== pick) near.set(c.sample.index, { fileKey: file.key, fileName: file.name, differ: [], others: [], chosenElsewhere: chosen });
        }
        continue;
      }
    }
    if (pairing.kind === "own") {
      // A choice of this file for its own sample settles a sample several files could be.
      claim(pairing.sample.index, file, pairing.comparison, chosen === pairing.sample.index);
      for (const r of pairing.rejected) {
        near.set(r.sample.index, { fileKey: file.key, fileName: file.name, differ: r.comparison.differ, others: [pairing.sample.index] });
      }
      for (const r of pairing.passedOver ?? []) {
        near.set(r.sample.index, { fileKey: file.key, fileName: file.name, differ: [], others: [], outrankedBy: pairing.sample.index });
      }
      continue;
    }
    if (pairing.kind === "ambiguous") {
      const candidates = pairing.candidates.map((c) => c.sample.index);
      ambiguous.push({ fileKey: file.key, fileName: file.name, candidates });
      unpaired.push({ fileKey: file.key, fileName: file.name, why: "ambiguous", candidates, differ: [] });
      for (const c of pairing.candidates) {
        near.set(c.sample.index, { fileKey: file.key, fileName: file.name, differ: [], others: candidates.filter((i) => i !== c.sample.index) });
        const seen = couldBe.get(c.sample.index) ?? { files: [], others: new Set<number>() };
        seen.files.push({ fileKey: file.key, fileName: file.name });
        for (const i of candidates) if (i !== c.sample.index) seen.others.add(i);
        couldBe.set(c.sample.index, seen);
      }
      for (const r of pairing.rejected) {
        near.set(r.sample.index, { fileKey: file.key, fileName: file.name, differ: r.comparison.differ, others: [] });
      }
      continue;
    }
    if (pairing.kind === "contradicted") {
      const candidates = pairing.candidates.map((c) => c.sample.index);
      unpaired.push({
        fileKey: file.key, fileName: file.name, why: "contradicted", candidates,
        differ: pairing.candidates.length === 1 ? pairing.candidates[0].comparison.differ : [],
      });
      for (const c of pairing.candidates) {
        near.set(c.sample.index, { fileKey: file.key, fileName: file.name, differ: c.comparison.differ, others: [] });
      }
      continue;
    }
    unpaired.push({ fileKey: file.key, fileName: file.name, why: "none", candidates: [], differ: [] });
  }
  const contested: FlowJoWorkspacePairing["contested"] = [];
  const byName = (sample: FlowJoSampleSummary, file: FlowJoWorkspaceFile) =>
    sample.candidateFileNames.some((n) => sameFileName(n, file.name));
  const rank = (c: Claim) => (c.chosen ? 9 : verdictRank(c.comparison.verdict));
  /** Two files of one acquisition: a file and a copy of it, whose keywords confirm each other. */
  const oneAcquisition = (a: Claim, b: Claim) =>
    compareIdentity(identityKeywords(a.file.keywords), identityKeywords(b.file.keywords)).verdict === "confirmed";
  const asFile = (c: Claim) => ({ fileKey: c.file.key, fileName: c.file.name });
  const resolutions = samples.map((sample): FlowJoFileResolution => {
    const all = claims.get(sample.index) ?? [];
    // Two files claiming one sample: the one the keywords confirm, or the one chosen. Files that
    // are one acquisition -- a file and a copy of it under another name, which its $FIL pairs --
    // are each this sample, and each gets its tree; they used to leave the sample with neither.
    // Files nothing tells apart are asked about, once per acquisition: a copy goes with its file,
    // and was offered as a rival of it.
    const best = Math.max(-1, ...all.map(rank));
    const tied = all.filter((c) => rank(c) === best);
    // The claims of one acquisition, grown from `seed` through every claim that confirms a member:
    // the chosen file's copies go with it, though a choice ranks them below it.
    const acquisitionOf = (seed: Claim[]): Claim[] => {
      const members = [...seed];
      for (let grew = true; grew;) {
        grew = false;
        for (const c of all) {
          if (!members.includes(c) && members.some((m) => oneAcquisition(m, c))) { members.push(c); grew = true; }
        }
      }
      return all.filter((c) => members.includes(c));
    };
    const groups: Claim[][] = [];
    for (const c of tied) if (!groups.some((g) => g.includes(c))) groups.push(acquisitionOf([c]));
    // The copy named like the sample stands for it; the others go with it.
    const leadOf = (g: Claim[]) => g.find((c) => byName(sample, c.file)) ?? g[0];
    if (groups.length === 1) {
      const members = groups[0];
      const lead = leadOf(members);
      for (const other of all) {
        if (members.includes(other)) continue;
        unpaired.push({
          fileKey: other.file.key, fileName: other.file.name, why: "ambiguous", candidates: [sample.index], differ: [],
          pairedWith: lead.file.name, pairedWithKey: lead.file.key,
        });
      }
      const copies = members.filter((c) => c !== lead).map(asFile);
      const { file, comparison } = lead;
      return {
        sampleIndex: sample.index,
        fileName: file.name,
        fileKey: file.key,
        matchedName: sample.candidateFileNames.find((n) => sameFileName(n, file.name))
          ?? sample.candidateFileNames.find((n) => sameFileName(n, filOf(file.keywords) ?? ""))
          ?? null,
        status: members.some((c) => c.chosen) ? "chosen" : "own",
        comparison,
        ...(copies.length ? { copies } : {}),
      };
    }
    const rivals = groups.map((g) => {
      const lead = leadOf(g);
      const copies = g.filter((c) => c !== lead).map(asFile);
      return { ...asFile(lead), ...(copies.length ? { copies } : {}) };
    });
    if (groups.length > 1) {
      contested.push({ sampleIndex: sample.index, files: rivals });
      for (const [i, g] of groups.entries()) {
        const lead = leadOf(g);
        const others = rivals.filter((_, j) => j !== i);
        for (const c of g) {
          unpaired.push({
            fileKey: c.file.key, fileName: c.file.name, why: "ambiguous", candidates: [sample.index], differ: [],
            rivals: others.map((o) => o.fileName), rivalKeys: others.map((o) => o.fileKey),
            ...(c !== lead ? { copyOf: lead.file.name, copyOfKey: lead.file.key } : {}),
          });
        }
      }
      // A file that could be the sample, though the files above could more surely: named too. It
      // was in no pairing and in no list of unpaired files.
      for (const c of all) {
        if (groups.some((g) => g.includes(c))) continue;
        unpaired.push({
          fileKey: c.file.key, fileName: c.file.name, why: "ambiguous", candidates: [sample.index], differ: [],
          rivals: rivals.map((o) => o.fileName), rivalKeys: rivals.map((o) => o.fileKey),
        });
      }
    }
    const seen = couldBe.get(sample.index);
    const n = groups.length > 1
      ? { fileKey: rivals[0].fileKey, fileName: rivals[0].fileName, differ: [], others: [], rivals }
      : near.get(sample.index);
    const status: FlowJoFileResolution["status"] = groups.length > 1
      ? "ambiguous"
      : n && n.chosenElsewhere === undefined && n.outrankedBy === undefined ? (n.differ.length ? "contradicted" : "ambiguous") : "missing";
    // Several files could each be this sample or another: every one is named, with every sample.
    const withFiles = n && status === "ambiguous" && !n.rivals && seen && seen.files.length > 1
      ? { ...n, others: [...seen.others].sort((a, b) => a - b), files: seen.files }
      : n;
    return { sampleIndex: sample.index, fileName: null, fileKey: null, matchedName: null, status, ...(withFiles ? { near: withFiles } : {}) };
  });
  if (!dataSetFiles.length) return { resolutions, ambiguous, contested, unpaired };

  // The data sets left, by well label, else event count. A sample is paired with a data set only
  // where no other data set of the file, open or not, might be it too, and no other sample joins
  // that data set: two data sets of one size, or of one well label ("tube1" on every data set),
  // cannot be told apart, and pairing them in list order gave each the other's gates. A data set
  // the file holds that is not open, or whose count is not known, might be any sample of the file.
  // Such a sample is left unpaired, with the open data sets it could be; a data set the user said
  // is one sample is that sample's.
  const eventsOf = (f: FlowJoWorkspaceFile): number | undefined => {
    const given = opts.events?.get(f.name);
    if (given !== undefined) return given;
    const tot = Object.entries(f.keywords ?? {}).find(([k]) => k.trim().toUpperCase() === "$TOT")?.[1];
    const n = tot === undefined ? NaN : parseInt(tot.trim(), 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const alsoOpen = (opts.alsoOpen ?? []).filter((o) => parseFcsDataSetFileName(o.name) !== null);
  const allNames = [...all.map((f) => f.name), ...alsoOpen.map((o) => o.name)];
  const open = [...dataSetFiles.map((f) => ({ name: f.name, events: eventsOf(f) })), ...alsoOpen];
  const taken = new Set<string>();
  const waiting = samples.filter((_, i) => resolutions[i].fileName === null);
  const joins = (s: FlowJoSampleSummary, f: FlowJoWorkspaceFile) =>
    flowJoSampleNamesFile(s, { name: f.name, events: eventsOf(f) }) &&
    compareIdentity(recordedOfSample(s), identityKeywords(f.keywords)).verdict !== "contradicted";
  const settled = resolutions.map((resolution, i): FlowJoFileResolution => {
    if (resolution.fileName !== null) return resolution;
    const sample = samples[i];
    const could = dataSetFiles.filter((f) => joins(sample, f));
    const chosenFile = could.find((f) => !taken.has(f.key) && choices[f.key] === sample.index);
    const elsewhere = (f: FlowJoWorkspaceFile) => otherDataSetsItMightBe(sample, f.name, open);
    const tied = (f: FlowJoWorkspaceFile) => elsewhere(f).length > 0 || unopenedDataSets(f.name, allNames) > 0 ||
      waiting.some((other) => other !== sample && joins(other, f));
    const hit = chosenFile ?? could.find((f) => !taken.has(f.key) && choices[f.key] === undefined && !tied(f));
    if (hit === undefined) {
      if (!could.length || !could.every(tied)) return resolution;
      const might = new Set(could.flatMap((f) => [f.name, ...elsewhere(f)]));
      return { ...resolution, status: "ambiguous", tiedWith: dataSetFiles.map((f) => f.name).filter((f) => might.has(f)) };
    }
    taken.add(hit.key);
    return {
      sampleIndex: sample.index,
      fileName: hit.name,
      fileKey: hit.key,
      matchedName: parseFcsDataSetFileName(hit.name)!.fileName,
      status: chosenFile ? "chosen" : "own",
      comparison: compareIdentity(recordedOfSample(sample), identityKeywords(hit.keywords)),
    };
  });
  for (const f of dataSetFiles) {
    if (taken.has(f.key)) continue;
    const couldBe = settled.filter((r) => r.tiedWith?.includes(f.name)).map((r) => r.sampleIndex);
    unpaired.push({
      fileKey: f.key, fileName: f.name, why: couldBe.length ? "ambiguous" : "none", candidates: couldBe, differ: [],
      ...(couldBe.length ? { tied: true } : {}),
    });
  }
  return { resolutions: settled, ambiguous, contested, unpaired };
}

/**
 * Match a workspace's samples to a set of files the user has supplied: every sample, with the file
 * that is it or null. See pairFlowJoWorkspaceFiles, which also says which files are unpaired.
 */
export function resolveFlowJoWorkspaceFiles(
  samples: readonly FlowJoSampleSummary[],
  files: readonly (string | FlowJoWorkspaceFile)[],
  choices: Readonly<Record<string, number>> = {},
  opts: FlowJoPairingOptions = {},
): FlowJoFileResolution[] {
  return pairFlowJoWorkspaceFiles(samples, files, choices, opts).resolutions;
}

/**
 * The supplied files that ARE samples carrying no gates, by key.
 *
 * Paired with every sample of the workspace at once, gated or not, by the same rule, so a file
 * whose own sample is an ungated compensation control is data even when a gated sample shares its
 * name -- the gated sample used to win it, and its gates were imported onto the control. A data
 * set that only samples without gates could be, left unpaired for a shared event count, is data
 * whichever of them it is.
 */
export function ungatedWorkspaceFiles(
  gated: readonly FlowJoSampleSummary[],
  ungated: readonly FlowJoSampleSummary[],
  files: readonly (string | FlowJoWorkspaceFile)[],
  choices: Readonly<Record<string, number>> = {},
  opts: FlowJoPairingOptions = {},
): Set<string> {
  const ungatedIndex = new Set(ungated.map((s) => s.index));
  const resolved = resolveFlowJoWorkspaceFiles([...gated, ...ungated].sort((a, b) => a.index - b.index), files, choices, opts);
  const keyOf = new Map(files.map(asWorkspaceFile).map((f) => [f.name, f.key]));
  const byGated = resolved.filter((r) => !ungatedIndex.has(r.sampleIndex));
  const gatedFiles = new Set(byGated.flatMap((r) => [...(r.fileName !== null ? [r.fileName] : []), ...(r.tiedWith ?? [])]));
  return new Set([
    // A file an ungated sample is, and every copy of it (fix/multitree-import).
    ...resolved.filter((r) => r.fileKey !== null && ungatedIndex.has(r.sampleIndex))
      .flatMap((r) => [r.fileKey!, ...(r.copies ?? []).map((c) => c.fileKey)]),
    // A data set that only samples without gates could be, left unpaired for a shared event count,
    // is data whichever of them it is (fix/fcs-read-write).
    ...resolved
      .filter((r) => ungatedIndex.has(r.sampleIndex))
      .flatMap((r) => r.tiedWith ?? [])
      .filter((f) => !gatedFiles.has(f))
      .map((f) => keyOf.get(f) ?? f),
  ]);
}

/**
 * A sample's matrix as the converter reads it (sampleCompensation). `spill` is the matrix its
 * compensated dimensions are evaluated with. `identity` is the sample's own matrix when it
 * compensates nothing: FlowJo applies it, and a compensated parameter is then its stored value.
 * `declined` is the sample's own matrix when GateLab cannot apply it, with why; a tree whose
 * compensated dimensions need it is refused (flowJoWorkspaceToGatingML), never evaluated on
 * uncompensated values or with another matrix.
 */
interface SampleCompensation {
  spill: FlowJoSpillover | null;
  identity: FlowJoSpillover | null;
  declined: DeclinedMatrix | null;
}

/** A `transforms:spilloverMatrix` GateLab does not apply, and why, in words for the user. */
interface DeclinedMatrix {
  name: string;
  prefix: string;
  suffix: string;
  why: string;
}

type MatrixReading =
  | { kind: "matrix" | "identity"; spill: FlowJoSpillover }
  | ({ kind: "declined" } & DeclinedMatrix);

/**
 * Read one `transforms:spilloverMatrix` element.
 *
 * Orientation is chosen to match `parseSpillover()` in `fcs.ts` exactly, so the result can be
 * used anywhere an embedded `$SPILLOVER` can: `matrix[i][j]` is the coefficient of the row
 * parameter `channels[i]` in the column parameter `channels[j]`. Rows are indexed by their
 * declared parameter rather than by document order, so a workspace that writes them in a
 * different order still yields the same matrix.
 *
 * `spectral="1"` is how FlowJo (10.6 on) writes a matrix its spectral compensation computed; one
 * written by 10.10 also names its weighting, weightOptAlgorithmType="OLS". Each row is a
 * fluorochrome's signature across the detectors, scaled so that its largest coefficient is 1.
 * Where the rows and the columns are the same parameters, the least-squares unmixing is exact and
 * is X·inv(M), the conventional compensation, so such a matrix is read as a spillover matrix.
 * FlowKit 1.3.1 unmixes one naming OLS by least squares (flowutils' compensate_spectral_ols), which
 * is that product, and cannot read one naming no weighting (a KeyError on weightOptAlgorithmType);
 * CytoML reads the element as an ordinary spillover matrix whatever the attribute says; and numpy
 * with the matrix as written gives FlowJo's own counts (the public FR-FCM-Z2JN Panel_B1.wsp,
 * FlowJo 10.6.2: "CD21-CD23-" 6,005 and "Single Cells" 161,314, where the same gates on the stored
 * values hold 1,055 and 158,979). Each row of every square spectral matrix in the FlowRepository
 * corpus has a largest coefficient of 1, but not always on its own detector: Panel_B2.wsp's FL10-A
 * row is 0.808 on FL10-A and 1 on FL9-A, and FlowJo applies it as written ("Viable" 179,246; the
 * rows rescaled to a unit diagonal give 181,080). A matrix with more detectors than rows, or
 * another weighting, is an unmixing GateLab does not do, and is declined; until 2026-09-26 every
 * spectral matrix was.
 */
function readSpilloverMatrix(el: Element): MatrixReading {
  const name = el.getAttribute("name") ?? "";
  const prefix = el.getAttribute("prefix") ?? "";
  const suffix = el.getAttribute("suffix") ?? "";
  const decline = (why: string): MatrixReading => ({ kind: "declined", name, prefix, suffix, why });
  const spectral = (el.getAttribute("spectral") ?? "0") !== "0";
  const weighting = el.getAttribute("weightOptAlgorithmType");
  if (spectral && weighting !== null && weighting !== "OLS") {
    return decline(`it is a spectral unmixing weighted by ${weighting}, which GateLab does not apply`);
  }

  const params = Array.from(el.getElementsByTagNameNS(DATATYPE_NS, "parameter"))
    .map((p) => p.getAttributeNS(DATATYPE_NS, "name") ?? "")
    .filter((n) => n.length > 0);
  if (params.length < 2) return decline("it lists fewer than two parameters");
  const index = new Map(params.map((n, i) => [n, i]));

  const matrix: number[][] = params.map(() => params.map(() => 0));
  let rowsSeen = 0;
  for (const row of Array.from(el.getElementsByTagNameNS(TRANSFORMS_NS, "spillover"))) {
    const rowName = row.getAttributeNS(DATATYPE_NS, "parameter") ?? "";
    const i = index.get(rowName);
    if (i === undefined) return decline(`its row "${rowName}" is not one of the parameters it lists`);
    rowsSeen++;
    for (const coef of Array.from(row.getElementsByTagNameNS(TRANSFORMS_NS, "coefficient"))) {
      const column = coef.getAttributeNS(DATATYPE_NS, "parameter") ?? "";
      const j = index.get(column);
      if (j === undefined) {
        return decline(spectral
          ? `it unmixes its ${params.length} parameters from detectors it does not list as parameters ("${column}"), which GateLab does not do`
          : `its coefficient for "${column}" is not one of the parameters it lists`);
      }
      const v = Number(coef.getAttributeNS(TRANSFORMS_NS, "value"));
      if (!Number.isFinite(v)) return decline(`its coefficient of "${rowName}" in "${column}" is not a number`);
      matrix[i][j] = v;
    }
  }
  if (rowsSeen !== params.length) return decline(`it gives ${rowsSeen} rows for its ${params.length} parameters`);

  // A matrix is applied as written, X·inv(M), in a convention FlowJo is seen to apply so; one in
  // any other is declined, since silently using it would change every gated population. A
  // spectral matrix is held to its own convention, a largest coefficient of 1 in each row. A
  // conventional one has a unit diagonal, or is the inverse of a matrix with one: an Accuri C6
  // writes its $SPILLOVER as the inverse of the unit-diagonal compensation matrix it keeps as
  // percentages (#BDACCURI4COLORCOMP), so its diagonal runs a little over 1 while the compensation
  // X·inv(M) keeps each detector's own signal at 1. The public FR-FCM-ZYCB
  // VALIDATION_CD25_CD127.wsp (FlowJo 10.3) carries such a matrix, "Acquisition-defined", diagonal
  // 1.003 to 1.006, its inverse's 0.9995 to 1.0003; numpy with it as written and FlowJo's grid
  // gives FlowJo's count in all 7 populations of the sample compared ("CD25+FOXP3+" 1,235), the
  // rows rescaled to a unit diagonal in 1 (1,262) and the stored values in 1 (8,146). Until
  // 2026-09-26 such a matrix was declined and its tree refused. The only other conventional matrix
  // in the FlowRepository corpus with a diagonal off 1 is an all-zero placeholder, which has no
  // inverse and is declined.
  //
  // The tolerance is loose because a real instrument-derived diagonal is not exactly 1: the Diva
  // matrix in the Priest et al. 2024 sort workspace runs 0.9999999974 to 1.0000020054, and the
  // Accuri's coefficients carry three decimals. The test exists to catch a different convention
  // entirely, such as a percentage-scaled or half-unit matrix, whose diagonal and whose inverse's
  // are both wrong by a factor, not by parts per thousand; the corpus has none, and no evidence of
  // what FlowJo makes of one.
  if (spectral) {
    const off = matrix.findIndex((row) => Math.abs(Math.max(...row) - 1) >= 1e-3);
    if (off >= 0) {
      return decline(`its row "${params[off]}" has a largest coefficient of ${Math.max(...matrix[off])}, not 1, ` +
        "so it is not a spectral matrix in FlowJo's convention");
    }
  } else {
    const off = matrix.findIndex((row, i) => Math.abs(row[i] - 1) >= 1e-3);
    if (off >= 0) {
      const inverse = invertMatrix(matrix);
      if (inverse === null) {
        return decline(`its diagonal is ${matrix[off][off]} at "${params[off]}", not 1, and it has no inverse, ` +
          "so it cannot be applied");
      }
      const invOff = inverse.findIndex((row, i) => Math.abs(row[i] - 1) >= 1e-3);
      if (invOff >= 0) {
        return decline(`its diagonal is ${matrix[off][off]} at "${params[off]}", not 1, nor is its inverse's ` +
          `(${Number(inverse[invOff][invOff].toPrecision(6))} at "${params[invOff]}"), so it is not a spillover ` +
          "matrix in a convention GateLab compensates with");
      }
    }
  }
  const spill = { name, prefix, suffix, matrix: { channels: params, matrix } };
  // Identity means no real compensation, matching parseSpillover()'s behaviour.
  const identity = matrix.every((row, i) => row.every((v, j) => (i === j ? Math.abs(v - 1) < 1e-9 : Math.abs(v) < 1e-9)));
  return { kind: identity ? "identity" : "matrix", spill };
}

/**
 * The matrix belonging to one sample.
 *
 * FlowJo writes the sample's own matrix inside its `Sample` element and also copies it into the
 * workspace-level `Matrices` block, alongside others that belong to different samples (an
 * "Acquisition-defined" entry is usually present too). Reading the sample's own copy is therefore
 * the only unambiguous choice; the workspace-level block is consulted only when the sample has no
 * matrix of its own and exactly one candidate exists there. A sample whose own matrix is declined
 * or an identity is not given another: until 2026-09-26 either fell through to the workspace-level
 * block, and a unique matrix there, another sample's, was applied.
 */
function sampleCompensation(sampleNode: Element): SampleCompensation {
  const owner = sampleNode.parentElement;
  const own = owner ? childrenByLocalName(owner, "spilloverMatrix").map(readSpilloverMatrix) : [];
  if (own.length) {
    const usable = own.find((r) => r.kind === "matrix");
    if (usable && usable.kind === "matrix") return { spill: usable.spill, identity: null, declined: null };
    const identity = own.find((r) => r.kind === "identity");
    if (identity && identity.kind === "identity") return { spill: null, identity: identity.spill, declined: null };
    const first = own[0];
    return { spill: null, identity: null, declined: first.kind === "declined" ? first : null };
  }
  const doc = sampleNode.ownerDocument;
  if (!doc) return { spill: null, identity: null, declined: null };
  const all = Array.from(doc.getElementsByTagNameNS(TRANSFORMS_NS, "spilloverMatrix"))
    .map(readSpilloverMatrix)
    .flatMap((r) => (r.kind === "matrix" ? [r.spill] : []));
  const distinct = new Map(all.map((m) => [m.name, m]));
  return { spill: distinct.size === 1 ? [...distinct.values()][0] : null, identity: null, declined: null };
}

/** The uncompensated parameter behind a possibly prefixed dimension name, or null. */
function uncompensatedName(raw: string, spill: FlowJoSpillover): string | null {
  const { prefix, suffix } = spill;
  if (prefix && !raw.startsWith(prefix)) return null;
  if (suffix && !raw.endsWith(suffix)) return null;
  const base = raw.slice(prefix.length, suffix ? raw.length - suffix.length : undefined);
  // The stripped name must actually be in the matrix. Without this a scatter parameter would be
  // mistaken for a compensated one whenever the prefix is empty.
  return spill.matrix.channels.includes(base) ? base : null;
}

/**
 * Name each dimension in the uncompensated space and say which compensation it needs.
 *
 * The workspace states neither: gate dimensions are written as `Comp-BV786-A` with no
 * `gating:compensation-ref` at all. Left alone, `Comp-BV786-A` resolves to the uncompensated
 * `BV786-A` by channel-name normalisation, so the gates import cleanly and land in the wrong
 * space — the failure is invisible. Making the reference explicit here is what lets the ordinary
 * Gating-ML compensation check reject the import instead.
 *
 * A compensated dimension the sample's matrix cannot supply goes into `unresolved`, or into
 * `declined` when the sample's own matrix is one GateLab does not apply; the converter refuses a
 * tree with any of the latter, and marks its document so that the import refuses one with any of
 * the former unless a matrix covers it (COMPENSATED_FCS_MARK).
 */
function nameDimensionsAndRefs(
  gate: Element,
  comp: SampleCompensation,
  unresolved: Set<string>,
  declined: Set<string>,
): void {
  const { spill, identity } = comp;
  for (const dimEl of Array.from(gate.getElementsByTagNameNS(DATATYPE_NS, "fcs-dimension"))) {
    const raw = dimEl.getAttributeNS(DATATYPE_NS, "name") ?? "";
    const owner = dimEl.parentElement;
    if (!owner) continue;
    const base = spill ? uncompensatedName(raw, spill) : null;
    if (base !== null) {
      dimEl.setAttributeNS(DATATYPE_NS, "data-type:name", base);
      owner.setAttributeNS(GATING_NS, "gating:compensation-ref", "FCS");
      continue;
    }
    // The sample's own matrix is an identity: FlowJo applies it, and each parameter it compensates
    // is that parameter's stored value, which is what the gate is evaluated on, whatever matrix the
    // FCS file carries.
    const same = identity ? uncompensatedName(raw, identity) : null;
    if (same !== null) {
      dimEl.setAttributeNS(DATATYPE_NS, "data-type:name", same);
      owner.setAttributeNS(GATING_NS, "gating:compensation-ref", "uncompensated");
      continue;
    }

    const prefix = spill?.prefix || identity?.prefix || comp.declined?.prefix || CONVENTIONAL_COMP_PREFIX;
    if (prefix && raw.startsWith(prefix)) {
      // Compensated, but nothing here can supply the matrix — either none was found, or this
      // parameter is not in the one that was. The requirement is still declared, and the name
      // still stripped so it resolves to a real parameter, precisely so the ordinary Gating-ML
      // compensation check refuses the import. Marking it uncompensated instead would let the
      // gate land on raw data and look like a clean import.
      dimEl.setAttributeNS(DATATYPE_NS, "data-type:name", raw.slice(prefix.length));
      owner.setAttributeNS(GATING_NS, "gating:compensation-ref", "FCS");
      (comp.declined ? declined : unresolved).add(raw);
      continue;
    }
    owner.setAttributeNS(GATING_NS, "gating:compensation-ref", "uncompensated");
  }
}

/**
 * Rewrite one sample's gates as a Gating-ML 2.0 document.
 *
 * Names come from `Population@name` and ancestry from the nesting, so neither FlowJo's gate ids
 * nor any `custom_info` convention is relied on for structure.
 */
export function flowJoWorkspaceToGatingML(
  xmlText: string,
  sampleIndex: number,
  /**
   * Which of the sample's independent trees to import. GateLab holds exactly one strategy, so a
   * sample with several must be narrowed to one rather than silently merged. Null imports them
   * all, which is reported as the merge it is.
   */
  treeIndex: number | null = null,
  /**
   * What the warning about a merge of several trees tells the user to do. The app merges a
   * sample's trees only under "One hierarchy per file", where no tree can be chosen, so it says
   * what can be done there instead.
   */
  mergedTreesAdvice = "Choose one to import it alone.",
  /** How FlowJo's gates are evaluated; see FlowJoImportOptions. FlowJo's own rule by default. */
  options: FlowJoImportOptions = {},
): FlowJoConversion {
  const flowJoGrid = options.flowJoGrid ?? true;
  const say = options.translate ?? inEnglish;
  /** A list of named items as the notes give them: the first six, and how many more. */
  const listed = (items: string[]): string =>
    items.slice(0, 6).join(say("; ")) + (items.length > 6 ? say("; and {count} more.", { count: items.length - 6 }) : say("."));
  const doc = parseWorkspace(xmlText);
  refuseOlderGatingML(doc, say);
  const floorsLogVertexAtZero = logVertexAtZeroOnFloor(doc.documentElement?.getAttribute("flowJoVersion"));
  const nodes = sampleNodes(doc);
  const node = nodes[sampleIndex];
  if (!node) {
    throw new Error(
      `This workspace has no sample at position ${sampleIndex + 1}; it holds ${nodes.length}.`,
    );
  }
  const sampleName = node.getAttribute("name") ?? `sample ${sampleIndex + 1}`;

  const out = new DOMParser().parseFromString(
    `<gating:Gating-ML xmlns:gating="${GATING_NS}" xmlns:data-type="${DATATYPE_NS}"/>`,
    "application/xml",
  );
  const root = out.documentElement;

  const warnings: string[] = [];
  const flowJoCounts: Record<string, number> = {};
  const idOf = new Map<Element, string>();
  /** Each population's emitted gate, so a dropped intersection can take its subtree with it. */
  const copyOf = new Map<Element, Element>();
  /** AndNode and NotNode elements in walk order, resolved once every gate has an id. */
  const booleanNodes: Element[] = [];
  /** The gate copy a NotNode carries, kept only as a fallback when its Dependent cannot be read. */
  const embeddedOf = new Map<Element, Element>();
  let andSerial = 0;
  let notSerial = 0;
  const compensation = sampleCompensation(node);
  const spill = compensation.spill;
  const unresolvedCompensated = new Set<string>();
  /** Compensated dimensions that need the sample's own matrix, which GateLab does not apply. */
  const declinedCompensated = new Set<string>();
  /** The trees (their top populations) holding a gate on one of those. */
  const declinedTrees = new Set<Element>();
  const transformKinds = workspaceTransformKinds(node);
  const transformSpecs = workspaceTransformSpecs(node);
  const channelMaps = workspaceChannelMaps(node);
  const linearRanges = workspaceLinearRanges(node);
  const gridAxes = workspaceGridAxes(node);
  /** Polygons put on FlowJo's grid, and those the option could not put there, with why. */
  let gridPolygons = 0;
  let gateLabPolygons = 0;
  const offGrid = new Map<string, string>();
  /** Polygons put on a grid of another resolution than 256, which no count has been compared at. */
  const otherResolution = new Map<string, number>();
  /** gate name → the non-representable transforms its axes are displayed with. */
  const approximated = new Map<string, Set<string>>();
  let carried = 0;
  let serial = 0;
  /** The gate element emitGate last appended, for a caller that must mark it. */
  let lastEmitted: Element | null = null;

  const roots = rootPopulations(node);
  const trees = sampleTrees(node);
  if (treeIndex !== null && !trees[treeIndex]) {
    throw new Error(
      `"${sampleName}" has no gating tree at position ${treeIndex + 1}; it holds ${trees.length}.`,
    );
  }
  const selectedRoots = treeIndex === null ? roots : trees[treeIndex];
  const qualifiedNames = qualifiedPopulationNames(selectedRoots);
  const timestep = sampleTimeScale(node);

  const visitPopulation = (pop: Element, depth: number): boolean => {
    const name = qualifiedNames.get(pop) ?? pop.getAttribute("name") ?? `population_${serial + 1}`;
    const count = Number(pop.getAttribute("count"));

    // A Boolean node has no gate of its own: an AndNode names the populations it intersects,
    // and a NotNode names the population it is the complement of. Resolving those needs gate
    // ids that are still being assigned, so both are collected here and written out once the
    // walk is done. Each takes an id of its own, so what FlowJo gated beneath it can name it as
    // its parent, and the walk goes on into it.
    if (pop.localName === "AndNode") {
      booleanNodes.push(pop);
      idOf.set(pop, `wsp_and_${++andSerial}`);
      if (Number.isFinite(count)) flowJoCounts[name] = count;
      return true;
    }
    if (pop.localName === "NotNode") {
      // FlowJo stores a COPY of the negated gate inside the NotNode, and on a workspace whose
      // gates are tailored per sample that copy goes stale: on FR-FCM-Z2V4 the copy inside
      // "debris-" differs from the debris gate the sample carries, and FlowJo's own count for
      // the NOT population is the complement of the current gate, not of the copy. Reading the
      // copy put that population 6% of the file out and every population beneath it with it.
      // The copy is kept only for the case where the named population cannot be read.
      booleanNodes.push(pop);
      idOf.set(pop, `wsp_not_${++notSerial}`);
      if (Number.isFinite(count)) flowJoCounts[name] = count;
      const embedded = gateElementOf(pop).el;
      if (embedded) embeddedOf.set(pop, embedded);
      return true;
    }
    if (pop.localName === "OrNode") {
      // One operator per population is GateLab's model, and OR across references has no
      // faithful form in it. Reported rather than imported as something else -- it used to be
      // dropped in silence, along with everything beneath it.
      if (Number.isFinite(count)) flowJoCounts[name] = count;
      warnings.push(
        `"${name}" combines its references with OR, which GateLab cannot represent; it and ` +
        `anything below it were skipped.`,
      );
      return false;
    }

    const { el, unsupported } = gateElementOf(pop);

    if (!el) {
      warnings.push(
        unsupported
          ? `"${name}" uses ${unsupported}, which this importer does not read yet; it and anything below it were skipped.`
          : `"${name}" has no gate; it and anything below it were skipped.`,
      );
      return false;
    }

    if (Number.isFinite(count)) flowJoCounts[name] = count;
    if (el.localName === "CurlyQuad") {
      const cross = curlyQuadCrosshair(el);
      if (cross) return visitCurlyQuad(pop, el, name, depth, cross);
    }
    // A helper GateLab's export added holds a gate of GateLab's, written with its "/" as
    // WSP_OPERAND_SLASH so that the paths naming it stay paths; the gate takes its own name back.
    return emitGate(pop, el, isOperandHelper(pop) ? name.split(WSP_OPERAND_SLASH).join("/") : name, depth);
  };

  /**
   * Emit one population's gate into the document, in the space FlowJo evaluates it in. `gateId`
   * overrides FlowJo's own id; the NotNode fallback passes the id the node's children already
   * name as their parent, so they keep pointing at it. `register` false emits a gate that is
   * not the population's own (a curly quadrant's shared crosshair), so the population keeps
   * whatever id it was given and the element is only recorded in `lastEmitted`.
   */
  /**
   * The grid a FlowJo polygon is tested on, or why it stays continuous. FlowJo's rule is
   * established for polygons that declare a gateResolution, on unit-gain linear, log and biex axes;
   * a quadrant gate's panel (quadId 0 to 3; flowjoGrid.ts says why), a Time axis and any other axis
   * are left continuous.
   */
  const gridFor = (
    el: Element, axes: [string, string],
  ): { x: FlowJoGridSpec; y: FlowJoGridSpec } | { why: string } => {
    const resolution = el.getAttribute("gateResolution");
    const channels = resolution === null || resolution === "" ? NaN : Number(resolution);
    if (!(Number.isInteger(channels) && channels >= 2 && channels <= 65536)) {
      return { why: say("declares no gate resolution") };
    }
    // Every ordinary polygon says quadId="-1"; 0 to 3 is one panel of a quadrant gate.
    const quadId = Number(el.getAttribute("quadId") ?? "-1");
    if (Number.isFinite(quadId) && quadId >= 0) return { why: say("is a panel of a quadrant gate") };
    const specs: FlowJoGridSpec[] = [];
    for (const ch of axes) {
      if (isTimeAxis(ch)) return { why: say("is on a Time axis") };
      const axis = gridAxes.get(ch) ?? gridAxes.get(ch.replace(/^Comp-/, ""));
      if (!axis) return { why: say("is on {channel}, whose axis FlowJo's grid is not established for", { channel: ch }) };
      specs.push({ kind: "flowjoChannels", channels, axis });
    }
    return { x: specs[0], y: specs[1] };
  };

  const emitGate = (
    pop: Element, el: Element, name: string, depth: number, gateId?: string, register = true,
  ): boolean => {
    const imported = out.importNode(el, true) as Element;
    // A curly quadrant whose crosshair could not be read carries a rectangle's content under
    // another name; it becomes one here so every later step sees the gate kind it describes.
    const copy = imported.localName === "CurlyQuad"
      ? curlyQuadAsRectangle(out, imported)
      : imported;
    const declinedHere = new Set<string>();
    nameDimensionsAndRefs(copy, compensation, unresolvedCompensated, declinedHere);
    if (declinedHere.size) {
      for (const raw of declinedHere) declinedCompensated.add(raw);
      let top = pop;
      for (let up = top.parentElement?.parentElement; up && POPULATION_NODES.has(up.localName); up = top.parentElement?.parentElement) top = up;
      declinedTrees.add(top);
    }
    // FlowJo's own rectangle, not the crosshair a curly quadrant stands on (register is false
    // for that one, and its bounds are the crosshair, not edges).
    const flowJoRectangle = register && imported.localName === "RectangleGate";

    // FlowJo stores vertices raw but evaluates the gate as straight lines in the axis's DISPLAY
    // space. Where GateLab can hold that space, the vertices are moved into it and the gate is
    // marked as living there, so it reproduces FlowJo's boundary rather than a straight-in-raw
    // lookalike. Where it cannot, the gate still imports — straight in raw — and is named.
    const axes = gateAxisNames(el);
    const specFor = (ch: string): TransformSpec | undefined =>
      transformSpecs.get(ch) ?? transformSpecs.get(ch.replace(/^Comp-/, ""));
    const sx = axes ? specFor(axes[0]) : undefined;
    const sy = axes ? specFor(axes[1]) : undefined;
    // A Time axis comes back from FlowJo's units to the file's ticks first (see sampleTimeScale);
    // any display transform is applied on top of that, exactly as FlowJo built it. A range (a
    // histogram's gate) has one dimension and no pair of axes, and its Time bound is in seconds
    // all the same: without the step a [10, 50] s range was read as ticks 10 to 50, and held 138
    // events where 14,573 lie in it.
    const range = axes ? null : dimensionNames(el);
    const rangeOnTime = range !== null && range.length === 1 && isTimeAxis(range[0]);
    const stepX = timestep !== null && (axes ? isTimeAxis(axes[0]) : rangeOnTime) ? timestep : 1;
    // A range's one dimension is both of the axes GateLab holds it on.
    const stepY = axes ? (timestep !== null && isTimeAxis(axes[1]) ? timestep : 1) : stepX;
    const timeScaled = stepX !== 1 || stepY !== 1;
    // FlowJo's rectangle rule, with the option on only; off, the rectangle is the one drawn.
    // FlowJo compares a rectangle in raw units. It moves an event beyond a linear axis's range onto
    // the axis's edge, and one below a biex axis's table or a log axis's offset onto that bottom,
    // and pins nothing at a biex or log axis's top. So a bound at or beyond where FlowJo pins is
    // opened here, on every dimension, a histogram's single one included, in FlowJo's stored units
    // before any transform or Time step, and biex and log axes are compared in raw units below. A
    // rectangle lying wholly beyond where FlowJo pins on one axis holds no event by FlowJo's rule;
    // it is left as drawn on every axis, and named.
    const rawRule = flowJoGrid && flowJoRectangle;
    /** The bounds FlowJo saved, before the rule opened any; see writeFlowJoAxes. */
    const saved = rawRule ? rectangleBoundValues(copy) : null;
    if (rawRule) {
      // Named as the workspace names them, on the element before nameDimensionsAndRefs renamed them.
      const pins = childrenByLocalName(el, "dimension").map((d) => {
        const fcs = childrenByLocalName(d, "fcs-dimension")[0];
        const ch = fcs ? (fcs.getAttributeNS(DATATYPE_NS, "name") ?? fcs.getAttribute("data-type:name")) : null;
        const spec = ch ? specFor(ch) : undefined;
        if (spec?.kind === "biex") {
          return { ch, where: say("the bottom of FlowJo's biex table"), bottom: biexBreakpoints({ ...spec, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS }).raw[0] };
        }
        if (spec?.kind === "wsplog") return { ch, where: say("the log axis's offset"), bottom: spec.offset };
        return null;
      });
      const below = pins.findIndex((pin, i) => pin !== null && liesBelow(copy, i, pin.bottom));
      const beyond = below < 0 ? openLinearRangeEdges(copy, linearRanges) : null;
      if (below >= 0) {
        const pin = pins[below]!;
        warnings.push(say(
          "\"{name}\" lies wholly below {where} on {channel} ({bound}). FlowJo places every event below it there, " +
          "so by FlowJo's rule this gate holds none; GateLab tests the recorded values, and counts the events that " +
          "fall inside its drawn bounds.",
          { name, where: pin.where, channel: pin.ch ?? "", bound: fmtBound(pin.bottom) },
        ));
      } else if (beyond) {
        warnings.push(say(
          "\"{name}\" lies wholly beyond the {channel} axis range ({min} to {max}). FlowJo places every event " +
          "beyond the range on the axis edge, so it counts none inside this gate; GateLab tests the recorded " +
          "values, and counts the events that fall inside its drawn bounds.",
          { name, channel: beyond.axis, min: String(beyond.min), max: String(beyond.max) },
        ));
      } else {
        pins.forEach((pin, i) => { if (pin) openLowerBoundAtOrBelow(copy, i, pin.bottom); });
      }
    }

    // A polygon GateLab evaluates continuously and wrote itself comes back as GateLab held it,
    // whatever the option says (polygonRecord.ts). The record is read off the element as the file
    // states it, so a polygon FlowJo has moved since is FlowJo's own again.
    const ownPolygon = copy.localName === "PolygonGate" && register ? gateLabPolygonRecord(el) : null;
    if (ownPolygon) {
      restoreGateLabPolygon(out, copy, ownPolygon);
      writeFlowJoPolygonAttributes(out, copy, el);
      if (ownPolygon.space === "display") carried++;
      gateLabPolygons++;
    } else if (copy.localName === "EllipsoidGate") {
      // Ellipsoids arrive in display channels, not raw, so they take their own conversion and
      // must NOT also go through the raw->display forward pass below.
      const mapFor = (ch: string): ChannelMap | undefined =>
        channelMaps.get(ch) ?? channelMaps.get(ch.replace(/^Comp-/, ""));
      const mx = axes ? mapFor(axes[0]) : undefined;
      const my = axes ? mapFor(axes[1]) : undefined;
      if (!axes || !mx || !my || !sx || !sy || !convertFlowJoEllipsoid(out, copy, mx, my)) {
        warnings.push(
          `"${name}" is an ellipse on an axis whose display the workspace does not declare, so ` +
          `its coordinates cannot be placed; it and anything below it were skipped.`,
        );
        return false;
      }
      if (sx.kind !== "identity" || sy.kind !== "identity") {
        writeGateSpace(out, copy, sx, sy);
        carried++;
      }
    } else if (axes && sx && sy) {
      const grid = flowJoGrid && copy.localName === "PolygonGate" ? gridFor(el, axes) : null;
      if (grid && "x" in grid) {
        // FlowJo's grid (flowjoGrid.ts): the vertices go onto their channels by FlowJo's rule
        // (beyond a linear or log axis unclamped, on a biex axis within the table), and the gate
        // keeps the raw vertices FlowJo saved for the way back out.
        const raw = polygonVertexValues(copy);
        const gx = flowJoGridScale(grid.x);
        const gy = flowJoGridScale(grid.y);
        // A log vertex at or below zero is on the floor for FlowJo 10.6 and later (flowjoGrid.ts).
        const cellOf = (spec: FlowJoGridSpec, cell: (v: number) => number) =>
          floorsLogVertexAtZero && spec.axis.kind === "wsplog" ? (v: number) => (v <= 0 ? 0 : cell(v)) : cell;
        applyForwardTransform(copy, cellOf(grid.x, gx.vertexCell), cellOf(grid.y, gy.vertexCell));
        writeGateSpace(out, copy, grid.x, grid.y, raw);
        carried++;
        gridPolygons++;
        if (grid.x.channels !== FLOWJO_GATE_RESOLUTION) otherResolution.set(name, grid.x.channels);
      } else {
        if (grid) offGrid.set(name, grid.why);
        if (copy.localName === "PolygonGate" && register) writeFlowJoPolygonAttributes(out, copy, el);
        // Under FlowJo's rule a rectangle's biex or log axis is compared in raw units (its lower
        // bound was opened above where FlowJo pins); any other axis keeps its space.
        const rawAxis = (spec: TransformSpec): boolean => rawRule && (spec.kind === "biex" || spec.kind === "wsplog");
        const ex: TransformSpec = rawAxis(sx) ? { kind: "identity" } : sx;
        const ey: TransformSpec = rawAxis(sy) ? { kind: "identity" } : sy;
        // Both axes linear means the gate is already straight in raw; nothing to move or record.
        if (ex.kind !== "identity" || ey.kind !== "identity") {
          const fx = transformFromSpec(ex).forward;
          const fy = transformFromSpec(ey).forward;
          applyForwardTransform(copy, (v) => fx(v / stepX), (v) => fy(v / stepY));
          writeGateSpace(out, copy, ex, ey);
          carried++;
        } else if (timeScaled) {
          applyForwardTransform(copy, (v) => v / stepX, (v) => v / stepY);
        }
      }
    } else if (axes) {
      if (timeScaled) applyForwardTransform(copy, (v) => v / stepX, (v) => v / stepY);
      // The pair could not be carried. That happens two ways, and both leave a real bend behind:
      // an axis whose transform produced no spec (unknown kind, or parameters that failed to
      // build), and — the previously SILENT case — an axis that has a perfectly carriable
      // transform whose partner is not declared in the Transformations block at all. Carrying
      // half a pair would mean guessing the undeclared axis's display (FlowJo probably means
      // linear, but that is not documented), so the gate imports straight-in-raw and every
      // bending axis is named rather than the known bend being quietly dropped.
      for (const [i, ch] of axes.entries()) {
        const spec = i === 0 ? sx : sy;
        if (spec !== undefined && spec.kind === "identity") continue; // linear: nothing bends
        const kind = transformKinds.get(ch) ?? transformKinds.get(ch.replace(/^Comp-/, ""));
        if (spec !== undefined) {
          // Carriable on its own; lost to an undeclared partner.
          if (!approximated.has(name)) approximated.set(name, new Set());
          approximated.get(name)!.add(kind ?? spec.kind);
          continue;
        }
        if (!kind || REPRESENTABLE_FLOWJO_TRANSFORMS.has(kind)) continue;
        if (!approximated.has(name)) approximated.set(name, new Set());
        approximated.get(name)!.add(kind);
      }
    } else if (timeScaled) {
      // A range on Time: compared in raw units like every range, in the file's ticks.
      applyForwardTransform(copy, (v) => v / stepX, (v) => v / stepY);
    }
    // Under FlowJo's rule a rectangle is compared in raw units, so the axes FlowJo saved it on
    // are recorded beside it for the FlowJo export (PolyRectGate.flowjo_axes). A range (a
    // histogram's gate, one dimension) states its one axis for both, as GateLab holds it; without
    // it the export dropped the bound the rule opened and declared another axis.
    const oneDimension = dimensionNames(el);
    const recordAxes: [string, string] | null = axes ?? (oneDimension.length === 1 ? [oneDimension[0], oneDimension[0]] : null);
    if (rawRule && recordAxes && saved) {
      const gridAxis = (ch: string): FlowJoGridAxis | null =>
        isTimeAxis(ch) ? null : gridAxes.get(ch) ?? gridAxes.get(ch.replace(/^Comp-/, "")) ?? null;
      const ax = gridAxis(recordAxes[0]);
      const ay = gridAxis(recordAxes[1]);
      // The bounds the rule opened, as FlowJo saved them, for the FlowJo export (flowjo_bounds), in
      // raw units as the gate holds them: a Time bound FlowJo saved at its Time axis's gain is
      // taken back to the file's ticks, as the gate's own bounds are above. Kept in FlowJo's Time
      // units, the export read it as ticks and wrote it times `$TIMESTEP`, both bounds on one
      // number (FR-FCM-Z2HV's "Time, SSC-A subset": 0.7732 to 0.7732, where FlowJo saved 12.08 to
      // 77.32, and every population beneath it empty on the way back).
      const now = rectangleBoundValues(copy);
      const step = (i: number): number => (i === 0 ? stepX : stepY);
      const opened = saved.map(([lo, hi], i): [number | null, number | null] => [
        lo !== null && now[i]?.[0] === null ? lo / step(i) : null,
        hi !== null && now[i]?.[1] === null ? hi / step(i) : null,
      ]);
      const anyOpened = opened.some(([lo, hi]) => lo !== null || hi !== null);
      if (ax || ay || anyOpened) writeFlowJoAxes(out, copy, ax, ay, anyOpened ? opened : null);
    }
    // FlowJo's own rectangles keep FlowJo's edge rule, and one GateLab wrote comes back as GateLab
    // held it. A curly quadrant that arrives as a rectangle is not marked: it is a quadrant, and
    // its dividers follow the quadrant rule.
    if (imported.localName === "RectangleGate" && register) {
      const own = gateLabRectangleRecord(el, [stepX, stepY]);
      if (own) restoreGateLabRectangle(out, copy, own);
      else writeRectBoundsMark(out, copy);
    }
    // FlowJo ids are unique within one file, which is all that is needed here; a generated id
    // keeps the document valid when one is missing.
    const id = gateId ?? el.getAttributeNS(GATING_NS, "id") ?? `wsp_gate_${++serial}`;
    copy.setAttributeNS(GATING_NS, "gating:id", id);
    copy.setAttributeNS(GATING_NS, "gating:name", name);
    if (register) idOf.set(pop, id);

    const parent = pop.parentElement?.parentElement ?? null; // node -> Subpopulations -> node
    const parentId = parent && POPULATION_NODES.has(parent.localName) ? idOf.get(parent) : undefined;
    if (parentId) copy.setAttributeNS(GATING_NS, "gating:parent_id", parentId);
    else if (depth > 0) {
      warnings.push(`"${name}" sits under a skipped gate, so it was attached to the top level.`);
    }

    root.appendChild(copy);
    if (register) copyOf.set(pop, copy);
    lastEmitted = copy;
    return true;
  };

  /**
   * A FlowJo CurlyQuad population: one quadrant of a crosshair whose arms FlowJo bends.
   *
   * FlowJo writes each quadrant as its own gate element and nothing about the bend but
   * percentX = percentY = 0; against its own counts the arms follow FLOWJO_CURLY_QUAD_CURL in
   * its 256-channel display space (models.ts). The four populations sharing a crosshair become
   * ONE GateLab quadrant gate: emitted once, as a rectangle whose minima are the crosshair and
   * marked with the bend, and each population becomes a derived one naming its quadrant, so
   * what FlowJo gated beneath a quadrant gates beneath it here as it does beneath an
   * intersection.
   */
  const curlyGroups = new Map<string, { gateId: string; curled: boolean }>();
  const curlyPops: Array<{ pop: Element; name: string; gateId: string; quadrant: number }> = [];
  let curlySerial = 0;
  let curlyPopSerial = 0;
  const visitCurlyQuad = (
    pop: Element, el: Element, name: string, depth: number,
    cross: { cx: number; cy: number; quadrant: number },
  ): boolean => {
    const container = pop.parentElement?.parentElement ?? null;
    const containerId = container && POPULATION_NODES.has(container.localName)
      ? idOf.get(container) ?? "?"
      : "top";
    const axes = gateAxisNames(el) ?? ["", ""];
    const key = `${containerId}|${axes[0]}|${axes[1]}|${cross.cx}|${cross.cy}`;
    let group = curlyGroups.get(key);
    if (!group) {
      const gateId = `wsp_curly_${++curlySerial}`;
      const before = carried;
      const rect = curlyQuadGroupRectangle(out, out.importNode(el, true) as Element);
      if (!emitGate(pop, rect, `${axes[0]} × ${axes[1]} quadrant`, depth, gateId, false)) return false;
      // The bend is a shape in FlowJo's display space. When that space could not be carried
      // the crosshair imports straight in raw, and says so, rather than bending in raw units.
      const curled = carried > before;
      writeCurlyMark(out, lastEmitted!, curled ? { ...FLOWJO_CURLY_QUAD_CURL } : null);
      if (!curled) {
        warnings.push(
          `"${name}" is a curly quadrant on axes whose display could not be carried, so its ` +
          "arms were imported straight; its counts will differ from FlowJo's near the crosshair.",
        );
      }
      group = { gateId, curled };
      curlyGroups.set(key, group);
    }
    if (curlyQuadIsCurved(el)) {
      warnings.push(
        `"${name}" declares a curly-quadrant percentage FlowJo does not document; its arms ` +
        "were given the bend fitted to FlowJo's own counts.",
      );
    }
    idOf.set(pop, `wsp_cq_${++curlyPopSerial}`);
    curlyPops.push({ pop, name, gateId: group.gateId, quadrant: cross.quadrant });
    return true;
  };

  for (const selected of selectedRoots) walkTree(selected, visitPopulation);

  // ---- Derived populations: intersections, complements and curly quadrants, resolved now that
  // every gate has an id ------------------------------------------------------------------------
  const derived: WspDerivedPopulation[] = [];
  // A dropped intersection takes everything gated beneath it: that was measured inside the
  // intersection, and no population is left to measure it in. booleanNodes is in walk order, so
  // an intersection's ancestors are settled before it is.
  const dropped = new Set<Element>();
  const containerOf = (node: Element): Element | null => {
    const up = node.parentElement?.parentElement ?? null; // node -> Subpopulations -> node
    return up && POPULATION_NODES.has(up.localName) ? up : null;
  };
  const beneathDropped = (node: Element): boolean => {
    for (let up = containerOf(node); up; up = containerOf(up)) if (dropped.has(up)) return true;
    return false;
  };
  /**
   * Every population a skipped node took with it, by id, with the name of the node that was
   * skipped: a complement or intersection elsewhere that names one of them has nothing left to name.
   */
  const lostWith = new Map<string, string>();
  const dropSubtree = (node: Element, by = qualifiedNames.get(node) ?? node.getAttribute("name") ?? ""): number => {
    let n = 0;
    for (const child of populationChildren(node)) {
      const copy = copyOf.get(child);
      if (copy?.parentNode === root) root.removeChild(copy);
      const id = idOf.get(child);
      if (id) lostWith.set(id, by);
      n += 1 + dropSubtree(child, by);
    }
    return n;
  };
  if (booleanNodes.length) {
    // FlowJo names a dependent by its FULL path from the tree root, so the index is keyed the
    // same way. Names are taken verbatim; nothing here depends on gate ids or on custom_info.
    const indexTrees = (trees: Element[]): Map<string, Element> => {
      const index = new Map<string, Element>();
      const indexFrom = (node: Element, prefix: string): void => {
        for (const child of populationChildren(node)) {
          const path = `${prefix}${child.getAttribute("name") ?? ""}`;
          index.set(path, child);
          indexFrom(child, `${path}/`);
        }
      };
      for (const rootPop of trees) {
        const rootPath = rootPop.getAttribute("name") ?? "";
        index.set(rootPath, rootPop);
        indexFrom(rootPop, `${rootPath}/`);
      }
      return index;
    };
    const byPath = indexTrees(selectedRoots);
    // The sample's other trees, indexed only when a reference leaves the imported one. Imported
    // one tree at a time, as the app imports a picked tree, a population named from another tree
    // is not in byPath; it must still be told apart from one the workspace does not hold at all.
    let sampleByPath: Map<string, Element> | null = null;
    const inAnotherTree = (path: string): Element | undefined => {
      if (treeIndex === null) return undefined; // every tree is in byPath already
      sampleByPath ??= indexTrees(roots);
      return sampleByPath.get(path);
    };

    // An operand resolves to gate references. A gated population is its own gate -- excluded for
    // a NotNode, whose population is the complement of the gate it carries. A nested AndNode is
    // the conjunction of ITS operands, and a conjunction of conjunctions is one conjunction, so it
    // flattens. That is exact because an operand sits beside its AndNode: 46,124 of the 46,144
    // operands in a 433-workspace survey do, and of the rest 16 name no population and 4 lie in
    // another branch. A population in another branch carries its own ancestors' gates, which a
    // bare reference to its gate would drop, so such an operand is refused rather than widened.
    /**
     * `fallback` marks a NotNode emitted as a gate of its own rather than derived: the copy of
     * the gate it stores, or the current gate of the top-level population it names in another tree.
     */
    type Resolution = { refs: WspDerivedPopulation["refs"]; fallback?: true } | { why: string };
    const readable = new Set(booleanNodes);
    const resolved = new Map<Element, Resolution>();
    const inProgress = new Set<Element>();
    const operandsOf = (node: Element): string[] => childrenByLocalName(node, "Dependents")
      .flatMap((d) => childrenByLocalName(d, "Dependent"))
      .map((d) => d.getAttribute("name") ?? "");
    const resolveAnd = (node: Element): Resolution => {
      const done = resolved.get(node);
      if (done) return done;
      if (inProgress.has(node)) return { why: "its operands refer back to it" };
      inProgress.add(node);
      const parentNode = node.parentElement?.parentElement ?? null;
      const deps = operandsOf(node);
      const refs: WspDerivedPopulation["refs"] = [];
      let why: string | null = deps.length ? null : "it names no operand";
      for (const path of deps) {
        if (why) break;
        const target = byPath.get(path);
        const label = path.split("/").pop() || path;
        if (!target) {
          why = inAnotherTree(path)
            ? `"${label}" is in another of this sample's trees, which was not imported with this one`
            : `"${label}" does not exist in this tree`;
        } else if ((target.parentElement?.parentElement ?? null) !== parentNode) {
          why = `"${label}" is not beside it, and a reference to its gate alone would drop its own ancestry`;
        } else if (target.localName === "AndNode") {
          const inner: Resolution = readable.has(target) ? resolveAnd(target) : { why: "it was itself skipped" };
          if ("why" in inner) why = `"${label}" cannot be resolved: ${inner.why}`;
          else refs.push(...inner.refs);
        } else if (target.localName === "NotNode") {
          // A NotNode operand contributes what it negates, excluded -- whichever way the
          // NotNode itself was read.
          const inner: Resolution = readable.has(target) ? resolveNot(target) : { why: "it was itself skipped" };
          if ("why" in inner) why = `"${label}" cannot be resolved: ${inner.why}`;
          else refs.push(...inner.refs);
        } else if (target.localName === "OrNode") {
          why = `"${label}" combines with OR, which GateLab cannot represent`;
        } else {
          const gate = idOf.get(target);
          if (gate?.startsWith("wsp_cq_")) why = `"${label}" is one quadrant of a curly quadrant, which an intersection cannot name yet`;
          else if (gate) refs.push({ gate, include: true });
          else why = `"${label}" was itself skipped`;
        }
      }
      inProgress.delete(node);
      // The same gate reached through two nested intersections is one condition, not two.
      const unique = [...new Map(refs.map((r) => [`${r.gate}|${r.include}`, r] as const)).values()];
      const res: Resolution = why ? { why } : { refs: unique };
      resolved.set(node, res);
      return res;
    };

    // A NotNode is the complement, inside its container, of the one population it names, and
    // FlowJo excludes that population's GATE ALONE, whatever its ancestry: inside the container C,
    // NOT T is C minus T's own gate. Its counts say so. On FR-FCM-Z73A, "CD45+ cells/Basophils-"
    // names a population in another branch; excluding it with its ancestry would count 1,007,465,
    // FlowJo counts 770,066, and excluding its gate alone counts 769,745. FR-FCM-Z2JV samples 21
    // and 22 match the gate-alone arithmetic exactly (110,440 and 97,338) and not the ancestry
    // reading (119,174 and 114,974). So a NOT is always C AND NOT (T's current gate), which GateLab
    // represents exactly; it was refused here as an OR of complements, which it is not. When T is
    // beside the NOT -- the usual case -- the two readings coincide. The complement of an
    // intersection is a union, and is refused by name, with its subtree.
    //
    // FlowJo also stores a COPY of the negated gate inside the node, and that copy goes stale
    // wherever the workspace tailors gates per sample: the copy inside "debris-" on FR-FCM-Z2DR
    // is the debris gate as it once was, and reading it put the population 10% away from
    // FlowJo's count. So the copy is used only when the population named is nowhere in the
    // sample, and the warning then says so. Whenever the population exists, the complement is
    // the exclusion of its current gate, or refused.
    //
    /**
     * What was said of a node that was kept -- its stored copy used, or a gate imported as its own
     * -- by the node's id. A node that goes afterwards, with a node refused in the settling below,
     * was said to have been kept and then to have gone; what was said of it is withdrawn.
     */
    const saidOfKept = new Map<string, string[]>();
    const sayKept = (id: string, text: string): void => {
      warnings.push(text);
      saidOfKept.set(id, [...(saidOfKept.get(id) ?? []), text]);
    };
    /** The node T was skipped with: T itself, or the topmost of its containers that was not imported. */
    const skippedWith = (target: Element): Element => {
      let top = target;
      for (let up = containerOf(target); up && !idOf.has(up); up = containerOf(up)) top = up;
      return top;
    };
    // A NotNode can name a population in another of the sample's trees, and imported one tree
    // at a time that population is not in byPath. The complement is still the exclusion of its
    // CURRENT gate, ancestors or not, which is imported as the NotNode's own gate, beneath the
    // NotNode's container. A Boolean node there is refused.
    //
    // `wentWith` names the node T was skipped with ("" when T itself was), when T is in the tree
    // imported but was not imported itself -- beneath an OR, or a population whose gate cannot be read. The NOT is the
    // same exclusion of T's gate alone: merged with T's tree under a per-file import it was
    // refused ("T" was itself skipped), and imported alone, with T in another tree, it was kept.
    const complementAcrossTrees = (node: Element, target: Element, label: string, wentWith?: string): Resolution => {
      if (target.localName === "AndNode") {
        return { why: `"${label}" is an intersection in another of this sample's trees, whose complement is a union GateLab cannot represent` };
      }
      if (target.localName === "OrNode") return { why: `"${label}" combines with OR, which GateLab cannot represent` };
      if (target.localName === "NotNode") {
        return { why: `"${label}" is itself a complement in another of this sample's trees, which this importer does not resolve` };
      }
      const { el, unsupported } = gateElementOf(target);
      if (!el) {
        return {
          why: unsupported
            ? `"${label}" uses ${unsupported}, which this importer does not read yet`
            : `"${label}" has no gate`,
        };
      }
      if (el.localName === "CurlyQuad") {
        return { why: `"${label}" is one quadrant of a curly quadrant, which a complement cannot name yet` };
      }
      const name = qualifiedNames.get(node) ?? node.getAttribute("name") ?? "complement";
      const id = idOf.get(node)!;
      if (!emitGate(node, el, name, containerOf(node) ? 1 : 0, id)) return { why: `the gate of "${label}" could not be placed` };
      writeComplementMark(out, copyOf.get(node)!);
      const stored = embeddedOf.get(node);
      const differs = !!stored && !sameGateGeometry(stored, el);
      if (wentWith !== undefined) {
        sayKept(id,
          `"${name}" is the complement of "${label}", which ${wentWith === "" ? "was skipped" : `went with "${wentWith}" when that was skipped`}. ` +
          `FlowJo excludes that population's gate alone, so the gate was imported as "${name}"'s own, and "${name}" was kept` +
          (differs ? "; the copy of the gate FlowJo stored inside it differs from the current one, and was not used." : "."),
        );
      } else if (differs) {
        sayKept(id,
          `"${name}" is the complement of "${label}", a gate in another of this sample's trees. The ` +
          `copy of that gate FlowJo stored inside "${name}" differs from the current one; the ` +
          "current gate was used, as FlowJo counts it, and the copy was not.",
        );
      }
      return { refs: [{ gate: id, include: false }], fallback: true };
    };
    const resolveNot = (node: Element): Resolution => {
      const done = resolved.get(node);
      if (done) return done;
      if (inProgress.has(node)) return { why: "its operand refers back to it" };
      inProgress.add(node);
      const deps = operandsOf(node);
      let res: Resolution;
      /** Set when the population named exists in the sample: its stored copy is then never used. */
      let named = false;
      if (deps.length !== 1) {
        // A NOT of several populations is refused by name. Where any population it names is in
        // the sample, the stored copy is not read in its place: that copy is used only for a
        // population nowhere in the sample, and read here it was the stale gate FlowJo keeps.
        named = deps.some((path) => byPath.has(path) || Boolean(inAnotherTree(path)));
        res = { why: deps.length ? `it names ${deps.length} populations` : "it names no population" };
      } else {
        const path = deps[0];
        const target = byPath.get(path);
        const label = path.split("/").pop() || path;
        const elsewhere = target ? undefined : inAnotherTree(path);
        named = Boolean(target || elsewhere);
        if (elsewhere) {
          res = complementAcrossTrees(node, elsewhere, label);
        } else if (!target) {
          res = { why: `"${label}" does not exist in this tree` };
        } else if (target.localName === "AndNode") {
          res = { why: `"${label}" is an intersection, whose complement is a union GateLab cannot represent` };
        } else if (target.localName === "OrNode") {
          res = { why: `"${label}" combines with OR, which GateLab cannot represent` };
        } else if (target.localName === "NotNode") {
          const inner: Resolution = readable.has(target) ? resolveNot(target) : { why: "it was itself skipped" };
          if ("why" in inner) res = { why: `"${label}" cannot be resolved: ${inner.why}` };
          else if (inner.refs.length !== 1) res = { why: `"${label}" negates more than one gate, and the complement of that is a union GateLab cannot represent` };
          else res = { refs: [{ gate: inner.refs[0].gate, include: !inner.refs[0].include }] };
        } else {
          const gate = idOf.get(target);
          // A population that was not imported -- beneath an OR, or a population whose gate cannot
          // be read -- is excluded by its gate alone, as a population in another tree is.
          const skipped = !gate && target.localName === "Population" ? skippedWith(target) : null;
          res = gate?.startsWith("wsp_cq_")
            ? { why: `"${label}" is one quadrant of a curly quadrant, which a complement cannot name yet` }
            : gate ? { refs: [{ gate, include: false }] }
              : skipped ? complementAcrossTrees(node, target, label, skipped === target ? "" : qualifiedNames.get(skipped) ?? skipped.getAttribute("name") ?? "")
                : { why: `"${label}" was itself skipped` };
        }
      }
      inProgress.delete(node);
      if ("why" in res && !named) {
        const embedded = embeddedOf.get(node);
        const name = qualifiedNames.get(node) ?? node.getAttribute("name") ?? "complement";
        const id = idOf.get(node)!;
        // Depth from the population container, not the XML parent: a top-level NotNode's parent
        // element is the SampleNode, and counting it made the node report that it "sits under a
        // skipped gate" when it was at the top level all along.
        if (embedded && emitGate(node, embedded, name, containerOf(node) ? 1 : 0, id)) {
          writeComplementMark(out, copyOf.get(node)!);
          sayKept(id,
            `"${name}" is the complement of a population that could not be read (${res.why}); ` +
            "the copy of the gate FlowJo stored inside it was used instead, which can be stale " +
            "when the workspace tailors gates per sample.",
          );
          res = { refs: [{ gate: id, include: false }], fallback: true };
        }
      }
      resolved.set(node, res);
      return res;
    };

    for (const node of booleanNodes) {
      if (beneathDropped(node)) {
        dropped.add(node);
        continue;
      }
      const isAnd = node.localName === "AndNode";
      const name = qualifiedNames.get(node) ?? node.getAttribute("name") ?? (isAnd ? "intersection" : "complement");
      const res = isAnd ? resolveAnd(node) : resolveNot(node);
      if ("why" in res) {
        dropped.add(node);
        const lost = dropSubtree(node);
        warnings.push(
          `"${name}" is ${isAnd ? "an intersection" : "a complement"} that was skipped: ${res.why}` +
          (lost ? `; the ${lost} population(s) beneath it went with it.` : "."),
        );
        continue;
      }
      // Emitted as a gate of its own by the fallback; nothing to derive.
      if (res.fallback) continue;
      const parentNode = containerOf(node);
      derived.push({
        id: idOf.get(node)!,
        name,
        parent: parentNode ? idOf.get(parentNode) ?? null : null,
        refs: res.refs,
      });
    }

    // A complement or intersection that names a population lying beneath a node skipped in
    // another branch, or another tree under a per-file import, names a gate that went with that
    // node. It was emitted all the same, and the import then dropped it, its subpopulations and
    // every intersection built on it without a word.
    //
    // A NOT of such a population is still what FlowJo counts: its container minus that
    // population's gate alone, whatever became of the population (see resolveNot). So the gate is
    // emitted again as the NOT's own, as for a population in another of the sample's trees, and
    // what names the gate names it there. It used to be refused, and imported or not by the import
    // mode: alone, a NOT naming a population in another tree is imported this way; merged with
    // that tree under a per-file import, the same NOT was refused. What names a gate that went and
    // cannot be given it so is refused by name, with its subtree.
    const nodeOfId = new Map([...idOf].map(([el, id]) => [id, el] as const));
    const labelOf = (id: string): string => {
      const el = nodeOfId.get(id);
      return el ? qualifiedNames.get(el) ?? el.getAttribute("name") ?? id : id;
    };
    /**
     * A gate that went, by id -> every NOT whose own gate it is now, emitted again, in document
     * order. What names the gate names the first of them still there: a single stand-in -- the
     * first in document order -- could itself go later, beneath an intersection refused after it,
     * and took with it an intersection elsewhere that named only another NOT of the same gate.
     */
    const standIns = new Map<string, string[]>();
    /** A NOT standing in for a gate that went, by id -> that gate. */
    const standsFor = new Map<string, string>();
    const liveStandIn = (gate: string): string | undefined =>
      standIns.get(standsFor.get(gate) ?? gate)?.find((id) => !lostWith.has(id));
    const settle = (): boolean => {
      // Beneath a population that went; counted with the node it went with.
      let moved = false;
      for (let i = derived.length - 1; i >= 0; i--) {
        const d = derived[i];
        if (d.parent !== null && lostWith.has(d.parent)) {
          lostWith.set(d.id, lostWith.get(d.parent)!);
          derived.splice(i, 1);
          moved = true;
        }
      }
      if (moved) return true;
      // A NOT of one population whose gate went: that gate, emitted again as the NOT's own.
      for (let i = 0; i < derived.length; i++) {
        const d = derived[i];
        const node = nodeOfId.get(d.id);
        const ref = d.refs.length === 1 ? d.refs[0] : undefined;
        if (!node || node.localName !== "NotNode" || !ref || ref.quadrant !== undefined) continue;
        if (!lostWith.has(ref.gate)) continue;
        const target = nodeOfId.get(ref.gate);
        const el = target?.localName === "Population" ? gateElementOf(target).el : null;
        if (!el || el.localName === "CurlyQuad") continue;
        if (!emitGate(node, el, d.name, containerOf(node) ? 1 : 0, d.id)) continue;
        // Its population is the complement of the gate, or -- a NOT of a NOT -- the gate itself.
        if (!ref.include) writeComplementMark(out, copyOf.get(node)!);
        standIns.set(ref.gate, [...(standIns.get(ref.gate) ?? []), d.id]);
        standsFor.set(d.id, ref.gate);
        derived.splice(i, 1);
        const stored = embeddedOf.get(node);
        sayKept(d.id,
          `"${d.name}" is the complement of "${labelOf(ref.gate)}", which went with "${lostWith.get(ref.gate)}" when that ` +
          `was skipped. FlowJo excludes that population's gate alone, so the gate was imported as "${d.name}"'s own, ` +
          `and "${d.name}" was kept` +
          (stored && !sameGateGeometry(stored, el) ? `; the copy of the gate FlowJo stored inside it differs from the current one, and was not used.` : "."),
        );
        return true;
      }
      // What names a gate emitted again as a NOT's own names it there -- at a NOT still there.
      for (const d of derived) {
        const live = (r: (typeof d.refs)[number]) => (lostWith.has(r.gate) ? liveStandIn(r.gate) : undefined);
        if (!d.refs.some((r) => live(r) !== undefined)) continue;
        d.refs = d.refs.map((r) => {
          const to = live(r);
          return to !== undefined ? { ...r, gate: to } : r;
        });
        moved = true;
      }
      if (moved) return true;
      // Anything else that names a gate that went is refused by name, with its subtree.
      for (let i = derived.length - 1; i >= 0; i--) {
        const d = derived[i];
        const node = nodeOfId.get(d.id);
        const gone = d.refs.find((r) => lostWith.has(r.gate));
        if (!gone || !node) continue;
        derived.splice(i, 1);
        dropped.add(node);
        const lost = dropSubtree(node, d.name);
        // Named by the population it named: a stand-in it was pointed at is not what it names.
        const named = standsFor.get(gone.gate) ?? gone.gate;
        lostWith.set(d.id, lostWith.get(named)!);
        warnings.push(
          `"${d.name}" is ${node.localName === "AndNode" ? "an intersection" : "a complement"} that was skipped: ` +
          `it depends on "${labelOf(named)}", which went with "${lostWith.get(named)}" when that was skipped` +
          (lost ? `; the ${lost} population(s) beneath it went with it.` : "."),
        );
        return true;
      }
      return false;
    };
    // A node that went, emitted afterwards as the operand another NOT named -- its stored copy,
    // read for a population nowhere in the sample -- named a container that is not there, and the
    // whole import was refused over it. It went, and what names it is refused by name.
    for (const id of lostWith.keys()) {
      const el = nodeOfId.get(id);
      const copy = el ? copyOf.get(el) : undefined;
      if (copy?.parentNode === root) root.removeChild(copy);
    }
    while (settle());
    // A node said to have been kept, that went afterwards: what was said of it is withdrawn. Its
    // loss is named with the node it went with ("the N population(s) beneath it went with it").
    for (const [id, texts] of saidOfKept) {
      if (!lostWith.has(id)) continue;
      for (const text of texts) {
        const at = warnings.indexOf(text);
        if (at >= 0) warnings.splice(at, 1);
      }
    }
  }

  // Curly-quadrant populations: one derived population per quadrant of the shared gate. One
  // beneath a dropped intersection went with it.
  for (const { pop, name, gateId, quadrant } of curlyPops) {
    if (beneathDropped(pop)) continue;
    const parentNode = containerOf(pop);
    derived.push({
      id: idOf.get(pop)!,
      name,
      parent: parentNode ? idOf.get(parentNode) ?? null : null,
      refs: [{ gate: gateId, include: true, quadrant }],
    });
  }
  // GateLab's own operand helpers: the gate of one stays, for the intersections that name it, and
  // holds no population; a complement written only as an operand is not derived.
  const operandGates: string[] = [];
  for (const top of selectedRoots) {
    walkTree(top, (pop) => {
      if (!isOperandHelper(pop)) return true;
      const id = idOf.get(pop);
      if (!id) return true;
      const at = derived.findIndex((d) => d.id === id);
      if (at >= 0) derived.splice(at, 1);
      else if (copyOf.get(pop)?.parentNode === root) operandGates.push(id);
      return true;
    });
  }
  if (operandGates.length) {
    const info = out.createElementNS(DATATYPE_NS, "data-type:custom_info");
    const tag = out.createElementNS(DATATYPE_NS, `data-type:${WSP_OPERAND_TAG}`);
    tag.textContent = JSON.stringify(operandGates);
    info.appendChild(tag);
    root.appendChild(info);
  }
  const derivedRoots = derived.filter((d) => d.parent === null).length;
  if (derived.length) {
    const info = out.createElementNS(DATATYPE_NS, "data-type:custom_info");
    const tag = out.createElementNS(DATATYPE_NS, `data-type:${WSP_DERIVED_TAG}`);
    tag.textContent = JSON.stringify(derived);
    info.appendChild(tag);
    root.appendChild(info);
  }

  const qualified = [...qualifiedNames.entries()]
    .filter(([pop, name]) => name !== (pop.getAttribute("name") ?? ""))
    .map(([, name]) => name);
  if (qualified.length) {
    warnings.push(
      `${qualified.length} population name(s) recur under different parents and were qualified ` +
        `with their parent so they stay distinct: ` +
        qualified.slice(0, 6).map((n) => `"${n}"`).join(", ") +
        (qualified.length > 6 ? ", …" : "") + ".",
    );
  }

  if (!root.children.length) {
    throw new Error(
      `"${sampleName}" has no gates this importer can read.` +
        (warnings.length ? ` ${warnings[0]}` : ""),
    );
  }

  // FlowJo evaluates a gate as straight lines in the space its axes are DISPLAYED in. Where that
  // space could not be carried — a transform GateLab has no spec for, or a pair broken by an
  // undeclared partner axis — the gate is imported straight-in-raw instead: a different gate, by
  // however much the transform bends over its edges. Stated per gate, with the transforms named,
  // so it is clear which results are exact and which are approximations.
  if (approximated.size) {
    const kinds = [...new Set([...approximated.values()].flatMap((v) => [...v]))].sort();
    const names = [...approximated.keys()];
    const shown = names.slice(0, 6).map((n) => `"${n}"`).join(", ");
    warnings.push(
      `${names.length} of ${Object.keys(flowJoCounts).length} gate(s) are drawn on axes FlowJo ` +
        `displays with ${kinds.join(" / ")}, which could not be carried onto the imported gate ` +
        "(the transform is one GateLab cannot hold, or its partner axis is not declared in the " +
        "workspace). They were imported as straight in RAW space, which is not the boundary " +
        "FlowJo evaluates, so their event counts will differ from FlowJo's by more than binning alone: " +
        shown + (names.length > 6 ? `, and ${names.length - 6} more.` : "."),
    );
  }

  // Parallel top-level trees mean the sample was gated under more than one strategy. They are
  // imported together, which is a merge the user did not ask for, so it is stated.
  // Gate elements only: the custom_info block holding derived populations is also a child of
  // the root, and counting it reported a single-root sample as two trees. A derived population
  // written at the top level is a root of its own, so it counts.
  const rootTrees = Array.from(root.children).filter(
    (el) => el.localName.endsWith("Gate") && !el.getAttributeNS(GATING_NS, "parent_id"),
  ).length + derivedRoots;
  // A sample GateLab's export marked as one tree (WSP_ONE_TREE_ATTR) is one strategy, whatever
  // it holds at the top level.
  if (rootTrees > 1 && trees.length > 1) {
    warnings.push(
      `"${sampleName}" holds ${rootTrees} independent gating trees and all were imported ` +
        `together, which merges strategies that FlowJo kept apart. ${mergedTreesAdvice}`,
    );
  }

  // Polygons the option would put on FlowJo's grid but cannot: they are evaluated continuously,
  // which is not FlowJo's rule, so their counts can differ from FlowJo's near their edges.
  if (otherResolution.size) {
    const names = [...otherResolution.entries()];
    warnings.push(say(
      "{count} polygon(s) declare a gate resolution other than 256 and are put on a grid of that many channels; " +
        "every FlowJo polygon measured declares 256, so no count at another resolution has been compared with " +
        "FlowJo's: {list}",
      { count: names.length, list: listed(names.map(([n, channels]) => say("\"{name}\" ({channels})", { name: n, channels }))) },
    ));
  }
  if (offGrid.size) {
    const names = [...offGrid.entries()];
    warnings.push(say(
      "{count} polygon(s) are evaluated continuously rather than on FlowJo's grid, because FlowJo's rule for " +
        "them is not established, so their counts can differ from FlowJo's by the events near their edges: {list}",
      { count: names.length, list: listed(names.map(([n, why]) => say("\"{name}\" {why}", { name: n, why }))) },
    ));
  }

  // A tree drawn on compensated parameters of a matrix GateLab does not apply is refused, by name,
  // whatever the FCS file carries: evaluated on the stored values, or with the file's own matrix,
  // its gates hold other events than FlowJo's. Until 2026-09-26 every spectral matrix was declined,
  // its dimensions went downstream as the file's own compensation, and a file with none evaluated
  // them on the stored values with a note (the public FR-FCM-Z2JN Panel_B1.wsp: "CD21-CD23-" 1,055
  // events where FlowJo has 6,005).
  if (declinedCompensated.size && compensation.declined) {
    const trees = [...declinedTrees].map((top) => `"${top.getAttribute("name") ?? ""}"`);
    const dims = [...declinedCompensated];
    throw new Error(
      `"${sampleName}": ${trees.length === 1 ? "the tree" : "the trees"} ${trees.join(", ")} cannot be imported. ` +
        `${trees.length === 1 ? "Its" : "Their"} gates are drawn on compensated parameters ` +
        `(${dims.slice(0, 3).join(", ")}${dims.length > 3 ? ", …" : ""}) of the workspace's matrix ` +
        `"${compensation.declined.name}", which GateLab does not apply: ${compensation.declined.why}. ` +
        "Evaluated on the stored values, or with another matrix, they would not hold the events FlowJo's hold.",
    );
  }

  // These dimensions declare a compensation nothing here can supply. They are reported, and the
  // document they are in is refused downstream for exactly that reason, unless the FCS file's own
  // matrix covers them (COMPENSATED_FCS_MARK).
  if (unresolvedCompensated.size) {
    warnings.push(
      `${unresolvedCompensated.size} gate dimension(s) are compensated ` +
        `(${[...unresolvedCompensated].slice(0, 3).join(", ")}` +
        `${unresolvedCompensated.size > 3 ? ", …" : ""}) but this workspace carries no usable ` +
        "compensation matrix for the sample, so those gates cannot be placed correctly.",
    );
  }

  markConverterDocument(out, { fcsCompensated: true });
  return {
    gatingMl: new XMLSerializer().serializeToString(out),
    sampleName,
    flowJoCounts,
    warnings,
    spillover: spill,
    gridPolygons,
    gateLabPolygons,
  };
}

// ── Which loaded sample a workspace's strategy belongs to ────────────────────

/** What to do with a pending workspace strategy, given the files currently loaded. */
export type FlowJoTargetResolution =
  | { kind: "apply" }                       // the active sample is the one the strategy goes on
  | { kind: "switch"; id: string }          // it is loaded, but is not active
  | { kind: "absent"; wanted: string[] };   // the file it goes on is not loaded

/**
 * Decide where a FlowJo workspace's gating strategy should land: on the loaded file it was
 * paired with, by that file's id.
 *
 * The import used to check ONLY the active sample and wait silently otherwise -- so choosing
 * several FCS at the prompt, where the target was not the file that happened to end up active,
 * loaded the data with no gating hierarchy and said nothing. It then re-derived the file from the
 * names the workspace records, which put the strategy on the first loaded file of that name:
 * with two of one name (Specimen_001_Tube_001.fcs from two experiments), the wrong one. The file
 * is decided once, in the open dialog, by its identity keywords; here it is only looked up.
 */
export function resolveFlowJoTarget(
  target: { entryId: string | null; names: readonly string[] },
  activeId: string | null,
  loaded: readonly { id: string }[],
): FlowJoTargetResolution {
  if (target.entryId !== null && target.entryId === activeId) return { kind: "apply" };
  if (target.entryId !== null && loaded.some((e) => e.id === target.entryId)) return { kind: "switch", id: target.entryId };
  return { kind: "absent", wanted: [...target.names] };
}
