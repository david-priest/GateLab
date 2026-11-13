import { describe, expect, it } from "vitest";
import { defaultIllustrationConfig } from "../../engine/figureDefaults";
import { createDefaultLayoutWorkspace, type LayoutWorkspace } from "../../engine/layout";
import { initialCoreState } from "../../store";
import { addFigureBlock } from "./fromIllustration";

const context = { samples: [], metadata: {}, hierarchyOfFile: () => "h1", state: initialCoreState() };

describe("addFigureBlock", () => {
  it("adds the figure as one block on the first page of the active sheet", () => {
    const config = { ...defaultIllustrationConfig(), figure: undefined };
    const before = createDefaultLayoutWorkspace();
    const after = addFigureBlock(before, config, context);
    expect(before.sheets[0].items).toHaveLength(0);
    const [item] = after.sheets[0].items;
    expect(item.recipe).toEqual({ kind: "figure", illustration: config, page: 0 });
    expect(item.width).toBeGreaterThan(0);
    expect(item.height).toBeGreaterThan(0);
    expect(after.sheets[0].width).toBeGreaterThanOrEqual(item.x + item.width + 48);
  });

  it("returns the workspace unchanged when it has no sheet", () => {
    const empty: LayoutWorkspace = { ...createDefaultLayoutWorkspace(), sheets: [] };
    expect(addFigureBlock(empty, defaultIllustrationConfig(), context)).toBe(empty);
  });
});
