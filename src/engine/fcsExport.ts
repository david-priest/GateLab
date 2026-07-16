// fcsExport.ts — write a gated population back out as an FCS 3.0 file.
// Ported from GateLabR inst/app/R/fcs_export.R (export_population_as_fcs +
// .matrix_to_flowframe), reimplementing what flowCore::write.FCS produces since we have
// no R: FCS 3.0, $DATATYPE=F (32-bit float), list mode, one column per stored channel.
//
// Matching GateLabR's semantics exactly:
//   • data = the requested assay subset by the population mask: original uncompensated
//     measurements, compensated linear measurements, or transformed display values;
//     only the stored channel subset
//     (the 422→33 filtering is already baked into the Sample — the dropped params are gone).
//   • $PnN = the ORIGINAL FCS parameter name (channel.pnn); $PnS = the display name;
//     $PnR = 262144 (2^18); $PnB = 32; $PnE = 0,0; event order preserved.

import type { Sample } from "./sample";

export type FcsExportAssay = "original" | "compensated" | "display";

export interface FcsExportChannel {
  name: string; // $PnN — original FCS parameter name
  desc: string; // $PnS — display / marker name
}

const FCS_RANGE = 262144; // 2^18, matches .matrix_to_flowframe `range`
const DELIM = "|"; // TEXT keyword delimiter (doubled to escape a literal)

function escDelim(s: string): string {
  return s.split(DELIM).join(DELIM + DELIM);
}

function buildText(kw: [string, string][]): string {
  let t = DELIM;
  for (const [k, v] of kw) t += escDelim(k) + DELIM + escDelim(v) + DELIM;
  return t;
}

/** Right-justify an integer in an 8-char ASCII header field. 0 if it won't fit. */
function headerField(n: number): string {
  const s = n <= 99999999 && n >= 0 ? String(n) : "0";
  return s.padStart(8, " ");
}

/**
 * Write columns (one Float32Array per channel, all the same length = event count) as an
 * FCS 3.0 byte stream. Data is written event-major (list mode), little-endian float32.
 */
export function writeFcs(columns: Float32Array[], channels: FcsExportChannel[]): Uint8Array {
  const nPar = channels.length;
  const nEvents = columns[0]?.length ?? 0;
  const dataBytes = nEvents * nPar * 4;

  const paramKeywords = (): [string, string][] => {
    const kw: [string, string][] = [];
    for (let i = 0; i < nPar; i++) {
      const p = i + 1;
      kw.push([`$P${p}N`, channels[i].name]);
      kw.push([`$P${p}B`, "32"]);
      kw.push([`$P${p}E`, "0,0"]);
      kw.push([`$P${p}R`, String(FCS_RANGE)]);
      if (channels[i].desc) kw.push([`$P${p}S`, channels[i].desc]);
    }
    return kw;
  };

  // $BEGINDATA/$ENDDATA feed back into TEXT length → converge the offsets.
  const textStart = 58; // after the 58-byte HEADER
  let beginData = 0;
  let endData = 0;
  let text = "";
  for (let iter = 0; iter < 6; iter++) {
    const kw: [string, string][] = [
      ["$BEGINANALYSIS", "0"],
      ["$ENDANALYSIS", "0"],
      ["$BEGINSTEXT", "0"],
      ["$ENDSTEXT", "0"],
      ["$BEGINDATA", String(beginData)],
      ["$ENDDATA", String(endData)],
      ["$BYTEORD", "1,2,3,4"], // little-endian
      ["$DATATYPE", "F"],
      ["$MODE", "L"],
      ["$NEXTDATA", "0"],
      ["$PAR", String(nPar)],
      ["$TOT", String(nEvents)],
      ...paramKeywords(),
    ];
    text = buildText(kw);
    const textEnd = textStart + text.length - 1;
    const nb = textEnd + 1;
    const ne = dataBytes > 0 ? nb + dataBytes - 1 : 0;
    if (nb === beginData && ne === endData) break;
    beginData = nb;
    endData = ne;
  }

  const textEnd = textStart + text.length - 1;

  // HEADER (58 bytes): "FCS3.0" + 4 spaces + 6 × 8-char offset fields.
  const header =
    "FCS3.0" +
    "    " +
    headerField(textStart) +
    headerField(textEnd) +
    headerField(beginData <= 99999999 ? beginData : 0) +
    headerField(endData <= 99999999 ? endData : 0) +
    headerField(0) + // ANALYSIS start
    headerField(0); // ANALYSIS end

  const out = new Uint8Array(beginData + dataBytes);
  // header + text are latin1/ASCII
  const writeAscii = (s: string, at: number) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i) & 0xff;
  };
  writeAscii(header, 0);
  writeAscii(text, textStart);

  // DATA — event-major, little-endian float32.
  const dv = new DataView(out.buffer);
  let off = beginData;
  for (let e = 0; e < nEvents; e++) {
    for (let c = 0; c < nPar; c++) {
      dv.setFloat32(off, columns[c][e], true);
      off += 4;
    }
  }
  return out;
}

/**
 * Export one population's events as an FCS file. Mirrors export_population_as_fcs for a
 * single sample: subset every stored channel's column by `mask` (event order preserved),
 * $PnN = original name, $PnS = display name.
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

  const columns: Float32Array[] = [];
  const channels: FcsExportChannel[] = [];
  sample.channels.forEach((ch, idx) => {
    const full = assay === "display"
      ? sample.displayColumn(idx)
      : assay === "compensated"
        ? sample.compensatedColumnData(idx)
        : sample.originalColumnData(idx);
    const sub = new Float32Array(keep.length);
    for (let k = 0; k < keep.length; k++) sub[k] = full[keep[k]];
    columns.push(sub);
    // $PnS = the Panel-tab display label (label ?? key), so channel renames reach the export.
    channels.push({ name: ch.pnn || ch.key, desc: sample.channelLabel(idx) });
  });

  return writeFcs(columns, channels);
}

/** Count set bits in an already length-validated mask. */
function maskCount(mask: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
  return c;
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
  let refChannels: FcsExportChannel[] | null = null;
  for (const { sample, mask } of samples) {
    if (maskCount(mask) === 0) continue;
    refKeys = sample.channels.map((ch) => ch.key);
    if (new Set(refKeys).size !== refKeys.length) {
      throw new Error("Cannot combine FCS export: the reference sample contains duplicate channel identifiers.");
    }
    // $PnS = Panel-tab display label so renames reach the combined export (see exportPopulationFcs).
    refChannels = sample.channels.map((ch, idx) => ({ name: ch.pnn || ch.key, desc: sample.channelLabel(idx) }));
    break;
  }

  if (!refKeys || !refChannels) {
    throw new Error("Cannot combine FCS export: the selected population contains no events in any sample.");
  }

  // One growing array of subset-column chunks per reference channel.
  const chunks: Float32Array[][] = refKeys.map(() => []);
  const refSet = new Set(refKeys);

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

    idxByRef.forEach((idx, r) => {
      const full = assay === "display"
        ? sample.displayColumn(idx!)
        : assay === "compensated"
          ? sample.compensatedColumnData(idx!)
          : sample.originalColumnData(idx!);
      const sub = new Float32Array(keep.length);
      for (let k = 0; k < keep.length; k++) sub[k] = full[keep[k]];
      chunks[r].push(sub);
    });
  }

  // Concatenate per-channel chunks into full columns.
  const columns: Float32Array[] = chunks.map((parts) => {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  });

  return writeFcs(columns, refChannels);
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
  return String(s ?? "").trim().replace(/[^A-Za-z0-9._-]/g, "_");
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
