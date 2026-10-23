// flowjo11Workbench.ts — reading a FlowJo 11 workbench (.flowjo).
//
// A .flowjo file is a zip of JSON: workbench.json, preferences.json and one analysis document per
// analysis (analyses/analysis-<id>/analysis-<id>.json). The analysis is a graph of nodes keyed by
// id: samples (dataSources), gate definitions (populationDefinitions, each defined once for its
// group), one population per gate per sample holding that sample's count (populations), groups,
// compensation matrices (platforms), cytometers and reports. Established from FlowJo 11.2.0's own
// saved workbenches only (LabNotes: "GateLab — FlowJo 11 workbench (.flowjo) format, clean-room
// notes (2026-10-22)"); no FlowJo code was read.
//
// The workbench is rewritten here, in memory and at full double precision, as the FlowJo 10
// workspace document flowjoWorkspace.ts already reads, so a .flowjo takes the .wsp path from there
// on: sample listing, pairing with FCS files, compensation, Boolean nodes and the conversion to
// Gating-ML are shared. What FlowJo 11 does differently is carried in two marks that path reads:
//   - FlowJo 11 stores a transform with every gate, and a gate keeps the one it was drawn on when
//     the plot's axis is changed afterwards. Each population is given a <Transformations> block of
//     its own (WSP_GATE_AXES_ATTR), declaring its gate's axes, so two gates on one parameter may be
//     on different axes as they are in FlowJo 11.
//   - Its polygons are tested on FlowJo 11's grid, not FlowJo 10's (flowjoGrid.ts), which the
//     document says on its Workspace element (WSP_FLOWJO11_ATTR).
//
// Coordinates. FlowJo 11 saves every vertex in the display units of its gate's own axis, 0 to 256.
// A FlowJo 10 workspace states them raw, so each is taken back to raw through that axis (the inverse
// of FlowJo 11's grid channel, flowJoGridScale(...).centre), and the converter brings it forward to
// the same display value again. An ellipse is the exception, as in FlowJo 10: its foci and edge are
// written in display units directly.
//
// Gate types. polygon (the pencil tool also writes one) and spiderQuad (four rays from a centre to
// the plot's edges) become polygons; rectangle, range, bisector and quad become rectangles, a quad's
// four with each arm a boundary of its own; curlyQuad becomes the four polygons FlowJo 11 writes
// beside it (`dependents`); ellipse becomes FlowJo 10's EllipsoidGate; not and and become NotNode and
// AndNode; or becomes an OrNode, which the converter reports and skips. A gate adjusted for one sample
// (`desyncTable`) is that sample's gate; a sample's tree is built from its own populations.
//
// What the workbench holds and GateLab does not read is left out without a note when it is display
// state (plots, resolution, tables, charts, reports, sample-table columns) and reported where it
// changes what a gate holds.

import { strFromU8, unzipSync } from "fflate";
import { WSP_DISPLAY_VERTICES_ATTR, WSP_FLOWJO11_ATTR, WSP_FLOWJO11_CURL_ATTR, WSP_FLOWJO11_HALF_OPEN_ATTR, WSP_GATE_AXES_ATTR, WSP_ONE_TREE_ATTR } from "./flowjoWorkspace";
import { FLOWJO_BIEX_TABLE_CHANNELS } from "./biex";
import { flowJoGridScale, type FlowJoGridSpec } from "./flowjoGrid";
import type { FlowJoGridAxis } from "./models";

/** FlowJo 11's curly-quadrant bend in its 256-channel display: (distance)² / 1000 channels. */
export const FLOWJO11_CURLY_QUAD_CURL = { power: 2, kx: 0.001, ky: 0.001 } as const;

/** Whether a file name is a FlowJo 11 workbench. */
export function isFlowJo11WorkbenchName(name: string): boolean {
  return /\.flowjo$/i.test(name);
}

/** Whether bytes are a FlowJo 11 workbench: a zip holding workbench.json. */
export function isFlowJo11WorkbenchBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  try {
    return Object.keys(unzipSync(bytes, { filter: (f) => f.name === "workbench.json" })).length === 1;
  } catch {
    return false;
  }
}

type Json = Record<string, unknown>;

interface Node {
  uuid: string;
  properties?: Json;
  definition?: Json;
  parents?: Record<string, string[]>;
  children?: Record<string, string[]>;
  results?: Json;
}

/** A FlowJo 11 axis as a gate stores it. */
interface AxisTransform {
  transformType?: string;
  minRange?: number;
  maxRange?: number;
  decadesOffset?: number;
  numberDecades?: number;
  shift?: number;
  negate?: boolean;
  T?: number;
  A?: number;
  M?: number;
  W?: number;
  vectorLength?: number;
}

interface GateAxis {
  parameterSpec?: { name?: string };
  transform?: AxisTransform;
}

interface GateDefinition {
  type?: string;
  xAxis?: GateAxis;
  yAxis?: GateAxis;
  xVertices?: number[];
  yVertices?: number[];
  rotationAngle?: number;
  dependents?: Array<{ quadId?: number; xVertices?: number[]; yVertices?: number[] }>;
}

/** A workbench as read: its name and its one analysis. */
export interface FlowJo11Workbench {
  name: string;
  analysis: Json;
}

/**
 * Read a .flowjo file. Refused, with the reason, when it is not a zip of a workbench, holds other
 * than one analysis, or an analysis of a schema this reader was not built from.
 */
export function readFlowJo11Workbench(bytes: Uint8Array): FlowJo11Workbench {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error("This file is not a FlowJo 11 workbench: it is not a zip archive.");
  }
  const workbenchEntry = entries["workbench.json"];
  if (!workbenchEntry) throw new Error("This file is not a FlowJo 11 workbench: it holds no workbench.json.");
  const workbench = JSON.parse(strFromU8(workbenchEntry)) as Json;
  const ids = Array.isArray(workbench.analyses) ? (workbench.analyses as unknown[]).filter((id): id is string => typeof id === "string") : [];
  if (ids.length !== 1) {
    throw new Error(
      `This FlowJo 11 workbench holds ${ids.length} analyses; GateLab reads a workbench with one. ` +
      "Save each analysis as a workbench of its own in FlowJo.",
    );
  }
  const path = `analyses/analysis-${ids[0]}/analysis-${ids[0]}.json`;
  const analysisEntry = entries[path];
  if (!analysisEntry) throw new Error(`This FlowJo 11 workbench names an analysis it does not hold (${path}).`);
  const analysis = JSON.parse(strFromU8(analysisEntry)) as Json;
  const schema = typeof analysis.schemaVersion === "string" ? analysis.schemaVersion : "";
  if (!/^3\./.test(schema)) {
    throw new Error(
      `This FlowJo 11 workbench is of analysis schema ${schema || "(none stated)"}; GateLab reads schema 3. ` +
      "Open it in a later GateLab.",
    );
  }
  return { name: typeof workbench.name === "string" ? workbench.name : "", analysis };
}

/** A collection of the analysis, by id; empty when absent. */
function collection(analysis: Json, key: string): Record<string, Node> {
  const v = analysis[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Node>) : {};
}

/** The spillover matrices, which FlowJo 11 files under `platforms.spilloverMatrix`. */
function spilloverMatrices(analysis: Json): Map<string, Node> {
  const out = new Map<string, Node>();
  const platforms = collection(analysis, "platforms");
  for (const [key, value] of Object.entries(platforms)) {
    const group = value as unknown as Record<string, Node>;
    // Grouped by type; a platform node itself carries a uuid.
    const nodes = typeof (value as Node).uuid === "string" ? [[key, value as Node] as const] : Object.entries(group);
    for (const [, node] of nodes) {
      if ((node.definition as Json | undefined)?.platformType === "spilloverMatrix") out.set(node.uuid, node);
    }
  }
  return out;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const num = (v: number): string => String(v);

/** A FlowJo 11 axis as FlowJo 10's grid axis, or null when GateLab cannot hold it. */
function gridAxisOf(t: AxisTransform | undefined): { axis: FlowJoGridAxis; channels: number } | { why: string } {
  switch (t?.transformType) {
    case "Linear":
      if (Number.isFinite(t.minRange) && Number.isFinite(t.maxRange) && t.maxRange! > t.minRange!) {
        return { axis: { kind: "linear", minRange: t.minRange!, maxRange: t.maxRange! }, channels: 256 };
      }
      return { why: "a linear axis without a usable range" };
    case "Log":
      if ((t.shift ?? 0) !== 0 || t.negate) return { why: "a log axis that is shifted or negated" };
      if (t.decadesOffset! > 0 && t.numberDecades! > 0) {
        return { axis: { kind: "wsplog", offset: t.decadesOffset!, decades: t.numberDecades! }, channels: 256 };
      }
      return { why: "a log axis without a usable offset and number of decades" };
    case "Biex": {
      const channels = Math.trunc(t.vectorLength ?? 256);
      if (Number.isFinite(t.T) && Number.isFinite(t.M) && t.M! > 0 && Number.isFinite(t.A) && t.W! < 0 && channels > 1) {
        return {
          axis: { kind: "biex", maxValue: t.T!, pos: t.M!, neg: t.A!, widthBasis: t.W!, channelRange: channels },
          channels,
        };
      }
      return { why: "a biex axis without usable parameters" };
    }
    default:
      return { why: `a ${t?.transformType ?? "missing"} axis` };
  }
}

/** The FlowJo 10 <Transformations> element for one parameter's axis. */
function transformElement(parameter: string, g: { axis: FlowJoGridAxis; channels: number }): string {
  const p = `<data-type:parameter data-type:name="${esc(parameter)}"/>`;
  const a = g.axis;
  if (a.kind === "linear") {
    return `<transforms:linear transforms:minRange="${num(a.minRange)}" transforms:maxRange="${num(a.maxRange)}" gain="1">${p}</transforms:linear>`;
  }
  if (a.kind === "wsplog") {
    return `<transforms:log transforms:offset="${num(a.offset)}" transforms:decades="${num(a.decades)}">${p}</transforms:log>`;
  }
  return `<transforms:biex transforms:length="${g.channels}" transforms:maxRange="${num(a.maxValue)}" ` +
    `transforms:neg="${num(a.neg)}" transforms:width="${num(a.widthBasis)}" transforms:pos="${num(a.pos)}">${p}</transforms:biex>`;
}

/** Display units (0 to 256) on an axis → raw, the inverse of FlowJo 11's grid channel. */
function rawOf(g: { axis: FlowJoGridAxis; channels: number }): (d: number) => number {
  const spec: FlowJoGridSpec = { kind: "flowjoChannels", channels: g.channels, axis: g.axis, rule: "flowjo11" };
  return flowJoGridScale(spec).centre;
}

const dimension = (parameter: string, min?: number, max?: number): string =>
  `<gating:dimension${min !== undefined ? ` gating:min="${num(min)}"` : ""}${max !== undefined ? ` gating:max="${num(max)}"` : ""}>` +
  `<data-type:fcs-dimension data-type:name="${esc(parameter)}"/></gating:dimension>`;

const vertex = (x: number, y: number): string =>
  `<gating:vertex><gating:coordinate data-type:value="${num(x)}"/><gating:coordinate data-type:value="${num(y)}"/></gating:vertex>`;

/** A gate element this reader cannot write, which the converter reports by its name and skips. */
const unreadable = (what: string): string => `<gating:${what.replace(/[^A-Za-z0-9]/g, "")}Gate/>`;

/**
 * Which side of each axis a quadrant's population lies on, by its population number: FlowJo 11
 * numbers them 0 to 3 as Q4 (x−, y−), Q3 (x+, y−), Q1 (x−, y+), Q2 (x+, y+), the order it writes
 * their names in. The number, not the name, says which, so a renamed quadrant keeps its place.
 */
function quadrantSigns(number: number): [boolean, boolean] | null {
  const signs: Array<[boolean, boolean]> = [[false, false], [true, false], [false, true], [true, true]];
  return signs[number] ?? null;
}

/**
 * Rewrite a workbench as a FlowJo 10 workspace document for flowjoWorkspace.ts. Every sample of the
 * workbench becomes one <Sample>, its populations one tree (WSP_ONE_TREE_ATTR), in the order the
 * workbench lists its samples.
 */
export function flowJo11WorkbenchToWorkspace(wb: FlowJo11Workbench): string {
  const a = wb.analysis;
  const dataSources = collection(a, "dataSources");
  const defs = collection(a, "populationDefinitions");
  const pops = collection(a, "populations");
  const cytometers = collection(a, "cytometers");
  const matrices = spilloverMatrices(a);

  const matrixXml = (node: Node): string => {
    const def = (node.definition ?? {}) as Json;
    const spill = (def.spillover ?? {}) as { rows?: string[]; columns?: string[]; values?: number[][] };
    const rows = spill.rows ?? [];
    const cols = spill.columns ?? [];
    const values = spill.values ?? [];
    const toDetector = (def.fluorToPrimaryDetector ?? {}) as Record<string, string>;
    // The prefix from the matrix's own naming of a compensated parameter, "Comp-" where it says none.
    let prefix = "Comp-";
    for (const [fluor, detector] of Object.entries(toDetector)) {
      if (typeof detector === "string" && fluor.endsWith(detector)) {
        prefix = fluor.slice(0, fluor.length - detector.length);
        break;
      }
    }
    const rowDetector = (r: string): string =>
      typeof toDetector[r] === "string" ? toDetector[r] : r.startsWith(prefix) ? r.slice(prefix.length) : r;
    const name = typeof def.name === "string" ? def.name : "FlowJo 11 matrix";
    const spectral = def.isSpectral === true ? "1" : "0";
    let out = `<transforms:spilloverMatrix spectral="${spectral}" prefix="${esc(prefix)}" name="${esc(name)}" suffix="" transforms:id="${esc(node.uuid)}">`;
    out += "<data-type:parameters>";
    for (const c of cols) out += `<data-type:parameter data-type:name="${esc(c)}"/>`;
    out += "</data-type:parameters>";
    rows.forEach((r, i) => {
      out += `<transforms:spillover data-type:parameter="${esc(rowDetector(r))}">`;
      cols.forEach((c, j) => {
        out += `<transforms:coefficient data-type:parameter="${esc(c)}" transforms:value="${num(values[i]?.[j] ?? NaN)}"/>`;
      });
      out += "</transforms:spillover>";
    });
    return out + "</transforms:spilloverMatrix>";
  };

  let samplesXml = "";
  const usedMatrices = new Set<string>();
  let sampleSerial = 0;
  for (const ds of Object.values(dataSources)) {
    sampleSerial++;
    const def = (ds.definition ?? {}) as Json;
    const res = (ds.results ?? {}) as Json;
    const custom = (def.customKeywords ?? {}) as Record<string, unknown>;
    const fileName = typeof custom["File Name"] === "string" ? (custom["File Name"] as string) : `sample ${sampleSerial}`;
    const uri = typeof def.uri === "string" ? def.uri : fileName;

    // The sample's populations, by id, and its root.
    const own = Object.values(pops).filter((p) => p.parents?._dataSource?.[0] === ds.uuid);
    const defOf = (p: Node): Json => ((defs[p.parents?.populationDefinitions?.[0] ?? ""]?.definition ?? {}) as Json);
    const typeOf = (p: Node): string => String(defOf(p).type ?? "");
    const root = own.find((p) => typeOf(p) === "root");
    if (!root) continue;
    const nameOf = (p: Node): string => {
      const names = (defOf(p).name ?? []) as string[];
      const n = Number((p.definition as Json | undefined)?.populationNumber ?? 0);
      return String(names.length > 1 ? names[n] ?? names[0] : names[0] ?? "");
    };
    const parentOf = (p: Node): string | undefined => p.parents?.populations?.[0];
    /**
     * Where a population sits in FlowJo 10's tree. A gate's population sits under its parent. A NOT
     * sits beside the population it negates, which FlowJo 11 links as its parent; an AND or OR beside
     * its operands, which it links as its parents.
     */
    const containerOf = (p: Node): string | undefined => {
      const t = typeOf(p);
      if (t === "not" || t === "and" || t === "or") {
        const operand = p.parents?.populations?.[0];
        return operand && pops[operand] ? parentOf(pops[operand]) : undefined;
      }
      return parentOf(p);
    };
    const childrenOf = new Map<string, Node[]>();
    for (const p of own) {
      if (p === root) continue;
      const c = containerOf(p);
      if (!c) continue;
      if (!childrenOf.has(c)) childrenOf.set(c, []);
      childrenOf.get(c)!.push(p);
    }
    const pathOf = (p: Node): string => {
      const names: string[] = [];
      for (let q: Node | undefined = p, guard = 0; q && q !== root && guard < 10000; q = containerOf(q) ? pops[containerOf(q)!] : undefined, guard++) {
        names.unshift(nameOf(q));
      }
      return names.join("/");
    };

    // The sample's display axes: the cytometer's, then its own over them.
    const sampleAxes = new Map<string, string>();
    for (const cytId of ds.parents?.cytometers ?? []) {
      for (const t of ((cytometers[cytId]?.definition as Json | undefined)?.transforms ?? []) as Array<{ parameterSpec?: { name?: string }; transform?: AxisTransform }>) {
        const name = t.parameterSpec?.name;
        const g = gridAxisOf(t.transform);
        if (name && "axis" in g) sampleAxes.set(name, transformElement(name, g));
      }
    }
    for (const t of (def.transforms ?? []) as Array<{ parameterSpec?: { name?: string }; transform?: AxisTransform }>) {
      const name = t.parameterSpec?.name;
      const g = gridAxisOf(t.transform);
      if (name && "axis" in g) sampleAxes.set(name, transformElement(name, g));
    }

    const populationXml = (p: Node): string => {
      const t = typeOf(p);
      const name = nameOf(p);
      const count = Number((p.results as Json | undefined)?.count);
      const countAttr = Number.isFinite(count) ? ` count="${count}"` : "";
      const kids = (childrenOf.get(p.uuid) ?? []).map(populationXml).join("");
      const subs = `<Subpopulations>${kids}</Subpopulations>`;
      if (t === "not" || t === "and" || t === "or") {
        const element = t === "not" ? "NotNode" : t === "and" ? "AndNode" : "OrNode";
        const operands = (p.parents?.populations ?? []).filter((id) => pops[id]).map((id) => `<Dependent name="${esc(pathOf(pops[id]))}"/>`).join("");
        return `<${element} name="${esc(name)}"${countAttr}><Dependents>${operands}</Dependents>${subs}</${element}>`;
      }
      const definition = defs[p.parents?.populationDefinitions?.[0] ?? ""]?.definition as Json | undefined;
      const shared = (definition?.gateDefinition ?? {}) as GateDefinition;
      const desyncTable = (definition?.desyncTable ?? {}) as Record<string, GateDefinition>;
      const g = desyncTable[ds.uuid] ?? shared;
      const number = Number((p.definition as Json | undefined)?.populationNumber ?? 0);
      // A quadrant is one gate only where every sample's version of it is plain, so that every
      // file's tree holds the same kind of gate and a per-file import can tailor one to another.
      const plainEverywhere = [shared, ...Object.values(desyncTable)].every(isPlainQuad);
      const gate = gateXml(g, shared, number, plainEverywhere);
      return `<Population name="${esc(name)}"${countAttr}>${gate.axes}<Gate gating:id="${esc(p.uuid)}">${gate.element}</Gate>${subs}</Population>`;
    };

    const top = (childrenOf.get(root.uuid) ?? []).map(populationXml).join("");
    const rootCount = Number((root.results as Json | undefined)?.count);

    const matrixIds = (ds.parents?.platforms ?? []).filter((id) => matrices.has(id));
    const matrix = matrixIds.length ? matrices.get(matrixIds[0])! : null;
    if (matrix) usedMatrices.add(matrix.uuid);

    const keywords: string[] = [];
    for (const [k, v] of Object.entries((res.keywords ?? {}) as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number") keywords.push(`<Keyword name="${esc(k)}" value="${esc(String(v))}"/>`);
    }
    for (const [k, v] of Object.entries(custom)) {
      if (k === "File URI" || k === "Compensation Matrix") continue;
      if (typeof v === "string" || typeof v === "number") keywords.push(`<Keyword name="${esc(k)}" value="${esc(String(v))}"/>`);
    }

    samplesXml += `<Sample><DataSet uri="${esc(`file:${encodeURI(uri)}`)}" sampleID="${sampleSerial}"/>` +
      (matrix ? matrixXml(matrix) : "") +
      `<Transformations>${[...sampleAxes.values()].join("")}</Transformations>` +
      `<Keywords>${keywords.join("")}</Keywords>` +
      `<SampleNode name="${esc(fileName)}"${Number.isFinite(rootCount) ? ` count="${rootCount}"` : ""} sampleID="${sampleSerial}" ${WSP_ONE_TREE_ATTR}="1">` +
      `<Subpopulations>${top}</Subpopulations></SampleNode></Sample>`;
  }

  const matricesXml = [...usedMatrices].map((id) => matrixXml(matrices.get(id)!)).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Workspace version="20.0" flowJoVersion="11" ${WSP_FLOWJO11_ATTR}="1" ` +
    `xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" ` +
    `xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" ` +
    `xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">` +
    `<!-- Read by GateLab from the FlowJo 11 workbench "${esc(wb.name).replace(/--/g, "- -")}". -->` +
    `<Matrices>${matricesXml}</Matrices><SampleList>${samplesXml}</SampleList></Workspace>`;
}

/**
 * Whether a gate is a plain quadrant: every arm through the centre (FlowJo 11 stores the arms in
 * single precision, so a few parts in a million apart).
 */
function isPlainQuad(g: GateDefinition): boolean {
  const xs = g.xVertices ?? [];
  const ys = g.yVertices ?? [];
  if (g.type !== "quad" || xs.length < 5 || ys.length < 5) return false;
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-3;
  return near(xs[1], xs[0]) && near(xs[3], xs[0]) && near(ys[2], ys[0]) && near(ys[4], ys[0]);
}

/**
 * One population's gate as FlowJo 10 states it, and the population's own axes block. `number` is
 * the population's place among a quadrant's four.
 */
function gateXml(
  g: GateDefinition, shared: GateDefinition, number: number, plainEverywhere = false,
): { element: string; axes: string } {
  const type = g.type ?? shared.type ?? "";
  const xName = g.xAxis?.parameterSpec?.name ?? "";
  const yName = g.yAxis?.parameterSpec?.name ?? "";
  const gx = gridAxisOf(g.xAxis?.transform);
  const gy = type === "range" || type === "bisector" ? gx : gridAxisOf(g.yAxis?.transform);
  if (!xName || ((type !== "range" && type !== "bisector") && !yName)) return { element: unreadable("NoAxis"), axes: "" };
  if (!("axis" in gx)) return { element: unreadable(`${g.xAxis?.transform?.transformType ?? "Unknown"}Axis`), axes: "" };
  if (!("axis" in gy)) return { element: unreadable(`${g.yAxis?.transform?.transformType ?? "Unknown"}Axis`), axes: "" };
  const axes = `<Transformations ${WSP_GATE_AXES_ATTR}="1">${transformElement(xName, gx)}` +
    (type === "range" || type === "bisector" ? "" : transformElement(yName, gy)) + "</Transformations>";
  const rx = rawOf(gx);
  const ry = rawOf(gy);
  const xs = g.xVertices ?? [];
  const ys = g.yVertices ?? [];
  const resolution = gx.channels;

  // A polygon's raw vertices are for a reader of the document that is not this one; the converter
  // takes the display vertices FlowJo 11 saved (WSP_DISPLAY_VERTICES_ATTR), exactly as saved.
  const polygon = (px: readonly number[], py: readonly number[]): string => {
    if (px.length < 3 || px.length !== py.length) return unreadable("Degenerate");
    const display = esc(JSON.stringify(px.map((x, i) => [x, py[i]])));
    return `<gating:PolygonGate quadId="-1" gateResolution="${resolution}" ${WSP_DISPLAY_VERTICES_ATTR}="${display}">` +
      `${dimension(xName)}${dimension(yName)}` +
      px.map((x, i) => vertex(rx(x), ry(py[i]))).join("") + "</gating:PolygonGate>";
  };
  const rectangle = (x: [number?, number?], y: [number?, number?], halfOpen = false): string =>
    `<gating:RectangleGate${halfOpen ? ` ${WSP_FLOWJO11_HALF_OPEN_ATTR}="1"` : ""}>${dimension(xName, x[0], x[1])}${dimension(yName, y[0], y[1])}</gating:RectangleGate>`;
  const range = (lo?: number, hi?: number, halfOpen = false): string =>
    `<gating:RectangleGate${halfOpen ? ` ${WSP_FLOWJO11_HALF_OPEN_ATTR}="1"` : ""}>${dimension(xName, lo, hi)}</gating:RectangleGate>`;
  // A rectangle's or a range's bound beyond an end of the display holds every event beyond that
  // end, which FlowJo 11 puts on the axis's first or last channel (flowjoGrid.ts), and is read as
  // no bound: on a log or biex axis its raw value would be the axis's end, and an event beyond it
  // would fall outside. GateLab's .flowjo export writes an open edge there.
  const lower = (r: (d: number) => number, d: number): number | undefined => (d < 0 ? undefined : r(d));
  const upper = (r: (d: number) => number, d: number, top: number): number | undefined => (d > top ? undefined : r(d));
  // FlowJo 11 tests a range or rectangle bound on a biex axis with the event on its 4096-entry table:
  // the event is in where the entry at or below its value is at or above the entry at or below the
  // lower bound and below the entry at or below the upper one, floor(lo × 16) ≤ entry < floor(hi × 16)
  // on a 256-channel axis. Measured on 2026-10-23 against the counts FlowJo 11.2.0 saved in David's
  // S6 workbenches: a range on biex BV711-A in 14 workbenches over four files (6,756, 2,191, 617 or
  // 1,112, 0; GateLab's continuous test 6,755 for the first), and a rectangle on biex APC-A × PE-A
  // under Singlets, uncompensated, over four files in several workbenches (2,871, 12,222, 807, 4,793
  // and 3,729; the continuous test 4 to 26 events more), the one reading of the bounds that fits
  // both; FlowJo 11.2 recounted GateLab's export of the range 6,756. So each bound becomes its entry's
  // raw value and the gate half-open, low edge in and high edge out, which tests the event's entry
  // exactly. A rectangle with a log or linear axis is left as before: neither was measured.
  const onTable = (g: { axis: FlowJoGridAxis; channels: number }, r: (d: number) => number) => (d: number): number =>
    r(Math.floor(d * (FLOWJO_BIEX_TABLE_CHANNELS / g.channels)) / (FLOWJO_BIEX_TABLE_CHANNELS / g.channels));

  switch (type) {
    case "polygon":
      return { element: polygon(xs, ys), axes };
    case "rectangle": {
      if (xs.length < 2 || ys.length < 2) return { element: unreadable("Degenerate"), axes };
      const [x0, x1] = [Math.min(xs[0], xs[1]), Math.max(xs[0], xs[1])];
      const [y0, y1] = [Math.min(ys[0], ys[1]), Math.max(ys[0], ys[1])];
      if (gx.axis.kind === "biex" && gy.axis.kind === "biex") {
        const [tx, ty] = [onTable(gx, rx), onTable(gy, ry)];
        return { element: rectangle([lower(tx, x0), upper(tx, x1, gx.channels)], [lower(ty, y0), upper(ty, y1, gy.channels)], true), axes };
      }
      return { element: rectangle([lower(rx, x0), upper(rx, x1, gx.channels)], [lower(ry, y0), upper(ry, y1, gy.channels)]), axes };
    }
    case "range": {
      if (xs.length < 2) return { element: unreadable("Degenerate"), axes };
      const [lo, hi] = [Math.min(xs[0], xs[1]), Math.max(xs[0], xs[1])];
      if (gx.axis.kind === "biex") {
        const t = onTable(gx, rx);
        return { element: range(lower(t, lo), upper(t, hi, gx.channels), true), axes };
      }
      return { element: range(lower(rx, lo), upper(rx, hi, gx.channels)), axes };
    }
    case "bisector": {
      // Two populations: number 0 ("<param>-") below the split, number 1 ("<param>+") from it up.
      if (!xs.length) return { element: unreadable("Degenerate"), axes };
      const split = rx(xs[0]);
      return { element: number === 1 ? range(split, undefined) : range(undefined, split), axes };
    }
    case "quad": {
      // [centre, down, right, up, left]. An adjusted quadrant's arms are each a boundary of their
      // own, which GateLab's quadrant gate cannot hold, so its four populations are rectangles: the up arm's x divides
      // the upper half, the down arm's the lower, the left arm's y the left half, the right arm's
      // the right. Outer edges are left open. Measured on one quadrant with one vertical arm moved
      // (all four of FlowJo 11's counts); where both the vertical and the horizontal arms differ the
      // four rectangles overlap near the centre, and what FlowJo 11 does there is not measured.
      const signs = quadrantSigns(number);
      if (xs.length < 5 || ys.length < 5 || !signs) return { element: unreadable("Degenerate"), axes };
      const [xPlus, yPlus] = signs;
      // A plain quadrant (isPlainQuad) is one quadrant gate in GateLab: written as FlowJo 10's
      // curly quadrant with straight arms (WSP_FLOWJO11_CURL_ATTR "straight"). Where one sample
      // adjusted its arms, every sample's version is four rectangles instead.
      // FlowJo 11 tests a plain quad's biex arm with the event on its 4096-entry table, against the
      // entry at or below the arm (measured on all 196 quadrant populations of the S6 workbenches,
      // 2026-10-23; flowjo11Export.ts, quadArmEntry): the centre is that entry's raw value, at or
      // above which GateLab's test puts exactly the events FlowJo 11 does. An event below the
      // table's first entry, which FlowJo 11 puts in no quadrant, GateLab still places.
      // An adjusted quadrant's arms are taken alike.
      const onEntry = (g: { axis: FlowJoGridAxis; channels: number }, r: (d: number) => number, d: number): number => {
        if (g.axis.kind !== "biex") return r(d);
        const perCell = FLOWJO_BIEX_TABLE_CHANNELS / g.channels;
        return r(Math.floor(d * perCell) / perCell);
      };
      if (plainEverywhere) {
        const cx = onEntry(gx, rx, xs[0]);
        const cy = onEntry(gy, ry, ys[0]);
        return {
          element: `<gating:CurlyQuad ${WSP_FLOWJO11_CURL_ATTR}="straight">` +
            `${dimension(xName, xPlus ? cx : undefined, xPlus ? undefined : cx)}` +
            `${dimension(yName, yPlus ? cy : undefined, yPlus ? undefined : cy)}</gating:CurlyQuad>`,
          axes,
        };
      }
      const split = yPlus ? xs[3] : xs[1];
      const level = xPlus ? ys[2] : ys[4];
      return {
        element: rectangle(xPlus ? [onEntry(gx, rx, split), undefined] : [undefined, onEntry(gx, rx, split)],
          yPlus ? [onEntry(gy, ry, level), undefined] : [undefined, onEntry(gy, ry, level)]),
        axes,
      };
    }
    case "spiderQuad": {
      // One quadrant gate with leaning arms in GateLab, written as FlowJo 10 writes one: four
      // panels, quadId 0 to 3 (x−/y−, x+/y−, x−/y+, x+/y+, FlowJo 11's population numbers), each
      // [horizontal arm end, plot corner, vertical arm end, centre] in raw units. FlowJo 11's arm
      // ends lie on the plot's edges; the corner is the plot's own.
      const signs = quadrantSigns(number);
      if (xs.length < 5 || ys.length < 5 || !signs) return { element: unreadable("Degenerate"), axes };
      const [xPlus, yPlus] = signs;
      const top = resolution;
      const horizontal = xPlus ? 2 : 4;
      const vertical = yPlus ? 3 : 1;
      const ring: Array<[number, number]> = [
        [xs[horizontal], ys[horizontal]],
        [xPlus ? top : 0, yPlus ? top : 0],
        [xs[vertical], ys[vertical]],
        [xs[0], ys[0]],
      ];
      return {
        element: `<gating:PolygonGate quadId="${number}" gateResolution="${resolution}">${dimension(xName)}${dimension(yName)}` +
          ring.map(([x, y]) => vertex(rx(x), ry(y))).join("") + "</gating:PolygonGate>",
        axes,
      };
    }
    case "curlyQuad": {
      // One curled quadrant in GateLab, written as FlowJo 10 writes one: each of the four
      // populations carries a CurlyQuad whose one bound per axis is the crosshair, a min on the
      // axis's positive side and a max on its negative (flowjoWorkspace.ts, curlyQuadCrosshair).
      // A curly quadrant adjusted for one sample carries its own centre. Its arms take FlowJo 11's
      // bend, (distance)² / 1000 channels: every vertex of the quadrants FlowJo 11 saves beside it
      // (`dependents`, 347 in four workbenches measured on 2026-10-22) is that curve rounded to the
      // channel, from the centre rounded down. On FlowJo 11's grid it gives FlowJo 11's counts for
      // all four quadrants of a curly quadrant adjusted for one sample and within 1% elsewhere.
      const signs = quadrantSigns(number);
      if (!xs.length || !ys.length || !signs) return { element: unreadable("CurlyQuadWithoutCentre"), axes };
      const [xPlus, yPlus] = signs;
      const cx = rx(xs[0]);
      const cy = ry(ys[0]);
      const curl = esc(JSON.stringify(FLOWJO11_CURLY_QUAD_CURL));
      return {
        element: `<gating:CurlyQuad gateResolution="${resolution}" ${WSP_FLOWJO11_CURL_ATTR}="${curl}">` +
          `${dimension(xName, xPlus ? cx : undefined, xPlus ? undefined : cx)}` +
          `${dimension(yName, yPlus ? cy : undefined, yPlus ? undefined : cy)}</gating:CurlyQuad>`,
        axes,
      };
    }
    case "ellipse": {
      // Two opposite corners of the ellipse's box in its own frame, turned by rotationAngle degrees
      // about the box's centre; written as FlowJo 10's ellipse (foci, edge, distance) in display units.
      // FlowJo 11 tests each event at the middle of its display channel (flowjo11Export.ts,
      // ellipseDifference: ten of ten saved counts); GateLab tests the event's value, so the counts
      // differ by the events between, which only an ellipse test on FlowJo 11's grid in the engine
      // would remove.
      if (xs.length < 2 || ys.length < 2) return { element: unreadable("Degenerate"), axes };
      const cx = (xs[0] + xs[1]) / 2;
      const cy = (ys[0] + ys[1]) / 2;
      const hx = Math.abs(xs[1] - xs[0]) / 2;
      const hy = Math.abs(ys[1] - ys[0]) / 2;
      if (!(hx > 0) || !(hy > 0)) return { element: unreadable("Degenerate"), axes };
      const th = ((g.rotationAngle ?? 0) * Math.PI) / 180;
      const u: [number, number] = [Math.cos(th), Math.sin(th)];
      const v: [number, number] = [-Math.sin(th), Math.cos(th)];
      const [major, minor, along, across] = hx >= hy ? [hx, hy, u, v] : [hy, hx, v, u];
      const f = Math.sqrt(major * major - minor * minor);
      const at = (dir: [number, number], s: number): [number, number] => [cx + dir[0] * s, cy + dir[1] * s];
      const foci = [at(along, -f), at(along, f)];
      const edge = [at(along, -major), at(along, major), at(across, -minor), at(across, minor)];
      return {
        element: `<gating:EllipsoidGate gating:distance="${num(2 * major)}">${dimension(xName)}${dimension(yName)}` +
          `<gating:foci>${foci.map(([x, y]) => vertex(x, y)).join("")}</gating:foci>` +
          `<gating:edge>${edge.map(([x, y]) => vertex(x, y)).join("")}</gating:edge></gating:EllipsoidGate>`,
        axes,
      };
    }
    default:
      return { element: unreadable(type || "Unknown"), axes };
  }
}
