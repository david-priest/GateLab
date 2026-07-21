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

import type { Sample } from "./sample";
import type { Gate, PolyRectGate, PopulationMap } from "./models";
import { isScatterChannel, isQcChannel } from "./transforms";

const SINH1 = Math.sinh(1); // sinh(log10(e)·ln10) = sinh(1)
const LOG10E = Math.log10(Math.E); // GatingML fasinh M
const LOGICLE_SPAN = 4.5; // M + A for exported logicle vertices (flowCore [0, M])

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

interface TransformRegistry {
  chToTr: Map<string, string | null>; // channel key → transform id (null = no transform)
  trDefs: Map<string, TrDef>; // ordered by first appearance
}

function buildTransforms(sample: Sample): TransformRegistry {
  const chToTr = new Map<string, string | null>();
  const trDefs = new Map<string, TrDef>();
  const isFlow = sample.instrument === "flow";

  if (!isFlow) {
    // CyTOF: one shared fasinh transform for all arcsinh channels.
    const cofactor = sample.arcsinhCofactor;
    const trId = `Tr_Arcsinh_${round(cofactor, 4)}`;
    trDefs.set(trId, { type: "fasinh", T: cofactor * SINH1, M: LOG10E, A: 0 });
    sample.channels.forEach((c, idx) => {
      chToTr.set(c.key, sample.transformKind(idx) === "identity" ? null : trId);
    });
    return { chToTr, trDefs };
  }

  // Flow: logicle for fluorescence, fasinh for scatter, none for QC.
  sample.channels.forEach((c, idx) => {
    const key = c.key;
    if (isQcChannel(key)) {
      chToTr.set(key, null);
    } else if (isScatterChannel(key)) {
      const cf = sample.currentScatterCofactor(idx);
      const trId = `Tr_Fasinh_${Math.round(cf)}`;
      if (!trDefs.has(trId)) trDefs.set(trId, { type: "fasinh", T: cf * SINH1, M: LOG10E, A: 0 });
      chToTr.set(key, trId);
    } else {
      const T = sample.logicleT(idx);
      const W = clampW(sample.currentLogicleW(idx));
      const trId = `Tr_Logicle_${key.replace(/[^A-Za-z0-9]/g, "_")}`;
      trDefs.set(trId, { type: "logicle", T, W, M: 4.5, A: 0 });
      chToTr.set(key, trId);
    }
  });
  return { chToTr, trDefs };
}

const round = (x: number, d: number): number => {
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
};
const clampW = (w: number): number => Math.max(0.1, Math.min(Number.isFinite(w) ? w : 0.5, 2.0));

// ── Scale JSON (per gate dimension) ──────────────────────────────────────────
function scaleJson(trId: string | null | undefined, isFlow: boolean, cofactor: number): string {
  let flag: number, arg: string, mn: number, mx: number;
  if (trId == null) {
    flag = 1; arg = "1"; mn = 1.0; mx = 1570900.0;
  } else if (!isFlow) {
    flag = 4; arg = String(cofactor); mn = -5.0; mx = 12000.0;
  } else if (trId.startsWith("Tr_Logicle_")) {
    flag = 5; arg = "4.5"; mn = -0.5; mx = 4.5;
  } else {
    flag = 4; arg = String(cofactor); mn = -2.0; mx = 12.0;
  }
  return `{"flag":${flag},"argument":"${arg}","min":${fmtNum(mn)},"max":${fmtNum(mx)},"bins":256,"size":256}`;
}

/** Cytobank definition JSON — vertices already in export (display) space. */
function definitionJson(
  gate: PolyRectGate,
  xTr: string | null | undefined,
  yTr: string | null | undefined,
  isFlow: boolean,
  xCofactor: number,
  yCofactor: number,
): string {
  const xs = gate.vertices.map((v) => v[0]);
  const ys = gate.vertices.map((v) => v[1]);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const cx = mean(xs);
  const cy = mean(ys);
  const sx = scaleJson(xTr, isFlow, xCofactor);
  const sy = scaleJson(yTr, isFlow, yCofactor);
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
function customInfo(name: string, numericId: number, gateSeq: number, typeStr: string, defJson: string): string[] {
  return [
    "    <data-type:custom_info>",
    "      <cytobank>",
    `        <name>${escAttr(name)}</name>`,
    `        <id>${numericId}</id>`,
    `        <gate_id>${gateSeq}</gate_id>`,
    `        <type>${typeStr}</type>`,
    "        <version>-1</version>",
    "        <compensation_id>-2</compensation_id>",
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
): string[] {
  const xs = gate.vertices.map((v) => v[0]);
  const ys = gate.vertices.map((v) => v[1]);
  const def = definitionJson(gate, xTr, yTr, isFlow, xCofactor, yCofactor);
  return [
    `  <gating:RectangleGate gating:id="${gmlId}">`,
    ...customInfo(gate.name, numId, seq, "RectangleGate", def),
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
): string[] {
  const def = definitionJson(gate, xTr, yTr, isFlow, xCofactor, yCofactor);
  const vertLines = gate.vertices.flatMap((v) => [
    "    <gating:vertex>",
    `      <gating:coordinate data-type:value="${fmtNum(v[0])}" />`,
    `      <gating:coordinate data-type:value="${fmtNum(v[1])}" />`,
    "    </gating:vertex>",
  ]);
  return [
    `  <gating:PolygonGate gating:id="${gmlId}">`,
    ...customInfo(gate.name, numId, seq, "PolygonGate", def),
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
    } else if (kind === "asinh" && sample.instrument === "flow" && isScatterChannel(c.key)) {
      entry.cofactor = round(sample.currentScatterCofactor(idx), 6);
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
  const cofactor = sample.arcsinhCofactor;

  // display channel name → dimension name (Cytobank uses $PnN, standard uses the display key).
  const pnnFor = (key: string): string => {
    if (!cytobankMode) return key;
    const idx = sample.index(key);
    const pnn = idx !== undefined ? sample.channels[idx].pnn : undefined;
    return pnn && pnn.length ? pnn : key;
  };

  const { chToTr, trDefs } = buildTransforms(sample);
  const scalesJson = buildScalesJson(sample, opts.globalScales);
  const compensationRefFor = (channelKey: string): "FCS" | "uncompensated" =>
    isFlow && sample.embeddedCompensationEnabled && sample.spillover?.channels.includes(channelKey)
      ? "FCS"
      : "uncompensated";
  const axisCofactor = (channelKey: string): number => {
    const idx = sample.index(channelKey);
    return isFlow && idx !== undefined && isScatterChannel(channelKey)
      ? sample.currentScatterCofactor(idx)
      : cofactor;
  };

  // Forward-transform a stored (gating-space) coordinate into export/display space.
  const toExport = (channelKey: string, v: number): number => {
    const idx = sample.index(channelKey);
    let dv = sample.gatingToDisplay(channelKey, v);
    if (idx !== undefined && sample.transformKind(idx) === "logicle") dv *= LOGICLE_SPAN;
    return dv;
  };
  const displayGate = (g: PolyRectGate): PolyRectGate => ({
    ...g,
    vertices: g.vertices.map((vv) => [toExport(g.x_channel, vv[0]), toExport(g.y_channel, vv[1])] as [number, number]),
  });

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

  // Gate elements.
  const gateLines: string[] = [];
  gate_order.forEach((gid, i) => {
    const g = gates[gid];
    if (!g || g.gate_type === "quadrant") return;
    const dg = displayGate(g as PolyRectGate);
    const gmlId = gateToGmlId.get(gid)!;
    const numId = gateNumericId.get(gid)!;
    const xTr = chToTr.get(g.x_channel) ?? null;
    const yTr = chToTr.get(g.y_channel) ?? null;
    const xName = pnnFor(g.x_channel);
    const yName = pnnFor(g.y_channel);
    const xCompRef = compensationRefFor(g.x_channel);
    const yCompRef = compensationRefFor(g.y_channel);
    const xCofactor = axisCofactor(g.x_channel);
    const yCofactor = axisCofactor(g.y_channel);
    if (g.gate_type === "rectangle") {
      gateLines.push(...rectangleXml(
        dg, gmlId, numId, i + 1, xTr, yTr, isFlow, xCofactor, yCofactor,
        xName, yName, xCompRef, yCompRef,
      ));
    } else {
      gateLines.push(...polygonXml(
        dg, gmlId, numId, i + 1, xTr, yTr, isFlow, xCofactor, yCofactor,
        xName, yName, xCompRef, yCompRef,
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

    // Nearest non-root ancestor that itself has a GateSet.
    let parentBoolNum: number | null = null;
    let parentBoolGmlId: string | null = null;
    let walk: string | null = pop.parent_id;
    while (walk && walk !== root_population_id) {
      if (popBoolGmlId.has(walk)) {
        parentBoolNum = popBoolNum.get(walk)!;
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
      const ownRefLines = valid.map((gr) => {
        const comp = gr.include ? "" : ' gating:complement="true"';
        return `      <gating:gateReference gating:ref="${gateToGmlId.get(gr.gate_id)}"${comp} />`;
      });
      let refLines = parentBoolGmlId
        ? [...ownRefLines, `      <gating:gateReference gating:ref="${parentBoolGmlId}" />`]
        : ownRefLines;
      // GatingML Boolean operations need ≥2 refs — pad single-ref lists.
      if (refLines.length === 1) {
        refLines = [
          refLines[0],
          `      <!-- Single-gate root population: ref twice (GatingML requires ≥2 args for "${operation}") -->`,
          refLines[0],
        ];
      }

      const allSeq = valid.map((gr) => gateSeq.get(gr.gate_id)!);
      const negSeq = valid.filter((gr) => !gr.include).map((gr) => gateSeq.get(gr.gate_id)!);
      const exprParts = valid.map((gr) => {
        const sid = gateSeq.get(gr.gate_id)!;
        return gr.include ? `gate_${sid}` : `NOT gate_${sid}`;
      });
      if (parentBoolNum != null) {
        const parentGsId = parentBoolNum - 36000000 + 1;
        exprParts.push(`pop_${parentGsId}`);
      }
      const ownExpr = exprParts.slice(0, valid.length).join(operation === "or" ? " OR " : " AND ");
      const boolExpr = parentBoolNum != null ? `(${ownExpr}) AND ${exprParts[exprParts.length - 1]}` : ownExpr;
      const parentMarker = parentBoolNum == null ? ',"gatelabParent":"root"' : "";
      const boolDefJson = `{"gates":[${allSeq.join(",")}],"negGates":[${negSeq.join(",")}],"tailoredPerPopulation":{},"booleanExpression":"${boolExpr}"${parentMarker}}`;

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
    `      <export_timestamp>${timestamp}</export_timestamp>`,
    "    </cytobank>",
    "    <gatelabr_scales>",
    `      <definition>${escText(scalesJson)}</definition>`,
    "    </gatelabr_scales>",
    "  </data-type:custom_info>",
    ...[...trDefs.entries()].flatMap(([id, tr]) => transformXml(id, tr)),
    ...gateLines,
    ...boolLines,
    ...(hierLines.length ? ["  <gating:GatingHierarchy>", ...hierLines, "  </gating:GatingHierarchy>"] : []),
    "</gating:Gating-ML>",
  ];
  return lines.join("\n") + "\n";
}
