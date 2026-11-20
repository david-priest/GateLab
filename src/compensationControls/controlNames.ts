// controlNames.ts — what a control file's name says about it.
//
// Reads the file name and the names the file carries for itself (TUBE NAME, $SMNO, $SRC): whether
// it is the unstained control, which channel it is the control for, and whether it is beads or
// cells. A name is the user's intent, so where it names one channel it decides the assignment and
// the signal is used to confirm it (controlDetection.ts).
//
// Matching is on runs of letters and digits, so "PE-Cy7", "PE Cy7", "PE_Cy7" and "PECy7" are one
// name, and a name inside a longer one is not counted: "PE-Cy7 Stained Control" is PE-Cy7, not PE.

import type { ControlChannel, ControlFile } from "./controlFile";

/** Lower-case runs of letters and digits. */
export function nameTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function fileTokens(file: Pick<ControlFile, "fileName" | "labels">): string[][] {
  const stem = file.fileName.replace(/\.(fcs|lmd)$/i, "");
  return [stem, ...file.labels].map(nameTokens).filter((tokens) => tokens.length > 0);
}

const UNSTAINED = [
  ["unstained"], ["unstain"], ["unlabelled"], ["unlabeled"], ["nostain"], ["no", "stain"],
  ["non", "stained"], ["nonstained"], ["blank"], ["autofluorescence"], ["cells", "only"],
  ["beads", "only"], ["negative", "control"], ["neg", "ctrl"], ["neg", "control"],
];

function hasRun(tokens: readonly string[], run: readonly string[]): boolean {
  for (let start = 0; start + run.length <= tokens.length; start++) {
    if (run.every((token, offset) => tokens[start + offset] === token)) return true;
  }
  return false;
}

/** True where a name of the file says it is the unstained (or negative) control. */
export function namedUnstained(file: Pick<ControlFile, "fileName" | "labels">): boolean {
  return fileTokens(file).some((tokens) => UNSTAINED.some((run) => hasRun(tokens, run)));
}

const FMO = [["fmo"], ["minus", "one"]];

/**
 * True where a name of the file says it is a fluorescence-minus-one control: every stain of the
 * panel but one. The channel left out is the one the name gives (namedChannel): "FMO PE", "PE FMO",
 * "PE fluorescence minus one".
 */
export function namedFmo(file: Pick<ControlFile, "fileName" | "labels">): boolean {
  return fileTokens(file).some((tokens) => FMO.some((run) => hasRun(tokens, run)));
}

const BEAD_TOKEN = /^(beads?|compbeads?|ultracomp|versacomp|onecomp|microspheres?)$/;
const CELL_TOKEN = /^(cells?|pbmcs?|splenocytes?|lymphocytes?|thymocytes?)$/;

/** Beads or cells, where a name of the file says so; null where no name does, or names say both. */
export function namedParticle(file: Pick<ControlFile, "fileName" | "labels">): "beads" | "cells" | null {
  const tokens = fileTokens(file).flat();
  const beads = tokens.some((token) => BEAD_TOKEN.test(token));
  const cells = tokens.some((token) => CELL_TOKEN.test(token));
  if (beads === cells) return null;
  return beads ? "beads" : "cells";
}

const withoutPulse = (name: string): string => name.replace(/-(A|H|W)$/i, "");
const joinedName = (name: string): string => nameTokens(withoutPulse(name)).join("");

/** A channel's detector or fluorochrome name ($PnN without the pulse suffix), joined. */
function detectorNames(channel: ControlChannel): string[] {
  return [joinedName(channel.pnn)].filter((name) => name.length >= 2);
}

/** A channel's marker names ($PnS, and the key, which is the marker where the file gives one), joined. */
function markerNames(channel: ControlChannel): string[] {
  return [...new Set([joinedName(channel.key), joinedName(channel.marker ?? "")])].filter((name) => name.length >= 2);
}

export interface NamedChannel {
  /** The one channel the name gives, by $PnN; null where it gives none or cannot choose between several. */
  readonly channel: string | null;
  /** Every channel the names give: more than one is a tie. */
  readonly candidates: readonly string[];
}

/**
 * The channel a file's names give. A channel is found where one of its names, joined to letters
 * and digits, equals a run of the file name's tokens joined the same way. A name found inside a
 * longer one that was also found is dropped (PE in PE-Cy7); where more than one channel is then
 * left, the name decides nothing.
 *
 * Detector names ($PnN: "FITC-A", "PE-Cy7-A") are tried first and markers ($PnS) only where no
 * detector name is found: control files often carry the whole panel's markers, so "CD45RA FITC"
 * would otherwise be given to whichever channel the panel assigns CD45RA.
 */
export function namedChannel(
  file: Pick<ControlFile, "fileName" | "labels">,
  channels: readonly ControlChannel[],
): NamedChannel {
  const runs = new Set<string>();
  for (const tokens of fileTokens(file)) {
    for (let start = 0; start < tokens.length; start++) {
      let joined = "";
      for (let end = start; end < tokens.length; end++) {
        joined += tokens[end];
        runs.add(joined);
      }
    }
  }
  for (const namesOf of [detectorNames, markerNames]) {
    const found: Array<{ key: string; name: string }> = [];
    for (const channel of channels) {
      const names = namesOf(channel).filter((name) => runs.has(name)).sort((x, y) => y.length - x.length);
      if (names.length > 0) found.push({ key: channel.pnn, name: names[0] });
    }
    // A name inside a longer name that was also found is that longer name read short: PE in PE-Cy7.
    const candidates = found
      .filter(({ name }) => !found.some((other) => other.name.length > name.length && other.name.includes(name)))
      .map(({ key }) => key);
    if (candidates.length > 0) return { channel: candidates.length === 1 ? candidates[0] : null, candidates };
  }
  return { channel: null, candidates: [] };
}
