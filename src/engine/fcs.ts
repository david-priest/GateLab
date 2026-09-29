// fcs.ts — FCS 3.0/3.1/3.2 reader (and lenient 2.0), ported to match GateLabR's
// flowCore-based fcs_import.R. Parses the HEADER offsets, the delimiter-separated
// TEXT segment ($PnN/$PnS/$DATATYPE/$BYTEORD/$SPILLOVER/…), and the DATA segment
// (float32/float64/int/ASCII, honouring $BYTEORD and FCS 3.2's per-parameter
// $PnDATATYPE), returning per-channel columns.
//
// Verified against the ground truth of
// the Aria III fixture sample_Bmem_purity_small.fcs (see src/testFixtures.ts):
//   FCS3.1, $DATATYPE=F, $BYTEORD='4,3,2,1' (big-endian), 1080 events, 13 channels,
//   6-channel $SPILLOVER. (Endianness is real, not guessed — see fcs.test.ts.)

import { detectInstrumentType } from "./transforms";

export interface FcsChannel {
  index: number; // 0-based column
  name: string; // $PnN (short/parameter name; metal $PnN for CyTOF)
  marker: string | null; // $PnS (antigen/marker label, may be absent)
  bits: number; // $PnB
  range: number; // $PnR
  /** $PnE when the channel was logarithmically amplified in hardware (`decades > 0`).
   *  Recorded for provenance and export; `columns` already holds decoded linear values. */
  logAmp?: { decades: number; offset: number };
  /**
   * $PnG, the amplifier gain, when the file states one. Recorded, never applied: `columns`
   * holds the value the acquisition software wrote, which is what FlowJo gates on (a FlowJo
   * workspace's gate coordinates reproduce its own counts only on the undivided values; see
   * gatingmlGain.ts). FCS 3.1 and Gating-ML 2.0 define the "scale value" of a linear channel as
   * value / $PnG, so the Gating-ML import and export convert gate coordinates at that boundary
   * rather than here.
   */
  gain?: number;
  /** $PnFEATURE, on instruments that write it: what the parameter measures. A BD FACSDiscover
   *  S8 says Area, Height or Width for a pulse and MaskSize, Eccentricity, TotalIntensity and
   *  the like for a feature it derived from the cell's image. Absent when the file has none. */
  feature?: string;
  /** Stable app identity supplied by a non-FCS host (for example an SCE row name). */
  appKey?: string;
  /** Cosmetic label supplied by a non-FCS host; never used for gate identity. */
  appLabel?: string;
}

export interface SpilloverMatrix {
  channels: string[]; // $PnN of the compensated (fluorescence) channels
  matrix: number[][]; // channels.length × channels.length
}

/** Native per-channel storage. Float FCS stays float32; double and integer FCS retain
 * their source precision without forcing every common float file to use twice the memory. */
export type NumericColumn = Float32Array | Float64Array | Uint8Array | Uint16Array | Uint32Array;

export interface FcsFile {
  version: string;
  nEvents: number;
  channels: FcsChannel[];
  keywords: Record<string, string>;
  columns: NumericColumn[]; // columns[j] = raw values for channel j, length nEvents
  spillover: SpilloverMatrix | null;
  instrument: "flow" | "cytof";
}

/** One data set of an FCS file, as the HEADER chain ($NEXTDATA) lays them out. */
export interface FcsDataSetInfo {
  /** 0-based position in the file. */
  index: number;
  /** Byte offset of this data set's HEADER from the start of the file. */
  offset: number;
  /** Byte length of the data set: up to the next one's HEADER, or to the end of the file. */
  length: number;
  /** $TOT. */
  events: number;
  /** $PAR. */
  parameters: number;
  /** The well or specimen this data set holds ($WELLID, else $SMNO), when the file says. */
  label: string | null;
}

/**
 * A file holding more than one data set, read without saying which one.
 *
 * FCS allows several data sets in one file, chained by $NEXTDATA; a Guava plate export writes
 * one per well. Reading only the first, as GateLab did until 2026-09, dropped every other well
 * with no message (a Guava Muse file of four wells came in as its first 108 events). A caller
 * that can hold several samples reads each one with `parseFcs(buffer, { dataSet })`, or takes
 * each out as a file of its own with `extractFcsDataSet`; any other caller gets this error.
 */
export class FcsMultipleDataSetsError extends Error {
  readonly dataSets: readonly FcsDataSetInfo[];
  constructor(dataSets: readonly FcsDataSetInfo[]) {
    const counts = dataSets.map((d) => d.events.toLocaleString("en-US"));
    super(
      `This FCS file holds ${dataSets.length} data sets (${counts.join(", ")} events), ` +
        "and a data set was not chosen, so none was read.",
    );
    this.name = "FcsMultipleDataSetsError";
    this.dataSets = dataSets;
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const latin1 = new TextDecoder("latin1");

function ascii(buf: Uint8Array, start: number, end: number): string {
  return latin1.decode(buf.subarray(start, end));
}

/**
 * Decode a TEXT segment. FCS 3.1 §2.1.2 makes every keyword value UTF-8; files older than 3.1,
 * and some that claim 3.1, are 8-bit. UTF-8 is tried first and the segment is read as Latin-1
 * only when its bytes are not valid UTF-8. An 8-bit text in which some byte sequence happened to
 * be valid UTF-8 would be misread, but that takes a lead byte followed by the right number of
 * continuation bytes, which ordinary Latin-1 text does not contain. Reading everything as
 * Latin-1, as GateLab did until 2026-09, turned every UTF-8 label into mojibake: "IFN-γ" arrived
 * as "IFN-Î³", and was then the channel's identity key.
 */
function decodeText(buf: Uint8Array, start: number, end: number): string {
  const bytes = buf.subarray(start, end);
  try {
    return utf8.decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}

/** Parse an integer from an ASCII, space-padded header field. */
function headInt(buf: Uint8Array, start: number, end: number): number {
  const s = ascii(buf, start, end).trim();
  return s ? parseInt(s, 10) : 0;
}

/** Split the TEXT segment into a keyword map. FCS escapes a literal delimiter by
 *  doubling it. Keys are stored upper-cased ($-prefixed for standard keywords). */
function parseTextSegment(text: string): Record<string, string> {
  const delim = text[0];
  const body = text.slice(1);
  // Split on single delimiter, but a doubled delimiter is a literal delimiter char.
  const tokens: string[] = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === delim) {
      if (body[i + 1] === delim) {
        cur += delim;
        i++;
      } else {
        tokens.push(cur);
        cur = "";
      }
    } else {
      cur += body[i];
    }
  }
  if (cur.length) tokens.push(cur);

  const kw: Record<string, string> = {};
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    kw[tokens[i].trim().toUpperCase()] = tokens[i + 1];
  }
  return kw;
}

/**
 * Parse a $SPILLOVER-style keyword value, identity included. `parseSpillover` below drops an
 * identity matrix because it compensates nothing; an export carrying the source's keyword needs
 * the matrix as the file states it.
 */
export function parseSpilloverKeyword(raw: string | undefined): SpilloverMatrix | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim());
  const n = parseInt(parts[0], 10);
  if (!Number.isFinite(n) || n < 1) return null;
  const chNames = parts.slice(1, 1 + n);
  const nums = parts.slice(1 + n).map(Number);
  if (chNames.length < n || nums.length < n * n || nums.slice(0, n * n).some((v) => !Number.isFinite(v))) {
    return null;
  }
  const matrix: number[][] = [];
  for (let i = 0; i < n; i++) matrix.push(nums.slice(i * n, i * n + n));
  return { channels: chNames, matrix };
}

function parseSpillover(raw: string | undefined): SpilloverMatrix | null {
  const parsed = parseSpilloverKeyword(raw);
  if (!parsed) return null;
  // Identity → no real compensation (mirror .extract_display_spillover behaviour).
  const isIdentity = parsed.matrix.every((row, i) =>
    row.every((v, j) => (i === j ? Math.abs(v - 1) < 1e-9 : Math.abs(v) < 1e-9))
  );
  if (isIdentity) return null;
  // Channels the file does not have stay in the matrix: the Sample reports them (sample.ts,
  // spilloverOrigin) rather than compensating with a submatrix and saying nothing.
  return parsed;
}

/** Parse `$PnE` as `f1,f2`. `f1 > 0` marks a channel that was logarithmically amplified
 *  in hardware, so the stored integer is a log channel number rather than an intensity. */
function parseLogAmp(raw: string | undefined): { decades: number; offset: number } | null {
  if (!raw) return null;
  const [a, b] = raw.split(",");
  const decades = parseFloat(a);
  if (!Number.isFinite(decades) || decades <= 0) return null;
  const parsed = parseFloat(b ?? "");
  // f2 = 0 is out of spec but common in the wild; every reader substitutes 1.
  const offset = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  return { decades, offset };
}

/**
 * Whether parameter `n` (1-based) states logarithmic amplification in its $PnE (f1 > 0), whatever
 * its data type.
 *
 * On integer data the channel is decoded on read and carries `logAmp`. On float data a log $PnE is
 * out of spec (FCS 3.1 §3.2.20: floating point data "shall be stored as linear with $PnE/0,0/"),
 * and readers split three ways over it: flowCore's read.FCS takes the stored value (it decodes only
 * integer data), flowio and FlowKit apply 10^(f1·x/$PnR)·f2 and then divide by $PnG, and flowCore's
 * linearize-with-PnG-scaling divides the stored value by $PnG. GateLab reads the stored value, as
 * flowCore does. A Guava Muse's FSC-, YEL- and RED-HLog channels are such channels ($PnE 4.0,1.0 on
 * $PnR 10000 with $PnG 2.95 to 117.38), holding log10 of the matching HLin channel, so none of the
 * decodes recovers a linear value; the flowCore-written GvHD files state $PnE 4,0 on values that are
 * already linear. FCS 3.1 also bars a gain on such a channel ("$PnG/f/, f not equal to 1, shall not
 * be used together with $PnE different from $PnE/0,0/"), so it has no linear gain either.
 */
export function statesLogAmplification(keywords: Record<string, string>, n: number): boolean {
  return parseLogAmp(keywords[`$P${n}E`]) !== null;
}

/**
 * Decode hardware log amplification in place, so `columns` always holds linear values.
 *
 * FCS 3.1 §3.2: for a log-amplified channel the stored value `x` over range `r` means
 * `10^(f1 * x / r) * f2`. This is DECODING, not a display transform — the datum the
 * instrument measured is the linear value, and every other reader (flowCore, FlowJo,
 * flowio, fcsparser) linearises on read. Leaving it encoded would put GateLab's raw
 * space in different units from every tool it exchanges gates with, so a Gating-ML
 * coordinate would not survive a round trip.
 *
 * A channel with no usable `$PnR` cannot be decoded; it is left as stored and its
 * `logAmp` is not set, so nothing downstream believes it was linearised.
 */
function decodeLogAmplification(
  channels: FcsChannel[],
  columns: NumericColumn[],
  nEvents: number,
): void {
  for (const channel of channels) {
    if (!channel.logAmp) continue;
    const { decades, offset } = channel.logAmp;
    if (!(channel.range > 0)) {
      delete channel.logAmp;
      continue;
    }
    // Float64, not Float32. The source is an integer over a small range, so the decode
    // is exact in double precision. In single precision the decoded values of one stored
    // integer can straddle a gate boundary, and because log-amplified data is heavily
    // quantised a boundary tie group is large: on the FACSCalibur fixture a float32
    // decode moved 1,374 of 20,000 events across a quantile gate edge.
    const src = columns[channel.index];
    const out = new Float64Array(nEvents);
    const k = decades / channel.range;
    // A stored integer above $PnR (flag bits, a vendor bug) would decode to 10^(more than the
    // declared decades) -- up to Infinity. flowCore masks the value to the channel's bit width,
    // ceil(log2($PnR)), before decoding; the same here, so an out-of-range word wraps rather
    // than exploding. (The integer read below already masks every integer channel; this is the
    // same modulus, so applying it again changes nothing.)
    // Modulo rather than a bitwise mask: a 32-bit word is negative to JavaScript's int32 ops.
    const modulus = Math.pow(2, Math.ceil(Math.log2(channel.range)));
    for (let i = 0; i < nEvents; i++) out[i] = Math.pow(10, k * (src[i] % modulus)) * offset;
    columns[channel.index] = out;
    // The range now describes the decoded values, as flowCore rewrites it: 10^decades · offset.
    channel.range = Math.pow(10, decades) * offset;
  }
}

/**
 * The bytes of an FCS file that hold its TEXT segment, read from the HEADER: enough to read the
 * keywords without the data. Null when the header cannot be read.
 */
export function fcsTextSegmentEnd(header: ArrayBuffer): number | null {
  const bytes = new Uint8Array(header);
  if (bytes.length < 26 || !/^FCS\d/.test(ascii(bytes, 0, 4))) return null;
  const end = headInt(bytes, 18, 26);
  return end > 0 ? end + 1 : null;
}

/**
 * The primary TEXT keywords of an FCS file, without reading its data: what identifies the
 * acquisition ($TOT, $DATE, $BTIM, $ETIM, GUID) is there, so a file can be paired with a
 * workspace's record of it before it is loaded. Null when the buffer holds no readable TEXT.
 */
export function readFcsKeywords(buffer: ArrayBuffer): Record<string, string> | null {
  const bytes = new Uint8Array(buffer);
  const end = fcsTextSegmentEnd(buffer);
  if (end === null) return null;
  const start = headInt(bytes, 10, 18);
  if (start <= 0 || end > bytes.length || start >= end) return null;
  // Decoded as parseFcs decodes TEXT (UTF-8, Latin-1 where the bytes are not UTF-8), so a
  // keyword read here compares equal to the same keyword of the loaded file.
  return parseTextSegment(decodeText(bytes, start, end));
}

/**
 * The keywords of an FCS file on disk, reading only its HEADER and TEXT: enough to pair a chosen
 * file with a workspace's record of it before it is loaded. Null when they cannot be read.
 */
export async function readFcsFileKeywords(file: Blob): Promise<Record<string, string> | null> {
  try {
    const part = async (end: number): Promise<ArrayBuffer> => {
      const slice = file.slice(0, end) as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
      return typeof slice.arrayBuffer === "function" ? slice.arrayBuffer() : file.arrayBuffer();
    };
    const head = await part(58);
    const end = fcsTextSegmentEnd(head);
    if (end === null) return null;
    return readFcsKeywords(end <= head.byteLength ? head : await part(end));
  } catch {
    return null;
  }
}

/** HEADER fields of one data set, as absolute byte offsets into the file. */
interface DataSetHeader {
  version: string;
  textStart: number;
  textEnd: number;
  dataStart: number;
  dataEnd: number;
}

const FCS_VERSION = /^FCS\d\.\d$/;

/** Read and check one data set's HEADER at `base`. Offsets in an FCS data set are relative to
 *  the start of that data set's HEADER, so every offset returned here has `base` added. */
function readHeader(bytes: Uint8Array, base: number): DataSetHeader {
  if (bytes.length - base < 58) {
    throw new Error(
      base === 0
        ? `Not an FCS file: it is ${bytes.length} bytes long, shorter than the 58-byte FCS HEADER.`
        : `The FCS data set at byte ${base} is cut short: its 58-byte HEADER does not fit in the file.`,
    );
  }
  const version = ascii(bytes, base, base + 6);
  if (!FCS_VERSION.test(version)) {
    const shown = JSON.stringify(ascii(bytes, base, base + 6).replace(/[^\x20-\x7e]/g, "?"));
    throw new Error(
      base === 0
        ? `Not an FCS file: it does not begin with an FCS version such as "FCS3.1" (it begins ${shown}).`
        : `The FCS file's $NEXTDATA points to byte ${base}, where there is no FCS HEADER (found ${shown}).`,
    );
  }
  const textStart = headInt(bytes, base + 10, base + 18);
  const textEnd = headInt(bytes, base + 18, base + 26);
  if (!(textStart > 0) || textEnd < textStart || base + textEnd >= bytes.length) {
    throw new Error(
      `The FCS HEADER${base ? ` at byte ${base}` : ""} places the TEXT segment at bytes ${textStart}-${textEnd}, ` +
        `which is not inside the ${bytes.length}-byte file.`,
    );
  }
  return {
    version,
    textStart: base + textStart,
    textEnd: base + textEnd,
    dataStart: headInt(bytes, base + 26, base + 34),
    dataEnd: headInt(bytes, base + 34, base + 42),
  };
}

function readKeywords(bytes: Uint8Array, header: DataSetHeader): Record<string, string> {
  return parseTextSegment(decodeText(bytes, header.textStart, header.textEnd + 1));
}

function dataSetLabel(kw: Record<string, string>): string | null {
  for (const k of ["$WELLID", "WELLID", "$SMNO", "SMNO"]) {
    const v = kw[k]?.trim();
    if (v) return v;
  }
  return null;
}

/** Why a $NEXTDATA past the end of the file was refused, with the likelier cause when the file
 *  holds an FCS HEADER at the pointer's value counted from the start of the file. */
function nextDataPastEndMessage(bytes: Uint8Array, base: number, next: number): string {
  const absolute = base > 0 && next < bytes.length && bytes.length - next >= 58 &&
    FCS_VERSION.test(ascii(bytes, next, next + 6));
  return (
    `The FCS file's $NEXTDATA points to byte ${base + next}, past the end of the ${bytes.length}-byte file, ` +
    "so a data set it names is not there" +
    (absolute
      ? `: its writer seems to have counted $NEXTDATA from the start of the file, where FCS counts it from ` +
        `the start of each data set (byte ${next} holds an FCS HEADER)`
      : ": the file may have been cut short") +
    ". No data set was read."
  );
}

/**
 * Every data set in an FCS file, following $NEXTDATA from the first HEADER.
 *
 * $NEXTDATA is the byte offset of the next data set's HEADER from the start of the CURRENT one
 * (FCS 3.1 §3.2.20), so the offsets accumulate, as flowCore's read.FCS adds them. 0 ends the
 * chain. A pointer that lands inside the file on anything but an FCS HEADER, or at or past the end
 * of the file, is an error: the file then names a data set it does not hold where it says. Until
 * 2026-09 a pointer past the end was read as the end of the chain, which dropped a data set
 * without a message whenever the writer had counted $NEXTDATA from the start of the file (a
 * three-data-set file came in as two); flowio and flowCore refuse such a file too.
 */
export function listFcsDataSets(buffer: ArrayBuffer): FcsDataSetInfo[] {
  const bytes = new Uint8Array(buffer);
  const sets: { offset: number; kw: Record<string, string> }[] = [];
  let base = 0;
  for (;;) {
    const header = readHeader(bytes, base);
    const kw = readKeywords(bytes, header);
    sets.push({ offset: base, kw });
    const next = parseInt((kw["$NEXTDATA"] ?? "0").trim() || "0", 10);
    if (!Number.isFinite(next) || next <= 0) break;
    const nextBase = base + next;
    if (nextBase >= bytes.length) throw new Error(nextDataPastEndMessage(bytes, base, next));
    if (sets.some((s) => s.offset === nextBase)) {
      throw new Error(`The FCS file's $NEXTDATA chain loops back to byte ${nextBase}.`);
    }
    base = nextBase;
  }
  return sets.map((s, index) => ({
    index,
    offset: s.offset,
    length: (index + 1 < sets.length ? sets[index + 1].offset : bytes.length) - s.offset,
    events: parseInt(s.kw["$TOT"] || "0", 10) || 0,
    parameters: parseInt(s.kw["$PAR"] || "0", 10) || 0,
    label: dataSetLabel(s.kw),
  }));
}

/**
 * One data set of a multi-data-set FCS file, as an FCS file of its own.
 *
 * Every offset inside a data set is relative to that data set's HEADER, so its bytes, cut out
 * unchanged, are already a valid FCS file -- except that $NEXTDATA still points past the end.
 * That value is overwritten in place with "0" padded by spaces to the same width, so no offset
 * moves and every other byte is the source's.
 */
export function extractFcsDataSet(buffer: ArrayBuffer, index: number): Uint8Array {
  const sets = listFcsDataSets(buffer);
  const set = sets[index];
  if (!set) throw new Error(`This FCS file has no data set ${index + 1} (it holds ${sets.length}).`);
  const out = new Uint8Array(buffer.slice(set.offset, set.offset + set.length));
  const header = readHeader(out, 0);
  const delim = out[header.textStart];
  const key = Array.from("$NEXTDATA", (c) => c.charCodeAt(0));
  const upper = (b: number) => (b >= 97 && b <= 122 ? b - 32 : b);
  for (let i = header.textStart; i + key.length + 1 < header.textEnd; i++) {
    if (out[i] !== delim) continue;
    let hit = true;
    for (let k = 0; k < key.length; k++) {
      if (upper(out[i + 1 + k]) !== key[k]) { hit = false; break; }
    }
    if (!hit || out[i + 1 + key.length] !== delim) continue;
    const valueStart = i + key.length + 2;
    let valueEnd = valueStart;
    while (valueEnd <= header.textEnd && out[valueEnd] !== delim) valueEnd++;
    if (valueEnd > valueStart) {
      out[valueStart] = 0x30; // "0"
      for (let k = valueStart + 1; k < valueEnd; k++) out[k] = 0x20;
    }
    break;
  }
  return out;
}

/**
 * The sample name GateLab gives one data set of a multi-data-set file:
 * "plate.fcs" → "plate (data set 2 of 4, A02).fcs". The name records which file and which data
 * set, so a workspace saved by reference can find the file again and take the same data set out
 * of it (parseFcsDataSetFileName).
 */
export function fcsDataSetFileName(
  fileName: string,
  index: number,
  count: number,
  label: string | null,
): string {
  const dot = fileName.toLowerCase().endsWith(".fcs") ? fileName.length - 4 : fileName.length;
  const stem = fileName.slice(0, dot);
  const ext = fileName.slice(dot) || ".fcs";
  const safeLabel = fcsDataSetLabelToken(label);
  return `${stem} (data set ${index + 1} of ${count}${safeLabel ? `, ${safeLabel}` : ""})${ext}`;
}

/** A data set's well or specimen label as fcsDataSetFileName writes it into a sample name. */
export function fcsDataSetLabelToken(label: string | null | undefined): string {
  return (label ?? "").replace(/[()/\\,]/g, "_").trim();
}

/** The file, 0-based data set and label a name from fcsDataSetFileName refers to, or null. */
export function parseFcsDataSetFileName(
  name: string,
): { fileName: string; index: number; count: number; label: string | null } | null {
  const m = /^(.*) \(data set (\d+) of (\d+)(?:, ([^()]*))?\)(\.fcs)?$/i.exec(name);
  if (!m) return null;
  const index = parseInt(m[2], 10) - 1;
  const count = parseInt(m[3], 10);
  if (!(index >= 0 && index < count)) return null;
  return { fileName: `${m[1]}${m[5] ?? ""}`, index, count, label: m[4]?.trim() || null };
}

/**
 * Data set `index` of a file expected to hold `count`, as a file of its own. Used to reopen a
 * sample named by fcsDataSetFileName; a file that no longer holds that many data sets is refused
 * rather than read at a different position.
 */
export function extractNamedFcsDataSet(buffer: ArrayBuffer, index: number, count: number): Uint8Array {
  const sets = listFcsDataSets(buffer);
  if (sets.length !== count) {
    throw new Error(
      `The file holds ${sets.length} data set${sets.length === 1 ? "" : "s"}, not the ${count} this sample was taken from.`,
    );
  }
  return extractFcsDataSet(buffer, index);
}

export interface ParseFcsOptions {
  /** Which data set to read, 0-based. Required for a file holding more than one. */
  dataSet?: number;
}

type ParamKind = "F" | "D" | "I" | "A";

export function parseFcs(buffer: ArrayBuffer, opts: ParseFcsOptions = {}): FcsFile {
  const sets = listFcsDataSets(buffer);
  if (opts.dataSet === undefined && sets.length > 1) throw new FcsMultipleDataSetsError(sets);
  const chosen = sets[opts.dataSet ?? 0];
  if (!chosen) {
    throw new Error(`This FCS file has no data set ${(opts.dataSet ?? 0) + 1} (it holds ${sets.length}).`);
  }
  return parseDataSet(buffer, chosen.offset);
}

function parseDataSet(buffer: ArrayBuffer, base: number): FcsFile {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  const header = readHeader(bytes, base);
  const version = header.version; // e.g. "FCS3.1"
  const kw = readKeywords(bytes, header);

  const get = (k: string) => kw[k.toUpperCase()];
  const par = parseInt(get("$PAR") || "0", 10);
  const tot = parseInt(get("$TOT") || "0", 10);
  const datatype = (get("$DATATYPE") || "F").trim().toUpperCase(); // F=float32, D=float64, I=int, A=ASCII
  if (!["F", "D", "I", "A"].includes(datatype)) {
    throw new Error(`Unsupported $DATATYPE=${datatype}: FCS data are I, F, D or A.`);
  }
  const mode = (get("$MODE") || "L").trim().toUpperCase();
  if (mode !== "L") {
    // Histogram modes (C, U) store frequencies, not events; reading them as list mode would
    // produce plausible-looking nonsense.
    throw new Error(`Unsupported $MODE=${mode}: only list-mode (L) data can be gated.`);
  }
  const byteord = (get("$BYTEORD") || "1,2,3,4").trim();
  const littleEndian = byteord.startsWith("1,2") || byteord === "1234";

  // Large files: header offsets can be 0 → real offsets live in $BEGINDATA/$ENDDATA.
  let dataStart = header.dataStart;
  let dataEnd = header.dataEnd;
  if (dataStart === 0 && get("$BEGINDATA")) dataStart = parseInt(get("$BEGINDATA")!, 10);
  if (dataEnd === 0 && get("$ENDDATA")) dataEnd = parseInt(get("$ENDDATA")!, 10);
  dataStart += base;
  dataEnd += base;

  // Each parameter's storage: FCS 3.2 lets $PnDATATYPE override $DATATYPE per parameter (the
  // S8 writes 22 integer bookkeeping parameters -- event number, drop id, sort flags, plate
  // position -- inside a float file). Read as float32 those came out as denormals near zero.
  const kinds: ParamKind[] = [];
  for (let i = 1; i <= par; i++) {
    const own = (get(`$P${i}DATATYPE`) ?? "").trim().toUpperCase();
    if (own && datatype !== "A") {
      if (!["F", "D", "I"].includes(own)) {
        throw new Error(`Unsupported $P${i}DATATYPE=${own}: a parameter's data type is I, F or D.`);
      }
      kinds.push(own as ParamKind);
    } else {
      kinds.push(datatype as ParamKind);
    }
  }

  const channels: FcsChannel[] = [];
  for (let i = 1; i <= par; i++) {
    // Log amplification is a property of INTEGER data: FCS 3.1 requires $PnE/0,0/ for float and
    // double files, and flowCore, the reference this decode follows, decodes only when the
    // datatype is integer. A float file carrying a stray $PnE/4,1/ (a vendor keyword left over
    // from an integer template) had its real intensities exponentiated -- 262144 became 10,000.
    const logAmp = kinds[i - 1] === "I" ? parseLogAmp(get(`$P${i}E`)) : null;
    const feature = (get(`$P${i}FEATURE`) ?? "").trim();
    const gain = parseFloat(get(`$P${i}G`) ?? "");
    channels.push({
      index: i - 1,
      name: (get(`$P${i}N`) || `P${i}`).trim(),
      marker: (get(`$P${i}S`) ?? null) as string | null,
      bits: parseInt(get(`$P${i}B`) || "32", 10),
      range: parseFloat(get(`$P${i}R`) || "0"),
      ...(logAmp ? { logAmp } : {}),
      ...(Number.isFinite(gain) && gain > 0 ? { gain } : {}),
      ...(feature ? { feature } : {}),
    });
  }
  const nCh = channels.length;

  // ── DATA segment (list mode, event-major: nEvents × nChannels) ────────────
  const columns: NumericColumn[] = channels.map((channel, c) => {
    const kind = kinds[c];
    if (kind === "D" || kind === "A") return new Float64Array(tot);
    if (kind === "F") return new Float32Array(tot);
    if (channel.bits <= 8) return new Uint8Array(tot);
    if (channel.bits <= 16) return new Uint16Array(tot);
    if (channel.bits <= 32) return new Uint32Array(tot);
    // JavaScript has no wider integer typed array compatible with ordinary numeric code.
    // Float64 retains every integer exactly through 53 bits, matching R's numeric storage.
    return new Float64Array(tot);
  });

  if (datatype === "A") {
    readAsciiData(bytes, dataStart, dataEnd, channels, columns, tot);
  } else {
    const widths = channels.map((c, idx) => {
      const kind = kinds[idx];
      if (kind === "F") return 4;
      if (kind === "D") return 8;
      // Integer ($DATATYPE=I) — common for CyTOF. Per-channel bit width from $PnB.
      // Support any byte-aligned width (8/16/24/32/…); throw a clear error on a
      // non-byte-aligned $PnB rather than silently reading 1 byte and corrupting the
      // whole stream (the previous behaviour for anything ≠ 16/32).
      if (!(c.bits > 0) || c.bits % 8 !== 0) {
        throw new Error(
          `Unsupported $P${c.index + 1}B=${c.bits}: only byte-aligned integer widths ` +
            "(8/16/24/32…) are supported.",
        );
      }
      return c.bits / 8;
    });
    const rowBytes = widths.reduce((s, w) => s + w, 0);
    const needed = tot * rowBytes;
    if (needed > 0 && (dataStart < base || dataStart + needed > bytes.length)) {
      throw new Error(
        `The FCS DATA segment is incomplete: ${tot.toLocaleString("en-US")} events of ${nCh} parameters ` +
          `need ${needed.toLocaleString("en-US")} bytes from byte ${dataStart - base}, but the file ` +
          `holds ${(bytes.length - base).toLocaleString("en-US")}.`,
      );
    }
    if (kinds.every((k) => k === "F")) {
      // Fast path when the file matches the platform (little-endian, 4-aligned).
      if (littleEndian && dataStart % 4 === 0) {
        const flat = new Float32Array(buffer, dataStart, tot * nCh);
        for (let e = 0; e < tot; e++) {
          const eventBase = e * nCh;
          for (let c = 0; c < nCh; c++) columns[c][e] = flat[eventBase + c];
        }
      } else {
        let off = dataStart;
        for (let e = 0; e < tot; e++) {
          for (let c = 0; c < nCh; c++) {
            columns[c][e] = view.getFloat32(off, littleEndian);
            off += 4;
          }
        }
      }
    } else {
      // Integer words hold at most ceil(log2($PnR)) meaningful bits. FCS 3.1 §3.2.20 ($PnB):
      // "Implementors should use a bit mask when reading these list mode parameter values to
      // insure that erroneous values are not read from the unused bits"; flowCore and flowio
      // both do. Until 2026-09 GateLab masked only log-amplified channels, so a flag bit kept a
      // linear channel's value 32,768 too high. Modulo, not `&`: JavaScript's bitwise operators
      // are 32-bit signed.
      const modulus = channels.map((c, idx) => {
        if (kinds[idx] !== "I" || !(c.range > 0)) return 0;
        const used = Math.ceil(Math.log2(c.range));
        return used < c.bits ? Math.pow(2, used) : 0;
      });
      let off = dataStart;
      for (let e = 0; e < tot; e++) {
        for (let c = 0; c < nCh; c++) {
          const bw = widths[c];
          const kind = kinds[c];
          let val: number;
          if (kind === "F") {
            val = view.getFloat32(off, littleEndian);
          } else if (kind === "D") {
            val = view.getFloat64(off, littleEndian);
          } else if (bw === 4) {
            val = view.getUint32(off, littleEndian);
          } else if (bw === 2) {
            val = view.getUint16(off, littleEndian);
          } else if (bw === 1) {
            val = view.getUint8(off);
          } else {
            // 24-bit and other byte-aligned widths: accumulate bytes (unsigned).
            // Use *256 (not <<) so 32-bit-plus values don't overflow JS bit ops.
            val = 0;
            if (littleEndian) {
              for (let k = bw - 1; k >= 0; k--) val = val * 256 + view.getUint8(off + k);
            } else {
              for (let k = 0; k < bw; k++) val = val * 256 + view.getUint8(off + k);
            }
          }
          if (modulus[c] > 0) val %= modulus[c];
          columns[c][e] = val;
          off += bw;
        }
      }
    }
  }

  decodeLogAmplification(channels, columns, tot);

  const spillover = parseSpillover(get("$SPILLOVER") || get("$SPILL") || get("SPILL"));
  const instrument = detectInstrumentType(channels.map((c) => c.name));

  return { version, nEvents: tot, channels, keywords: kw, columns, spillover, instrument };
}

/**
 * $DATATYPE/A/: ASCII-encoded numbers. With a numeric $PnB each value is exactly that many
 * characters, with no separators; with $PnB of "*" on every parameter the values are free format,
 * separated by spaces, tabs, commas or line breaks (FCS 3.0 §3.2.18). Anything other than I, F,
 * D or A is refused above; until 2026-09 an ASCII file was read as binary integers and came in
 * as the character codes of its digits.
 */
function readAsciiData(
  bytes: Uint8Array,
  dataStart: number,
  dataEnd: number,
  channels: FcsChannel[],
  columns: NumericColumn[],
  tot: number,
): void {
  const nCh = channels.length;
  if (tot === 0 || nCh === 0) return;
  const text = ascii(bytes, dataStart, Math.min(bytes.length, dataEnd + 1));
  const store = (e: number, c: number, token: string) => {
    const v = Number(token.trim());
    if (!Number.isFinite(v)) {
      throw new Error(`$DATATYPE=A: event ${e + 1}, parameter ${c + 1} is not a number (${JSON.stringify(token)}).`);
    }
    columns[c][e] = v;
  };
  const free = channels.every((c) => !Number.isFinite(c.bits));
  if (free) {
    const tokens = text.split(/[\s,]+/).filter((t) => t.length > 0);
    if (tokens.length < tot * nCh) {
      throw new Error(`$DATATYPE=A: the DATA segment holds ${tokens.length} values; ${tot} events of ${nCh} parameters need ${tot * nCh}.`);
    }
    for (let e = 0; e < tot; e++) for (let c = 0; c < nCh; c++) store(e, c, tokens[e * nCh + c]);
    return;
  }
  if (channels.some((c) => !(c.bits > 0))) {
    throw new Error("$DATATYPE=A: $PnB must give a character count for every parameter, or be * for all of them.");
  }
  const rowChars = channels.reduce((s, c) => s + c.bits, 0);
  if (text.length < tot * rowChars) {
    throw new Error(`$DATATYPE=A: the DATA segment holds ${text.length} characters; ${tot} events need ${tot * rowChars}.`);
  }
  let off = 0;
  for (let e = 0; e < tot; e++) {
    for (let c = 0; c < nCh; c++) {
      store(e, c, text.slice(off, off + channels[c].bits));
      off += channels[c].bits;
    }
  }
}
