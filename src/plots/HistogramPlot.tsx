// HistogramPlot.tsx — the Gating tab's one-channel view: a histogram of the plotted population on
// the X channel, with the range gates on that channel drawn over it and editable by their ends.
//
// A range gate is held as GateLab has always held one: a rectangle whose two axes are the same
// channel (gatingml.ts reads Gating-ML's one-dimensional RectangleGate that way, and both
// exporters write it back as one dimension). This view adds no gate kind and no engine code. It
// draws what buildPlotGates gives for the channel on both axes, and it reports drawn and dragged
// ends in DISPLAY units; App converts them through the gate's own space exactly as it does a
// dragged rectangle on the scatter plot.
//
// The curve is drawn from the points the scatter plot would draw (the same pooling and the same
// "Max events" cap), normalised to its tallest bin, so subsampling changes nothing a reader sees.
// It is drawn binned (steps) or smoothed (a Gaussian over the bins, FlowJo's default look), with
// the number of bins and the smoothing width set under the plot. All of that is display only: the
// percentages on the gates are the gate counts, which always use every event.

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AxisTicks } from "../engine/ticks";
import type { PlotGate } from "./gatePayload";
import { SearchableSelect, type SearchableOption } from "../ui/SearchableSelect";
import { DEFAULT_GATING_FONT_SIZES } from "./GatingPlot";
import type { GatingFontSizes } from "../engine/workspace";
import { useI18n } from "../ui/i18n";
import { usePersistedTabState } from "../ui/tabState";
import { NumberField } from "../ui/NumberField";
import { displayGateColour, useGateInk } from "./gateInk";

/** The ends a drag moved, in display units; an end left out did not move. */
export interface RangeEdit {
  gate_id: string;
  lo?: number;
  hi?: number;
}

interface Props {
  /** Display values of the plotted points on the channel. */
  values: Float32Array | null;
  xRange: [number, number];
  ticks: AxisTicks | null;
  channel: string;
  channelOptions: SearchableOption[];
  onChannelChange: (channel: string) => void;
  /** Gates drawn with the channel on both axes (buildPlotGates); only rectangles are shown. */
  gates: PlotGate[];
  selectedGateId: string | null;
  mode: "navigate" | "draw-range" | "draw-bisector";
  fontSizes?: GatingFontSizes;
  onNewRange?: (lo: number, hi: number) => void;
  /** A bisector placed: where its two ranges meet, in display units. */
  onNewBisector?: (at: number) => void;
  /** The ranges a drag moved: the one dragged, and any whose end met a moved end (a shared handle). */
  onRangeEdit?: (edits: RangeEdit[]) => void;
  /**
   * Each range's stored label offset (the gate's own `label_offset`), in this view's terms: display
   * units along the axis from the middle of the visible range, and % of max up from the label's
   * place under its bar. Absent or null: the label sits there.
   */
  labelOffsets?: Record<string, [number, number] | null | undefined>;
  /** A label dragged to a new place, as the offset to store; it never moves the gate. */
  onLabelMove?: (gateId: string, offset: [number, number]) => void;
  /** The view panned or stretched to a new axis range (committed on release, as the scatter plot's). */
  onRangeChange?: (range: [number, number]) => void;
  onGateSelect?: (gateId: string) => void;
}

const M = { top: 14, right: 18, bottom: 34, left: 52 };
/** A drag shorter than this, in pixels, is a click. */
const CLICK_PX = 3;
/** Width of an end's handle, in pixels: inside a range but this near an end resizes; elsewhere it moves. */
const END_HIT_PX = 12;

/**
 * Counts per bin over `range`, `bins` equal bins, the top edge in the last bin. Values outside the
 * range, and values that are not finite, are left out: they are off the axis, as on the scatter.
 */
export function histogramCounts(values: ArrayLike<number>, range: [number, number], bins: number): number[] {
  const counts = new Array<number>(bins).fill(0);
  const [lo, hi] = range;
  const span = hi - lo;
  if (!(span > 0)) return counts;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!(v >= lo && v <= hi)) continue;
    counts[Math.min(bins - 1, Math.floor(((v - lo) / span) * bins))]++;
  }
  return counts;
}

/**
 * Counts smoothed by a Gaussian of `sigmaBins` bins (cut at four sigma, its weights summing to one).
 * Past either end of the axis there are no counts, so a peak against an edge spreads off the plot.
 * A width below a tenth of a bin returns the counts unchanged.
 */
export function smoothCounts(counts: readonly number[], sigmaBins: number): number[] {
  if (!(sigmaBins >= 0.1)) return [...counts];
  const half = Math.ceil(sigmaBins * 4);
  const kernel: number[] = [];
  for (let k = -half; k <= half; k++) kernel.push(Math.exp(-0.5 * (k / sigmaBins) ** 2));
  const total = kernel.reduce((a, b) => a + b, 0);
  return counts.map((_, i) => {
    let sum = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < counts.length) sum += counts[j] * kernel[k + half];
    }
    return sum / total;
  });
}

/** How the curve is drawn: steps, one per bin, or a line through the smoothed bins' centres. */
export type HistogramStyle = "smoothed" | "binned";

/**
 * A range gate's interval on the channel, in display units, and which ends have no bound. The two
 * axes of a range carry the same interval; when an imported rectangle on one channel carries two,
 * an event is in it only inside both, so the interval drawn is their intersection.
 */
export function plotGateInterval(gate: PlotGate): { lo: number; hi: number; open: [boolean, boolean] } | null {
  if (gate.gate_type !== "rectangle" || !gate.vertices?.length) return null;
  const xs = gate.vertices.map((v) => v[0]);
  const ys = gate.vertices.map((v) => v[1]);
  const lo = Math.max(Math.min(...xs), Math.min(...ys));
  const hi = Math.min(Math.max(...xs), Math.max(...ys));
  if (!Number.isFinite(lo) && !Number.isFinite(hi)) return null;
  const ux = gate.unbounded?.x ?? [false, false];
  const uy = gate.unbounded?.y ?? [false, false];
  return { lo, hi, open: [ux[0] && uy[0], ux[1] && uy[1]] };
}

/** Evenly spaced ticks for a linear axis, at a 1, 2 or 5 step. */
export function linearTicks([lo, hi]: [number, number], target = 6): number[] {
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(span)) return [];
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  // By whole steps, rounded, so that 0.1 + 0.2 is not drawn as 0.30000000000000004.
  for (let k = Math.ceil(lo / step - 1e-9); k <= Math.floor(hi / step + 1e-9); k++) out.push(+(k * step).toPrecision(12) || 0);
  return out;
}

function tickLabel(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(1)}K`;
  return String(+v.toFixed(2));
}

/**
 * Another range whose end met an end the drag moves, at the same value: the two share that handle
 * and it moves both, so ranges that meet (a bisector's two halves) keep meeting. `end` is the
 * partner's own end that moves: 0 its low end, 1 its high end.
 */
interface LinkedEnd {
  gateId: string;
  end: 0 | 1;
  lo: number;
  hi: number;
}

type Drag =
  | { kind: "draw"; pointerId: number; from: number; to: number }
  /**
   * Panning (or, with Shift or Option held, stretching) the axis. `base` is the range the gesture
   * measures from and `fromP` the pointer's place then, in SVG pixels; both are taken again when
   * the modifier changes mid-drag, so switching between the two never jumps.
   */
  | { kind: "pan"; pointerId: number; fromP: number; base: [number, number]; grab: number; stretch: boolean; view: [number, number]; moved: boolean }
  | { kind: "label"; pointerId: number; gateId: string; fromX: number; fromY: number; start: [number, number]; dx: number; dy: number; moved: boolean }
  | { kind: "split"; pointerId: number; from: number; to: number }
  | {
      kind: "lo" | "hi" | "body"; pointerId: number; gateId: string; from: number; lo: number; hi: number;
      open: [boolean, boolean]; moved: boolean; dx: number; links: LinkedEnd[];
    };

/** Two ends at one value, allowing for the last bits of a display transform. */
const sameEnd = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** An interval with the given ends moved by `dx`, kept in order. */
function shiftEnds(lo: number, hi: number, moveLo: boolean, moveHi: boolean, dx: number): { lo: number; hi: number } {
  const a = moveLo ? lo + dx : lo;
  const b = moveHi ? hi + dx : hi;
  return a <= b ? { lo: a, hi: b } : { lo: b, hi: a };
}

export function HistogramPlot({
  values,
  xRange,
  ticks,
  channel,
  channelOptions,
  onChannelChange,
  gates,
  selectedGateId,
  mode,
  fontSizes = DEFAULT_GATING_FONT_SIZES,
  onNewRange,
  onNewBisector,
  onRangeEdit,
  labelOffsets = {},
  onLabelMove,
  onRangeChange,
  onGateSelect,
}: Props) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(560);
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);

  // Sized as the scatter plot is: from the plot area's width, between 380 and 630 pixels.
  useEffect(() => {
    const parent = hostRef.current?.parentElement;
    if (!parent) return;
    const fit = () => {
      const w = parent.clientWidth;
      if (w > 0) setWidth(Math.min(Math.max(380, w - 32), 630));
    };
    fit();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    ro?.observe(parent);
    return () => ro?.disconnect();
  }, []);

  const height = Math.round(width * 0.72);
  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;
  // The axis range on screen: the committed one, or the one a pan or stretch in progress shows.
  const [panView, setPanView] = useState<[number, number] | null>(null);
  const view = panView ?? xRange;
  const [x0, x1] = view;
  const toPx = (v: number) => M.left + ((v - x0) / (x1 - x0)) * innerW;
  const clampToAxis = (v: number) => Math.min(x1, Math.max(x0, v));

  // Display settings, kept for the session (tabState), so they survive switching views and tabs.
  const [style, setStyle] = usePersistedTabState<HistogramStyle>("gating.histogram.style", "smoothed");
  const [bins, setBins] = usePersistedTabState<number>("gating.histogram.bins", 256);
  /** Smoothing width (the Gaussian's sigma) as a percentage of the axis, so it does not change with the bin count. */
  const [smoothing, setSmoothing] = usePersistedTabState<number>("gating.histogram.smoothing", 1);

  const counts = useMemo(() => (values ? histogramCounts(values, view, bins) : null), [values, x0, x1, bins]); // eslint-disable-line react-hooks/exhaustive-deps
  const curve = useMemo(() => {
    if (!counts) return "";
    const heights = style === "smoothed" ? smoothCounts(counts, (smoothing / 100) * bins) : counts;
    const peak = Math.max(...heights);
    if (!(peak > 0)) return "";
    const binW = innerW / bins;
    const base = M.top + innerH;
    const yOf = (c: number) => base - (c / peak) * innerH;
    let d = `M${M.left},${base}`;
    heights.forEach((c, i) => {
      d += style === "smoothed"
        ? `L${M.left + (i + 0.5) * binW},${yOf(c)}`
        : `L${M.left + i * binW},${yOf(c)}L${M.left + (i + 1) * binW},${yOf(c)}`;
    });
    return `${d}L${M.left + innerW},${base}Z`;
  }, [counts, innerW, innerH, bins, style, smoothing]);

  const xTicks = useMemo(() => {
    const inRange = (v: number) => v >= x0 && v <= x1;
    const major = ticks
      ? ticks.major_pos.map((p, i) => ({ p, label: ticks.major_labels[i] ?? "" })).filter((tk) => inRange(tk.p))
      : linearTicks(view).map((p) => ({ p, label: tickLabel(p) }));
    // A label that would run into the one before it is left off; its tick stays. Near zero a
    // logicle axis packs −1000, −100 and 0 into a few pixels.
    let lastEnd = -Infinity;
    const labelled = [...major].sort((a, b) => a.p - b.p).map((tk) => {
      const half = (tk.label.length * fontSizes.tick * 0.6) / 2;
      const at = toPx(tk.p);
      if (at - half < lastEnd + 4) return { ...tk, label: "" };
      lastEnd = at + half;
      return tk;
    });
    return { major: labelled, minor: ticks ? ticks.minor_pos.filter(inRange) : [] };
  }, [ticks, x0, x1, innerW, fontSizes.tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each range on its own row, so that overlapping ranges and their labels stay readable.
  const ranges = useMemo(() => {
    const placed: { gate: PlotGate; lo: number; hi: number; open: [boolean, boolean]; row: number }[] = [];
    const rowEnds: number[] = [];
    const intervals = gates
      .map((gate) => ({ gate, interval: plotGateInterval(gate) }))
      .filter((r): r is { gate: PlotGate; interval: NonNullable<ReturnType<typeof plotGateInterval>> } => r.interval !== null)
      .sort((p, q) => p.interval.lo - q.interval.lo);
    // Left to right, each on the first row whose last range (or its label) ends where this one
    // begins, so ranges side by side share a row.
    for (const { gate, interval } of intervals) {
      const a = toPx(clampToAxis(interval.lo));
      const b = toPx(clampToAxis(interval.hi));
      const labelHalf = ((gate.name.length + 7) * fontSizes.gate * 0.6) / 2;
      const left = Math.min(a, (a + b) / 2 - labelHalf);
      const right = Math.max(b, (a + b) / 2 + labelHalf);
      // Bars that only touch (a bisector's halves) share a row; labels still keep apart.
      let row = rowEnds.findIndex((end) => end <= left + 0.5);
      if (row < 0) { row = rowEnds.length; rowEnds.push(right); } else rowEnds[row] = right;
      placed.push({ gate, ...interval, row });
    }
    return placed;
  }, [gates, x0, x1, innerW, fontSizes.gate]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The display value under a pointer, by the plot's own geometry (the SVG may be scaled by CSS). */
  /** Screen pixels per SVG pixel (the SVG may be scaled by CSS). */
  const screenScale = (): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    return rect && rect.width > 0 ? rect.width / width : 1;
  };
  const valueAt = (clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    const scale = rect && rect.width > 0 ? rect.width / width : 1;
    const px = (clientX - (rect?.left ?? 0)) / scale;
    return x0 + ((px - M.left) / innerW) * (x1 - x0);
  };
  const pxPerUnit = innerW / (x1 - x0);

  const begin = (next: Drag, event: ReactPointerEvent) => {
    dragRef.current = next;
    setDrag(next);
    try { svgRef.current?.setPointerCapture?.(event.pointerId); } catch { /* not capturable here */ }
    event.stopPropagation();
    event.preventDefault();
  };

  /** The pointer's place along the SVG, in its own pixels. */
  const svgX = (clientX: number): number => (clientX - (svgRef.current?.getBoundingClientRect().left ?? 0)) / screenScale();

  const onBackgroundDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    if (mode === "navigate") {
      // Drag pans the axis; with Shift (or Option) it stretches it, the low end fixed and the
      // grabbed value following the pointer, as on the scatter plot.
      const p = svgX(event.clientX);
      begin({ kind: "pan", pointerId: event.pointerId, fromP: p, base: [x0, x1], grab: valueAt(event.clientX), stretch: event.shiftKey || event.altKey, view: [x0, x1], moved: false }, event);
      return;
    }
    const v = clampToAxis(valueAt(event.clientX));
    begin({ kind: mode === "draw-bisector" ? "split" : "draw", pointerId: event.pointerId, from: v, to: v }, event);
  };

  const onGateDown = (event: ReactPointerEvent, kind: "lo" | "hi" | "body", r: (typeof ranges)[number]) => {
    if (mode !== "navigate" || event.button !== 0) return;
    // The ends this drag moves, and every other range with an end at the same value: those move
    // with it. Alt (Option) moves this range alone.
    const moving: [number, 0 | 1][] = [];
    if (kind !== "hi" && !r.open[0]) moving.push([r.lo, 0]);
    if (kind !== "lo" && !r.open[1]) moving.push([r.hi, 1]);
    const links: LinkedEnd[] = event.altKey ? [] : ranges.flatMap((other) => {
      if (other.gate.gate_id === r.gate.gate_id) return [];
      return moving.flatMap(([value, side]): LinkedEnd[] => {
        const end = side === 0 ? 1 : 0;
        const at = end === 0 ? other.lo : other.hi;
        return !other.open[end] && sameEnd(at, value) ? [{ gateId: other.gate.gate_id, end, lo: other.lo, hi: other.hi }] : [];
      });
    });
    begin({ kind, pointerId: event.pointerId, gateId: r.gate.gate_id, from: valueAt(event.clientX), lo: r.lo, hi: r.hi, open: r.open, moved: false, dx: 0, links }, event);
  };

  const onMove = (event: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== event.pointerId) return;
    const v = valueAt(event.clientX);
    let next: Drag;
    if (d.kind === "pan") {
      const p = svgX(event.clientX);
      const stretch = event.shiftKey || event.altKey;
      const from = stretch === d.stretch ? d : { ...d, fromP: p, base: d.view, grab: d.view[0] + ((p - M.left) / innerW) * (d.view[1] - d.view[0]), stretch };
      const [b0, b1] = from.base;
      let view: [number, number] = from.view;
      if (!stretch) {
        const shift = ((p - from.fromP) / innerW) * (b1 - b0);
        view = [b0 - shift, b1 - shift];
      } else if (p - M.left > 10 && from.grab > b0) {
        view = [b0, b0 + ((from.grab - b0) * innerW) / (p - M.left)];
      }
      next = { ...from, view, moved: d.moved || Math.abs(p - d.fromP) >= CLICK_PX };
      if (next.moved) setPanView(view);
    } else if (d.kind === "label") {
      const k = screenScale();
      const dx = (event.clientX - d.fromX) / k;
      const dy = (event.clientY - d.fromY) / k;
      next = { ...d, dx, dy, moved: d.moved || Math.hypot(dx, dy) >= CLICK_PX };
    } else if (!("gateId" in d)) {
      next = { ...d, to: clampToAxis(v) };
    } else {
      next = { ...d, dx: v - d.from, moved: d.moved || Math.abs(v - d.from) * pxPerUnit >= CLICK_PX };
    }
    dragRef.current = next;
    setDrag(next);
  };

  const onUp = (event: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    try { svgRef.current?.releasePointerCapture?.(event.pointerId); } catch { /* already released */ }
    if (d.kind === "draw") {
      const lo = Math.min(d.from, d.to);
      const hi = Math.max(d.from, d.to);
      if ((hi - lo) * pxPerUnit >= CLICK_PX) onNewRange?.(lo, hi);
      return;
    }
    if (d.kind === "split") {
      onNewBisector?.(d.to);
      return;
    }
    if (d.kind === "pan") {
      if (d.moved && d.view[1] > d.view[0]) onRangeChange?.(d.view);
      setPanView(null);
      return;
    }
    if (d.kind === "label") {
      onGateSelect?.(d.gateId);
      const placed = placedRanges.find((p) => p.r.gate.gate_id === d.gateId);
      if (d.moved && placed) onLabelMove?.(d.gateId, labelPlace(placed, d).offset);
      return;
    }
    onGateSelect?.(d.gateId);
    if (!d.moved) return;
    const edited = draggedInterval(d);
    const edit: RangeEdit = { gate_id: d.gateId };
    if (d.kind !== "hi" && !d.open[0]) edit.lo = edited.lo;
    if (d.kind !== "lo" && !d.open[1]) edit.hi = edited.hi;
    if (edit.lo === undefined && edit.hi === undefined) return;
    const linked = d.links.map((link): RangeEdit => {
      const moved = linkedInterval(link, d.dx);
      return link.end === 0 ? { gate_id: link.gateId, lo: moved.lo } : { gate_id: link.gateId, hi: moved.hi };
    });
    onRangeEdit?.([edit, ...linked]);
  };

  /** The interval a gate drag shows: one end moved, or both by the same amount; an open end stays open. */
  function draggedInterval(d: Extract<Drag, { links: LinkedEnd[] }>): { lo: number; hi: number } {
    if (!d.moved) return { lo: d.lo, hi: d.hi };
    return shiftEnds(d.lo, d.hi, d.kind !== "hi" && !d.open[0], d.kind !== "lo" && !d.open[1], d.dx);
  }
  function linkedInterval(link: LinkedEnd, dx: number): { lo: number; hi: number } {
    return shiftEnds(link.lo, link.hi, link.end === 0, link.end === 1, dx);
  }

  // Where each range is on screen, following a drag in progress: the one dragged, and the ranges
  // whose ends it carries.
  // A range wholly off the axis (panned away) is not drawn; one partly off is drawn to the edge.
  const placedRanges = ranges.filter((r) => r.hi >= x0 && r.lo <= x1).map((r) => {
    let live: { lo: number; hi: number } = r;
    if (drag && "links" in drag && drag.moved) {
      const link = drag.links.find((l) => l.gateId === r.gate.gate_id);
      if (drag.gateId === r.gate.gate_id) live = draggedInterval(drag);
      else if (link) live = linkedInterval(link, drag.dx);
    }
    return { r, a: toPx(clampToAxis(live.lo)), b: toPx(clampToAxis(live.hi)) };
  });
  const yTicks = [0, 25, 50, 75, 100];
  // Each row is a bar with its label under it, so the label never sits on the bar or its arrows.
  const pillH = fontSizes.gate + 6;
  // Ranges take the workspace's gate look, as the scatter plot's gates do (gateInk.ts).
  const ink = useGateInk();
  const gateColour = (stored: string) => displayGateColour(stored, ink.coloured);
  const rowY = (row: number) => M.top + 8 + row * (pillH + 14);

  /**
   * Where a range's label sits, as its centre in pixels, and the offset that place stores. It starts
   * under the middle of the visible part of its bar, moves by the stored offset (or the drag in
   * progress), and is held inside the frame.
   */
  function labelPlace(
    placed: { r: (typeof ranges)[number]; a: number; b: number },
    labelDrag?: Extract<Drag, { kind: "label" }> | null,
  ): { cx: number; cy: number; w: number; text: string; offset: [number, number] } {
    const { r, a, b } = placed;
    const pct = r.gate.percent_of_parent;
    const text = `${r.gate.name}${pct === null || pct === undefined ? "" : ` ${pct.toFixed(pct >= 10 ? 1 : 2)}%`}`;
    const w = text.length * fontSizes.gate * 0.6 + 10;
    const baseX = (a + b) / 2;
    const baseY = rowY(r.row) + pillH / 2;
    const stored = labelOffsets[r.gate.gate_id] ?? [0, 0];
    const live = labelDrag && labelDrag.gateId === r.gate.gate_id && labelDrag.moved
      ? [labelDrag.start[0] + labelDrag.dx / pxPerUnit, labelDrag.start[1] - (labelDrag.dy / innerH) * 100]
      : stored;
    const cx = Math.min(M.left + innerW - w / 2, Math.max(M.left + w / 2, baseX + live[0] * pxPerUnit));
    const cy = Math.min(M.top + innerH - pillH / 2, Math.max(M.top + pillH / 2, baseY - (live[1] / 100) * innerH));
    return { cx, cy, w, text, offset: [(cx - baseX) / pxPerUnit, ((baseY - cy) / innerH) * 100] };
  }

  return (
    <div ref={hostRef} className="gl-histogram" data-testid="histogram-plot">
      <svg
        ref={svgRef}
        width={width}
        height={height}
        role="img"
        aria-label={t("Histogram of {channel}", { channel: channelOptions.find((o) => o.value === channel)?.label ?? channel })}
        style={{ display: "block", cursor: mode === "navigate" ? (drag?.kind === "pan" ? "grabbing" : "grab") : "crosshair", touchAction: "none" }}
        onPointerDown={onBackgroundDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <rect x={M.left} y={M.top} width={innerW} height={innerH} fill="#fff" stroke="#000" strokeWidth={1} />
        {curve && <path className="gl-histogram-curve" d={curve} fill="#c8d4e6" stroke="#1f3b66" strokeWidth={1} />}
        {/* Axes */}
        {xTicks.minor.map((p) => (
          <line key={`m${p}`} x1={toPx(p)} x2={toPx(p)} y1={M.top + innerH} y2={M.top + innerH + 3} stroke="#000" />
        ))}
        {xTicks.major.map(({ p, label }) => (
          <g key={`M${p}`}>
            <line x1={toPx(p)} x2={toPx(p)} y1={M.top + innerH} y2={M.top + innerH + 6} stroke="#000" />
            <text x={toPx(p)} y={M.top + innerH + 8 + fontSizes.tick} textAnchor="middle" fontSize={fontSizes.tick}>{label}</text>
          </g>
        ))}
        {yTicks.map((p) => {
          const y = M.top + innerH - (p / 100) * innerH;
          return (
            <g key={`y${p}`}>
              <line x1={M.left - 5} x2={M.left} y1={y} y2={y} stroke="#000" />
              <text x={M.left - 8} y={y + fontSizes.tick / 3} textAnchor="end" fontSize={fontSizes.tick}>{p}</text>
            </g>
          );
        })}
        <text
          transform={`translate(${14},${M.top + innerH / 2}) rotate(-90)`}
          textAnchor="middle"
          fontSize={fontSizes.axis}
        >
          {t("% of max")}
        </text>
        {/* Range gates, in layers: each range's body (its whole band, which drags the range side to
            side), then what is drawn, then the labels, then the two ends on top of everything, so
            an end stays a resize handle even where another range's band covers it. A narrower band
            lies over a wider one, so a range inside another can still be taken. */}
        <g style={{ pointerEvents: mode === "navigate" ? "auto" : "none" }}>
          {placedRanges.slice().sort((p, q) => (q.b - q.a) - (p.b - p.a)).map(({ r, a, b }) => (
            <rect
              key={`body-${r.gate.gate_id}`}
              className="gl-range-body"
              data-gate-id={r.gate.gate_id}
              x={a} y={M.top} width={Math.max(0, b - a)} height={innerH}
              fill="transparent"
              style={{ cursor: "move" }}
              onPointerDown={(e) => onGateDown(e, "body", r)}
            />
          ))}
          {/* No fill: a range is its bounds, as full-height lines, and a bar between them at its
              label's height, an arrowhead at each end pointing out to the bound. A side with no
              bound has no line, and its arrow runs to the edge of the plot. The bar follows the
              label when the label is dragged up or down. */}
          {placedRanges.map((placed) => {
            const { r, a, b } = placed;
            const lp = labelPlace(placed, drag?.kind === "label" ? drag : null);
            // The bar runs through the label; where the label is wider than the range it would hide
            // both arrowheads, so the bar runs just under it instead.
            const y = lp.w > b - a - 20 ? lp.cy + pillH / 2 + 5 : lp.cy;
            const selected = r.gate.gate_id === selectedGateId;
            const weight = selected ? ink.lineWidth + 1 : ink.lineWidth;
            return (
              <g key={r.gate.gate_id} className={"gl-range-gate" + (selected ? " is-selected" : "")} data-gate-id={r.gate.gate_id} style={{ pointerEvents: "none" }}>
                <line className="gl-range-bar" x1={a} x2={b} y1={y} y2={y} stroke={gateColour(r.gate.color)} strokeWidth={weight} />
                {([0, 1] as const).map((end) => {
                  const x = end === 0 ? a : b;
                  const out = end === 0 ? -1 : 1;
                  return (
                    <g key={end}>
                      {!r.open[end] && (
                        <line className="gl-range-bound" x1={x} x2={x} y1={M.top} y2={M.top + innerH} stroke={gateColour(r.gate.color)} strokeWidth={weight} />
                      )}
                      <path className="gl-range-arrow" d={`M${x},${y}l${-out * 8},-4.5v9z`} fill={gateColour(r.gate.color)} />
                    </g>
                  );
                })}
              </g>
            );
          })}
          {/* Labels, as on the scatter plot: a pill in the gate's colour, dragged on its own. */}
          {placedRanges.map((placed) => {
            const { cx, cy, w, text } = labelPlace(placed, drag?.kind === "label" ? drag : null);
            const id = placed.r.gate.gate_id;
            return (
              <g
                key={`label-${id}`}
                className="gl-range-label"
                data-gate-id={id}
                style={{ cursor: "move" }}
                onPointerDown={(e) => {
                  if (mode !== "navigate" || e.button !== 0) return;
                  begin({ kind: "label", pointerId: e.pointerId, gateId: id, fromX: e.clientX, fromY: e.clientY, start: labelPlace(placed).offset, dx: 0, dy: 0, moved: false }, e);
                }}
              >
                <rect x={cx - w / 2} y={cy - pillH / 2} width={w} height={pillH} rx={3} fill={gateColour(placed.r.gate.color)} fillOpacity={ink.labelBackground} />
                <text x={cx} y={cy + fontSizes.gate * 0.35} textAnchor="middle" fontSize={fontSizes.gate} fill="#fff" style={{ userSelect: "none" }}>
                  {text}
                </text>
              </g>
            );
          })}
          {placedRanges.map(({ r, a, b }) => ([0, 1] as const).map((end) => r.open[end] ? null : (
            <line
              key={`end-${r.gate.gate_id}-${end}`}
              className={end === 0 ? "gl-range-lo" : "gl-range-hi"}
              data-gate-id={r.gate.gate_id}
              x1={end === 0 ? a : b} x2={end === 0 ? a : b} y1={M.top} y2={M.top + innerH}
              stroke="transparent" strokeWidth={END_HIT_PX}
              style={{ cursor: "ew-resize" }}
              onPointerDown={(e) => onGateDown(e, end === 0 ? "lo" : "hi", r)}
            />
          )))}
        </g>
        {drag?.kind === "split" && (
          <line
            className="gl-range-draft"
            x1={toPx(drag.to)} x2={toPx(drag.to)} y1={M.top} y2={M.top + innerH}
            stroke="#1f77b4" strokeWidth={1.5} strokeDasharray="4 3"
          />
        )}
        {drag?.kind === "draw" && (
          <rect
            className="gl-range-draft"
            x={toPx(Math.min(drag.from, drag.to))}
            y={M.top}
            width={Math.abs(toPx(drag.to) - toPx(drag.from))}
            height={innerH}
            fill="#1f77b4" opacity={0.15} stroke="#1f77b4" strokeDasharray="4 3"
          />
        )}
      </svg>
      <div className="gl-histogram-axis" style={{ width, fontSize: fontSizes.axis }}>
        <SearchableSelect label={t("Histogram channel")} value={channel} options={channelOptions} onChange={onChannelChange} />
      </div>
      {/* How the curve is drawn; nothing here changes a gate or a count. */}
      <div className="gl-histogram-options" role="group" aria-label={t("Histogram display")}>
        {(["smoothed", "binned"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={"gl-chip" + (style === option ? " active" : "")}
            aria-pressed={style === option}
            onClick={() => setStyle(option)}
          >
            {t(option === "smoothed" ? "Smoothed" : "Binned")}
          </button>
        ))}
        <label className="gl-field-inline" title={t("Number of equal bins across the axis")}>
          {t("Bins")}
          <NumberField value={bins} onCommit={setBins} min={16} max={1024} step={16} integer aria-label={t("Histogram bins")} style={{ width: 58 }} />
        </label>
        <label className="gl-field-inline" title={t("Width of the smoothing (the Gaussian's standard deviation) as a percentage of the axis")}>
          {t("Smoothing")}
          <NumberField value={smoothing} onCommit={setSmoothing} min={0.1} max={10} step={0.1} disabled={style !== "smoothed"} aria-label={t("Histogram smoothing width")} style={{ width: 52 }} />
          % {t("of axis")}
        </label>
      </div>
    </div>
  );
}
