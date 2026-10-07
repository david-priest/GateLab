/**
 * Write a GateLab tree back into a BD FACSChorus experiment file (`.cef`), so gates adjusted here
 * can go back onto the sorter.
 *
 * A `.cef` is a zip of `manifest.json`, `experiment.json` (the whole experiment), `instrument.json`
 * and `verification` (a 64-hex-digit digest no plain hash of the contents reproduces; see the
 * importer's notes). Chorus cannot take gates from anything but a FlowJo workspace or one of its
 * own experiment files, so the export is the source experiment with its live gates replaced:
 * everything else in `experiment.json` — panels, reagents, carriers, worksheets, sort template,
 * sort records — is written back as it was, and the manifest, the instrument record and the
 * digest are copied byte for byte. Whether Chorus checks the digest against the new contents is
 * for Chorus to say; the file is otherwise what Chorus itself writes.
 *
 * What goes in (chorusExperiment.ts has the model): one Chorus gate per population, a Polygon
 * (the only kind Chorus draws, besides its automatic Saturated / Unsaturated filters, which are
 * kept from the source) with RAW vertices straight in the space Chorus displays each parameter
 * in. So a GateLab gate imported from Chorus, whose vertices are held in that display, goes back
 * exactly; a rectangle goes back as its four corners (exact on monotone axes); a polygon GateLab
 * drew straight in raw space on a biexponential axis is densified along its edges so Chorus's
 * straight-in-display rendering follows the same outline; an ellipse goes as its outline; a
 * quadrant as four rectangles over the axis window. A population that is not one included gate
 * (several gates, an excluded gate, OR) has no Chorus form and is left out with its children,
 * named in the warnings.
 *
 * Identities: a population that matches a source population by name and parent keeps its gate
 * and population ids, so sort destinations and worksheet plots that name it still do; a new one
 * gets the next free gate id. Sort destinations assigned to a population no longer present are
 * cleared and named; a plot drawn on one is re-pointed to its nearest surviving ancestor.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Gate, Population, PopulationMap, TransformSpec } from "./models";
import { ellipseBoundary } from "./ellipse";
import { transformFromSpec } from "./sample";
import { chorusDisplayFromKeywords, chorusAxisSpec } from "./chorusExperiment";

export interface ChorusExportChannel {
  /** GateLab's channel key, what a gate's x_channel / y_channel names. */
  key: string;
  /** The FCS `$PnN`, what Chorus's parameters are named after. */
  pnn: string;
}

export interface ChorusExportInput {
  /** The `.cef` the experiment came from, as read. */
  source: Uint8Array;
  channels: readonly ChorusExportChannel[];
  /** The FCS keywords of the file the tree is viewed on: the display Chorus records per parameter. */
  keywords: Record<string, string> | null;
  gates: Record<string, Gate>;
  populations: PopulationMap;
  root_population_id: string;
}

export interface ChorusExportResult {
  bytes: Uint8Array;
  /** Populations written, as Chorus gates. */
  written: number;
  /** Populations left out, each with why. */
  skipped: { name: string; why: string }[];
  warnings: string[];
}

interface ChorusJsonGate {
  children: { name: string; color: string; populationId: string }[];
  inputPopulationIds: unknown;
  parameters: Record<string, unknown>[];
  vertices: { x: number; y: number }[];
  labelOrigin?: { x: number; y: number };
  gateKind: string;
  name: string;
  gateId: string;
  parentPopulationId: string;
  categories: unknown[];
}

const AUTOMATIC = new Set(["Saturated", "Unsaturated"]);
const ROOT = "0-1";
/** Points inserted along each raw-straight edge drawn on a biexponential axis. */
const DENSIFY = 12;

const num = (v: number): number => (Object.is(v, -0) ? 0 : v);

/** "#rrggbb" → "r,g,b", Chorus's colour form; anything else is left to Chorus's default. */
function chorusColor(color: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  return m ? `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}` : "0,0,0";
}

/** The FCS name's fluorochrome or measurement, and its measurement letter. */
function splitPnn(pnn: string): { base: string; measurement: string | null } {
  const m = /^(.*)-([AHWT])$/.exec(pnn);
  return m ? { base: m[1], measurement: m[2] } : { base: pnn, measurement: null };
}

/**
 * The Chorus parameter object for an FCS channel: the one a source gate or plot already uses for
 * that name, else built from the experiment's fluorochromes (a colour) or the name itself (scatter
 * and image features), in the key set this file's parameters use.
 */
function parameterFor(
  pnn: string,
  known: Map<string, Record<string, unknown>>,
  fluorochromeIds: Map<string, string>,
  template: Record<string, unknown> | null,
  display: Map<string, { T: number; M: number; R: number }> | null,
): Record<string, unknown> {
  const hit = known.get(pnn);
  if (hit) return hit;
  const { base, measurement } = splitPnn(pnn);
  const fluorochromeId = fluorochromeIds.get(base);
  const isColor = fluorochromeId !== undefined;
  const scatterWord = base.split(" ")[0];
  const p: Record<string, unknown> = {
    measurementId: isColor ? fluorochromeId : base,
    fluorochrome: isColor ? base : scatterWord,
    measurement: measurement,
    scatter: isColor ? "" : scatterWord,
    scale: isColor || display?.has(pnn) ? "Biexponential" : "Linear",
    parameterKind: isColor ? "Color" : measurement ? "Scatter" : base.split(" ")[0],
  };
  if (template && "name" in template) p.name = `${p.measurementId}-${measurement ?? ""}`.replace(/-$/, "");
  if (template && "numerator" in template) { p.numerator = null; p.denominator = null; }
  if (!measurement) p.parameterKind = (template?.parameterKind as string) ?? "Max Intensity";
  // Keys in the file's own order where a template exists.
  if (template) {
    const ordered: Record<string, unknown> = {};
    for (const k of Object.keys(template)) if (k in p) ordered[k] = p[k];
    for (const k of Object.keys(p)) if (!(k in ordered)) ordered[k] = p[k];
    return ordered;
  }
  return p;
}

/** The raw vertices Chorus holds for a GateLab gate, in the gate's own order. */
function rawVertices(
  gate: Gate,
  axes: [string, string],
  chorusSpecs: [TransformSpec | null, TransformSpec | null],
  windows: [[number, number], [number, number]],
  warn: (msg: string) => void,
): { x: number; y: number }[][] | null {
  const toRaw = (point: [number, number]): [number, number] => {
    if (gate.space !== "display" || !gate.transforms) return point;
    const tx = gate.transforms[axes[0]], ty = gate.transforms[axes[1]];
    return [tx ? transformFromSpec(tx).inverse(point[0]) : point[0], ty ? transformFromSpec(ty).inverse(point[1]) : point[1]];
  };
  // Densify a raw-straight edge where Chorus would draw it straight in its biexponential: the
  // points between the corners, spaced evenly in raw, keep the outline where the two differ.
  const biex = chorusSpecs.map((s) => s !== null && s.kind !== "identity");
  const densify = gate.space !== "display" && (biex[0] || biex[1]);
  const outline = (pts: [number, number][]): { x: number; y: number }[] => {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      out.push({ x: num(a[0]), y: num(a[1]) });
      if (densify) for (let k = 1; k < DENSIFY; k++) { const t = k / DENSIFY; out.push({ x: num(a[0] + (b[0] - a[0]) * t), y: num(a[1] + (b[1] - a[1]) * t) }); }
    }
    return out;
  };
  switch (gate.gate_type) {
    case "rectangle": {
      const [p, q] = gate.vertices.map(toRaw);
      const x0 = Math.min(p[0], q[0]), x1 = Math.max(p[0], q[0]), y0 = Math.min(p[1], q[1]), y1 = Math.max(p[1], q[1]);
      // Axis-aligned under monotone axes: the corners alone describe it exactly.
      return [[{ x: num(x0), y: num(y0) }, { x: num(x1), y: num(y0) }, { x: num(x1), y: num(y1) }, { x: num(x0), y: num(y1) }]];
    }
    case "polygon":
      return [gate.space === "display" ? gate.vertices.map(toRaw).map(([x, y]) => ({ x: num(x), y: num(y) })) : outline(gate.vertices)];
    case "ellipse": {
      const boundary = ellipseBoundary(gate, 64).map(toRaw);
      warn(`"${gate.name}" is an ellipse, which Chorus does not draw; it is written as a 64-sided polygon on its outline.`);
      return [boundary.map(([x, y]) => ({ x: num(x), y: num(y) }))];
    }
    case "quadrant": {
      const [cx, cy] = toRaw(gate.center);
      const [[xlo, xhi], [ylo, yhi]] = windows;
      if (gate.curl) warn(`"${gate.name}" is a curly quadrant; its arms are written straight, as Chorus draws.`);
      const rect = (x0: number, x1: number, y0: number, y1: number) => [{ x: num(x0), y: num(y0) }, { x: num(x1), y: num(y0) }, { x: num(x1), y: num(y1) }, { x: num(x0), y: num(y1) }];
      // Q1 = x- y+, Q2 = x+ y+, Q3 = x+ y-, Q4 = x- y-, GateLab's order; bounded by the axis window.
      return [rect(xlo, cx, cy, yhi), rect(cx, xhi, cy, yhi), rect(cx, xhi, ylo, cy), rect(xlo, cx, ylo, cy)];
    }
  }
}

export function exportChorusExperiment(input: ChorusExportInput): ChorusExportResult {
  const warnings: string[] = [];
  const warn = (msg: string) => { if (!warnings.includes(msg)) warnings.push(msg); };
  const skipped: { name: string; why: string }[] = [];
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(input.source); } catch { throw new Error("The source is not a FACSChorus experiment file (.cef): it is not a zip archive."); }
  const expBytes = files["experiment.json"];
  if (!expBytes) throw new Error("The source is not a FACSChorus experiment file (.cef): it holds no experiment.json.");
  const text = strFromU8(expBytes);
  const doc = JSON.parse(text) as { experiment: { panels: { analysis: { gates: ChorusJsonGate[]; analysisWorksheets?: { plots?: { parentPopulationId?: string }[] }[] }; sortMappings?: { assignedPopulations?: string[] }[]; reagents?: { fluorochromeId: string; fluorochrome: string }[] }[] }; fluorochromes?: { fluorochromeId: string; name: string }[] };
  const panel = doc.experiment?.panels?.[0];
  if (!panel?.analysis) throw new Error("The source experiment has no panel with an analysis to write gates into.");
  const sourceGates = panel.analysis.gates ?? [];

  // What the source knows: parameter objects by FCS name, fluorochrome ids, the key set in use.
  const known = new Map<string, Record<string, unknown>>();
  let template: Record<string, unknown> | null = null;
  const nameOf = (p: Record<string, unknown>): string | null => {
    const measurement = typeof p.measurement === "string" ? p.measurement : null;
    const id = String(p.measurementId ?? "");
    if (!measurement) return id || null;
    if (id.includes("_|_")) return null;
    const base = p.parameterKind === "Color" && p.fluorochrome ? String(p.fluorochrome) : id;
    return `${base}-${measurement}`;
  };
  for (const g of sourceGates) for (const p of g.parameters ?? []) {
    template ??= p;
    const n = nameOf(p);
    if (n && !known.has(n)) known.set(n, p);
  }
  const fluorochromeIds = new Map<string, string>();
  for (const f of doc.fluorochromes ?? []) if (f.name && f.fluorochromeId) fluorochromeIds.set(f.name, f.fluorochromeId);
  for (const r of panel.reagents ?? []) if (r.fluorochrome && r.fluorochromeId) fluorochromeIds.set(r.fluorochrome, r.fluorochromeId);
  const display = chorusDisplayFromKeywords(input.keywords);
  const pnnOf = new Map(input.channels.map((c) => [c.key, c.pnn] as const));

  // The source tree by population id, and each population's name and parent, for matching.
  const sourceByPop = new Map<string, ChorusJsonGate>();
  const sourceParent = new Map<string, string>();
  for (const g of sourceGates) for (const c of g.children ?? []) { sourceByPop.set(c.populationId, g); sourceParent.set(c.populationId, g.parentPopulationId); }
  const sourceKey = (popId: string): string => `${sourceParent.get(popId) ?? ""}\u0000${sourceByPop.get(popId)?.children.find((c) => c.populationId === popId)?.name ?? ""}`;
  const sourceByKey = new Map<string, string>();
  for (const popId of sourceByPop.keys()) sourceByKey.set(sourceKey(popId), popId);
  let nextGateId = sourceGates.reduce((m, g) => Math.max(m, Number(g.gateId) || 0), 0) + 1;

  // The axis window Chorus shows, for a quadrant's outer corners: the file's own, else the data's range.
  const windowFor = (pnn: string): [number, number] => {
    const kw = input.keywords ?? {};
    const n = Number(kw["$PAR"]) || 0;
    for (let i = 1; i <= n; i++) {
      if (kw[`$P${i}N`] !== pnn) continue;
      const lo = Number(kw[`P${i}MDMin`]), hi = Number(kw[`P${i}MDMax`]);
      if (Number.isFinite(lo) && Number.isFinite(hi)) return [lo, hi];
      const r = Number(kw[`$P${i}R`]);
      if (Number.isFinite(r)) return [0, r];
    }
    return [0, 262144];
  };

  // Walk GateLab's tree from the root; each population becomes one Polygon under its parent's
  // Chorus population id, which is the source's where the population matches, else a new one.
  const out: ChorusJsonGate[] = sourceGates.filter((g) => AUTOMATIC.has(g.gateKind));
  const chorusPopId = new Map<string, string>([[input.root_population_id, ROOT]]);
  let written = 0;
  const visit = (pop: Population): void => {
    const parentId = chorusPopId.get(pop.parent_id ?? input.root_population_id);
    if (!parentId) return;
    const included = pop.gate_refs.filter((r) => r.include);
    const why = pop.gate_refs.length === 0 ? "it has no gate"
      : pop.gate_refs.some((r) => !r.include) ? "it excludes a gate (NOT), which Chorus has no form for"
      : pop.gate_logic === "or" ? "it is an OR of gates, which Chorus has no form for"
      : included.length !== 1 ? `it is the AND of ${included.length} gates, where Chorus draws one gate per population`
      : null;
    const gate = why ? null : input.gates[included[0].gate_id];
    if (why || !gate) {
      skipped.push({ name: pop.name, why: why ?? "its gate is missing" });
      return;
    }
    const axes: [string, string] = [gate.x_channel, gate.y_channel];
    const pnns = axes.map((k) => pnnOf.get(k) ?? k) as [string, string];
    const specs = pnns.map((p) => (display?.get(p) ? chorusAxisSpec(display.get(p)!) : null)) as [TransformSpec | null, TransformSpec | null];
    const windows = pnns.map(windowFor) as [[number, number], [number, number]];
    const polygons = rawVertices(gate, axes, specs, windows, warn);
    if (!polygons) { skipped.push({ name: pop.name, why: "its gate has no Chorus form" }); return; }
    const quadrant = included[0].quadrant;
    let polygon = gate.gate_type === "quadrant" ? polygons[quadrant ?? 0] : polygons[0];
    if (!polygon || polygon.length < 3) { skipped.push({ name: pop.name, why: "its gate has fewer than three vertices" }); return; }
    // The importer qualifies a name that recurs under different parents ("Scatter/P1"); Chorus
    // allows the repeat, so the match and the name written are the unqualified one.
    const short = pop.name.includes("/") ? pop.name.slice(pop.name.lastIndexOf("/") + 1) : pop.name;
    // The importer attaches what sat beneath Chorus's automatic Unsaturated filter to the filter's
    // parent, so a match is also sought under the automatic gates that hang off this parent, and a
    // population found there goes back beneath the filter it came from.
    const parents = [parentId, ...out.filter((g) => AUTOMATIC.has(g.gateKind) && g.parentPopulationId === parentId).flatMap((g) => g.children.map((c) => c.populationId))];
    let existing: string | undefined;
    let writtenParent = parentId;
    let writtenName = pop.name;
    for (const candidate of parents) {
      for (const name of [pop.name, short]) {
        const hit = sourceByKey.get(`${candidate}\u0000${name}`);
        if (hit) { existing = hit; writtenParent = candidate; writtenName = name; break; }
      }
      if (existing) break;
    }
    const sourceGate = existing ? sourceByPop.get(existing) : undefined;
    // A vertex that came through the display and back lands within floating-point noise of the
    // one Chorus wrote; where it does, Chorus's own value is written, so a gate nobody moved goes
    // back exactly and a moved vertex goes back as moved.
    if (sourceGate && sourceGate.vertices.length === polygon.length) {
      polygon = polygon.map((v, i) => {
        const o = sourceGate.vertices[i];
        const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 1e-9 + 1e-9;
        return { x: near(v.x, o.x) ? o.x : v.x, y: near(v.y, o.y) ? o.y : v.y };
      });
    }
    const gateId = sourceGate?.gateId ?? String(nextGateId++);
    const popId = existing ?? `${gateId}-1`;
    chorusPopId.set(pop.population_id, popId);
    const parameters = pnns.map((p) => parameterFor(p, known, fluorochromeIds, template, display));
    const chorusGate: ChorusJsonGate = {
      children: [{ name: writtenName, color: chorusColor(gate.color), populationId: popId }],
      inputPopulationIds: null,
      parameters,
      vertices: polygon,
      ...(sourceGate?.labelOrigin ? { labelOrigin: sourceGate.labelOrigin } : {}),
      gateKind: "Polygon",
      // Chorus labels a gate apart from its population ("P3" for "CD45RB-IgD+"); a matched gate
      // keeps its label, a new one is labelled as GateLab names it.
      name: sourceGate?.name ?? (gate.gate_type === "quadrant" ? `${gate.name} Q${(quadrant ?? 0) + 1}` : gate.name),
      gateId,
      parentPopulationId: writtenParent,
      categories: sourceGate?.categories ?? [],
    };
    out.push(chorusGate);
    written++;
    for (const childId of pop.children) { const child = input.populations[childId]; if (child) visit(child); }
  };
  const root = input.populations[input.root_population_id];
  if (!root) throw new Error("The tree has no root population.");
  for (const childId of root.children) { const child = input.populations[childId]; if (child) visit(child); }

  // Chorus's own order for the gates it already had (ids are strings; the file lists them in
  // the order they were made), new gates after them in tree order.
  const sourceOrder = new Map(sourceGates.map((g, i) => [g.gateId, i] as const));
  out.sort((a, b) => (sourceOrder.get(a.gateId) ?? Number.POSITIVE_INFINITY) - (sourceOrder.get(b.gateId) ?? Number.POSITIVE_INFINITY) || out.indexOf(a) - out.indexOf(b));

  // References to populations that are no longer there.
  const present = new Set(out.flatMap((g) => g.children.map((c) => c.populationId)));
  present.add(ROOT);
  const changedMappings = new Set<number>();
  (panel.sortMappings ?? []).forEach((m, i) => {
    const before = m.assignedPopulations ?? [];
    const kept = before.filter((id) => present.has(id));
    if (kept.length !== before.length) {
      const gone = before.filter((id) => !present.has(id)).map((id) => sourceByPop.get(id)?.children.find((c) => c.populationId === id)?.name ?? id);
      m.assignedPopulations = kept;
      changedMappings.add(i);
      warn(`A sort destination was assigned to ${gone.map((n) => `"${n}"`).join(", ")}, which the tree no longer holds; the assignment is cleared.`);
    }
  });
  const survivingAncestor = (id: string): string => { let cur: string | undefined = id; while (cur && !present.has(cur)) cur = sourceParent.get(cur); return cur ?? ROOT; };
  const changedPlots = new Set<string>();
  (panel.analysis.analysisWorksheets ?? []).forEach((ws, w) => (ws.plots ?? []).forEach((plot, q) => {
    if (plot.parentPopulationId && !present.has(plot.parentPopulationId)) {
      const was = sourceByPop.get(plot.parentPopulationId)?.children.find((c) => c.populationId === plot.parentPopulationId)?.name ?? plot.parentPopulationId;
      plot.parentPopulationId = survivingAncestor(plot.parentPopulationId);
      changedPlots.add(`${w}/${q}`);
      warn(`A worksheet plot of "${was}", which the tree no longer holds, now shows its nearest remaining ancestor.`);
    }
  }));
  for (const s of skipped) warn(`"${s.name}" was left out with everything beneath it: ${s.why}.`);

  // The file back as text: the gates array, and any sort destination or plot that changed, are
  // spliced into the source's own text, so everything else — and an unchanged tree — is byte for
  // byte what Chorus wrote. Chorus's JSON is two-space indented with CRLF line ends, doubles
  // written with a decimal point and exponents in .NET's form; the same is written here.
  const edits: { span: [number, number]; text: string }[] = [];
  const gatesPath = ["experiment", "panels", 0, "analysis", "gates"];
  const gatesSpan = findJsonValueSpan(text, gatesPath);
  if (!gatesSpan) throw new Error("The source experiment's gates could not be located in its text.");
  const style = jsonStyleAt(text, gatesSpan[0]);
  edits.push({ span: gatesSpan, text: formatChorusJson(out, style, DOUBLE_FIELDS) });
  (panel.sortMappings ?? []).forEach((m, i) => {
    if (!changedMappings.has(i)) return;
    const span = findJsonValueSpan(text, ["experiment", "panels", 0, "sortMappings", i, "assignedPopulations"]);
    if (span) edits.push({ span, text: formatChorusJson(m.assignedPopulations ?? [], jsonStyleAt(text, span[0]), DOUBLE_FIELDS) });
  });
  (panel.analysis.analysisWorksheets ?? []).forEach((ws, w) => (ws.plots ?? []).forEach((plot, q) => {
    if (!changedPlots.has(`${w}/${q}`)) return;
    const span = findJsonValueSpan(text, ["experiment", "panels", 0, "analysis", "analysisWorksheets", w, "plots", q, "parentPopulationId"]);
    if (span) edits.push({ span, text: JSON.stringify(plot.parentPopulationId) });
  }));
  edits.sort((a, b) => b.span[0] - a.span[0]);
  let json = text;
  for (const e of edits) json = json.slice(0, e.span[0]) + e.text + json.slice(e.span[1]);
  const entries: Record<string, Uint8Array> = {};
  for (const name of Object.keys(files)) entries[name] = name === "experiment.json" ? strToU8(json) : files[name];
  const bytes = zipSync(entries, { level: 6 });
  return { bytes, written, skipped, warnings };
}

/** Fields Chorus writes as doubles, with a decimal point even when integral. */
const DOUBLE_FIELDS = new Set(["x", "y"]);

interface JsonStyle {
  /** Line end and per-level indent, or null for a one-line value. */
  pretty: { eol: string; unit: string; base: string } | null;
}

/** The formatting of the value starting at `at`: its line end, indent unit, and the indent of its own line. */
export function jsonStyleAt(text: string, at: number): JsonStyle {
  const lineStart = text.lastIndexOf("\n", at) + 1;
  const base = /^[ \t]*/.exec(text.slice(lineStart, at))![0];
  const after = text.slice(at + 1, at + 40);
  const m = /^(\r?\n)([ \t]*)/.exec(after);
  if (!m) return { pretty: null };
  const eol = m[1];
  const unit = m[2].length > base.length ? m[2].slice(base.length) : "  ";
  return { pretty: { eol, unit, base } };
}

/** A number as .NET writes a double: a decimal point kept, exponents as E-07 / E+15. */
function formatDouble(n: number): string {
  if (!Number.isFinite(n)) return "0.0";
  if (n === 0) return Object.is(n, -0) ? "-0.0" : "0.0";
  // .NET's shortest round-trip form goes scientific below 1E-05 and from 1E+15, with the exponent
  // at least two digits; JavaScript's thresholds are 1e-7 and 1e21.
  const exponent = Math.floor(Math.log10(Math.abs(n)));
  if (exponent < -4 || exponent >= 15) {
    const [mantissa, exp] = n.toExponential().split("e");
    const sign = exp.startsWith("-") ? "-" : "+";
    return `${mantissa}E${sign}${exp.replace(/^[+-]/, "").padStart(2, "0")}`;
  }
  let s = String(n);
  const e = /^(-?\d+(?:\.\d+)?)e([+-])(\d+)$/.exec(s);
  if (e) return `${e[1]}E${e[2]}${e[3].padStart(2, "0")}`;
  if (!s.includes(".")) s += ".0";
  return s;
}

/** JSON in Chorus's own layout, from the style of the value it replaces. */
export function formatChorusJson(value: unknown, style: JsonStyle, doubles: Set<string>, depth = 0, key: string | null = null): string {
  const pretty = style.pretty;
  const indent = (d: number) => (pretty ? pretty.base + pretty.unit.repeat(d) : "");
  const eol = pretty ? pretty.eol : "";
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return key !== null && doubles.has(key) ? formatDouble(value) : Number.isInteger(value) ? String(value) : formatDouble(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const items = value.map((v) => indent(depth + 1) + formatChorusJson(v, style, doubles, depth + 1, null));
    return pretty ? `[${eol}${items.join("," + eol)}${eol}${indent(depth)}]` : `[${items.join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (!keys.length) return "{}";
  const items = keys.map((k) => `${indent(depth + 1)}${JSON.stringify(k)}: ${formatChorusJson(obj[k], style, doubles, depth + 1, k)}`);
  return pretty ? `{${eol}${items.join("," + eol)}${eol}${indent(depth)}}` : `{${items.join(",")}}`;
}

/**
 * The [start, end) of the value at `path` in a JSON text, found by scanning the text once with the
 * container path kept as a stack, so the value can be replaced without re-serialising the rest.
 */
export function findJsonValueSpan(text: string, path: readonly (string | number)[]): [number, number] | null {
  const stack: { kind: "object" | "array"; key: string | number | null; index: number }[] = [];
  let i = 0;
  const n = text.length;
  let pendingKey: string | null = null;
  let found: [number, number] | null = null;
  const current = (): (string | number)[] => stack.map((s) => (s.kind === "array" ? s.index : s.key!));
  const atPath = (): boolean => { const c = current(); return c.length === path.length && c.every((v, k) => v === path[k]); };
  const skipWs = () => { while (i < n && /\s/.test(text[i])) i++; };
  const readString = (): string => { const start = i; i++; while (i < n) { if (text[i] === "\\") { i += 2; continue; } if (text[i] === '"') { i++; break; } i++; } return JSON.parse(text.slice(start, i)) as string; };
  const readScalar = () => { while (i < n && !/[,\]}\s]/.test(text[i])) i++; };
  // Values are visited in order; a container's children get their key (object) or index (array).
  const visitValue = (): void => {
    skipWs();
    const start = i;
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const kind = ch === "{" ? "object" : "array";
      stack.push({ kind, key: null, index: -1 });
      i++;
      skipWs();
      const close = ch === "{" ? "}" : "]";
      while (i < n && text[i] !== close) {
        const frame = stack[stack.length - 1];
        if (kind === "object") { skipWs(); frame.key = readString(); skipWs(); i++; /* : */ } else frame.index++;
        visitValue();
        skipWs();
        if (text[i] === ",") { i++; skipWs(); }
      }
      i++; // close
      stack.pop();
    } else if (ch === '"') readString();
    else readScalar();
    if (!found && atPath()) found = [start, i];
  };
  visitValue();
  void pendingKey;
  return found;
}
