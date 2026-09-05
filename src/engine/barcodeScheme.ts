// barcodeScheme.ts — a debarcoding strategy from a sample table.
//
// One multiplexed CyTOF tube holds many samples, each carrying a combination of barcode
// isotopes. The wet-lab record of that combination is a table: one row per sample, one column
// per barcode channel holding 0/1. Debarcoding in GateLab is manual gating on the barcode
// planes: four gates per plane (one per state of the pair), and one population per sample that
// intersects one gate from each plane. This module turns the table into exactly that strategy,
// with the gates placed from a template, so the user tweaks gates rather than draws them.
//
// The table carries states only. Which channels are drawn together (the plane layout) is a
// separate declaration: proposed from column order, editable in the dialog, or written as
// "# plane:" header lines above the table. A plane may pair a barcode channel with a
// display-only partner (usually the DNA channel) when the scheme has an odd number of
// channels; that plane gets two gates, and the display axis contributes no state.

import {
  newGateRef,
  newPopulation,
  newRootPopulation,
  type Gate,
  type PolyRectGate,
  type PopulationMap,
  type Vertex,
} from "./models";
import { isDnaChannel, massLabel, massToken, tokenMatchesChannel, type MassToken } from "./barcodeMass";
import {
  findDisplayPlanes,
  templateShapesFor,
  type BarcodeStateKey,
  type BarcodeTemplate,
  type LearnedBarcodeTemplate,
  type QcGateTemplate,
  type QcPopulationTemplate,
} from "./barcodeTemplate";
import { populationTreeOrder } from "./populations";

/** Gate names use the mass alone ("194+195-"), as the lab's workspaces and barcode strings do. */
const massOnly = (channelKey: string): string => {
  const t = massToken(channelKey);
  return t ? String(t.mass) : channelKey;
};

// ---------------------------------------------------------------------------
// The table as written
// ---------------------------------------------------------------------------

export interface PlaneDeclaration {
  x: string;
  y: string;
  xDisplay: boolean;
  yDisplay: boolean;
  line: number;
}

export interface BarcodeTable {
  headers: string[];
  rows: string[][];
  /** "# plane:" header lines, in order. */
  planeDeclarations: PlaneDeclaration[];
  problems: string[];
  delimiter: "," | "\t" | ";";
}

function splitDelimited(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function detectDelimiter(headerLine: string): "," | "\t" | ";" {
  if (headerLine.includes("\t")) return "\t";
  if (!headerLine.includes(",") && headerLine.includes(";")) return ";";
  return ",";
}

/** Parse "# plane: 195Pt x 194Pt" or "# plane: 103Rh(display) x 89Y". */
function parsePlaneDeclaration(text: string, line: number): PlaneDeclaration | string {
  const body = text.replace(/^#\s*planes?\s*:\s*/i, "").trim();
  const parts = body.split(/\s*(?:x|×|\/|,)\s*/i).filter(Boolean);
  if (parts.length !== 2) {
    return `Line ${line}: a plane declaration names two channels separated by "x", as in "# plane: 195Pt x 194Pt" (got "${body}").`;
  }
  const read = (p: string) => {
    const m = /^(.*?)\s*\((display|dummy|shown|axis)\)\s*$/i.exec(p);
    return m ? { name: m[1].trim(), display: true } : { name: p.trim(), display: false };
  };
  const x = read(parts[0]);
  const y = read(parts[1]);
  if (x.display && y.display) return `Line ${line}: both axes of a plane cannot be display-only.`;
  return { x: x.name, y: y.name, xDisplay: x.display, yDisplay: y.display, line };
}

export function parseBarcodeTable(text: string): BarcodeTable {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const problems: string[] = [];
  const planeDeclarations: PlaneDeclaration[] = [];
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    if (raw.trim().startsWith("#")) {
      if (/^#\s*planes?\s*:/i.test(raw.trim())) {
        const d = parsePlaneDeclaration(raw.trim(), i + 1);
        if (typeof d === "string") problems.push(d);
        else planeDeclarations.push(d);
      }
      continue;
    }
    headerIndex = i;
    break;
  }
  if (headerIndex < 0) {
    return { headers: [], rows: [], planeDeclarations, problems: [...problems, "The file has no header row."], delimiter: "," };
  }
  const delimiter = detectDelimiter(lines[headerIndex]);
  const headers = splitDelimited(lines[headerIndex], delimiter);
  if (headers.some((h) => !h)) problems.push("Every column needs a header; one is blank.");
  const dup = headers.filter((h, i) => headers.indexOf(h) !== i);
  if (dup.length) problems.push(`Duplicate column header(s): ${[...new Set(dup)].join(", ")}.`);
  const rows: string[][] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const fields = splitDelimited(raw, delimiter);
    if (fields.length !== headers.length) {
      problems.push(`Line ${i + 1} has ${fields.length} field(s); the header has ${headers.length}.`);
      continue;
    }
    rows.push(fields);
  }
  if (!rows.length) problems.push("The table has no sample rows.");
  return { headers, rows, planeDeclarations, problems, delimiter };
}

// ---------------------------------------------------------------------------
// Resolving the table against the loaded sample
// ---------------------------------------------------------------------------

export interface BarcodeChannelLike {
  key: string;
  pnn: string;
  marker: string | null;
}

export interface BarcodePlane {
  /** Channel keys. */
  x: string;
  y: string;
  xIsBarcode: boolean;
  yIsBarcode: boolean;
}

export interface BarcodeSample {
  rowNumber: number;
  name: string;
  fileName: string | null;
  /** State per barcode channel key. */
  states: Record<string, boolean>;
  metadata: Record<string, string>;
}

export interface BarcodeScheme {
  /** Barcode channel keys, in table column order. */
  channels: string[];
  /** Column header that produced each channel key. */
  channelHeaders: Record<string, string>;
  planes: BarcodePlane[];
  samples: BarcodeSample[];
  metadataColumns: string[];
  problems: string[];
  notes: string[];
}

const RESERVED = {
  name: /^(name|population|population_name|sample_name)$/i,
  fileName: /^(file_name|filename|file|fcs|output|output_file)$/i,
  sampleId: /^(sample_id|sample|id)$/i,
  barcode: /^(barcode|barcodes|code)$/i,
};

const TRUE_STATES = new Set(["1", "+", "pos", "positive", "true", "yes", "y"]);
const FALSE_STATES = new Set(["0", "-", "neg", "negative", "false", "no", "n", "−"]);

function parseState(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (TRUE_STATES.has(v)) return true;
  if (FALSE_STATES.has(v)) return false;
  return null;
}

/** Resolve a scheme token to one loaded channel, or report the candidates. */
export function resolveMassToken(
  token: string,
  channels: BarcodeChannelLike[],
): { key: string } | { candidates: string[] } {
  const exact = channels.find((c) => c.key === token || c.pnn === token || c.marker === token);
  if (exact) return { key: exact.key };
  const t: MassToken | null = massToken(token);
  if (!t) return { candidates: [] };
  const hits = channels.filter((c) =>
    tokenMatchesChannel(t, c.pnn) || tokenMatchesChannel(t, c.key) || (c.marker ? tokenMatchesChannel(t, c.marker) : false));
  const keys = [...new Set(hits.map((c) => c.key))];
  return keys.length === 1 ? { key: keys[0] } : { candidates: keys };
}

/** Expand "89+196-113+115-194-195-" into per-token states. */
export function parseBarcodeString(value: string): { token: string; state: boolean }[] | null {
  const out: { token: string; state: boolean }[] = [];
  const re = /(\d{2,3}[A-Z][a-z]?|\d{2,3})\s*([+\-−])/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  const s = value.trim();
  while ((m = re.exec(s))) {
    out.push({ token: m[1], state: m[2] === "+" });
    consumed = re.lastIndex;
  }
  if (!out.length || s.slice(consumed).replace(/[\s,;]/g, "").length) return null;
  return out;
}

/** Pair barcode channels in order; a leftover channel is shown against the DNA channel. */
export function proposePlanes(
  barcodeChannels: string[],
  channels: BarcodeChannelLike[],
  declared: PlaneDeclaration[],
): { planes: BarcodePlane[]; problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  const planes: BarcodePlane[] = [];
  const covered = new Set<string>();

  if (declared.length) {
    for (const d of declared) {
      const rx = resolveMassToken(d.x, channels);
      const ry = resolveMassToken(d.y, channels);
      if (!("key" in rx) || !("key" in ry)) {
        const which = !("key" in rx) ? d.x : d.y;
        const cands = !("key" in rx) ? rx.candidates : (ry as { candidates: string[] }).candidates;
        problems.push(`Line ${d.line}: "${which}" ${cands.length ? `matches ${cands.length} channels (${cands.join(", ")})` : "matches no loaded channel"}.`);
        continue;
      }
      const plane: BarcodePlane = { x: rx.key, y: ry.key, xIsBarcode: !d.xDisplay, yIsBarcode: !d.yDisplay };
      for (const [k, isBarcode] of [[plane.x, plane.xIsBarcode], [plane.y, plane.yIsBarcode]] as const) {
        if (covered.has(k)) problems.push(`Line ${d.line}: channel ${k} appears in more than one plane.`);
        covered.add(k);
        if (isBarcode && !barcodeChannels.includes(k)) {
          problems.push(`Line ${d.line}: ${k} is declared as a barcode axis but the table has no state column for it. Mark it "(display)" or add the column.`);
        }
        if (!isBarcode && barcodeChannels.includes(k)) {
          problems.push(`Line ${d.line}: ${k} is declared display-only but the table has a state column for it.`);
        }
      }
      planes.push(plane);
    }
    const missing = barcodeChannels.filter((k) => !covered.has(k));
    if (missing.length) problems.push(`No declared plane draws ${missing.join(", ")}.`);
    return { planes, problems, notes };
  }

  for (let i = 0; i + 1 < barcodeChannels.length; i += 2) {
    // Second channel on x, first on y: the nPhos4 convention ("194+195-" reads y then x).
    planes.push({ x: barcodeChannels[i + 1], y: barcodeChannels[i], xIsBarcode: true, yIsBarcode: true });
  }
  if (barcodeChannels.length % 2 === 1) {
    const odd = barcodeChannels[barcodeChannels.length - 1];
    const dna = channels.find((c) => !barcodeChannels.includes(c.key) && (isDnaChannel(c.pnn) || isDnaChannel(c.key) || (c.marker ? isDnaChannel(c.marker) : false)));
    if (dna) {
      planes.push({ x: dna.key, y: odd, xIsBarcode: false, yIsBarcode: true });
      notes.push(`${odd} has no partner, so it is drawn against ${dna.key} (display only).`);
    } else {
      problems.push(`${odd} has no partner and no DNA channel was found to draw it against; declare a plane for it.`);
    }
  }
  return { planes, problems, notes };
}

export function resolveBarcodeScheme(
  table: BarcodeTable,
  channels: BarcodeChannelLike[],
  planesOverride?: BarcodePlane[],
): BarcodeScheme {
  const problems = [...table.problems];
  const notes: string[] = [];
  const h = table.headers;
  const col = (re: RegExp) => h.findIndex((x) => re.test(x));
  const nameCol = col(RESERVED.name);
  const fileCol = col(RESERVED.fileName);
  const sampleIdCol = col(RESERVED.sampleId);
  const barcodeCol = col(RESERVED.barcode);

  // Channel columns: a header that resolves to exactly one loaded channel and whose values are
  // all states. Anything else is metadata (a header that resolves but holds other values is a
  // problem, because it is almost certainly a mistyped state).
  const channelCols: { index: number; key: string; header: string }[] = [];
  const metaCols: number[] = [];
  h.forEach((header, i) => {
    if ([nameCol, fileCol, sampleIdCol, barcodeCol].includes(i)) return;
    const r = resolveMassToken(header, channels);
    if ("key" in r) {
      const bad = table.rows.filter((row) => parseState(row[i]) === null);
      if (bad.length) {
        problems.push(`Column "${header}" names channel ${r.key} but ${bad.length} row(s) hold something other than a state (0/1, -/+): first at row ${table.rows.indexOf(bad[0]) + 1}.`);
      }
      channelCols.push({ index: i, key: r.key, header });
      return;
    }
    if (r.candidates.length > 1) {
      problems.push(`Column "${header}" matches ${r.candidates.length} channels (${r.candidates.join(", ")}); name it more fully.`);
      return;
    }
    metaCols.push(i);
  });
  const dupKeys = channelCols.map((c) => c.key).filter((k, i, a) => a.indexOf(k) !== i);
  if (dupKeys.length) problems.push(`Two columns resolve to the same channel: ${[...new Set(dupKeys)].join(", ")}.`);

  // Samples.
  const samples: BarcodeSample[] = [];
  const combos = new Map<string, number[]>();
  const stringChannels: string[] = [];
  table.rows.forEach((row, ri) => {
    const rowNumber = ri + 1;
    const states: Record<string, boolean> = {};
    for (const c of channelCols) {
      const s = parseState(row[c.index]);
      if (s !== null) states[c.key] = s;
    }
    if (barcodeCol >= 0) {
      const parsed = parseBarcodeString(row[barcodeCol]);
      if (!parsed) {
        problems.push(`Row ${rowNumber}: barcode "${row[barcodeCol]}" is not a sequence of mass tokens with signs.`);
      } else {
        for (const { token, state } of parsed) {
          const r = resolveMassToken(token, channels);
          if (!("key" in r)) {
            problems.push(`Row ${rowNumber}: barcode token "${token}" ${r.candidates.length ? `matches ${r.candidates.join(", ")}` : "matches no loaded channel"}.`);
            continue;
          }
          if (r.key in states && states[r.key] !== state) {
            problems.push(`Row ${rowNumber}: the barcode string and the ${r.key} column disagree.`);
          }
          states[r.key] = state;
          if (!stringChannels.includes(r.key)) stringChannels.push(r.key);
        }
      }
    }
    const metadata: Record<string, string> = {};
    for (const i of metaCols) metadata[h[i]] = row[i];
    if (sampleIdCol >= 0) metadata[h[sampleIdCol]] = row[sampleIdCol];
    if (barcodeCol >= 0) metadata[h[barcodeCol]] = row[barcodeCol];
    const fileName = fileCol >= 0 && row[fileCol] ? row[fileCol] : null;
    const name =
      (nameCol >= 0 && row[nameCol]) ||
      (sampleIdCol >= 0 && row[sampleIdCol]) ||
      (fileName ? fileName.replace(/\.[^.]+$/, "") : "") ||
      String(rowNumber).padStart(2, "0");
    samples.push({ rowNumber, name, fileName, states, metadata });
  });

  const barcodeChannels = [...channelCols.map((c) => c.key), ...stringChannels.filter((k) => !channelCols.some((c) => c.key === k))];
  if (!barcodeChannels.length) problems.push("No barcode channel column was recognised: name each column by its isotope (89Y, 194Pt) or supply a barcode column.");

  for (const s of samples) {
    const missing = barcodeChannels.filter((k) => !(k in s.states));
    if (missing.length) problems.push(`Row ${s.rowNumber} (${s.name}): no state for ${missing.join(", ")}. A blank is not a zero.`);
    const combo = barcodeChannels.map((k) => (s.states[k] ? "1" : "0")).join("");
    combos.set(combo, [...(combos.get(combo) ?? []), s.rowNumber]);
  }
  for (const [combo, rows] of combos) {
    if (rows.length > 1) problems.push(`Rows ${rows.join(", ")} share the same barcode combination (${combo}); two populations would receive the same cells.`);
  }
  const names = samples.map((s) => s.name);
  const dupNames = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupNames.length) problems.push(`Duplicate population name(s): ${dupNames.join(", ")}.`);

  const layout = planesOverride
    ? { planes: planesOverride, problems: [] as string[], notes: [] as string[] }
    : proposePlanes(barcodeChannels, channels, table.planeDeclarations);
  if (planesOverride) {
    const covered = new Set(planesOverride.flatMap((p) => [p.xIsBarcode ? p.x : "", p.yIsBarcode ? p.y : ""]));
    const missing = barcodeChannels.filter((k) => !covered.has(k));
    if (missing.length) layout.problems.push(`No plane draws ${missing.join(", ")}.`);
    const seen = new Set<string>();
    for (const p of planesOverride) {
      for (const k of [p.x, p.y]) {
        if (seen.has(k)) layout.problems.push(`Channel ${k} appears in more than one plane.`);
        seen.add(k);
      }
      if (p.x === p.y) layout.problems.push(`A plane cannot draw ${p.x} against itself.`);
      if (!p.xIsBarcode && !p.yIsBarcode) layout.problems.push(`The plane ${p.x} x ${p.y} has no barcode axis.`);
      for (const [k, isBarcode] of [[p.x, p.xIsBarcode], [p.y, p.yIsBarcode]] as const) {
        if (!isBarcode && barcodeChannels.includes(k)) layout.problems.push(`${k} is display-only in a plane but the table has a state column for it.`);
        if (isBarcode && !barcodeChannels.includes(k)) layout.problems.push(`${k} is a barcode axis but the table has no state column for it.`);
      }
    }
  }

  return {
    channels: barcodeChannels,
    channelHeaders: Object.fromEntries(channelCols.map((c) => [c.key, c.header])),
    planes: layout.planes,
    samples,
    metadataColumns: [
      ...metaCols.map((i) => h[i]),
      ...(sampleIdCol >= 0 ? [h[sampleIdCol]] : []),
      ...(barcodeCol >= 0 ? [h[barcodeCol]] : []),
    ],
    problems: [...problems, ...layout.problems],
    notes: [...notes, ...layout.notes],
  };
}

// ---------------------------------------------------------------------------
// Building the strategy
// ---------------------------------------------------------------------------

export interface BarcodeGatingResult {
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string;
  /** Population id → metadata fields, keyed by the ids in `populations`. */
  populationMetadata: Record<string, Record<string, string>>;
  metadataColumns: string[];
  /** Per plane, the gate id for each state key present. */
  gatesByPlane: { plane: BarcodePlane; gates: Partial<Record<BarcodeStateKey | "-" | "+", string>> }[];
  /** Gates created by this build; reused ones are not counted. */
  nGates: number;
  nPopulations: number;
  /** Existing gates referenced instead of created (see BarcodeBuildOptions.existingGates). */
  reusedGateIds: string[];
  /** QC populations created above the samples, outermost first, and anything left out. */
  qc: QcChainPreview;
}

export interface QcChainPreview {
  populations: { name: string; gates: { name: string; x: string; y: string }[] }[];
  /** Gates or populations left out because a channel could not be matched. */
  skipped: string[];
}

export interface BarcodeBuildOptions {
  /** Create the template's QC chain above the samples. */
  qc?: boolean;
  /** Loaded channels, for resolving the QC gates' channel names. */
  channels?: BarcodeChannelLike[];
  /** Raw min/max per channel key, for gates whose x spans the sample (Time). */
  ranges?: Record<string, [number, number]>;
  /**
   * Gates the workspace already holds. A gate with the same name on the same two channels is
   * referenced instead of created, so a scheme imported into a second hierarchy runs on the
   * first one's gates. Off when `reuse` is false.
   */
  existingGates?: readonly Gate[];
  reuse?: boolean;
}

/**
 * A QC gate's channel, by exact name, by isotope, or by role: "Time", "Center", "Offset",
 * "Width", "Residual", "Amplitude" and "Event_length" match the same word in the loaded names
 * regardless of case and punctuation; "DNA" matches an intercalator channel; "Live" a cisplatin
 * or viability channel.
 */
export function resolveQcChannel(pattern: string, channels: BarcodeChannelLike[]): string | null {
  const exact = channels.find((c) => c.key === pattern || c.pnn === pattern || c.marker === pattern);
  if (exact) return exact.key;
  const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const p = squash(pattern);
  const names = (c: BarcodeChannelLike) => [c.key, c.pnn, c.marker ?? ""];
  if (p === "dna") {
    const hit = channels.find((c) => names(c).some((n) => isDnaChannel(n)));
    return hit ? hit.key : null;
  }
  if (p === "live" || p === "viability") {
    const hit = channels.find((c) => names(c).some((n) => /198pt|pt198|cisplatin|live|viab/i.test(n)));
    return hit ? hit.key : null;
  }
  const byRole = channels.filter((c) => names(c).some((n) => squash(n) === p));
  if (byRole.length === 1) return byRole[0].key;
  const byMass = resolveMassToken(pattern, channels);
  if ("key" in byMass) return byMass.key;
  // A learned template names the channel as its own file did ("103Rh_DNA", "198Pt_Live"); on a
  // file with another intercalator or viability isotope, fall back to the role.
  if (isDnaChannel(pattern)) return resolveQcChannel("DNA", channels);
  if (/198pt|pt198|cisplatin|live|viab/i.test(pattern)) return resolveQcChannel("Live", channels);
  const loose = channels.filter((c) => names(c).some((n) => squash(n).startsWith(p) || squash(n).endsWith(p)));
  return loose.length === 1 ? loose[0].key : null;
}

/** What the QC chain would create on this sample, and what it would skip. */
export function previewQcChain(qc: QcPopulationTemplate[], channels: BarcodeChannelLike[]): QcChainPreview {
  const populations: QcChainPreview["populations"] = [];
  const skipped: string[] = [];
  for (const pop of qc) {
    const gates: { name: string; x: string; y: string }[] = [];
    for (const g of pop.gates) {
      const x = resolveQcChannel(g.x, channels);
      const y = resolveQcChannel(g.y, channels);
      if (!x || !y) {
        skipped.push(`${pop.name} / ${g.name}: no channel matches ${!x ? g.x : g.y}.`);
        continue;
      }
      gates.push({ name: g.name, x, y });
    }
    if (gates.length) populations.push({ name: pop.name, gates });
    else skipped.push(`${pop.name}: none of its gates could be placed, so the population is left out.`);
  }
  return { populations, skipped };
}

/**
 * A polygon of eight vertices around the box [x0,x1] × [y0,y1]: the corners plus the midpoint of
 * each edge, so the gate can be bent rather than only resized.
 */
function octagonBox(x0: number, x1: number, y0: number, y1: number): Vertex[] {
  const xm = (x0 + x1) / 2;
  const ym = (y0 + y1) / 2;
  return [[x0, y0], [xm, y0], [x1, y0], [x1, ym], [x1, y1], [xm, y1], [x0, y1], [x0, ym]];
}

/** State colours: "--" blue, "+-" red, "-+" green, "++" orange, as the lab's screenshots read. */
const STATE_COLORS: Record<BarcodeStateKey, string> = {
  "--": "#377eb8",
  "+-": "#e41a1c",
  "-+": "#4daf4a",
  "++": "#ff7f00",
};

function stateOf(sample: BarcodeSample, plane: BarcodePlane): BarcodeStateKey | "-" | "+" {
  const xs = plane.xIsBarcode ? (sample.states[plane.x] ? "+" : "-") : null;
  const ys = plane.yIsBarcode ? (sample.states[plane.y] ? "+" : "-") : null;
  if (xs !== null && ys !== null) return `${xs}${ys}` as BarcodeStateKey;
  return (xs ?? ys) as "-" | "+";
}

/**
 * Gates from the template and one AND population per sample under a synthetic root, in the shape
 * `importGating` consumes. Gates are drawn in display space with the arcsinh transform recorded,
 * exactly as a hand-drawn CyTOF gate is stored.
 */
export function buildBarcodeGating(
  scheme: BarcodeScheme,
  template: BarcodeTemplate,
  cofactor: number,
  options: BarcodeBuildOptions = {},
): BarcodeGatingResult {
  if (scheme.problems.length) throw new Error(`The barcode scheme has ${scheme.problems.length} problem(s); fix them before importing.`);
  const gates: Record<string, Gate> = {};
  const gate_order: string[] = [];
  const gatesByPlane: BarcodeGatingResult["gatesByPlane"] = [];
  const QC_COLORS = ["#984ea3", "#a65628", "#999999", "#e6ab02", "#66c2a5", "#f781bf", "#377eb8", "#4daf4a"];
  let qcColor = 0;
  const qcPreview: QcChainPreview = { populations: [], skipped: [] };
  const reusable = options.reuse === false ? [] : options.existingGates ?? [];
  const reusedGateIds: string[] = [];
  /** An existing polygon or rectangle with this name on these channels, if any. */
  const priorGate = (name: string, x: string, y: string): Gate | undefined =>
    reusable.find((g) => (g.gate_type === "polygon" || g.gate_type === "rectangle") && g.name === name && g.x_channel === x && g.y_channel === y);
  /** Gate ids for the QC chain, per template population, in chain order. */
  const qcGateIds: string[][] = [];
  if (options.qc && template.qc.length) {
    const channels = options.channels ?? [];
    for (const pop of template.qc) {
      const ids: string[] = [];
      const placed: { name: string; x: string; y: string }[] = [];
      for (const g of pop.gates) {
        const x = resolveQcChannel(g.x, channels);
        const y = resolveQcChannel(g.y, channels);
        if (!x || !y) {
          qcPreview.skipped.push(`${pop.name} / ${g.name}: no channel matches ${!x ? g.x : g.y}.`);
          continue;
        }
        const prior = priorGate(g.name, x, y);
        if (prior) {
          reusedGateIds.push(prior.gate_id);
          ids.push(prior.gate_id);
          placed.push({ name: prior.name, x, y });
          continue;
        }
        const gate = qcGateFor(g, x, y, cofactor, options.ranges?.[x]);
        gate.color = QC_COLORS[qcColor++ % QC_COLORS.length];
        gates[gate.gate_id] = gate;
        gate_order.push(gate.gate_id);
        ids.push(gate.gate_id);
        placed.push({ name: gate.name, x, y });
      }
      if (ids.length) {
        qcGateIds.push(ids);
        qcPreview.populations.push({ name: pop.name, gates: placed });
      } else {
        qcPreview.skipped.push(`${pop.name}: none of its gates could be placed, so the population is left out.`);
      }
    }
  }
  const asinhSpace = (x: string, y: string) => ({
    space: "display" as const,
    transforms: { [x]: { kind: "asinh" as const, cofactor }, [y]: { kind: "asinh" as const, cofactor } },
  });
  const addGate = (g: PolyRectGate) => {
    gates[g.gate_id] = g;
    gate_order.push(g.gate_id);
  };

  for (const plane of scheme.planes) {
    const xLabel = massLabel(plane.x) ?? plane.x;
    const yLabel = massLabel(plane.y) ?? plane.y;
    const xName = massOnly(plane.x);
    const yName = massOnly(plane.y);
    const byState: Partial<Record<BarcodeStateKey | "-" | "+", string>> = {};
    if (plane.xIsBarcode && plane.yIsBarcode) {
      const shapes = templateShapesFor(template, xLabel, yLabel);
      for (const key of ["--", "+-", "-+", "++"] as const) {
        const [xs, ys] = key.split("") as ["-" | "+", "-" | "+"];
        // nPhos4 reads y then x: "194+195-" on a 195Pt (x) × 194Pt (y) plane.
        const name = `${yName}${ys}${xName}${xs}`;
        const prior = priorGate(name, plane.x, plane.y);
        if (prior) {
          reusedGateIds.push(prior.gate_id);
          byState[key] = prior.gate_id;
          continue;
        }
        const g: PolyRectGate = {
          gate_id: crypto.randomUUID(),
          name,
          gate_type: "polygon",
          x_channel: plane.x,
          y_channel: plane.y,
          vertices: shapes[key].map(([x, y]) => [x, y] as Vertex),
          color: STATE_COLORS[key],
          label_offset: null,
          ...asinhSpace(plane.x, plane.y),
        };
        addGate(g);
        byState[key] = g.gate_id;
      }
    } else {
      // One barcode axis, one display axis: two rectangles split at the boundary, spanning the
      // display axis, so the display axis contributes nothing to membership.
      const barcodeIsX = plane.xIsBarcode;
      const label = barcodeIsX ? xName : yName;
      const [dLo, dHi] = template.displayRange;
      const b = template.boundary;
      const negLo = Math.min(...template.states["--"].map((v) => v[barcodeIsX ? 0 : 1]));
      const posHi = Math.max(...template.states[barcodeIsX ? "+-" : "-+"].map((v) => v[barcodeIsX ? 0 : 1]));
      for (const [key, lo, hi, color] of [
        ["-", negLo, b, STATE_COLORS["--"]],
        ["+", b, posHi, STATE_COLORS[barcodeIsX ? "+-" : "-+"]],
      ] as const) {
        // An eight-vertex polygon around the band, so its edges can be bent like any other
        // barcode gate; the display axis is spanned in full.
        const vertices: Vertex[] = barcodeIsX ? octagonBox(lo, hi, dLo, dHi) : octagonBox(dLo, dHi, lo, hi);
        const prior = priorGate(`${label}${key}`, plane.x, plane.y);
        if (prior) {
          reusedGateIds.push(prior.gate_id);
          byState[key] = prior.gate_id;
          continue;
        }
        const g: PolyRectGate = {
          gate_id: crypto.randomUUID(),
          name: `${label}${key}`,
          gate_type: "polygon",
          x_channel: plane.x,
          y_channel: plane.y,
          vertices,
          color,
          label_offset: null,
          ...asinhSpace(plane.x, plane.y),
        };
        addGate(g);
        byState[key] = g.gate_id;
      }
    }
    gatesByPlane.push({ plane, gates: byState });
  }

  const root = newRootPopulation();
  const populations: PopulationMap = { [root.population_id]: root };
  const populationMetadata: Record<string, Record<string, string>> = {};
  let parent = root;
  qcGateIds.forEach((ids, i) => {
    const pop = newPopulation(qcPreview.populations[i].name, ids.map((id) => newGateRef(id, true)), parent.population_id, "and");
    populations[pop.population_id] = pop;
    parent.children.push(pop.population_id);
    parent = pop;
  });
  for (const sample of scheme.samples) {
    const refs = gatesByPlane.map(({ plane, gates: byState }) => {
      const id = byState[stateOf(sample, plane)];
      if (!id) throw new Error(`No gate for sample ${sample.name} on plane ${plane.x} x ${plane.y}.`);
      return newGateRef(id, true);
    });
    const pop = newPopulation(sample.name, refs, parent.population_id, "and");
    populations[pop.population_id] = pop;
    parent.children.push(pop.population_id);
    const meta: Record<string, string> = { ...sample.metadata };
    if (sample.fileName) meta.file_name = sample.fileName;
    populationMetadata[pop.population_id] = meta;
  }
  const metadataColumns = [...scheme.metadataColumns];
  if (scheme.samples.some((s) => s.fileName) && !metadataColumns.includes("file_name")) metadataColumns.push("file_name");

  return {
    gates,
    gate_order,
    populations,
    root_population_id: root.population_id,
    populationMetadata,
    metadataColumns,
    gatesByPlane,
    nGates: gate_order.length,
    nPopulations: scheme.samples.length,
    reusedGateIds,
    qc: qcPreview,
  };
}

/** A QC gate on this sample: resolved channels, the sample's cofactor, and a full Time span. */
function qcGateFor(
  g: QcGateTemplate,
  x: string,
  y: string,
  cofactor: number,
  xRange: [number, number] | undefined,
): PolyRectGate {
  let vertices: Vertex[] = g.vertices.map(([vx, vy]) => [vx, vy]);
  if (g.xFull) {
    const xs = vertices.map((v) => v[0]);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const [lo, hi] = xRange ?? [xMin, xMax];
    // Stretch 2% beyond the data so the first and last events sit inside the box.
    const pad = (hi - lo) * 0.02;
    vertices = vertices.map(([vx, vy]) => [vx <= xMin ? lo - pad : vx >= xMax ? hi + pad : vx, vy]);
  }
  const display = g.space === "display";
  const spec = (kind: "identity" | "asinh") => (kind === "identity" ? { kind: "identity" as const } : { kind: "asinh" as const, cofactor });
  return {
    gate_id: crypto.randomUUID(),
    name: g.name,
    gate_type: g.gate_type,
    x_channel: x,
    y_channel: y,
    vertices,
    color: "#999999",
    label_offset: null,
    ...(display
      ? { space: "display" as const, transforms: { [x]: spec(g.transforms?.x ?? "asinh"), [y]: spec(g.transforms?.y ?? "asinh") } }
      : { space: "raw" as const }),
  };
}

/** The template CSV offered for download, with the plane declarations spelled out. */
export interface BarcodeSchemeExport {
  csv: string;
  nSamples: number;
  /** Plane labels as written in the header, e.g. "195Pt x 194Pt", "103Rh(display) x 89Y". */
  planeLabels: string[];
  /** Barcode channel keys in column order. */
  channels: string[];
  notes: string[];
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Write a workspace's debarcoding strategy back out as a scheme table: one row per sample
 * population (a population whose gates are exactly one gate from every barcode plane), one
 * 0/1 column per barcode channel, `name`, `file_name` and any other population metadata.
 *
 * The barcode planes come from the learned template; a display-only plane (one barcode
 * channel drawn against an intercalator channel, two gates) is found here from the gates.
 * Columns are ordered so that automatic pairing reproduces the planes, and the planes are
 * declared in the header regardless.
 */
export function exportBarcodeScheme(
  gates: Gate[],
  populations: PopulationMap,
  rootPopulationId: string | null,
  learned: LearnedBarcodeTemplate,
  metadata: Record<string, Record<string, string>> = {},
  source = "the current workspace",
): BarcodeSchemeExport {
  const cofactor = learned.template.cofactor;
  /** Per gate, the barcode channels it decides and their state. */
  const gateStates = new Map<string, { channel: string; state: "+" | "-" }[]>();
  const planes: { x: string; y: string; xIsBarcode: boolean; yIsBarcode: boolean; gateIds: string[] }[] = [];
  for (const p of learned.planes) {
    planes.push({ x: p.x, y: p.y, xIsBarcode: true, yIsBarcode: true, gateIds: Object.values(p.gateIds) });
    for (const k of BARCODE_STATE_KEYS_LOCAL) {
      gateStates.set(p.gateIds[k], [
        { channel: p.x, state: k[0] as "+" | "-" },
        { channel: p.y, state: k[1] as "+" | "-" },
      ]);
    }
  }
  const barcodeChannels = new Set(planes.flatMap((p) => [p.x, p.y]));
  for (const d of findDisplayPlanes(gates, cofactor, barcodeChannels)) {
    gateStates.set(d.negId, [{ channel: d.channel, state: "-" }]);
    gateStates.set(d.posId, [{ channel: d.channel, state: "+" }]);
    planes.push({ x: d.x, y: d.y, xIsBarcode: d.barcodeAxis === 0, yIsBarcode: d.barcodeAxis === 1, gateIds: [d.negId, d.posId] });
  }
  const massOf = (ch: string): number => Number(ch.match(/\d+/)?.[0] ?? 0);
  const label = (ch: string): string => massLabel(ch) ?? ch;
  // Sort planes by their lightest barcode isotope; columns per plane are [y, x] for a barcode
  // plane (second column on x, the drawing convention) and the barcode channel of a display plane.
  const barcodeAxes = (p: (typeof planes)[number]): string[] =>
    [p.yIsBarcode ? p.y : null, p.xIsBarcode ? p.x : null].filter((v): v is string => !!v);
  planes.sort((a, b) => Math.min(...barcodeAxes(a).map(massOf)) - Math.min(...barcodeAxes(b).map(massOf)));
  const channels = planes.flatMap(barcodeAxes);
  const planeLabels = planes.map((p) => `${label(p.x)}${p.xIsBarcode ? "" : "(display)"} x ${label(p.y)}${p.yIsBarcode ? "" : "(display)"}`);
  const gateToPlane = new Map<string, number>();
  planes.forEach((p, i) => p.gateIds.forEach((id) => gateToPlane.set(id, i)));

  const notes: string[] = [];
  const partial: string[] = [];
  const rows: { name: string; file: string; meta: Record<string, string>; states: Record<string, "1" | "0"> }[] = [];
  const order = rootPopulationId ? populationTreeOrder(populations, rootPopulationId).map((r) => r.popId) : Object.keys(populations);
  for (const id of order) {
    const pop = populations[id];
    if (!pop || id === rootPopulationId || !pop.gate_refs.length) continue;
    if (!pop.gate_refs.every((r) => r.include && r.quadrant == null && gateToPlane.has(r.gate_id))) continue;
    const covered = new Set(pop.gate_refs.map((r) => gateToPlane.get(r.gate_id)!));
    if (covered.size !== planes.length || covered.size !== pop.gate_refs.length) {
      partial.push(pop.name);
      continue;
    }
    const states: Record<string, "1" | "0"> = {};
    for (const r of pop.gate_refs) for (const s of gateStates.get(r.gate_id) ?? []) states[s.channel] = s.state === "+" ? "1" : "0";
    const meta = { ...(metadata[id] ?? {}) };
    const file = meta.file_name ?? "";
    delete meta.file_name;
    delete meta.name;
    rows.push({ name: pop.name, file, meta, states });
  }
  if (partial.length) notes.push(`Left out ${partial.length} population(s) that use some but not all planes: ${partial.slice(0, 6).join(", ")}${partial.length > 6 ? ", …" : ""}.`);
  const metaColumns = [...new Set(rows.flatMap((r) => Object.keys(r.meta)))].filter(
    (c) => !RESERVED_EXPORT_COLUMNS.has(c.toLowerCase()) && !channels.some((ch) => label(ch) === c),
  );
  const header = ["name", "file_name", ...metaColumns, ...channels.map(label)];
  const lines = [
    `# GateLab barcode scheme, saved ${new Date().toISOString().slice(0, 10)} from ${source}.`,
    ...planeLabels.map((p) => `# plane: ${p}`),
    header.map(csvCell).join(","),
    ...rows.map((r) => [r.name, r.file, ...metaColumns.map((c) => r.meta[c] ?? ""), ...channels.map((ch) => r.states[ch] ?? "")].map(csvCell).join(",")),
    "",
  ];
  return { csv: lines.join("\n"), nSamples: rows.length, planeLabels, channels, notes };
}

const BARCODE_STATE_KEYS_LOCAL: readonly BarcodeStateKey[] = ["--", "+-", "-+", "++"];
const RESERVED_EXPORT_COLUMNS = new Set(["name", "file_name", "sample_id", "barcode"]);

export function barcodeSchemeTemplateCsv(): string {
  return [
    "# GateLab barcode scheme. One row per sample; one column per barcode channel with 1 or 0.",
    "# Optional: declare which channels are drawn together. Without these lines, channels are",
    "# paired in column order and an odd channel is drawn against the DNA channel.",
    "# plane: 195Pt x 194Pt",
    "# plane: 115In x 113In",
    "# plane: 103Rh(display) x 89Y",
    "name,file_name,condition,89Y,113In,115In,194Pt,195Pt",
    "01,sample_01.fcs,DMSO,1,1,0,0,0",
    "02,sample_02.fcs,DMSO,1,0,1,0,0",
    "03,sample_03.fcs,Spike,0,1,0,1,0",
    "",
  ].join("\n");
}
