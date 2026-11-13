/**
 * The Strategy tab's hand-off to Layout (moved from App.tsx): a strategy strip as one block. One
 * plot of a strip goes through addPlotsToSheet (shared.ts).
 */
import { cloneLayoutWorkspace, nextLayoutItemPosition, type LayoutStrategyRecipe, type LayoutWorkspace } from "../../engine/layout";
import { followSheetIteration } from "../layoutFollow";

/** A strategy strip from the Strategy tab as a Layout block on the active sheet. */
export function addStrategyBlock(
  current: LayoutWorkspace,
  recipe: LayoutStrategyRecipe,
  size: { width: number; height: number } | undefined,
): LayoutWorkspace {
  const next = cloneLayoutWorkspace(current);
  const sheet = next.sheets.find((s0) => s0.id === next.activeSheetId) ?? next.sheets[0];
  if (!sheet) return current;
  // A multi-population grid is framed at the size it was drawn on the Strategy tab, so it
  // arrives as it was made; the sheet grows to show it, and its frame can be dragged smaller,
  // which scales the block as a whole.
  const frame = nextLayoutItemPosition(sheet, size?.width ?? 600, size?.height ?? 320);
  sheet.items.push({ id: crypto.randomUUID(), ...frame, recipe: followSheetIteration(sheet, [recipe])[0] });
  sheet.width = Math.max(sheet.width, frame.x + frame.width + 48);
  sheet.height = Math.max(sheet.height, frame.y + frame.height + 48);
  return next;
}
