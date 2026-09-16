// fcs.ts — FCS 3.0/3.1 reader (and lenient 2.0), ported to match GateLabR's
// flowCore-based fcs_import.R. Parses the HEADER offsets, the delimiter-separated
// TEXT segment ($PnN/$PnS/$DATATYPE/$BYTEORD/$SPILLOVER/…), and the DATA segment
// (float32/float64/int, honouring $BYTEORD), returning per-channel columns.
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

const td = new TextDecoder("latin1");

function ascii(buf: Uint8Array, start: number, end: number): string {
  return td.decode(buf.subarray(start, end));
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

function parseSpillover(raw: string | undefined, channels: FcsChannel[]): SpilloverMatrix | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim());
  const n = parseInt(parts[0], 10);
  if (!Number.isFinite(n) || n < 1) return null;
  const chNames = parts.slice(1, 1 + n);
  const nums = parts.slice(1 + n).map(Number);
  if (nums.length < n * n) return null;
  const matrix: number[][] = [];
  for (let i = 0; i < n; i++) matrix.push(nums.slice(i * n, i * n + n));
  // Identity → no real compensation (mirror .extract_display_spillover behaviour).
  const isIdentity = matrix.every((row, i) =>
    row.every((v, j) => (i === j ? Math.abs(v - 1) < 1e-9 : Math.abs(v) < 1e-9))
  );
  if (isIdentity) return null;
  // keep only channels that actually exist in the file
  const known = new Set(channels.map((c) => c.name));
  if (!chNames.every((c) => known.has(c))) {
    // tolerate: still return; the caller matches by name where possible
  }
  return { channels: chNames, matrix };
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
    // than exploding.
    // Modulo rather than a bitwise mask: a 32-bit word is negative to JavaScript's int32 ops.
    const modulus = Math.pow(2, Math.ceil(Math.log2(channel.range)));
    for (let i = 0; i < nEvents; i++) out[i] = Math.pow(10, k * (src[i] % modulus)) * offset;
    columns[channel.index] = out;
    // The range now describes the decoded values, as flowCore rewrites it: 10^decades · offset.
    channel.range = Math.pow(10, decades) * offset;
  }
}

export function parseFcs(buffer: ArrayBuffer): FcsFile {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  const version = ascii(bytes, 0, 6); // e.g. "FCS3.1"

  // HEADER offset fields: 8-byte ASCII, right-justified, starting at byte 10.
  let textStart = headInt(bytes, 10, 18);
  let textEnd = headInt(bytes, 18, 26);
  let dataStart = headInt(bytes, 26, 34);
  let dataEnd = headInt(bytes, 34, 42);

  const text = ascii(bytes, textStart, textEnd + 1);
  const kw = parseTextSegment(text);

  const get = (k: string) => kw[k.toUpperCase()];
  const par = parseInt(get("$PAR") || "0", 10);
  const tot = parseInt(get("$TOT") || "0", 10);
  const datatype = (get("$DATATYPE") || "F").toUpperCase(); // F=float32, D=float64, I=int
  const byteord = (get("$BYTEORD") || "1,2,3,4").trim();
  const littleEndian = byteord.startsWith("1,2") || byteord === "1234";

  // Large files: header offsets can be 0 → real offsets live in $BEGINDATA/$ENDDATA.
  if (dataStart === 0 && get("$BEGINDATA")) dataStart = parseInt(get("$BEGINDATA")!, 10);
  if (dataEnd === 0 && get("$ENDDATA")) dataEnd = parseInt(get("$ENDDATA")!, 10);
  void textStart; void textEnd;

  const channels: FcsChannel[] = [];
  for (let i = 1; i <= par; i++) {
    // Log amplification is a property of INTEGER data: FCS 3.1 requires $PnE/0,0/ for float and
    // double files, and flowCore, the reference this decode follows, decodes only when the
    // datatype is integer. A float file carrying a stray $PnE/4,1/ (a vendor keyword left over
    // from an integer template) had its real intensities exponentiated -- 262144 became 10,000.
    const logAmp = datatype === "I" ? parseLogAmp(get(`$P${i}E`)) : null;
    const feature = (get(`$P${i}FEATURE`) ?? "").trim();
    channels.push({
      index: i - 1,
      name: (get(`$P${i}N`) || `P${i}`).trim(),
      marker: (get(`$P${i}S`) ?? null) as string | null,
      bits: parseInt(get(`$P${i}B`) || "32", 10),
      range: parseFloat(get(`$P${i}R`) || "0"),
      ...(logAmp ? { logAmp } : {}),
      ...(feature ? { feature } : {}),
    });
  }
  const nCh = channels.length;

  // ── DATA segment (list mode, event-major: nEvents × nChannels) ────────────
  const columns: NumericColumn[] = channels.map((channel) => {
    if (datatype === "D") return new Float64Array(tot);
    if (datatype !== "I") return new Float32Array(tot);
    if (channel.bits <= 8) return new Uint8Array(tot);
    if (channel.bits <= 16) return new Uint16Array(tot);
    if (channel.bits <= 32) return new Uint32Array(tot);
    // JavaScript has no wider integer typed array compatible with ordinary numeric code.
    // Float64 retains every integer exactly through 53 bits, matching R's numeric storage.
    return new Float64Array(tot);
  });
  const bytesPerVal = datatype === "D" ? 8 : datatype === "F" ? 4 : (channels[0]?.bits || 32) / 8;

  if (datatype === "F") {
    // Fast path when the file matches the platform (little-endian, 4-aligned).
    if (littleEndian && dataStart % 4 === 0) {
      const flat = new Float32Array(buffer, dataStart, tot * nCh);
      for (let e = 0; e < tot; e++) {
        const base = e * nCh;
        for (let c = 0; c < nCh; c++) columns[c][e] = flat[base + c];
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
  } else if (datatype === "D") {
    let off = dataStart;
    for (let e = 0; e < tot; e++) {
      for (let c = 0; c < nCh; c++) {
        columns[c][e] = view.getFloat64(off, littleEndian);
        off += 8;
      }
    }
  } else {
    // Integer ($DATATYPE=I) — common for CyTOF. Per-channel bit width from $PnB.
    // Support any byte-aligned width (8/16/24/32/…); throw a clear error on a
    // non-byte-aligned $PnB rather than silently reading 1 byte and corrupting the
    // whole stream (the previous behaviour for anything ≠ 16/32).
    const byteW = channels.map((c) => {
      if (c.bits <= 0 || c.bits % 8 !== 0) {
        throw new Error(
          `Unsupported $P${c.index + 1}B=${c.bits}: only byte-aligned integer widths ` +
            "(8/16/24/32…) are supported.",
        );
      }
      return c.bits / 8;
    });
    let off = dataStart;
    for (let e = 0; e < tot; e++) {
      for (let c = 0; c < nCh; c++) {
        const bw = byteW[c];
        if (bw === 4) {
          columns[c][e] = view.getUint32(off, littleEndian);
        } else if (bw === 2) {
          columns[c][e] = view.getUint16(off, littleEndian);
        } else if (bw === 1) {
          columns[c][e] = view.getUint8(off);
        } else {
          // 24-bit and other byte-aligned widths: accumulate bytes (unsigned).
          // Use *256 (not <<) so 32-bit-plus values don't overflow JS bit ops.
          let val = 0;
          if (littleEndian) {
            for (let k = bw - 1; k >= 0; k--) val = val * 256 + view.getUint8(off + k);
          } else {
            for (let k = 0; k < bw; k++) val = val * 256 + view.getUint8(off + k);
          }
          columns[c][e] = val;
        }
        off += bw;
      }
    }
  }
  void bytesPerVal;
  void dataEnd;

  decodeLogAmplification(channels, columns, tot);

  const spillover = parseSpillover(get("$SPILLOVER") || get("$SPILL") || get("SPILL"), channels);
  const instrument = detectInstrumentType(channels.map((c) => c.name));

  return { version, nEvents: tot, channels, keywords: kw, columns, spillover, instrument };
}
