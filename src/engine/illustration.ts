// illustration.ts — the Illustration tab data, ported from GateLabR strategy_utils.R
// (compute_illustration_batch + build_gates_for_channels) and render_illustration_tab
// (app.R:7689-8060). A grid of populations (rows) × x-channels (cols), each cell showing the
// population's events on (x_channel, y_channel) with the gates on that channel pair overlaid.
// Rendered through the reused mini_plot.js CytofMiniPlot.renderIllustrationGrid so output matches.

import type { Sample } from "./sample";
import type { Gate, PopulationMap } from "./models";
import { computeGateCounts, type GateCount } from "./populations";
import type { AxisTicks } from "./ticks";
import { displayLabelOffset } from "../plots/gatePayload";
import { computeRangeFromValues } from "./strategy";

/** Even-spaced downsample of masked event indices (round(seq(1,N,len=cap))). */
function sampledIndices(mask: Uint8Array, cap: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
  const useAll = !Number.isFinite(cap) || cap <= 0;
  if (useAll || idx.length <= cap) return idx;
  const out = new Array<number>(cap);
  const denom = cap > 1 ? cap - 1 : 1;
  for (let k = 0; k < cap; k++) out[k] = idx[Math.round((k * (idx.length - 1)) / denom)];
  return out;
}

interface GateOverlay {
  gate_id: string;
  name: string;
  percent_of_parent: number | null;
  gate_type: string;
  vertices: [number, number][];
  color: string;
  label_offset: [number, number] | null;
}

/**
 * Gates drawn on a specific (xCh, yCh) pair — exact or flipped orientation, in display space.
 * Port of build_gates_for_channels; percent_of_parent from the population's gate counts.
 */
function buildGatesForChannels(
  sample: Sample,
  gates: Record<string, Gate>,
  gateOrder: string[],
  gateCounts: Record<string, GateCount>,
  xCh: string,
  yCh: string | null,
): GateOverlay[] {
  if (!yCh) return [];
  const out: GateOverlay[] = [];
  const ids = gateOrder.length ? gateOrder : Object.keys(gates);
  for (const gid of ids) {
    const gate = gates[gid];
    if (!gate || gate.gate_type === "quadrant") continue;

    let flipped: boolean;
    if (gate.x_channel === xCh && gate.y_channel === yCh) flipped = false;
    else if (gate.x_channel === yCh && gate.y_channel === xCh) flipped = true;
    else continue;

    // Gate vertices (gating space) → display space on the cell's (xCh, yCh) axes.
    const raw = gate.gate_type === "rectangle" ? aabbCorners(gate.vertices) : gate.vertices;
    const verts: [number, number][] = raw.map(([vx, vy]) => {
      // (vx,vy) are in (gate.x_channel, gate.y_channel) space.
      const cellX = flipped ? vy : vx; // value on xCh
      const cellY = flipped ? vx : vy; // value on yCh
      return [sample.gatingToDisplay(xCh, cellX), sample.gatingToDisplay(yCh, cellY)];
    });

    const c = gateCounts[gid];
    out.push({
      gate_id: gid,
      name: gate.name,
      percent_of_parent: c?.percent_of_parent ?? null,
      gate_type: gate.gate_type,
      vertices: verts,
      color: gate.color,
      label_offset: gate.label_offset ?? displayLabelOffset(verts),
    });
  }
  return out;
}

function aabbCorners(vertices: [number, number][]): [number, number][] {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const [vx, vy] of vertices) {
    if (vx < xmin) xmin = vx;
    if (vx > xmax) xmax = vx;
    if (vy < ymin) ymin = vy;
    if (vy > ymax) ymax = vy;
  }
  return [[xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax]];
}

export interface IllustrationFontSizes {
  tick: number;
  axis_label: number;
  gate_label: number;
  title: number;
}

// Every knob mini_plot.js renderIllustrationGrid reads (app.R collect_style_params + render site).
export interface IllustrationOptions {
  displayMode: string;
  maxEvents: number;
  nColumns: number;
  plotSize: number;
  fitToColumns: boolean;
  contourThreshold: number;
  pointAlpha: number;
  pointSize: number;
  kdeBandwidth: number; // contour smoothing (0 = auto)
  colorByPop: boolean;
  overlayPops: boolean; // one panel per channel, all populations overlaid
  populationColors: Record<string, string>; // per-population hex overrides
  histLineWidth: number;
  histFill: boolean;
  histFillAlpha: number;
  histOverlayMode: string; // "blend" | "front_opaque"
  histLayout: string; // "grid" | "ridgeline"
  ridgeOverlap: number;
  ridgeColGap: number;
  ridgeGradient: boolean; // heat gradient (black→yellow) fill
  pubStyle: boolean; // black gates, no label background
  gateLineWidth: number;
  fontSizes: IllustrationFontSizes;
}

/** Assemble the object passed to CytofMiniPlot.renderIllustrationGrid. */
export function buildIllustrationPayload(
  sample: Sample,
  gates: Record<string, Gate>,
  gateOrder: string[],
  populations: PopulationMap,
  masks: Record<string, Uint8Array>,
  eventCount: Record<string, number | null>,
  popIds: string[],
  xChannels: string[],
  yChannel: string | null,
  globalScales: Record<string, [number, number]>,
  opts: IllustrationOptions,
): Record<string, unknown> {
  const data = sample.gatingData();
  // Preview point budget: cap per-panel events so a large max-events × many pop×channel panels
  // can't lock the browser up (app.R:7751-7761). Full max-events is reserved for export.
  const nPanels = Math.max(1, popIds.length) * Math.max(1, xChannels.length);
  const PREVIEW_POINT_BUDGET = 300_000;
  const cap = Math.min(opts.maxEvents, Math.max(500, Math.floor(PREVIEW_POINT_BUDGET / nPanels)));

  // GLOBAL scale per channel: the global-scale override, else the channel's full display range
  // with R's asymmetric 5%-below / 20%-above padding (computeRangeFromValues) so headroom + axis
  // origin match GateLabR — identical stable range across the Strategy panels (no per-plot fitting).
  const rangeFor = (ch: string): [number, number] => {
    const idx = sample.index(ch);
    if (idx === undefined) return [0, 1];
    return globalScales[ch] ?? computeRangeFromValues(sample.displayColumn(idx));
  };
  const xRangeByChannel = new Map<string, [number, number]>();
  for (const ch of xChannels) xRangeByChannel.set(ch, rangeFor(ch));
  const yRange = yChannel ? rangeFor(yChannel) : null;
  const yIdx = yChannel ? sample.index(yChannel) : undefined;
  const yCol = yIdx !== undefined ? sample.displayColumn(yIdx) : null;

  const ticksFor = (ch: string, range: [number, number]): AxisTicks | null => {
    const idx = sample.index(ch);
    return idx !== undefined ? sample.channelTicks(idx, range) : null;
  };
  const yTicks = yChannel && yRange ? ticksFor(yChannel, yRange) : null;

  const plots: Record<string, unknown> = {};
  const gateOverlays: Record<string, unknown> = {};
  const popNames: Record<string, string> = {};
  const popCounts: Record<string, number> = {};

  for (const popId of popIds) {
    const mask = masks[popId];
    if (!mask) continue;
    const sampleIdx = sampledIndices(mask, cap);
    const nPop = eventCount[popId] ?? sampleIdx.length;
    popNames[popId] = populations[popId]?.name ?? popId;
    popCounts[popId] = nPop;
    if (sampleIdx.length === 0) continue;

    const gateCounts = computeGateCounts(gates, mask, data);

    for (const xCh of xChannels) {
      const xIdx = sample.index(xCh);
      if (xIdx === undefined) continue;
      const xCol = sample.displayColumn(xIdx);
      const x = sampleIdx.map((i) => xCol[i]);
      const y = yCol ? sampleIdx.map((i) => yCol[i]) : [];
      const xr = xRangeByChannel.get(xCh) ?? [0, 1];
      const key = `${popId}|${xCh}`;
      plots[key] = {
        x,
        y,
        x_range: xr,
        y_range: yRange,
        n_events: nPop,
        x_label: sample.labelForKey(xCh),
        y_label: yChannel ? sample.labelForKey(yChannel) : yChannel,
        x_is_logicle: (() => (ticksFor(xCh, xr) !== null))(),
        x_logicle_ticks: ticksFor(xCh, xr),
        y_is_logicle: yTicks !== null,
        y_logicle_ticks: yTicks,
      };
      gateOverlays[key] = buildGatesForChannels(sample, gates, gateOrder, gateCounts, xCh, yChannel);
    }
  }

  return {
    containerId: "illustration-grid-container",
    plots,
    gate_overlays: gateOverlays,
    pop_ids: popIds,
    pop_names: popNames,
    pop_counts: popCounts,
    x_channels: xChannels,
    y_channel: yChannel,
    display_mode: opts.displayMode,
    plot_size: opts.plotSize,
    n_columns: opts.nColumns,
    fit_to_columns: opts.fitToColumns,
    contour_threshold: opts.contourThreshold,
    point_alpha: opts.pointAlpha,
    point_size: opts.pointSize,
    kde_bandwidth: opts.kdeBandwidth,
    color_by_population: opts.colorByPop,
    overlay_populations: opts.overlayPops,
    population_colors: opts.populationColors,
    hist_line_width: opts.histLineWidth,
    hist_fill: opts.histFill,
    hist_fill_alpha: opts.histFillAlpha,
    hist_overlay_mode: opts.histOverlayMode,
    hist_layout: opts.histLayout,
    ridge_overlap: opts.ridgeOverlap,
    ridge_col_gap: opts.ridgeColGap,
    ridge_gradient: opts.ridgeGradient,
    font_sizes: opts.fontSizes,
    gate_style: { pub_style: opts.pubStyle, line_width: opts.gateLineWidth },
  };
}
