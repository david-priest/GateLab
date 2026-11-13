// The Layout tab's rulers and guides as pure functions: tick and label spacing at three zooms, the
// ticks in view, the snap lines guides add (and a drawn edge snapping to one), and the edits.

import { describe, expect, it } from "vitest";
import { createLayoutSheet, SCREEN_PX_PER_MM } from "../../engine/layout";
import { snapCoordinate, shapeSnapLines } from "./LayoutShape";
import { addGuide, clearGuides, copiedGuides, guideSnapLines, moveGuide, overOwnRuler, removeGuide, RULER_SIZE, rulerSteps, rulerTicks } from "./guideModel";

describe("Ruler ticks", () => {
  it("spaces ticks and labels by zoom so labels never crowd", () => {
    expect(rulerSteps(0.25)).toEqual({ tickMm: 10, labelMm: 50 });
    expect(rulerSteps(1)).toEqual({ tickMm: 5, labelMm: 10 });
    expect(rulerSteps(4)).toEqual({ tickMm: 1, labelMm: 5 });
    for (const zoom of [0.1, 0.25, 0.5, 1, 2, 4]) {
      const { labelMm } = rulerSteps(zoom);
      expect(labelMm * SCREEN_PX_PER_MM * zoom).toBeGreaterThanOrEqual(34);
    }
  });

  it("labels the major ticks in mm from the page's corner, wherever it is in view", () => {
    const labels = (origin: number, zoom: number) => rulerTicks(origin, 400, zoom).filter((tick) => tick.major).map((tick) => tick.mm);
    expect(labels(18, 1).slice(0, 3)).toEqual([0, 10, 20]);
    expect(labels(18, 4).slice(0, 3)).toEqual([0, 5, 10]);
    expect(labels(18, 0.25).slice(0, 3)).toEqual([0, 50, 100]);
    // Scrolled so the corner is 100 px off to the left: the ruler starts past 0 mm.
    const scrolled = rulerTicks(-100, 400, 1);
    expect(scrolled[0].mm).toBe(30);
    expect(scrolled[0].at).toBeCloseTo(-100 + 30 * SCREEN_PX_PER_MM);
    expect(scrolled.every((tick) => tick.at >= 0 && tick.at <= 400)).toBe(true);
  });
});

describe("Guides on a sheet", () => {
  it("adds, moves and removes guides, keeping no empty list", () => {
    const sheet = createLayoutSheet("S");
    addGuide(sheet, { axis: "y", at: 120.456 });
    addGuide(sheet, { axis: "x", at: 64 });
    expect(sheet.guides).toEqual([{ axis: "y", at: 120.46 }, { axis: "x", at: 64 }]);
    const before = sheet.guides;
    moveGuide(sheet, 1, 80);
    expect(sheet.guides).toEqual([{ axis: "y", at: 120.46 }, { axis: "x", at: 80 }]);
    expect(before![1].at).toBe(64); // a new list, so an undo snapshot is left as it was
    removeGuide(sheet, 0);
    expect(sheet.guides).toEqual([{ axis: "x", at: 80 }]);
    removeGuide(sheet, 0);
    expect(sheet).not.toHaveProperty("guides");
    addGuide(sheet, { axis: "x", at: 1 });
    clearGuides(sheet);
    expect(sheet).not.toHaveProperty("guides");
  });

  it("copies guides for a copied sheet and nothing for a sheet without", () => {
    const sheet = createLayoutSheet("S");
    expect(copiedGuides(sheet)).toEqual({});
    sheet.guides = [{ axis: "x", at: 10 }];
    const copy = copiedGuides(sheet).guides!;
    expect(copy).toEqual(sheet.guides);
    expect(copy[0]).not.toBe(sheet.guides[0]);
  });

  it("gives vertical guides to the x snap lines and horizontal ones to the y, and a drawn edge snaps to a guide", () => {
    const sheet = createLayoutSheet("S");
    sheet.guides = [{ axis: "x", at: 113 }, { axis: "y", at: 203 }];
    const lines = guideSnapLines(sheet);
    expect(lines).toEqual({ vertical: [113], horizontal: [203] });
    expect(guideSnapLines(null)).toEqual({ vertical: [], horizontal: [] });
    const snap = shapeSnapLines(10, lines, []);
    expect(snapCoordinate(117, snap.vertical, 6, snap.grid)).toBe(113);
    expect(snapCoordinate(198, snap.horizontal, 6, snap.grid)).toBe(203);
    expect(snapCoordinate(150, snap.vertical, 6, snap.grid)).toBe(150);
  });

  it("knows a guide let go over its own ruler", () => {
    const pane = { left: 0, top: 0 };
    expect(overOwnRuler("y", pane, 300, RULER_SIZE - 1)).toBe(true);
    expect(overOwnRuler("y", pane, 5, 300)).toBe(false);
    expect(overOwnRuler("x", pane, 5, 300)).toBe(true);
  });
});
