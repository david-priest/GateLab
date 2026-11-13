// figureStyle.ts — the workspace's figure style: the text sizes and the histogram line width that a
// Layout sheet, a Plotting chart, the Illustration figure and the Strategy tab take in place of
// their own when they follow it (each has `followFigureStyle`). The gates' line width and colour
// are the workspace's gate ink (plots/gateInk.ts), which every tab already shares. Display only:
// nothing here reaches a gate, a population or a count. Sizes are px, as each tab stores its own.

import { DEFAULT_LAYOUT_STYLE, LAYOUT_STYLE_RANGES, type LayoutPlotStyle } from "./layout";

export type FigureStyleKey = "fontTick" | "fontAxis" | "fontTitle" | "fontLegend" | "fontGate" | "histLineWidth";

export type FigureStyle = Pick<LayoutPlotStyle, FigureStyleKey>;

export const FIGURE_STYLE_KEYS: readonly FigureStyleKey[] = ["fontTick", "fontAxis", "fontTitle", "fontLegend", "fontGate", "histLineWidth"];

/** A Layout sheet's defaults, so a sheet that follows the style draws as a new sheet did. */
export const DEFAULT_FIGURE_STYLE: Readonly<FigureStyle> = Object.freeze(
  Object.fromEntries(FIGURE_STYLE_KEYS.map((key) => [key, DEFAULT_LAYOUT_STYLE[key]])) as FigureStyle,
);

/** A saved style: each field within a sheet style's range, a missing or malformed one the default. */
export function normalizeFigureStyle(value: unknown): FigureStyle {
  const out: FigureStyle = { ...DEFAULT_FIGURE_STYLE };
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const candidate = value as Record<string, unknown>;
  for (const key of FIGURE_STYLE_KEYS) {
    const raw = candidate[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const [lo, hi] = LAYOUT_STYLE_RANGES[key];
    out[key] = Math.min(hi, Math.max(lo, raw));
  }
  return out;
}

/** Whether a style is the defaults throughout; a workspace saves its style only when it is not. */
export function isDefaultFigureStyle(style: FigureStyle): boolean {
  return FIGURE_STYLE_KEYS.every((key) => style[key] === DEFAULT_FIGURE_STYLE[key]);
}
