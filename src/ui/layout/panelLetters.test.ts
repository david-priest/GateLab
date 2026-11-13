// Panel letters: reading order, the letters' text, and how a letter keeps to its item through
// moves, resizes, deletes, copies and the sheet's iteration. Synthetic items only.

import { describe, expect, it } from "vitest";
import { cloneLayoutWorkspace, copyLayoutItems, createLayoutSheet, type LayoutItem, type LayoutSheet, type LayoutWorkspace } from "../../engine/layout";
import { expandLayoutSheet } from "../../engine/layoutBatch";
import {
  addPanelLetters,
  isPanelLetter,
  letterLabel,
  panelLetters,
  readingOrder,
  reconcilePanelLetters,
  removePanelLetters,
  setLetterStyle,
  withPanelLetterIds,
} from "./panelLetters";

function plot(id: string, x: number, y: number, width = 200, height = 200): LayoutItem {
  return { id, x, y, width, height, z: 0, recipe: { kind: "biplot", sampleId: "D1", populationId: "CD4_positive", xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "pseudocolor" } };
}
function text(id: string, x: number, y: number): LayoutItem {
  return { id, x, y, width: 160, height: 32, z: 0, recipe: { kind: "text", text: "control", fontSize: 18 } };
}
function sheetOf(items: LayoutItem[]): LayoutSheet {
  const sheet = createLayoutSheet("S");
  sheet.items = items;
  return sheet;
}
function workspaceOf(sheet: LayoutSheet): LayoutWorkspace {
  return { version: 2, activeSheetId: sheet.id, sheets: [sheet] };
}
/** One edit as the tab makes it: a clone changed, then the letters brought up to date against the workspace before. */
function edit(workspace: LayoutWorkspace, change: (sheet: LayoutSheet) => void): LayoutWorkspace {
  const next = cloneLayoutWorkspace(workspace);
  change(next.sheets[0]);
  return reconcilePanelLetters(workspace, next);
}
/** Each lettered item's letter, by the item's id. */
function lettersByItem(sheet: LayoutSheet): Record<string, string> {
  const texts = panelLetters(sheet);
  const out: Record<string, string> = {};
  for (const item of sheet.items) if (isPanelLetter(item)) out[item.recipe.letterFor] = texts.get(item.id) ?? "";
  return out;
}
const letterOf = (sheet: LayoutSheet, itemId: string) => sheet.items.find((item) => isPanelLetter(item) && item.recipe.letterFor === itemId)!;

describe("letterLabel", () => {
  it("counts A to Z, then AA, AB …, in either case", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map((n) => letterLabel(n))).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
    expect(letterLabel(27, "lower")).toBe("ab");
  });
});

describe("reading order", () => {
  it("reads two rows of three from the top row, left to right, whatever order they were added in", () => {
    const items = [plot("p6", 500, 330), plot("p1", 20, 20), plot("p5", 260, 310), plot("p3", 500, 30), plot("p4", 20, 320), plot("p2", 260, 10)];
    expect(readingOrder(items).map(({ id }) => id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
  });

  it("reads a tall item beside two short ones first, then the short ones top to bottom", () => {
    const items = [plot("lower", 300, 230, 200, 180), plot("tall", 20, 20, 240, 420), plot("upper", 300, 20, 200, 180)];
    expect(readingOrder(items).map(({ id }) => id)).toEqual(["tall", "upper", "lower"]);
  });

  it("does not join items that overlap by half the shorter one or less", () => {
    // 100 of 200 overlap: exactly half, so two rows; the lower-left item reads after the upper-right.
    const items = [plot("b", 300, 0), plot("a", 0, 100)];
    expect(readingOrder(items).map(({ id }) => id)).toEqual(["b", "a"]);
  });
});

describe("panel letters on a sheet", () => {
  it("letters every item that can take one when nothing is named, skipping text, and keeps letters already given", () => {
    const sheet = sheetOf([plot("p2", 300, 40), plot("p1", 40, 40), text("t", 40, 300)]);
    const created = addPanelLetters(sheet, null);
    expect(created).toHaveLength(2);
    expect(lettersByItem(sheet)).toEqual({ p1: "A", p2: "B" });
    expect(letterOf(sheet, "p1")).toMatchObject({ recipe: { kind: "text", text: "A", fontSize: 16, bold: true } });
    // Asked again, nothing changes: an item with a letter keeps it.
    expect(addPanelLetters(sheet, null)).toEqual([]);
    expect(sheet.items.filter(isPanelLetter)).toHaveLength(2);
  });

  it("letters only the items named, and ranks among lettered items alone", () => {
    const sheet = sheetOf([plot("p1", 40, 40), plot("p2", 300, 40), plot("p3", 560, 40)]);
    addPanelLetters(sheet, ["p3", "p2"]);
    expect(lettersByItem(sheet)).toEqual({ p2: "A", p3: "B" });
    addPanelLetters(sheet, ["p1"]);
    expect(lettersByItem(sheet)).toEqual({ p1: "A", p2: "B", p3: "C" });
  });

  it("goes past Z to AA and AB, and writes lower case when the sheet asks", () => {
    const items = Array.from({ length: 28 }, (_, i) => plot(`p${i}`, 40 + (i % 7) * 150, 40 + Math.floor(i / 7) * 150, 120, 120));
    const sheet = sheetOf(items);
    addPanelLetters(sheet, null);
    expect(lettersByItem(sheet)).toMatchObject({ p0: "A", p25: "Z", p26: "AA", p27: "AB" });
    setLetterStyle(sheet, { case: "lower" });
    const lower = edit(workspaceOf(sheet), () => {}).sheets[0];
    expect(lettersByItem(lower)).toMatchObject({ p0: "a", p27: "ab" });
    expect(letterOf(lower, "p27").recipe).toMatchObject({ text: "ab" });
  });

  it("puts a letter just outside its item's top-left corner, kept on the page", () => {
    const sheet = sheetOf([plot("inside", 200, 200), plot("edge", 0, 0)]);
    addPanelLetters(sheet, null);
    const inside = letterOf(sheet, "inside");
    expect(inside.x + inside.width).toBeGreaterThan(200);
    expect(inside.x).toBeLessThan(200);
    expect(inside.y).toBeLessThan(200);
    const edge = letterOf(sheet, "edge");
    expect([edge.x, edge.y]).toEqual([0, 0]);
  });

  it("renumbers when a lettered item moves or goes, and removes the letter of an item that goes", () => {
    let ws = workspaceOf(sheetOf([plot("p1", 40, 40), plot("p2", 300, 40), plot("p3", 40, 300)]));
    ws = edit(ws, (sheet) => { addPanelLetters(sheet, null); });
    expect(lettersByItem(ws.sheets[0])).toEqual({ p1: "A", p2: "B", p3: "C" });
    // p3 moved to the top row, left of p1.
    ws = edit(ws, (sheet) => { Object.assign(sheet.items.find(({ id }) => id === "p3")!, { x: 0, y: 60 }); });
    expect(lettersByItem(ws.sheets[0])).toEqual({ p3: "A", p1: "B", p2: "C" });
    expect(letterOf(ws.sheets[0], "p1").recipe).toMatchObject({ text: "B" });
    // p3 removed: its letter goes with it, and the others close up.
    ws = edit(ws, (sheet) => { sheet.items = sheet.items.filter(({ id }) => id !== "p3"); });
    expect(ws.sheets[0].items.filter(isPanelLetter)).toHaveLength(2);
    expect(lettersByItem(ws.sheets[0])).toEqual({ p1: "A", p2: "B" });
  });

  it("follows its item when the item moves or is resized from its top-left corner, and a drag of the letter sets its offset", () => {
    let ws = workspaceOf(sheetOf([plot("p1", 200, 200)]));
    ws = edit(ws, (sheet) => { addPanelLetters(sheet, null); });
    const start = letterOf(ws.sheets[0], "p1");
    const offset = { x: start.x - 200, y: start.y - 200 };
    ws = edit(ws, (sheet) => { Object.assign(sheet.items[0], { x: 400, y: 300 }); });
    expect(letterOf(ws.sheets[0], "p1")).toMatchObject({ x: 400 + offset.x, y: 300 + offset.y });
    ws = edit(ws, (sheet) => { Object.assign(sheet.items[0], { x: 380, y: 280, width: 260, height: 260 }); });
    expect(letterOf(ws.sheets[0], "p1")).toMatchObject({ x: 380 + offset.x, y: 280 + offset.y });
    // A resize from the right edge leaves the corner, and the letter, where they were.
    ws = edit(ws, (sheet) => { sheet.items[0].width = 300; });
    expect(letterOf(ws.sheets[0], "p1")).toMatchObject({ x: 380 + offset.x, y: 280 + offset.y });
    // The letter dragged: its new place is its offset from now on.
    ws = edit(ws, (sheet) => { Object.assign(letterOf(sheet, "p1"), { x: 390, y: 250 }); });
    expect(letterOf(ws.sheets[0], "p1").recipe).toMatchObject({ letterOffset: { x: 10, y: -30 } });
    ws = edit(ws, (sheet) => { Object.assign(sheet.items[0], { x: 100, y: 100 }); });
    expect(letterOf(ws.sheets[0], "p1")).toMatchObject({ x: 110, y: 70 });
  });

  it("takes the sheet's size, weight and case, and its item's group and lock", () => {
    let ws = workspaceOf(sheetOf([plot("p1", 200, 200), plot("p2", 500, 200)]));
    ws = edit(ws, (sheet) => { addPanelLetters(sheet, null); });
    ws = edit(ws, (sheet) => {
      setLetterStyle(sheet, { fontSize: 24, bold: false });
      Object.assign(sheet.items[0], { group: "g1", locked: true });
    });
    const letter = letterOf(ws.sheets[0], "p1");
    expect(letter.recipe).toMatchObject({ fontSize: 24 });
    expect(letter.recipe).not.toHaveProperty("bold");
    expect(letter).toMatchObject({ group: "g1", locked: true });
    expect(letter.height).toBeGreaterThanOrEqual(24);
    expect(letterOf(ws.sheets[0], "p2")).not.toHaveProperty("group");
  });

  it("removes the letters of the items named, or every letter", () => {
    const sheet = sheetOf([plot("p1", 40, 40), plot("p2", 300, 40), plot("p3", 560, 40)]);
    addPanelLetters(sheet, null);
    expect(removePanelLetters(sheet, ["p2"])).toBe(1);
    expect(lettersByItem(sheet)).toEqual({ p1: "A", p3: "B" });
    expect(removePanelLetters(sheet, null)).toBe(2);
    expect(sheet.items.filter(isPanelLetter)).toHaveLength(0);
    expect(sheet.items).toHaveLength(3);
  });

  it("gives a duplicate of a lettered item a letter of its own, and drops a second letter for one item", () => {
    let ws = workspaceOf(sheetOf([plot("p1", 40, 40)]));
    ws = edit(ws, (sheet) => { addPanelLetters(sheet, null); });
    ws = edit(ws, (sheet) => {
      const sources = withPanelLetterIds(sheet, ["p1"]).map((id) => sheet.items.find((item) => item.id === id)!);
      const { copies } = copyLayoutItems(sources);
      sheet.items.push(...copies.map((copy) => (isPanelLetter(copy) ? copy : { ...copy, x: 400, y: 40 })));
    });
    const sheet = ws.sheets[0];
    const copy = sheet.items.find((item) => !isPanelLetter(item) && item.id !== "p1")!;
    expect(lettersByItem(sheet)).toEqual({ p1: "A", [copy.id]: "B" });
    expect(letterOf(sheet, copy.id).x).toBe(letterOf(sheet, "p1").x + 360);
    // A letter copied alone names the same item, which already has one: the copy does not stand.
    ws = edit(ws, (s) => { s.items.push(copyLayoutItems([letterOf(s, "p1")]).copies[0]); });
    expect(ws.sheets[0].items.filter(isPanelLetter)).toHaveLength(2);
  });

  it("repeats on every page of an iterated sheet with its item", () => {
    const sheet = sheetOf([plot("p1", 200, 200)]);
    (sheet.items[0].recipe as { iterated?: boolean }).iterated = true;
    addPanelLetters(sheet, null);
    sheet.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    const units = ["D1", "D2"].map((id) => ({ id, name: id, fileName: `${id}.fcs` }));
    const pages = expandLayoutSheet(sheet, units);
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      const letter = page.items.find((item) => item.recipe.kind === "text")!;
      expect(letter.recipe).toMatchObject({ text: "A" });
    }
    // Tiles: each tile's copy of the letter sits by its tile's copy of the item.
    sheet.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "tiles", rows: 1, columns: 2, order: "row-major", gap: 20 } };
    const [tiled] = expandLayoutSheet(sheet, units);
    const plots = tiled.items.filter((item) => item.recipe.kind === "biplot");
    const letters = tiled.items.filter((item) => item.recipe.kind === "text");
    expect(letters).toHaveLength(2);
    letters.forEach((letter, i) => expect(plots[i].x - letter.x).toBe(200 - letterOf(sheet, "p1").x));
  });

  it("leaves a sheet without letters as it was", () => {
    const ws = workspaceOf(sheetOf([plot("p1", 40, 40), text("t", 40, 300)]));
    const next = edit(ws, () => {});
    expect(next.sheets[0]).toEqual(ws.sheets[0]);
  });
});
