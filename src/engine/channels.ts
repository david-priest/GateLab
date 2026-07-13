// channels.ts — resolve which channels to expose and their display names.
// Ported 1:1 from GateLabR fcs_import.R filter_flow_channels().
//
// Spectral-unmixed flow files (BD S8, Cytek, …) carry hundreds of raw detector
// channels alongside a handful of UNMIXED population channels (whose $PnS is an
// antibody marker ending in "-A"). GateLabR keeps only scatter, LightLoss,
// Autofluorescence, the unmixed markers, and Time/Event_length — dropping every
// raw spectral detector. Conventional flow (no unmixed channels) keeps everything.

import type { FcsFile } from "./fcs";

export interface ResolvedChannel {
  /** App-wide IDENTITY: gate channel id, byName lookups, compensation, transforms.
   *  Never changes once resolved (renaming sets `label` instead — see Panel tab). */
  key: string;
  /** User-facing display name (Panel tab). Falls back to `key` when unset. Cosmetic only —
   *  gates/masks/workspace all key off `key`, so a rename can never break identity. */
  label?: string;
  /** Original $PnN (kept for Gating-ML export / compensation lookup). */
  pnn: string;
  /** $PnS marker, if any. */
  marker: string | null;
  /** Index into fcs.columns for the raw values. */
  columnIndex: number;
  range: number;
}

const endsWithA = (s: string): boolean => /-A$/i.test(s);
const suffixAHW = (s: string): boolean => /-(A|H|W)$/i.test(s);

export function resolveChannels(fcs: FcsFile): ResolvedChannel[] {
  if (fcs.instrument !== "flow") {
    // CyTOF / other: keep all channels; prefer the marker when it's distinct.
    return fcs.channels.map((c) => ({
      key: c.marker && c.marker.trim() && c.marker.trim() !== c.name ? c.marker.trim() : c.name,
      pnn: c.name,
      marker: c.marker,
      columnIndex: c.index,
      range: c.range,
    }));
  }
  return filterFlowChannels(fcs);
}

function keepAll(fcs: FcsFile): ResolvedChannel[] {
  // Conventional flow → keep all; display = $PnS if present, else $PnN.
  return fcs.channels.map((c) => ({
    key: c.marker && c.marker.trim() ? c.marker.trim() : c.name,
    pnn: c.name,
    marker: c.marker,
    columnIndex: c.index,
    range: c.range,
  }));
}

function filterFlowChannels(fcs: FcsFile): ResolvedChannel[] {
  // Detect spectral-unmixed: >= 2 channels whose $PnS differs from $PnN and ends "-A".
  const nUnmixed = fcs.channels.filter((c) => {
    const s = (c.marker ?? "").trim();
    return s.length > 0 && s !== c.name && endsWithA(s);
  }).length;
  if (nUnmixed < 2) return keepAll(fcs);

  const kept: ResolvedChannel[] = [];
  for (const c of fcs.channels) {
    const ch = c.name;
    const desc = (c.marker ?? "").trim();
    const cu = ch.toUpperCase();
    const base = { pnn: ch, marker: c.marker, columnIndex: c.index, range: c.range };

    // Scatter (FSC/SSC) with -A/-H/-W suffix → keep, display = $PnN.
    if (/^(FSC|SSC)/.test(cu)) {
      if (suffixAHW(ch)) kept.push({ key: ch, ...base });
      continue;
    }
    // LightLoss imaging scatter → keep -A/-H/-W variants.
    if (/^LightLoss/i.test(ch) && suffixAHW(ch)) {
      kept.push({ key: ch, ...base });
      continue;
    }
    // Autofluorescence-A → keep.
    if (/^Autofluorescence/i.test(ch) && suffixAHW(ch)) {
      kept.push({ key: ch, ...base });
      continue;
    }
    // Unmixed fluorophore channels: $PnS != $PnN and ends "-A" → "{$PnS} ({$PnN})".
    if (desc.length > 0 && desc !== ch && endsWithA(desc)) {
      kept.push({ key: `${desc} (${ch})`, ...base });
      continue;
    }
    // QC/timing kept.
    if (/^(Time|Event_length|Cell_length)$/i.test(ch)) {
      kept.push({ key: ch, ...base });
      continue;
    }
    // else: raw spectral detector / generic QC → dropped.
  }

  return kept.length === 0 ? keepAll(fcs) : kept;
}
