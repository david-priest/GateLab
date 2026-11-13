// layoutRotationExport.ts — a turned text block or placed image in the exported page. The page
// draws the content laid out upright in a box with the frame's width and height swapped, turned
// about the frame's centre; the export writes it the same way: the content at its upright place
// and a rotate transform about the frame's centre on the item's own group. Text stays text and a
// placed SVG stays vector; the PDF writer and the PNG export follow the transform.

import type { LayoutTurn } from "../ui/layout/layoutRotation";

type Box = { left: number; top: number; width: number; height: number };

/** The turn the page drew an item with (its data-rotation), in degrees clockwise. */
export function exportTurn(item: HTMLElement): LayoutTurn {
  const turn = Number(item.dataset.rotation);
  return turn === 90 || turn === 180 || turn === 270 ? turn : 0;
}

/**
 * A box drawn inside a turned item (`drawn`, as measured on the page, page px), as it is before
 * the turn: its centre turned back about the frame's centre, its width and height swapped for a
 * quarter turn. The box itself for no turn.
 */
export function unturnedBox(drawn: Box, frame: Box, turn: LayoutTurn): Box {
  if (!turn) return drawn;
  const centreX = frame.left + frame.width / 2;
  const centreY = frame.top + frame.height / 2;
  const dx = drawn.left + drawn.width / 2 - centreX;
  const dy = drawn.top + drawn.height / 2 - centreY;
  // Turned back by the turn (y downward): 90° takes (x, y) to (y, -x), 180° to (-x, -y), 270° to (-y, x).
  const [ux, uy] = turn === 90 ? [dy, -dx] : turn === 180 ? [-dx, -dy] : [-dy, dx];
  const sideways = turn !== 180;
  const width = sideways ? drawn.height : drawn.width;
  const height = sideways ? drawn.width : drawn.height;
  return { left: centreX + ux - width / 2, top: centreY + uy - height / 2, width, height };
}

/** Set the turn on an item's group as a rotate transform about the frame's centre; nothing for no turn. */
export function setTurnTransform(group: Element, frame: Box, turn: LayoutTurn): void {
  if (!turn) return;
  group.setAttribute("transform", `rotate(${turn} ${round(frame.left + frame.width / 2)} ${round(frame.top + frame.height / 2)})`);
}

const round = (value: number) => Math.round(value * 1000) / 1000;
