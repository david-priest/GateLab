// strategyTree.ts — the gating tree a Strategy export can carry: the populations the strategy
// draws and their ancestors, in tree order, each with its event count and its % of parent, drawn
// as one vector page with the population tree's own branch glyphs (TreeConnectors). The page is
// written three ways: as the second page of the strategy's PDF, and as a second file beside its
// SVG or PNG, named as the strategy's with "_tree" added.
//
// The counts are the file's population masks (derived.masks), the masks the multi-population
// panels count each panel's parent from, and a percentage is taken from them as the panels take
// theirs: the count over the parent's, times 100, rounded to one decimal. A population made by
// one gate therefore shows here the number its gate shows wherever the strategy draws that gate
// on the parent's events: on the multi-population grid, and on a single population's full path.
// Without the full path, a single population's strip draws its gates on all events, and the
// share on its panel is of all events.

import type { PopulationMap } from "../engine/models";
import { populationTreeOrder, type MaskMap } from "../engine/populations";
import { EXPORT_FONT, exportId, finishExportSvg } from "../plots/exportSvg";
import { SEG, TREE_LINE_COLOR, treeConnectorLines } from "./TreeConnectors";

const SVG_NS = "http://www.w3.org/2000/svg";

/** As the strategy panels round a percentage. */
const round1 = (x: number): number => Math.round(x * 10) / 10;

export interface StrategyTreeRow {
  popId: string;
  name: string;
  /** 0 for the root. */
  depth: number;
  /** As populationTreeOrder gives it, over the tree's own rows: └ or ├, and │ carried down. */
  isLastPath: boolean[];
  /** Events in the population; null where the file has no mask for it. */
  count: number | null;
  /** Its share of the parent's events, %, to one decimal; null for the root and where the parent holds no events. */
  percentOfParent: number | null;
}

/**
 * The tree of a strategy drawn from one file: the populations in `shownIds` and every ancestor
 * up to the root, in tree order, with the glyphs of that tree alone (a population's last shown
 * child takes └ even where the full tree has more children after it).
 */
export function strategyTreeRows(
  populations: PopulationMap,
  rootId: string,
  shownIds: readonly string[],
  masks: MaskMap,
  nEvents: number,
): StrategyTreeRow[] {
  if (!populations[rootId]) return [];
  const keep = new Set<string>([rootId]);
  for (const id of shownIds) {
    for (let cur: string | null = id; cur && populations[cur] && !keep.has(cur); cur = populations[cur].parent_id) keep.add(cur);
  }
  const tree: PopulationMap = {};
  for (const id of keep) tree[id] = populations[id];
  const counts = new Map<string, number | null>();
  // The root holds every event, as the strategy's first panel does.
  const countOf = (id: string): number | null => {
    if (id === rootId) return nEvents;
    if (!counts.has(id)) {
      const mask = masks[id];
      let count = 0;
      if (mask) for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
      counts.set(id, mask ? count : null);
    }
    return counts.get(id)!;
  };
  return populationTreeOrder(tree, rootId).map(({ popId, depth, isLastPath }) => {
    const count = countOf(popId);
    const parentId = popId === rootId ? null : populations[popId].parent_id;
    const parentCount = parentId ? countOf(parentId) : null;
    return {
      popId,
      name: populations[popId].name,
      depth,
      isLastPath,
      count,
      percentOfParent: count !== null && parentCount ? round1((count / parentCount) * 100) : null,
    };
  });
}

/** The tree drawn as a page: an SVG finished for an editor, with its size in CSS pixels. */
export interface StrategyTreePage {
  root: SVGSVGElement;
  width: number;
  height: number;
}

/** "–" where there is no number. */
export const treeCountText = (row: StrategyTreeRow): string => (row.count === null ? "–" : row.count.toLocaleString());
export const treePercentText = (row: StrategyTreeRow): string =>
  row.depth === 0 ? "" : row.percentOfParent === null ? "–" : `${row.percentOfParent.toFixed(1)}%`;

/**
 * The rows as a page: a title, a header (Population, Events, % of parent), and one row per
 * population with its glyphs, its name, and its two numbers set right. Text is sized `fontSize`
 * px, the strategy's title size, and measured in the export font where a canvas exists.
 */
export function composeStrategyTree(rows: readonly StrategyTreeRow[], opts: { title: string; fontSize: number }): StrategyTreePage {
  const fs = opts.fontSize;
  const context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  const widthOf = (text: string, bold = false) => {
    if (!context) return text.length * fs * 0.6;
    context.font = `${bold ? "bold " : ""}${fs}px ${EXPORT_FONT}`;
    return context.measureText(text).width;
  };
  const pad = 12;
  const rowHeight = Math.max(20, Math.ceil(fs * 1.75));
  const gap = 2 * fs;
  const textGap = 4;
  const header = { name: "Population", count: "Events", percent: "% of parent" };
  const nameWidth = Math.max(widthOf(header.name, true), ...rows.map((row) => row.depth * SEG + textGap + widthOf(row.name)));
  const countWidth = Math.max(widthOf(header.count, true), ...rows.map((row) => widthOf(treeCountText(row))));
  const percentWidth = Math.max(widthOf(header.percent, true), ...rows.map((row) => widthOf(treePercentText(row))));
  const countRight = Math.ceil(pad + nameWidth + gap + countWidth);
  const percentRight = Math.ceil(countRight + gap + percentWidth);
  const width = Math.ceil(Math.max(percentRight, pad + widthOf(opts.title)) + pad);
  /** The baseline of text centred in a row whose top is `top`. */
  const baseline = (top: number) => Math.round((top + rowHeight / 2 + fs * 0.35) * 10) / 10;

  const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const textAt = (x: number, y: number, text: string, extra: Record<string, string | number> = {}) =>
    el("text", { x, y, "font-size": fs, fill: "#000000", ...extra }, text);

  const root = el("svg", {});
  root.appendChild(el("rect", { width: "100%", height: "100%", fill: "#ffffff" }));
  const page = el("g", { id: "gating-tree" });
  root.appendChild(page);

  let y = pad;
  page.appendChild(textAt(pad, Math.round((y + fs * 0.82) * 10) / 10, opts.title, { id: "gating-tree-title", fill: "#334155" }));
  y += Math.ceil(fs * 1.2) + 8;

  const head = el("g", { id: "gating-tree-header" });
  head.appendChild(textAt(pad, baseline(y), header.name, { "font-weight": "bold" }));
  head.appendChild(textAt(countRight, baseline(y), header.count, { "font-weight": "bold", "text-anchor": "end" }));
  head.appendChild(textAt(percentRight, baseline(y), header.percent, { "font-weight": "bold", "text-anchor": "end" }));
  y += rowHeight;
  head.appendChild(el("line", { x1: pad, y1: y + 0.5, x2: percentRight, y2: y + 0.5, stroke: "#94a3b8", "stroke-width": 0.75 }));
  page.appendChild(head);
  y += 2;

  rows.forEach((row, index) => {
    const group = el("g", { id: exportId("row", index + 1, row.name) });
    const lines = treeConnectorLines(row.depth, row.isLastPath, rowHeight / 2, rowHeight);
    if (lines.length) {
      const glyphs = el("g", { transform: `translate(${pad},${y})` });
      for (const line of lines) {
        glyphs.appendChild(el("line", { x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2, stroke: TREE_LINE_COLOR, "stroke-width": 1.5, "stroke-linecap": "square" }));
      }
      group.appendChild(glyphs);
    }
    group.appendChild(textAt(pad + row.depth * SEG + (row.depth ? textGap : 0), baseline(y), row.name));
    group.appendChild(textAt(countRight, baseline(y), treeCountText(row), { "text-anchor": "end" }));
    const percent = treePercentText(row);
    if (percent) group.appendChild(textAt(percentRight, baseline(y), percent, { "text-anchor": "end" }));
    page.appendChild(group);
    y += rowHeight;
  });

  const height = Math.ceil(y + pad);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  finishExportSvg(root, { widthPx: width, heightPx: height });
  return { root, width, height };
}
