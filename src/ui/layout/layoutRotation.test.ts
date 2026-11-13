// Quarter turns of Layout text blocks and placed images (layoutRotation.ts): a turn of 90° swaps
// the frame's width and height about its centre and 180° keeps them; four right turns return the
// item to where it started; only text blocks that are not panel letters and placed images turn,
// and a locked item does not; a turned text block grows away from its first line. Synthetic
// identifiers only.

import { describe, expect, it } from "vitest";
import { createLayoutSheet, type LayoutItem } from "../../engine/layout";
import { canTurn, canTurnAll, growTextFrame, turnedBoxStyle, turnItem, turnItems } from "./layoutRotation";

const text = (frame: Partial<LayoutItem> = {}): LayoutItem => ({ id: "t", x: 100, y: 50, width: 160, height: 33, z: 0, ...frame, recipe: { kind: "text", text: "CD4_positive", fontSize: 14 } });
const image = (): LayoutItem => ({ id: "i", x: 10, y: 10, width: 80, height: 40, z: 1, recipe: { kind: "image", fileName: "schematic_D1.svg", mediaType: "image/svg+xml", naturalWidth: 40, naturalHeight: 20, content: "<svg/>" } });
const frame = (item: LayoutItem) => ({ x: item.x, y: item.y, width: item.width, height: item.height, rotation: item.rotation });
const centre = (item: LayoutItem) => [item.x + item.width / 2, item.y + item.height / 2];

describe("Quarter turns of a Layout item", () => {
  it("swaps the frame's width and height about its centre for 90° and 270°, and not for 180°", () => {
    const item = text();
    const start = centre(item);
    turnItem(item, "right");
    expect(frame(item)).toEqual({ x: 163.5, y: -13.5, width: 33, height: 160, rotation: 90 });
    expect(centre(item)).toEqual(start);
    turnItem(item, "right");
    expect(frame(item)).toEqual({ x: 100, y: 50, width: 160, height: 33, rotation: 180 });
    turnItem(item, "right");
    expect(frame(item)).toMatchObject({ width: 33, height: 160, rotation: 270 });
    expect(centre(item)).toEqual(start);

    const left = text();
    turnItem(left, "left");
    expect(frame(left)).toEqual({ x: 163.5, y: -13.5, width: 33, height: 160, rotation: 270 });
  });

  it("returns the item to its start after four right turns, or a right and a left, with no turn stored", () => {
    const item = text();
    for (let i = 0; i < 4; i++) turnItem(item, "right");
    expect(item).toEqual(text());
    expect("rotation" in item).toBe(false);
    turnItem(item, "right");
    turnItem(item, "left");
    expect(item).toEqual(text());
  });

  it("turns text blocks and placed images only, not a plot, a shape or a panel letter", () => {
    expect(canTurn(text())).toBe(true);
    expect(canTurn(image())).toBe(true);
    expect(canTurn({ recipe: { kind: "biplot", sampleId: "D1", populationId: "p", xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "pseudocolor" } })).toBe(false);
    expect(canTurn({ recipe: { kind: "shape", shape: "rectangle", stroke: "#000000", strokeWidth: 1 } as LayoutItem["recipe"] })).toBe(false);
    expect(canTurn({ recipe: { kind: "text", text: "A", fontSize: 14, letterFor: "i" } })).toBe(false);
    expect(canTurnAll([text(), image()])).toBe(true);
    expect(canTurnAll([])).toBe(false);
  });

  it("turns each selected item about its own centre, leaving locked and other items as they are", () => {
    const sheet = createLayoutSheet("S");
    const plot: LayoutItem = { id: "p", x: 0, y: 0, width: 260, height: 280, z: 2, recipe: { kind: "biplot", sampleId: "D1", populationId: "p", xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "pseudocolor" } };
    sheet.items = [text(), image(), { ...text({ id: "locked", locked: true }) }, plot];
    expect(turnItems(sheet, ["t", "i", "locked", "p"], "right")).toBe(true);
    expect(frame(sheet.items[0])).toEqual({ x: 163.5, y: -13.5, width: 33, height: 160, rotation: 90 });
    expect(frame(sheet.items[1])).toEqual({ x: 30, y: -10, width: 40, height: 80, rotation: 90 });
    expect(frame(sheet.items[2])).toEqual(frame(text()));
    expect(sheet.items[3]).toEqual(plot);
    expect(turnItems(sheet, ["locked", "p"], "right")).toBe(false);
  });

  it("grows a turned text block away from its first line, and an upright one downward", () => {
    const upright = text();
    growTextFrame(upright, 60);
    expect(frame(upright)).toEqual({ x: 100, y: 50, width: 160, height: 64, rotation: undefined });
    const ninety = text({ rotation: 90, width: 33, height: 160 });
    growTextFrame(ninety, 60);
    expect(frame(ninety)).toEqual({ x: 69, y: 50, width: 64, height: 160, rotation: 90 });
    const twoSeventy = text({ rotation: 270, width: 33, height: 160 });
    growTextFrame(twoSeventy, 60);
    expect(frame(twoSeventy)).toEqual({ x: 100, y: 50, width: 64, height: 160, rotation: 270 });
    const half = text({ rotation: 180 });
    growTextFrame(half, 60);
    expect(frame(half)).toEqual({ x: 100, y: 19, width: 160, height: 64, rotation: 180 });
    // It never shrinks.
    growTextFrame(half, 10);
    expect(half.height).toBe(64);
  });

  it("lays a turned item's content out in a box with the frame's sides swapped, centred and turned", () => {
    expect(turnedBoxStyle(0, 33, 160)).toBeUndefined();
    expect(turnedBoxStyle(90, 33, 160)).toEqual({
      width: "calc(160px - 2 * var(--gl-hair, 1px))",
      height: "calc(33px - 2 * var(--gl-hair, 1px))",
      marginLeft: -63.5,
      marginTop: 63.5,
      transform: "rotate(90deg)",
    });
    expect(turnedBoxStyle(180, 160, 33)).toMatchObject({ width: "calc(160px - 2 * var(--gl-hair, 1px))", marginLeft: 0, marginTop: 0, transform: "rotate(180deg)" });
  });
});
