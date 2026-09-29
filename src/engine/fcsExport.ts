// fcsExport.ts — write a gated population back out as an FCS 3.1 file.
// Ported from GateLabR inst/app/R/fcs_export.R (export_population_as_fcs +
// .matrix_to_flowframe): list mode, one column per stored channel, event order preserved.
//
// What the file carries (2026-09; before then it wrote a fixed FCS 3.0 skeleton):
//   • data = the requested assay subset by the population mask: original uncompensated
//     measurements, compensated linear measurements, or transformed display values; only the
//     stored channel subset (the 422→33 filtering is already baked into the Sample).
//   • precision = the source's: $DATATYPE=D when a channel was stored (or decoded) in double
//     precision or holds integers float32 cannot represent, otherwise F. Writing everything as
//     float32 rounded a float64 file's 0.1 to 0.10000000149011612.
//   • $PnN = the ORIGINAL FCS parameter name; $PnS = the source's $PnS, or the Panel-tab label
//     when the user renamed the channel in GateLab (until 2026-09 it was always GateLab's
//     display key, so "HDR-T" came back as "Time").
//   • $PnR = the source's range when it covers the data, else the data's ceiling + 1, which is
//     what flowCore::write.FCS writes. A constant 262144 made flowCore's default reader clamp
//     every scatter value of a modern instrument onto 262144.
//   • $PnE = 0,0, except on a float channel written as stored whose source states a log $PnE
//     (out of spec, as on the Guava Muse) and holds no value beyond that $PnR on any such
//     channel: that keeps the source's $PnE, $PnR and $PnG, so every reader reads it as it reads
//     the source.
//   • $ORIGINALITY = NonDataModified only when the DATA segment is the source's: every event and
//     parameter, in the type, width and byte order it was stored in; DataModified otherwise.
//   • the source's keywords: provenance ($CYT, $DATE, $FIL, …), $TIMESTEP, each kept channel's
//     own keywords renumbered ($PnG, $PnV, $PnD, vendor PnDISPLAY, …), and, on the original
//     assay only, the spillover matrix in force as $SPILLOVER restricted to the exported
//     channels: the source's own, or one supplied from outside it (a FlowJo workspace's), written
//     as GateLab compensates with it under the file's $PnN and named by GATELAB_SPILLOVER. A
//     matrix of the Compensation tab's profiles is not written (the source's is). A compensated or
//     display export carries no matrix, since its values must not be compensated again, and every
//     export says which assay it holds in GATELAB_ASSAY.
//   • TEXT in UTF-8, as FCS 3.1 requires; offsets are byte offsets of the encoded text.

import type { Sample } from "./sample";
import { parseSpilloverKeyword, statesLogAmplification, type NumericColumn } from "./fcs";

export type FcsExportAssay = "original" | "compensated" | "display";

/** The FCS version every file written here states in its HEADER; the export dialog says it too. */
export const FCS_EXPORT_VERSION = "3.1";

export interface CombinedFcsCompatibility {
  compatible: boolean;
  reason: string | null;
}

export interface FcsExportChannel {
  name: string; // $PnN — original FCS parameter name
  desc: string; // $PnS — "" writes no $PnS
  /** $PnR. Raised to the data's ceiling + 1 when the data exceed it; derived from the data when
   *  absent. */
  range?: number;
  /**
   * The source's own $PnE, for a float channel written as stored whose source states a log $PnE
   * (statesLogAmplification in fcs.ts). It is written with `range` unchanged as $PnR, because
   * readers that decode it (flowio, FlowKit) use both; the pair, with the source's $PnG, lets every
   * reader read the export as it reads the source. Absent: $PnE 0,0 and a $PnR covering the data.
   */
  amplification?: string;
  /** Further keywords of this parameter, "{n}" standing for its number in the written file:
   *  ["$P{n}G", "2"], ["P{n}DISPLAY", "LOG"]. The writer's own ($PnN, $PnB, $PnE, $PnR, $PnS,
   *  $PnDATATYPE) are not taken from here. */
  keywords?: [string, string][];
}

export interface WriteFcsOptions {
  /** File-level keywords besides the structural ones the writer sets itself. */
  keywords?: [string, string][];
  /** "D" writes float64 ($PnB 64); the default "F" writes float32. */
  datatype?: "F" | "D";
}

/** Split export keeps a population × file output only when it exceeds this exclusive floor. */
export function passesPopulationFcsExportThreshold(
  eventCount: number | null | undefined,
  minimumEvents: number,
): boolean {
  if (typeof eventCount !== "number" || !Number.isFinite(eventCount)) return false;
  const threshold = Math.max(0, Math.floor(minimumEvents));
  return eventCount > threshold;
}

/**
 * TEXT delimiters, in order of preference: every one is written by some instrument in the
 * FlowRepository corpus ("\f" by most BD software, "\r" by the FACSDiscover S8), so every reader
 * already meets it. The first that no keyword or value contains is used.
 *
 * FCS lets a value contain the delimiter by doubling it, but flowCore's read.FCS, by default
 * (emptyValue = TRUE), takes a doubled delimiter for an empty value and then refuses the file with
 * "Empty keyword name detected". A BD FACSChorus file's BDCHORUSDATARECORD is JSON containing "|",
 * "/" and "\\", so with a fixed "|" every original export of an S8 file failed flowCore's default
 * read, the call GateLabR's fcs_import.R makes.
 */
const DELIM_CANDIDATES = ["|", "\f", "/", "\\", "\r", "\t", "\n"] as const;
/**
 * Further delimiters, tried only when a TEXT contains every one of DELIM_CANDIDATES. FCS 3.1
 * §2.2.15 allows any single ASCII byte from 0x01 to 0x7E. These are the ones no reader treats
 * specially: flowio splits the TEXT with a regular expression built from the delimiter, escaping
 * only "|", "\\" and "*", so a regex metacharacter ("." "^" "$" "+" "?" "(" ")" "[" "]" "{" "}")
 * or "-" would break its split. Letters, digits, "$", ",", "." and "-" also appear in the
 * structural keywords and numbers the writer adds after the delimiter is chosen, so they are
 * never candidates. Doubling the delimiter, which flowCore's default read refuses, is left for a
 * TEXT containing every one of these as well.
 */
const DELIM_FALLBACKS: readonly string[] = [
  ..."~!#%&;:@_`'\"<>=",
  ...Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)).filter((c) => !DELIM_CANDIDATES.includes(c as never)),
];
/** HEADER offsets are 8 ASCII digits; a segment reaching past this is located by TEXT alone. */
const HEADER_OFFSET_MAX = 99_999_999;

/** Keywords the writer states itself; one arriving from a source is dropped rather than doubled. */
const STRUCTURAL = new Set([
  "$BEGINANALYSIS", "$ENDANALYSIS", "$BEGINSTEXT", "$ENDSTEXT", "$BEGINDATA", "$ENDDATA",
  "$BYTEORD", "$DATATYPE", "$MODE", "$NEXTDATA", "$PAR", "$TOT",
]);
const WRITER_PARAM_SUFFIXES = new Set(["N", "B", "E", "R", "S", "DATATYPE"]);

/** The first delimiter, preferred candidates before fallbacks, that occurs in no keyword or value;
 *  "|", to be doubled wherever it occurs, when every one does. */
function chooseDelimiter(kw: readonly [string, string][]): string {
  const all = [...DELIM_CANDIDATES, ...DELIM_FALLBACKS];
  const free = new Set<string>(all);
  for (const [k, v] of kw) {
    for (const c of all) {
      if (free.has(c) && (k.includes(c) || v.includes(c))) free.delete(c);
    }
    if (free.size === 0) break;
  }
  return all.find((c) => free.has(c)) ?? DELIM_CANDIDATES[0];
}

function escDelim(s: string, delim: string): string {
  return s.split(delim).join(delim + delim);
}

function buildText(kw: [string, string][], delim: string): string {
  let t = delim;
  for (const [k, v] of kw) t += escDelim(k, delim) + delim + escDelim(v, delim) + delim;
  return t;
}

/** Right-justify an integer in an 8-char ASCII header field. 0 if it won't fit. */
function headerField(n: number): string {
  const s = n <= HEADER_OFFSET_MAX && n >= 0 ? String(n) : "0";
  return s.padStart(8, " ");
}

/** An integer $PnR covering `column`: `declared` when every finite value is at or below it. */
function coveringRange(column: ArrayLike<number>, declared: number | undefined): number {
  let max = -Infinity;
  for (let i = 0; i < column.length; i++) {
    const v = column[i];
    if (v > max && Number.isFinite(v)) max = v;
  }
  const base = declared !== undefined && Number.isFinite(declared) && declared > 0 ? Math.ceil(declared) : 0;
  if (max === -Infinity) return base || 1;
  return base >= max ? base : Math.max(1, Math.ceil(max) + 1);
}

/**
 * Write columns (one per channel, all the same length = event count) as an FCS 3.1 byte
 * stream. Data is written event-major (list mode), little-endian, float32 or float64.
 */
export function writeFcs(
  columns: readonly ArrayLike<number>[],
  channels: FcsExportChannel[],
  opts: WriteFcsOptions = {},
): Uint8Array {
  const nPar = channels.length;
  const nEvents = columns[0]?.length ?? 0;
  const datatype = opts.datatype ?? "F";
  const width = datatype === "D" ? 8 : 4;
  const dataBytes = nEvents * nPar * width;

  const fileKeywords = (opts.keywords ?? []).filter(([k]) => {
    const key = k.trim().toUpperCase();
    return !STRUCTURAL.has(key) && !/^\$P\d+[A-Z]/.test(key);
  });
  const paramKeywords = (): [string, string][] => {
    const kw: [string, string][] = [];
    for (let i = 0; i < nPar; i++) {
      const p = i + 1;
      kw.push([`$P${p}N`, channels[i].name]);
      kw.push([`$P${p}B`, String(width * 8)]);
      // Every export is float (F or D), and FCS 3.1 requires $PnE 0,0 on float data. The one
      // exception restates a source that already broke that rule, with its $PnR, so no reader
      // decodes the channel differently from the source (FcsExportChannel.amplification).
      const range = channels[i].range;
      const restated = channels[i].amplification !== undefined && range !== undefined && range > 0;
      kw.push([`$P${p}E`, restated ? channels[i].amplification! : "0,0"]);
      kw.push([`$P${p}R`, restated ? String(range) : String(coveringRange(columns[i], range))]);
      if (channels[i].desc) kw.push([`$P${p}S`, channels[i].desc]);
      for (const [template, value] of channels[i].keywords ?? []) {
        const key = template.replace("{n}", String(p));
        const own = /^\$P\d+(.+)$/i.exec(key);
        if (own && WRITER_PARAM_SUFFIXES.has(own[1].toUpperCase())) continue;
        kw.push([key, value]);
      }
    }
    return kw;
  };
  const perParam = paramKeywords();
  // The structural keywords are ASCII letters, digits, "$" and ",", none of them a candidate, so
  // the delimiter depends only on these and stays fixed while the offsets converge below.
  const delim = chooseDelimiter([...fileKeywords, ...perParam]);

  // $BEGINDATA/$ENDDATA feed back into TEXT length → converge the offsets. Lengths are in
  // BYTES of the UTF-8 encoding: a label such as "IFN-γ" is one character and two bytes.
  const encoder = new TextEncoder();
  const textStart = 58; // after the 58-byte HEADER
  let beginData = 0;
  let endData = 0;
  let textBytes = new Uint8Array(0);
  for (let iter = 0; iter < 8; iter++) {
    const kw: [string, string][] = [
      ["$BEGINANALYSIS", "0"],
      ["$ENDANALYSIS", "0"],
      ["$BEGINSTEXT", "0"],
      ["$ENDSTEXT", "0"],
      ["$BEGINDATA", String(beginData)],
      ["$ENDDATA", String(endData)],
      ["$BYTEORD", "1,2,3,4"], // little-endian
      ["$DATATYPE", datatype],
      ["$MODE", "L"],
      ["$NEXTDATA", "0"],
      ["$PAR", String(nPar)],
      ["$TOT", String(nEvents)],
      ...fileKeywords,
      ...perParam,
    ];
    // The delimiter is chosen (and, failing that, escaped) in the TEXT string before encoding.
    // UTF-8 never encodes a non-ASCII character with an ASCII byte, so no label can produce a
    // stray delimiter; the old byte-truncating writer turned "ż" (U+017C) into 0x7C, which is "|".
    textBytes = encoder.encode(buildText(kw, delim));
    // An empty DATA segment ends one byte before it begins, as flowCore's write.FCS writes it;
    // 0/0 declared a one-byte segment, which flowio and FlowKit refuse.
    const nb = textStart + textBytes.length;
    const ne = nb + dataBytes - 1;
    if (nb === beginData && ne === endData) break;
    beginData = nb;
    endData = ne;
  }

  const textEnd = textStart + textBytes.length - 1;
  // FCS 3.1 §3.1: when any part of a segment lies beyond byte 99,999,999, BOTH of its HEADER
  // offsets are 0 and TEXT alone locates it. Zeroing only the end left a begin with no end.
  const dataInHeader = endData <= HEADER_OFFSET_MAX;

  // HEADER (58 bytes): "FCS3.1" + 4 spaces + 6 × 8-char offset fields.
  const header =
    `FCS${FCS_EXPORT_VERSION}` +
    "    " +
    headerField(textStart) +
    headerField(textEnd) +
    headerField(dataInHeader ? beginData : 0) +
    headerField(dataInHeader ? endData : 0) +
    headerField(0) + // ANALYSIS start
    headerField(0); // ANALYSIS end

  const dataOffset = textStart + textBytes.length;
  const out = new Uint8Array(dataOffset + dataBytes);
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  out.set(textBytes, textStart);

  // DATA — event-major, little-endian.
  const dv = new DataView(out.buffer);
  let off = dataOffset;
  for (let e = 0; e < nEvents; e++) {
    for (let c = 0; c < nPar; c++) {
      if (datatype === "D") dv.setFloat64(off, columns[c][e], true);
      else dv.setFloat32(off, columns[c][e], true);
      off += width;
    }
  }
  return out;
}

/** Spillover keywords: written anew as $SPILLOVER on an original export, never copied. */
const SPILLOVER_KEYS = new Set(["$SPILLOVER", "SPILLOVER", "$SPILL", "SPILL", "$COMP"]);
/** Histogram peak keywords name a parameter by number in a form of their own; not renumbered. */
const PEAK_KEYWORD = /^\$PKN?\d+$/;
/** Per-parameter keywords whose value describes the scale of the STORED values, which a display
 *  export no longer holds: gain, the FCS 3.1 display range, calibration, and BD's PnDISPLAY. */
const SCALE_SUFFIXES = new Set(["G", "D", "CALIBRATION", "DISPLAY"]);

/** A parameter keyword's number and suffix: "$P12V" → [12, "V", "$"], "P12DISPLAY" → [12, "DISPLAY", ""]. */
function parameterKeyword(key: string): { n: number; suffix: string; rest: string; dollar: boolean } | null {
  const m = /^(\$?)P(\d+)([A-Z].*)$/i.exec(key);
  if (!m) return null;
  return { dollar: m[1] === "$", n: parseInt(m[2], 10), suffix: m[3].toUpperCase(), rest: m[3] };
}

/** What one sample contributes to an export: per-channel descriptions, keywords and columns. */
interface ExportSource {
  channels: FcsExportChannel[];
  fileKeywords: [string, string][];
  /** $SPILLOVER value restricted to the exported channels (original assay only). */
  spillover: string | null;
  /** The name of a matrix supplied from outside the file, when `spillover` is that matrix. */
  spilloverLabel: string | null;
  /** Full-length column per exported channel, in the assay requested. */
  columns: NumericColumn[];
  /** Source storage per exported channel, which decides the written precision. */
  sourceColumns: NumericColumn[];
}

function exportSource(sample: Sample, indices: readonly number[], assay: FcsExportAssay): ExportSource {
  const kw = sample.fcs.keywords;
  const byParam = new Map<number, [string, string][]>();
  const fileKeywords: [string, string][] = [];
  for (const [key, value] of Object.entries(kw)) {
    const upper = key.toUpperCase();
    if (STRUCTURAL.has(upper) || SPILLOVER_KEYS.has(upper) || PEAK_KEYWORD.test(upper)) continue;
    if (upper === "$UNICODE" || upper === "$ORIGINALITY" || upper === "GATELAB_ASSAY" || upper === "GATELAB_SPILLOVER") continue;
    const param = parameterKeyword(key);
    if (param) {
      const list = byParam.get(param.n) ?? [];
      list.push([`${param.dollar ? "$" : ""}P{n}${param.rest}`, value]);
      byParam.set(param.n, list);
      continue;
    }
    // The acquisition software's display state for compensation describes the stored,
    // uncompensated values; it is not true of an export that holds anything else.
    if (assay !== "original" && upper === "APPLY COMPENSATION") continue;
    fileKeywords.push([key, value]);
  }

  const channels: FcsExportChannel[] = [];
  const columns: NumericColumn[] = [];
  const sourceColumns: NumericColumn[] = [];
  const exportedPnn: string[] = [];
  let timeTransformed = false;
  // Whether this file's float channels stating a log $PnE hold values beyond that $PnR (below).
  const logStatedLinear = sample.fcs.channels.some((c) =>
    !c.logAmp && statesLogAmplification(kw, c.index + 1) && !(c.range > 0 && withinRange(sample.fcs.columns[c.index], c.range)));
  for (const idx of indices) {
    const ch = sample.channels[idx];
    const src = sample.fcs.channels[ch.columnIndex];
    const pnn = ch.pnn || ch.key;
    exportedPnn.push(pnn);
    const kind = assay === "display" ? sample.transformKind(idx) : "identity";
    if (assay === "display" && /^time$/i.test(pnn) && kind !== "identity") timeTransformed = true;
    const column = assay === "display"
      ? sample.displayColumn(idx)
      : assay === "compensated"
        ? sample.compensatedColumnData(idx)
        : sample.originalColumnData(idx);
    // A float channel whose source states a log $PnE (out of spec; the Guava Muse HLog and GvHD
    // channels) is read as stored, as flowCore reads it. Written as stored, and with every stored
    // value within the source's $PnR, it keeps the source's $PnE, $PnR and $PnG, so flowio and
    // FlowKit (which decode it and divide by $PnG) and flowCore (which does neither) each read the
    // export as they read the source. Until 2026-09 the export wrote $PnE 0,0 and kept $PnG: flowio
    // then read a Muse HLog value x as x / $PnG, where it reads the source as 10^(4x/10000) / $PnG.
    // A log $PnE describes channel values from 0 to $PnR (FCS 3.1), so a file holding values above
    // $PnR on such a channel shows its $PnE does not describe its values: the GvHD files hold
    // values up to 10,000 on $PnR 1024, already linear (flowCore wrote them so). Every such channel
    // of that file, like one written as anything but its stored values (display values, a
    // compensated channel), is written linear and without a gain: $PnE 0,0, no $PnG and a $PnR
    // covering the data. Restating that source's $PnR would make flowCore's default read clamp the
    // export at 1024, and its $PnE with a covering $PnR would make flowio decode it on another
    // range. Its Gating-ML scale value is GateLab's value either way (gatingMlGains leaves a
    // channel stating a log $PnE unconverted).
    const logStated = !!src && !src.logAmp && statesLogAmplification(kw, ch.columnIndex + 1);
    const restated = logStated && !logStatedLinear && column === sample.fcs.columns[ch.columnIndex] && src!.range > 0;
    const own = (byParam.get(ch.columnIndex + 1) ?? []).filter(([template]) => {
      const p = parameterKeyword(template.replace("{n}", "1"));
      if (!p) return false;
      // Gain describes a linearly amplified channel; a hardware log channel is written decoded,
      // on a linear scale, where a reader dividing by its $PnG would be wrong (FCS 3.1: gain
      // "shall not be used together with" log amplification).
      if (p.suffix === "G" && (src?.logAmp || assay === "display" || (logStated && !restated))) return false;
      if (assay === "display" && SCALE_SUFFIXES.has(p.suffix)) return false;
      return true;
    });
    // Otherwise $PnE is written 0,0 (writeFcs), because every value written is linear: a
    // log-amplified INTEGER channel is written decoded. Carrying a float channel's log $PnE with a
    // $PnR raised to cover the data told flowio and FlowKit to decode it on another range: the
    // first GvHD FL1-H event, 43.48 as stored, read back as 1.04 (10^(4 × 43.48 / 10001)).
    channels.push({
      name: pnn,
      // The source's $PnS, unless the user renamed the channel in GateLab's Panel tab.
      desc: ch.label ?? src?.marker ?? "",
      ...(assay !== "display" && src ? { range: src.range } : {}),
      ...(restated ? { amplification: kw[`$P${ch.columnIndex + 1}E`].trim() } : {}),
      keywords: own,
    });
    columns.push(column);
    sourceColumns.push(sample.originalColumnData(idx));
  }
  const keepKeywords = fileKeywords.filter(([k]) => !(timeTransformed && k.toUpperCase() === "$TIMESTEP"));

  let spillover: string | null = null;
  let spilloverLabel: string | null = null;
  if (assay === "original") {
    // The matrix in force: one supplied from outside the file and installed over its own (a FlowJo
    // workspace's) where there is one, else the file's own. The file's own, written over an
    // installed workspace matrix, named a matrix GateLab was not compensating with (often
    // acquisition's identity). An installed matrix is written as GateLab compensates with it
    // (Sample.spillover: the parameters it matched on this file, its coefficients among them),
    // under this file's $PnN. As supplied, its names are the workspace's: FlowJo saves a "/" in a
    // parameter name as "_" ("LIVE_DEAD Aqua-A" for the file's "LIVE/DEAD Aqua-A"), which
    // Sample.externalSpilloverPreview maps back, and matched against the exported $PnN by exact
    // name such a channel was dropped from the written matrix (all of them, and so the whole
    // matrix, on FR-FCM-Z2C8's Exp2_ST3_matrix), leaving a reader nothing to compensate with.
    const external = sample.externalSpillover;
    const inForce = external ? sample.spillover : null;
    const pnnOfKey = new Map(sample.channels.map((c) => [c.key, c.pnn || c.key] as const));
    const matrix = inForce
      ? { channels: inForce.channels.map((key) => pnnOfKey.get(key) ?? key), matrix: inForce.matrix }
      : parseSpilloverKeyword(kw["$SPILLOVER"] || kw["$SPILL"] || kw["SPILL"] || kw["SPILLOVER"]);
    if (matrix) {
      const keep = matrix.channels.map((c, i) => [c, i] as const).filter(([c]) => exportedPnn.includes(c));
      if (keep.length > 0) {
        spillover = [
          String(keep.length),
          ...keep.map(([c]) => c),
          ...keep.flatMap(([, i]) => keep.map(([, j]) => String(matrix.matrix[i][j]))),
        ].join(",");
        spilloverLabel = external?.label ?? null;
      }
    }
  }
  return { channels, fileKeywords: keepKeywords, spillover, spilloverLabel, columns, sourceColumns };
}

/** Every value of the column at or below `range`: values a log $PnE on that range can describe
 *  as channel values. */
function withinRange(column: ArrayLike<number>, range: number): boolean {
  for (let i = 0; i < column.length; i++) if (column[i] > range) return false;
  return true;
}

/** True when a source column, over the kept events, needs float64 to survive exactly. */
function needsDouble(source: NumericColumn, keep: readonly number[]): boolean {
  if (source instanceof Float64Array) return true;
  if (source instanceof Uint32Array) {
    for (const i of keep) if (source[i] > 16_777_216) return true;
  }
  return false;
}

function subset(full: NumericColumn, keep: readonly number[], double: boolean): Float32Array | Float64Array {
  const out = double ? new Float64Array(keep.length) : new Float32Array(keep.length);
  for (let k = 0; k < keep.length; k++) out[k] = full[keep[k]];
  return out;
}

/**
 * Whether an export leaves the DATA segment as the source stored it. FCS 3.1 allows
 * $ORIGINALITY/NonDataModified/ only for changes that "have not modified anything in the DATA
 * segment", so this asks for the source's bytes: every event and every parameter in the source's
 * order, each written in the type and width it was stored in and in the same byte order, with no
 * value decoded or masked on read (integer data never qualifies, since it is written as float) and
 * no $PnE restated. Until 2026-09 any full original export was NonDataModified, including a
 * FACSCalibur's, whose log channel numbers were written as decoded linear doubles with $PnE 4,0
 * turned into 0,0, and integer files whose flag bits the reader had masked away.
 */
function dataSegmentUnchanged(
  sample: Sample,
  source: ExportSource,
  keep: readonly number[],
  datatype: "F" | "D",
): boolean {
  const kw = sample.fcs.keywords;
  if (keep.length !== sample.fcs.nEvents) return false;
  if (sample.channels.length !== sample.fcs.channels.length) return false;
  if (sample.channels.some((ch, i) => ch.columnIndex !== i)) return false;
  // writeFcs writes little-endian.
  if (!/^1,2,3,4(,5,6,7,8)?$/.test((kw["$BYTEORD"] ?? "").replace(/\s/g, ""))) return false;
  const base = (kw["$DATATYPE"] ?? "").trim().toUpperCase();
  return sample.channels.every((ch, i) => {
    const p = ch.columnIndex + 1;
    const stored = (kw[`$P${p}DATATYPE`] ?? "").trim().toUpperCase() || base;
    if (stored !== datatype) return false;
    if (source.columns[i] !== sample.fcs.columns[ch.columnIndex]) return false;
    return !statesLogAmplification(kw, p) || source.channels[i].amplification !== undefined;
  });
}

function assayKeywords(assay: FcsExportAssay, unmodified: boolean, sourceOriginality?: string): [string, string][] {
  // FCS 3.1: a file whose DATA differ from the source's is DataModified. One whose DATA are the
  // source's is NonDataModified, unless the source already said its DATA were modified or appended
  // to, which a copy of them still is.
  const prior = (sourceOriginality ?? "").trim().toLowerCase();
  const originality = !unmodified
    ? "DataModified"
    : prior === "datamodified" ? "DataModified" : prior === "appended" ? "Appended" : "NonDataModified";
  return [
    ["$ORIGINALITY", originality],
    ["GATELAB_ASSAY", assay],
  ];
}

/**
 * Export one population's events as an FCS file. Mirrors export_population_as_fcs for a
 * single sample: subset every stored channel's column by `mask` (event order preserved),
 * $PnN = original name, $PnS = the source's (or the user's rename).
 */
export function exportPopulationFcs(
  sample: Sample,
  mask: Uint8Array | null,
  assay: FcsExportAssay = "original",
): Uint8Array {
  const n = sample.fcs.nEvents;
  if (mask && mask.length !== n) {
    throw new Error(`Cannot export FCS: population mask has ${mask.length} events but the sample has ${n}.`);
  }
  const keep: number[] = [];
  if (mask) {
    for (let i = 0; i < n; i++) if (mask[i]) keep.push(i);
  } else {
    for (let i = 0; i < n; i++) keep.push(i);
  }

  const source = exportSource(sample, sample.channels.map((_, idx) => idx), assay);
  const double = assay !== "display" && source.sourceColumns.some((c) => needsDouble(c, keep));
  const columns = source.columns.map((c) => subset(c, keep, double));
  const unmodified = assay === "original" && dataSegmentUnchanged(sample, source, keep, double ? "D" : "F");
  return writeFcs(columns, source.channels, {
    datatype: double ? "D" : "F",
    keywords: [
      ...assayKeywords(assay, unmodified, sample.fcs.keywords["$ORIGINALITY"]),
      ...(source.spillover ? [["$SPILLOVER", source.spillover] as [string, string]] : []),
      ...(source.spillover && source.spilloverLabel ? [["GATELAB_SPILLOVER", source.spilloverLabel] as [string, string]] : []),
      ...source.fileKeywords,
    ],
  });
}
/** Count set bits in an already length-validated mask. */
function maskCount(mask: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
  return c;
}

/** Conservative preflight for the pooled-export option shown in the export dialog. */
export function inspectCombinedFcsCompatibility(
  samples: readonly { sample: Sample; name?: string }[],
): CombinedFcsCompatibility {
  if (samples.length < 2) {
    return {
      compatible: false,
      reason: "Check at least two FCS files to create one pooled FCS.",
    };
  }
  const reference = samples[0];
  const referenceKeys = reference.sample.channels.map((channel) => channel.key);
  if (new Set(referenceKeys).size !== referenceKeys.length) {
    return {
      compatible: false,
      reason: `${reference.name || "The reference FCS"} contains duplicate channel identifiers.`,
    };
  }
  const referenceSet = new Set(referenceKeys);
  for (let index = 1; index < samples.length; index++) {
    const candidate = samples[index];
    const keys = candidate.sample.channels.map((channel) => channel.key);
    const set = new Set(keys);
    const duplicates = keys.filter((key, keyIndex) => keys.indexOf(key) !== keyIndex);
    const missing = referenceKeys.filter((key) => !set.has(key));
    const extra = keys.filter((key) => !referenceSet.has(key));
    if (missing.length || extra.length || duplicates.length) {
      const details = [
        missing.length ? `missing ${missing.join(", ")}` : "",
        extra.length ? `extra ${extra.join(", ")}` : "",
        duplicates.length ? `duplicate ${[...new Set(duplicates)].join(", ")}` : "",
      ].filter(Boolean).join("; ");
      return {
        compatible: false,
        reason: `${candidate.name || `FCS ${index + 1}`} has a different channel panel (${details}).`,
      };
    }
  }
  return { compatible: true, reason: null };
}

/**
 * Export ONE population concatenated across several samples into a single FCS.
 * Mirrors the multi-sample branch of GateLabR export_population_as_fcs (split_by_sample),
 * but writes one combined file instead of one-per-sample.
 *
 * Channel layout is fixed by the FIRST sample that contributes events (its stored channel
 * order + $PnN/$PnS). Subsequent samples are aligned to that layout BY CHANNEL KEY
 * (sample.index(key)), so column order differences between files don't matter. Every sample
 * that contributes events must have exactly the same channel-key set. A panel mismatch aborts
 * the export rather than silently dropping a sample or a channel.
 * Event order is preserved within each sample; samples are concatenated in list order.
 *
 * A keyword is carried only when every contributing sample states it with the same value, so a
 * pooled file claims no one file's $FIL or $DATE, and carries a $SPILLOVER, $TIMESTEP or $PnG
 * only when all of its sources agree on it. $PnR covers the pooled data.
 */
export function exportPopulationFcsCombined(
  samples: { sample: Sample; mask: Uint8Array; name?: string }[],
  assay: FcsExportAssay = "original",
): Uint8Array {
  for (const { sample, mask, name } of samples) {
    if (mask.length !== sample.fcs.nEvents) {
      const label = name?.trim() || "sample";
      throw new Error(
        `Cannot combine FCS export: population mask for "${label}" has ${mask.length} events but the sample has ${sample.fcs.nEvents}.`,
      );
    }
  }

  // Reference channel layout = first sample with a non-empty mask.
  let refKeys: string[] | null = null;
  for (const { sample, mask } of samples) {
    if (maskCount(mask) === 0) continue;
    refKeys = sample.channels.map((ch) => ch.key);
    if (new Set(refKeys).size !== refKeys.length) {
      throw new Error("Cannot combine FCS export: the reference sample contains duplicate channel identifiers.");
    }
    break;
  }

  if (!refKeys) {
    throw new Error("Cannot combine FCS export: the selected population contains no events in any sample.");
  }

  const refSet = new Set(refKeys);
  const parts: { source: ExportSource; keep: number[] }[] = [];

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    const { sample, mask, name } = samples[sampleIndex];
    const n = sample.fcs.nEvents;
    if (maskCount(mask) === 0) continue;

    const sampleKeys = sample.channels.map((ch) => ch.key);
    const sampleSet = new Set(sampleKeys);
    const missing = refKeys.filter((key) => !sampleSet.has(key));
    const extra = sampleKeys.filter((key) => !refSet.has(key));
    const duplicate = sampleKeys.filter((key, i) => sampleKeys.indexOf(key) !== i);
    if (missing.length || extra.length || duplicate.length) {
      const label = name?.trim() || `sample ${sampleIndex + 1}`;
      const details = [
        missing.length ? `missing: ${missing.join(", ")}` : "",
        extra.length ? `extra: ${extra.join(", ")}` : "",
        duplicate.length ? `duplicate: ${[...new Set(duplicate)].join(", ")}` : "",
      ].filter(Boolean).join("; ");
      throw new Error(
        `Cannot combine FCS export: "${label}" has a different channel panel (${details}). ` +
        `No partial file was written. Use “all (split zip)” for samples with different panels.`,
      );
    }

    // Resolve each reference channel to this sample's stored index (by key). Exact set
    // validation above guarantees every lookup succeeds; order may differ safely.
    const idxByRef = refKeys.map((key) => sample.index(key));
    if (idxByRef.some((i) => i === undefined)) {
      throw new Error("Cannot combine FCS export: internal channel alignment failed.");
    }

    const keep: number[] = [];
    for (let i = 0; i < n; i++) if (mask[i]) keep.push(i);
    if (keep.length === 0) continue;
    parts.push({ source: exportSource(sample, idxByRef as number[], assay), keep });
  }

  const double = assay !== "display" &&
    parts.some(({ source, keep }) => source.sourceColumns.some((c) => needsDouble(c, keep)));
  const total = parts.reduce((s, p) => s + p.keep.length, 0);
  const columns = refKeys.map((_, r) => {
    const out = double ? new Float64Array(total) : new Float32Array(total);
    let off = 0;
    for (const { source, keep } of parts) {
      out.set(subset(source.columns[r], keep, double), off);
      off += keep.length;
    }
    return out;
  });

  // Keep only what every contributing sample says alike.
  const sameEverywhere = (lists: [string, string][][]): [string, string][] => {
    const [first, ...rest] = lists;
    return first.filter(([k, v]) => rest.every((list) => list.some(([k2, v2]) => k2 === k && v2 === v)));
  };
  const ref = parts[0].source;
  const channels: FcsExportChannel[] = ref.channels.map((ch, r) => {
    const ranges = parts.map(({ source }) => source.channels[r].range)
      .filter((v): v is number => v !== undefined);
    const keywords = sameEverywhere(parts.map(({ source }) => source.channels[r].keywords ?? []));
    // A restated log $PnE holds only when every source states it on the same $PnR; otherwise the
    // pooled channel is written linear, and without a gain, which such a channel does not have.
    const amplifications = parts.map(({ source }) => source.channels[r].amplification);
    const restated = amplifications.every((a) => a !== undefined && a === amplifications[0]) &&
      ranges.length === parts.length && ranges.every((v) => v === ranges[0]);
    const mixed = !restated && amplifications.some((a) => a !== undefined);
    const { amplification: _unused, ...linear } = ch;
    return {
      ...(restated ? ch : linear),
      ...(ranges.length ? { range: Math.max(...ranges) } : {}),
      keywords: mixed
        ? keywords.filter(([template]) => parameterKeyword(template.replace("{n}", "1"))?.suffix !== "G")
        : keywords,
    };
  });
  const spillover = parts.every(({ source }) => source.spillover === ref.spillover) ? ref.spillover : null;
  const spilloverLabel = spillover && parts.every(({ source }) => source.spilloverLabel === ref.spilloverLabel) ? ref.spilloverLabel : null;

  return writeFcs(columns, channels, {
    datatype: double ? "D" : "F",
    keywords: [
      ...assayKeywords(assay, false),
      ...(spillover ? [["$SPILLOVER", spillover] as [string, string]] : []),
      ...(spilloverLabel ? [["GATELAB_SPILLOVER", spilloverLabel] as [string, string]] : []),
      ...sameEverywhere(parts.map(({ source }) => source.fileKeywords)),
    ],
  });
}

/**
 * Build a safe .fcs filename from optional prefix/suffix + sample & population names.
 * Each user-supplied part is sanitised (any char outside [A-Za-z0-9._-] → "_"). Empty parts
 * are dropped so no stray "__" separators appear. Mirrors GateLabR's gsub("[^A-Za-z0-9._-]",
 * "_", …) filename construction (filename_prefix + sample + "_" + pop + suffix + ".fcs").
 */
/** Reduce a user-editable name (population, file stem…) to a filesystem-safe token — replaces any
 * char outside [A-Za-z0-9._-] with "_". Windows-safe (kills / \ : * ? " < > |). Shared by all
 * download filename construction so a population like "CD4+/CD8-" never yields an invalid name. */
export function sanitizeFilePart(s: string | null | undefined): string {
  // Immunology population names are built from + and -, and the minus is usually the Unicode
  // U+2212 that the app renders. Mapping both to "_" made sibling gates collide on one name:
  // CD45RB+IgD+, CD45RB+IgD- and CD45RB-IgD+ all became "CD45RB_IgD_", and the later export
  // silently overwrote the earlier one -- twelve populations produced eight files.
  // + and - are legal on every filesystem, so they are kept and the signs survive.
  return String(s ?? "")
    .trim()
    .replace(/[\u2212\u2012\u2013\u2014\u2010\u2011]/g, "-") // minus / dashes → ASCII
    .replace(/[^A-Za-z0-9._+-]/g, "_");
}

/**
 * Merge exported files without ever losing one to a name clash.
 *
 * Sanitising can still map two distinct population names onto the same string, and writing
 * into a plain object would drop the earlier file with no error. Distinct content therefore
 * gets a numbered suffix instead.
 */
export function mergeExportFiles(
  into: Record<string, Uint8Array>,
  from: Record<string, Uint8Array>,
): Record<string, Uint8Array> {
  for (const [name, bytes] of Object.entries(from)) {
    if (!(name in into)) {
      into[name] = bytes;
      continue;
    }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let n = 2;
    while (`${stem}_${n}${ext}` in into) n++;
    into[`${stem}_${n}${ext}`] = bytes;
  }
  return into;
}

export function sanitizeFcsName(
  prefix: string | null | undefined,
  sampleName: string,
  popName: string,
  suffix: string | null | undefined,
): string {
  const parts = [prefix ?? "", sampleName ?? "", popName ?? "", suffix ?? ""]
    .map((s) => sanitizeFilePart(s))
    .filter((s) => s.length > 0);
  return parts.join("_") + ".fcs";
}
