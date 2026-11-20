// "Calculate from controls…": a spillover matrix from single-stained controls.
//
// The dialog shows what each file was read as (compensationControls/controlSession.ts) and lets the
// user correct it, shows each control's events on its own channel with the two boundaries that
// divide negative from positive, and reports the matrix with its checks. Nothing here compensates
// a file: "Add to matrices" stores the matrix in the list, not in use.

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent } from "react";
import {
  fromScale,
  histogramCounts,
  histogramScale,
  scaleTicks,
  toScale,
} from "../compensationControls/controlHistogram";
import { controlFileFromSample, sortedValues, type ControlFile } from "../compensationControls/controlFile";
import { FEW_EVENTS, type EstimateWarning } from "../compensationControls/spilloverEstimate";
import {
  controlSession,
  sessionDetection,
  sessionOriginControls,
  type ControlSession,
  type FileChoice,
  type SessionChoices,
  type SessionFile,
  type SessionRole,
} from "../compensationControls/controlSession";
import { splitCofactor } from "../compensationControls/controlSplit";
import type { BaselineCompensationProfileRecord } from "../engine/compensationProfileRecord";
import { parseFcs } from "../engine/fcs";
import { pickFilesOrInput } from "../engine/fsAccess";
import { Sample } from "../engine/sample";
import { calculatedFlowMatrix } from "./compensationLibrary";
import { compensationMatrixCellAppearance, percentText, significantNumber } from "./compensationUiFormat";
import { useI18n } from "./i18n";

type Translate = ReturnType<typeof useI18n>["t"];

export interface ControlsDialogFile {
  readonly id: string;
  readonly name: string;
  readonly sample: Sample;
}

export interface CompensationControlsDialogProps {
  /** The workspace's flow files, as they are when the dialog opens. */
  readonly workspaceFiles: readonly ControlsDialogFile[];
  /** Names already in the Matrices list. */
  readonly takenNames: ReadonlySet<string>;
  /** Adds the matrix to the list, not in use; resolves to what to tell the user. */
  readonly onAdd: (profile: BaselineCompensationProfileRecord) => string;
  readonly onClose: (message?: string) => void;
}

/** A coefficient difference from the embedded matrix larger than this is counted in the report. */
const REFERENCE_DIFFERENCE = 0.005;
const REFERENCE_ERRORS = 5;
const HISTOGRAM_BINS = 160;
const PLOT = { width: 620, height: 190, left: 10, right: 10, top: 10, bottom: 24 };

const ROLE_LABEL: Record<SessionRole, string> = {
  "single-stain": "Single-stained control",
  unstained: "Unstained control",
  fmo: "FMO control",
  mixed: "Stained sample",
  unknown: "Not recognised",
  ignored: "Not used",
};

const rawText = (value: number): string =>
  Math.abs(value) >= 1000 ? Math.round(value).toLocaleString("en-US") : significantNumber(value, 3);

function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

function warningText(warning: EstimateWarning, t: Translate): string {
  switch (warning.code) {
    case "few-positive-events":
      return t("Only {count} positive events (fewer than {limit}).", { count: warning.count, limit: FEW_EVENTS });
    case "few-negative-events":
      return t("Only {count} negative events (fewer than {limit}).", { count: warning.count, limit: FEW_EVENTS });
    case "coefficient-above-one":
      return t("Brighter in {receiver} than in its own channel ({value}): check its channel.", {
        receiver: warning.receiver,
        value: percentText(warning.value),
      });
    case "negative-set-to-zero":
      return t("Coefficients below zero stored as 0: {count} (lowest: {receiver}, {value}).", {
        count: warning.count,
        receiver: warning.receiver,
        value: percentText(warning.lowest),
      });
    case "positive-at-top-of-range":
      return t("{percent} of the positive events are at the top of the range.", { percent: percentText(warning.fraction) });
    case "saturated":
      return t("Its positive events are at the top of the range: the detector was saturated, and no row can be calculated. Record the control dimmer, or at the voltage of a dimmer sample.");
    default:
      return t("The positive events are not above the negative events: no row.");
  }
}

/** Everything to say about one file, most important first. */
function fileNotes(entry: SessionFile | null, session: ControlSession, otherChannels: boolean, t: Translate): string[] {
  if (otherChannels) return [t("Its channels are not the controls': not used.")];
  if (!entry) return [];
  const notes: string[] = [];
  if (entry.duplicate && entry.channel !== null) {
    const used = session.files.find((other) => other.planned !== null && other.channel === entry.channel);
    notes.push(t("Not used: {file} is the control for {channel}.", { file: used?.file.fileName ?? "", channel: entry.channel }));
  }
  if (entry.role === "single-stain" && entry.channel === null) notes.push(t("Choose its channel."));
  if (entry.planned?.problem === "no-negative-population") {
    notes.push(t("No negative peak was found. Bead controls carry their own negative beads: mark the two populations by hand, or choose Cells to use the unstained control."));
  }
  if (entry.planned?.problem === "no-unstained-control") {
    notes.push(t("No negative population, and no unstained control to take one from."));
  }
  if (entry.planned?.negativeReason === "own-peak-not-negative") {
    notes.push(t("Its lower peak is above the unstained control's events, so it is not a negative population: the unstained control is used."));
  } else if (entry.planned?.negativeReason === "own-peak-small") {
    notes.push(t("It has only {count} negative events of its own: the unstained control is used.", { count: entry.planned.split?.negativeCount ?? 0 }));
  }
  if (entry.planned?.scatterDiffers) notes.push(t("The unstained control is of other particles (its scatter differs)."));
  for (const warning of entry.row?.warnings ?? []) notes.push(warningText(warning, t));
  if (entry.role === "single-stain" || entry.role === "fmo") {
    for (const note of entry.detected.notes) {
      if (note === "named-channel-has-no-signal") notes.push(t("Named for a channel that holds no signal."));
      else if (note === "name-and-signal-disagree") {
        notes.push(t("Named for this channel, but brightest in {channel}.", { channel: entry.detected.brightest?.channel ?? "?" }));
      } else if (note === "name-fits-several-channels") notes.push(t("Its name fits several channels."));
    }
    if (entry.chosen && entry.role === "single-stain" && entry.channel !== null &&
        entry.detected.brightest && entry.detected.brightest.channel !== entry.channel) {
      notes.push(t("Brightest in {channel}.", { channel: entry.detected.brightest.channel }));
    }
  }
  if (entry.detected.notes.includes("weak-signal") && entry.role === "unknown") notes.push(t("A little signal, not enough for a control."));
  if (entry.boundariesMoved) notes.push(t("Boundaries set by hand."));
  return notes;
}

function matchedByText(entry: SessionFile, t: Translate): string {
  if (entry.chosen) return t("Chosen");
  if (entry.detected.matchedBy === "name-and-signal") return t("Name and signal");
  if (entry.detected.matchedBy === "name") return t("Name");
  if (entry.detected.matchedBy === "signal") return t("Signal");
  return "";
}

/** The findings of the three checks and of the comparison, one sentence each. */
function reportLines(session: ControlSession, nameOf: (id: string) => string, t: Translate): string[] {
  const lines: string[] = [];
  if (session.channelsWithoutControl.length > 0) {
    lines.push(session.brightness.length > 0 || session.fmo.length > 0
      ? t("No usable control for {channels}: left out of the matrix. A sample stained in one of them is not compensated for it, and the findings below may come from it.", { channels: session.channelsWithoutControl.join(", ") })
      : t("No usable control for {channels}: left out of the matrix.", { channels: session.channelsWithoutControl.join(", ") }));
  }
  for (const finding of session.settings) {
    if (finding.code === "setting-differs") {
      lines.push(finding.setting === "voltage"
        ? t("{file}: {channel} was run at {value} V, the others at {expected} V. Spillover changes with voltage.", {
            file: nameOf(finding.fileId), channel: finding.channel, value: finding.value, expected: finding.expected,
          })
        : t("{file}: {channel} was run at gain {value}, the others at {expected}.", {
            file: nameOf(finding.fileId), channel: finding.channel, value: finding.value, expected: finding.expected,
          }));
    } else if (finding.code === "settings-not-recorded") {
      lines.push(t("No file records a voltage or a gain for {channels}: the settings were not compared.", { channels: finding.channels.join(", ") }));
    } else if (finding.code === "cytometer-differs") {
      lines.push(t("{file} was run on {cytometer}, the others on {expected}.", {
        file: nameOf(finding.fileId), cytometer: finding.cytometer, expected: finding.expected,
      }));
    } else {
      lines.push(t("{file} was acquired on {date}, the others on {expected}.", {
        file: nameOf(finding.fileId), date: finding.acquired, expected: finding.expected,
      }));
    }
  }
  // Per channel, the sample that is brightest against the control.
  const brightest = new Map<string, { fileId: string; ratio: number }>();
  for (const { fileId, findings } of session.brightness) {
    for (const finding of findings) {
      if (finding.exceeds && finding.ratio > (brightest.get(finding.channel)?.ratio ?? 0)) {
        brightest.set(finding.channel, { fileId, ratio: finding.ratio });
      }
    }
  }
  for (const [channel, { fileId, ratio }] of brightest) {
    lines.push(t("{channel}: {file} is {ratio} times as bright as the control reaches, so the spillover of its brightest events is extrapolated.", {
      channel, file: nameOf(fileId), ratio: significantNumber(ratio, 3),
    }));
  }
  for (const { fileId, omitted, residuals } of session.fmo) {
    const flagged = residuals.filter((residual) => residual.flagged);
    if (flagged.length === 0) {
      lines.push(t("{file}: nothing is left in {channel} after compensation ({count} stained channels checked).", {
        file: nameOf(fileId), channel: omitted, count: residuals.length,
      }));
    }
    for (const residual of flagged) {
      lines.push(residual.residual > 0
        ? t("{file}: {value} of {source} is left in {receiver} after compensation. The coefficient looks too small.", {
            file: nameOf(fileId), value: percentText(residual.residual), source: residual.source, receiver: residual.receiver,
          })
        : t("{file}: {receiver} is pulled {value} of {source} below its level after compensation. The coefficient looks too large.", {
            file: nameOf(fileId), value: percentText(-residual.residual), source: residual.source, receiver: residual.receiver,
          }));
    }
  }
  if (session.reference && session.reference.differences.length > 0) {
    const largest = session.reference.differences[0];
    // Counted: differences larger than the threshold and than five standard errors of the estimate.
    const over = session.reference.differences.filter((difference) =>
      Math.abs(difference.difference) > Math.max(REFERENCE_DIFFERENCE, REFERENCE_ERRORS * (difference.uncertainty ?? 0))).length;
    lines.push(t("Against the matrix embedded in {file}: the largest difference is {source} into {receiver}, {calculated} calculated against {reference}. {count} of {total} coefficients differ by more than {threshold} and more than five standard errors.", {
      file: nameOf(session.reference.fileId),
      source: largest.source,
      receiver: largest.receiver,
      calculated: largest.uncertainty !== null
        ? `${percentText(largest.calculated)} ± ${percentText(largest.uncertainty, false, 2)}`
        : percentText(largest.calculated),
      reference: percentText(largest.reference),
      count: over,
      total: session.reference.differences.length,
      threshold: percentText(REFERENCE_DIFFERENCE),
    }));
  }
  return lines;
}

interface HistogramProps {
  readonly entry: SessionFile;
  readonly files: readonly ControlFile[];
  /** The boundaries that changed; undefined puts one back to where the detection has it. */
  readonly onBoundaries: (change: BoundaryChange) => void;
  readonly onReset: () => void;
}

/** The four boundaries of a control: each of its two sets of events is an interval. */
type Boundary = "negativeLower" | "negativeUpper" | "positiveLower" | "positiveUpper";
type BoundaryChange = Partial<Record<Boundary, number | undefined>>;
const NO_BOUNDARIES: BoundaryChange = {
  negativeLower: undefined, negativeUpper: undefined, positiveLower: undefined, positiveUpper: undefined,
};
const BOUNDARY_LABEL: Record<Boundary, string> = {
  negativeLower: "Lower boundary of the negative events",
  negativeUpper: "Upper boundary of the negative events",
  positiveLower: "Lower boundary of the positive events",
  positiveUpper: "Upper boundary of the positive events",
};

/** A control's events on its own channel, with the boundaries of its negative and positive events. */
function ControlHistogram({ entry, files, onBoundaries, onReset }: HistogramProps) {
  const { t } = useI18n();
  const channel = entry.channel!;
  const own = entry.file.values(channel);
  const negativeFile = entry.spec && entry.spec.negative.fileId !== entry.file.id
    ? files.find((file) => file.id === entry.spec!.negative.fileId) ?? null
    : null;
  const other = negativeFile?.values(channel) ?? null;
  const drawn = useMemo(() => {
    if (!own) return null;
    const range = entry.file.channels.find((candidate) => candidate.pnn === channel)?.range ?? 0;
    const cofactor = entry.planned?.split?.cofactor ?? splitCofactor(sortedValues(own), range);
    const scale = histogramScale([own, other], cofactor);
    if (!scale) return null;
    return {
      scale,
      counts: histogramCounts(own, scale, HISTOGRAM_BINS),
      otherCounts: other ? histogramCounts(other, scale, HISTOGRAM_BINS) : null,
      sorted: sortedValues(own),
    };
  }, [own, other, channel, entry.file, entry.planned]);
  /** A boundary while it is dragged: the matrix is calculated when it is let go. */
  const [drag, setDrag] = useState<{ which: Boundary; value: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => setDrag(null), [entry.file.id, channel]);

  if (!own || !drawn) return <p className="gl-hint">{t("This file has no events to draw in {channel}.", { channel })}</p>;
  const { scale, counts, otherCounts, sorted } = drawn;
  const inner = { width: PLOT.width - PLOT.left - PLOT.right, height: PLOT.height - PLOT.top - PLOT.bottom };
  const xOf = (value: number) => PLOT.left + ((toScale(value, scale.cofactor) - scale.lo) / (scale.hi - scale.lo)) * inner.width;
  const clampX = (x: number) => Math.max(PLOT.left, Math.min(PLOT.left + inner.width, x));
  const valueAt = (clientX: number): number => {
    const box = svgRef.current!.getBoundingClientRect();
    const x = ((clientX - box.left) / box.width) * PLOT.width;
    const at = (clampX(x) - PLOT.left) / inner.width;
    return fromScale(scale.lo + at * (scale.hi - scale.lo), scale.cofactor);
  };
  const path = (bins: Uint32Array, closed: boolean): string => {
    const top = Math.max(1, ...bins);
    const step = inner.width / bins.length;
    const base = PLOT.top + inner.height;
    let d = closed ? `M${PLOT.left},${base}` : "";
    bins.forEach((count, bin) => {
      const y = base - (count / top) * inner.height;
      const x = PLOT.left + bin * step;
      d += `${d === "" ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}L${(x + step).toFixed(1)},${y.toFixed(1)}`;
    });
    return closed ? `${d}L${PLOT.left + inner.width},${base}Z` : d;
  };

  // The extent drawn stands for "no boundary" on the outer side of each set: a handle left at
  // the edge of the plot takes every event beyond it too.
  const edge = { lo: fromScale(scale.lo, scale.cofactor), hi: fromScale(scale.hi, scale.cofactor) };
  const inEffect = (which: Boundary): number | null => (drag?.which === which ? drag.value : entry[which]);
  const negativeUpper = inEffect("negativeUpper");
  const positiveLower = inEffect("positiveLower");
  const negativeLower = negativeUpper === null ? null : inEffect("negativeLower") ?? edge.lo;
  const positiveUpper = positiveLower === null ? null : inEffect("positiveUpper") ?? edge.hi;
  /** A boundary stays between its neighbours: the four are in order along the axis. */
  const limited = (which: Boundary, value: number): number => {
    const [low, high] = which === "negativeLower" ? [edge.lo, negativeUpper ?? edge.hi]
      : which === "negativeUpper" ? [negativeLower ?? edge.lo, positiveLower ?? edge.hi]
      : which === "positiveLower" ? [negativeUpper ?? edge.lo, positiveUpper ?? edge.hi]
      : [positiveLower ?? edge.lo, edge.hi];
    return Math.max(low, Math.min(high, value));
  };
  const commit = (which: Boundary, value: number) => {
    setDrag(null);
    // A handle pressed and let go where it was changes nothing.
    if (value === (entry[which] ?? (which === "negativeLower" ? edge.lo : which === "positiveUpper" ? edge.hi : null))) return;
    // An outer boundary put back at the edge of the plot is no boundary.
    const half = (scale.hi - scale.lo) / HISTOGRAM_BINS / 2;
    const at = toScale(value, scale.cofactor);
    const open = (which === "negativeLower" && at <= scale.lo + half) || (which === "positiveUpper" && at >= scale.hi - half);
    onBoundaries({ [which]: open ? undefined : value });
  };
  const handle = (which: Boundary, value: number) => {
    const set = which.startsWith("negative") ? "negative" : "positive";
    const side = which.endsWith("Lower") ? "lower" : "upper";
    const x = clampX(xOf(value));
    const stepBy = (direction: number) => {
      const position = toScale(value, scale.cofactor) + direction * (scale.hi - scale.lo) / HISTOGRAM_BINS;
      commit(which, limited(which, fromScale(position, scale.cofactor)));
    };
    return (
      <g
        className={`gl-comp-controls-handle is-${set} is-${side}`}
        role="slider"
        tabIndex={0}
        aria-label={t(BOUNDARY_LABEL[which])}
        aria-valuenow={Math.round(value)}
        aria-valuetext={rawText(value)}
        onKeyDown={(event: KeyboardEvent<SVGGElement>) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowDown") { event.preventDefault(); stepBy(event.shiftKey ? -5 : -1); }
          else if (event.key === "ArrowRight" || event.key === "ArrowUp") { event.preventDefault(); stepBy(event.shiftKey ? 5 : 1); }
        }}
        onPointerDown={(event: PointerEvent<SVGGElement>) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDrag({ which, value });
        }}
        onPointerMove={(event: PointerEvent<SVGGElement>) => {
          if (drag?.which === which) setDrag({ which, value: limited(which, valueAt(event.clientX)) });
        }}
        onPointerUp={(event: PointerEvent<SVGGElement>) => {
          if (drag?.which !== which) return;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
          commit(which, drag.value);
        }}
        onPointerCancel={() => setDrag(null)}
      >
        <rect x={x - 7} y={PLOT.top} width={14} height={inner.height} fill="transparent" />
        <line x1={x} x2={x} y1={PLOT.top} y2={PLOT.top + inner.height} />
        <path d={`M${x - 5},${PLOT.top}h10l-5,7z`} />
      </g>
    );
  };

  const countBelow = (value: number): number => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // Counted as the estimate takes them: lower inclusive, upper exclusive, none where the side is open.
  const closedLower = inEffect("negativeLower");
  const closedUpper = inEffect("positiveUpper");
  const positiveCount = positiveLower === null ? 0
    : (closedUpper === null ? sorted.length : countBelow(closedUpper)) - countBelow(positiveLower);
  const negativeCount = negativeUpper === null ? entry.row?.negativeCount ?? 0
    : countBelow(negativeUpper) - (closedLower === null ? 0 : countBelow(closedLower));
  const byHand = () => {
    // Starting places for a control with no negative peak found: the lowest tenth and the upper half.
    onBoundaries({ ...NO_BOUNDARIES, negativeUpper: sorted[Math.floor(sorted.length * 0.1)], positiveLower: sorted[Math.floor(sorted.length * 0.5)] });
  };

  return (
    <div className="gl-comp-controls-histogram">
      <div className="gl-comp-controls-histogram-head">
        <strong>{t("{file}: events in {channel}", { file: entry.file.fileName, channel })}</strong>
        {entry.boundariesMoved && (
          <button type="button" className="gl-mini-btn" onClick={onReset}>{t("Reset boundaries")}</button>
        )}
        {entry.spec === null && entry.planned?.problem === "no-negative-population" && (
          <button type="button" className="gl-mini-btn gl-comp-controls-by-hand" onClick={byHand}>{t("Mark by hand")}</button>
        )}
      </div>
      <svg
        ref={svgRef}
        className="gl-comp-controls-plot"
        viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
        role="group"
        aria-label={t("Histogram of {file} in {channel}", { file: entry.file.fileName, channel })}
      >
        {negativeUpper !== null && negativeLower !== null && (
          <rect
            className="gl-comp-controls-negative"
            x={clampX(xOf(negativeLower))}
            y={PLOT.top}
            width={Math.max(0, clampX(xOf(negativeUpper)) - clampX(xOf(negativeLower)))}
            height={inner.height}
          />
        )}
        {positiveLower !== null && positiveUpper !== null && (
          <rect
            className="gl-comp-controls-positive"
            x={clampX(xOf(positiveLower))}
            y={PLOT.top}
            width={Math.max(0, clampX(xOf(positiveUpper)) - clampX(xOf(positiveLower)))}
            height={inner.height}
          />
        )}
        <path className="gl-comp-controls-own" d={path(counts, true)} />
        {otherCounts && <path className="gl-comp-controls-other" d={path(otherCounts, false)} />}
        <line className="gl-comp-controls-axis" x1={PLOT.left} x2={PLOT.left + inner.width} y1={PLOT.top + inner.height} y2={PLOT.top + inner.height} />
        {scaleTicks(scale).map((tick) => {
          const x = PLOT.left + tick.at * inner.width;
          return (
            <g key={tick.label} className="gl-comp-controls-tick">
              <line x1={x} x2={x} y1={PLOT.top + inner.height} y2={PLOT.top + inner.height + 4} />
              <text x={x} y={PLOT.height - 6} textAnchor="middle">{tick.label}</text>
            </g>
          );
        })}
        {negativeLower !== null && handle("negativeLower", negativeLower)}
        {negativeUpper !== null && handle("negativeUpper", negativeUpper)}
        {positiveUpper !== null && handle("positiveUpper", positiveUpper)}
        {positiveLower !== null && handle("positiveLower", positiveLower)}
      </svg>
      <p className="gl-comp-controls-counts">
        {positiveLower !== null && (
          <span className="is-positive">
            {closedUpper === null
              ? t("Positive: {count} events at or above {value}", { count: positiveCount.toLocaleString("en-US"), value: rawText(positiveLower) })
              : t("Positive: {count} events from {lower} to {upper}", { count: positiveCount.toLocaleString("en-US"), lower: rawText(positiveLower), upper: rawText(closedUpper) })}
          </span>
        )}
        {negativeUpper !== null ? (
          <span className="is-negative">
            {closedLower === null
              ? t("Negative: {count} events below {value}", { count: negativeCount.toLocaleString("en-US"), value: rawText(negativeUpper) })
              : t("Negative: {count} events from {lower} to {upper}", { count: negativeCount.toLocaleString("en-US"), lower: rawText(closedLower), upper: rawText(negativeUpper) })}
          </span>
        ) : negativeFile ? (
          <span className="is-negative">
            {t("Negative: all {count} events of {file} (dashed line)", { count: negativeCount.toLocaleString("en-US"), file: negativeFile.fileName })}
          </span>
        ) : null}
      </p>
      <p className="gl-hint">{t("Each set of events has a lower and an upper boundary: drag one, or select it and use the arrow keys. Events outside both sets are not used.")}</p>
    </div>
  );
}

export function CompensationControlsDialog({ workspaceFiles, takenNames, onAdd, onClose }: CompensationControlsDialogProps) {
  const { t } = useI18n();
  // The files as they were when the dialog opened: a re-render of the App does not start the detection again.
  const [opened] = useState(() => workspaceFiles.filter(({ sample }) => sample.instrument === "flow"));
  const [added, setAdded] = useState<readonly ControlsDialogFile[]>([]);
  const [choices, setChoices] = useState<SessionChoices>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState(() => uniqueName("Calculated matrix", takenNames));
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [adding, setAdding] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const files = useMemo(
    () => [...opened, ...added].map(({ id, name: fileName, sample }) => controlFileFromSample(sample, id, fileName)),
    [opened, added],
  );
  const ignored = files.filter((file) => choices[file.id]?.role === "ignored").map((file) => file.id).join("\u0001");
  // Detection reads every file, so it runs again only when the files taking part change.
  const base = useMemo(() => sessionDetection(files, choices), [files, ignored]); // eslint-disable-line react-hooks/exhaustive-deps
  const session = useMemo(() => controlSession(base, choices), [base, choices]);
  const entryOf = useMemo(() => new Map(session.files.map((entry) => [entry.file.id, entry])), [session]);
  const nameOf = (id: string) => files.find((file) => file.id === id)?.fileName ?? id;
  const selectedEntry = (selected !== null ? entryOf.get(selected) : undefined)
    ?? session.files.find((entry) => entry.planned !== null) ?? null;
  const lines = useMemo(() => reportLines(session, nameOf, t), [session, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (id: string, change: FileChoice) => {
    setError(null);
    setChoices((current) => ({ ...current, [id]: { ...current[id], ...change } }));
  };

  const readFiles = async (picked: readonly File[]) => {
    setReading(true);
    setError(null);
    try {
      const read: ControlsDialogFile[] = [];
      for (const file of picked) {
        try {
          const sample = new Sample(parseFcs(await file.arrayBuffer()));
          if (sample.instrument !== "flow") throw new Error(t("not a flow cytometry file"));
          read.push({ id: `added-${Date.now()}-${read.length}-${file.name}`, name: file.name, sample });
        } catch (cause) {
          setError(t("{file} could not be read: {reason}", { file: file.name, reason: cause instanceof Error ? cause.message : String(cause) }));
        }
      }
      setAdded((current) => [...current, ...read.filter((file) => ![...opened, ...current].some((other) => other.name === file.name))]);
    } finally {
      setReading(false);
    }
  };
  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (picked.length > 0) void readFiles(picked);
  };
  const chooseFiles = () =>
    void pickFilesOrInput(fileRef.current, { "application/vnd.isac.fcs": [".fcs"] }, "Compensation controls", true).then((picked) => {
      if (picked && picked.length > 0) void readFiles(picked);
    });

  const add = async () => {
    if (!session.estimate) return;
    setAdding(true);
    setError(null);
    try {
      const profile = await calculatedFlowMatrix(
        session.matrixChannels,
        session.estimate.matrix,
        sessionOriginControls(session),
        name.trim().normalize("NFC").slice(0, 200) || "Calculated matrix",
      );
      onClose(onAdd(profile));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAdding(false);
    }
  };

  const maximum = session.estimate
    ? Math.max(0, ...session.estimate.matrix.flatMap((row, i) => row.filter((_, j) => i !== j).map(Math.abs)))
    : 0;
  const hasChoices = Object.keys(choices).length > 0;

  return (
    <div className="gl-modal-backdrop" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
      <div className="gl-modal gl-comp-controls" role="dialog" aria-modal="true" aria-labelledby="comp-controls-title">
        <div className="gl-modal-title" id="comp-controls-title">{t("Calculate a matrix from single-stained controls")}</div>
        <p className="gl-comp-controls-intro">
          {t("Each file is read for what it is: a single-stained control and its channel, an unstained control, an FMO control or a stained sample. Correct anything read wrongly. The matrix is added to the list of matrices and compensates no file until you use it.")}
        </p>
        <div className="gl-comp-controls-bar">
          <button type="button" className="gl-mini-btn" disabled={reading} onClick={chooseFiles}>
            {reading ? t("Reading…") : t("Add FCS files…")}
          </button>
          <button type="button" className="gl-mini-btn" disabled={!hasChoices} onClick={() => { setChoices({}); setError(null); }}>
            {t("Reset to what was read")}
          </button>
          <span className="gl-hint">
            {t("{files} files · {controls} controls used · {channels} channels in the matrix", {
              files: files.length,
              controls: session.files.filter((entry) => entry.planned !== null).length,
              channels: session.matrixChannels.length,
            })}
          </span>
          <input
            ref={fileRef}
            type="file"
            accept=".fcs"
            multiple
            className="gl-sr-only"
            aria-label={t("Add compensation control files")}
            onChange={handleFiles}
          />
        </div>
        <div className="gl-comp-controls-body">
          <div className="gl-comp-controls-files">
            {files.length === 0 ? (
              <p className="gl-hint">{t("No flow files yet. Add the control files, and a stained sample of the same experiment if you have one.")}</p>
            ) : (
              <table className="gl-comp-controls-table">
                <thead>
                  <tr>
                    <th>{t("File")}</th>
                    <th>{t("Read as")}</th>
                    <th>{t("Channel")}</th>
                    <th>{t("By")}</th>
                    <th>{t("Particles")}</th>
                    <th>{t("Negative events")}</th>
                    <th>{t("Events used")}</th>
                    <th>{t("Notes")}</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((file) => {
                    const entry = entryOf.get(file.id) ?? null;
                    const choice = choices[file.id] ?? {};
                    const role: SessionRole = choice.role === "ignored" ? "ignored" : entry?.role ?? "ignored";
                    const other = base.otherChannels.includes(file.id);
                    const notes = fileNotes(entry, session, other, t);
                    const usesChannel = role === "single-stain" || role === "fmo";
                    const isSelected = selectedEntry?.file.id === file.id;
                    return (
                      <tr
                        key={file.id}
                        data-file-id={file.id}
                        className={(isSelected ? "is-selected" : "") + (entry?.planned ? " is-control" : "") + (role === "ignored" || other ? " is-unused" : "")}
                        onClick={() => entry?.planned && setSelected(file.id)}
                      >
                        <td className="gl-comp-controls-file" title={file.fileName}>{file.fileName}</td>
                        <td>
                          <select
                            aria-label={t("What {file} is", { file: file.fileName })}
                            value={role}
                            disabled={other}
                            onChange={(event) => choose(file.id, { role: event.currentTarget.value as SessionRole })}
                          >
                            {(Object.keys(ROLE_LABEL) as SessionRole[])
                              .filter((option) => option !== "unknown" || role === "unknown")
                              .map((option) => <option key={option} value={option}>{t(ROLE_LABEL[option])}</option>)}
                          </select>
                        </td>
                        <td>
                          {usesChannel && entry ? (
                            <select
                              aria-label={t("Channel of {file}", { file: file.fileName })}
                              value={entry.channel ?? ""}
                              onChange={(event) => choose(file.id, { channel: event.currentTarget.value || null, ...NO_BOUNDARIES })}
                            >
                              <option value="">{"—"}</option>
                              {session.channels.map((channel) => <option key={channel.pnn} value={channel.pnn}>{channel.pnn}</option>)}
                            </select>
                          ) : ""}
                        </td>
                        <td>{entry && role !== "ignored" ? matchedByText(entry, t) : ""}</td>
                        <td>
                          {entry?.planned ? (
                            <select
                              aria-label={t("Particles of {file}", { file: file.fileName })}
                              value={choice.kind ?? "auto"}
                              onChange={(event) => choose(file.id, { kind: event.currentTarget.value as FileChoice["kind"] })}
                            >
                              <option value="auto">
                                {entry.planned.kindFrom === "chosen"
                                  ? t("Automatic")
                                  : entry.planned.kind === "beads" ? t("Automatic: beads") : t("Automatic: cells")}
                              </option>
                              <option value="beads">{t("Beads")}</option>
                              <option value="cells">{t("Stained cells")}</option>
                            </select>
                          ) : ""}
                        </td>
                        <td>
                          {entry?.planned ? (
                            <select
                              aria-label={t("Negative events of {file}", { file: file.fileName })}
                              value={choice.negative ?? "auto"}
                              onChange={(event) => choose(file.id, { negative: event.currentTarget.value as FileChoice["negative"] })}
                            >
                              <option value="auto">
                                {choice.negative !== undefined && choice.negative !== "auto"
                                  ? t("Automatic")
                                  : entry.spec === null
                                    ? t("Automatic: none found")
                                    : entry.spec.negative.fileId === file.id ? t("Automatic: its own") : t("Automatic: unstained")}
                              </option>
                              <option value="internal">{t("Its own negative peak")}</option>
                              <option value="unstained">{t("The unstained control")}</option>
                            </select>
                          ) : ""}
                        </td>
                        <td className="gl-comp-controls-events">
                          {entry?.row
                            ? t("{positive} pos · {negative} neg", {
                                positive: entry.row.positiveCount.toLocaleString("en-US"),
                                negative: entry.row.negativeCount.toLocaleString("en-US"),
                              })
                            : entry && role !== "ignored" ? file.eventCount.toLocaleString("en-US") : ""}
                        </td>
                        <td className="gl-comp-controls-notes">
                          {notes.map((note) => <div key={note}>{note}</div>)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <div className="gl-comp-controls-side">
            {selectedEntry?.planned && selectedEntry.channel !== null ? (
              <ControlHistogram
                entry={selectedEntry}
                files={base.files}
                onBoundaries={(change) => choose(selectedEntry.file.id, change)}
                onReset={() => choose(selectedEntry.file.id, NO_BOUNDARIES)}
              />
            ) : (
              <p className="gl-hint">{t("Select a single-stained control to see its events and the boundaries of its negative and positive events.")}</p>
            )}
            <div className="gl-comp-controls-report">
              <h4>{t("Findings")}</h4>
              {lines.length === 0 ? (
                <p className="gl-hint">{session.estimate ? t("Nothing to report.") : t("At least two channels need a control.")}</p>
              ) : (
                <ul>{lines.map((line) => <li key={line}>{line}</li>)}</ul>
              )}
            </div>
          </div>
        </div>
        {session.estimate && (
          <div className="gl-comp-controls-matrix">
            <h4>{t("Calculated matrix · {count} channels", { count: session.matrixChannels.length })}</h4>
            <div className="gl-comp-controls-matrix-scroll">
              <table aria-label={t("Calculated spillover matrix")}>
                <thead>
                  <tr>
                    <th title={t("Rows are the fluorochrome, columns the channel it spills into.")}>{t("From \\ into")}</th>
                    {session.matrixChannels.map((channel) => <th key={channel}>{channel.replace(/-A$/i, "")}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {session.estimate.matrix.map((row, i) => (
                    <tr key={session.matrixChannels[i]}>
                      <th>{session.matrixChannels[i].replace(/-A$/i, "")}</th>
                      {row.map((value, j) => (
                        <td
                          key={session.matrixChannels[j]}
                          style={compensationMatrixCellAppearance(value, maximum, i === j)}
                          title={`${session.matrixChannels[i]} → ${session.matrixChannels[j]}: ${percentText(value, false, 4)}` +
                            (i !== j && session.estimate!.rows[i].uncertainty ? ` ± ${percentText(session.estimate!.rows[i].uncertainty![j], false, 2)}` : "")}
                        >
                          {i === j ? "100%" : value === 0 ? "·" : `${(100 * value).toFixed(2)}%`}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {error && <div className="gl-comp-error" role="alert">{error}</div>}
        <div className="gl-modal-actions gl-comp-controls-actions">
          <label className="gl-comp-controls-name">
            <span>{t("Name")}</span>
            <input value={name} maxLength={200} onChange={(event) => setName(event.currentTarget.value)} />
          </label>
          <button type="button" className="gl-btn-ghost" onClick={() => onClose()}>{t("Close")}</button>
          <button type="button" className="gl-btn" disabled={!session.estimate || adding} onClick={() => void add()}>
            {t("Add to matrices")}
          </button>
        </div>
      </div>
    </div>
  );
}
