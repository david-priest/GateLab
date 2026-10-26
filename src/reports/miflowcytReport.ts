// miflowcytReport.ts — a gating-analysis report organised by MIFlowCyt (Lee et al., Cytometry A
// 2008;73:926–930, Table 1): experiment overview, flow sample, instrument, data analysis.
//
// GateLab can state the instrument items the FCS TEXT segment carries and every data-analysis
// item it holds itself: the list-mode files, the compensation applied, each gate's boundary with
// the space and transform it is evaluated in, the hierarchy traced to all events, and counts with
// their denominators named. The experiment overview and the specimen are the author's to supply;
// an item with no value is listed as not recorded, never filled with a default.
//
// Headless: the caller passes the evaluated counts, so nothing here gates events or touches the
// engine's state. Rendered as Markdown; the structured report is returned as well.

import type { Sample, SpilloverOrigin } from "../engine/sample";
import type { DisplaySpillover } from "../engine/compensation";
import {
  isUnbounded,
  rectangleRule,
  type Gate,
  type GateRef,
  type PopulationMap,
  type TransformSpec,
} from "../engine/models";
import { populationTreeOrder } from "../engine/populations";

/** Items only the author can supply; each absent one is reported as not recorded. */
export interface MiflowcytAuthorInput {
  purpose?: string;
  keywords?: string[];
  /** Conditional and manipulated variables, e.g. "Donor (D1, D2, D3); stimulation (treated, control)". */
  experimentVariables?: string;
  conclusions?: string;
  qualityControl?: string;
  contact?: string;
  material?: string;
  source?: string;
  organism?: string;
  treatment?: string;
  /** Reagents, where the analyte measured is ambiguous from the $PnS label alone. */
  reagents?: string;
  /** How the list-mode data can be obtained (repository and accession, or on request). */
  dataAvailability?: string;
}

export interface MiflowcytFileInput {
  fileName: string;
  sample: Sample;
  gates: Record<string, Gate>;
  populations: PopulationMap;
  rootId: string;
  /** Evaluated event count per population id, as the Statistics tab holds them. */
  counts: Record<string, number | null>;
  /** Gate ids whose coordinates this file holds as its own (per-file tailoring). */
  tailoredGateIds?: readonly string[];
  /**
   * The applied matrix when it is not held on the sample: a compensation profile's. Without it a
   * profile layer is reported by its id and matrix hash.
   */
  profileMatrix?: DisplaySpillover;
}

export interface MiflowcytReportInput {
  files: MiflowcytFileInput[];
  software: { name: string; version: string; commit?: string };
  /** ISO 8601. */
  generatedAt: string;
  author?: MiflowcytAuthorInput;
  /** Counts below this are marked in the statistics table; absent, none are. */
  minEvents?: number;
}

export interface MiflowcytItem {
  label: string;
  /** null when the item is not recorded anywhere GateLab can read. */
  value: string | null;
  /** Where the value came from: "author", an FCS keyword, or "GateLab". */
  source: string | null;
}

export interface MiflowcytPopulationRow {
  path: string;
  definition: string;
  count: number | null;
  /** Denominator population's path for % of parent; null for the root. */
  parentPath: string | null;
  pctParent: number | null;
  pctTotal: number | null;
  belowMinEvents: boolean;
}

export interface MiflowcytFileReport {
  fileName: string;
  instrument: MiflowcytItem[];
  parameters: MiflowcytParameterRow[];
  listMode: MiflowcytItem[];
  compensation: { description: string; matrix: DisplaySpillover | null };
  gates: { name: string; tailored: boolean; description: string }[];
  populations: MiflowcytPopulationRow[];
}

export interface MiflowcytParameterRow {
  pnn: string;
  marker: string | null;
  /** FCS $Pn keywords that describe acquisition, by suffix (V, G, L, F, O, T, E, TYPE, FEATURE). */
  keywords: Record<string, string>;
}

export interface MiflowcytReport {
  generatedAt: string;
  software: string;
  overview: MiflowcytItem[];
  specimen: MiflowcytItem[];
  dataAvailability: MiflowcytItem;
  files: MiflowcytFileReport[];
  /** Labels of the items with no value, in report order. */
  notRecorded: string[];
}

/** The $Pn keyword suffixes that describe how a parameter was acquired (FCS 3.1 and 3.2). */
const PARAMETER_KEYWORDS = ["V", "G", "L", "O", "F", "T", "E", "TYPE", "FEATURE"] as const;

/** Instrument-level TEXT keywords, in the order they are reported. */
const INSTRUMENT_KEYWORDS: [string, string][] = [
  ["$CYT", "Cytometer"],
  ["$CYTSN", "Cytometer serial number"],
  ["$SYS", "Acquisition system"],
  ["$INST", "Institution"],
  ["$OP", "Operator"],
  ["$DATE", "Acquisition date"],
  ["$BTIM", "Acquisition start"],
  ["$ETIM", "Acquisition end"],
];

const QUADRANT_SIGNS = ["x− y+", "x+ y+", "x+ y−", "x− y−"];

function authorItem(label: string, value: string | undefined): MiflowcytItem {
  const v = value?.trim();
  return { label, value: v ? v : null, source: v ? "author" : null };
}

function keyword(sample: Sample, key: string): string | null {
  const kw = sample.fcs.keywords;
  const v = kw[key] ?? kw[key.toUpperCase()] ?? kw[key.toLowerCase()];
  return v === undefined || v.trim() === "" ? null : v.trim();
}

/** A coordinate as written in the report: six significant figures, or "no bound". */
function num(v: number): string {
  if (isUnbounded(v)) return v < 0 ? "no lower bound" : "no upper bound";
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(6)));
}

export function describeTransform(spec: TransformSpec): string {
  let text: string;
  switch (spec.kind) {
    case "identity": text = "linear"; break;
    case "asinh": text = `arcsinh(x / ${num(spec.cofactor)})`; break;
    case "logicle": text = `logicle (T = ${num(spec.T)}, W = ${num(spec.W)}, M = ${num(spec.M)}, A = ${num(spec.A)})`; break;
    case "hyperlog": text = `hyperlog (T = ${num(spec.T)}, W = ${num(spec.W)}, M = ${num(spec.M)}, A = ${num(spec.A)})`; break;
    case "biex":
      text = `FlowJo biexponential (maximum ${num(spec.maxValue)}, positive decades ${num(spec.pos)}, ` +
        `negative decades ${num(spec.neg)}, width basis ${num(spec.widthBasis)}, ${num(spec.channelRange)} channels)`;
      break;
    case "wsplog": text = `FlowJo log (offset ${num(spec.offset)}, ${num(spec.decades)} decades)`; break;
    case "flog": text = `Gating-ML flog (T = ${num(spec.T)}, M = ${num(spec.M)})`; break;
    case "flowjoChannels": text = `FlowJo gate grid of ${spec.channels} channels`; break;
  }
  if ("bounds" in spec && spec.bounds && (spec.bounds.min !== undefined || spec.bounds.max !== undefined)) {
    const parts: string[] = [];
    if (spec.bounds.min !== undefined) parts.push(`boundMin ${num(spec.bounds.min)}`);
    if (spec.bounds.max !== undefined) parts.push(`boundMax ${num(spec.bounds.max)}`);
    text += `, ${parts.join(", ")}`;
  }
  return text;
}

/** The space a gate's coordinates are in, with the transform on each of its axes. */
function describeSpace(gate: Gate, sample: Sample): string {
  if (sample.gateSpace(gate) === "raw") {
    return "raw channel values (straight in raw space; independent of display scales)";
  }
  const axes = gate.x_channel === gate.y_channel ? [gate.x_channel] : [gate.x_channel, gate.y_channel];
  if (!gate.transforms) {
    // A CyTOF gate made before gates carried their transform: read in the sample's display space.
    return `display space of the sample (arcsinh, cofactor ${num(sample.arcsinhCofactor)})`;
  }
  const specs = axes.map((ch) => {
    const spec = gate.transforms?.[ch];
    return `${ch}: ${spec ? describeTransform(spec) : "linear"}`;
  });
  return `transformed space (${specs.join("; ")})`;
}

export function describeGate(gate: Gate, sample: Sample): string {
  const space = describeSpace(gate, sample);
  const axes = `${gate.x_channel} × ${gate.y_channel}`;
  switch (gate.gate_type) {
    case "rectangle": {
      const [a, b] = gate.vertices;
      const xs = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
      const ys = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
      const rule = rectangleRule(gate) === "half-open" ? "lower edge included, upper edge excluded" : "both edges included";
      const range = (ch: string, r: number[]) => `${ch} from ${num(r[0])} to ${num(r[1])}`;
      const body = gate.x_channel === gate.y_channel
        ? range(gate.x_channel, xs)
        : `${range(gate.x_channel, xs)}; ${range(gate.y_channel, ys)}`;
      return `Rectangle on ${axes}: ${body} (${rule}). Coordinates in ${space}.`;
    }
    case "polygon": {
      const vs = gate.vertices.map(([x, y]) => `(${num(x)}, ${num(y)})`).join(", ");
      return `Polygon on ${axes} with ${gate.vertices.length} vertices: ${vs}. Boundary inclusive. Coordinates in ${space}.`;
    }
    case "ellipse": {
      const [[a, b], [, d]] = gate.covariance;
      return `Ellipse on ${axes}: centre (${num(gate.mean[0])}, ${num(gate.mean[1])}), covariance ` +
        `[[${num(a)}, ${num(b)}], [${num(b)}, ${num(d)}]], squared Mahalanobis radius ${num(gate.distance_square)}. ` +
        `Boundary inclusive. Coordinates in ${space}.`;
    }
    case "quadrant": {
      let shape = "straight crosshair";
      if (gate.curl) shape = `curved arms (horizontal k = ${num(gate.curl.kx)}, vertical k = ${num(gate.curl.ky)}, power ${num(gate.curl.power)})`;
      else if (gate.arms) {
        const arm = (p: readonly number[]) => `(${num(p[0])}, ${num(p[1])})`;
        shape = `arms ending at up ${arm(gate.arms.up)}, right ${arm(gate.arms.right)}, down ${arm(gate.arms.down)}, left ${arm(gate.arms.left)}`;
      }
      return `Quadrant on ${axes} centred at (${num(gate.center[0])}, ${num(gate.center[1])}), ${shape}; ` +
        `Q1 ${QUADRANT_SIGNS[0]}, Q2 ${QUADRANT_SIGNS[1]}, Q3 ${QUADRANT_SIGNS[2]}, Q4 ${QUADRANT_SIGNS[3]}; ` +
        `an event on a divider belongs to the upper side. Coordinates in ${space}.`;
    }
  }
}

function describeRef(ref: GateRef, gates: Record<string, Gate>): string {
  const gate = gates[ref.gate_id];
  let name = gate ? gate.name : `missing gate ${ref.gate_id}`;
  if (gate?.gate_type === "quadrant" && ref.quadrant !== undefined) {
    name += ` Q${ref.quadrant} (${QUADRANT_SIGNS[ref.quadrant - 1] ?? "?"})`;
  }
  return ref.include ? `inside ${name}` : `outside ${name}`;
}

/** Each population's path from the root, joined with " / ". */
export function populationPaths(populations: PopulationMap, rootId: string): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const { popId } of populationTreeOrder(populations, rootId)) {
    const pop = populations[popId];
    const parent = pop?.parent_id ? paths[pop.parent_id] : undefined;
    paths[popId] = parent !== undefined ? `${parent} / ${pop.name}` : pop?.name ?? popId;
  }
  return paths;
}

function compensationFor(file: MiflowcytFileInput): MiflowcytFileReport["compensation"] {
  const { sample } = file;
  const embedded = sample.fcs.spillover !== null;
  const metadata = sample.activeCompensatedLayerMetadata;
  if (!sample.compensationEnabled || !metadata) {
    const note = embedded ? " The file carries a spillover matrix, which was not applied." : "";
    return {
      description: "No software compensation was applied in GateLab. Hardware compensation, if any, is not recorded by GateLab." + note,
      matrix: null,
    };
  }
  if (metadata.runtimeIdentity === "profile") {
    const matrix = file.profileMatrix ?? null;
    const held = matrix ? "" : ` The matrix is held in that profile (matrix SHA-256 ${metadata.matrixHash}).`;
    return {
      description: `Software compensation (${metadata.kind}, ${metadata.method}) with compensation profile ` +
        `${metadata.profileId}, on ${metadata.includedPnns.length} parameters.${held}`,
      matrix,
    };
  }
  const origin: SpilloverOrigin = sample.spilloverOrigin;
  let source: string;
  if (origin.kind === "external") {
    source = `the matrix "${origin.label}", supplied from outside the file` +
      (origin.replacedEmbedded ? " in place of the file's own matrix" : "");
  } else {
    source = "the spillover matrix embedded in the FCS file";
  }
  const dropped = origin.droppedChannels && origin.droppedChannels.length > 0
    ? ` Parameters in the matrix but not in the sample, left out: ${origin.droppedChannels.join(", ")}.`
    : "";
  return {
    description: `Software compensation by matrix inversion with ${source}.${dropped}`,
    matrix: sample.spillover,
  };
}

function fileReport(file: MiflowcytFileInput, minEvents: number | undefined): MiflowcytFileReport {
  const { sample } = file;
  const instrument: MiflowcytItem[] = INSTRUMENT_KEYWORDS.map(([key, label]) => {
    const value = keyword(sample, key);
    return { label, value, source: value === null ? null : `FCS ${key}` };
  });

  const parameters: MiflowcytParameterRow[] = sample.channels.map((ch) => {
    const n = ch.columnIndex + 1;
    const keywords: Record<string, string> = {};
    for (const suffix of PARAMETER_KEYWORDS) {
      const v = keyword(sample, `$P${n}${suffix}`);
      if (v !== null) keywords[suffix] = v;
    }
    return { pnn: ch.pnn, marker: ch.marker, keywords };
  });

  const listMode: MiflowcytItem[] = [
    { label: "File", value: file.fileName, source: "GateLab" },
    { label: "$FIL", value: keyword(sample, "$FIL"), source: keyword(sample, "$FIL") === null ? null : "FCS $FIL" },
    { label: "FCS version", value: sample.fcs.version || null, source: sample.fcs.version ? "FCS HEADER" : null },
    { label: "Events", value: String(sample.fcs.nEvents), source: "FCS $TOT" },
    { label: "Parameters", value: String(sample.fcs.channels.length), source: "FCS $PAR" },
  ];

  const tailored = new Set(file.tailoredGateIds ?? []);
  const usedGateIds = new Set<string>();
  for (const pop of Object.values(file.populations)) for (const ref of pop.gate_refs) usedGateIds.add(ref.gate_id);
  const gates = Object.values(file.gates)
    .filter((g) => usedGateIds.has(g.gate_id))
    .map((g) => ({ name: g.name, tailored: tailored.has(g.gate_id), description: describeGate(g, sample) }));

  const paths = populationPaths(file.populations, file.rootId);
  const total = file.counts[file.rootId] ?? sample.fcs.nEvents;
  const populations: MiflowcytPopulationRow[] = populationTreeOrder(file.populations, file.rootId).map(({ popId }) => {
    const pop = file.populations[popId];
    const count = popId === file.rootId ? (file.counts[popId] ?? sample.fcs.nEvents) : (file.counts[popId] ?? null);
    const isRoot = popId === file.rootId || !pop.parent_id;
    const parentCount = isRoot ? null : (file.counts[pop.parent_id!] ?? null);
    const definition = isRoot
      ? "all events"
      : pop.gate_refs.length === 0
        ? "all events of the parent"
        : pop.gate_refs.map((r) => describeRef(r, file.gates)).join(pop.gate_logic === "or" ? " or " : " and ");
    const pct = (n: number | null, d: number | null) =>
      n === null || d === null || d <= 0 ? null : Math.round((n / d) * 10000) / 100;
    return {
      path: paths[popId],
      definition,
      count,
      parentPath: isRoot ? null : paths[pop.parent_id!] ?? null,
      pctParent: isRoot ? 100 : pct(count, parentCount),
      pctTotal: pct(count, total),
      belowMinEvents: minEvents !== undefined && count !== null && count < minEvents,
    };
  });

  return { fileName: file.fileName, instrument, parameters, listMode, compensation: compensationFor(file), gates, populations };
}

export function buildMiflowcytReport(input: MiflowcytReportInput): MiflowcytReport {
  const a = input.author ?? {};
  const overview = [
    authorItem("Purpose", a.purpose),
    authorItem("Keywords", a.keywords?.join(", ")),
    authorItem("Experiment variables", a.experimentVariables),
    authorItem("Conclusions", a.conclusions),
    authorItem("Quality control", a.qualityControl),
    authorItem("Contact", a.contact),
  ];
  const specimen = [
    authorItem("Material", a.material),
    authorItem("Specimen source", a.source),
    authorItem("Organism", a.organism),
    authorItem("Treatment", a.treatment),
    authorItem("Reagents, analytes, detectors and reporters", a.reagents),
  ];
  const dataAvailability = authorItem("List-mode data availability", a.dataAvailability);
  const files = input.files.map((f) => fileReport(f, input.minEvents));
  const notRecorded = [...overview, ...specimen, dataAvailability].filter((i) => i.value === null).map((i) => i.label);
  for (const f of files) {
    for (const item of f.instrument) if (item.value === null) notRecorded.push(`${item.label} (${f.fileName})`);
  }
  const s = input.software;
  return {
    generatedAt: input.generatedAt,
    software: `${s.name} ${s.version}${s.commit ? ` (${s.commit})` : ""}`,
    overview,
    specimen,
    dataAvailability,
    files,
    notRecorded,
  };
}

const NOT_RECORDED = "Not recorded";

function itemLine(item: MiflowcytItem): string {
  const source = item.source && item.source !== "author" ? ` (${item.source})` : "";
  return `- ${item.label}: ${item.value ?? NOT_RECORDED}${item.value ? source : ""}`;
}

/** Markdown table cell text: pipes escaped, line breaks flattened. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function pctText(v: number | null): string {
  return v === null ? "" : v.toFixed(2);
}

export function renderMiflowcytMarkdown(report: MiflowcytReport): string {
  const out: string[] = [];
  out.push("# Flow cytometry analysis report (MIFlowCyt)", "");
  out.push(`Generated ${report.generatedAt} by ${report.software}. Sections follow MIFlowCyt 1.0 (Lee et al., Cytometry A 2008;73:926–930). Items marked "${NOT_RECORDED}" are not held in the GateLab workspace and are for the author to supply.`, "");

  out.push("## Experiment overview", "", ...report.overview.map(itemLine), "");
  out.push("## Flow sample", "", ...report.specimen.map(itemLine), "");

  out.push("## Data analysis", "", itemLine(report.dataAvailability), "");
  out.push("Gate coordinates are given in the space the gate is evaluated in. Percentages are of the named parent population (% parent) and of all events in the file (% total).", "");

  for (const f of report.files) {
    out.push(`### ${f.fileName}`, "");
    out.push("#### Instrument", "", ...f.instrument.map(itemLine), "");
    out.push("| Parameter ($PnN) | Marker ($PnS) | Acquisition keywords |", "| --- | --- | --- |");
    for (const p of f.parameters) {
      const kws = Object.entries(p.keywords).map(([k, v]) => `$Pn${k} ${v}`).join("; ");
      out.push(`| ${cell(p.pnn)} | ${cell(p.marker ?? "")} | ${cell(kws)} |`);
    }
    out.push("");
    out.push("#### List-mode data", "", ...f.listMode.map(itemLine), "");
    out.push("#### Compensation", "", f.compensation.description, "");
    const m = f.compensation.matrix;
    if (m) {
      out.push("Spillover matrix (row: source parameter; column: receiving parameter):", "");
      out.push(`| | ${m.channels.map(cell).join(" | ")} |`, `| --- |${m.channels.map(() => " --- |").join("")}`);
      m.matrix.forEach((row, i) => out.push(`| ${cell(m.channels[i])} | ${row.map((v) => num(v)).join(" | ")} |`));
      out.push("");
    }
    out.push("#### Gates", "");
    if (f.gates.length === 0) out.push("No gates.", "");
    for (const g of f.gates) out.push(`- ${g.name}${g.tailored ? " (coordinates specific to this file)" : ""}: ${g.description}`);
    if (f.gates.length) out.push("");
    out.push("#### Gating hierarchy and statistics", "");
    out.push("| Population | Definition | Events | % parent | Parent | % total |", "| --- | --- | ---: | ---: | --- | ---: |");
    for (const p of f.populations) {
      const count = p.count === null ? "" : `${p.count}${p.belowMinEvents ? " (below minimum)" : ""}`;
      out.push(`| ${cell(p.path)} | ${cell(p.definition)} | ${count} | ${pctText(p.pctParent)} | ${cell(p.parentPath ?? "")} | ${pctText(p.pctTotal)} |`);
    }
    out.push("");
  }

  if (report.notRecorded.length) {
    out.push("## Items not recorded", "", ...report.notRecorded.map((l) => `- ${l}`), "");
  }
  return out.join("\n");
}

const esc = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function itemHtml(item: MiflowcytItem): string {
  const source = item.value && item.source && item.source !== "author" ? ` <span class="src">(${esc(item.source)})</span>` : "";
  const value = item.value === null ? `<span class="nr">${NOT_RECORDED}</span>` : esc(item.value);
  return `<li><b>${esc(item.label)}:</b> ${value}${source}</li>`;
}

/** The report as one self-contained HTML page, laid out to print to PDF from the browser. */
export function renderMiflowcytHtml(report: MiflowcytReport): string {
  const out: string[] = [];
  out.push(
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><title>Flow cytometry analysis report (MIFlowCyt)</title>',
    "<style>",
    "body{font:13px/1.45 -apple-system,'Helvetica Neue',Arial,sans-serif;color:#111;max-width:1000px;margin:24px auto;padding:0 16px}",
    "h1{font-size:20px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #ccc}h3{font-size:14px;margin-top:22px}h4{font-size:13px;margin:16px 0 6px}",
    "table{border-collapse:collapse;margin:6px 0 12px;font-size:12px}th,td{border:1px solid #ccc;padding:3px 6px;text-align:left;vertical-align:top}td.n{text-align:right;font-variant-numeric:tabular-nums}",
    ".nr{color:#a33}.src{color:#666}.low{color:#a33}ul{padding-left:20px}",
    "@media print{body{margin:0;max-width:none}h3{break-before:page}}",
    "</style></head><body>",
    "<h1>Flow cytometry analysis report (MIFlowCyt)</h1>",
    `<p>Generated ${esc(report.generatedAt)} by ${esc(report.software)}. Sections follow MIFlowCyt 1.0 (Lee et al., Cytometry A 2008;73:926–930). Items marked “${NOT_RECORDED}” are not held in the GateLab workspace and are for the author to supply.</p>`,
    "<h2>Experiment overview</h2><ul>", ...report.overview.map(itemHtml), "</ul>",
    "<h2>Flow sample</h2><ul>", ...report.specimen.map(itemHtml), "</ul>",
    "<h2>Data analysis</h2><ul>", itemHtml(report.dataAvailability), "</ul>",
    "<p>Gate coordinates are given in the space the gate is evaluated in. Percentages are of the named parent population (% parent) and of all events in the file (% total).</p>",
  );
  for (const f of report.files) {
    out.push(`<h3>${esc(f.fileName)}</h3>`, "<h4>Instrument</h4><ul>", ...f.instrument.map(itemHtml), "</ul>");
    out.push("<table><tr><th>Parameter ($PnN)</th><th>Marker ($PnS)</th><th>Acquisition keywords</th></tr>");
    for (const p of f.parameters) {
      const kws = Object.entries(p.keywords).map(([k, v]) => `$Pn${k} ${v}`).join("; ");
      out.push(`<tr><td>${esc(p.pnn)}</td><td>${esc(p.marker ?? "")}</td><td>${esc(kws)}</td></tr>`);
    }
    out.push("</table>", "<h4>List-mode data</h4><ul>", ...f.listMode.map(itemHtml), "</ul>");
    out.push("<h4>Compensation</h4>", `<p>${esc(f.compensation.description)}</p>`);
    const m = f.compensation.matrix;
    if (m) {
      out.push("<p>Spillover matrix (row: source parameter; column: receiving parameter):</p><table>");
      out.push(`<tr><th></th>${m.channels.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`);
      m.matrix.forEach((row, i) => out.push(`<tr><th>${esc(m.channels[i])}</th>${row.map((v) => `<td class="n">${num(v)}</td>`).join("")}</tr>`));
      out.push("</table>");
    }
    out.push("<h4>Gates</h4>");
    if (f.gates.length === 0) out.push("<p>No gates.</p>");
    else {
      out.push("<ul>");
      for (const g of f.gates) out.push(`<li><b>${esc(g.name)}</b>${g.tailored ? " (coordinates specific to this file)" : ""}: ${esc(g.description)}</li>`);
      out.push("</ul>");
    }
    out.push("<h4>Gating hierarchy and statistics</h4>");
    out.push("<table><tr><th>Population</th><th>Definition</th><th>Events</th><th>% parent</th><th>Parent</th><th>% total</th></tr>");
    for (const p of f.populations) {
      const count = p.count === null ? "" : `${p.count}${p.belowMinEvents ? ' <span class="low">(below minimum)</span>' : ""}`;
      out.push(`<tr><td>${esc(p.path)}</td><td>${esc(p.definition)}</td><td class="n">${count}</td><td class="n">${pctText(p.pctParent)}</td><td>${esc(p.parentPath ?? "")}</td><td class="n">${pctText(p.pctTotal)}</td></tr>`);
    }
    out.push("</table>");
  }
  if (report.notRecorded.length) {
    out.push("<h2>Items not recorded</h2><ul>", ...report.notRecorded.map((l) => `<li>${esc(l)}</li>`), "</ul>");
  }
  out.push("</body></html>");
  return out.join("\n");
}
