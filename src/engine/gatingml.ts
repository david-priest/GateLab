// gatingml.ts — Gating-ML 2.0 import (Cytobank / GateLabR / FlowJo exports).
// Ported 1:1 from GateLabR inst/app/R/gatingml_import.R.
//
// GateLabR exports encode the population hierarchy as a <GatingHierarchy> of nested
// <PopulationGatePair>s; Cytobank exports use flat <BooleanGate>s + custom_info
// (gate_set_id, booleanExpression "pop_X"). Both are handled. Gate vertices live in
// TRANSFORMED (display) space with a transformation-ref; we invert them back to the
// gating space GateLab masks in (raw for flow, arcsinh for CyTOF).

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
import { Logicle, isScatterChannel } from "./transforms";

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
    if (dims.length < 2) return null;
    const [x, y] = dims;
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
      dims,
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
  scales: Record<string, { w?: number; cofactor?: number; lo?: number; hi?: number }> | null;
}

function parseGatelabrScales(root: Element): GatingMLResult["scales"] {
  const ci = firstChildLocal(root, "custom_info");
  const gs = ci ? firstChildLocal(ci, "gatelabr_scales") : null;
  const def = gs ? firstChildLocal(gs, "definition") : null;
  const txt = def?.textContent?.trim();
  if (!txt) return null;
  try {
    const parsed = JSON.parse(txt);
    return parsed?.channels ?? null;
  } catch {
    return null;
  }
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

  for (const el of Array.from(root.children)) {
    if (el.localName === "GatingHierarchy" && !hierarchyNode) {
      hierarchyNode = el;
      continue;
    }
    const g = parseGateNode(el);
    if (!g || !g.gml_id) continue;
    rawGates[g.gml_id] = g;
    if (g.gate_type === "boolean") boolOrder.push(g.gml_id);
  }

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
            let include = !r.complement;
            if (refGate.operation === "not") include = false;
            gateRefs.push(newGateRef(aid, include));
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
    scales: parseGatelabrScales(root),
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
      inc[rid] = !r.complement;
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
