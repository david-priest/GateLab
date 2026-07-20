// strategy.ts — gating-strategy step computation, ported from GateLabR strategy_utils.R
// (compute_gating_strategy) + the render_strategy_tab payload assembly (app.R:6307-6620).
//
// For a target population, walk the ancestry root→pop, apply each gate ref sequentially on a
// running mask, and per step plot the PARENT events (before that gate) in DISPLAY space on the
// gate's channels, with the gate overlay + pct_pass. Masks are computed in GATING space (raw
// for flow) so counts match GateLab's population tree; the plotted values are display-space.
// When both forward+back are shown, the final population's events overlay in orange.

import type { Sample } from "./sample";
import type { Gate, GateRef, PopulationMap } from "./models";
import { getGateMask, type AssayData } from "./gates";
import type { AxisTicks } from "./ticks";
import { displayLabelOffset } from "../plots/gatePayload";

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
  n_before: number;
  n_after: number;
  n_total: number;
  pct_pass: number;
  pct_total: number;
  pop_name: string;
}

/** Display-space overlay vertices for a gate (rectangles → AABB corners). */
function displayVerticesOf(sample: Sample, gate: Gate): [number, number][] {
  if (gate.gate_type === "quadrant") return [];
  const toD = (vx: number, vy: number): [number, number] => [
    sample.gatingToDisplay(gate.x_channel, vx),
    sample.gatingToDisplay(gate.y_channel, vy),
  ];
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

export function computeGatingStrategy(
  sample: Sample,
  gates: Record<string, Gate>,
  populations: PopulationMap,
  rootId: string,
  populationId: string,
  opts: StrategyOptions,
): StrategyStep[] {
  const useAll = !Number.isFinite(opts.maxEvents) || opts.maxEvents <= 0;
  const cap = opts.maxEvents;
  const pop = populations[populationId];
  if (!pop) return [];

  // Ordered gate refs (root→pop if fullPath, else this pop's).
  const allRefs: { ref: GateRef; popName: string }[] = [];
  if (opts.fullPath) {
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

  const data: AssayData = sample.gatingData();
  const n = sample.fcs.nEvents;
  let running = new Uint8Array(n).fill(1);
  const steps: StrategyStep[] = [];

  for (const { ref, popName } of allRefs) {
    const gate = gates[ref.gate_id];
    if (!gate) continue;

    let nBefore = 0;
    for (let i = 0; i < n; i++) if (running[i]) nBefore++;
    if (nBefore === 0) break;

    const gm = getGateMask(gate, data, ref.quadrant);
    const newMask = new Uint8Array(n);
    let nAfter = 0;
    for (let i = 0; i < n; i++) {
      const pass = ref.include ? gm[i] : !gm[i];
      const v = running[i] && pass ? 1 : 0;
      newMask[i] = v;
      if (v) nAfter++;
    }
    const pctPass = nBefore > 0 ? round1((nAfter / nBefore) * 100) : 0;

    // Parent events (running BEFORE this gate), downsampled evenly (round(seq(1,N,len=cap))).
    const parentIdx: number[] = [];
    for (let i = 0; i < n; i++) if (running[i]) parentIdx.push(i);
    let sampleIdx = parentIdx;
    if (!useAll && parentIdx.length > cap) {
      sampleIdx = new Array(cap);
      const denom = cap > 1 ? cap - 1 : 1;
      for (let k = 0; k < cap; k++) sampleIdx[k] = parentIdx[Math.round((k * (parentIdx.length - 1)) / denom)];
    }

    const xIdx = sample.index(gate.x_channel);
    const yIdx = sample.index(gate.y_channel);
    const xCol = xIdx !== undefined ? sample.displayColumn(xIdx) : null;
    const yCol = yIdx !== undefined ? sample.displayColumn(yIdx) : null;
    const x = sampleIdx.map((i) => (xCol ? xCol[i] : NaN));
    const y = sampleIdx.map((i) => (yCol ? yCol[i] : NaN));

    steps.push({
      gate_id: gate.gate_id,
      gate_name: gate.name,
      x_channel: gate.x_channel,
      y_channel: gate.y_channel,
      gate_type: gate.gate_type,
      color: gate.color,
      label_offset: gate.label_offset,
      include: ref.include,
      x,
      y,
      displayVertices: displayVerticesOf(sample, gate),
      n_before: nBefore,
      n_after: nAfter,
      n_total: n,
      pct_pass: pctPass,
      pct_total: n > 0 ? round1((nAfter / n) * 100) : 0,
      pop_name: popName,
    });

    running = newMask;
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
  fontSizes: StrategyFontSizes;
  contextTitle?: string;
}

/** Assemble the object passed to CytofMiniPlot.renderStrategyGrid. */
export function buildStrategyPayload(
  sample: Sample,
  steps: StrategyStep[],
  finalMask: Uint8Array | null,
  globalScales: Record<string, [number, number]>,
  opts: StrategyPayloadOptions,
): Record<string, unknown> {
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
  const stableRange = new Map<string, [number, number]>();
  for (const ch of channels) {
    const idx = sample.index(ch);
    if (idx === undefined) continue;
    stableRange.set(ch, globalScales[ch] ?? computeRangeFromValues(sample.displayColumn(idx)));
  }

  // Back-gated (final population) display values on each step's channels, downsampled.
  const backValues = (ch: string): number[] => {
    const idx = sample.index(ch);
    if (!finalMask || idx === undefined) return [];
    const col = sample.displayColumn(idx);
    const vals: number[] = [];
    for (let i = 0; i < finalMask.length; i++) if (finalMask[i]) vals.push(col[i]);
    if (!useAll && vals.length > cap) {
      const out = new Array<number>(cap);
      const denom = cap > 1 ? cap - 1 : 1;
      for (let k = 0; k < cap; k++) out[k] = vals[Math.round((k * (vals.length - 1)) / denom)];
      return out;
    }
    return vals;
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
    gate_style: { pub_style: opts.pubStyle, line_width: opts.gateLineWidth },
  };
}
