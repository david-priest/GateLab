/**
 * BD FACSChorus statistics export, and how well an imported tree reproduces it.
 *
 * Chorus (the FACSDiscover S8's software) exports a `<experiment>_Statistics.csv`: a header
 * block (experiment, cytometer, export date), then one block per recording with a
 * `Population,Events,Percent Parent,Percent Total,…` table under the gates current at export.
 * The `.cef` experiment file holds no per-recording counts, so this export is the only record
 * of what Chorus itself counted, and the only way to check an import against the instrument.
 *
 * The comparison pairs each loaded file with the recording of the same name and each population
 * of the file's tree with Chorus's row of the same name, in tree order, and says WHY a count may
 * differ: a gate on linear axes is exact, a gate on Chorus's biexponential axes is straight in
 * Chorus's display but straight in raw here (chorusExperiment.ts), and a population beneath such
 * a gate inherits its parent's difference. Everything else — populations one side lacks,
 * Chorus's automatic saturation gates, a tree that did not come from a Chorus import — is named
 * as such rather than left as an unexplained number.
 */

export interface ChorusStatisticsPopulation {
  name: string;
  events: number;
  /** null where Chorus wrote NaN (All Events has no parent). */
  percentParent: number | null;
  percentTotal: number | null;
}

export interface ChorusStatisticsRecording {
  name: string;
  id: string | null;
  populations: ChorusStatisticsPopulation[];
}

export interface ChorusStatistics {
  experimentName: string | null;
  experimentId: string | null;
  cytometer: string | null;
  /** As written ("25/02/2026 22:25:08"): Chorus formats it in the instrument PC's locale. */
  exportedAt: string | null;
  recordings: ChorusStatisticsRecording[];
}

/** One field per cell, quotes honoured; a Chorus population name may hold a comma. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function lines(text: string): string[][] {
  return text.replace(/^﻿/, "").split(/\r\n|\r|\n/).map(splitCsvLine);
}

/** The header block and at least one recording with a population table. */
export function isChorusStatisticsFile(text: string): boolean {
  const head = text.slice(0, 4000);
  return /^﻿?Experiment Name,/.test(head) && /(^|\r|\n)Recording Name,/.test(text) && /(^|\r|\n)Population,Events,/.test(text);
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const v = Number(s.trim());
  return Number.isFinite(v) ? v : null;
}

export function parseChorusStatistics(text: string): ChorusStatistics {
  if (!isChorusStatisticsFile(text)) {
    throw new Error("This is not a FACSChorus statistics export: expected an Experiment Name line, Recording Name blocks and Population tables.");
  }
  const rows = lines(text);
  const stats: ChorusStatistics = { experimentName: null, experimentId: null, cytometer: null, exportedAt: null, recordings: [] };
  let recording: ChorusStatisticsRecording | null = null;
  let columns: string[] | null = null;
  for (const row of rows) {
    const key = (row[0] ?? "").trim();
    if (!key) { columns = null; continue; }
    if (columns && recording) {
      const events = num(row[columns.indexOf("Events")]);
      if (events === null) { columns = null; continue; }
      recording.populations.push({
        name: key,
        events,
        percentParent: num(row[columns.indexOf("Percent Parent")]),
        percentTotal: num(row[columns.indexOf("Percent Total")]),
      });
      continue;
    }
    switch (key) {
      case "Experiment Name": stats.experimentName = row[1]?.trim() || null; break;
      case "Experiment Id": stats.experimentId = row[1]?.trim() || null; break;
      case "Cytometer Name": stats.cytometer = row[1]?.trim() || null; break;
      case "Export Date": stats.exportedAt = row[1]?.trim() || null; break;
      case "Recording Name":
        recording = { name: row[1]?.trim() ?? "", id: null, populations: [] };
        stats.recordings.push(recording);
        break;
      case "Recording Id": if (recording) recording.id = row[1]?.trim() || null; break;
      case "Population":
        if (recording && row.includes("Events")) columns = row.map((c) => c.trim());
        break;
      default: break;
    }
  }
  if (!stats.recordings.some((r) => r.populations.length)) {
    throw new Error("This FACSChorus statistics export holds no population table.");
  }
  return stats;
}

// ── The comparison ──────────────────────────────────────────────────────────────────────────

/** What chorusToGatingML did with one gate, kept so a count difference can be explained. */
export interface ChorusGateReport {
  /** The population name as imported (qualified with its parent where a name recurred). */
  name: string;
  kind: string;
  axes: Array<{ name: string; scale: string }>;
  /** Straight in raw here while Chorus evaluates it straight in its biexponential or log display. */
  approximated: boolean;
  /**
   * The gate's geometry is not the current gates' (the tree is a sort's snapshot or a recording's,
   * and the gate moved afterwards); Chorus's statistics are counted under the current gates.
   * Unset when no current gates were available to compare with.
   */
  differsFromCurrent?: boolean;
}

/** The Chorus import a tree came from, as far as the comparison needs it. */
export interface ChorusImportRecord {
  experimentName: string;
  treeLabel: string;
  /** The live gates, a sort's snapshot of them, or the tree a recording was made under. */
  kind: "current" | "sort" | "recording";
  /** For a sort's snapshot: when it started; for a recording: when it was made. As Chorus wrote it (UTC, no zone). */
  sortedAt: string | null;
  gates: ChorusGateReport[];
}

/** One population of a loaded file's tree, with GateLab's count on that file. */
export interface FilePopulationCount {
  name: string;
  depth: number;
  parentName: string | null;
  events: number;
  percentParent: number | null;
}

export interface FileCounts {
  fileName: string;
  /** The hierarchy the file is counted under, for the report. */
  hierarchyName: string;
  events: number;
  populations: FilePopulationCount[];
}

export type ComparisonReason =
  /** Linear axes all the way up: Chorus and GateLab evaluate the same test. */
  | { kind: "exact" }
  /** The gate moved after this tree was taken; the export was counted under the current gates. */
  | { kind: "moved" }
  /** The gate's own axes are biexponential or log in Chorus. */
  | { kind: "biexponential"; axes: string[] }
  /** The gate is linear but sits beneath one that is not. */
  | { kind: "inherited"; from: string }
  /** Chorus's automatic saturation filter, which GateLab does not apply. */
  | { kind: "automatic" }
  /** In the statistics export but not in the file's tree. */
  | { kind: "chorus-only" }
  /** In the file's tree but not in the statistics export. */
  | { kind: "gatelab-only" }
  /** The tree's population has no gate of that name in the Chorus import, so nothing is known about its axes. */
  | { kind: "unknown" };

export interface ComparedPopulation {
  name: string;
  depth: number;
  chorusEvents: number | null;
  gatelabEvents: number | null;
  chorusPercentParent: number | null;
  gatelabPercentParent: number | null;
  /** GateLab − Chorus, when both counted. */
  delta: number | null;
  /** delta as a fraction of Chorus's count, when Chorus counted something. */
  relative: number | null;
  reason: ComparisonReason;
}

export interface RecordingComparison {
  fileName: string;
  hierarchyName: string;
  recordingName: string;
  fileEvents: number;
  /** Chorus's All Events for the recording; differs from fileEvents when the file is not that recording. */
  recordingEvents: number | null;
  rows: ComparedPopulation[];
  compared: number;
  exact: number;
  largest: { name: string; delta: number; relative: number | null } | null;
}

export interface ChorusStatisticsComparison {
  recordings: RecordingComparison[];
  /** Recordings in the export with no loaded file of that name. */
  unmatchedRecordings: string[];
  /** Loaded files with no recording of that name. */
  unmatchedFiles: string[];
}

const AUTOMATIC = new Set(["Saturated", "Unsaturated"]);
const ROOT_ROW = "All Events";

/** File names match recordings by stem, case-insensitively: Chorus names the FCS it writes after the recording. */
export function recordingStem(name: string): string {
  return name.trim().replace(/\.fcs$/i, "").trim().toLowerCase();
}

function reasonFor(
  pop: FilePopulationCount,
  byName: Map<string, FilePopulationCount>,
  reports: Map<string, ChorusGateReport> | null,
): ComparisonReason {
  if (!reports) return { kind: "unknown" };
  const own = reports.get(pop.name);
  if (!own) return { kind: "unknown" };
  // A gate that moved after the tree was taken outranks everything: the export counted a
  // different gate. A moved ancestor outranks the gate's own axes for the same reason.
  if (own.differsFromCurrent) return { kind: "moved" };
  // Ancestors nearest first, as far as the import knows them; beyond an unknown one nothing is
  // assumed, but a reason found below it still stands.
  const ancestors: ChorusGateReport[] = [];
  let hitUnknown = false;
  let up = pop.parentName ? byName.get(pop.parentName) ?? null : null;
  while (up) {
    const r = reports.get(up.name);
    if (!r) { hitUnknown = true; break; }
    ancestors.push(r);
    up = up.parentName ? byName.get(up.parentName) ?? null : null;
  }
  const moved = ancestors.find((r) => r.differsFromCurrent);
  if (moved) return { kind: "inherited", from: moved.name };
  if (own.approximated) {
    return { kind: "biexponential", axes: own.axes.filter((a) => a.scale !== "Linear" && a.scale !== "").map((a) => a.name) };
  }
  const approximated = ancestors.find((r) => r.approximated);
  if (approximated) return { kind: "inherited", from: approximated.name };
  return hitUnknown ? { kind: "unknown" } : { kind: "exact" };
}

export function compareChorusStatistics(
  stats: ChorusStatistics,
  files: FileCounts[],
  record: ChorusImportRecord | null,
): ChorusStatisticsComparison {
  const reports = record ? new Map(record.gates.map((g) => [g.name, g])) : null;
  const byStem = new Map(stats.recordings.map((r) => [recordingStem(r.name), r]));
  const matchedRecordings = new Set<string>();
  const out: ChorusStatisticsComparison = { recordings: [], unmatchedRecordings: [], unmatchedFiles: [] };

  for (const file of files) {
    const rec = byStem.get(recordingStem(file.fileName));
    if (!rec) { out.unmatchedFiles.push(file.fileName); continue; }
    matchedRecordings.add(rec.name);
    const byName = new Map(file.populations.map((p) => [p.name, p]));
    // Chorus rows are consumed in order, so a name that recurs pairs with the tree's next
    // population of that name: both sides are depth-first, and Chorus writes unqualified names.
    const unused = rec.populations.filter((p) => p.name !== ROOT_ROW);
    const take = (name: string): ChorusStatisticsPopulation | null => {
      const i = unused.findIndex((p) => p.name === name);
      if (i < 0) return null;
      return unused.splice(i, 1)[0];
    };
    const rows: ComparedPopulation[] = [];
    for (const pop of file.populations) {
      const c = take(pop.name) ?? take(pop.name.slice(pop.name.lastIndexOf("/") + 1));
      const delta = c ? pop.events - c.events : null;
      rows.push({
        name: pop.name,
        depth: pop.depth,
        chorusEvents: c?.events ?? null,
        gatelabEvents: pop.events,
        chorusPercentParent: c?.percentParent ?? null,
        gatelabPercentParent: pop.percentParent,
        delta,
        relative: delta !== null && c && c.events > 0 ? delta / c.events : null,
        reason: c ? reasonFor(pop, byName, reports) : { kind: "gatelab-only" },
      });
    }
    for (const c of unused) {
      rows.push({
        name: c.name, depth: 0, chorusEvents: c.events, gatelabEvents: null,
        chorusPercentParent: c.percentParent, gatelabPercentParent: null, delta: null, relative: null,
        reason: AUTOMATIC.has(c.name) ? { kind: "automatic" } : { kind: "chorus-only" },
      });
    }
    const counted = rows.filter((r) => r.delta !== null);
    let largest: RecordingComparison["largest"] = null;
    for (const r of counted) {
      if (!largest || Math.abs(r.delta!) > Math.abs(largest.delta)) largest = { name: r.name, delta: r.delta!, relative: r.relative };
    }
    out.recordings.push({
      fileName: file.fileName,
      hierarchyName: file.hierarchyName,
      recordingName: rec.name,
      fileEvents: file.events,
      recordingEvents: rec.populations.find((p) => p.name === ROOT_ROW)?.events ?? null,
      rows,
      compared: counted.length,
      exact: counted.filter((r) => r.delta === 0).length,
      largest,
    });
  }
  out.unmatchedRecordings = stats.recordings.filter((r) => !matchedRecordings.has(r.name)).map((r) => r.name);
  return out;
}
