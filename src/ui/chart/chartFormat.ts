// chartFormat.ts — how the Plotting charts write their numbers and labels: a measured value for a
// tick or a tooltip, a fraction as a percentage tick, and a long label shortened in the middle.

/** A panel title's longest shown length; a longer one is shortened in the middle, whole in its tooltip. */
export const CHART_TITLE_CHARS = 36;

/** A measured value for a tick or a tooltip: four significant figures, thousands separated. */
export function formatMeasured(value: number): string {
  if (!Number.isFinite(value)) return "–";
  const abs = Math.abs(value);
  if (abs >= 1000) return Math.round(value).toLocaleString("en-US");
  return Number(value.toPrecision(4)).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/**
 * A measured value as the flow plots tick a linear axis (mini_plot.js `_formatLinearVal`): 1.5K and
 * 2.5M above a thousand, whole numbers from 100, one decimal from 1, two significant figures below.
 */
export function formatLinearTick(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-9) return "0";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}${Number((abs / 1e6).toPrecision(3))}M`;
  if (abs >= 1e3) return `${sign}${Number((abs / 1e3).toPrecision(3))}K`;
  if (abs >= 100) return sign + Math.round(abs).toLocaleString("en-US");
  if (abs >= 1) return sign + Number(abs.toFixed(1));
  return sign + Number(abs.toPrecision(2));
}

/** A tick as a percentage with the decimals the axis's ticks need (2.5%, 0.25%), and no more. */
export function formatPercentTick(value: number, ticks: readonly number[]): string {
  const decimals = [0, 1, 2, 3].find((d) => ticks.every((tick) => Math.abs(Number((tick * 100).toFixed(d)) - tick * 100) < 1e-9)) ?? 3;
  return `${(value * 100).toFixed(decimals)}%`;
}

export function compactChartLabel(label: string, maxLength = 30): string {
  if (label.length <= maxLength) return label;
  const tail = Math.max(8, Math.floor(maxLength * 0.35));
  return `${label.slice(0, maxLength - tail - 1)}…${label.slice(-tail)}`;
}
