import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";
import { computePopulationStats } from "./stats";
import { newRootPopulation, type PopulationMap } from "./models";

const ARIA_SMALL =
  "/Users/davidpriest/code/gatelabr-test-fcs/conventional_comp_AriaIII/sample_Bmem_purity_small.fcs";
function loadArrayBuffer(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// Independent reference stats over a plain array.
function refMedian(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const refMean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;

describe("computePopulationStats — MFI math vs independent reference", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));
  const root = newRootPopulation();
  const pops: PopulationMap = { [root.population_id]: root };
  const n = sample.fcs.nEvents;
  const rootMask = new Uint8Array(n).fill(1);
  const masks = { [root.population_id]: rootMask };
  const eventCount = { [root.population_id]: n };
  const ch = sample.channels[6].key; // a fluorophore column

  it("root Median/Mean MFI match a direct computation of the raw column", () => {
    const t = computePopulationStats(
      sample, pops, root.population_id, masks, eventCount,
      [ch], ["count", "median", "mean"], "raw",
    );
    expect(t.rows.length).toBe(1);
    const row = t.rows[0];
    expect(row.cells.count).toBe(n);

    const raw = Array.from(sample.rawColumnData(6)).filter(Number.isFinite);
    expect(row.cells[`${ch}::Median`]).toBeCloseTo(Math.round(refMedian(raw) * 10) / 10, 1);
    expect(row.cells[`${ch}::Mean`]).toBeCloseTo(Math.round(refMean(raw) * 10) / 10, 1);
  });

  it("transformed space uses the display column, not raw", () => {
    const t = computePopulationStats(
      sample, pops, root.population_id, masks, eventCount,
      [ch], ["median"], "transformed",
    );
    const disp = Array.from(sample.displayColumn(6)).filter(Number.isFinite);
    expect(t.rows[0].cells[`${ch}::Median`]).toBeCloseTo(Math.round(refMedian(disp) * 10) / 10, 1);
  });

  it("columns follow selected stats × channels; % Parent is 100 at root", () => {
    const t = computePopulationStats(
      sample, pops, root.population_id, masks, eventCount,
      [ch], ["count", "pct_parent", "median", "cv"], "raw",
    );
    expect(t.columns.map((c) => c.label)).toEqual(["Count", "% Parent", `${ch} Median`, `${ch} CV%`]);
    expect(t.rows[0].cells.pct_parent).toBe(100);
  });

  it("no MFI stats selected → no channel columns even if channels passed", () => {
    const t = computePopulationStats(
      sample, pops, root.population_id, masks, eventCount,
      [ch], ["count"], "raw",
    );
    expect(t.columns.map((c) => c.key)).toEqual(["count"]);
  });
});
