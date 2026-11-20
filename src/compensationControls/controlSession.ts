// controlSession.ts — the calculator as the interface drives it.
//
// The files, what was detected of them, and what the user chose instead (a file's role or channel,
// beads or cells, where the negative events come from, the two boundaries on a control's own
// channel), giving the matrix and its checks. Detection is the costly part and depends only on
// which files take part, so it is a separate step (sessionDetection) the interface keeps while the
// user changes the rest.
//
// A file the user has given a role or a channel keeps it whatever is detected of the others: where
// two files are the control for one channel, the user's choice is used and the other is a
// duplicate.

import { checkBrightness, checkSettings, fmoResiduals, type BrightnessFinding, type FmoResidual, type SettingsFinding } from "./controlChecks";
import { detectControls, type ControlDetection, type ControlRole, type DetectedControl } from "./controlDetection";
import { eventIndices, type ControlChannel, type ControlFile } from "./controlFile";
import { namedChannel, namedUnstained } from "./controlNames";
import { planControl, type ControlKind, type NegativeChoice, type PlannedControl } from "./controlPlan";
import {
  compareSpillover,
  estimateSpillover,
  type CoefficientDifference,
  type ControlRow,
  type ControlSpec,
  type SpilloverEstimate,
} from "./spilloverEstimate";

/** A file's part in the calculation; "ignored" takes no part at all. */
export type SessionRole = ControlRole | "ignored";

/** What the user chose for one file, over what was detected. Absent fields are left to the detection. */
export interface FileChoice {
  readonly role?: SessionRole;
  readonly channel?: string | null;
  readonly kind?: "auto" | ControlKind;
  readonly negative?: NegativeChoice;
  /**
   * The boundaries on the control's own channel, raw units, where the user has moved them: each
   * set is an interval, lower inclusive and upper exclusive. Left to the detection, the negative
   * events have no lower boundary and the positive events no upper one.
   */
  readonly negativeLower?: number;
  readonly negativeUpper?: number;
  readonly positiveLower?: number;
  readonly positiveUpper?: number;
}

export type SessionChoices = Readonly<Record<string, FileChoice | undefined>>;

export interface SessionDetection {
  /** The files that take part, in the order given. */
  readonly files: readonly ControlFile[];
  /** Files left out because their channels are not those of the controls. */
  readonly otherChannels: readonly string[];
  readonly detection: ControlDetection;
}

const channelSignature = (file: ControlFile): string => file.channels.map((channel) => channel.pnn).sort().join("\u0001");

/**
 * The files that take part and what each is detected as. A file the user ignores is left out. So
 * is a file whose channels are not the controls': the files are grouped by their channels, and the
 * group with the most files named as controls (a channel's name, or unstained) is kept, or the
 * largest group where no file is so named, together with any file that has all of that group's
 * channels and more.
 */
export function sessionDetection(files: readonly ControlFile[], choices: SessionChoices = {}): SessionDetection {
  const taking = files.filter((file) => choices[file.id]?.role !== "ignored");
  const groups = new Map<string, ControlFile[]>();
  for (const file of taking) {
    const signature = channelSignature(file);
    groups.set(signature, [...(groups.get(signature) ?? []), file]);
  }
  let kept: ControlFile[] = [];
  let keptNamed = -1;
  for (const group of groups.values()) {
    const named = group.filter((file) =>
      namedUnstained(file) || namedChannel(file, group[0].channels).channel !== null).length;
    if (named > keptNamed || (named === keptNamed && group.length > kept.length)) {
      kept = group;
      keptNamed = named;
    }
  }
  // A file with every channel of that group and more (a sample recorded with one more parameter) takes part too.
  const keptChannels = kept.length > 0 ? kept[0].channels.map((channel) => channel.pnn) : [];
  const keptSignature = kept.length > 0 ? channelSignature(kept[0]) : "";
  kept = taking.filter((file) =>
    channelSignature(file) === keptSignature ||
    (keptChannels.length > 0 && keptChannels.every((pnn) => file.channels.some((channel) => channel.pnn === pnn))));
  const keptIds = new Set(kept.map((file) => file.id));
  return {
    files: kept,
    otherChannels: taking.filter((file) => !keptIds.has(file.id)).map((file) => file.id),
    detection: detectControls(kept),
  };
}

export interface SessionFile {
  readonly file: ControlFile;
  readonly detected: DetectedControl;
  readonly role: SessionRole;
  /** The channel the file is the control for (single-stain) or leaves out (FMO). */
  readonly channel: string | null;
  /** True where the role or the channel is the user's choice. */
  readonly chosen: boolean;
  /** True where another file is used as the control for this file's channel. */
  readonly duplicate: boolean;
  /** The control as planned; null for a file that is not the control used for a channel. */
  readonly planned: PlannedControl | null;
  /** The events calculated from, with the user's boundaries; null where it cannot be calculated. */
  readonly spec: ControlSpec | null;
  /** The boundaries in effect on the control's own channel; null where there is none. */
  readonly negativeLower: number | null;
  readonly negativeUpper: number | null;
  readonly positiveLower: number | null;
  readonly positiveUpper: number | null;
  /** True where a boundary is the user's. */
  readonly boundariesMoved: boolean;
  /** The control's row of the estimate: counts, medians and warnings. */
  readonly row: ControlRow | null;
}

export interface ControlSession {
  /** The channels every file has. */
  readonly channels: readonly ControlChannel[];
  readonly files: readonly SessionFile[];
  readonly otherChannels: readonly string[];
  /** The channels the matrix covers: those with a control that gave a row. */
  readonly matrixChannels: readonly string[];
  /** Null where fewer than two channels have a control. */
  readonly estimate: SpilloverEstimate | null;
  readonly channelsWithoutControl: readonly string[];
  /** The embedded matrix of a file of the set, and the calculated matrix against it. */
  readonly reference: Readonly<{ fileId: string; differences: readonly CoefficientDifference[] }> | null;
  readonly settings: readonly SettingsFinding[];
  /** One entry per stained sample among the files. */
  readonly brightness: readonly Readonly<{ fileId: string; findings: readonly BrightnessFinding[] }>[];
  /** One entry per FMO control whose omitted channel is in the matrix. */
  readonly fmo: readonly Readonly<{ fileId: string; omitted: string; residuals: readonly FmoResidual[] }>[];
}

function hasSpillover(file: ControlFile): boolean {
  return file.embedded?.matrix.some((row, i) => row.some((value, j) => i !== j && value !== 0)) ?? false;
}

/** The session: roles with the user's choices, every used control planned, the matrix and its checks. */
export function controlSession(base: SessionDetection, choices: SessionChoices = {}): ControlSession {
  const { files, detection } = base;
  const resolved = files.map((file, f) => {
    const detected = detection.controls[f];
    const choice = choices[file.id] ?? {};
    const role: SessionRole = choice.role ?? detected.role;
    const channel = choice.channel !== undefined ? choice.channel : detected.channel;
    return { file, detected, choice, role, channel, chosen: choice.role !== undefined || choice.channel !== undefined };
  });

  // The control used for each channel: a file the user chose, else the one detected, else the brightest.
  const usedFor = new Map<string, string>();
  for (const channel of detection.channels) {
    const candidates = resolved
      .filter((entry) => entry.role === "single-stain" && entry.channel === channel.pnn)
      .sort((a, b) =>
        Number(b.chosen) - Number(a.chosen) ||
        Number(a.detected.duplicate) - Number(b.detected.duplicate) ||
        (b.detected.fold ?? 0) - (a.detected.fold ?? 0));
    if (candidates.length > 0) usedFor.set(channel.pnn, candidates[0].file.id);
  }

  const unstained = resolved.filter((entry) => entry.role === "unstained").map((entry) => entry.file);
  const planned = new Map<string, { planned: PlannedControl; spec: ControlSpec | null; moved: boolean }>();
  for (const entry of resolved) {
    if (entry.role !== "single-stain" || entry.channel === null || usedFor.get(entry.channel) !== entry.file.id) continue;
    const plan = planControl(files, entry.file.id, entry.channel, unstained, {
      kind: entry.choice.kind,
      negative: entry.choice.negative,
    });
    const { negativeLower, negativeUpper, positiveLower, positiveUpper } = entry.choice;
    // A boundary the user has not moved is left as the plan has it.
    const moved = (bounds: { lower?: number; upper?: number }) =>
      Object.fromEntries(Object.entries(bounds).filter(([, value]) => value !== undefined));
    let spec = plan.spec;
    if (spec) {
      spec = {
        channel: spec.channel,
        positive: { ...spec.positive, ...moved({ lower: positiveLower, upper: positiveUpper }) },
        // The boundaries are on this file's events: they do not apply to an unstained control's.
        negative: plan.negativeSource !== "internal"
          ? spec.negative
          : { ...spec.negative, ...moved({ lower: negativeLower, upper: negativeUpper }) },
      };
    } else if (negativeUpper !== undefined && positiveLower !== undefined && entry.choice.negative !== "unstained") {
      // No negative population was found, and the user has marked one: the boundaries are the control.
      spec = {
        channel: entry.channel,
        positive: { fileId: entry.file.id, lower: positiveLower, ...moved({ upper: positiveUpper }) },
        negative: { fileId: entry.file.id, upper: negativeUpper, ...moved({ lower: negativeLower }) },
      };
    }
    planned.set(entry.file.id, {
      planned: plan,
      spec,
      moved: [negativeLower, negativeUpper, positiveLower, positiveUpper].some((value) => value !== undefined),
    });
  }

  // A control that gives no row (no signal, too few events) leaves its channel out of the matrix.
  const specOf = (channel: string): ControlSpec | null => planned.get(usedFor.get(channel) ?? "")?.spec ?? null;
  const withSpec = detection.channels.map((channel) => channel.pnn).filter((channel) => specOf(channel) !== null);
  const first = estimateSpillover(files, withSpec, withSpec.map((channel) => specOf(channel)!));
  const rowOf = new Map(first.rows.map((row) => [row.channel, row]));
  const matrixChannels = withSpec.filter((channel) => rowOf.get(channel)?.calculated != null);
  const specs = matrixChannels.map((channel) => specOf(channel)!);
  const estimate = matrixChannels.length < 2
    ? null
    : matrixChannels.length === withSpec.length ? first : estimateSpillover(files, matrixChannels, specs);
  estimate?.rows.forEach((row) => rowOf.set(row.channel, row));

  const sessionFiles: SessionFile[] = resolved.map((entry) => {
    const plan = planned.get(entry.file.id) ?? null;
    const used = plan !== null;
    const spec = plan?.spec ?? null;
    const internal = spec !== null && spec.negative.fileId === entry.file.id && spec.negative.upper !== undefined;
    return {
      file: entry.file,
      detected: entry.detected,
      role: entry.role,
      channel: entry.channel,
      chosen: entry.chosen,
      duplicate: entry.role === "single-stain" && entry.channel !== null && !used,
      planned: plan?.planned ?? null,
      spec,
      negativeLower: internal ? spec!.negative.lower ?? null : null,
      negativeUpper: internal ? spec!.negative.upper! : null,
      positiveLower: spec?.positive.lower ?? null,
      positiveUpper: spec?.positive.upper ?? null,
      boundariesMoved: plan?.moved ?? false,
      row: used && entry.channel !== null ? rowOf.get(entry.channel) ?? null : null,
    };
  });

  const samples = sessionFiles.filter((entry) => entry.role === "mixed").map((entry) => entry.file);
  const controlIds = new Set(specs.flatMap((spec) => [spec.positive.fileId, spec.negative.fileId]));
  const controls = files.filter((file) => controlIds.has(file.id));
  const referenceFile = samples.find(hasSpillover) ?? files.find(hasSpillover) ?? null;

  return {
    channels: detection.channels,
    files: sessionFiles,
    otherChannels: base.otherChannels,
    matrixChannels,
    estimate,
    channelsWithoutControl: detection.channels.map((channel) => channel.pnn).filter((channel) => !matrixChannels.includes(channel)),
    reference: estimate && referenceFile?.embedded
      ? { fileId: referenceFile.id, differences: compareSpillover(estimate, referenceFile.embedded) }
      : null,
    settings: estimate ? checkSettings(controls, samples, matrixChannels) : [],
    brightness: estimate
      ? samples.map((sample) => ({
          fileId: sample.id,
          findings: checkBrightness(files, matrixChannels, specs, estimate.matrix, sample),
        }))
      : [],
    fmo: estimate
      ? sessionFiles
          .filter((entry) => entry.role === "fmo" && entry.channel !== null && matrixChannels.includes(entry.channel))
          .map((entry) => ({
            fileId: entry.file.id,
            omitted: entry.channel!,
            residuals: fmoResiduals(entry.file, entry.channel!, matrixChannels, estimate.matrix),
          }))
      : [],
  };
}

/** One control of a calculated matrix, as its origin records it (compensationProfileRecord.ts). */
export type SessionOriginControl = Readonly<{
  channel: string;
  row: "control";
  events: Readonly<{ fileName: string; count: number; lower?: number; upper?: number }>;
  negative: Readonly<{ fileName: string; count: number; lower?: number; upper?: number }>;
}>;

/** What the matrix was calculated from, per channel in matrix order: files, event counts and boundaries. */
export function sessionOriginControls(session: ControlSession): SessionOriginControl[] {
  const byId = new Map(session.files.map((entry) => [entry.file.id, entry]));
  const bounds = (set: ControlSpec["positive"]) => ({
    ...(set.lower !== undefined && Number.isFinite(set.lower) ? { lower: set.lower } : {}),
    ...(set.upper !== undefined && Number.isFinite(set.upper) ? { upper: set.upper } : {}),
  });
  return session.matrixChannels.map((channel) => {
    const entry = session.files.find((candidate) => candidate.spec?.channel === channel && candidate.row?.channel === channel)!;
    const spec = entry.spec!;
    const negativeFile = byId.get(spec.negative.fileId)!.file;
    return {
      channel,
      row: "control" as const,
      events: { fileName: entry.file.fileName, count: entry.row!.positiveCount, ...bounds(spec.positive) },
      negative: { fileName: negativeFile.fileName, count: entry.row!.negativeCount, ...bounds(spec.negative) },
    };
  });
}

/** The events of a control's two sets in its own channel, for drawing: counts as the estimate takes them. */
export function sessionEventCounts(entry: SessionFile, files: readonly ControlFile[]): { positive: number; negative: number } | null {
  if (!entry.spec) return null;
  const own = entry.file.values(entry.spec.channel);
  const negativeOwn = files.find((file) => file.id === entry.spec!.negative.fileId)?.values(entry.spec.channel);
  if (!own || !negativeOwn) return null;
  return {
    positive: eventIndices(entry.spec.positive, own).length,
    negative: eventIndices(entry.spec.negative, negativeOwn).length,
  };
}
