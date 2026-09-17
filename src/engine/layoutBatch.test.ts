import { describe, expect, it } from "vitest";
import { createLayoutSheet, type LayoutItem } from "./layout";
import { expandLayoutSheet, fillPlaceholders, iterationUnits, normalizeIteration, templateFrame, type LayoutUnit } from "./layoutBatch";

const units: LayoutUnit[] = [
  { id: "f1", name: "D1", fileName: "D1.fcs", groupName: "treated", metadata: { donor: "D1", day: "7" } },
  { id: "f2", name: "D2", fileName: "D2.fcs", groupName: "treated", metadata: { donor: "D2", day: "7" } },
  { id: "f3", name: "D3", fileName: "D3.fcs", metadata: { donor: "D3", day: "0" } },
];
function plot(id: string, x: number, y: number, iterated: boolean): LayoutItem {
  return { id, x, y, width: 200, height: 200, z: 0, recipe: { kind: "biplot", sampleId: "f1", populationId: "p", xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "pseudocolor", iterated, title: "{sample} · {n}/{N}" } };
}
function text(id: string, x: number, y: number, body: string): LayoutItem {
  return { id, x, y, width: 160, height: 32, z: 1, recipe: { kind: "text", text: body, fontSize: 12 } };
}

describe("placeholders", () => {
  it("fills sample, file, group, position and metadata, and leaves the unknown as written", () => {
    expect(fillPlaceholders("{sample} ({file}) {group} {meta:day} {n} of {N} {other}", units[0], 1, 3)).toBe("D1 (D1.fcs) treated 7 1 of 3 {other}");
    expect(fillPlaceholders("{sample} {n}", null, 2, 5)).toBe("{sample} 2");
    expect(fillPlaceholders("{group}{meta:missing}", units[2], 3, 3)).toBe("");
  });
});

describe("expandLayoutSheet", () => {
  it("is the template itself while iteration is off", () => {
    const sheet = createLayoutSheet("S");
    sheet.items = [plot("a", 57, 57, true), text("t", 57, 300, "Donor {sample}")];
    const pages = expandLayoutSheet(sheet, units);
    expect(pages).toHaveLength(1);
    expect(pages[0].items.map((i) => i.id)).toEqual(["a", "t"]);
    expect(pages[0].items[0].unitId).toBeUndefined();
    expect(pages[0].items[1].recipe).toMatchObject({ text: "Donor {sample}" });
  });

  it("makes one page per unit, binding the items that follow and repeating the fixed ones", () => {
    const sheet = createLayoutSheet("S");
    sheet.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } };
    sheet.items = [plot("a", 57, 57, true), plot("control", 300, 57, false), text("t", 57, 300, "Donor {sample}, day {meta:day}")];
    const pages = expandLayoutSheet(sheet, units);
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.units.map((u) => u.id))).toEqual([["f1"], ["f2"], ["f3"]]);
    const second = pages[1];
    expect(second.items.map((i) => [i.id, i.templateId, i.unitId])).toEqual([["a", "a", "f2"], ["control", "control", undefined], ["t", "t", undefined]]);
    expect(second.items[0].recipe).toMatchObject({ sampleId: "f2", title: "D2 · 2/3" });
    expect(second.items[1].recipe).toMatchObject({ sampleId: "f1", title: "D2 · 2/3" }); // fixed file, page's placeholders
    expect(second.items[2].recipe).toMatchObject({ text: "Donor D2, day 7" });
    expect(second.items[0]).toMatchObject({ x: 57, y: 57, offset: { x: 0, y: 0 } });
  });

  it("lays tiles of the template's extent in a grid, row-major then column-major, over as many pages as needed", () => {
    const sheet = createLayoutSheet("S");
    sheet.items = [plot("a", 57, 57, true), text("t", 57, 267, "{sample}")]; // extent 200 wide, 242 tall
    sheet.iteration = { mode: "files", source: { kind: "all" }, arrangement: { kind: "tiles", rows: 1, columns: 2, order: "row-major", gap: 20 } };
    const pages = expandLayoutSheet(sheet, units);
    expect(pages).toHaveLength(2);
    expect(pages[0].units.map((u) => u.id)).toEqual(["f1", "f2"]);
    expect(pages[1].units.map((u) => u.id)).toEqual(["f3"]);
    expect(pages[0].items.map((i) => [i.id, i.x, i.y])).toEqual([["a", 57, 57], ["t", 57, 267], ["a::1", 277, 57], ["t::1", 277, 267]]);
    expect(pages[0].items[3].recipe).toMatchObject({ text: "D2" });
    expect(pages[0].items[2].offset).toEqual({ x: 220, y: 0 });
    sheet.iteration = { ...sheet.iteration, arrangement: { kind: "tiles", rows: 2, columns: 1, order: "column-major", gap: 20 } };
    const down = expandLayoutSheet(sheet, units);
    expect(down[0].items.map((i) => [i.id, i.x, i.y])).toEqual([["a", 57, 57], ["t", 57, 267], ["a::1", 57, 319], ["t::1", 57, 529]]);
  });

  it("maps a moved tile copy back to the template", () => {
    expect(templateFrame({ templateId: "a", offset: { x: 220, y: 0 } }, { x: 300, y: 80, width: 210, height: 200 })).toEqual({ id: "a", x: 80, y: 80, width: 210, height: 200 });
  });
});

describe("iterationUnits", () => {
  const files = units.map((u) => ({ id: u.id, name: u.name, fileName: u.fileName, metadata: u.metadata }));
  const groups = [{ id: "g1", name: "treated" }];
  const fileGroups = { f1: "g1", f2: "g1" };
  it("takes the checked files, all files, a group or a metadata value, in file order", () => {
    expect(iterationUnits({ mode: "files", source: { kind: "checked" }, arrangement: { kind: "page-per-unit" } }, files, ["f3", "f1"], groups, fileGroups).map((u) => u.id)).toEqual(["f1", "f3"]);
    expect(iterationUnits({ mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } }, files, [], groups, fileGroups).map((u) => u.id)).toEqual(["f1", "f2", "f3"]);
    expect(iterationUnits({ mode: "files", source: { kind: "group", groupId: "g1" }, arrangement: { kind: "page-per-unit" } }, files, [], groups, fileGroups).map((u) => [u.id, u.groupName])).toEqual([["f1", "treated"], ["f2", "treated"]]);
    expect(iterationUnits({ mode: "files", source: { kind: "metadata", column: "day", value: "0" }, arrangement: { kind: "page-per-unit" } }, files, [], groups, fileGroups).map((u) => u.id)).toEqual(["f3"]);
  });
});

describe("normalizeIteration", () => {
  it("accepts a saved iteration and falls back field by field", () => {
    expect(normalizeIteration(undefined)).toEqual({ mode: "off", source: { kind: "checked" }, arrangement: { kind: "page-per-unit" } });
    expect(normalizeIteration({ mode: "files", source: { kind: "group", groupId: "g" }, arrangement: { kind: "tiles", rows: 99, columns: 0, order: "sideways", gap: -1 } }))
      .toEqual({ mode: "files", source: { kind: "group", groupId: "g" }, arrangement: { kind: "tiles", rows: 12, columns: 1, order: "row-major", gap: 0 } });
    expect(normalizeIteration({ mode: "files", source: { kind: "metadata" } }).source).toEqual({ kind: "checked" });
  });
});
