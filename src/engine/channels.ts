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

/**
 * FCS permits a descriptive $PnS marker that is not the parameter identity.
 * Repeated markers must therefore not become repeated app keys: channel maps,
 * gates, compensation, and exports all require a one-to-one identity. Use $PnN
 * only when needed to disambiguate, then suffix malformed repeated $PnN values.
 */
function uniqueChannelKeys(channels: ResolvedChannel[]): ResolvedChannel[] {
  const counts = new Map<string, number>();
  for (const channel of channels) counts.set(channel.key, (counts.get(channel.key) ?? 0) + 1);

  const withParameterNames = channels.map((channel) => {
    if ((counts.get(channel.key) ?? 0) < 2 || channel.pnn === channel.key) return channel;
    return { ...channel, key: `${channel.key} (${channel.pnn})` };
  });

  const used = new Set<string>();
  return withParameterNames.map((channel) => {
    const base = channel.key;
    let key = base;
    let suffix = 2;
    while (used.has(key)) key = `${base} [${suffix++}]`;
    used.add(key);
    return key === channel.key ? channel : { ...channel, key };
  });
}

const endsWithA = (s: string): boolean => /-A$/i.test(s);
const suffixAHW = (s: string): boolean => /-(A|H|W)$/i.test(s);

export function resolveChannels(fcs: FcsFile): ResolvedChannel[] {
  if (fcs.instrument !== "flow") {
    // CyTOF / other: keep all channels; prefer the marker when it's distinct.
    return uniqueChannelKeys(fcs.channels.map((c) => ({
      key: c.marker && c.marker.trim() && c.marker.trim() !== c.name ? c.marker.trim() : c.name,
      pnn: c.name,
      marker: c.marker,
      columnIndex: c.index,
      range: c.range,
    })));
  }
  return uniqueChannelKeys(filterFlowChannels(fcs));
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
