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

/** Turn one item a quarter turn about its frame's centre, the frame's width and height swapped. */
export function turnItem(item: LayoutItem, direction: TurnDirection): void {
  const next = ((turnOf(item) + (direction === "right" ? 90 : 270)) % 360) as LayoutTurn;
  const centreX = item.x + item.width / 2;
  const centreY = item.y + item.height / 2;
  const { width, height } = item;
  item.width = height;
  item.height = width;
  item.x = centreX - item.width / 2;
  item.y = centreY - item.height / 2;
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
 * A text block grown to show every line it was given, as an upright one grows downward: the
 * growth is along the turned text's own height, away from its first line, so a block turned 90°
 * grows to the left, one turned 270° to the right, and one turned 180° upward. It never shrinks.
 */
export function growTextFrame(item: LayoutItem, contentHeight: number): void {
  const need = Math.ceil(contentHeight) + 4;
  const turn = turnOf(item);
  if (turn === 90 || turn === 270) {
    if (need <= item.width) return;
    if (turn === 90) item.x -= need - item.width;
    item.width = need;
    return;
  }
  if (need <= item.height) return;
  if (turn === 180) item.y -= need - item.height;
  item.height = need;
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
    width: `calc(${boxWidth}px - 2 * var(--gl-hair, 1px))`,
    height: `calc(${boxHeight}px - 2 * var(--gl-hair, 1px))`,
    marginLeft: (width - boxWidth) / 2,
    marginTop: (height - boxHeight) / 2,
    transform: `rotate(${turn}deg)`,
  };
}
