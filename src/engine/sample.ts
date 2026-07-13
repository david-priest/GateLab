// sample.ts — a loaded FCS wrapped with its per-channel display transforms and the
// raw / gating / display coordinate spaces GateLabR uses.
//
// GateLabR distinction (fcs_import.R + app.R is_flow_display_context):
//   • DISPLAY space — what the plot shows (logicle / arcsinh). Gates are DRAWN here.
//   • GATING space  — where masks are computed and gates are STORED. For FLOW this is
//     RAW FCS values (so polygon edges are straight in raw space, invariant to logicle
//     params); for CyTOF it equals the display asinh space (no separate raw display).
// Masking in the wrong space would bend polygon edges and change counts, so this class
// keeps them separate and exposes gating↔display vertex conversion.

import type { FcsFile, NumericColumn } from "./fcs";
import type { AssayData } from "./gates";
import { resolveChannels, type ResolvedChannel } from "./channels";
import { encodeFloat32Base64, encodeUint8Base64 } from "./encode";
import { logicleTicks, scatterTicks, type AxisTicks } from "./ticks";
import {
  extractDisplaySpillover,
  invertMatrix,
  compensate,
  type DisplaySpillover,
} from "./compensation";
import {
  Logicle,
  isCytofRawChannel,
  isQcChannel,
  isScatterChannel,
  estimateLogicleParams,
} from "./transforms";

export interface ChannelTransform {
  kind: "logicle" | "asinh" | "identity";
  forward(v: number): number; // raw → display
  inverse(v: number): number; // display → raw
}

const IDENTITY: ChannelTransform = { kind: "identity", forward: (v) => v, inverse: (v) => v };
function asinhTransform(cf: number): ChannelTransform {
  return { kind: "asinh", forward: (v) => Math.asinh(v / cf), inverse: (v) => cf * Math.sinh(v) };
}

export type DisplayMode = "pseudocolor" | "dots" | "contour";

/** Max points drawn per plot; more are downsampled for speed (gating uses all events). */
export const PLOT_CAP = 50000;

export interface ScatterPayload {
  x_b64: string;
  y_b64: string;
  x_label: string;
  y_label: string;
  x_range: [number, number];
  y_range: [number, number];
  display_mode: DisplayMode;
  point_alpha: number;
  /** Outer contour threshold as % of peak density (contour mode). */
  contour_threshold: number;
  n_events: number;
  gates: unknown[];
  selected_gate_id?: string | null;
  /** All channel keys, for the axis-label channel picker built into cytof_plot.js. */
  channels: string[];
  // Logicle/scatter axis ticks (null → cytof_plot.js uses D3 default linear ticks).
  x_is_logicle: boolean;
  y_is_logicle: boolean;
  x_logicle_ticks: AxisTicks | null;
  y_logicle_ticks: AxisTicks | null;
  // Colour-by-factor overlay (population / metadata / division): per-plotted-point palette index.
  overlay_mode?: boolean;
  color_b64?: string;
  color_palette?: string[];
  color_labels?: string[];
}

/** Per-event palette index (length = nEvents) + the palette/labels it indexes, for the colour overlay. */
export interface OverlaySpec {
  colors: Uint8Array;
  palette: string[];
  labels: string[];
}

export interface SampleOpts {
  /** CyTOF arcsinh cofactor (default 5). */
  cytofCofactor?: number;
}

export class Sample {
  readonly fcs: FcsFile;
  /** Auto-detected instrument (from channel names). The effective value can be overridden. */
  readonly detectedInstrument: "flow" | "cytof";
  private _instrumentMode: "auto" | "flow" | "cytof" = "auto";
  /** Effective instrument: the manual override if set, else the auto-detected value. */
  get instrument(): "flow" | "cytof" {
    return this._instrumentMode === "auto" ? this.detectedInstrument : this._instrumentMode;
  }
  get instrumentMode(): "auto" | "flow" | "cytof" {
    return this._instrumentMode;
  }
  /** "raw" for flow (gates stored/masked in raw space), "display" for CyTOF. */
  get gatingSpace(): "raw" | "display" {
    return this.instrument === "flow" ? "raw" : "display";
  }

  // Transforms are built lazily per channel: a logicle transform sorts the full
  // column, so eagerly building all of them is O(nChannels · n·log n) — pathological
  // for wide spectral panels (100s of channels). Only displayed channels get built.
  private readonly cytofCofactor: number;
  private readonly transformCache = new Map<number, ChannelTransform>();
  private readonly byName = new Map<string, number>();
  private readonly displayCache = new Map<number, Float32Array>();
  private readonly gatingCache = new Map<number, Float32Array>();
  /** Kept/renamed channels (spectral raw detectors filtered out for flow). */
  readonly channels: ResolvedChannel[];
  /** Embedded $SPILLOVER mapped to display-named fluorochrome channels (null if none). */
  readonly spillover: DisplaySpillover | null;

  constructor(fcs: FcsFile, opts: SampleOpts = {}) {
    this.fcs = fcs;
    this.detectedInstrument = fcs.instrument;
    this.cytofCofactor = opts.cytofCofactor ?? 5;
    this.channels = resolveChannels(fcs);
    this.channels.forEach((c, i) => this.byName.set(c.key, i));
    const pnnToKey = new Map<string, string>();
    for (const c of this.channels) pnnToKey.set(c.pnn, c.key);
    this.spillover = extractDisplaySpillover(
      fcs.spillover,
      (pnn) => pnnToKey.get(pnn) ?? null,
      isScatterChannel,
      isQcChannel,
    );
  }

  // ── Compensation ────────────────────────────────────────────────────────────
  private compensationOn = false;
  private compCache: Map<string, Float32Array> | null = null;
  /** True when the file carries a (non-identity) spillover that can be applied. */
  get hasCompensation(): boolean {
    return this.spillover !== null;
  }
  get compensationEnabled(): boolean {
    return this.compensationOn;
  }
  /** Toggle spillover compensation (applied to raw fluor values before transforms). */
  setCompensation(on: boolean): void {
    if (on === this.compensationOn) return;
    if (on && this.spillover) {
      const inv = invertMatrix(this.spillover.matrix);
      if (inv) {
        const fluor = this.spillover.channels.map((key) => {
          const i = this.byName.get(key)!;
          return this.fcs.columns[this.channels[i].columnIndex]; // uncompensated raw
        });
        const comp = compensate(fluor, inv);
        this.compCache = new Map();
        this.spillover.channels.forEach((key, i) => this.compCache!.set(key, comp[i]));
      } else {
        this.compCache = null; // singular → cannot compensate
        on = false;
      }
    } else {
      this.compCache = null;
    }
    this.compensationOn = on;
    this.invalidateAll();
  }
  /** Force the instrument mode ('auto' = the detected value). Rebuilds all derived caches
   *  because the display transform + gating space depend on the instrument. Intended as a
   *  recovery for an auto-detect miss — switch it before gating for best results, since the
   *  gating space (raw vs display) also flips with it. */
  setInstrumentMode(mode: "auto" | "flow" | "cytof"): void {
    if (mode === this._instrumentMode) return;
    this._instrumentMode = mode;
    this.invalidateAll();
  }
  /** Drop every derived cache — raw data changed underneath (compensation / instrument change). */
  private invalidateAll(): void {
    this.transformCache.clear();
    this.displayCache.clear();
    this.gatingCache.clear();
    this.rangeCache.clear();
    this.logicleParamsCache.clear();
  }

  /** Raw column for a resolved-channel index (compensated when compensation is on). */
  private rawColumn(idx: number): NumericColumn {
    if (this.compensationOn && this.compCache) {
      const c = this.compCache.get(this.channels[idx].key);
      if (c) return c;
    }
    return this.fcs.columns[this.channels[idx].columnIndex];
  }
  /** Current linear column (compensated when compensation is enabled). */
  rawColumnData(idx: number): NumericColumn {
    return this.rawColumn(idx);
  }
  /** Original stored FCS measurements, before compensation or display transforms. */
  originalColumnData(idx: number): NumericColumn {
    return this.fcs.columns[this.channels[idx].columnIndex];
  }
  /** Linear measurements after the sample's current compensation setting. */
  compensatedColumnData(idx: number): NumericColumn {
    return this.rawColumn(idx);
  }

  /** Auto-estimated {T, W} per channel (single sort), cached. */
  private readonly logicleParamsCache = new Map<number, { t: number; w: number }>();
  /** User-set logicle W per channel (overrides the auto estimate). */
  private readonly wOverride = new Map<number, number>();

  private logicleParams(idx: number): { t: number; w: number } {
    let p = this.logicleParamsCache.get(idx);
    if (!p) {
      p = estimateLogicleParams(this.rawColumn(idx));
      this.logicleParamsCache.set(idx, p);
    }
    return p;
  }

  /** Lazily build + cache the raw→display transform for one channel. */
  private transform(idx: number): ChannelTransform {
    const hit = this.transformCache.get(idx);
    if (hit) return hit;
    const name = this.channels[idx].key;
    let t: ChannelTransform;
    if (this.instrument === "cytof") {
      t = isCytofRawChannel(name) ? IDENTITY : asinhTransform(this.cytofCofactor);
    } else if (isQcChannel(name)) {
      t = IDENTITY;
    } else if (isScatterChannel(name)) {
      t = asinhTransform(150);
    } else {
      const { t: tv } = this.logicleParams(idx);
      const w = this.wOverride.get(idx) ?? this.logicleParams(idx).w;
      const lg = new Logicle(tv, w, 4.5, 0);
      // GateLabR (fcs_import.R:862) falls back to asinh(x/150) when the logicle can't be built /
      // doesn't converge (Logicle.scale returns -1). Health-check at representative values; an
      // unhealthy channel uses asinh outright, a healthy one still guards rare per-value failures
      // so no -1/NaN display coord ever reaches the plot / ticks / stats.
      const asinhFallback = asinhTransform(150);
      const healthy = [0, tv * 0.5, tv].every((v) => {
        const s = lg.scale(v);
        return Number.isFinite(s) && s !== -1;
      });
      t = healthy
        ? {
            kind: "logicle",
            forward: (v) => { const s = lg.scale(v); return s === -1 || !Number.isFinite(s) ? asinhFallback.forward(v) : s; },
            inverse: (v) => lg.inverse(v),
          }
        : asinhFallback;
    }
    this.transformCache.set(idx, t);
    return t;
  }

  /** True when the channel is displayed with a logicle transform (flow signal). */
  isLogicleChannel(idx: number): boolean {
    return this.transform(idx).kind === "logicle";
  }
  /** Auto-estimated logicle W (the slider's reset target). */
  autoLogicleW(idx: number): number {
    return this.logicleParams(idx).w;
  }
  /** Logicle T (top-of-scale) for a channel — used when exporting a logicle transform. */
  logicleT(idx: number): number {
    return this.logicleParams(idx).t;
  }
  /** CyTOF arcsinh cofactor (for exporting the fasinh transform). */
  get arcsinhCofactor(): number {
    return this.cytofCofactor;
  }
  /** Current logicle W (user override or auto). */
  currentLogicleW(idx: number): number {
    return this.wOverride.get(idx) ?? this.logicleParams(idx).w;
  }
  /** Override the logicle W for a channel; invalidates its cached display column. */
  setLogicleW(idx: number, w: number): void {
    this.wOverride.set(idx, Math.max(0.1, Math.min(w, 2.0)));
    this.invalidateChannel(idx);
  }
  /** User-set logicle W overrides, keyed by channel key (for workspace save). */
  logicleWOverrides(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [idx, w] of this.wOverride) out[this.channels[idx].key] = w;
    return out;
  }
  /** Clear a W override, reverting to the auto estimate. */
  resetLogicleW(idx: number): void {
    this.wOverride.delete(idx);
    this.invalidateChannel(idx);
  }
  private invalidateChannel(idx: number): void {
    this.transformCache.delete(idx);
    this.displayCache.delete(idx);
    this.gatingCache.delete(idx);
  }

  index(channel: string): number | undefined {
    return this.byName.get(channel);
  }

  channelNames(): string[] {
    return this.channels.map((c) => c.key);
  }

  /** Display label for a resolved-channel index — the Panel-tab override, else the key. */
  channelLabel(idx: number): string {
    return this.channels[idx].label ?? this.channels[idx].key;
  }

  /** Display label for a channel identity key (key unchanged if not found). */
  labelForKey(key: string): string {
    const i = this.byName.get(key);
    return i === undefined ? key : this.channelLabel(i);
  }

  /** Resolve a display label back to its identity key (identity for un-renamed channels). */
  keyForLabel(label: string): string {
    for (let i = 0; i < this.channels.length; i++) {
      if (this.channelLabel(i) === label) return this.channels[i].key;
    }
    return label; // already a key, or unknown
  }

  /** Set (or clear, when equal to the key / empty) a channel's Panel-tab display label. */
  setChannelLabel(idx: number, label: string): void {
    const key = this.channels[idx].key;
    const trimmed = label.trim();
    this.channels[idx].label = trimmed && trimmed !== key ? trimmed : undefined;
  }

  /** True when a channel may be renamed — scatter (FSC/SSC) and QC/Time channels are locked. */
  isRenamable(idx: number): boolean {
    const key = this.channels[idx].key;
    return !isQcChannel(key) && !isScatterChannel(key);
  }

  /** Non-default display labels, keyed by identity key (for workspace save). */
  labelOverrides(): Record<string, string> {
    const out: Record<string, string> = {};
    this.channels.forEach((c) => {
      if (c.label && c.label !== c.key) out[c.key] = c.label;
    });
    return out;
  }

  /** Restore display labels from a saved {key: label} map (workspace open). */
  applyLabelOverrides(map: Record<string, string>): void {
    for (const [key, label] of Object.entries(map ?? {})) {
      const i = this.byName.get(key);
      if (i !== undefined) this.setChannelLabel(i, label);
    }
  }

  transformKind(idx: number): ChannelTransform["kind"] {
    return this.transform(idx).kind;
  }

  /** Display-space column (what the plot shows). Cached. */
  displayColumn(idx: number): Float32Array {
    const hit = this.displayCache.get(idx);
    if (hit) return hit;
    const raw = this.rawColumn(idx);
    const t = this.transform(idx);
    const out = new Float32Array(raw.length);
    if (t.kind === "identity") out.set(raw);
    else for (let i = 0; i < raw.length; i++) out[i] = t.forward(raw[i]);
    this.displayCache.set(idx, out);
    return out;
  }

  /** Gating-space column (masks run on this). Flow → raw; CyTOF → display. */
  gatingColumn(idx: number): NumericColumn {
    if (this.gatingSpace === "raw") return this.rawColumn(idx);
    const hit = this.gatingCache.get(idx);
    if (hit) return hit;
    const col = this.displayColumn(idx); // CyTOF gating == display
    this.gatingCache.set(idx, col);
    return col;
  }

  /** Convert one axis coordinate gating → display (for rendering gates). */
  gatingToDisplay(channel: string, v: number): number {
    const idx = this.byName.get(channel);
    if (idx === undefined) return v;
    return this.gatingSpace === "raw" ? this.transform(idx).forward(v) : v;
  }

  /** Convert one axis coordinate display → gating (for storing a drawn gate). */
  displayToGating(channel: string, v: number): number {
    const idx = this.byName.get(channel);
    if (idx === undefined) return v;
    return this.gatingSpace === "raw" ? this.transform(idx).inverse(v) : v;
  }

  /** AssayData over gating columns, for getGateMask / applyGatingStrategy. */
  gatingData(): AssayData {
    return {
      n: this.fcs.nEvents,
      column: (ch) => {
        const i = this.byName.get(ch);
        return i === undefined ? undefined : this.gatingColumn(i);
      },
    };
  }

  /** Auto display range for an axis (padded min/max), cached. */
  displayRange(idx: number): [number, number] {
    const hit = this.rangeCache.get(idx);
    if (hit) return hit;
    const r = paddedRange(this.displayColumn(idx));
    this.rangeCache.set(idx, r);
    return r;
  }
  private readonly rangeCache = new Map<number, [number, number]>();

  /**
   * Display-space axis ticks for a channel over the given visible range (mirrors
   * GateLabR generate_channel_ticks): flow scatter → decade log ticks, flow signal →
   * logicle decade ticks, CyTOF metal / QC → null (cytof_plot.js falls back to D3's
   * linear ticks). Recomputed per view because the tick set depends on the visible range.
   */
  channelTicks(idx: number, axisRange: [number, number]): AxisTicks | null {
    const name = this.channels[idx].key;
    if (isQcChannel(name)) return null;
    const t = this.transform(idx);
    const fwd = (v: number) => t.forward(v);
    const inv = (v: number) => t.inverse(v);
    // Flow scatter (FSC/SSC): asinh display, raw-unit decade labels (1K/10K/100K).
    if (this.instrument === "flow" && isScatterChannel(name)) {
      return scatterTicks(fwd, inv, axisRange, 150);
    }
    // Flow signal (fluorophore): logicle display, biexponential decade labels.
    if (t.kind === "logicle") {
      return logicleTicks(fwd, inv, axisRange, this.logicleParams(idx).t);
    }
    return null; // CyTOF metal / identity → D3 default linear ticks
  }

  /**
   * Build a cytof_plot.js render payload for the chosen display channels.
   * `mask` restricts plotted events to a population; `xRange`/`yRange` override the
   * auto axis range (pan/zoom + Min/Max controls). Plotted points are capped at
   * `plotCap` for speed — gating/counts are unaffected (they use the full masks).
   */
  plotPayload(
    xIdx: number,
    yIdx: number,
    mode: DisplayMode,
    gates: unknown[] = [],
    mask?: Uint8Array | null,
    selectedGateId?: string | null,
    xRange?: [number, number] | null,
    yRange?: [number, number] | null,
    plotCap = PLOT_CAP,
    contourThreshold = 5,
    overlay?: OverlaySpec | null,
  ): ScatterPayload {
    const xdFull = this.displayColumn(xIdx);
    const ydFull = this.displayColumn(yIdx);

    // Ticks depend on the visible range → compute from the effective (possibly panned) range.
    const xr = xRange ?? this.displayRange(xIdx);
    const yr = yRange ?? this.displayRange(yIdx);
    const xTicks = this.channelTicks(xIdx, xr);
    const yTicks = this.channelTicks(yIdx, yr);

    // Which event indices to plot (masked population, or all). When a population is
    // larger than the plot cap, collect the evenly-spaced sample directly into the
    // capped array: allocating an Int32Array for every selected event (often millions)
    // only to discard it immediately caused severe GC pressure while switching pops.
    let indices: Int32Array | null = null;
    let plottedN = xdFull.length;
    const cap = Number.isFinite(plotCap) && plotCap > 0
      ? Math.max(1, Math.floor(plotCap))
      : null;
    if (mask) {
      let c = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
      plottedN = c;
      if (cap !== null && c > cap) {
        indices = new Int32Array(cap);
        const denom = cap > 1 ? cap - 1 : 1;
        let samplePos = 0;
        let memberPos = 0;
        let target = 0;
        for (let i = 0; i < mask.length && samplePos < cap; i++) {
          if (!mask[i]) continue;
          if (memberPos === target) {
            indices[samplePos++] = i;
            target = samplePos < cap
              ? Math.round((samplePos * (c - 1)) / denom)
              : c;
          }
          memberPos++;
        }
      } else {
        indices = new Int32Array(c);
        let k = 0;
        for (let i = 0; i < mask.length; i++) if (mask[i]) indices[k++] = i;
      }
    }

    // Downsample for display (GateLabR: idx[round(seq(1, N, length.out = cap))]) — keep
    // evenly-spaced points; deterministic → stable across pan/zoom. cap <= 0 or Infinity
    // = no downsampling ("0 = all"). Counts/gating are untouched.
    if (!mask && cap !== null && plottedN > cap) {
      const sub = new Int32Array(cap);
      const denom = cap > 1 ? cap - 1 : 1;
      for (let k = 0; k < cap; k++) {
        const j = Math.round((k * (plottedN - 1)) / denom);
        sub[k] = j;
      }
      indices = sub;
    }

    let xd: Float32Array;
    let yd: Float32Array;
    if (indices) {
      xd = new Float32Array(indices.length);
      yd = new Float32Array(indices.length);
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        xd[k] = xdFull[i];
        yd[k] = ydFull[i];
      }
    } else {
      xd = xdFull;
      yd = ydFull;
    }

    // Colour overlay: subset the per-event palette index in lock-step with the plotted points.
    let overlayFields: Partial<ScatterPayload> = {};
    if (overlay) {
      const src = overlay.colors;
      let cd: Uint8Array;
      if (indices) {
        cd = new Uint8Array(indices.length);
        for (let k = 0; k < indices.length; k++) cd[k] = src[indices[k]] ?? 0;
      } else {
        cd = src.length === xd.length ? src : src.slice(0, xd.length);
      }
      overlayFields = {
        overlay_mode: true,
        color_b64: encodeUint8Base64(cd),
        color_palette: overlay.palette,
        color_labels: overlay.labels,
      };
    }

    return {
      x_b64: encodeFloat32Base64(xd),
      y_b64: encodeFloat32Base64(yd),
      // x_label doubles as the gate channel identifier in cytof_plot.js (gate.x_channel
      // === x_label), so it must be the resolved channel key the Sample indexes by.
      x_label: this.channels[xIdx].key,
      y_label: this.channels[yIdx].key,
      x_range: xr,
      y_range: yr,
      display_mode: mode,
      point_alpha: 0.4,
      contour_threshold: contourThreshold,
      n_events: plottedN, // true population size (title); plotted array may be capped
      gates,
      selected_gate_id: selectedGateId ?? null,
      channels: this.channels.map((c) => c.key),
      x_is_logicle: xTicks !== null,
      y_is_logicle: yTicks !== null,
      x_logicle_ticks: xTicks,
      y_logicle_ticks: yTicks,
      ...overlayFields,
    };
  }

  /** First two non-QC channels (resolved-channel indices; fall back to 0/1). */
  defaultChannelIndices(): [number, number] {
    const usable: number[] = [];
    this.channels.forEach((c, i) => {
      if (!isQcChannel(c.key)) usable.push(i);
    });
    const x = usable[0] ?? 0;
    const y = usable[1] ?? Math.min(1, this.channels.length - 1);
    return [x, y];
  }
}

function paddedRange(v: Float32Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) return [lo - 0.5, hi + 0.5];
  const pad = (hi - lo) * 0.02;
  return [lo - pad, hi + pad];
}
