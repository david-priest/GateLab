import type { CompensationPairEvidence } from "./compensationPairPreview";

export type CompensationEvidenceMode = "biological" | "control";

export type CompensationAttentionReason =
  | "new-zero-pile"
  | "negative-receiver-shift"
  | "negative-residual-slope"
  | "multiple-overcompensation-signals"
  | "high-tail-curve"
  | "positive-residual-control"
  | "multiple-undercompensation-signals"
  | "mixed-residual-signals";

export type CompensationEvidenceCategory =
  | "overcompensation-like"
  | "undercompensation-like"
  | "high-tail-structure"
  | "positive-association-only"
  | "mixed-evidence"
  | "no-automatic-evidence"
  | "insufficient";

export interface CompensationAttentionInput {
  readonly coefficient: number;
  readonly physicalPrior: number;
  readonly evidence: CompensationPairEvidence;
}

export interface CompensationEvidenceAssessment {
  readonly category: CompensationEvidenceCategory;
  readonly label: string;
  readonly detail: string;
  readonly reason: CompensationAttentionReason | null;
  readonly automaticFollowup: boolean;
}

export interface RankedCompensationAttention {
  readonly index: number;
  readonly relativePriority: number;
  readonly reason: CompensationAttentionReason;
  readonly category: CompensationEvidenceCategory;
}

const MIN_SHIFT_MAD = 0.5;
const MIN_CYTOF_ZERO_DELTA_FRACTION = 0.01;
const MIN_SLOPE_ABSOLUTE = 1e-4;
const MIN_SLOPE_COEFFICIENT_FRACTION = 0.05;
const MIN_UPPER_TAIL_EXCESS_MAD = 3;
const MIN_UPPER_TAIL_SLOPE_DELTA_MAD = 1;
const STRONG_UPPER_TAIL_EXCESS_MAD = 5;

interface EvidenceSignals {
  readonly negativeShift: number;
  readonly negativeSlope: number;
  readonly zeroDelta: number;
  readonly positiveShift: number;
  readonly positiveSlope: number;
  readonly upperTailExcess: number;
  readonly upperTailSlopeDelta: number;
  readonly hasNegativeShift: boolean;
  readonly hasNegativeSlope: boolean;
  readonly hasNewZeroPile: boolean;
  readonly hasPositiveShift: boolean;
  readonly hasPositiveSlope: boolean;
  readonly hasHighTailCurve: boolean;
}

function evidenceSignals(
  input: CompensationAttentionInput,
  kind: "flow" | "cytof",
): EvidenceSignals {
  const shift = input.evidence.normalizedNegativeShift ?? 0;
  const slope = input.evidence.residualSlope ?? 0;
  const upperTailExcess = Math.max(0, input.evidence.upperTailExcessMad ?? 0);
  const upperTailSlopeDelta = Math.max(0, input.evidence.upperTailSlopeDeltaMad ?? 0);
  const coefficient = Math.abs(input.coefficient);
  const slopeThreshold = Math.max(
    MIN_SLOPE_ABSOLUTE,
    coefficient * MIN_SLOPE_COEFFICIENT_FRACTION,
  );
  return {
    negativeShift: Math.max(0, -shift),
    negativeSlope: Math.max(0, -slope),
    zeroDelta: kind === "cytof"
      ? Math.max(0, input.evidence.receiverZeroDeltaFraction)
      : 0,
    positiveShift: Math.max(0, shift),
    positiveSlope: Math.max(0, slope),
    upperTailExcess,
    upperTailSlopeDelta,
    hasNegativeShift: shift <= -MIN_SHIFT_MAD,
    hasNegativeSlope: slope <= -slopeThreshold,
    hasNewZeroPile: kind === "cytof" &&
      input.evidence.receiverZeroDeltaFraction >= MIN_CYTOF_ZERO_DELTA_FRACTION,
    hasPositiveShift: shift >= MIN_SHIFT_MAD,
    hasPositiveSlope: slope >= slopeThreshold,
    hasHighTailCurve: upperTailExcess >= MIN_UPPER_TAIL_EXCESS_MAD &&
      (upperTailSlopeDelta >= MIN_UPPER_TAIL_SLOPE_DELTA_MAD ||
        upperTailExcess >= STRONG_UPPER_TAIL_EXCESS_MAD),
  };
}

function overcompensationReason(signals: EvidenceSignals): CompensationAttentionReason {
  const count = Number(signals.hasNegativeShift) +
    Number(signals.hasNegativeSlope) +
    Number(signals.hasNewZeroPile);
  if (count > 1) return "multiple-overcompensation-signals";
  if (signals.hasNewZeroPile) return "new-zero-pile";
  if (signals.hasNegativeShift) return "negative-receiver-shift";
  return "negative-residual-slope";
}

/**
 * Give a deliberately qualified interpretation of one source→receiver pair.
 * Positive association is never called under-compensation in biological-sample
 * mode because co-expression, cell size, and activation can create the same shape.
 */
export function assessCompensationEvidence(
  input: CompensationAttentionInput,
  kind: "flow" | "cytof",
  mode: CompensationEvidenceMode = "biological",
): CompensationEvidenceAssessment {
  const signals = evidenceSignals(input, kind);
  const hasOvercompensationSignal = signals.hasNegativeShift ||
    signals.hasNegativeSlope || signals.hasNewZeroPile;
  const hasBroadPositiveAssociation = signals.hasPositiveShift || signals.hasPositiveSlope;
  const hasUndercompensationSignal = signals.hasHighTailCurve ||
    (mode === "control" && hasBroadPositiveAssociation);

  if (hasOvercompensationSignal && hasUndercompensationSignal) {
    return {
      category: "mixed-evidence",
      label: "Mixed evidence · inspect",
      detail: "Positive and negative residual signals disagree. Inspect the matched plots and use a suitable control before changing the coefficient.",
      reason: "mixed-residual-signals",
      automaticFollowup: true,
    };
  }
  if (hasOvercompensationSignal) {
    return {
      category: "overcompensation-like",
      label: "Overcompensation-like",
      detail: "A negative receiver shift, negative residual slope, or new NNLS zero pile is present. This is a review prompt, not an automatic coefficient verdict.",
      reason: overcompensationReason(signals),
      automaticFollowup: true,
    };
  }
  if (signals.hasHighTailCurve) {
    if (mode === "control") {
      return {
        category: "undercompensation-like",
        label: "Undercompensation-like · control",
        detail: "A source-associated point or curve emerges in the upper tail. In a suitable single-stain/control sample this can support under-compensation review.",
        reason: "high-tail-curve",
        automaticFollowup: true,
      };
    }
    return {
      category: "high-tail-structure",
      label: "High-tail structure · control required",
      detail: "A source-associated point or curve emerges only at high expression. Spill can look this way, but biological co-expression can too.",
      reason: "high-tail-curve",
      automaticFollowup: input.physicalPrior > 0,
    };
  }
  if (hasBroadPositiveAssociation) {
    if (mode === "control") {
      const count = Number(signals.hasPositiveShift) + Number(signals.hasPositiveSlope);
      return {
        category: "undercompensation-like",
        label: "Undercompensation-like · control",
        detail: "Positive source-associated residual signal is present. This interpretation is valid only because control-data mode was selected.",
        reason: count > 1 ? "multiple-undercompensation-signals" : "positive-residual-control",
        automaticFollowup: true,
      };
    }
    return {
      category: "positive-association-only",
      label: "Positive association only · control required",
      detail: "Positive association alone is not treated as spill in a biological sample; co-expression and cell size can produce the same pattern.",
      reason: null,
      automaticFollowup: false,
    };
  }
  if (input.evidence.status !== "ready") {
    return {
      category: "insufficient",
      label: "Evidence groups insufficient",
      detail: "The pair remains available for visual review, but the automatic screen could not form robust comparison groups.",
      reason: null,
      automaticFollowup: false,
    };
  }
  return {
    category: "no-automatic-evidence",
    label: "No automatic evidence",
    detail: "This screen did not find a qualified residual pattern. Visual review and manual follow-up remain available.",
    reason: null,
    automaticFollowup: false,
  };
}

function positivePercentileRank(value: number, population: readonly number[]): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const positive = population
    .filter((candidate) => Number.isFinite(candidate) && candidate > 0)
    .sort((left, right) => left - right);
  if (positive.length === 0) return 0;
  let atOrBelow = 0;
  for (const candidate of positive) {
    if (candidate <= value) atOrBelow++;
    else break;
  }
  return atOrBelow / positive.length;
}

/**
 * Rank qualified residual patterns while keeping the biological-sample default
 * conservative. Control mode intentionally permits positive residual association
 * to enter the shortlist; the user must explicitly assert that evidence context.
 */
export function rankConservativeCompensationAttention(
  inputs: readonly CompensationAttentionInput[],
  kind: "flow" | "cytof",
  mode: CompensationEvidenceMode = "biological",
): readonly RankedCompensationAttention[] {
  const metrics = inputs.map((input) => ({
    ...evidenceSignals(input, kind),
    coefficient: Math.abs(input.coefficient),
  }));
  const population = <K extends keyof (typeof metrics)[number]>(key: K): number[] =>
    metrics.map((metric) => typeof metric[key] === "number" ? metric[key] as number : 0);
  const negativeShifts = population("negativeShift");
  const negativeSlopes = population("negativeSlope");
  const zeroDeltas = population("zeroDelta");
  const positiveShifts = population("positiveShift");
  const positiveSlopes = population("positiveSlope");
  const upperTailExcesses = population("upperTailExcess");
  const upperTailSlopeDeltas = population("upperTailSlopeDelta");
  const coefficients = population("coefficient");

  const ranked = inputs.flatMap((input, index): RankedCompensationAttention[] => {
    const assessment = assessCompensationEvidence(input, kind, mode);
    if (!assessment.automaticFollowup || assessment.reason === null) return [];
    const metric = metrics[index];
    const relativePriority =
      0.22 * positivePercentileRank(metric.negativeShift, negativeShifts) +
      0.13 * positivePercentileRank(metric.negativeSlope, negativeSlopes) +
      0.14 * positivePercentileRank(metric.zeroDelta, zeroDeltas) +
      (mode === "control" ? 0.13 * positivePercentileRank(metric.positiveShift, positiveShifts) : 0) +
      (mode === "control" ? 0.08 * positivePercentileRank(metric.positiveSlope, positiveSlopes) : 0) +
      0.12 * positivePercentileRank(metric.upperTailExcess, upperTailExcesses) +
      0.08 * positivePercentileRank(metric.upperTailSlopeDelta, upperTailSlopeDeltas) +
      0.05 * positivePercentileRank(metric.coefficient, coefficients) +
      0.05 * Math.max(0, Math.min(1, input.physicalPrior));
    return [{
      index,
      relativePriority,
      reason: assessment.reason,
      category: assessment.category,
    }];
  });
  return Object.freeze(ranked.sort((left, right) =>
    right.relativePriority - left.relativePriority || left.index - right.index));
}
