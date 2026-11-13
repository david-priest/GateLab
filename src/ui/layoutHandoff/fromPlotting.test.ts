import { describe, expect, it } from "vitest";
import { createDefaultLayoutWorkspace, type LayoutWorkspace } from "../../engine/layout";
import { defaultProportionsSettings } from "../../engine/proportionsModel";
import { initialCoreState } from "../../store";
import { addPlottingPanelBlocks, addProportionsBlock } from "./fromPlotting";

const settings = defaultProportionsSettings([], initialCoreState(), []);

describe("addProportionsBlock", () => {
  it("adds the chart as one block that takes the sheet's text sizes, at the size the sizer gives", () => {
    const before = createDefaultLayoutWorkspace();
    const after = addProportionsBlock(before, settings, () => ({ width: 410, height: 290 }), {});
    expect(before.sheets[0].items).toHaveLength(0);
    const [item] = after.sheets[0].items;
    expect(item.recipe).toEqual({ kind: "proportions", settings, textSize: "sheet" });
    expect([item.width, item.height]).toEqual([410, 290]);
  });

  it("records the page shown of a chart with pages in the block's panel selector", () => {
    const paged = { ...settings, pageBy: "groups" as const };
    const [item] = addProportionsBlock(createDefaultLayoutWorkspace(), paged, () => ({ width: 410, height: 290 }), {}, { page: "treated" }).sheets[0].items;
    expect(item.recipe).toEqual({ kind: "proportions", settings: paged, panel: { page: "treated" }, textSize: "sheet" });
  });

  it("takes 360 by 280 without a sizer, and leaves a workspace without a sheet as it is", () => {
    const [item] = addProportionsBlock(createDefaultLayoutWorkspace(), settings, null, {}).sheets[0].items;
    expect([item.width, item.height]).toEqual([360, 280]);
    const empty: LayoutWorkspace = { ...createDefaultLayoutWorkspace(), sheets: [] };
    expect(addProportionsBlock(empty, settings, null, {})).toBe(empty);
  });
});

describe("addPlottingPanelBlocks", () => {
  const blocks = [
    { panel: { group: "control" }, row: 0, column: 0 },
    { panel: { group: "treated" }, row: 0, column: 1 },
  ];

  it("adds a block per panel in the tab's arrangement and the legend below them", () => {
    const before = createDefaultLayoutWorkspace();
    const after = addPlottingPanelBlocks(before, settings, blocks, () => ({ width: 200, height: 150 }), () => ({ width: 180, height: 40 }), {});
    expect(before.sheets[0].items).toHaveLength(0);
    const items = after.sheets[0].items;
    expect(items.map((item) => item.recipe)).toEqual([
      { kind: "proportions", settings, panel: { group: "control" }, textSize: "sheet" },
      { kind: "proportions", settings, panel: { group: "treated" }, textSize: "sheet" },
      { kind: "proportions", settings, panel: { legend: true }, textSize: "sheet" },
    ]);
    const [first, second, legend] = items;
    expect([first.width, first.height]).toEqual([200, 150]);
    expect(second.y).toBe(first.y);
    expect(second.x).toBeGreaterThan(first.x);
    expect(legend.x).toBe(first.x);
    expect(legend.y).toBe(first.y + first.height + 12);
    expect([legend.width, legend.height]).toEqual([180, 40]);
    expect(new Set(items.map((item) => item.z)).size).toBe(3);
  });

  it("marks the blocks iterated when the sheet iterates over files and they differ only in population", () => {
    const before = createDefaultLayoutWorkspace();
    before.sheets[0].iteration = { mode: "files" } as NonNullable<LayoutWorkspace["sheets"][number]["iteration"]>;
    const same = [{ panel: {}, row: 0, column: 0 }, { panel: {}, row: 0, column: 1 }];
    const after = addPlottingPanelBlocks(before, settings, same, null, null, {});
    expect(after.sheets[0].items.map((item) => item.recipe)).toEqual([
      { kind: "proportions", settings, panel: {}, textSize: "sheet", iterated: true },
      { kind: "proportions", settings, panel: {}, textSize: "sheet", iterated: true },
    ]);
    const differing = addPlottingPanelBlocks(before, settings, blocks, null, null, {});
    for (const item of differing.sheets[0].items) expect(item.recipe).not.toHaveProperty("iterated");
  });
});
