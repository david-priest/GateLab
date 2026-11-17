// layoutRotation.ts — text blocks and placed images turned in quarter turns on a Layout page. The
// turn is the content's (`item.rotation`, clockwise, absent for 0); the item's frame stays an
// upright box, so selection, snapping, alignment and the geometry fields work on it as on any
// other item. A turn by 90° swaps the frame's width and height about its centre, so a row label
// turned left becomes a tall narrow box in place. Plots, charts, figures and shapes are not turned,
// nor is a panel letter.

import type { CSSProperties } from "react";
import type { LayoutItem, LayoutSheet } from "../../engine/layout";
import { isPanelLetter } from "./panelLetters";

export type LayoutTurn = 0 | 90 | 180 | 270;
export type TurnDirection = "left" | "right";

/** The item's turn in degrees clockwise. */
export function turnOf(item: Pick<LayoutItem, "rotation">): LayoutTurn {
  return item.rotation ?? 0;
}

/** Whether an item's content can be turned: a text block that is not a panel letter, or a placed image. */
export function canTurn(item: Pick<LayoutItem, "recipe">): boolean {
  return (item.recipe.kind === "text" && !isPanelLetter(item)) || item.recipe.kind === "image";
}

/** Whether the turn controls apply to a selection: one or more items, every one of them turnable. */
export function canTurnAll(items: readonly Pick<LayoutItem, "recipe">[]): boolean {
  return items.length > 0 && items.every(canTurn);
}

/**
 * A position moved by half the difference of a frame's sides, kept on whole pixels: where the
 * sides differ by an odd number the shift is cut toward zero, so the centre moves half a pixel at
 * most and the next quarter turn moves it back; one off whole pixels is rounded onto them.
 */
const turnShift = (at: number, by: number) => (Number.isInteger(at) ? at + Math.trunc(by) : Math.round(at + by));

/** Turn one item a quarter turn about its frame's centre, the frame's width and height swapped. */
export function turnItem(item: LayoutItem, direction: TurnDirection): void {
  const next = ((turnOf(item) + (direction === "right" ? 90 : 270)) % 360) as LayoutTurn;
  const { width, height } = item;
  item.width = height;
  item.height = width;
  item.x = turnShift(item.x, (width - height) / 2);
  item.y = turnShift(item.y, (height - width) / 2);
  if (next) item.rotation = next;
  else delete item.rotation;
}

/** Turn every turnable, unlocked item of `ids` on the sheet, each about its own centre. Whether any turned. */
export function turnItems(sheet: LayoutSheet, ids: readonly string[], direction: TurnDirection): boolean {
  let turned = false;
  for (const item of sheet.items) {
    if (!ids.includes(item.id) || item.locked || !canTurn(item)) continue;
    turnItem(item, direction);
    turned = true;
  }
  return turned;
}

/**
 * A text block grown by `growth` (frame px, see textFrameGrowth) to show every line it was given,
 * as an upright one grows downward: the growth is along the turned text's own height, away from
 * its first line, so a block turned 90° grows to the left, one turned 270° to the right, and one
 * turned 180° upward. It never shrinks.
 */
export function growTextFrame(item: LayoutItem, growth: number): void {
  if (!(growth > 0)) return;
  const turn = turnOf(item);
  if (turn === 90 || turn === 270) {
    if (turn === 90) item.x -= growth;
    item.width += growth;
    return;
  }
  if (turn === 180) item.y -= growth;
  item.height += growth;
}

/**
 * The style of the box a turned item's content is laid out in, inside the item's body of
 * `width` × `height` (the frame, px): the frame's size with width and height swapped for a turn
 * of 90° or 270°, centred on the frame and turned about its centre. Undefined for no turn.
 */
export function turnedBoxStyle(turn: LayoutTurn, width: number, height: number): CSSProperties | undefined {
  if (!turn) return undefined;
  const sideways = turn !== 180;
  const boxWidth = sideways ? height : width;
  const boxHeight = sideways ? width : height;
  return {
    width: boxWidth,
    height: boxHeight,
    marginLeft: (width - boxWidth) / 2,
    marginTop: (height - boxHeight) / 2,
    transform: `rotate(${turn}deg)`,
  };
}
