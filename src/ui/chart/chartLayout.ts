// chartLayout.ts — the panel-size arithmetic the Plotting charts share: a panel's plot width, set
// or fitted to its contents, and whether its category labels turn, with the margin they then take.

export interface ChartPanelLayout {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  rotateLabels: boolean;
}

/** The plot's width: the panel's whole width less its margins when set (an Illustration panel's size), else `natural`. */
export function fittedInnerWidth(panelWidth: number, margin: { left: number; right: number }, natural: number): number {
  return panelWidth > 0 ? Math.max(40, panelWidth - margin.left - margin.right) : natural;
}

/** The longest category label's width, each label counted to at most `maxChars` characters. */
export function longestLabelWidth(labels: readonly string[], tickFont: number, maxChars = Infinity): number {
  return Math.max(0, ...labels.map((label) => Math.min(label.length, maxChars) * tickFont * 0.58));
}

/** Whether the category labels turn: the longest is wider than its slot and than `minWidth`. */
export function labelsRotate(longestLabelPx: number, step: number, minWidth: number): boolean {
  return longestLabelPx > step * 0.88 && longestLabelPx > minWidth;
}

/**
 * The bottom margin for turned labels. At 35°, the vertical component is ~57% of the rendered
 * label width. Cap it because labels are middle-ellipsized, while their full value remains
 * available in a tooltip.
 */
export function rotatedLabelsBottom(longestLabelPx: number, minBottom: number): number {
  return Math.min(142, Math.max(minBottom, 30 + Math.min(longestLabelPx, 210) * 0.57));
}

/** Each category label's drawn width at the tick font, counted to at most `maxChars` characters as `compactChartLabel` shortens it. */
export function labelWidths(labels: readonly string[], tickFont: number, maxChars = Infinity): number[] {
  return labels.map((label) => Math.min(label.length, maxChars) * tickFont * 0.58);
}

/**
 * The left margin turned labels need. Each label ends at its slot's centre, `step * (i + 0.5)`
 * right of the plot's left edge, and turned by `angle` degrees it reaches cos(angle) of its width
 * to the left; the margin is the furthest any reaches past the plot's edge, with `pad` px to spare.
 */
export function rotatedLabelsLeft(widths: readonly number[], step: number, angle = 35, pad = 3): number {
  const reach = Math.cos((angle * Math.PI) / 180);
  return Math.max(0, ...widths.map((width, i) => Math.ceil(width * reach - step * (i + 0.5) + pad)));
}

/**
 * The left margin, at least `left`, that keeps turned labels inside the panel. `innerAt` gives the
 * plot's width at a margin: a panel of set width loses plot width to a wider margin, which narrows
 * each slot and moves the first label's end left, so the margin is raised until it holds.
 */
export function leftForTurnedLabels(left: number, widths: readonly number[], innerAt: (left: number) => number, angle = 35): number {
  if (!widths.length) return left;
  let margin = left;
  for (let round = 0; round < 8; round++) {
    const need = rotatedLabelsLeft(widths, innerAt(margin) / widths.length, angle);
    if (need <= margin) break;
    margin = need;
  }
  return margin;
}

/** The height of a line of n under the category labels, at the tick font. */
export function nLineHeight(tickFont: number): number {
  return tickFont + 3;
}

/**
 * The layout with `rows` lines of n under the category labels: the bottom margin and the panel
 * grown by them, and the first line's baseline below the plot, under turned labels or under the
 * labels' one line. No rows leaves the layout as it is.
 */
export function withNRows<L extends ChartPanelLayout>(layout: L, tickFont: number, rows: number): L & { nBaseline: number } {
  const line = nLineHeight(tickFont);
  const nBaseline = (layout.rotateLabels ? layout.margin.bottom - 4 : 18) + line;
  if (rows <= 0) return { ...layout, nBaseline };
  const extra = rows * line;
  return { ...layout, height: layout.height + extra, margin: { ...layout.margin, bottom: layout.margin.bottom + extra }, nBaseline };
}
