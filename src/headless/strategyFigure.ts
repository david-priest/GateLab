// strategyFigure.ts — a gating-strategy figure for one population of one file, without a browser.
//
// What is drawn is the Strategy tab's own: computeGatingStrategy gives each gate on the path from
// the root with its parent events in display space, and buildStrategyPayload the panel the tab
// hands its renderer (axis ranges and ticks, gate vertices and curved outlines, quadrant centres
// and arms, labels and counts). The tab's renderer (vendor/GateLabR mini_plot.js) paints events on
// a canvas, which Node has no implementation of, so the drawing here is a plain one: a binned
// pseudocolour of every parent event in the renderer's jet palette, the gate, the axes and the
// counts. It is for checking a strategy and for a record, not a replacement for the tab's export.

import { jsPDF } from "jspdf";
import { computeGatingStrategy, buildStrategyPayload, type StrategyPayloadOptions } from "../engine/strategy";
import { densityColorFraction, DEFAULT_DENSITY_COLOR_POWER } from "../engine/pseudocolor";
import type { AxisTicks } from "../engine/ticks";
import type { GatedFile } from "./headless";

type Pt = [number, number];

/** One panel as the Strategy tab's payload describes it (strategy.ts strategyPayload). */
interface PanelStep {
  gate_name: string;
  x_channel: string;
  y_channel: string;
  gate_type: string;
  color: string;
  include: boolean;
  vertices: Pt[];
  outline?: Pt[];
  center?: Pt;
  /** Curly arms (h, v), or a spider quadrant's four (with l, d). */
  arms?: { h: Pt[]; v: Pt[]; l?: Pt[]; d?: Pt[] };
  x: number[];
  y: number[];
  x_range: [number, number];
  y_range: [number, number];
  x_logicle_ticks: AxisTicks | null;
  y_logicle_ticks: AxisTicks | null;
  n_before: number;
  n_after: number;
  pct_pass: number;
}

type Shape =
  | { kind: "rect"; x: number; y: number; w: number; h: number; fill: string }
  | { kind: "line"; points: Pt[]; stroke: string; width: number; closed?: boolean; dash?: boolean }
  | { kind: "text"; x: number; y: number; text: string; size: number; anchor: "start" | "middle" | "end"; rotate?: boolean; bold?: boolean; fill?: string };

const PLOT = 200;
const MARGIN = { left: 62, right: 22, top: 40, bottom: 44 };
const CELL_W = MARGIN.left + PLOT + MARGIN.right;
const CELL_H = MARGIN.top + PLOT + MARGIN.bottom;
const HEADER = 34;
const BINS = 100;

/** The jet palette of the Strategy tab's renderer (mini_plot.js _jetLUT), at t in [0, 1]. */
function jet(t: number): string {
  let r: number, g: number, b: number;
  if (t < 0.125) { r = 0; g = 0; b = 0.5 + t * 4; }
  else if (t < 0.375) { r = 0; g = (t - 0.125) * 4; b = 1; }
  else if (t < 0.625) { r = (t - 0.375) * 4; g = 1; b = 1 - (t - 0.375) * 4; }
  else if (t < 0.875) { r = 1; g = 1 - (t - 0.625) * 4; b = 0; }
  else { r = 1 - (t - 0.875) * 4; g = 0; b = 0; }
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

/** Evenly spaced round ticks over a linear range. */
function linearTicks(lo: number, hi: number): { pos: number[]; labels: string[] } {
  const span = hi - lo;
  if (!(span > 0)) return { pos: [], labels: [] };
  const raw = span / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const pos: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) pos.push(Number(v.toPrecision(12)));
  const fmt = (v: number) => {
    const a = Math.abs(v);
    if (a >= 1e6) return `${Number((v / 1e6).toPrecision(3))}M`;
    if (a >= 1e3) return `${Number((v / 1e3).toPrecision(3))}K`;
    return String(Number(v.toPrecision(3)));
  };
  return { pos, labels: pos.map(fmt) };
}

function panelShapes(step: PanelStep, ox: number, oy: number): Shape[] {
  const out: Shape[] = [];
  const [x0, x1] = step.x_range;
  const [y0, y1] = step.y_range;
  const sx = (v: number) => ox + MARGIN.left + ((v - x0) / (x1 - x0 || 1)) * PLOT;
  const sy = (v: number) => oy + MARGIN.top + PLOT - ((v - y0) / (y1 - y0 || 1)) * PLOT;
  const clampX = (v: number) => Math.max(ox + MARGIN.left, Math.min(ox + MARGIN.left + PLOT, v));
  const clampY = (v: number) => Math.max(oy + MARGIN.top, Math.min(oy + MARGIN.top + PLOT, v));

  // Every parent event, binned, coloured by density as the renderer colours its pseudocolour.
  const counts = new Uint32Array(BINS * BINS);
  let max = 0;
  for (let i = 0; i < step.x.length; i++) {
    const fx = (step.x[i] - x0) / (x1 - x0);
    const fy = (step.y[i] - y0) / (y1 - y0);
    if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) continue;
    const k = Math.min(BINS - 1, Math.floor(fy * BINS)) * BINS + Math.min(BINS - 1, Math.floor(fx * BINS));
    if (++counts[k] > max) max = counts[k];
  }
  const cell = PLOT / BINS;
  for (let k = 0; k < counts.length; k++) {
    if (!counts[k]) continue;
    const bx = k % BINS;
    const by = Math.floor(k / BINS);
    const t = densityColorFraction(counts[k] / max, DEFAULT_DENSITY_COLOR_POWER);
    out.push({ kind: "rect", x: ox + MARGIN.left + bx * cell, y: oy + MARGIN.top + PLOT - (by + 1) * cell, w: cell, h: cell, fill: jet(t) });
  }

  // The gate: its true outline where a transform bends it, else its vertices; a quadrant's crosshair.
  if (step.center) {
    if (step.arms) {
      out.push({ kind: "line", points: step.arms.h.map(([a, b]) => [clampX(sx(a)), clampY(sy(b))]), stroke: step.color, width: 1.2 });
      out.push({ kind: "line", points: step.arms.v.map(([a, b]) => [clampX(sx(a)), clampY(sy(b))]), stroke: step.color, width: 1.2 });
      for (const arm of [step.arms.l, step.arms.d]) {
        if (arm) out.push({ kind: "line", points: arm.map(([a, b]) => [clampX(sx(a)), clampY(sy(b))]), stroke: step.color, width: 1.2 });
      }
    } else {
      const cx = clampX(sx(step.center[0]));
      const cy = clampY(sy(step.center[1]));
      out.push({ kind: "line", points: [[cx, oy + MARGIN.top], [cx, oy + MARGIN.top + PLOT]], stroke: step.color, width: 1.2 });
      out.push({ kind: "line", points: [[ox + MARGIN.left, cy], [ox + MARGIN.left + PLOT, cy]], stroke: step.color, width: 1.2 });
    }
  } else {
    const ring = step.outline?.length ? step.outline : step.vertices;
    if (ring.length > 1) out.push({ kind: "line", points: ring.map(([a, b]) => [clampX(sx(a)), clampY(sy(b))]), stroke: step.color, width: 1.4, closed: true, dash: !step.include });
  }

  // Frame and axes.
  const L = ox + MARGIN.left, T = oy + MARGIN.top, R = L + PLOT, B = T + PLOT;
  out.push({ kind: "line", points: [[L, T], [R, T], [R, B], [L, B]], stroke: "#000", width: 0.8, closed: true });
  const xt = step.x_logicle_ticks ? { pos: step.x_logicle_ticks.major_pos, labels: step.x_logicle_ticks.major_labels } : linearTicks(x0, x1);
  const yt = step.y_logicle_ticks ? { pos: step.y_logicle_ticks.major_pos, labels: step.y_logicle_ticks.major_labels } : linearTicks(y0, y1);
  xt.pos.forEach((v, i) => {
    const px = sx(v);
    if (px < L - 0.01 || px > R + 0.01) return;
    out.push({ kind: "line", points: [[px, B], [px, B + 4]], stroke: "#000", width: 0.8 });
    out.push({ kind: "text", x: px, y: B + 14, text: xt.labels[i], size: 8, anchor: "middle" });
  });
  yt.pos.forEach((v, i) => {
    const py = sy(v);
    if (py < T - 0.01 || py > B + 0.01) return;
    out.push({ kind: "line", points: [[L - 4, py], [L, py]], stroke: "#000", width: 0.8 });
    out.push({ kind: "text", x: L - 6, y: py + 3, text: yt.labels[i], size: 8, anchor: "end" });
  });
  out.push({ kind: "text", x: L + PLOT / 2, y: B + 32, text: step.x_channel, size: 10, anchor: "middle" });
  out.push({ kind: "text", x: L - 42, y: T + PLOT / 2, text: step.y_channel, size: 10, anchor: "middle", rotate: true });
  const name = `${step.include ? "" : "NOT "}${step.gate_name}`;
  out.push({ kind: "text", x: L, y: oy + 16, text: name, size: 10, anchor: "start", bold: true });
  out.push({
    kind: "text", x: L, y: oy + 30, size: 8, anchor: "start",
    text: `${step.n_after.toLocaleString("en-US")} of ${step.n_before.toLocaleString("en-US")} events (${step.pct_pass}%)`,
  });
  return out;
}

export interface StrategyFigure {
  width: number;
  height: number;
  shapes: Shape[];
  /** Gates on the path, in order, with their counts, for the report. */
  steps: { gate: string; include: boolean; before: number; after: number }[];
}

/**
 * The figure of the gates from the root to `populationId` in one file, every parent event shown.
 * Null when the population has no gate on its path.
 */
export function strategyFigure(g: GatedFile, populationId: string, columns = 4): StrategyFigure | null {
  const t = g.tree;
  const steps = computeGatingStrategy(g.sample, t.gates, t.populations, t.root_population_id, populationId, { fullPath: true, maxEvents: 0 });
  if (!steps.length) return null;
  const opts: StrategyPayloadOptions = {
    gateView: ["forward"], displayMode: "pseudocolor", maxEvents: 0, nColumns: columns, plotSize: PLOT, fitToColumns: false,
    contourThreshold: 5, pointAlpha: 1, densityColorPower: DEFAULT_DENSITY_COLOR_POWER, pointSize: 1, kdeBandwidth: 0,
    pubStyle: true, gateLineWidth: 1.4, fontSizes: { tick: 8, axis_label: 10, gate_label: 9, title: 10 },
  };
  const payload = buildStrategyPayload(g.sample, steps, null, {}, opts) as { steps: PanelStep[] };
  const cols = Math.max(1, Math.min(columns, payload.steps.length));
  const rows = Math.ceil(payload.steps.length / cols);
  const shapes: Shape[] = [];
  const pop = t.populations[populationId];
  shapes.push({ kind: "text", x: 10, y: 20, text: `${g.file}: ${pop?.name ?? populationId}`, size: 12, anchor: "start", bold: true });
  payload.steps.forEach((s, i) => shapes.push(...panelShapes(s, (i % cols) * CELL_W, HEADER + Math.floor(i / cols) * CELL_H)));
  return {
    width: cols * CELL_W,
    height: HEADER + rows * CELL_H,
    shapes,
    steps: payload.steps.map((s) => ({ gate: s.gate_name, include: s.include, before: s.n_before, after: s.n_after })),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: number) => Number(v.toFixed(2));

export function figureSvg(f: StrategyFigure): string {
  const body = f.shapes.map((s) => {
    if (s.kind === "rect") return `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" fill="${s.fill}"/>`;
    if (s.kind === "line") {
      const pts = s.points.map(([a, b]) => `${n(a)},${n(b)}`).join(" ");
      return `<${s.closed ? "polygon" : "polyline"} points="${pts}" fill="none" stroke="${esc(s.stroke)}" stroke-width="${s.width}"${s.dash ? ' stroke-dasharray="4 3"' : ""}/>`;
    }
    const rot = s.rotate ? ` transform="rotate(-90 ${n(s.x)} ${n(s.y)})"` : "";
    return `<text x="${n(s.x)}" y="${n(s.y)}" font-size="${s.size}" text-anchor="${s.anchor}"${s.bold ? ' font-weight="bold"' : ""}${rot}>${esc(s.text)}</text>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f.width}" height="${f.height}" viewBox="0 0 ${f.width} ${f.height}" font-family="Arial, Helvetica, sans-serif">\n<rect width="100%" height="100%" fill="#fff"/>\n${body}\n</svg>\n`;
}

const rgb = (c: string): [number, number, number] => {
  const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(c);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (h) {
    const x = h[1].length === 3 ? h[1].split("").map((d) => d + d).join("") : h[1];
    return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
  }
  return [0, 0, 0];
};

/** The same figure as a vector PDF, one page at the figure's size in points. */
export function figurePdf(f: StrategyFigure): Uint8Array {
  const doc = new jsPDF({ orientation: f.width > f.height ? "landscape" : "portrait", unit: "pt", format: [f.width, f.height], compress: true });
  doc.setFont("helvetica", "normal");
  for (const s of f.shapes) {
    if (s.kind === "rect") {
      doc.setFillColor(...rgb(s.fill));
      doc.rect(s.x, s.y, s.w, s.h, "F");
    } else if (s.kind === "line") {
      doc.setDrawColor(...rgb(s.stroke));
      doc.setLineWidth(s.width);
      doc.setLineDashPattern(s.dash ? [4, 3] : [], 0);
      const pts = s.closed ? [...s.points, s.points[0]] : s.points;
      for (let i = 1; i < pts.length; i++) doc.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    } else {
      doc.setFont("helvetica", s.bold ? "bold" : "normal");
      doc.setFontSize(s.size);
      doc.setTextColor(0, 0, 0);
      const align = s.anchor === "start" ? "left" : s.anchor === "middle" ? "center" : "right";
      // jsPDF applies `align` along the page's x axis even to rotated text, so a rotated label is
      // centred by hand: it runs up from its start, half its width below the centre.
      if (s.rotate) doc.text(s.text, s.x + s.size / 3, s.y + doc.getTextWidth(s.text) / 2, { angle: 90 });
      else doc.text(s.text, s.x, s.y, { align });
    }
  }
  return new Uint8Array(doc.output("arraybuffer"));
}
