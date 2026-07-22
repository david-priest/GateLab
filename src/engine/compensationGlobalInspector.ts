import {
  deterministicCompensationEventIndices,
  type CompensationDensityPanel,
} from "./compensationPairPreview";
import {
  DEFAULT_DENSITY_COLOR_POWER,
  robustDensityColorCeiling,
} from "./pseudocolor";
import type { Sample } from "./sample";
import type { AxisTicks } from "./ticks";

export type CompensationInspectorLayer = "original" | "compensated";

interface CompensationInspectorChannelProjection {
  readonly key: string;
  readonly pnn: string;
  readonly range: readonly [number, number];
  /** FlowJo-style decade ticks for this channel/range (null → linear); shared by both layers. */
  readonly ticks: AxisTicks | null;
  readonly originalRaw: Float64Array;
  readonly compensatedRaw: Float64Array;
  readonly originalDisplay: Float64Array;
  readonly compensatedDisplay: Float64Array;
}

export interface CompensationGlobalInspectorDataset {
  readonly eventIndices: Uint32Array;
  readonly eventSignature: string;
  readonly eligibleEventCount: number;
  readonly channels: ReadonlyMap<string, CompensationInspectorChannelProjection>;
}

export interface CompensationGlobalPairPreview {
  readonly eventCount: number;
  readonly totalEvents: number;
  readonly eventSignature: string;
  readonly xRange: readonly [number, number];
  readonly yRange: readonly [number, number];
  readonly xTicks: AxisTicks | null;
  readonly yTicks: AxisTicks | null;
  readonly original: CompensationDensityPanel;
  readonly compensated: CompensationDensityPanel;
}

export type CompensationGlobalInspectorDatasetResult =
  | { readonly ready: true; readonly dataset: CompensationGlobalInspectorDataset }
  | { readonly ready: false; readonly reason: string };

export type CompensationGlobalPairPreviewResult =
  | { readonly ready: true; readonly preview: CompensationGlobalPairPreview }
  | { readonly ready: false; readonly reason: string };

function resolvedIndex(sample: Sample, channelKey: string): number | undefined {
  const direct = sample.index(channelKey);
  if (direct !== undefined) return direct;
  const byPnn = sample.channels.findIndex((channel) => channel.pnn === channelKey);
  return byPnn < 0 ? undefined : byPnn;
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

function eventSignature(indices: Uint32Array): string {
  if (indices.length === 0) return "0:empty";
  let checksum = 2166136261;
  for (const event of indices) {
    checksum ^= event;
    checksum = Math.imul(checksum, 16777619) >>> 0;
  }
  return `${indices.length}:${indices[0]}:${indices[indices.length - 1]}:${checksum.toString(16)}`;
}

/**
 * Freeze one population sample and project every requested channel into Original and
 * Compensated display coordinates with the same transform. Per-channel shared ranges
 * are calculated once and reused by every gallery pair.
 */
export function buildCompensationGlobalInspectorDataset(
  sample: Sample,
  channelKeys: readonly string[],
  options: Readonly<{
    maxEvents?: number;
    eventMask?: Uint8Array | null;
    fixedEventIndices?: Uint32Array;
    eligibleEventCount?: number;
  }> = {},
): CompensationGlobalInspectorDatasetResult {
  const status = sample.compensatedLayerStatus();
  if (status.state !== "ready") {
    return { ready: false, reason: "Apply compensation before comparing Uncompensated and Compensated data." };
  }
  const eventIndices = options.fixedEventIndices?.slice() ??
    deterministicCompensationEventIndices(
      sample.fcs.nEvents,
      options.maxEvents ?? 2_500,
      options.eventMask,
    );
  for (const event of eventIndices) {
    if (event >= sample.fcs.nEvents || (options.eventMask && !options.eventMask[event])) {
      return { ready: false, reason: "The frozen global-inspector event selection is no longer valid." };
    }
  }

  const channels = new Map<string, CompensationInspectorChannelProjection>();
  for (const channelKey of Array.from(new Set(channelKeys))) {
    const index = resolvedIndex(sample, channelKey);
    if (index === undefined) continue;
    const channel = sample.channels[index];
    const originalColumn = sample.originalColumnData(index);
    const compensatedColumn = sample.compensatedColumnData(index);
    const originalRaw = new Float64Array(eventIndices.length);
    const compensatedRaw = new Float64Array(eventIndices.length);
    const originalDisplay = new Float64Array(eventIndices.length);
    const compensatedDisplay = new Float64Array(eventIndices.length);
    const rangeValues: number[] = [];
    for (let previewEvent = 0; previewEvent < eventIndices.length; previewEvent++) {
      const event = eventIndices[previewEvent];
      const beforeRaw = originalColumn[event];
      const afterRaw = compensatedColumn[event];
      const beforeDisplay = sample.rawToDisplay(channel.key, beforeRaw);
      const afterDisplay = sample.rawToDisplay(channel.key, afterRaw);
      originalRaw[previewEvent] = beforeRaw;
      compensatedRaw[previewEvent] = afterRaw;
      originalDisplay[previewEvent] = beforeDisplay;
      compensatedDisplay[previewEvent] = afterDisplay;
      if (Number.isFinite(beforeDisplay)) rangeValues.push(beforeDisplay);
      if (Number.isFinite(afterDisplay)) rangeValues.push(afterDisplay);
    }
    const range = robustSharedRange(rangeValues);
    const projection = Object.freeze({
      key: channel.key,
      pnn: channel.pnn,
      range,
      ticks: sample.channelTicks(index, [range[0], range[1]]),
      originalRaw,
      compensatedRaw,
      originalDisplay,
      compensatedDisplay,
    });
    channels.set(channelKey, projection);
    channels.set(channel.key, projection);
    channels.set(channel.pnn, projection);
  }
  const eligibleEventCount = options.eventMask
    ? options.eligibleEventCount ?? options.eventMask.reduce((count, included) => count + (included ? 1 : 0), 0)
    : sample.fcs.nEvents;
  return {
    ready: true,
    dataset: Object.freeze({
      eventIndices,
      eventSignature: eventSignature(eventIndices),
      eligibleEventCount,
      channels,
    }),
  };
}

function lockedPanel(
  xDisplay: Float64Array,
  yDisplay: Float64Array,
  xRaw: Float64Array,
  yRaw: Float64Array,
  validIndices: readonly number[],
  xRange: readonly [number, number],
  yRange: readonly [number, number],
): CompensationDensityPanel {
  const x: number[] = [];
  const y: number[] = [];
  let sourceZero = 0;
  let receiverZero = 0;
  let cornerZero = 0;
  for (const index of validIndices) {
    x.push(Math.max(xRange[0], Math.min(xRange[1], xDisplay[index])));
    y.push(Math.max(yRange[0], Math.min(yRange[1], yDisplay[index])));
    const xZero = Math.abs(xRaw[index]) <= 1e-12;
    const yZero = Math.abs(yRaw[index]) <= 1e-12;
    if (xZero) sourceZero++;
    if (yZero) receiverZero++;
    if (xZero && yZero) cornerZero++;
  }
  return {
    x,
    y,
    zeroPile: Object.freeze({ source: sourceZero, receiver: receiverZero, corner: cornerZero }),
  };
}

/** Build a pair without refitting its event IDs, transforms, or axes per assay layer. */
export function buildCompensationGlobalPairPreview(
  dataset: CompensationGlobalInspectorDataset,
  sourceKey: string,
  receiverKey: string,
): CompensationGlobalPairPreviewResult {
  const source = dataset.channels.get(sourceKey);
  const receiver = dataset.channels.get(receiverKey);
  if (!source || !receiver) {
    return { ready: false, reason: "One or both channels are absent from the frozen global-inspector dataset." };
  }
  const validIndices: number[] = [];
  for (let index = 0; index < dataset.eventIndices.length; index++) {
    if ([
      source.originalDisplay[index],
      receiver.originalDisplay[index],
      source.compensatedDisplay[index],
      receiver.compensatedDisplay[index],
    ].every(Number.isFinite)) validIndices.push(index);
  }
  return {
    ready: true,
    preview: Object.freeze({
      eventCount: validIndices.length,
      totalEvents: dataset.eligibleEventCount,
      eventSignature: dataset.eventSignature,
      xRange: source.range,
      yRange: receiver.range,
      xTicks: source.ticks,
      yTicks: receiver.ticks,
      original: lockedPanel(
        source.originalDisplay,
        receiver.originalDisplay,
        source.originalRaw,
        receiver.originalRaw,
        validIndices,
        source.range,
        receiver.range,
      ),
      compensated: lockedPanel(
        source.compensatedDisplay,
        receiver.compensatedDisplay,
        source.compensatedRaw,
        receiver.compensatedRaw,
        validIndices,
        source.range,
        receiver.range,
      ),
    }),
  };
}

function densityCeiling(
  panel: CompensationDensityPanel,
  xRange: readonly [number, number],
  yRange: readonly [number, number],
  clipQuantile: number,
  smoothingRadius: number,
): number {
  const radius = Math.max(1, Math.min(24, Math.round(smoothingRadius) || 3));
  const gridSize = 256;
  const pad = radius;
  const extended = gridSize + 2 * pad;
  const grid = new Float64Array(extended * extended);
  const xSpan = Math.max(1e-12, xRange[1] - xRange[0]);
  const ySpan = Math.max(1e-12, yRange[1] - yRange[0]);
  for (let index = 0; index < panel.x.length; index++) {
    const gx = Math.max(0, Math.min(extended - 1,
      Math.floor((panel.x[index] - xRange[0]) / xSpan * gridSize) + pad));
    const gy = Math.max(0, Math.min(extended - 1,
      Math.floor((panel.y[index] - yRange[0]) / ySpan * gridSize) + pad));
    grid[gy * extended + gx]++;
  }
  const blurred = new Float64Array(extended * extended);
  const kernelArea = (radius * 2 + 1) ** 2;
  const integralStride = extended + 1;
  const integral = new Float64Array(integralStride * integralStride);
  for (let y = 0; y < extended; y++) {
    let rowTotal = 0;
    for (let x = 0; x < extended; x++) {
      rowTotal += grid[y * extended + x];
      integral[(y + 1) * integralStride + x + 1] = integral[y * integralStride + x + 1] + rowTotal;
    }
  }
  for (let y = radius; y < extended - radius; y++) {
    const y0 = y - radius;
    const y1 = y + radius + 1;
    for (let x = radius; x < extended - radius; x++) {
      const x0 = x - radius;
      const x1 = x + radius + 1;
      const sum = integral[y1 * integralStride + x1]
        - integral[y0 * integralStride + x1]
        - integral[y1 * integralStride + x0]
        + integral[y0 * integralStride + x0];
      blurred[y * extended + x] = sum / kernelArea;
    }
  }
  const occupied: number[] = [];
  for (let y = pad; y < pad + gridSize; y++) {
    for (let x = pad; x < pad + gridSize; x++) {
      const value = blurred[y * extended + x];
      if (value > 0) occupied.push(value);
    }
  }
  occupied.sort((left, right) => left - right);
  return occupied.length === 0 ? 1 : Math.max(1e-12, quantile(occupied, clipQuantile));
}

/**
 * Convert the user-facing smoothing setting into a density-grid radius that preserves the
 * same apparent blur in screen pixels as a compensation biplot is resized. The reference
 * geometry is GateLab's 220 px plot with its 170 px inner plotting area.
 */
export function compensationDensitySmoothingRadiusForPlot(
  smoothingSetting: number,
  plotSize: number,
): number {
  const setting = Math.max(1, Math.min(10, Number.isFinite(smoothingSetting) ? smoothingSetting : 6));
  const innerSize = Math.max(1, (Number.isFinite(plotSize) ? plotSize : 220) - 50);
  return Math.max(1, Math.min(24, setting * 170 / innerSize));
}

/** One density-colour ceiling shared by both assay layers for a locked pair. */
export function compensationSharedDensityCeiling(
  preview: Pick<CompensationGlobalPairPreview, "original" | "compensated" | "xRange" | "yRange">,
  clipQuantile = 0.95,
  smoothingRadius = 3,
  densityColorPower = DEFAULT_DENSITY_COLOR_POWER,
): number {
  const baseCeiling = Math.max(
    densityCeiling(preview.original, preview.xRange, preview.yRange, clipQuantile, smoothingRadius),
    densityCeiling(preview.compensated, preview.xRange, preview.yRange, clipQuantile, smoothingRadius),
  );
  return robustDensityColorCeiling(baseCeiling, densityColorPower);
}
