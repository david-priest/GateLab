// The objects list's model: default names per kind, rename and reset, hidden items (a hidden
// item's panel letter with it), the rows in stacking order with groups, restacking from the list,
// and the SVG id a named item takes. Synthetic files D1 and D2, population CD4_positive.

import { describe, expect, it } from "vitest";
import { createLayoutSheet, type LayoutItem, type LayoutRecipe, type LayoutSheet } from "../../engine/layout";
import { normalizeProportionsSettings } from "../../engine/proportionsSettings";
import {
  defaultObjectName,
  hiddenItemIds,
  moveObjects,
  objectEntries,
  objectKindWord,
  objectName,
  objectNaming,
  renameObject,
  setObjectsHidden,
  setObjectsLocked,
  stepObjects,
  withoutHiddenItems,
} from "./layoutObjects";
import { objectExportId } from "./objectExportId";

const naming = objectNaming([
  { id: "D1", name: "D1.fcs", tree: { populations: { cd4: { name: "CD4_positive" } } } },
  { id: "D2", name: "D2.fcs", tree: { populations: {} } },
]);

function item(id: string, z: number, recipe: LayoutRecipe, extra: Partial<LayoutItem> = {}): LayoutItem {
  return { id, x: 0, y: 0, width: 200, height: 200, z, recipe, ...extra };
}
const biplot = (sampleId = "D1", populationId = "cd4"): LayoutRecipe => ({ kind: "biplot", sampleId, populationId, xChannel: "CD4", yChannel: "FSC-A", displayMode: "pseudocolor" });
const text = (words: string): LayoutRecipe => ({ kind: "text", text: words, fontSize: 14 });

function sheetOf(items: LayoutItem[]): LayoutSheet {
  const sheet = createLayoutSheet("S");
  sheet.items = items;
  return sheet;
}
/** Ids top of the stack first. */
const stack = (sheet: LayoutSheet) => [...sheet.items].sort((a, b) => b.z - a.z).map((entry) => entry.id);

describe("default object names", () => {
  it("names each kind from what it is", () => {
    expect(defaultObjectName(item("a", 0, biplot()), naming)).toBe("CD4_positive · D1.fcs");
    expect(defaultObjectName(item("a", 0, { ...biplot(), kind: "histogram", yChannel: null } as LayoutRecipe), naming)).toBe("CD4_positive · D1.fcs");
    expect(defaultObjectName(item("a", 0, { ...biplot(), pool: { sampleIds: ["D1", "D2"] } } as LayoutRecipe), naming)).toBe("CD4_positive · 2 files");
    // A population the file's tree does not hold, and a file not prepared yet.
    expect(defaultObjectName(item("a", 0, biplot("D3", "x")), naming)).toBe("Population · file");
    expect(defaultObjectName(item("a", 0, { kind: "strategy", sampleId: "D1", populationId: "cd4", fullPath: true, displayMode: "pseudocolor" }), naming)).toBe("CD4_positive strategy");
    expect(defaultObjectName(item("a", 0, { kind: "chart", sampleId: "D1", populationId: "cd4", statistic: "count", files: "checked", groupBy: "", chartType: "bars", showPoints: true, test: true }), naming)).toBe("CD4_positive · Events");
    const settings = normalizeProportionsSettings({});
    expect(defaultObjectName(item("a", 0, { kind: "proportions", settings }), naming)).toBe(settings.plotType === "box" ? "Boxplot" : "Composition");
    expect(defaultObjectName(item("a", 0, { kind: "proportions", settings, panel: { legend: true } }), naming)).toMatch(/ · legend$/);
    expect(defaultObjectName(item("a", 0, { kind: "proportions", settings, panel: { population: "CD4_positive", group: "treated" } }), naming)).toMatch(/ · CD4_positive · treated$/);
    expect(defaultObjectName(item("a", 0, text("\n  Day 7 control and treated donors D1 D2\nsecond line")), naming)).toBe("Day 7 control and treated…");
    expect(defaultObjectName(item("a", 0, text("Day 7")), naming)).toBe("Day 7");
    expect(defaultObjectName(item("a", 0, text("   ")), naming)).toBe("Text");
    expect(defaultObjectName(item("a", 0, { kind: "text", text: "B", fontSize: 16, letterFor: "p" }), naming)).toBe("Panel letter B");
  });

  it("gives each kind a short word, a panel letter its own", () => {
    expect(objectKindWord(item("a", 0, biplot()))).toBe("Plot");
    expect(objectKindWord(item("a", 0, text("x")))).toBe("Text");
    expect(objectKindWord(item("a", 0, { kind: "text", text: "A", fontSize: 16, letterFor: "p" }))).toBe("Letter");
  });

  it("renames an item and takes an empty name back to the default", () => {
    const sheet = sheetOf([item("p", 0, biplot())]);
    renameObject(sheet, "p", "  CD4 panel  ");
    expect(sheet.items[0].name).toBe("CD4 panel");
    expect(objectName(sheet.items[0], naming)).toBe("CD4 panel");
    renameObject(sheet, "p", "   ");
    expect(sheet.items[0]).not.toHaveProperty("name");
    expect(objectName(sheet.items[0], naming)).toBe("CD4_positive · D1.fcs");
  });
});

describe("hidden and locked items", () => {
  it("hides an item and its panel letter, and shows them again", () => {
    const sheet = sheetOf([item("p", 0, biplot()), item("l", 1, { kind: "text", text: "A", fontSize: 16, letterFor: "p" }), item("t", 2, text("Day 7"))]);
    setObjectsHidden(sheet, ["p"], true);
    expect(sheet.items[0].hidden).toBe(true);
    expect([...hiddenItemIds(sheet)].sort()).toEqual(["l", "p"]);
    const pages = withoutHiddenItems([{ items: sheet.items.map((entry) => ({ ...entry, templateId: entry.id })) }], sheet);
    expect(pages[0].items.map((entry) => entry.id)).toEqual(["t"]);
    setObjectsHidden(sheet, ["p"], false);
    expect(sheet.items[0]).not.toHaveProperty("hidden");
    expect(hiddenItemIds(sheet).size).toBe(0);
  });

  it("locks and unlocks", () => {
    const sheet = sheetOf([item("p", 0, biplot())]);
    setObjectsLocked(sheet, ["p"], true);
    expect(sheet.items[0].locked).toBe(true);
    setObjectsLocked(sheet, ["p"], false);
    expect(sheet.items[0].locked).toBe(false);
  });
});

describe("rows and restacking", () => {
  function grouped() {
    return sheetOf([
      item("a", 0, biplot()),
      item("g1", 1, biplot(), { group: "G" }),
      item("b", 2, text("b")),
      item("g2", 3, biplot(), { group: "G" }),
      item("c", 4, text("c")),
    ]);
  }

  it("lists the stack top first, a group's row where its topmost member is", () => {
    const entries = objectEntries(grouped());
    expect(entries.map((entry) => entry.key)).toEqual(["c", "group:G", "b", "a"]);
    const group = entries[1];
    expect(group.kind === "group" && group.members.map((member) => member.id)).toEqual(["g2", "g1"]);
  });

  it("moves rows by drag position, a group whole, and keeps z 0 … n−1", () => {
    const sheet = grouped();
    moveObjects(sheet, ["a"], 0);
    expect(stack(sheet)).toEqual(["a", "c", "g2", "g1", "b"]);
    moveObjects(sheet, ["group:G"], 4);
    expect(stack(sheet)).toEqual(["a", "c", "b", "g2", "g1"]);
    expect(sheet.items.map((entry) => entry.z).sort()).toEqual([0, 1, 2, 3, 4]);
    // Within a group, a member moves among the members only.
    moveObjects(sheet, ["g1"], 0, "G");
    expect(stack(sheet)).toEqual(["a", "c", "b", "g1", "g2"]);
  });

  it("steps a row up and down its level", () => {
    const sheet = grouped();
    stepObjects(sheet, ["b"], -1);
    expect(stack(sheet)).toEqual(["c", "b", "g2", "g1", "a"]);
    stepObjects(sheet, ["c"], 1);
    expect(stack(sheet)).toEqual(["b", "c", "g2", "g1", "a"]);
    stepObjects(sheet, ["g2"], 1, "G");
    expect(stack(sheet)).toEqual(["b", "c", "g1", "g2", "a"]);
    // At the ends a step does nothing.
    stepObjects(sheet, ["b"], -1);
    stepObjects(sheet, ["a"], 1);
    expect(stack(sheet)).toEqual(["b", "c", "g1", "g2", "a"]);
  });
});

describe("export ids from names", () => {
  it("makes a name a valid XML id, unique on the page, and gives way when it holds nothing usable", () => {
    const taken = new Set<string>();
    expect(objectExportId("CD4 panel", taken)).toBe("CD4-panel");
    expect(objectExportId("CD4 panel", taken)).toBe("CD4-panel-2");
    expect(objectExportId("CD4-panel", taken)).toBe("CD4-panel-3");
    expect(objectExportId("7 day", taken)).toBe("_7-day");
    expect(objectExportId("日本語", taken)).toBeNull();
    expect(objectExportId(undefined, taken)).toBeNull();
  });
});
