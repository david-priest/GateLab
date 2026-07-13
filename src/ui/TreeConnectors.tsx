// TreeConnectors.tsx — the SVG ├/└/│ population-tree branch glyphs (make_tree_connectors port,
// app.R:5617-5659). Shared by the POPULATIONS tree (PopulationTree.tsx) and the Statistics tab so
// both draw the identical branching. Width is exactly depth*SEG px, so it drops in wherever a
// depth*16 left-indent used to be. `isLastPath[i]` = "the ancestor at level i+1 is its parent's
// last child" → └ vs ├ at the leaf, │ carried down for non-last ancestors.

import React from "react";

export const SEG = 16; // px per depth level
const HGT = 20; // connector SVG height (rows must be ~this tall for the │ segments to join)
const LINE_COLOR = "#bfc5cf";

// `fill`: stretch the glyphs vertically to the row height (preserveAspectRatio="none") so the │
// segments join across rows even when the row is taller than HGT — used by the Statistics table,
// whose <td> rows are taller than a tree row. The tree view leaves it off (rows are HGT-sized).
export function TreeConnectors({ depth, isLastPath, fill }: { depth: number; isLastPath: boolean[]; fill?: boolean }) {
  if (depth === 0) return null;
  const total = depth * SEG;
  const mid = Math.floor(HGT / 2);
  const lines: React.ReactNode[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number, key: string) => (
    <line key={key} x1={x1} y1={y1} x2={x2} y2={y2} stroke={LINE_COLOR} strokeWidth={1.5} strokeLinecap="square" />
  );
  for (let i = 1; i <= depth; i++) {
    const cx = (i - 1) * SEG + Math.floor(SEG / 2);
    const isLast = isLastPath[i - 1] === true;
    const isLeaf = i === depth;
    if (isLeaf) {
      if (isLast) {
        lines.push(line(cx, 0, cx, mid, `v${i}`)); // └
        lines.push(line(cx, mid, total, mid, `h${i}`));
      } else {
        lines.push(line(cx, 0, cx, HGT, `v${i}`)); // ├
        lines.push(line(cx, mid, total, mid, `h${i}`));
      }
    } else if (!isLast) {
      lines.push(line(cx, 0, cx, HGT, `a${i}`)); // │
    }
  }
  return (
    <svg
      width={total}
      height={HGT}
      viewBox={`0 0 ${total} ${HGT}`}
      preserveAspectRatio={fill ? "none" : undefined}
      style={{ flexShrink: 0, overflow: "visible", ...(fill ? { height: "100%" } : null) }}
    >
      {lines}
    </svg>
  );
}
