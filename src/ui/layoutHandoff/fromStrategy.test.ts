import { describe, expect, it } from "vitest";
import { createDefaultLayoutWorkspace, type LayoutStrategyRecipe, type LayoutWorkspace } from "../../engine/layout";
import { addStrategyBlock } from "./fromStrategy";

const strip: LayoutStrategyRecipe = { kind: "strategy", sampleId: "f1", populationId: "p1", fullPath: true, displayMode: "scatter" };

describe("addStrategyBlock", () => {
  it("frames a strip at the size it was drawn, and the sheet grows to hold it", () => {
    const before = createDefaultLayoutWorkspace();
    const after = addStrategyBlock(before, strip, { width: 900, height: 2000 });
    expect(before.sheets[0].items).toHaveLength(0);
    const [item] = after.sheets[0].items;
    expect(item.recipe).toEqual(strip);
    expect([item.width, item.height]).toEqual([900, 2000]);
    expect(after.sheets[0].height).toBeGreaterThanOrEqual(item.y + 2000 + 48);
  });

  it("takes 600 by 320 when no size is given", () => {
    const [item] = addStrategyBlock(createDefaultLayoutWorkspace(), strip, undefined).sheets[0].items;
    expect([item.width, item.height]).toEqual([600, 320]);
  });

  it("returns the workspace unchanged when it has no sheet", () => {
    const empty: LayoutWorkspace = { ...createDefaultLayoutWorkspace(), sheets: [] };
    expect(addStrategyBlock(empty, strip, undefined)).toBe(empty);
  });
});
