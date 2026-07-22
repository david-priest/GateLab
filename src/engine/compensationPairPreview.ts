import type { Sample } from "./sample";
import type { AxisTicks } from "./ticks";

export interface CompensationDensityPanel {
  readonly x: readonly number[];
  readonly y: readonly number[];
  /** Exact zero-valued measurements in the sampled linear assay, before display transform. */
  readonly zeroPile: Readonly<{
    readonly source: number;
    readonly receiver: number;
    readonly corner: number;
  }>;
}

export interface CompensationPairPreview {
  readonly eventCount: number;
  readonly totalEvents: number;
  readonly xRange: readonly [number, number];
  readonly yRange: readonly [number, number];
  /** FlowJo-style decade ticks shared across Original/Compensated (null → linear, e.g. CyTOF). */
  readonly xTicks: AxisTicks | null;
  readonly yTicks: AxisTicks | null;
  readonly original: CompensationDensityPanel;
  readonly compensated: CompensationDensityPanel;
  /** Conservative residual evidence for review prioritisation; never an automatic verdict. */
  readonly evidence: CompensationPairEvidence;
}

export interface CompensationPairEvidence {
  readonly status: "ready" | "insufficient";
  readonly sourceLowEvents: number;
  readonly sourceHighEvents: number;
  readonly destinationNegativeEvents: number;
  /** Median receiver shift, source-high minus source-low, in baseline receiver MADs. */
  readonly normalizedNegativeShift: number | null;
  /** Robust binned-median slope on compensated linear measurements (receiver/source). */
  readonly residualSlope: number | null;
  /** Upper-source-tail departure from the robust bulk trend, in bulk residual MADs. */
  readonly upperTailExcessMad: number | null;
  /** Change in upper-tail slope versus the bulk trend, scaled into bulk residual MADs. */
  readonly upperTailSlopeDeltaMad: number | null;
  /** Compensated minus Original exact-zero receiver fraction in the sampled events. */
  readonly receiverZeroDeltaFraction: number;
}

export type CompensationPairPreviewResult =
  | { readonly ready: true; readonly preview: CompensationPairPreview }
  | { readonly ready: false; readonly reason: string };

function resolvedIndex(sample: Sample, channelKey: string): number | undefined {
  const direct = sample.index(channelKey);
  if (direct !== undefined) return direct;
  const byPnn = sample.channels.findIndex((channel) => channel.pnn === channelKey);
  return byPnn < 0 ? undefined : byPnn;
}

/**
 * Deterministically sample the complete file or a frozen population mask without first
 * materialising every eligible event index. The same returned IDs can therefore be reused
 * across every coefficient candidate in an exact sweep.
 */
export function deterministicCompensationEventIndices(
  total: number,
  maximum: number,
  eventMask?: Uint8Array | null,
): Uint32Array {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError("Compensation event count must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new RangeError("Compensation preview size must be a positive safe integer.");
  }
  if (eventMask && eventMask.length !== total) {
    throw new RangeError("Compensation population mask length does not match the sample.");
  }
  const eligible = eventMask
    ? eventMask.reduce((count, included) => count + (included ? 1 : 0), 0)
    : total;
  const count = Math.min(eligible, maximum);
  const result = new Uint32Array(count);
  if (count === 0) return result;
  if (!eventMask) {
    if (count === 1) return result;
    for (let index = 0; index < count; index++) {
      result[index] = Math.floor(index * (total - 1) / (count - 1));
    }
    return result;
  }
  const targetRanks = Array.from({ length: count }, (_, index) =>
    count === 1 ? 0 : Math.floor(index * (eligible - 1) / (count - 1)));
  let eligibleRank = 0;
  let target = 0;
  for (let event = 0; event < total && target < count; event++) {
    if (!eventMask[event]) continue;
    if (eligibleRank === targetRanks[target]) result[target++] = event;
    eligibleRank++;
  }
  return result;
}

function quantile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) return 0;
  const position = Math.max(0, Math.min(1, probability)) * (sorted.length - 1);
  const below = Math.floor(position);
  const above = Math.ceil(position);
  if (below === above) return sorted[below];
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}

function robustSharedRange(values: readonly number[]): readonly [number, number] {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return [-1, 1];
  let low = quantile(finite, 0.002);
  let high = quantile(finite, 0.998);
  if (!(high > low)) {
    const center = Number.isFinite(low) ? low : 0;
    const radius = Math.max(1, Math.abs(center) * 0.05);
    return [center - radius, center + radius];
  }
  const padding = (high - low) * 0.035;
  low -= padding;
  high += padding;
  return [low, high];
}

function medianValue(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  return quantile(sorted, 0.5);
}

function robustSpread(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const center = medianValue(values);
  const mad = medianValue(values.map((value) => Math.abs(value - center))) * 1.4826;
  if (Number.isFinite(mad) && mad > 0) return mad;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(1, values.length - 1);
  const standardDeviation = Math.sqrt(variance);
  return Number.isFinite(standardDeviation) && standardDeviation > 0
    ? standardDeviation
    : 1e-12;
}

function binnedMedianSlope(x: readonly number[], y: readonly number[], bins = 12): number | null {
  if (x.length !== y.length || x.length < bins * 8) return null;
  const order = Array.from({ length: x.length }, (_, index) => index)
    .sort((left, right) => x[left] - x[right]);
  const centers: Array<Readonly<{ x: number; y: number }>> = [];
  for (let bin = 0; bin < bins; bin++) {
    const start = Math.floor(bin * order.length / bins);
    const end = Math.floor((bin + 1) * order.length / bins);
    const indices = order.slice(start, end);
    if (indices.length < 8) continue;
    const medianX = medianValue(indices.map((index) => x[index]));
    const medianY = medianValue(indices.map((index) => y[index]));
    if (Number.isFinite(medianX) && Number.isFinite(medianY)) centers.push({ x: medianX, y: medianY });
  }
  const slopes: number[] = [];
  for (let left = 0; left < centers.length; left++) {
    for (let right = left + 1; right < centers.length; right++) {
      const deltaX = centers[right].x - centers[left].x;
      if (deltaX === 0) continue;
      const slope = (centers[right].y - centers[left].y) / deltaX;
      if (Number.isFinite(slope)) slopes.push(slope);
    }
  }
  const slope = medianValue(slopes);
  return Number.isFinite(slope) ? slope : null;
}

export interface CompensationUpperTailEvidence {
  readonly excessMad: number | null;
  readonly slopeDeltaMad: number | null;
}

/**
 * Detect a receiver signal that appears only at the high end of the source channel.
 *
 * A robust trend is fitted to the lower 80% of source values. The top 10% is then
 * compared with that extrapolated bulk trend. This deliberately distinguishes a
 * point/curve that emerges in the upper tail from a broad linear association across
 * the full range. The result is screening evidence only: biological co-expression
 * and size-dependent marker intensity can still create genuine upper-tail structure.
 */
export function compensationUpperTailEvidence(
  x: readonly number[],
  y: readonly number[],
): CompensationUpperTailEvidence {
  if (x.length !== y.length || x.length < 120) {
    return { excessMad: null, slopeDeltaMad: null };
  }
  const order = Array.from({ length: x.length }, (_, index) => index)
    .filter((index) => Number.isFinite(x[index]) && Number.isFinite(y[index]))
    .sort((left, right) => x[left] - x[right]);
  if (order.length < 120) return { excessMad: null, slopeDeltaMad: null };

  const bulkEnd = Math.max(96, Math.floor(order.length * 0.8));
  const tailStart = Math.min(order.length - 24, Math.floor(order.length * 0.9));
  const bulkIndices = order.slice(0, bulkEnd);
  const tailIndices = order.slice(tailStart);
  if (bulkIndices.length < 96 || tailIndices.length < 24) {
    return { excessMad: null, slopeDeltaMad: null };
  }

  const bulkX = bulkIndices.map((index) => x[index]);
  const bulkY = bulkIndices.map((index) => y[index]);
  const bulkSlope = binnedMedianSlope(bulkX, bulkY, 10);
  if (bulkSlope === null) return { excessMad: null, slopeDeltaMad: null };
  const intercept = medianValue(bulkIndices.map((index) => y[index] - bulkSlope * x[index]));
  const bulkResiduals = bulkIndices.map((index) => y[index] - (intercept + bulkSlope * x[index]));
  const residualScale = Math.max(
    robustSpread(bulkResiduals),
    robustSpread(bulkY) * 0.05,
    1e-12,
  );
  const tailResiduals = tailIndices
    .map((index) => y[index] - (intercept + bulkSlope * x[index]))
    .sort((left, right) => left - right);
  // The upper quartile retains sensitivity to a narrow, pointed high-expression
  // branch while remaining much less vulnerable than a maximum to isolated events.
  const excessMad = quantile(tailResiduals, 0.75) / residualScale;

  const upperQuarter = order.slice(Math.floor(order.length * 0.75));
  const upperX = upperQuarter.map((index) => x[index]);
  const upperY = upperQuarter.map((index) => y[index]);
  const upperSlope = binnedMedianSlope(upperX, upperY, 4);
  const sourceSpan = quantile(upperX, 0.9) - quantile(upperX, 0.1);
  const slopeDeltaMad = upperSlope === null || !(sourceSpan > 0)
    ? null
    : (upperSlope - bulkSlope) * sourceSpan / residualScale;
  return {
    excessMad: Number.isFinite(excessMad) ? excessMad : null,
    slopeDeltaMad: Number.isFinite(slopeDeltaMad) ? slopeDeltaMad : null,
  };
}

function compensationPairEvidence(
  compensatedRawX: readonly number[],
  compensatedRawY: readonly number[],
  compensatedDisplayX: readonly number[],
  compensatedDisplayY: readonly number[],
  originalReceiverZero: number,
  compensatedReceiverZero: number,
): CompensationPairEvidence {
  const eventCount = compensatedDisplayX.length;
  const upperTail = compensationUpperTailEvidence(compensatedDisplayX, compensatedDisplayY);
  const minimumGroup = Math.min(50, Math.max(12, Math.floor(eventCount * 0.01)));
  const insufficient = (
    sourceLowEvents = 0,
    sourceHighEvents = 0,
    destinationNegativeEvents = 0,
  ): CompensationPairEvidence => ({
    status: "insufficient",
    sourceLowEvents,
    sourceHighEvents,
    destinationNegativeEvents,
    normalizedNegativeShift: null,
    residualSlope: null,
    upperTailExcessMad: upperTail.excessMad,
    upperTailSlopeDeltaMad: upperTail.slopeDeltaMad,
    receiverZeroDeltaFraction: eventCount > 0
      ? (compensatedReceiverZero - originalReceiverZero) / eventCount
      : 0,
  });
  if (eventCount < minimumGroup * 3) return insufficient();

  const sortedSource = [...compensatedDisplayX].sort((left, right) => left - right);
  const lowThreshold = quantile(sortedSource, 0.25);
  const lowIndices = compensatedDisplayX.flatMap((value, index) => value <= lowThreshold ? [index] : []);
  if (lowIndices.length < minimumGroup) return insufficient(lowIndices.length);
  const lowSource = lowIndices.map((index) => compensatedDisplayX[index]);
  const sourceBaseline = medianValue(lowSource);
  const sourceSpread = robustSpread(lowSource);
  let highIndices = compensatedDisplayX.flatMap((value, index) =>
    value >= sourceBaseline + 3 * sourceSpread ? [index] : []);
  if (highIndices.length < minimumGroup) {
    highIndices = Array.from({ length: eventCount }, (_, index) => index)
      .sort((left, right) => compensatedDisplayX[right] - compensatedDisplayX[left])
      .slice(0, minimumGroup);
  }
  if (highIndices.length < minimumGroup) return insufficient(lowIndices.length, highIndices.length);

  const destinationBaseline = lowIndices.map((index) => compensatedDisplayY[index]);
  const destinationCenter = medianValue(destinationBaseline);
  const destinationSpread = robustSpread(destinationBaseline);
  const destinationCut = destinationCenter + 5 * destinationSpread;
  const destinationNegativeIndices = compensatedDisplayY.flatMap((value, index) =>
    value <= destinationCut ? [index] : []);
  const destinationNegative = new Set(destinationNegativeIndices);
  const lowNegative = lowIndices.filter((index) => destinationNegative.has(index));
  const highNegative = highIndices.filter((index) => destinationNegative.has(index));
  if (lowNegative.length < minimumGroup || highNegative.length < minimumGroup) {
    return insufficient(lowIndices.length, highIndices.length, destinationNegativeIndices.length);
  }

  const shift = (
    medianValue(highNegative.map((index) => compensatedDisplayY[index])) -
    medianValue(lowNegative.map((index) => compensatedDisplayY[index]))
  ) / destinationSpread;
  const rawNegativeX = destinationNegativeIndices.map((index) => compensatedRawX[index]);
  const rawNegativeY = destinationNegativeIndices.map((index) => compensatedRawY[index]);
  return {
    status: "ready",
    sourceLowEvents: lowIndices.length,
    sourceHighEvents: highIndices.length,
    destinationNegativeEvents: destinationNegativeIndices.length,
    normalizedNegativeShift: Number.isFinite(shift) ? shift : null,
    residualSlope: binnedMedianSlope(rawNegativeX, rawNegativeY),
    upperTailExcessMad: upperTail.excessMad,
    upperTailSlopeDeltaMad: upperTail.slopeDeltaMad,
    receiverZeroDeltaFraction: eventCount > 0
      ? (compensatedReceiverZero - originalReceiverZero) / eventCount
      : 0,
  };
}

function clippedPanel(
  x: readonly number[],
  y: readonly number[],
  rawX: readonly number[],
  rawY: readonly number[],
  xRange: readonly [number, number],
  yRange: readonly [number, number],
): CompensationDensityPanel {
  let sourceZero = 0;
  let receiverZero = 0;
  let cornerZero = 0;
  for (let index = 0; index < rawX.length; index++) {
    const xZero = Math.abs(rawX[index]) <= 1e-12;
    const yZero = Math.abs(rawY[index]) <= 1e-12;
    if (xZero) sourceZero++;
    if (yZero) receiverZero++;
    if (xZero && yZero) cornerZero++;
  }
  return {
    x: x.map((value) => Math.max(xRange[0], Math.min(xRange[1], value))),
    y: y.map((value) => Math.max(yRange[0], Math.min(yRange[1], value))),
    zeroPile: Object.freeze({
      source: sourceZero,
      receiver: receiverZero,
      corner: cornerZero,
    }),
  };
}

/**
 * Build locked-axis Original/Compensated density panels from the same deterministic
 * event sample. Values outside robust limits are accumulated into edge bins so no
 * off-scale events silently disappear.
 */
export function buildCompensationPairPreview(
  sample: Sample,
  sourceKey: string,
  receiverKey: string,
  options: Readonly<{
    maxEvents?: number;
    eventMask?: Uint8Array | null;
    fixedEventIndices?: Uint32Array;
    eligibleEventCount?: number;
  }> = {},
): CompensationPairPreviewResult {
  const status = sample.compensatedLayerStatus();
  if (status.state !== "ready") {
    return { ready: false, reason: "Apply compensation to compare Original and Compensated data." };
  }
  const sourceIndex = resolvedIndex(sample, sourceKey);
  const receiverIndex = resolvedIndex(sample, receiverKey);
  if (sourceIndex === undefined || receiverIndex === undefined) {
    return {
      ready: false,
      reason: "This matrix pair is not present in the FCS file, so a data biplot cannot be drawn.",
    };
  }
  if (sample.fcs.nEvents === 0) {
    return { ready: false, reason: "This sample contains no events." };
  }

  const eventIndices = options.fixedEventIndices?.slice() ??
    deterministicCompensationEventIndices(
      sample.fcs.nEvents,
      options.maxEvents ?? 15_000,
      options.eventMask,
    );
  for (const event of eventIndices) {
    if (event >= sample.fcs.nEvents || (options.eventMask && !options.eventMask[event])) {
      return { ready: false, reason: "The frozen compensation event selection is no longer valid." };
    }
  }
  const sourceChannel = sample.channels[sourceIndex].key;
  const receiverChannel = sample.channels[receiverIndex].key;
  const originalSource = sample.originalColumnData(sourceIndex);
  const originalReceiver = sample.originalColumnData(receiverIndex);
  const compensatedSource = sample.compensatedColumnData(sourceIndex);
  const compensatedReceiver = sample.compensatedColumnData(receiverIndex);
  const originalX: number[] = [];
  const originalY: number[] = [];
  const originalRawX: number[] = [];
  const originalRawY: number[] = [];
  const compensatedX: number[] = [];
  const compensatedY: number[] = [];
  const compensatedRawX: number[] = [];
  const compensatedRawY: number[] = [];

  for (const event of eventIndices) {
    const beforeX = sample.rawToDisplay(sourceChannel, originalSource[event]);
    const beforeY = sample.rawToDisplay(receiverChannel, originalReceiver[event]);
    const afterX = sample.rawToDisplay(sourceChannel, compensatedSource[event]);
    const afterY = sample.rawToDisplay(receiverChannel, compensatedReceiver[event]);
    if (![beforeX, beforeY, afterX, afterY].every(Number.isFinite)) continue;
    originalX.push(beforeX);
    originalY.push(beforeY);
    originalRawX.push(originalSource[event]);
    originalRawY.push(originalReceiver[event]);
    compensatedX.push(afterX);
    compensatedY.push(afterY);
    compensatedRawX.push(compensatedSource[event]);
    compensatedRawY.push(compensatedReceiver[event]);
  }
  const xRange = robustSharedRange([...originalX, ...compensatedX]);
  const yRange = robustSharedRange([...originalY, ...compensatedY]);
  const xTicks = sample.channelTicks(sourceIndex, [xRange[0], xRange[1]]);
  const yTicks = sample.channelTicks(receiverIndex, [yRange[0], yRange[1]]);
  const originalPanel = clippedPanel(
    originalX,
    originalY,
    originalRawX,
    originalRawY,
    xRange,
    yRange,
  );
  const compensatedPanel = clippedPanel(
    compensatedX,
    compensatedY,
    compensatedRawX,
    compensatedRawY,
    xRange,
    yRange,
  );
  return {
    ready: true,
    preview: {
      eventCount: originalX.length,
      totalEvents: options.eventMask
        ? options.eligibleEventCount ?? options.eventMask.reduce((count, included) => count + (included ? 1 : 0), 0)
        : sample.fcs.nEvents,
      xRange,
      yRange,
      xTicks,
      yTicks,
      original: originalPanel,
      compensated: compensatedPanel,
      evidence: compensationPairEvidence(
        compensatedRawX,
        compensatedRawY,
        compensatedX,
        compensatedY,
        originalPanel.zeroPile.receiver,
        compensatedPanel.zeroPile.receiver,
      ),
    },
  };
}

/**
 * Build the same locked-axis diagnostic from exact worker-solved candidate columns. Candidate
 * columns are aligned to fixedEventIndices, not to the complete FCS file.
 */
export function buildSolvedCompensationPairPreview(
  sample: Sample,
  sourceKey: string,
  receiverKey: string,
  fixedEventIndices: Uint32Array,
  candidateSource: ArrayLike<number>,
  candidateReceiver: ArrayLike<number>,
  options: Readonly<{
    totalEvents?: number;
    xRange?: readonly [number, number];
    yRange?: readonly [number, number];
  }> = {},
): CompensationPairPreviewResult {
  const sourceIndex = resolvedIndex(sample, sourceKey);
  const receiverIndex = resolvedIndex(sample, receiverKey);
  if (sourceIndex === undefined || receiverIndex === undefined) {
    return {
      ready: false,
      reason: "This matrix pair is not present in the FCS file, so a data biplot cannot be drawn.",
    };
  }
  if (
    candidateSource.length !== fixedEventIndices.length ||
    candidateReceiver.length !== fixedEventIndices.length
  ) {
    return { ready: false, reason: "The solved compensation preview does not match the frozen event selection." };
  }
  const sourceChannel = sample.channels[sourceIndex].key;
  const receiverChannel = sample.channels[receiverIndex].key;
  const originalSource = sample.originalColumnData(sourceIndex);
  const originalReceiver = sample.originalColumnData(receiverIndex);
  const originalX: number[] = [];
  const originalY: number[] = [];
  const originalRawX: number[] = [];
  const originalRawY: number[] = [];
  const candidateX: number[] = [];
  const candidateY: number[] = [];
  const candidateRawX: number[] = [];
  const candidateRawY: number[] = [];
  for (let previewEvent = 0; previewEvent < fixedEventIndices.length; previewEvent++) {
    const event = fixedEventIndices[previewEvent];
    if (event >= sample.fcs.nEvents) {
      return { ready: false, reason: "The frozen compensation event selection is no longer valid." };
    }
    const beforeRawX = originalSource[event];
    const beforeRawY = originalReceiver[event];
    const afterRawX = candidateSource[previewEvent];
    const afterRawY = candidateReceiver[previewEvent];
    const beforeX = sample.rawToDisplay(sourceChannel, beforeRawX);
    const beforeY = sample.rawToDisplay(receiverChannel, beforeRawY);
    const afterX = sample.rawToDisplay(sourceChannel, afterRawX);
    const afterY = sample.rawToDisplay(receiverChannel, afterRawY);
    if (![beforeRawX, beforeRawY, afterRawX, afterRawY, beforeX, beforeY, afterX, afterY].every(Number.isFinite)) continue;
    originalX.push(beforeX);
    originalY.push(beforeY);
    originalRawX.push(beforeRawX);
    originalRawY.push(beforeRawY);
    candidateX.push(afterX);
    candidateY.push(afterY);
    candidateRawX.push(afterRawX);
    candidateRawY.push(afterRawY);
  }
  const xRange = options.xRange ?? robustSharedRange([...originalX, ...candidateX]);
  const yRange = options.yRange ?? robustSharedRange([...originalY, ...candidateY]);
  const xTicks = sample.channelTicks(sourceIndex, [xRange[0], xRange[1]]);
  const yTicks = sample.channelTicks(receiverIndex, [yRange[0], yRange[1]]);
  const originalPanel = clippedPanel(originalX, originalY, originalRawX, originalRawY, xRange, yRange);
  const candidatePanel = clippedPanel(candidateX, candidateY, candidateRawX, candidateRawY, xRange, yRange);
  return {
    ready: true,
    preview: {
      eventCount: originalX.length,
      totalEvents: options.totalEvents ?? sample.fcs.nEvents,
      xRange,
      yRange,
      xTicks,
      yTicks,
      original: originalPanel,
      compensated: candidatePanel,
      evidence: compensationPairEvidence(
        candidateRawX,
        candidateRawY,
        candidateX,
        candidateY,
        originalPanel.zeroPile.receiver,
        candidatePanel.zeroPile.receiver,
      ),
    },
  };
}
