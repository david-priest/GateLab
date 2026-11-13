// layoutClipboard.ts — the Layout tab's own clipboard: copy, cut and paste of items, between the
// sheets of a workspace. Held in memory only; the system clipboard is never read or written.

import { copyLayoutItems, dropStaleReadsFrom, isPlotLikeRecipe, sheetSizePx, type LayoutItem, type LayoutSheet } from "../../engine/layout";
import { followSheetIteration } from "../layoutFollow";
import { usePersistedTabState } from "../tabState";

/** How far each paste on the sheet the items came from steps from the one before, in px. */
export const PASTE_STEP = 20;

export interface LayoutClipboard {
  /** The sheet the items were copied from. */
  sheetId: string;
  /** Copies of the items as they were when copied, bottom of the stack first. */
  items: LayoutItem[];
  /** How many times this copy has been pasted on each sheet, by sheet id (paste in place not counted). */
  pastes: Record<string, number>;
}

export type LayoutClipboardAction = "copy" | "cut" | "paste" | "paste-in-place";

/** Cmd/Ctrl-C, -X, -V and Shift-Cmd/Ctrl-V; anything else is not the clipboard's. */
export function layoutClipboardShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): LayoutClipboardAction | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "c" && !event.shiftKey) return "copy";
  if (key === "x" && !event.shiftKey) return "cut";
  if (key === "v") return event.shiftKey ? "paste-in-place" : "paste";
  return null;
}

/** The items of `sheet` named by `ids`, copied as they are now in stacking order; null when none is there. */
export function copyToLayoutClipboard(sheet: LayoutSheet, ids: readonly string[]): LayoutClipboard | null {
  const items = sheet.items.filter((item) => ids.includes(item.id)).sort((a, b) => a.z - b.z);
  if (!items.length) return null;
  return { sheetId: sheet.id, items: structuredClone(items), pastes: {} };
}

/**
 * Pastes the clipboard's items on top of `sheet`, which is changed in place, and returns the new
 * items' ids and the clipboard with this paste counted. Copies are made as Duplicate makes them
 * (copyLayoutItems): new ids, groups of their own, and a text block copied with its plot reads the
 * copy. A text block whose plot was not copied keeps reading the original where that is still on
 * the sheet, and becomes plain text elsewhere. A locked item stays locked.
 *
 * On the sheet the items came from, paste n (from 1) is n × 20 px right and down from the
 * originals; on another sheet the first lands at the originals' place, moved onto the sheet if it
 * would fall outside, and each later one steps 20 px. Paste in place takes the originals' place.
 */
export function pasteLayoutClipboard(
  sheet: LayoutSheet,
  clipboard: LayoutClipboard,
  inPlace: boolean,
  newId?: () => string,
): { created: string[]; clipboard: LayoutClipboard } {
  const sameSheet = sheet.id === clipboard.sheetId;
  const count = clipboard.pastes[sheet.id] ?? 0;
  const { copies } = copyLayoutItems(clipboard.items, newId);
  let dx = 0;
  let dy = 0;
  if (!inPlace) {
    const step = (sameSheet ? count + 1 : count) * PASTE_STEP;
    const onPage = sameSheet ? { dx: 0, dy: 0 } : ontoSheet(sheet, clipboard.items);
    dx = onPage.dx + step;
    dy = onPage.dy + step;
  }
  // Plots pasted on another sheet follow its iteration as plots added from another tab do; on
  // their own sheet they keep what the originals had, as a duplicate does.
  const recipes = sameSheet
    ? copies.map((copy) => copy.recipe)
    : followSheetIteration(sheet, copies.map(({ recipe }) => {
        if (!isPlotLikeRecipe(recipe) || !("iterated" in recipe)) return recipe;
        const { iterated: _own, ...rest } = recipe;
        return rest as typeof recipe;
      }));
  let z = Math.max(0, ...sheet.items.map((item) => item.z));
  const created = copies.map((copy, index) => {
    sheet.items.push({ ...copy, recipe: recipes[index], x: copy.x + dx, y: copy.y + dy, z: ++z });
    return copy.id;
  });
  dropStaleReadsFrom(sheet);
  return {
    created,
    clipboard: inPlace ? clipboard : { ...clipboard, pastes: { ...clipboard.pastes, [sheet.id]: count + 1 } },
  };
}

/**
 * The tab's clipboard and what acts on it. The clipboard is held in the session's tab state, so
 * it outlives a visit to another tab and a change of sheet, and is emptied when another workspace
 * is opened (clearPersistedTabState). Each action that changes the sheet is one undo step.
 */
export function useLayoutClipboard({ sheet, mutateActiveSheet, removeItems, selectMany }: {
  sheet: LayoutSheet | undefined;
  mutateActiveSheet: (change: (sheet: LayoutSheet) => void) => void;
  removeItems: (ids: readonly string[]) => void;
  selectMany: (ids: string[]) => void;
}) {
  const [clipboard, setClipboard] = usePersistedTabState<LayoutClipboard | null>("layout.clipboard", null);
  const copy = (ids: readonly string[]) => {
    const held = sheet ? copyToLayoutClipboard(sheet, ids) : null;
    if (held) setClipboard(held);
    return held !== null;
  };
  const cut = (ids: readonly string[]) => {
    if (copy(ids)) removeItems(ids);
  };
  const paste = (inPlace: boolean) => {
    if (!clipboard) return;
    let result: ReturnType<typeof pasteLayoutClipboard> | null = null;
    mutateActiveSheet((draft) => { result = pasteLayoutClipboard(draft, clipboard, inPlace); });
    const done = result as ReturnType<typeof pasteLayoutClipboard> | null;
    if (!done) return;
    setClipboard(done.clipboard);
    selectMany(done.created);
  };
  /** Runs a key's action; copy and cut act on `ids`, the selection. */
  const run = (action: LayoutClipboardAction, ids: readonly string[]) => {
    if (action === "copy") copy(ids);
    else if (action === "cut") cut(ids);
    else paste(action === "paste-in-place");
  };
  return { canPaste: clipboard !== null, copy, cut, paste, run };
}

/** The shift that brings the items' bounding box onto the sheet; none when it is on already. */
function ontoSheet(sheet: LayoutSheet, items: readonly LayoutItem[]): { dx: number; dy: number } {
  const { width, height } = sheetSizePx(sheet.page);
  const left = Math.min(...items.map((item) => item.x));
  const top = Math.min(...items.map((item) => item.y));
  const right = Math.max(...items.map((item) => item.x + item.width));
  const bottom = Math.max(...items.map((item) => item.y + item.height));
  const shift = (low: number, high: number, size: number) => {
    if (low < 0 || high - low > size) return -low;
    if (high > size) return size - high;
    return 0;
  };
  return { dx: shift(left, right, width), dy: shift(top, bottom, height) };
}
