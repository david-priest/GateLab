// The figure's axis policies: shared by channel, fitted per file, or the Gating tab's own ranges.

import { describe, it, expect } from "vitest";
import { figureRanges, type FigureSource, type FigureSpec } from "./figure";

function source(values: Record<string, number[]>): FigureSource {
  const keys = Object.keys(values);
  return {
    sample: {
      index: (key: string) => (keys.includes(key) ? keys.indexOf(key) : undefined),
      displayColumn: (idx: number) => Float32Array.from(values[keys[idx]]),
    },
  } as unknown as FigureSource;
}
const figure = (scalePolicy: FigureSpec["scalePolicy"]): FigureSpec =>
  ({ scalePolicy, transforms: { "FSC-A": {}, "SSC-A": {} } } as unknown as FigureSpec);

describe("figureRanges", () => {
  it("spans every file under the shared policy", () => {
    const ranges = figureRanges([source({ "FSC-A": [0, 10], "SSC-A": [5, 6] }), source({ "FSC-A": [20, 30], "SSC-A": [1, 2] })], figure("shared"));
    expect(ranges["FSC-A"][0]).toBeLessThanOrEqual(0);
    expect(ranges["FSC-A"][1]).toBeGreaterThanOrEqual(30);
  });
  it("takes the Gating tab's range where it has one under the gating policy, and only then", () => {
    const sources = [source({ "FSC-A": [0, 10], "SSC-A": [5, 6] })];
    const gating = { "FSC-A": [100, 200] as [number, number], "Other": [0, 1] as [number, number] };
    expect(figureRanges(sources, figure("gating"), gating)["FSC-A"]).toEqual([100, 200]);
    expect(figureRanges(sources, figure("gating"), gating)["SSC-A"][1]).toBeGreaterThanOrEqual(6);
    expect(figureRanges(sources, figure("shared"), gating)["FSC-A"]).not.toEqual([100, 200]);
    expect("Other" in figureRanges(sources, figure("gating"), gating)).toBe(false);
  });
});
