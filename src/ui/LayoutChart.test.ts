// LayoutChart.test.ts — what the Layout chart draws a point for, how it groups files without a
// value, and what it reports about the files it leaves out.

import { describe, expect, it } from "vitest";
import type { LayoutChartRecipe } from "../engine/layout";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState } from "../store";
import { chartData, type ChartSource } from "./LayoutChart";

const fcs = (channels: string[], values: number[]): FcsFile => ({
  version: "FCS3.1",
  nEvents: values.length,
  instrument: "flow",
  keywords: {},
  spillover: null,
  channels: channels.map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
  columns: channels.map(() => Float32Array.from(values)),
});

/** A file whose population P holds the events `inP` and is `percent` % of its parent; without `percent`, P is not on the file. */
function source(id: string, percent: number | undefined, inP: boolean[] = [true, true, true], channels = ["FSC-A"]): ChartSource {
  const has = percent !== undefined;
  return {
    id,
    name: `${id}.fcs`,
    sample: new Sample(fcs(channels, [10, 20, 30])),
    derived: {
      masks: has ? { P: Uint8Array.from(inP.map(Number)) } : {},
      stats: { percent_of_parent: has ? { P: percent } : {}, percent_of_total: {}, event_count: {} },
    } as unknown as ChartSource["derived"],
    tree: { id: "T", populations: { P: { name: "CD4_positive" } } } as unknown as ChartSource["tree"],
  };
}

const recipe = (over: Partial<LayoutChartRecipe> = {}): LayoutChartRecipe =>
  ({ kind: "chart", sampleId: "D1", populationId: "P", statistic: "percent_of_parent", files: "all", groupBy: "day", chartType: "bars", showPoints: true, test: true, ...over }) as LayoutChartRecipe;

describe("Layout chart data", () => {
  it("draws files without a value in the column as Unassigned and leaves them out of the test", () => {
    const sources = [source("D1", 10), source("D2", 20), source("D3", 12), source("D4", 22), source("D5", 50)];
    const metadata = { D1: { day: "7" }, D2: { day: "0" }, D3: { day: "7" }, D4: { day: "0" }, D5: { day: " " } };
    const data = chartData(recipe(), sources, metadata, [], initialCoreState());
    expect(data.groups.map((g) => [g.label, g.n])).toEqual([["7", 2], ["0", 2], ["Unassigned", 1]]);
    // Two groups tested, so a rank-sum rather than Kruskal–Wallis over three.
    expect(data.test?.name).toBe("Wilcoxon rank-sum");
    expect(data.missing).toEqual([]);
  });

  it("names the files the population is not on, and draws no point for them", () => {
    const sources = [source("D1", 10), source("D2", undefined), source("D3", 12)];
    const data = chartData(recipe({ groupBy: "" }), sources, {}, [], initialCoreState());
    expect(data.points.map((p) => p.name)).toEqual(["D1.fcs", "D3.fcs"]);
    expect(data.missing).toEqual(["D2.fcs"]);
  });

  it("takes a median of the population's events, names the axis by channel and scale, and names files without the channel", () => {
    const sources = [source("D1", 10, [true, true, false]), source("D2", 10, [false, true, true]), source("D3", 10, [true, true, true], ["SSC-A"])];
    const data = chartData(recipe({ statistic: "median", channel: "FSC-A", groupBy: "" }), sources, {}, [], initialCoreState());
    // Scatter channels are drawn linear, so the medians are of the stored values: 15 and 25.
    expect(data.points.map((p) => [p.name, p.value])).toEqual([["D1.fcs", 15], ["D2.fcs", 25]]);
    expect(data.axis).toBe("Median FSC-A (linear)");
    expect(data.noChannel).toEqual(["D3.fcs"]);
  });
});
