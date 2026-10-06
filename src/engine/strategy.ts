// strategy.ts — gating-strategy step computation, ported from GateLabR strategy_utils.R
// (compute_gating_strategy) + the render_strategy_tab payload assembly (app.R:6307-6620).
//
// For a target population, walk the ancestry root→pop, apply each gate ref sequentially on a
// running mask, and per step plot the PARENT events (before that gate) in DISPLAY space on the
// gate's channels, with the gate overlay + pct_pass. Masks are computed in GATING space (raw
// for flow) so counts match GateLab's population tree; the plotted values are display-space.
// When both forward+back are shown, the final population's events overlay in orange.
//
// The pieces are exported one by one (the path's masks, the even thinning, a step from a mask,
// the payload from several files' parts) so pooledStrategy.ts can draw the same steps from
// several files' events together.

import type { Sample } from "./sample";
import { ellipseBoundary } from "./ellipse";
import type { GateEdgeMode } from "../ui/gateEdgeModes";
import type { Gate, GateRef, PopulationMap } from "./models";
import { columnsForGate, getGateMask, type GateAssayData } from "./gates";
import type { AxisTicks } from "./ticks";
import { displayLabelOffset, polygonOutline } from "../plots/gatePayload";
import { allocateCombinedSampleCaps } from "./multiSamplePlot";

const round1 = (x: number): number => Math.round(x * 10) / 10;

// ── Range helpers (ported from app.R compute_range_from_values / expand_range_for_vertices) ──
const STRATEGY_SPAN_SCALE = 1.2;

export function computeRangeFromValues(vals: ArrayLike<number>, spanScale = STRATEGY_SPAN_SCALE): [number, number] {
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (Number.isFinite(v)) {
      if (v < low) low = v;
      if (v > high) high = v;
    }
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return [0, 1];
  let span = high - low;
  if (!Number.isFinite(span) || span < 1e-10) span = 1;
  const out: [number, number] = [low - span * 0.05, high + span * Math.max(0, spanScale - 1)];
  if (low >= 0) out[0] = Math.min(0, out[0]);
  return out;
}

// ── Step computation ─────────────────────────────────────────────────────────
export interface StrategyStep {
  gate_id: string;
  gate_name: string;
  x_channel: string;
  y_channel: string;
  gate_type: string;
  color: string;
  label_offset: [number, number] | null;
  include: boolean;
  x: number[]; // parent events, display space, gate's x channel
  y: number[];
  displayVertices: [number, number][]; // gate overlay, display space
  outline?: [number, number][]; // true boundary, only when the transform bends the edges
  n_before: number;
  n_after: number;
  n_total: number;
  pct_pass: number;
  pct_total: number;
  pop_name: string;
}

/**
 * True display-space boundary for a gate, present only when the transform actually bends it.
 *
 * A gate is straight in the space it was drawn in and bows once an axis is shown on a different
 * scale. Rectangles are axis-aligned boxes in display space and provably cannot bow.
 */
function outlineOf(sample: Sample, gate: Gate, displayVerts: [number, number][]) {
  if (gate.gate_type === "quadrant" || gate.gate_type === "rectangle") return undefined;
  return polygonOutline(
    gate.gate_type === "ellipse" ? ellipseBoundary(gate) : gate.vertices,
    (pt) => [
      sample.gateToDisplay(gate, gate.x_channel, pt[0]),
      sample.gateToDisplay(gate, gate.y_channel, pt[1]),
    ],
    displayVerts,
  );
}

/** Display-space overlay vertices for a gate (rectangles → AABB corners). */
function displayVerticesOf(sample: Sample, gate: Gate): [number, number][] {
  if (gate.gate_type === "quadrant") return [];
  const toD = (vx: number, vy: number): [number, number] => [
    sample.gateToDisplay(gate, gate.x_channel, vx),
    sample.gateToDisplay(gate, gate.y_channel, vy),
  ];
  if (gate.gate_type === "ellipse") return ellipseBoundary(gate).map(([vx, vy]) => toD(vx, vy));
  if (gate.gate_type === "rectangle") {
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const [vx, vy] of gate.vertices) {
      if (vx < xmin) xmin = vx;
      if (vx > xmax) xmax = vx;
      if (vy < ymin) ymin = vy;
      if (vy > ymax) ymax = vy;
    }
    return [toD(xmin, ymin), toD(xmax, ymin), toD(xmax, ymax), toD(xmin, ymax)];
  }
  return gate.vertices.map(([vx, vy]) => toD(vx, vy));
}

export interface StrategyOptions {
  fullPath: boolean;
  maxEvents: number; // 0/Infinity = all
}

/** One gate of a population's path, with the events before and after it, before any thinning. */
export interface StrategyStepMask {
  gate: Gate;
  ref: GateRef;
  popName: string;
  /** The running population before this gate: 1 for an event still in it. */
  before: Uint8Array;
  nBefore: number;
  nAfter: number;
}

/**
 * The gates of a population's path (root→pop when `fullPath`, else the population's own), each
 * applied in turn on a running mask in gating space. Every gate of the path is returned, one
 * whose running population is empty with zero counts, so two files' paths line up step by step.
 */
export function strategyStepMasks(
  sample: Sample,
  gates: Record<string, Gate>,
  populations: PopulationMap,
  rootId: string,
  populationId: string,
  fullPath: boolean,
): StrategyStepMask[] {
  const pop = populations[populationId];
  if (!pop) return [];

  // Ordered gate refs (root→pop if fullPath, else this pop's).
  const allRefs: { ref: GateRef; popName: string }[] = [];
  if (fullPath) {
    const ancestry: string[] = [];
    let cur: string | null = populationId;
    while (cur && cur !== rootId) {
      ancestry.unshift(cur);
      cur = populations[cur]?.parent_id ?? null;
    }
    for (const ancId of ancestry) {
      const anc = populations[ancId];
      for (const ref of anc?.gate_refs ?? []) allRefs.push({ ref, popName: anc.name });
    }
  } else {
    for (const ref of pop.gate_refs ?? []) allRefs.push({ ref, popName: pop.name });
  }
  if (allRefs.length === 0) return [];

  const data: GateAssayData = sample.gateAssayData();
  const n = sample.fcs.nEvents;
  let running = new Uint8Array(n).fill(1);
  const steps: StrategyStepMask[] = [];

  for (const { ref, popName } of allRefs) {
    const gate = gates[ref.gate_id];
    if (!gate) continue;

    let nBefore = 0;
    for (let i = 0; i < n; i++) if (running[i]) nBefore++;

    const gm = getGateMask(gate, columnsForGate(data, gate), ref.quadrant);
    const newMask = new Uint8Array(n);
    let nAfter = 0;
    for (let i = 0; i < n; i++) {
      const pass = ref.include ? gm[i] : !gm[i];
      const v = running[i] && pass ? 1 : 0;
      newMask[i] = v;
      if (v) nAfter++;
    }
    steps.push({ gate, ref, popName, before: running, nBefore, nAfter });
    running = newMask;
  }

  return steps;
}

/** The values thinned evenly to `cap` when there are more (0 or Infinity: all), as R's round(seq(1, N, length.out = cap)). */
export function thinEvenly<T>(values: T[], cap: number): T[] {
  if (!Number.isFinite(cap) || cap <= 0 || values.length <= cap) return values;
  const out = new Array<T>(cap);
  const denom = cap > 1 ? cap - 1 : 1;
  for (let k = 0; k < cap; k++) out[k] = values[Math.round((k * (values.length - 1)) / denom)];
  return out;
}

/** The indices of the set events, thinned evenly to `cap` (0 or Infinity: all). */
export function evenIndices(mask: Uint8Array, cap: number): number[] {
  const all: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) all.push(i);
  return thinEvenly(all, cap);
}

/** The events' values on a channel in display space; NaN when the file lacks the channel. */
export function displayValues(sample: Sample, channel: string, indices: readonly number[]): number[] {
  const idx = sample.index(channel);
  const col = idx !== undefined ? sample.displayColumn(idx) : null;
  return indices.map((i) => (col ? col[i] : NaN));
}

/**
 * A step as drawn: the mask's gate on `sample`'s display space with the points and counts
 * given. `drawn` false leaves the gate's boundary off the plot (its percentage stays in the
 * title), which is how a pooled step shows a gate the files do not hold alike.
 */
export function strategyStepOf(
  sample: Sample,
  mask: StrategyStepMask,
  x: number[],
  y: number[],
  counts: { nBefore: number; nAfter: number; nTotal: number },
  drawn = true,
): StrategyStep {
  const gate = mask.gate;
  const displayVerts = drawn ? displayVerticesOf(sample, gate) : [];
  return {
    gate_id: gate.gate_id,
    gate_name: gate.name,
    x_channel: gate.x_channel,
    y_channel: gate.y_channel,
    gate_type: gate.gate_type,
    color: gate.color,
    label_offset: gate.label_offset,
    include: mask.ref.include,
    x,
    y,
    displayVertices: displayVerts,
    outline: drawn ? outlineOf(sample, gate, displayVerts) : undefined,
    n_before: counts.nBefore,
    n_after: counts.nAfter,
    n_total: counts.nTotal,
    pct_pass: counts.nBefore > 0 ? round1((counts.nAfter / counts.nBefore) * 100) : 0,
    pct_total: counts.nTotal > 0 ? round1((counts.nAfter / counts.nTotal) * 100) : 0,
    pop_name: mask.popName,
  };
}

export function computeGatingStrategy(
  sample: Sample,
  gates: Record<string, Gate>,
  populations: PopulationMap,
  rootId: string,
  populationId: string,
  opts: StrategyOptions,
): StrategyStep[] {
  const n = sample.fcs.nEvents;
  const steps: StrategyStep[] = [];
  for (const mask of strategyStepMasks(sample, gates, populations, rootId, populationId, opts.fullPath)) {
    // The path ends where its population runs out.
    if (mask.nBefore === 0) break;
    // Parent events (running BEFORE this gate), downsampled evenly (round(seq(1,N,len=cap))).
    const indices = evenIndices(mask.before, opts.maxEvents);
    steps.push(strategyStepOf(
      sample,
      mask,
      displayValues(sample, mask.gate.x_channel, indices),
      displayValues(sample, mask.gate.y_channel, indices),
      { nBefore: mask.nBefore, nAfter: mask.nAfter, nTotal: n },
    ));
  }
  return steps;
}

// ── renderStrategyGrid payload assembly (app.R render_strategy_tab) ──────────────
export interface StrategyFontSizes {
  tick: number;
  axis_label: number;
  gate_label: number;
  title: number;
}
export interface StrategyPayloadOptions {
  gateView: ("forward" | "back")[];
  displayMode: string;
  maxEvents: number;
  nColumns: number;
  plotSize: number;
  fitToColumns: boolean;
  contourThreshold: number;
  pointAlpha: number;
  densityColorPower: number;
  pointSize: number;
  kdeBandwidth: number; // contour smoothing (0 = auto)
  pubStyle: boolean; // black gates, no label background
  gateLineWidth: number;
  gateEdgeMode?: GateEdgeMode;
  /** What a gate's label says; the renderer reads it as gate_style.label_format. */
  gateLabelFormat?: string;
  fontSizes: StrategyFontSizes;
  contextTitle?: string;
}

/** One file on a strategy plot: its sample and, for back-gating, the final population's events. */
export interface StrategyPart {
  sample: Sample;
  finalMask: Uint8Array | null;
}

/** Assemble the object passed to CytofMiniPlot.renderStrategyGrid. */
export function buildStrategyPayload(
  sample: Sample,
  steps: StrategyStep[],
  finalMask: Uint8Array | null,
  globalScales: Record<string, [number, number]>,
  opts: StrategyPayloadOptions,
): Record<string, unknown> {
  return strategyPayload([{ sample, finalMask }], steps, globalScales, opts);
}

/**
 * The payload for steps pooled over several files: the first file's axes, ticks and labels, a
 * channel's range over every file when no global scale sets it, and the back-gated events of
 * every file with the cap shared out by population size.
 */
export function buildPooledStrategyPayload(
  parts: readonly StrategyPart[],
  steps: StrategyStep[],
  globalScales: Record<string, [number, number]>,
  opts: StrategyPayloadOptions,
): Record<string, unknown> {
  return strategyPayload(parts, steps, globalScales, opts);
}

function strategyPayload(
  parts: readonly StrategyPart[],
  steps: StrategyStep[],
  globalScales: Record<string, [number, number]>,
  opts: StrategyPayloadOptions,
): Record<string, unknown> {
  const sample = parts[0].sample;
  const showForward = opts.gateView.includes("forward");
  const showBack = opts.gateView.includes("back");
  const useAll = !Number.isFinite(opts.maxEvents) || opts.maxEvents <= 0;
  const cap = opts.maxEvents;

  // Stable per-channel range (global scale, else span-1.2 over ALL display values).
  const channels = new Set<string>();
  for (const s of steps) {
    channels.add(s.x_channel);
    channels.add(s.y_channel);
  }
  // GLOBAL scale per channel: the global-scale override, else the channel's full display
  // range — identical to the main Gating plot and every other panel (no per-plot fitting).
  // Pooled, the range covers every file's values.
  const stableRange = new Map<string, [number, number]>();
  for (const ch of channels) {
    if (sample.index(ch) === undefined) continue;
    if (globalScales[ch]) {
      stableRange.set(ch, globalScales[ch]);
      continue;
    }
    let range: [number, number] | null = null;
    for (const part of parts) {
      const idx = part.sample.index(ch);
      if (idx === undefined) continue;
      const own = computeRangeFromValues(part.sample.displayColumn(idx));
      range = range ? [Math.min(range[0], own[0]), Math.max(range[1], own[1])] : own;
    }
    if (range) stableRange.set(ch, range);
  }

  // Back-gated (final population) display values on each step's channels, each file's thinned
  // to its share of the cap.
  const finalCounts = parts.map((part) => {
    let count = 0;
    if (part.finalMask) for (let i = 0; i < part.finalMask.length; i++) if (part.finalMask[i]) count++;
    return count;
  });
  const backCaps = useAll ? finalCounts : allocateCombinedSampleCaps(finalCounts, cap);
  const backValues = (ch: string): number[] => {
    const out: number[][] = [];
    parts.forEach((part, index) => {
      const idx = part.sample.index(ch);
      if (!part.finalMask || idx === undefined) return;
      const col = part.sample.displayColumn(idx);
      const vals: number[] = [];
      for (let i = 0; i < part.finalMask.length; i++) if (part.finalMask[i]) vals.push(col[i]);
      out.push(thinEvenly(vals, useAll ? 0 : Math.max(1, backCaps[index])));
    });
    return out.flat();
  };

  const stepsJson = steps.map((s) => {
    const xBackFull = showBack ? backValues(s.x_channel) : [];
    const yBackFull = showBack ? backValues(s.y_channel) : [];
    const xMain = showForward ? s.x : xBackFull;
    const yMain = showForward ? s.y : yBackFull;

    const xIdxR = sample.index(s.x_channel);
    const yIdxR = sample.index(s.y_channel);
    const xRange = stableRange.get(s.x_channel) ?? (xIdxR !== undefined ? sample.displayRange(xIdxR) : [0, 1]);
    const yRange = stableRange.get(s.y_channel) ?? (yIdxR !== undefined ? sample.displayRange(yIdxR) : [0, 1]);

    const xIdx = sample.index(s.x_channel);
    const yIdx = sample.index(s.y_channel);
    const xTicks: AxisTicks | null = xIdx !== undefined ? sample.channelTicks(xIdx, xRange) : null;
    const yTicks: AxisTicks | null = yIdx !== undefined ? sample.channelTicks(yIdx, yRange) : null;

    return {
      gate_id: s.gate_id,
      gate_name: s.gate_name,
      // Axis labels only — use the Panel display name (identity keys drive the math above).
      x_channel: sample.labelForKey(s.x_channel),
      y_channel: sample.labelForKey(s.y_channel),
      vertices: s.displayVertices,
      outline: s.outline,
      gate_type: s.gate_type,
      color: s.color,
      // Same label position as the main plot: user-set offset, else the auto "above the gate".
      label_offset: s.label_offset ?? displayLabelOffset(s.displayVertices),
      include: s.include,
      x: xMain,
      y: yMain,
      x_back: showForward && showBack ? xBackFull : [],
      y_back: showForward && showBack ? yBackFull : [],
      x_range: xRange,
      y_range: yRange,
      x_is_logicle: xTicks !== null,
      x_logicle_ticks: xTicks,
      y_is_logicle: yTicks !== null,
      y_logicle_ticks: yTicks,
      n_before: s.n_before,
      n_after: s.n_after,
      pct_pass: s.pct_pass,
      pct_total: s.pct_total,
    };
  });

  return {
    containerId: "strategy-grid-container",
    steps: stepsJson,
    strategy_context_title: opts.contextTitle,
    gate_view: opts.gateView,
    display_mode: opts.displayMode,
    plot_size: opts.plotSize,
    n_columns: opts.nColumns,
    fit_to_columns: opts.fitToColumns,
    contour_threshold: opts.contourThreshold,
    point_alpha: opts.pointAlpha,
    density_color_power: opts.densityColorPower,
    point_size: opts.pointSize,
    kde_bandwidth: opts.kdeBandwidth,
    font_sizes: opts.fontSizes,
    gate_style: {
      pub_style: opts.pubStyle,
      line_width: opts.gateLineWidth,
      gate_edge_mode: opts.gateEdgeMode ?? "straight-bow",
      label_format: opts.gateLabelFormat ?? "name-percent",
    },
  };
}
