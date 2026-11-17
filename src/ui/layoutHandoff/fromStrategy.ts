/**
 * The Strategy tab's hand-off to Layout (moved from App.tsx): a strategy strip as one block. One
 * plot of a strip goes through addPlotsToSheet (shared.ts).
 */
import { cloneLayoutWorkspace, type LayoutStrategyRecipe, type LayoutWorkspace } from "../../engine/layout";
import { followSheetIteration } from "../layoutFollow";
import { addItemOnPage } from "../layoutPlacement";

/** A strategy strip from the Strategy tab as a Layout block on the active sheet. */
export function addStrategyBlock(
  current: LayoutWorkspace,
  recipe: LayoutStrategyRecipe,
  size: { width: number; height: number } | undefined,
): LayoutWorkspace {
  const next = cloneLayoutWorkspace(current);
  const sheet = next.sheets.find((s0) => s0.id === next.activeSheetId) ?? next.sheets[0];
  if (!sheet) return current;
  // A multi-population grid is framed at the size it was drawn on the Strategy tab and put on a
  // page: one wider or taller than the page is scaled as a whole to fit inside its margin, its
  // panels, fonts and arrows in proportion, and one the last page has no room for starts a new
  // page. Its frame can be dragged larger or smaller, which scales the block the same way.
  addItemOnPage(sheet, followSheetIteration(sheet, [recipe])[0], { width: size?.width ?? 600, height: size?.height ?? 320 });
  return next;
}
