/**
 * The artefacts of a FACSChorus experiment on one clock: the sorts a `.cef` records, the
 * recordings the loaded FCS files are, and the gate trees each carries.
 *
 * A `.cef` holds the live gates and one snapshot per sort, but no recordings; every FCS the
 * S8 exports holds the recording it is and the tree it was made under (chorusExperiment.ts).
 * Laid out together they answer the questions a sorted sample raises: when was it recorded,
 * which sort was running, and which tree was in force — the recording's own, or the sort's.
 */

import { listChorusTrees, treeSignature, type ChorusExperiment, type ChorusRecording, type ChorusTreeSummary } from "./chorusExperiment";

export interface ChorusTimelineSort {
  kind: "sort";
  /** Index into listChorusTrees(experiment), for chorusToGatingML. */
  treeIndex: number;
  name: string;
  startedAt: string;
  stoppedAt: string | null;
  gateCount: number;
  totalEvents: number | null;
  sorted: Array<{ population: string; sortCount: number }>;
  sameAsCurrent: boolean;
  /** Loaded recordings whose tree is this sort's snapshot, vertex for vertex. */
  recordedWith: string[];
}

export interface ChorusTimelineRecording {
  kind: "recording";
  fileId: string;
  fileName: string;
  name: string;
  startedAt: string | null;
  stoppedAt: string | null;
  eventCount: number | null;
  gateCount: number;
  /** Whether the recording's experiment id is the experiment's; null without an experiment. */
  sameExperiment: boolean | null;
  /** The sort that was running when it was recorded, if any. */
  duringSort: string | null;
  /** Labels of the experiment's trees (current gates, sort snapshots) identical to its own. */
  matchesTrees: string[];
  /** Recordings sharing one tree share a group; groups are numbered in time order. */
  treeGroup: number;
}

export type ChorusTimelineItem = ChorusTimelineSort | ChorusTimelineRecording;

export interface ChorusTimeline {
  /** Sorts and recordings, earliest first. */
  items: ChorusTimelineItem[];
  /** The live gates, when an experiment was given. */
  current: { treeIndex: number; gateCount: number; savedAt: string | null } | null;
  /** How many distinct trees the loaded recordings carry. */
  treeGroups: number;
  /** Recordings the experiment says it has (its metadata), when known. */
  recordingCount: number | null;
  /** The span of everything with a time, for drawing. */
  span: { start: string; end: string } | null;
}

export interface LoadedChorusRecording {
  fileId: string;
  fileName: string;
  recording: ChorusRecording;
}

/** Chorus writes its times in UTC with no zone designator; FCS $BEGINDATETIME carries a Z. */
export function chorusTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const zoned = /(Z|[+-]\d\d:?\d\d)$/.test(iso);
  const t = new Date(zoned ? iso : `${iso}Z`).getTime();
  return Number.isFinite(t) ? t : null;
}

function drawn(gates: readonly { gateKind: string }[]): number {
  return gates.filter((g) => g.gateKind !== "Saturated" && g.gateKind !== "Unsaturated").length;
}

export function buildChorusTimeline(
  experiment: ChorusExperiment | null,
  recordings: readonly LoadedChorusRecording[],
): ChorusTimeline {
  const trees: ChorusTreeSummary[] = experiment ? listChorusTrees(experiment) : [];
  // A tree is named by its sort, or "Current gates"; the picker's time suffix is not part of it.
  const treeSigs = experiment
    ? trees.map((t) => {
        const sort = t.kind === "sort" ? experiment.sorts.find((s) => s.startedAt === t.sortedAt && t.label.startsWith(s.name)) : null;
        return { label: sort ? sort.name : t.label, sig: t.kind === "current" ? treeSignature(experiment.panels[0].gates) : treeSignature(sort?.gates ?? []) };
      })
    : [];
  // A recording names the panel it was made in as its association, or the experiment itself.
  const experimentIds = new Set<string>();
  if (experiment) {
    if (experiment.id) experimentIds.add(experiment.id);
    for (const p of experiment.panels) if (p.id) experimentIds.add(p.id);
  }
  const currentTree = trees.find((t) => t.kind === "current") ?? null;

  const sorts: ChorusTimelineSort[] = trees
    .filter((t) => t.kind === "sort" && t.sortedAt)
    .map((t) => {
      const sort = experiment!.sorts.find((s) => s.startedAt === t.sortedAt && t.label.startsWith(s.name));
      return {
        kind: "sort" as const,
        treeIndex: t.index,
        name: sort?.name ?? t.label,
        startedAt: t.sortedAt!,
        stoppedAt: sort?.stoppedAt ?? null,
        gateCount: t.gateCount,
        totalEvents: t.totalEvents,
        sorted: t.sorted,
        sameAsCurrent: t.sameAsCurrent,
        recordedWith: [],
      };
    });

  // Recordings in time order, grouped by the tree they carry.
  const ordered = [...recordings].sort((a, b) => (chorusTime(a.recording.startedAt) ?? 0) - (chorusTime(b.recording.startedAt) ?? 0));
  const groupOf = new Map<string, number>();
  const recs: ChorusTimelineRecording[] = ordered.map(({ fileId, fileName, recording }) => {
    const sig = treeSignature(recording.panel.gates);
    if (!groupOf.has(sig)) groupOf.set(sig, groupOf.size);
    const t0 = chorusTime(recording.startedAt);
    const t1 = chorusTime(recording.stoppedAt) ?? t0;
    const during = t0 === null ? null : sorts.find((s) => {
      const s0 = chorusTime(s.startedAt);
      const s1 = chorusTime(s.stoppedAt);
      return s0 !== null && s1 !== null && t0 < s1 && (t1 ?? t0) > s0;
    });
    const matches = treeSigs.filter((t) => t.sig === sig).map((t) => t.label);
    return {
      kind: "recording" as const,
      fileId,
      fileName,
      name: recording.name,
      startedAt: recording.startedAt,
      stoppedAt: recording.stoppedAt,
      eventCount: recording.eventCount,
      gateCount: drawn(recording.panel.gates),
      sameExperiment: experiment && recording.experimentId !== null && experimentIds.size ? experimentIds.has(recording.experimentId) : null,
      duringSort: during?.name ?? null,
      matchesTrees: matches,
      treeGroup: groupOf.get(sig)!,
    };
  });
  for (const r of recs) {
    for (const s of sorts) if (r.matchesTrees.includes(s.name)) s.recordedWith.push(r.fileName);
  }

  const items: ChorusTimelineItem[] = [...sorts, ...recs].sort((a, b) => (chorusTime(a.startedAt) ?? 0) - (chorusTime(b.startedAt) ?? 0));
  const times = items.map((i) => chorusTime(i.startedAt)).filter((t): t is number => t !== null);
  const ends = items.map((i) => chorusTime(i.stoppedAt) ?? chorusTime(i.startedAt)).filter((t): t is number => t !== null);
  const savedAt = experiment?.savedAt ?? null;
  const savedT = chorusTime(savedAt);
  if (savedT !== null) { times.push(savedT); ends.push(savedT); }
  return {
    items,
    current: currentTree ? { treeIndex: currentTree.index, gateCount: currentTree.gateCount, savedAt } : null,
    treeGroups: groupOf.size,
    recordingCount: experiment?.recordingCount ?? null,
    span: times.length ? { start: new Date(Math.min(...times)).toISOString(), end: new Date(Math.max(...ends)).toISOString() } : null,
  };
}
