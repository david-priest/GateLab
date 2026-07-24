import type { Sample } from "./sample";
import { robustAxisRange } from "./axisRange";

export interface CombinedSamplePlotInput {
  id: string;
  name: string;
  sample: Sample;
  xIndex: number;
  yIndex: number;
  mask: Uint8Array | null;
  /** Optional per-event palette index, kept in lock-step with sampled points. */
  colors?: Uint8Array | null;
  /** Constant palette index (used for colouring by sample without a full-size array). */
  colorIndex?: number;
  /** Lazily resolve a palette index only for events that survive display sampling. */
  colorAt?: (eventIndex: number) => number;
}

export interface CombinedSamplePointCloud {
  x: Float32Array;
  y: Float32Array;
  colors: Uint8Array | null;
  /** Full selected-event count before display downsampling. */
  eventCount: number;
  sampleEventCounts: ReadonlyArray<{ id: string; name: string; eventCount: number }>;
}

export interface WorkspaceAxisRanges {
  xRange: [number, number];
  yRange: [number, number];
}

function countSelected(mask: Uint8Array | null, eventCount: number): number {
  if (!mask) return eventCount;
  let count = 0;
  const limit = Math.min(mask.length, eventCount);
  for (let index = 0; index < limit; index++) count += mask[index] ? 1 : 0;
  return count;
}

/**
 * Allocate one shared plot cap proportionally across files. Largest remainders
 * receive the spare slots, so the total never exceeds the requested cap and a
 * large workspace cannot silently multiply the main-plot point budget.
 */
export function allocateCombinedSampleCaps(
  counts: readonly number[],
  plotCap: number,
): number[] {
  const normalized = counts.map((count) => Math.max(0, Math.floor(count)));
  const total = normalized.reduce((sum, count) => sum + count, 0);
  if (!Number.isFinite(plotCap) || plotCap <= 0 || total <= plotCap) return normalized;

  const cap = Math.max(1, Math.floor(plotCap));
  const raw = normalized.map((count) => count > 0 ? (count * cap) / total : 0);
  const allocated = raw.map((value, index) => Math.min(normalized[index], Math.floor(value)));
  let remaining = cap - allocated.reduce((sum, count) => sum + count, 0);

  const order = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .filter(({ index }) => normalized[index] > allocated[index])
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (remaining <= 0) break;
    allocated[index]++;
    remaining--;
  }

  // With more non-empty files than points, the remainder pass may exhaust all
  // candidates after one slot each. Fill any pathological residual deterministically.
  for (let index = 0; remaining > 0 && index < allocated.length; index++) {
    const room = normalized[index] - allocated[index];
    if (room <= 0) continue;
    const add = Math.min(room, remaining);
    allocated[index] += add;
    remaining -= add;
  }
  return allocated;
}

function sampledMemberPositions(memberCount: number, sampleCount: number): Int32Array | null {
  if (sampleCount >= memberCount) return null;
  const positions = new Int32Array(sampleCount);
  const denominator = sampleCount > 1 ? sampleCount - 1 : 1;
  for (let index = 0; index < sampleCount; index++) {
    positions[index] = Math.round((index * (memberCount - 1)) / denominator);
  }
  return positions;
}

/**
 * Build one deterministic point cloud from compatible checked files. This only
 * reads display columns and precomputed population masks; gating for inactive
 * files is deliberately handled outside this helper so it can be scheduled
 * between browser paints rather than blocking gate interaction.
 */
export function buildCombinedSamplePointCloud(
  inputs: readonly CombinedSamplePlotInput[],
  plotCap: number,
): CombinedSamplePointCloud {
  const counts = inputs.map((input) =>
    countSelected(input.mask, Math.min(
      input.sample.fcs.nEvents,
      input.sample.displayColumn(input.xIndex).length,
      input.sample.displayColumn(input.yIndex).length,
    )));
  const caps = allocateCombinedSampleCaps(counts, plotCap);
  const plottedCount = caps.reduce((sum, count) => sum + count, 0);
  const x = new Float32Array(plottedCount);
  const y = new Float32Array(plottedCount);
  const includeColors = inputs.some((input) =>
    (input.colors !== undefined && input.colors !== null) ||
    input.colorIndex !== undefined ||
    input.colorAt !== undefined);
  const colors = includeColors ? new Uint8Array(plottedCount) : null;

  let outputIndex = 0;
  inputs.forEach((input, inputIndex) => {
    const selectedCount = counts[inputIndex];
    const sampleCount = caps[inputIndex];
    if (selectedCount === 0 || sampleCount === 0) return;

    const xColumn = input.sample.displayColumn(input.xIndex);
    const yColumn = input.sample.displayColumn(input.yIndex);
    const limit = Math.min(input.sample.fcs.nEvents, xColumn.length, yColumn.length);
    const sampledPositions = sampledMemberPositions(selectedCount, sampleCount);
    let memberPosition = 0;
    let sampledIndex = 0;

    for (let eventIndex = 0; eventIndex < limit && sampledIndex < sampleCount; eventIndex++) {
      if (input.mask && !input.mask[eventIndex]) continue;
      const take = sampledPositions === null ||
        memberPosition === sampledPositions[sampledIndex];
      if (take) {
        x[outputIndex] = xColumn[eventIndex];
        y[outputIndex] = yColumn[eventIndex];
        if (colors) {
          colors[outputIndex] =
            input.colors?.[eventIndex] ??
            input.colorAt?.(eventIndex) ??
            input.colorIndex ??
            0;
        }
        outputIndex++;
        sampledIndex++;
      }
      memberPosition++;
    }
  });

  return {
    x,
    y,
    colors,
    eventCount: counts.reduce((sum, count) => sum + count, 0),
    sampleEventCounts: inputs.map((input, index) => ({
      id: input.id,
      name: input.name,
      eventCount: counts[index],
    })),
  };
}

/**
 * Compute one stable automatic frame from every compatible file in the workspace.
 *
 * This deliberately ignores the checked-file display subset. Checking files changes
 * which events are drawn, but must not make axes jump while a user compares samples.
 * The deterministic shared cap also prevents range calculation from multiplying the
 * point budget by the number of loaded FCS files.
 */
export function buildWorkspaceAxisRanges(
  inputs: readonly CombinedSamplePlotInput[],
  rangeSampleCap = 100_000,
): WorkspaceAxisRanges | null {
  if (inputs.length === 0) return null;
  const cloud = buildCombinedSamplePointCloud(
    inputs.map((input) => ({
      ...input,
      mask: null,
      colors: null,
      colorIndex: undefined,
      colorAt: undefined,
    })),
    rangeSampleCap,
  );
  if (cloud.x.length === 0 || cloud.y.length === 0) return null;
  return {
    xRange: robustAxisRange(cloud.x),
    yRange: robustAxisRange(cloud.y),
  };
}
