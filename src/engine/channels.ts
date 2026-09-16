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
  if (fcs.channels.some((channel) => channel.appKey !== undefined)) {
    return uniqueChannelKeys(fcs.channels.map((channel) => ({
      key: channel.appKey?.trim() || channel.name,
      ...(channel.appLabel?.trim() &&
          channel.appLabel.trim() !== (channel.appKey?.trim() || channel.name)
        ? { label: channel.appLabel.trim() }
        : {}),
      pnn: channel.name,
      marker: channel.marker,
      columnIndex: channel.index,
      range: channel.range,
    })));
  }
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

/** $PnFEATURE values that are pulse measurements or timing, not features derived per event. */
const PULSE_FEATURES = new Set(["area", "height", "width", "time to peak", "time"]);

/** The per-event features a BD FACSDiscover S8 derives from its images, by the names it
 *  writes: "Size (FSC)", "Eccentricity (SSC (Imaging))", "Delta CoM (FSC/eGFP)", … */
const IMAGING_FEATURE_NAME =
  /^(Size|Max Intensity|Long Axis Moment|Short Axis Moment|Radial Moment|Center of Mass \([XY]\)|Total Intensity|Eccentricity|Diffusivity|Delta CoM|Correlation) \(/i;

/** An imaging feature: a measurement the instrument derived from the cell's image rather than
 *  read from a pulse, one per imaging channel (size, eccentricity, moments, intensities, centre
 *  of mass). $PnFEATURE settles it when the file carries the keyword: anything that is not a
 *  pulse or timing feature. Without the keyword, an export that kept the names and dropped the
 *  vendor keywords, the documented names decide. $PnS equals $PnN on these, so the unmixed
 *  marker rule never sees them, and their names start with the feature, not the channel. */
export function isImagingFeature(name: string, feature?: string): boolean {
  const f = (feature ?? "").trim().toLowerCase();
  if (f) return !PULSE_FEATURES.has(f);
  return IMAGING_FEATURE_NAME.test(name);
}

/** A raw spectral detector: not scatter, not imaging scatter, not an imaging feature, not
 *  QC/timing, and carrying no marker of its own. These are what the unmixed filter exists to
 *  drop. */
function isRawDetector(name: string, marker: string | null, feature?: string): boolean {
  const desc = (marker ?? "").trim();
  if (desc.length > 0 && desc !== name) return false;
  if (/^(FSC|SSC)/i.test(name)) return false;
  if (/^(LightLoss|Autofluorescence|Extinction)/i.test(name)) return false;
  if (isImagingFeature(name, feature)) return false;
  return !/^(Time|Event_length|Cell_length)$/i.test(name);
}

function filterFlowChannels(fcs: FcsFile): ResolvedChannel[] {
  // Detect spectral-unmixed: >= 2 channels whose $PnS differs from $PnN and ends "-A".
  const nUnmixed = fcs.channels.filter((c) => {
    const s = (c.marker ?? "").trim();
    return s.length > 0 && s !== c.name && endsWithA(s);
  }).length;
  if (nUnmixed < 2) return keepAll(fcs);

  // ...and raw detectors to drop, more than one of them. An unmixed file is defined by carrying
  // BOTH raw detectors and unmixed population channels; a file with no detectors at all is a
  // conventional analyser whose $PnS happens to end "-A", and filtering it discards real
  // data. The Xitogen XTG-1600 writes $PnN=FL1-A with $PnS=FITC-A on every conjugate, so
  // the marker test alone fired thirteen times and silently dropped 14 of its 32 channels
  // — every fluorescence height channel plus FSC-Width. One detector is not enough either:
  // a conventional file with a single unlabelled fluorescence channel was taken for a
  // spectral one, which dropped its height and width channels and changed every gate's
  // channel identity between files of one panel. A spectral file carries dozens.
  // See channels.test.ts. GateLabR's fcs_import.R applies the same rule.
  if (fcs.channels.filter((c) => isRawDetector(c.name, c.marker, c.feature)).length < 2) return keepAll(fcs);

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
    // Imaging features → keep under their own names. The S8 writes 33 of them for a three-
    // channel imaging set (11 features × LightLoss, FSC and SSC (Imaging)); they fell through
    // every rule above and were dropped with the detectors. See channels.test.ts.
    if (isImagingFeature(ch, c.feature)) {
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
