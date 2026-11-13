// overlayHeading.ts — what heads a panel that overlays chosen populations: the populations it
// draws, not the Data tab's population of its row or column. Used by the Illustration grid and its
// export, a figure block on a Layout sheet, and a plot sent to the Layout tab on its own.

import type { FigurePage, FigurePanel, FigureValue } from "../engine/figure";

/** The longest heading kept whole, as a chart panel's title is kept whole (TITLE_CHARS). */
export const OVERLAY_HEADING_CHARS = 36;

/**
 * The populations a panel overlays, joined with ", " in the order chosen. Longer than a heading
 * holds, the plot's name when it has one, else the first population and how many more.
 */
export function overlayHeading(names: readonly string[], plotName?: string): string {
  const joined = names.join(", ");
  if (joined.length <= OVERLAY_HEADING_CHARS || names.length < 2) return joined;
  return plotName?.trim() ? plotName : `${names[0]} + ${names.length - 1} more`;
}

/**
 * The heading of a panel whose plot overlays chosen populations, or draws the figure's populations
 * together; null for any other panel.
 */
function panelOverlayHeading(panel: FigurePanel): string | null {
  const chosen = panel.plot.together ? panel.populations : panel.plot.populations;
  return chosen?.length ? overlayHeading(chosen.map((ref) => ref.label), panel.plot.name) : null;
}

/**
 * The page with each row and column heading that names a population headed by the populations
 * its panels overlay instead, where every panel under that heading overlays the same chosen
 * populations. A heading over panels that draw other populations is left as it is.
 */
export function headOverlaidPopulations(page: FigurePage): FigurePage {
  const relabel = (group: FigureValue[], panels: readonly FigurePanel[]): FigureValue[] => {
    if (!panels.length || !group.some((value) => value.dimension === "populations")) return group;
    const headings = new Set(panels.map(panelOverlayHeading));
    const [heading] = headings;
    if (headings.size !== 1 || heading === null) return group;
    return group.map((value) => (value.dimension === "populations" ? { ...value, label: heading } : value));
  };
  const rows = page.rows.map((group, i) => relabel(group, page.panels.filter((p) => p.row === i)));
  const columns = page.columns.map((group, i) => relabel(group, page.panels.filter((p) => p.column === i)));
  const pageValues = JSON.parse(page.key) as FigureValue[];
  const pageHeading = relabel(pageValues, page.panels);
  const label = pageHeading === pageValues ? page.label : pageHeading.map((value) => value.label).join(" / ");
  return { ...page, label, rows, columns };
}
