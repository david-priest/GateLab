// TreeConnectors.tsx — the SVG ├/└/│ population-tree branch glyphs (make_tree_connectors port,
// app.R:5617-5659). Shared by the POPULATIONS tree (PopulationTree.tsx) and the Statistics tab so
// both draw the identical branching. Width is exactly depth*SEG px, so it drops in wherever a
// depth*16 left-indent used to be. `isLastPath[i]` = "the ancestor at level i+1 is its parent's
// last child" → └ vs ├ at the leaf, │ carried down for non-last ancestors.

import React from "react";

export const SEG = 16; // px per depth level
const HGT = 20; // connector SVG height (rows must be ~this tall for the │ segments to join)
export const TREE_LINE_COLOR = "#bfc5cf";

/** One line of a row's glyphs; y as px, or as a percentage of the row's height. */
export interface TreeConnectorLine {
  key: string;
  x1: number;
  y1: number | string;
  x2: number;
  y2: number | string;
}

/**
 * The lines of one row's glyphs, `depth * SEG` px wide: └ or ├ at the row's own level, and │ for
 * each ancestor level still to be continued. `mid` and `bottom` are the row's middle and foot. The
 * Strategy tab's gating-tree export draws its rows from these too.
 */
export function treeConnectorLines(depth: number, isLastPath: boolean[], mid: number | string, bottom: number | string): TreeConnectorLine[] {
  const total = depth * SEG;
  const lines: TreeConnectorLine[] = [];
  const line = (x1: number, y1: number | string, x2: number, y2: number | string, key: string) => lines.push({ key, x1, y1, x2, y2 });
  for (let i = 1; i <= depth; i++) {
    const cx = (i - 1) * SEG + Math.floor(SEG / 2);
    const isLast = isLastPath[i - 1] === true;
    const isLeaf = i === depth;
    if (isLeaf) {
      if (isLast) {
        line(cx, 0, cx, mid, `v${i}`); // └
        line(cx, mid, total, mid, `h${i}`);
      } else {
        line(cx, 0, cx, bottom, `v${i}`); // ├
        line(cx, mid, total, mid, `h${i}`);
      }
    } else if (!isLast) {
      line(cx, 0, cx, bottom, `a${i}`); // │
    }
  }
  return lines;
}

// `fill`: the glyphs follow the row height, so the │ segments join across rows taller than HGT —
// a population row whose gate badges wrap to several lines, or a Statistics <td>. The vertical
// lines run in percentages of the SVG's own height and the SVG sits absolutely inside a
// row-height placeholder of the same width, so nothing is stretched (a stretched SVG thickened
// the ├ tick with the row) and the placeholder adds no height of its own to the row.
export function TreeConnectors({ depth, isLastPath, fill }: { depth: number; isLastPath: boolean[]; fill?: boolean }) {
  if (depth === 0) return null;
  const total = depth * SEG;
  const mid: number | string = fill ? "50%" : Math.floor(HGT / 2);
  const bottom: number | string = fill ? "100%" : HGT;
  const lines: React.ReactNode[] = treeConnectorLines(depth, isLastPath, mid, bottom).map(({ key, x1, y1, x2, y2 }) => (
    <line key={key} x1={x1} y1={y1} x2={x2} y2={y2} stroke={TREE_LINE_COLOR} strokeWidth={1.5} strokeLinecap="square" />
  ));
  if (!fill) {
    return (
      <svg width={total} height={HGT} viewBox={`0 0 ${total} ${HGT}`} style={{ flexShrink: 0, overflow: "visible" }}>
        {lines}
      </svg>
    );
  }
  return (
    <span className="tree-connectors-fill" style={{ position: "relative", display: "block", width: total, flexShrink: 0, alignSelf: "stretch" }}>
      <svg width={total} height="100%" style={{ position: "absolute", top: 0, left: 0, overflow: "visible" }}>
        {lines}
      </svg>
    </span>
  );
}
