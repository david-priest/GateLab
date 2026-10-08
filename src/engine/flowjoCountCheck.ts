// flowjoCountCheck.ts — GateLab's count of every imported population set beside the count FlowJo
// recorded for it in the workspace, file by file. A FlowJo workspace stores an event count on
// each population; the import reads them (flowJoWorkspaceToGatingML's flowJoCounts) and this
// module compares them with the counts of the tree as it stands, by population name, which is
// how the import names what it makes. Nothing here evaluates a gate: both sides are counts.

import type { FileCounts } from "./chorusStatistics";

/** FlowJo's own record of one sample of a workspace, kept from the import of its strategy. */
export interface FlowJoReference {
  /** The loaded file the sample's strategy went onto, by id; null where only its name is known. */
  entryId: string | null;
  fileName: string;
  /** FlowJo's name for the sample. */
  sampleName: string;
  /** The events FlowJo had for the sample (`SampleNode@count`), or null when it states none. */
  events: number | null;
  /** FlowJo's recorded event count per population, by the name the import gave the population. */
  counts: Readonly<Record<string, number>>;
}

export type FlowJoCheckReason =
  | { kind: "exact" }
  /** Every population above it counts as FlowJo's does, so the difference arises at its own gate. */
  | { kind: "own" }
  /** A population above it already differs, and it is counted within that one. */
  | { kind: "inherited"; from: string }
  /** FlowJo recorded a count for it and the tree holds no population of that name. */
  | { kind: "flowjo-only" }
  /** The tree holds it and FlowJo's record has no population of that name. */
  | { kind: "gatelab-only" }
  /** FlowJo's record names it without a count (it writes -1 for one it had not calculated). */
  | { kind: "unrecorded" };

export interface FlowJoCheckedPopulation {
  name: string;
  depth: number;
  flowJoEvents: number | null;
  gatelabEvents: number | null;
  flowJoPercentParent: number | null;
  gatelabPercentParent: number | null;
  /** GateLab's count less FlowJo's; null where either side has none. */
  delta: number | null;
  /** The difference as a fraction of FlowJo's count; null where it has none or counts nothing. */
  relative: number | null;
  reason: FlowJoCheckReason;
}

export interface FlowJoFileCheck {
  fileName: string;
  hierarchyName: string;
  sampleName: string;
  fileEvents: number;
  /** FlowJo's event total for the sample; where it differs from the file's, this is another file. */
  flowJoEvents: number | null;
  rows: FlowJoCheckedPopulation[];
  /** Populations with a count on both sides. */
  compared: number;
  exact: number;
  /** The row furthest from FlowJo's count, by events; null when every compared row is exact. */
  largest: FlowJoCheckedPopulation | null;
}

export interface FlowJoCountCheck {
  files: FlowJoFileCheck[];
  /** Samples whose file is not loaded now, or cannot be told from another of its name. */
  unmatched: string[];
  compared: number;
  exact: number;
  /** Populations FlowJo recorded that no tree holds, over every file. */
  flowJoOnly: number;
  largest: { fileName: string; row: FlowJoCheckedPopulation } | null;
}

/** A recorded count worth comparing: FlowJo writes -1 for a population it had not calculated. */
const recorded = (count: number | undefined): count is number => count !== undefined && Number.isFinite(count) && count >= 0;

const percent = (events: number | null, of: number | null): number | null =>
  events === null || of === null || !(of > 0) ? null : (events / of) * 100;

function checkFile(reference: FlowJoReference, file: FileCounts): FlowJoFileCheck {
  const rows: FlowJoCheckedPopulation[] = [];
  const seen = new Set<string>();
  /** Each compared population's difference by name, for telling an inherited one from its own. */
  const deltaOf = new Map<string, number>();
  const parentOf = new Map<string, string | null>();
  for (const pop of file.populations) if (!parentOf.has(pop.name)) parentOf.set(pop.name, pop.parentName);
  const differingAncestor = (name: string): string | null => {
    const walked = new Set<string>();
    for (let up = parentOf.get(name) ?? null; up !== null && !walked.has(up); up = parentOf.get(up) ?? null) {
      walked.add(up);
      const delta = deltaOf.get(up);
      if (delta !== undefined && delta !== 0) return up;
    }
    return null;
  };
  for (const pop of file.populations) {
    // A name the tree holds twice is compared once, at its first place: the import qualifies the
    // names FlowJo repeats, so a second one of the same name was made after the import.
    const first = !seen.has(pop.name);
    seen.add(pop.name);
    const named = first && Object.prototype.hasOwnProperty.call(reference.counts, pop.name);
    const count = named ? reference.counts[pop.name] : undefined;
    const flowJoEvents = recorded(count) ? count : null;
    const parentFlowJo = pop.parentName === null
      ? reference.events
      : recorded(reference.counts[pop.parentName]) ? reference.counts[pop.parentName] : null;
    const delta = flowJoEvents === null ? null : pop.events - flowJoEvents;
    if (delta !== null) deltaOf.set(pop.name, delta);
    const from = delta !== null && delta !== 0 ? differingAncestor(pop.name) : null;
    rows.push({
      name: pop.name,
      depth: pop.depth,
      flowJoEvents,
      gatelabEvents: pop.events,
      flowJoPercentParent: percent(flowJoEvents, parentFlowJo),
      gatelabPercentParent: pop.percentParent,
      delta,
      relative: delta === null || flowJoEvents === null || flowJoEvents === 0 ? null : delta / flowJoEvents,
      reason: delta === null
        ? { kind: named ? "unrecorded" : "gatelab-only" }
        : delta === 0 ? { kind: "exact" } : from !== null ? { kind: "inherited", from } : { kind: "own" },
    });
  }
  for (const [name, count] of Object.entries(reference.counts)) {
    if (seen.has(name) || !recorded(count)) continue;
    rows.push({
      name, depth: 1, flowJoEvents: count, gatelabEvents: null, flowJoPercentParent: null, gatelabPercentParent: null,
      delta: null, relative: null, reason: { kind: "flowjo-only" },
    });
  }
  const compared = rows.filter((row) => row.delta !== null);
  let largest: FlowJoCheckedPopulation | null = null;
  for (const row of compared) {
    if (row.delta !== 0 && (!largest || Math.abs(row.delta!) > Math.abs(largest.delta!))) largest = row;
  }
  return {
    fileName: file.fileName,
    hierarchyName: file.hierarchyName,
    sampleName: reference.sampleName,
    fileEvents: file.events,
    flowJoEvents: reference.events,
    rows,
    compared: compared.length,
    exact: compared.filter((row) => row.delta === 0).length,
    largest,
  };
}

/**
 * Each reference's populations against its file's counts as they are now. A reference names its
 * file by id; one that carries none is its file where exactly one loaded file has its name.
 */
export function checkAgainstFlowJo(references: readonly FlowJoReference[], files: readonly FileCounts[]): FlowJoCountCheck {
  const out: FlowJoCountCheck = { files: [], unmatched: [], compared: 0, exact: 0, flowJoOnly: 0, largest: null };
  for (const reference of references) {
    const byId = reference.entryId !== null ? files.filter((file) => file.entryId === reference.entryId) : [];
    const byName = byId.length ? byId : files.filter((file) => file.fileName === reference.fileName);
    if (byName.length !== 1) { out.unmatched.push(reference.fileName); continue; }
    const checked = checkFile(reference, byName[0]);
    out.files.push(checked);
    out.compared += checked.compared;
    out.exact += checked.exact;
    out.flowJoOnly += checked.rows.filter((row) => row.reason.kind === "flowjo-only").length;
    if (checked.largest && (!out.largest || Math.abs(checked.largest.delta!) > Math.abs(out.largest.row.delta!))) {
      out.largest = { fileName: checked.fileName, row: checked.largest };
    }
  }
  return out;
}

const csvCell = (value: string | number | null): string => {
  if (value === null) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The check as a table: one row per population of every compared file. */
export function flowJoCountCheckCsv(check: FlowJoCountCheck): string {
  const lines = [["file", "flowjo_sample", "population", "flowjo_events", "gatelab_events", "difference", "difference_of_flowjo", "status", "differs_below"].join(",")];
  for (const file of check.files) {
    for (const row of file.rows) {
      lines.push([
        file.fileName, file.sampleName, row.name, row.flowJoEvents, row.gatelabEvents, row.delta,
        row.relative === null ? null : Number(row.relative.toFixed(6)),
        row.reason.kind, row.reason.kind === "inherited" ? row.reason.from : null,
      ].map(csvCell).join(","));
    }
  }
  return `${lines.join("\n")}\n`;
}
