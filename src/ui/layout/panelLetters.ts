// panelLetters.ts — panel letters on a Layout sheet. A letter is a text item bound to the item it
// letters (`letterFor`), placed at an offset from that item's top-left corner (`letterOffset`).
// What it says is not the user's: it is the item's rank among the sheet's lettered items in
// reading order, as A, B, C … Z, AA, AB …, in the sheet's letter style. The tab writes text, size,
// weight and place into each letter on every edit (reconcilePanelLetters), so the page, the
// iteration and the export draw a letter as the text it is.

import {
  DEFAULT_LETTER_STYLE,
  pageOrigins,
  pageSizePx,
  type LayoutItem,
  type LayoutLetterStyle,
  type LayoutSheet,
  type LayoutTextRecipe,
  type LayoutWorkspace,
} from "../../engine/layout";

type Frame = Pick<LayoutItem, "id" | "x" | "y" | "width" | "height">;

/** Kinds that never take a letter: text (letters included) and shapes. */
const UNLETTERED = new Set<string>(["text", "shape"]);

export function isPanelLetter(item: Pick<LayoutItem, "recipe">): item is LayoutItem & { recipe: LayoutTextRecipe & { letterFor: string } } {
  return item.recipe.kind === "text" && typeof item.recipe.letterFor === "string" && item.recipe.letterFor !== "";
}

/** Whether an item can be given a letter: every kind but text and shapes. */
export function canTakePanelLetter(item: Pick<LayoutItem, "recipe">): boolean {
  return !UNLETTERED.has(item.recipe.kind);
}

/** The sheet's letter style, every field present. */
export function sheetLetterStyle(sheet: Pick<LayoutSheet, "letterStyle">): LayoutLetterStyle {
  return { ...DEFAULT_LETTER_STYLE, ...(sheet.letterStyle ?? {}) };
}

/** The n-th letter, 0-based: A … Z, AA, AB …, in the case given. */
export function letterLabel(index: number, letterCase: LayoutLetterStyle["case"] = "upper"): string {
  let n = Math.max(0, Math.floor(index)) + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return letterCase === "lower" ? out.toLowerCase() : out;
}

/** Whether two frames are on one row: their vertical extents overlap by more than half of the shorter. */
function sameRow(a: Frame, b: Frame): boolean {
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlap > Math.min(a.height, b.height) / 2;
}

/**
 * Frames in reading order: rows from top to bottom, left to right within a row. A frame joins
 * the first row holding a frame it shares a row with, so a tall panel beside two short ones
 * reads first and the short ones after it, top one first.
 */
export function readingOrder<T extends Frame>(frames: readonly T[]): T[] {
  const sorted = [...frames].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: T[][] = [];
  for (const frame of sorted) {
    const row = rows.find((candidate) => candidate.some((member) => sameRow(member, frame)));
    if (row) row.push(frame);
    else rows.push([frame]);
  }
  rows.sort((a, b) => Math.min(...a.map((f) => f.y)) - Math.min(...b.map((f) => f.y)));
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x || a.y - b.y));
}

/**
 * The letters that stand: one per item that can take a letter and is on the sheet, the first
 * found for each. A letter whose item is gone, or a second letter for one item, does not.
 */
function standingLetters(sheet: Pick<LayoutSheet, "items">): Map<string, LayoutItem> {
  const byId = new Map(sheet.items.map((item) => [item.id, item]));
  const letterOf = new Map<string, LayoutItem>();
  for (const item of sheet.items) {
    if (!isPanelLetter(item)) continue;
    const target = byId.get(item.recipe.letterFor);
    if (!target || !canTakePanelLetter(target) || letterOf.has(target.id)) continue;
    letterOf.set(target.id, item);
  }
  return letterOf;
}

/** Each letter item's text, by the letter's id: its item's rank among the lettered items in reading order. */
export function panelLetters(sheet: Pick<LayoutSheet, "items" | "letterStyle">): Map<string, string> {
  const letterOf = standingLetters(sheet);
  const lettered = sheet.items.filter((item) => letterOf.has(item.id));
  const style = sheetLetterStyle(sheet);
  return new Map(readingOrder(lettered).map((item, index) => [letterOf.get(item.id)!.id, letterLabel(index, style.case)]));
}

/** The frame a letter of this text takes in this style: wide enough for its letters, never under the text minimum. */
export function letterBoxSize(text: string, style: LayoutLetterStyle): { width: number; height: number } {
  return {
    width: Math.max(24, Math.ceil(style.fontSize * 0.8 * Math.max(1, text.length) + 6)),
    height: Math.max(20, Math.ceil(style.fontSize * 1.2 + 6)),
  };
}

/** Where a new letter goes: its box just outside the item's top-left corner, the glyph above and left of it. */
export function defaultLetterOffset(size: { width: number; height: number }): { x: number; y: number } {
  return { x: -size.width + 4, y: -size.height + 6 };
}

/** A letter's top-left corner kept on the page its item's corner is on. */
function onPage(sheet: Pick<LayoutSheet, "page">, target: Frame, x: number, y: number, size: { width: number; height: number }) {
  const one = pageSizePx(sheet.page);
  const origins = pageOrigins(sheet.page);
  const origin = origins.find((o) => target.x >= o.x && target.x < o.x + one.width && target.y >= o.y && target.y < o.y + one.height) ?? origins[0] ?? { x: 0, y: 0 };
  return {
    x: Math.round(Math.min(origin.x + one.width - size.width, Math.max(origin.x, x))),
    y: Math.round(Math.min(origin.y + one.height - size.height, Math.max(origin.y, y))),
  };
}

/**
 * Bring a sheet's letters up to date, in place: letters whose item is gone (or that double
 * another) are removed; each other letter takes its text, size and weight from the sheet, its
 * item's group and lock, and its place from its item and offset. With the sheet as it was before
 * the edit, a letter moved while its item stayed keeps the move as its new offset.
 */
export function applyPanelLetters(sheet: LayoutSheet, before?: LayoutSheet | null): void {
  if (!sheet.items.some(isPanelLetter)) return;
  const letterOf = standingLetters(sheet);
  const standing = new Set([...letterOf.values()].map((letter) => letter.id));
  sheet.items = sheet.items.filter((item) => !isPanelLetter(item) || standing.has(item.id));
  const texts = panelLetters(sheet);
  const style = sheetLetterStyle(sheet);
  const old = new Map((before?.items ?? []).map((item) => [item.id, item]));
  for (const [targetId, letter] of letterOf) {
    const target = sheet.items.find((item) => item.id === targetId)!;
    const recipe = letter.recipe as LayoutTextRecipe;
    const text = texts.get(letter.id) ?? "";
    const size = letterBoxSize(text, style);
    let offset = recipe.letterOffset ?? defaultLetterOffset(size);
    const was = old.get(letter.id);
    const targetWas = old.get(targetId);
    const letterMoved = !!was && (was.x !== letter.x || was.y !== letter.y);
    const targetMoved = !targetWas || targetWas.x !== target.x || targetWas.y !== target.y;
    if (letterMoved && !targetMoved) offset = { x: Math.round(letter.x - target.x), y: Math.round(letter.y - target.y) };
    const at = onPage(sheet, target, target.x + offset.x, target.y + offset.y, size);
    const next: LayoutTextRecipe = { ...recipe, text, fontSize: style.fontSize, letterOffset: offset };
    if (style.bold) next.bold = true;
    else delete next.bold;
    letter.recipe = next;
    letter.x = at.x;
    letter.y = at.y;
    letter.width = size.width;
    letter.height = size.height;
    letter.showFrame = false;
    if (target.group) letter.group = target.group;
    else delete letter.group;
    if (target.locked) letter.locked = true;
    else letter.locked = false;
  }
}

/** Every sheet's letters brought up to date after an edit, given the workspace before it. The workspace is changed in place and returned. */
export function reconcilePanelLetters(before: LayoutWorkspace | null, next: LayoutWorkspace): LayoutWorkspace {
  for (const sheet of next.sheets) applyPanelLetters(sheet, before?.sheets.find(({ id }) => id === sheet.id) ?? null);
  return next;
}

/**
 * Letters for the items named (or, with none named, every item on the sheet) that can take one
 * and have none; an item that has a letter keeps it. Returns the new letters' ids.
 */
export function addPanelLetters(sheet: LayoutSheet, ids: readonly string[] | null, newId: () => string = () => crypto.randomUUID()): string[] {
  const letterOf = standingLetters(sheet);
  const wanted = sheet.items.filter((item) => canTakePanelLetter(item) && !letterOf.has(item.id) && (!ids || ids.length === 0 || ids.includes(item.id)));
  if (!wanted.length) return [];
  let z = Math.max(0, ...sheet.items.map((item) => item.z));
  const style = sheetLetterStyle(sheet);
  const created: string[] = [];
  for (const target of wanted) {
    const size = letterBoxSize("A", style);
    const at = onPage(sheet, target, target.x + defaultLetterOffset(size).x, target.y + defaultLetterOffset(size).y, size);
    const id = newId();
    created.push(id);
    sheet.items.push({
      id,
      x: at.x,
      y: at.y,
      width: size.width,
      height: size.height,
      z: ++z,
      recipe: { kind: "text", text: "", fontSize: style.fontSize, letterFor: target.id, letterOffset: { x: at.x - target.x, y: at.y - target.y } },
    });
  }
  applyPanelLetters(sheet);
  return created;
}

/** Remove the letters of the items named, and any letters named themselves; with none named, every letter on the sheet. Returns how many went. */
export function removePanelLetters(sheet: LayoutSheet, ids: readonly string[] | null): number {
  const all = !ids || ids.length === 0;
  const before = sheet.items.length;
  sheet.items = sheet.items.filter((item) => !isPanelLetter(item) || !(all || ids!.includes(item.id) || ids!.includes(item.recipe.letterFor)));
  const removed = before - sheet.items.length;
  if (removed) applyPanelLetters(sheet);
  return removed;
}

/** A field of the sheet's letter style set; the letters take it when the edit is committed. */
export function setLetterStyle(sheet: LayoutSheet, patch: Partial<LayoutLetterStyle>): void {
  sheet.letterStyle = { ...sheetLetterStyle(sheet), ...patch };
}

/** The ids given with the letters of the items among them, so a copy of a lettered item has a letter of its own. */
export function withPanelLetterIds(sheet: Pick<LayoutSheet, "items">, ids: readonly string[]): string[] {
  const out = [...ids];
  for (const letter of standingLetters(sheet).values()) {
    if (isPanelLetter(letter) && ids.includes(letter.recipe.letterFor) && !out.includes(letter.id)) out.push(letter.id);
  }
  return out;
}

/** Whether any item named can take a letter (with none named, any item on the sheet), and whether any of them has one. */
export function panelLetterState(sheet: Pick<LayoutSheet, "items">, ids: readonly string[]): { canAdd: boolean; canRemove: boolean } {
  const letterOf = standingLetters(sheet);
  const scope = ids.length ? sheet.items.filter((item) => ids.includes(item.id)) : sheet.items;
  return {
    canAdd: scope.some((item) => canTakePanelLetter(item) && !letterOf.has(item.id)),
    canRemove: scope.some((item) => letterOf.has(item.id) || (isPanelLetter(item) && [...letterOf.values()].includes(item))),
  };
}
