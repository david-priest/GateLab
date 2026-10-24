// layoutFollow.test.ts — blocks added from other tabs follow an iterating sheet, and a followed
// strategy is drawn for each file of a file iteration.

import { describe, expect, it } from "vitest";
import { createDefaultLayoutWorkspace, type LayoutPlotRecipe, type LayoutSheet, type LayoutStrategyRecipe } from "../engine/layout";
import { expandLayoutSheet, iterationUnits } from "../engine/layoutBatch";
import { followSheetIteration } from "./layoutFollow";

const plot = (sampleId: string, populationId: string, pool?: string[]): LayoutPlotRecipe => ({ kind: "biplot", sampleId, populationId, xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "pseudocolor", ...(pool ? { pool: { sampleIds: pool } } : {}) });
const strategy: LayoutStrategyRecipe = { kind: "strategy", sampleId: "D1", populationId: "p1", fullPath: true, displayMode: "pseudocolor" };
const sheet = (mode: "off" | "files" | "populations" | "metadata") => ({ iteration: mode === "off" ? undefined : { mode, column: "day", source: { kind: "all" as const }, arrangement: { kind: "page-per-unit" as const } } });

describe("followSheetIteration", () => {
  it("marks blocks added to an iterating sheet to follow it, as the toolbar does, from any tab", () => {
    expect(followSheetIteration(sheet("files"), [strategy])).toEqual([{ ...strategy, iterated: true }]);
    expect(followSheetIteration(sheet("files"), [plot("D1", "p1"), plot("D1", "p2")]).map((recipe) => recipe.iterated)).toEqual([true, true]);
    expect(followSheetIteration(sheet("populations"), [plot("D1", "p1"), plot("D2", "p1")]).map((recipe) => recipe.iterated)).toEqual([true, true]);
    expect(followSheetIteration(sheet("off"), [strategy])).toEqual([strategy]);
    const text = { kind: "text" as const, text: "{file}", fontSize: 12 };
    expect(followSheetIteration(sheet("files"), [text])).toEqual([text]);
  });

  it("leaves plots that differ in what the iteration varies, and a pool under a file iteration, as they are", () => {
    expect(followSheetIteration(sheet("files"), [plot("D1", "p1"), plot("D2", "p1")]).map((recipe) => recipe.iterated)).toEqual([undefined, undefined]);
    expect(followSheetIteration(sheet("metadata"), [plot("D1", "p1"), plot("D2", "p1")]).map((recipe) => recipe.iterated)).toEqual([undefined, undefined]);
    expect(followSheetIteration(sheet("populations"), [plot("D1", "p1"), plot("D1", "p2")]).map((recipe) => recipe.iterated)).toEqual([undefined, undefined]);
    expect(followSheetIteration(sheet("files"), [plot("D1", "p1", ["D1", "D2"])])[0].iterated).toBeUndefined();
    expect(followSheetIteration(sheet("metadata"), [plot("D1", "p1", ["D1", "D2"])])[0].iterated).toBe(true);
  });

  it("draws a strategy added to a file-iterating sheet once for each file", () => {
    const base = createDefaultLayoutWorkspace().sheets[0];
    const iterating: LayoutSheet = { ...base, iteration: { mode: "files", source: { kind: "all" }, arrangement: { kind: "page-per-unit" } } };
    const files = [{ id: "D1", name: "D1.fcs" }, { id: "D2", name: "D2.fcs" }, { id: "D3", name: "D3.fcs" }];
    const units = iterationUnits(iterating.iteration!, files, [], [], {});
    const drawn = (recipe: LayoutStrategyRecipe) =>
      expandLayoutSheet({ ...iterating, items: [{ id: "s", x: 0, y: 0, width: 600, height: 320, z: 1, recipe }] }, units).map((page) => (page.items[0].recipe as LayoutStrategyRecipe).sampleId);
    // Unmarked, as the Strategy tab added it before: the first file on every page.
    expect(drawn(strategy)).toEqual(["D1", "D1", "D1"]);
    expect(drawn(followSheetIteration(iterating, [strategy])[0])).toEqual(["D1", "D2", "D3"]);
  });
});
