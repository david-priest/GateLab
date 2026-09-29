// flowjoOpen.ts — the small decisions the "Open FlowJo workspace" dialog makes about files.
//
// Pure, so they can be tested without the dialog: which of the files a user points at are worth
// holding, and which sample stands as the primary when every file gets its own hierarchy.

import { parseFcsDataSetFileName } from "./fcs";
import type { FlowJoFileResolution, FlowJoSampleSummary, FlowJoUnpairedFile } from "./flowjoWorkspace";
import { compareIdentity, describeContradiction, identityKeywords, sameFileName } from "./fileIdentity";

type Named = { name: string; keywords?: Readonly<Record<string, string>> | null };

/** A file filesToHold did not hold, and the file it was taken to be. */
export interface SkippedFile<T> {
  file: T;
  sameAs: Named;
  /** The file it was taken to be is already in the workspace, not only chosen. */
  open: boolean;
  /** Their keywords say they are one acquisition; otherwise nothing says they are two. */
  confirmed: boolean;
}

/**
 * The incoming files worth holding for the open: not already in the workspace (the dialog counts
 * a loaded file as found, and loading it again pooled a duplicate into the first hierarchy), and
 * not already held. Names are compared as file systems do, without case -- but a file of the same
 * name whose keywords record another acquisition is another file, and is held: Diva names files
 * Specimen_001_Tube_001.fcs in every experiment, and dropping the second experiment's as "already
 * open" left the dialog pairing the first experiment's file with the second's workspace. A file
 * whose data sets are open as samples of their own ("plate (data set 2 of 4, A02).fcs") is in the
 * workspace too.
 */
export function filesToHold<T extends Named>(
  held: readonly Named[],
  loaded: readonly (string | Named)[],
  incoming: readonly T[],
  /**
   * Filled with each incoming file not held, and the file it was taken to be: `open` when that
   * file is already in the workspace, `confirmed` when their keywords say they are one acquisition.
   * Such a file was dropped without a word, neither loaded nor named.
   */
  skipped?: SkippedFile<T>[],
): T[] {
  // A data set open as a sample stands for its file too. The file's own keywords, as a file is
  // read before it is loaded (readFcsKeywords), are its first data set's; another data set's
  // keywords say nothing about the file, so that entry carries none and the plate is not
  // loaded a second time.
  const open: Named[] = loaded.flatMap((f): Named[] => {
    const named: Named = typeof f === "string" ? { name: f } : f;
    const set = parseFcsDataSetFileName(named.name);
    return set ? [named, { name: set.fileName, keywords: set.index === 0 ? named.keywords ?? null : null }] : [named];
  });
  const taken: Named[] = [...held, ...open];
  const verdict = (a: Named, b: Named) => compareIdentity(identityKeywords(a.keywords), identityKeywords(b.keywords)).verdict;
  const same = (a: Named, b: Named) => a.name.toLowerCase() === b.name.toLowerCase() && verdict(a, b) !== "contradicted";
  const out: T[] = [];
  for (const file of incoming) {
    const as = taken.find((t) => same(t, file));
    if (as) {
      skipped?.push({ file, sameAs: as, open: open.includes(as), confirmed: verdict(as, file) === "confirmed" });
      continue;
    }
    taken.push(file);
    out.push(file);
  }
  return out;
}

/** What a dialog or a result can say of a file to tell it from another of the same name. */
export interface DescribedFile {
  key: string;
  name: string;
  /** Where it was chosen from, when that is known. */
  path?: string | null;
  keywords?: Readonly<Record<string, string>> | null;
  /** Its event count, when it has been read; else its $TOT is used. */
  events?: number | null;
}

/** The words of a file's description, so a dialog can say them in its own language. */
export interface FileDistinctionWords {
  events: string;
  recorded: (when: string) => string;
  file: (position: number) => string;
}

const ENGLISH_DISTINCTION: FileDistinctionWords = {
  events: "events",
  recorded: (when) => `recorded ${when}`,
  file: (position) => `file ${position}`,
};

/** Where a file is, how many events it holds and when it was recorded, as far as that is known. */
export function fileDistinction(f: Omit<DescribedFile, "key">, words: FileDistinctionWords = ENGLISH_DISTINCTION): string {
  const keyword = (key: string) =>
    Object.entries(f.keywords ?? {}).find(([k]) => k.trim().toUpperCase() === key)?.[1]?.trim() ?? "";
  const tot = keyword("$TOT");
  const events = f.events ?? (/^\d+$/.test(tot) ? Number(tot) : null);
  const when = [keyword("$DATE"), keyword("$BTIM")].filter(Boolean).join(" ");
  return [
    f.path && f.path !== f.name ? f.path : "",
    events !== null ? `${events.toLocaleString("en-US")} ${words.events}` : "",
    when ? words.recorded(when) : "",
  ].filter(Boolean).join(" · ");
}

/**
 * Each file's name as a list holding it should say it, by key: the name alone, or, where another
 * file of the list shares it, with where it is, its event count and when it was recorded -- and a
 * number, where even those are the same. Two files of one name read identically in the question
 * that asked which was a sample, in its row and in the result, and the choice between them was
 * blind.
 */
export function distinctFileNames(
  files: readonly DescribedFile[],
  words: FileDistinctionWords = ENGLISH_DISTINCTION,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    const same = files.filter((o) => sameFileName(o.name, f.name));
    if (same.length < 2) {
      out.set(f.key, f.name);
      continue;
    }
    const detail = fileDistinction(f, words);
    const clash = same.filter((o) => fileDistinction(o, words) === detail).length > 1;
    out.set(f.key, `${f.name} (${[detail, clash ? words.file(same.indexOf(f) + 1) : ""].filter(Boolean).join(" · ")})`);
  }
  return out;
}

/** A sample whose file the dialog paired with it: by its keywords, or by the user's choice. */
export function isPaired(r: FlowJoFileResolution | undefined): r is FlowJoFileResolution & { fileKey: string; fileName: string } {
  return !!r && r.fileKey !== null && r.fileName !== null && (r.status === "own" || r.status === "chosen");
}

/**
 * The sample whose strategy is imported first under "one hierarchy per file": the selected one,
 * when its FCS was paired with it. It used to fall back to the first sample whose file was found,
 * which overrode the user's own choice of row and imported another sample's tree -- at the tree
 * position chosen from the selected sample's list.
 */
export function perFilePrimary(
  samples: readonly FlowJoSampleSummary[],
  resolutions: readonly FlowJoFileResolution[],
  strategySample: number | null,
): FlowJoSampleSummary | undefined {
  const selected = samples.find((x) => x.index === strategySample);
  return selected && isPaired(resolutions.find((r) => r.sampleIndex === selected.index)) ? selected : undefined;
}

/**
 * Whether an open imports one hierarchy per file: asked for, and more than one gated sample's FCS
 * paired. With one there is nothing to be per-file about, and the chosen sample's tree is
 * imported alone -- which is when the dialog asks which of its trees.
 */
export function perFileImportApplies(
  perFileTrees: boolean,
  gated: readonly FlowJoSampleSummary[],
  resolutions: readonly FlowJoFileResolution[],
): boolean {
  if (!perFileTrees) return false;
  const indices = new Set(gated.map((s) => s.index));
  return resolutions.filter((r) => isPaired(r) && indices.has(r.sampleIndex)).length > 1;
}

/** A tree chosen in the open dialog, bound to the sample it was chosen from. */
export interface ChosenTree {
  sampleIndex: number;
  treeIndex: number;
}

/**
 * The top-level tree an open imports from its sample: the one chosen FROM THIS SAMPLE, else the
 * one with the most gates the importer can read, the first of those tied. The first readable tree
 * was the default, and a small tree of bead gates written before the analysis was imported unless
 * the user found the choice (FR-FCM-Z6L9: "beads", 2 gates, over "Lymphocytes", 23). A position
 * chosen from one sample's list is never applied to another sample's trees --
 * it once imported "D2_monocytes" for a user who had chosen "D1_beads". A workspace holds one
 * tree, so this is never "all of them"; the others are named in the result. Null under a per-file
 * import, which takes each file's trees together, as one tree.
 */
export function openTreeIndex(
  sample: FlowJoSampleSummary,
  chosen: ChosenTree | null,
  perFile: boolean,
): number | null {
  if (perFile) return null;
  // A tree with no gate the importer can read is not offered, and is never the default: it could
  // only fail, once, before the retry picker disabled it.
  const readable = sample.trees.filter((t) => t.gateCount > 0);
  if (chosen && chosen.sampleIndex === sample.index && readable.some((t) => t.index === chosen.treeIndex)) return chosen.treeIndex;
  const largest = readable.reduce<(typeof readable)[number] | undefined>((best, t) => (!best || t.gateCount > best.gateCount ? t : best), undefined);
  return (largest ?? sample.trees[0])?.index ?? null;
}

/**
 * The sample the open dialog selects before the user chooses one: the one the viewed file IS,
 * else the one the first file chosen for the open is, else the one any other loaded file is.
 * A workspace of one gated sample selects it. Otherwise nothing is selected: the sample with the
 * most gates, the old default, was often not the loaded file's, and its tree list was shown for a
 * file it would not be imported onto.
 */
export function defaultStrategySample(
  samples: readonly FlowJoSampleSummary[],
  resolutions: readonly FlowJoFileResolution[],
  preferredFileKeys: readonly string[],
): number | null {
  const gated = new Set(samples.map((s) => s.index));
  for (const key of preferredFileKeys) {
    const r = resolutions.find((q) => isPaired(q) && q.fileKey === key && gated.has(q.sampleIndex));
    if (r) return r.sampleIndex;
  }
  if (samples.length === 1) return samples[0].index;
  // A data set open already that a gated sample could be, where nothing says which
  // (FlowJoFileResolution.tiedWith): that sample is selected, and the open asks which sample the
  // data set is before importing anything.
  const tied = resolutions.find((q) => gated.has(q.sampleIndex) && q.tiedWith?.length);
  return tied ? tied.sampleIndex : null;
}

/** What the open dialog holds that decides what is imported. */
export interface FlowJoOpenChoice {
  /** The gated samples. */
  samples: readonly FlowJoSampleSummary[];
  strategySample: number | null;
  /** Whether the user has chosen a row; until then the selection follows the files. */
  strategyTouched: boolean;
  strategyTree: ChosenTree | null;
  perFileTrees: boolean;
  /** The user's explicit choice to apply a sample's tree to a file that is not that sample. */
  crossFile: { sampleIndex: number; fileKey: string } | null;
}

export interface FlowJoOpenPlan {
  /** The sample whose trees are listed, whose matrix is compared, and whose tree is imported. */
  sample: FlowJoSampleSummary | undefined;
  /** That sample's pairing. */
  resolution: FlowJoFileResolution | undefined;
  /** The file its tree goes onto: its own, or one the user chose (cross). Null: none yet. */
  target: { fileKey: string; fileName: string; cross: boolean } | null;
  treeIndex: number | null;
  perFile: boolean;
  /** Under a per-file import, every file with the sample it is, the target first. */
  pairs: { sample: FlowJoSampleSummary; fileKey: string; fileName: string }[];
}

/**
 * Everything the open dialog shows and imports, from one place: the tree list, the compensation
 * note and the import all read the same sample, so the trees listed are the trees imported. They
 * used to read different ones -- the list the radio row's, the import perFilePrimary's.
 */
export function plannedFlowJoOpen(
  choice: FlowJoOpenChoice,
  resolutions: readonly FlowJoFileResolution[],
  files: readonly { key: string; name: string }[],
  preferredFileKeys: readonly string[],
): FlowJoOpenPlan {
  const index = choice.strategyTouched
    ? choice.strategySample
    : defaultStrategySample(choice.samples, resolutions, preferredFileKeys);
  const sample = choice.samples.find((x) => x.index === index);
  const resolution = sample ? resolutions.find((r) => r.sampleIndex === sample.index) : undefined;
  let target: FlowJoOpenPlan["target"] = null;
  if (isPaired(resolution)) {
    target = { fileKey: resolution.fileKey, fileName: resolution.fileName, cross: false };
  } else if (sample && choice.crossFile && choice.crossFile.sampleIndex === sample.index) {
    const file = files.find((f) => f.key === choice.crossFile!.fileKey);
    if (file) target = { fileKey: file.key, fileName: file.name, cross: true };
  }
  const gated = new Set(choice.samples.map((s) => s.index));
  // Every file of a paired sample: the file, and any copies of it (one acquisition twice).
  const filesOf = (r: FlowJoFileResolution) => [
    { fileKey: r.fileKey!, fileName: r.fileName! },
    ...(r.copies ?? []),
  ];
  const others = !sample || !target ? [] : resolutions
    .filter((r) => isPaired(r) && gated.has(r.sampleIndex) && r.sampleIndex !== sample.index)
    .flatMap((r) => filesOf(r).filter((f) => f.fileKey !== target!.fileKey)
      .map((f) => ({ sample: choice.samples.find((x) => x.index === r.sampleIndex)!, ...f })));
  // Copies of the chosen sample's own file get its tree as theirs; they alone make nothing per file.
  const ownCopies = sample && target && !target.cross && isPaired(resolution)
    ? (resolution.copies ?? []).filter((f) => f.fileKey !== target!.fileKey).map((f) => ({ sample, ...f }))
    : [];
  const perFile = choice.perFileTrees && !!sample && !!target && others.length > 0;
  return {
    sample,
    resolution,
    target,
    treeIndex: sample ? openTreeIndex(sample, choice.strategyTree, perFile) : null,
    perFile,
    pairs: perFile && sample && target ? [{ sample, fileKey: target.fileKey, fileName: target.fileName }, ...ownCopies, ...others] : [],
  };
}

/**
 * Names for a result line: every one when there are few, else the first few and how many more.
 * A sample can hold dozens of trees -- 71 on FR-FCM-Z2TL -- and naming every one that was not
 * imported ran the line to over two thousand characters. A long name is shortened.
 */
export function namesInBrief(names: readonly string[], max = 6, longest = 48): string {
  const quoted = names.map((n) => `"${n.length > longest ? `${n.slice(0, longest - 1)}…` : n}"`);
  if (quoted.length <= max) return quoted.join(", ");
  const shown = max - 1;
  return `${quoted.slice(0, shown).join(", ")} and ${quoted.length - shown} more`;
}

/**
 * A failure reason short enough to repeat in a dialog that must stay on screen: its lines run
 * together, cut at a separator before `max` characters. A Gating-ML refusal names every gate on a
 * channel the file lacks, and repeated in full in the tree picker it ran past 4,000 characters and
 * pushed the trees and Cancel off screen. The full reason is offered folded, beneath it.
 */
export function briefReason(why: string, max = 200): string {
  const flat = flatReason(why);
  if (flat.length <= max) return flat;
  const head = flat.slice(0, max);
  const cut = Math.max(...[", ", "; ", ". ", ": ", " - "].map((sep) => head.lastIndexOf(sep)));
  return `${(cut > max / 2 ? head.slice(0, cut + 1) : head).trimEnd()} …`;
}

/** A reason on one line, as briefReason says it: a reason written over several lines is not cut. */
function flatReason(why: string): string {
  return why.split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
}

/**
 * Whether briefReason left something out. Compared with the reason as written, a reason written
 * over several lines -- a Gating-ML refusal lists a gate per line -- read as cut when nothing was,
 * and the picker offered its "full reason" for every multi-line one.
 */
export function reasonWasCut(why: string, max = 200): boolean {
  return briefReason(why, max) !== flatReason(why);
}

/**
 * Why a file the import holds is paired with no gated sample, for the result line: another
 * acquisition, several samples it could be, or none named like it.
 */
export function describeUnpaired(
  u: FlowJoUnpairedFile,
  label: (sampleIndex: number) => string,
  /** A file named as the result names it, told from another of the same name (distinctFileNames). */
  called: (fileKey: string, fileName: string) => string = (_key, name) => name,
): string {
  if (u.why === "contradicted") {
    return u.differ.length && u.candidates.length === 1
      ? describeContradiction(label(u.candidates[0]), u.differ, "the file")
      : `the ${u.candidates.length} samples named like it record other acquisitions`;
  }
  if (u.why === "ambiguous") {
    if (u.candidates.length > 1) return `${u.candidates.length} samples could be it, and none was chosen`;
    // One sample, and other files that could be it: the file that is it, or the files that could each be.
    const rivals = (u.rivals ?? []).map((name, i) => called(u.rivalKeys?.[i] ?? "", name)).join(", ");
    if (u.pairedWith) return `${called(u.pairedWithKey ?? "", u.pairedWith)} is ${label(u.candidates[0])}`;
    // A copy goes with its file: the choice was between that file and the others.
    if (u.copyOf) {
      const of = called(u.copyOfKey ?? "", u.copyOf);
      return `it is a copy of ${of}; ${of} and ${rivals} could each be ${label(u.candidates[0])}, and none was chosen`;
    }
    if (u.rivals?.length) return `it and ${rivals} could each be ${label(u.candidates[0])}, and none was chosen`;
    return `another file could be ${label(u.candidates[0])}, and none was chosen`;
  }
  return "no sample is named like it";
}

/**
 * The files of a folder worth holding for an open: every one named like a sample of the
 * workspace, and every other whose $FIL is -- a file renamed on disk keeps the $FIL it was
 * recorded as, and the pairing finds its sample by it. Only names used to be kept, so such a file
 * was never held from a folder ("0/23 found"), though choosing it by hand paired it. Each kept
 * file comes with its TEXT keywords, which the pairing needs anyway.
 */
export async function workspaceFilesInFolder<F extends { name: string; file: Blob }>(
  samples: readonly FlowJoSampleSummary[],
  files: readonly F[],
  readKeywords: (file: Blob) => Promise<Record<string, string> | null>,
): Promise<(F & { keywords: Record<string, string> | null })[]> {
  const names = samples.flatMap((sample) => sample.candidateFileNames);
  const namedLike = (name: string) => names.some((n) => sameFileName(n, name));
  const out: (F & { keywords: Record<string, string> | null })[] = [];
  for (const f of files) {
    if (!/\.fcs$/i.test(f.name)) continue;
    const byName = namedLike(f.name);
    const keywords = await readKeywords(f.file);
    const fil = Object.entries(keywords ?? {}).find(([k]) => k.trim().toUpperCase() === "$FIL")?.[1]?.trim();
    if (byName || (fil && namedLike(fil))) out.push({ ...f, keywords });
  }
  return out;
}

/** A UI translator, as useI18n().t; the default fills the English template's {placeholders}. */
export type NoteTranslator = (source: string, values?: Readonly<Record<string, string | number>>) => string;

const english: NoteTranslator = (source, values = {}) =>
  source.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);

/** The note for one data set left unpaired on a count shared, or possibly shared (tiedDataSetsNote). */
export const TIED_DATA_SET_NOTE =
  "{name} was not paired with a workspace sample: it holds {events} events, a count another data set or " +
  "workspace sample shares or may share, and no $WELLID or $SMNO says which sample it is. It gets the " +
  "imported tree as drawn, without its sample's own coordinates; import gating onto it to choose its sample.";
/** The note for several (tiedDataSetsNote). */
export const TIED_DATA_SETS_NOTE =
  "{names} were not paired with a workspace sample: each holds {events} events, a count another data set " +
  "or workspace sample shares or may share, and no $WELLID or $SMNO says which sample each is. They get " +
  "the imported tree as drawn, without their samples' own coordinates; import gating onto each to choose " +
  "its sample.";

/**
 * A note naming the data sets left unpaired because only an event count another data set or
 * workspace sample shares, or may share, could say which sample each is
 * (FlowJoFileResolution.tiedWith), or null when there are none. They are not left ungated: they
 * get the imported tree as drawn, which is what the note says.
 */
export function tiedDataSetsNote(
  resolutions: readonly FlowJoFileResolution[],
  events: ReadonlyMap<string, number>,
  t: NoteTranslator = english,
): string | null {
  const names = [...new Set(resolutions.flatMap((r) => r.tiedWith ?? []))];
  if (!names.length) return null;
  const counts = [...new Set(names.map((n) => events.get(n)).filter((n) => n !== undefined))]
    .sort((a, b) => a - b).map((n) => n.toLocaleString("en-US"));
  const eventsText = counts.length > 1
    ? t("{items} or {last}", { items: counts.slice(0, -1).join(", "), last: counts[counts.length - 1] })
    : counts[0] ?? "?";
  if (names.length === 1) return t(TIED_DATA_SET_NOTE, { name: names[0], events: eventsText });
  const list = t("{items} and {last}", { items: names.slice(0, -1).join(", "), last: names[names.length - 1] });
  return t(TIED_DATA_SETS_NOTE, { names: list, events: eventsText });
}
