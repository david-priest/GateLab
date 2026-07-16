// gatingml.ts — Gating-ML 2.0 import (Cytobank / GateLabR / FlowJo exports).
// Ported 1:1 from GateLabR inst/app/R/gatingml_import.R.
//
// GateLabR exports encode the population hierarchy as a <GatingHierarchy> of nested
// <PopulationGatePair>s; Cytobank exports use flat <BooleanGate>s + custom_info
// (gate_set_id, booleanExpression "pop_X"). Both structures are handled, but the
// current product policy imports positive AND populations only: files containing
// NOT/complement or OR logic are rejected before any workspace state is replaced.
// Gate vertices live in TRANSFORMED (display) space with a transformation-ref; we
// invert them back to the gating space GateLab masks in (raw for flow, arcsinh for
// CyTOF).

import {
  newRootPopulation,
  newPopulation,
  newGateRef,
  linkChildToParent,
  nextGateColor,
  type Gate,
  type GateRef,
  type PopulationMap,
  type Vertex,
} from "./models";
import type { DisplaySpillover } from "./compensation";
import type { Sample } from "./sample";
import { Logicle, isQcChannel, isScatterChannel } from "./transforms";

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
  return Array.from(el.children).filter((c) => c.localName === name);
}
function firstChildLocal(el: Element, name: string): Element | null {
  return childrenLocal(el, name)[0] ?? null;
}
function num(x: string | null): number {
  if (x == null) return NaN;
  const v = Number(x);
  return v;
}
const hasNum = (x: number): boolean => Number.isFinite(x);

// ---------------------------------------------------------------------------
// custom_info (Cytobank name / definition / ids)
// ---------------------------------------------------------------------------

function cytobankNode(node: Element): Element | null {
  const ci = firstChildLocal(node, "custom_info");
  return ci ? firstChildLocal(ci, "cytobank") : null;
}
function parseCytobankName(node: Element): string | null {
  const cb = cytobankNode(node);
  const nm = cb ? firstChildLocal(cb, "name") : null;
  const txt = nm?.textContent?.trim();
  return txt ? txt : null;
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
function parseCytobankIds(node: Element): { gate_id?: number; gate_set_id?: number } {
  const cb = cytobankNode(node);
  if (!cb) return {};
  const out: { gate_id?: number; gate_set_id?: number } = {};
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
function detectSource(root: Element): "gatelabr" | "cytobank" | "generic" {
  const ci = firstChildLocal(root, "custom_info");
  if (ci && firstChildLocal(ci, "gatelabr_scales")) return "gatelabr";
  // any descendant <cytobank>
  if (root.getElementsByTagName("*")) {
    for (const el of Array.from(root.getElementsByTagName("*"))) {
      if (el.localName === "cytobank") return "cytobank";
    }
  }
  return "generic";
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

type TransformDef =
  | { type: "logicle"; T: number; W: number; M: number; A: number }
  | { type: "fasinh"; T: number; M: number; A: number };

function parseTransforms(root: Element): Record<string, TransformDef> {
  const out: Record<string, TransformDef> = {};
  for (const el of Array.from(root.children)) {
    if (el.localName !== "transformation") continue;
    const id = attrLocal(el, "id");
    if (!id) continue;

    const lg = firstChildLocal(el, "logicle");
    if (lg) {
      const t = num(attrLocal(lg, "T"));
      const w = num(attrLocal(lg, "W"));
      const m = num(attrLocal(lg, "M"));
      const a = num(attrLocal(lg, "A"));
      if (hasNum(t) && hasNum(w)) {
        out[id] = { type: "logicle", T: t, W: w, M: hasNum(m) ? m : 4.5, A: hasNum(a) ? a : 0 };
        continue;
      }
    }

    const fa = firstChildLocal(el, "fasinh") ?? firstChildLocal(el, "arcsinh");
    if (fa) {
      const t = num(attrLocal(fa, "T"));
      if (hasNum(t)) {
        const m = num(attrLocal(fa, "M"));
        const a = num(attrLocal(fa, "A"));
        out[id] = { type: "fasinh", T: t, M: hasNum(m) ? m : Math.log10(Math.E), A: hasNum(a) ? a : 0 };
      }
    }
  }
  return out;
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
    const mn = num(attrLocal(dim, "min"));
    const mx = num(attrLocal(dim, "max"));
    if (hasNum(mn)) d.min = mn;
    if (hasNum(mx)) d.max = mx;
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

/** Reduce a channel label to a canonical metal token, e.g. "CD3 (Y89Di)" → "y89". */
export function normalizeChannel(ch: string): string {
  let s = ch.trim().replace(/[()]/g, "").replace(/Di/gi, "");
  const hits = s.match(/[A-Za-z]{1,3}[0-9]{2,3}|[0-9]{2,3}[A-Za-z]{1,3}/g) ?? [];
  for (const tok of hits) {
    let m = /^([A-Za-z]{1,3})([0-9]{2,3})$/.exec(tok);
    if (m) return m[1].toLowerCase() + m[2];
    m = /^([0-9]{2,3})([A-Za-z]{1,3})$/.exec(tok);
    if (m) return m[2].toLowerCase() + m[1];
  }
  const compact = s.replace(/[^A-Za-z0-9]/g, "");
  let m = /^([A-Za-z]{1,3})([0-9]{2,3})$/.exec(compact);
  if (m) return m[1].toLowerCase() + m[2];
  m = /^([0-9]{2,3})([A-Za-z]{1,3})$/.exec(compact);
  if (m) return m[2].toLowerCase() + m[1];
  return ch.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveChannel(
  ch: string,
  sessionChannels: string[],
  pnnToChannel: Record<string, string>,
): string | null {
  if (sessionChannels.includes(ch)) return ch;

  const pnnKeys = Object.keys(pnnToChannel);
  if (pnnKeys.length) {
    if (ch in pnnToChannel && sessionChannels.includes(pnnToChannel[ch])) return pnnToChannel[ch];
    const nn = normalizeChannel(ch);
    if (nn) {
      for (const k of pnnKeys) {
        if (normalizeChannel(k) === nn && sessionChannels.includes(pnnToChannel[k])) {
          return pnnToChannel[k];
        }
      }
    }
  }

  const lower = ch.toLowerCase();
  for (const s of sessionChannels) if (s.toLowerCase() === lower) return s;

  const nn = normalizeChannel(ch);
  for (const s of sessionChannels) if (normalizeChannel(s) === nn) return s;

  return null;
}

// ---------------------------------------------------------------------------
// Inverter — transformed (display) vertex → gating space
// ---------------------------------------------------------------------------

function makeInverter(
  resolvedChannel: string,
  transRef: string | undefined,
  transforms: Record<string, TransformDef>,
): (v: number) => number {
  const identity = (v: number) => v;
  if (!transRef || !resolvedChannel) return identity;
  if (/^(time|event_length|cell_length|barcode)$/i.test(resolvedChannel)) return identity;

  const tr = transforms[transRef];
  if (!tr) return identity;

  if (tr.type === "logicle") {
    const { T, W, M, A } = tr;
    if (!Number.isFinite(T) || !Number.isFinite(W) || T <= 0 || W < 0) return identity;
    const m = M ?? 4.5;
    const a = A ?? 0;
    const lg = new Logicle(T, W, m, a);
    // GateLabR/flowCore logicle output spans [0, M+A] (T→M), but our Logicle uses the
    // flowutils [0,1] scale (T→1). Rescale the exported vertex before inverting.
    const span = m + a;
    return (v) => lg.inverse(v / span);
  }

  if (tr.type === "fasinh") {
    // CyTOF metal / Gaussian: gates stored in arcsinh(=display) space → identity.
    // Flow scatter: gates stored in RAW space → invert the arcsinh forward transform.
    if (!isScatterChannel(resolvedChannel)) return identity;
    const T = tr.T;
    const M = Number.isFinite(tr.M) ? tr.M : Math.log10(Math.E);
    const A = Number.isFinite(tr.A) ? tr.A : 0;
    if (!Number.isFinite(T) || T <= 0 || !Number.isFinite(M) || M <= 0) return identity;
    const denom = Math.sinh(M * LN10);
    if (!Number.isFinite(denom) || denom === 0) return identity;
    const cfEff = T / denom;
    const k1 = (M + A) * LN10;
    const k0 = A * LN10;
    return (v) => cfEff * Math.sinh(v * k1 + k0);
  }

  return identity;
}

// ---------------------------------------------------------------------------
// Gate node parsing
// ---------------------------------------------------------------------------

interface RawGate {
  gml_id: string;
  name: string;
  gate_type: "rectangle" | "polygon" | "boolean";
  x_channel?: string;
  y_channel?: string;
  vertices?: Vertex[];
  channels: string[];
  dims?: GmlDim[];
  operation?: "and" | "or" | "not";
  refs?: { gate_id: string; complement: boolean }[];
  pop_parent_indices?: number[];
  gate_set_id?: number;
  explicit_root?: boolean;
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
    const x = dims[0];
    const y = dims[1] ?? dims[0];
    const xlo = x.min !== undefined && Number.isFinite(x.min) ? x.min : -1e9;
    const xhi = x.max !== undefined && Number.isFinite(x.max) ? x.max : 1e9;
    const ylo = y.min !== undefined && Number.isFinite(y.min) ? y.min : -1e9;
    const yhi = y.max !== undefined && Number.isFinite(y.max) ? y.max : 1e9;
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
      if (!rid) continue;
      refs.push({ gate_id: rid, complement: (attrLocal(r, "complement") ?? "false").toLowerCase() === "true" });
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
    };
  }

  return null;
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

function pairPopulationName(pair: Element, rawGates: Record<string, RawGate>): string {
  const nameNode = firstChildLocal(pair, "name");
  const explicitName = (nameNode?.textContent ?? "").trim();
  if (explicitName) return explicitName;
  const gateRef = attrLocal(pair, "gate-ref");
  return (gateRef && rawGates[gateRef]?.name) || gateRef || "Unnamed population";
}

/**
 * GateLab deliberately authors and imports positive intersections only. Detect
 * unsupported Boolean semantics while the XML is still detached from app state,
 * and report the affected population names rather than silently dropping an
 * operator and changing membership.
 */
function positiveAndLogicProblems(
  rawGates: Record<string, RawGate>,
  hierarchyNode: Element | null,
): string[] {
  const problems: string[] = [];
  const namesByGate = new Map<string, string[]>();
  const pairs = hierarchyNode
    ? Array.from(hierarchyNode.getElementsByTagName("*")).filter(
        (node) => node.localName === "PopulationGatePair",
      )
    : [];

  for (const pair of pairs) {
    const gateRef = attrLocal(pair, "gate-ref");
    if (!gateRef) continue;
    const names = namesByGate.get(gateRef) ?? [];
    names.push(pairPopulationName(pair, rawGates));
    namesByGate.set(gateRef, [...new Set(names)]);
  }

  const addProblem = (name: string, operation: "NOT" | "OR") => {
    problems.push(
      `Population ${JSON.stringify(name)} uses ${operation} logic; ` +
        "GateLab currently imports positive AND populations only.",
    );
  };

  for (const gate of Object.values(rawGates)) {
    if (gate.gate_type !== "boolean") continue;
    const names = namesByGate.get(gate.gml_id) ?? [gate.name];
    if (gate.operation === "or") {
      for (const name of names) addProblem(name, "OR");
    }
    if (gate.operation === "not" || (gate.refs ?? []).some((ref) => ref.complement)) {
      for (const name of names) addProblem(name, "NOT");
    }
  }

  for (const pair of pairs) {
    if ((attrLocal(pair, "complement") ?? "false").toLowerCase() === "true") {
      addProblem(pairPopulationName(pair, rawGates), "NOT");
    }
  }

  return [...new Set(problems)];
}

function missingChannelProblems(
  rawGates: Record<string, RawGate>,
  sessionChannels: string[],
  pnnToChannel: Record<string, string>,
): string[] {
  const problems: string[] = [];
  for (const gate of Object.values(rawGates)) {
    if (gate.gate_type === "boolean") continue;
    const missing = [...new Set(gate.channels)].filter(
      (channel) => resolveChannel(channel, sessionChannels, pnnToChannel) == null,
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
  source: "gatelabr" | "cytobank" | "generic";
  n_pops_imported: number;
  scales: Record<string, GatingMLScaleEntry> | null;
  cytof_cofactor: number | null;
  compensation: GatingMLCompensationState | null;
  compensation_refs: GatingMLCompensationRef[];
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
    if (comp.reference !== "FCS" && comp.reference !== "uncompensated") {
      throw new Error("Invalid embedded GateLab compensation state: unsupported matrix reference.");
    }
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
    if (comp.enabled && (comp.reference !== "FCS" || channels.length < 2 || !matrix)) {
      throw new Error("Invalid embedded GateLab compensation state: enabled compensation requires an FCS spillover matrix.");
    }
    return {
      scales,
      cytofCofactor,
      compensation: { enabled: comp.enabled, reference: comp.reference, channels, ...(matrix ? { matrix } : {}) },
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
    if (sample.instrument === "flow" && isScatterChannel(key) && state.cofactor !== undefined &&
        sample.currentScatterCofactor(idx) !== state.cofactor) {
      sample.setScatterCofactor(idx, state.cofactor);
      transformsChanged = true;
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

function parseCompensationRefs(rawGates: Record<string, RawGate>): GatingMLCompensationRef[] {
  const refs = new Set<GatingMLCompensationRef>();
  const unsupported = new Set<string>();
  for (const gate of Object.values(rawGates)) {
    if (gate.gate_type === "boolean") continue;
    for (const dim of gate.dims ?? []) {
      const value = dim.compensation_ref?.trim();
      if (!value) continue;
      if (value.toLowerCase() === "fcs") refs.add("FCS");
      else if (value.toLowerCase() === "uncompensated") refs.add("uncompensated");
      else unsupported.add(value);
    }
  }
  if (unsupported.size) {
    throw new Error(
      `This Gating-ML file references unsupported compensation matrix ${[...unsupported].map((x) => `"${x}"`).join(", ")}. ` +
      "GateLab can safely import FCS or uncompensated dimensions only.",
    );
  }
  return [...refs];
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

/** Determine the data state required to evaluate imported gates without changing membership. */
export function resolveGatingMLCompensation(
  embedded: GatingMLCompensationState | null,
  dimensionRefs: GatingMLCompensationRef[],
  isFlow: boolean,
  available: DisplaySpillover | null,
): GatingMLCompensationResolution {
  if (!isFlow) return { target: null, source: "none", requiresConfirmation: false };

  if (embedded) {
    if (!embedded.enabled) {
      if (dimensionRefs.includes("FCS")) {
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

  if (dimensionRefs.includes("FCS")) {
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
): GatingMLResult {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const parseErr = doc.getElementsByTagName("parsererror");
  if (parseErr.length) throw new Error("Invalid Gating-ML XML (could not parse).");
  const root = doc.documentElement;

  const transforms = parseTransforms(root);

  const rawGates: Record<string, RawGate> = {};
  const boolOrder: string[] = [];
  let hierarchyNode: Element | null = null;
  const importProblems: string[] = [];
  const supportedGateTypes = new Set(["RectangleGate", "PolygonGate", "BooleanGate"]);

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

    const id = attrLocal(el, "id");
    if (!id) {
      importProblems.push(`${el.localName} is missing its required id.`);
      continue;
    }
    if (rawGates[id]) {
      importProblems.push(`${el.localName} has duplicate id ${id}.`);
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
    }

    const g = parseGateNode(el);
    if (!g || !g.gml_id) {
      importProblems.push(`${gateLabel(el)} could not be parsed.`);
      continue;
    }
    rawGates[g.gml_id] = g;
    if (g.gate_type === "boolean") boolOrder.push(g.gml_id);
  }
  importProblems.push(...positiveAndLogicProblems(rawGates, hierarchyNode));
  importProblems.push(...missingChannelProblems(rawGates, sessionChannels, pnnToChannel));
  const gatelabrState = parseGatelabrState(root);
  const compensationRefs = parseCompensationRefs(rawGates);

  for (const gate of Object.values(rawGates)) {
    for (const dim of gate.dims ?? []) {
      const ref = dim.transformation_ref;
      if (ref && !transforms[ref]) {
        importProblems.push(`${gate.gml_id} references unsupported or missing transformation ${ref}.`);
      }
    }
    if (gate.gate_type === "boolean") {
      for (const ref of gate.refs ?? []) {
        const target = rawGates[ref.gate_id];
        if (!target) importProblems.push(`${gate.gml_id} references missing gate ${ref.gate_id}.`);
        else if (target.gate_type === "boolean") {
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

  if (hierarchyNode) {
    for (const pair of Array.from(hierarchyNode.getElementsByTagName("*"))) {
      if (pair.localName !== "PopulationGatePair") continue;
      const ref = attrLocal(pair, "gate-ref");
      if (!ref) importProblems.push("A PopulationGatePair is missing gate-ref.");
      else if (!rawGates[ref]) importProblems.push(`A PopulationGatePair references missing gate ${ref}.`);
    }
  }

  if (importProblems.length) throwImportProblems(importProblems);

  const gmlToApp: Record<string, string> = {};
  const appGates: Record<string, Gate> = {};
  const gateOrder: string[] = [];
  let nSkipped = 0;
  const unresolved: string[] = [];

  // Primitive gates → app gates (resolve channels, invert vertices).
  for (const gmlId of Object.keys(rawGates)) {
    const g = rawGates[gmlId];
    if (g.gate_type === "boolean") continue;

    const channels = [...new Set(g.channels)];
    const resolved: Record<string, string | null> = {};
    for (const ch of channels) resolved[ch] = resolveChannel(ch, sessionChannels, pnnToChannel);
    const missing = channels.filter((ch) => resolved[ch] == null);
    if (missing.length) {
      unresolved.push(...missing);
      nSkipped++;
      continue;
    }
    const xCh = resolved[g.x_channel!];
    const yCh = resolved[g.y_channel!];
    if (!xCh || !yCh) {
      nSkipped++;
      continue;
    }

    const xTr = g.dims?.[0]?.transformation_ref;
    const yTr = g.dims?.[1]?.transformation_ref;
    const invX = makeInverter(xCh, xTr, transforms);
    const invY = makeInverter(yCh, yTr, transforms);
    const verts: Vertex[] = (g.vertices ?? []).map((v) => [invX(v[0]), invY(v[1])]);
    if (verts.length < 3 && g.gate_type === "polygon") {
      nSkipped++;
      continue;
    }

    const appId = uuid();
    appGates[appId] = {
      gate_id: appId,
      name: g.name,
      gate_type: g.gate_type,
      x_channel: xCh,
      y_channel: yCh,
      vertices: verts,
      color: nextGateColor(Object.keys(appGates).length),
      label_offset: null, // auto-position (buildPlotGates computes it in display space)
    };
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

  if (hierarchyNode) {
    const processPair = (pairNode: Element, parentId: string): void => {
      const gateRefGml = attrLocal(pairNode, "gate-ref");
      const complement = (attrLocal(pairNode, "complement") ?? "false").toLowerCase() === "true";

      const nameNode = firstChildLocal(pairNode, "name");
      let popName = nameNode ? (nameNode.textContent ?? "").trim() : "";
      if (!popName && gateRefGml && rawGates[gateRefGml]) popName = rawGates[gateRefGml].name;
      if (!popName) popName = "Population";

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

      if (gateRefs.length === 0) return;

      const pop = newPopulation(popName, gateRefs, parentId, gateLogic);
      populations[pop.population_id] = pop;
      populations = linkChildToParent(populations, pop.population_id, parentId);

      for (const child of childrenLocal(pairNode, "PopulationGatePair")) processPair(child, pop.population_id);
    };

    for (const top of childrenLocal(hierarchyNode, "PopulationGatePair")) processPair(top, rootPopId);
  } else {
    buildPopulationsFromBooleans(rawGates, boolOrder, gmlToApp, appGates, gateOrder, populations, rootPopId);
  }

  return {
    gates: appGates,
    gate_order: gateOrder,
    populations,
    root_population_id: rootPopId,
    n_gates_imported: Object.keys(appGates).length,
    n_gates_skipped: nSkipped,
    skipped_channels: [...new Set(unresolved)].sort(),
    source: detectSource(root),
    n_pops_imported: Math.max(0, Object.keys(populations).length - 1),
    scales: gatelabrState.scales,
    cytof_cofactor: gatelabrState.cytofCofactor,
    compensation: gatelabrState.compensation,
    compensation_refs: compensationRefs,
  };
}

/** Cytobank flat-boolean → population hierarchy (no <GatingHierarchy> present). */
function buildPopulationsFromBooleans(
  rawGates: Record<string, RawGate>,
  boolOrder: string[],
  gmlToApp: Record<string, string>,
  appGates: Record<string, Gate>,
  gateOrder: string[],
  populations: PopulationMap,
  rootPopId: string,
): void {
  const boolNames: Record<string, string> = {};
  const boolPrim: Record<string, string[]> = {};
  const boolInclude: Record<string, Record<string, boolean>> = {};
  const boolPopIndices: Record<string, number[]> = {};
  const gsidToGml: Record<string, string> = {};

  for (const bid of boolOrder) {
    const g = rawGates[bid];
    if (!g || g.gate_type !== "boolean") continue;
    if (g.gate_set_id != null && Number.isFinite(g.gate_set_id)) gsidToGml[String(g.gate_set_id)] = bid;
  }

  for (const bid of boolOrder) {
    const g = rawGates[bid];
    if (!g || g.gate_type !== "boolean") continue;
    const prim: string[] = [];
    const inc: Record<string, boolean> = {};
    const seen = new Set<string>();
    for (const r of g.refs ?? []) {
      const rid = r.gate_id;
      if (seen.has(rid)) continue;
      seen.add(rid);
      const rg = rawGates[rid];
      if (rg && rg.gate_type === "boolean") continue;
      if (!gmlToApp[rid]) continue;
      prim.push(rid);
      inc[rid] = g.operation === "not" ? r.complement : !r.complement;
    }
    boolNames[bid] = g.name;
    boolPrim[bid] = [...new Set(prim)];
    boolInclude[bid] = inc;
    boolPopIndices[bid] = g.pop_parent_indices ?? [];
  }

  if (Object.keys(boolNames).length === 0) {
    // No booleans → one population per primitive gate under root.
    for (const gid of gateOrder) {
      const g = appGates[gid];
      const pop = newPopulation(g.name, [newGateRef(gid, true)], rootPopId);
      populations[pop.population_id] = pop;
      linkChildToParent(populations, pop.population_id, rootPopId);
    }
    return;
  }

  // Resolve each boolean gate's parent.
  const parents: Record<string, string | null> = {};
  for (const bid of Object.keys(boolNames)) {
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
      const mySet = boolPrim[bid] ?? [];
      let best: string | null = null;
      let bestSize = -1;
      for (const oid of Object.keys(boolNames)) {
        if (oid === bid) continue;
        const oset = boolPrim[oid] ?? [];
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

  const orderedBids = Object.keys(boolNames).sort((a, b) => depth(a) - depth(b));
  const bidToPid: Record<string, string> = {};
  for (const bid of orderedBids) bidToPid[bid] = uuid();

  for (const bid of orderedBids) {
    const pid = bidToPid[bid];
    const parentBid = parents[bid];
    const parentPid = parentBid ? bidToPid[parentBid] ?? rootPopId : rootPopId;

    const myPrim = boolPrim[bid] ?? [];
    const parentPrim = parentBid ? boolPrim[parentBid] ?? [] : [];
    const incr = myPrim.filter((x) => !parentPrim.includes(x));

    const refs: GateRef[] = [];
    const includeMap = boolInclude[bid] ?? {};
    for (const rid of Object.keys(includeMap)) {
      if (!incr.includes(rid)) continue;
      const appId = gmlToApp[rid];
      if (!appId || appId === rid) continue;
      refs.push(newGateRef(appId, includeMap[rid]));
    }
    if (refs.length === 0) continue;

    const pop = newPopulation(
      boolNames[bid] ?? "Population",
      refs,
      parentPid,
      rawGates[bid]?.operation === "or" ? "or" : "and",
    );
    pop.population_id = pid; // preserve the id used for parent links
    populations[pid] = pop;
    linkChildToParent(populations, pid, parentPid);
  }
}
