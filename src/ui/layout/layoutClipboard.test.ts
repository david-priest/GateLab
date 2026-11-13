// The Layout clipboard's model: what a copy holds and where each paste lands. Synthetic sheets of
// plots of D1 and D2 and text blocks; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { createLayoutSheet, DEFAULT_ITERATION, sheetSizePx, type LayoutItem, type LayoutRecipe, type LayoutSheet } from "../../engine/layout";
import { copyToLayoutClipboard, layoutClipboardShortcut, pasteLayoutClipboard, PASTE_STEP } from "./layoutClipboard";

const plot = (id: string, x: number, y: number, z: number, extra: Partial<LayoutItem> = {}, recipe: Partial<LayoutRecipe> = {}): LayoutItem => ({
  id, x, y, z, width: 200, height: 180,
  recipe: { kind: "biplot", sampleId: "D1", populationId: "CD4_positive", xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "pseudocolor", ...recipe } as LayoutRecipe,
  ...extra,
});
const text = (id: string, x: number, y: number, z: number, readsFrom?: string): LayoutItem => ({
  id, x, y, z, width: 160, height: 32,
  recipe: { kind: "text", text: "Text", fontSize: 18, ...(readsFrom ? { readsFrom } : {}) },
});
function sheetWith(id: string, items: LayoutItem[]): LayoutSheet {
  const sheet = createLayoutSheet(id);
  sheet.id = id;
  sheet.items = items;
  return sheet;
}
let counter = 0;
const newId = () => `new-${++counter}`;

describe("layoutClipboardShortcut", () => {
  it("reads Cmd or Ctrl with C, X, V and Shift-V, and nothing else", () => {
    const k = (key: string, more: Partial<KeyboardEvent> = {}) => layoutClipboardShortcut({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...more });
    expect(k("c", { metaKey: true })).toBe("copy");
    expect(k("x", { ctrlKey: true })).toBe("cut");
    expect(k("v", { metaKey: true })).toBe("paste");
    expect(k("V", { metaKey: true, shiftKey: true })).toBe("paste-in-place");
    expect(k("c")).toBeNull();
    expect(k("v", { metaKey: true, altKey: true })).toBeNull();
    expect(k("d", { metaKey: true })).toBeNull();
  });
});

describe("copy and paste on one sheet", () => {
  it("pastes 20 px right and down, stepping 20 px more each time, on top in the originals' order", () => {
    const sheet = sheetWith("S1", [plot("a", 100, 100, 2), plot("b", 300, 100, 0), text("c", 50, 50, 1)]);
    const clip = copyToLayoutClipboard(sheet, ["a", "b"])!;
    expect(clip.items.map(({ id }) => id)).toEqual(["b", "a"]); // stacking order
    const first = pasteLayoutClipboard(sheet, clip, false, newId);
    const pasted = sheet.items.slice(3);
    expect(first.created).toEqual(pasted.map(({ id }) => id));
    expect(pasted.map(({ x, y }) => [x, y])).toEqual([[320, 120], [120, 120]]);
    expect(pasted.map(({ z }) => z)).toEqual([3, 4]); // above everything, b under a as before
    const second = pasteLayoutClipboard(sheet, first.clipboard, false, newId);
    expect(sheet.items.slice(5).map(({ x, y }) => [x, y])).toEqual([[340, 140], [140, 140]]);
    expect(second.clipboard.pastes.S1).toBe(2);
  });

  it("holds the items as they were when copied", () => {
    const sheet = sheetWith("S1", [plot("a", 100, 100, 0)]);
    const clip = copyToLayoutClipboard(sheet, ["a"])!;
    sheet.items[0].x = 500;
    pasteLayoutClipboard(sheet, clip, false, newId);
    expect(sheet.items[1].x).toBe(100 + PASTE_STEP);
  });

  it("pastes in place at the originals' coordinates, without stepping the next paste", () => {
    const sheet = sheetWith("S1", [plot("a", 100, 100, 0)]);
    const clip = copyToLayoutClipboard(sheet, ["a"])!;
    const inPlace = pasteLayoutClipboard(sheet, clip, true, newId);
    expect(sheet.items[1]).toMatchObject({ x: 100, y: 100 });
    pasteLayoutClipboard(sheet, inPlace.clipboard, false, newId);
    expect(sheet.items[2]).toMatchObject({ x: 120, y: 120 });
  });

  it("keeps grouping among the pasted items with a group id of their own, and a locked item locked", () => {
    const sheet = sheetWith("S1", [plot("a", 0, 0, 0, { group: "g1", locked: true }), plot("b", 220, 0, 1, { group: "g1" })]);
    pasteLayoutClipboard(sheet, copyToLayoutClipboard(sheet, ["a", "b"])!, false, newId);
    const [a2, b2] = sheet.items.slice(2);
    expect(a2.group).toBeDefined();
    expect(a2.group).toBe(b2.group);
    expect(a2.group).not.toBe("g1");
    expect(a2.locked).toBe(true);
    expect(b2.locked).toBeUndefined();
    expect(new Set(sheet.items.map(({ id }) => id)).size).toBe(4);
  });
});

describe("a text block's link to a plot", () => {
  it("reads the pasted plot when the plot was copied with it", () => {
    const sheet = sheetWith("S1", [plot("p", 0, 0, 0), text("t", 0, 200, 1, "p")]);
    const other = sheetWith("S2", []);
    pasteLayoutClipboard(other, copyToLayoutClipboard(sheet, ["p", "t"])!, false, newId);
    const [p2, t2] = other.items;
    expect(t2.recipe).toMatchObject({ kind: "text", readsFrom: p2.id });
  });

  it("keeps reading the original on its own sheet, and loses the link on another", () => {
    const sheet = sheetWith("S1", [plot("p", 0, 0, 0), text("t", 0, 200, 1, "p")]);
    const clip = copyToLayoutClipboard(sheet, ["t"])!;
    pasteLayoutClipboard(sheet, clip, false, newId);
    expect(sheet.items[2].recipe).toMatchObject({ kind: "text", readsFrom: "p" });
    const other = sheetWith("S2", []);
    pasteLayoutClipboard(other, clip, false, newId);
    expect(other.items[0].recipe).not.toHaveProperty("readsFrom");
  });
});

describe("paste on another sheet", () => {
  it("lands at the originals' coordinates first, then steps 20 px", () => {
    const sheet = sheetWith("S1", [plot("a", 100, 120, 0)]);
    const other = sheetWith("S2", [plot("x", 0, 0, 5)]);
    const clip = copyToLayoutClipboard(sheet, ["a"])!;
    const first = pasteLayoutClipboard(other, clip, false, newId);
    expect(other.items[1]).toMatchObject({ x: 100, y: 120, z: 6 });
    pasteLayoutClipboard(other, first.clipboard, false, newId);
    expect(other.items[2]).toMatchObject({ x: 120, y: 140 });
  });

  it("moves items that would fall outside the page onto it, keeping their arrangement", () => {
    const sheet = sheetWith("S1", [plot("a", 2000, 1500, 0), plot("b", 2250, 1500, 1)]);
    const other = sheetWith("S2", []);
    const { width, height } = sheetSizePx(other.page);
    pasteLayoutClipboard(other, copyToLayoutClipboard(sheet, ["a", "b"])!, false, newId);
    const [a2, b2] = other.items;
    expect(b2.x + b2.width).toBe(width);
    expect(a2.y + a2.height).toBe(height);
    expect(b2.x - a2.x).toBe(250);
    // Paste in place keeps the originals' coordinates, wherever they are.
    pasteLayoutClipboard(other, copyToLayoutClipboard(sheet, ["a"])!, true, newId);
    expect(other.items[2]).toMatchObject({ x: 2000, y: 1500 });
  });

  it("makes pasted plots follow the sheet's iteration, as plots added from another tab do", () => {
    const sheet = sheetWith("S1", [plot("a", 0, 0, 0), text("t", 0, 200, 1)]);
    const iterating = sheetWith("S2", []);
    iterating.iteration = { ...DEFAULT_ITERATION, mode: "files" };
    pasteLayoutClipboard(iterating, copyToLayoutClipboard(sheet, ["a", "t"])!, false, newId);
    expect(iterating.items[0].recipe).toMatchObject({ iterated: true });
    expect(iterating.items[1].recipe).not.toHaveProperty("iterated");
    // On a sheet that does not iterate, a plot copied from one that does no longer follows.
    const plain = sheetWith("S3", []);
    pasteLayoutClipboard(plain, copyToLayoutClipboard(iterating, [iterating.items[0].id])!, false, newId);
    expect(plain.items[0].recipe).not.toHaveProperty("iterated");
  });

  it("keeps a plot's own iteration choice when pasted on its own sheet", () => {
    const sheet = sheetWith("S1", [plot("a", 0, 0, 0)]);
    sheet.iteration = { ...DEFAULT_ITERATION, mode: "files" };
    pasteLayoutClipboard(sheet, copyToLayoutClipboard(sheet, ["a"])!, false, newId);
    expect(sheet.items[1].recipe).not.toHaveProperty("iterated");
  });
});
