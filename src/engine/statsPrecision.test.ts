// @vitest-environment jsdom
//
// MFI statistics were rounded to one decimal place before they ever reached the screen. That is
// fine for raw values in the tens of thousands and useless for TRANSFORMED ones: a logicle
// display coordinate lives in [0, 1], so on a real workspace every channel median collapsed onto
// 0.1–0.6 and the whole column read as though the channels were identical.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";
import { computePopulationStats, type ValueSpace } from "./stats";
import { significantNumber } from "../ui/compensationUiFormat";
import { ARIA_SMALL } from "../testFixtures";

function load(): Sample {
  const b = readFileSync(ARIA_SMALL);
  return new Sample(parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}

/** Every fluorescence channel's median, in the given value space, for the root population. */
function medians(space: ValueSpace): number[] {
  const s = load();
  const channels = s.channels.filter((_, i) => s.isFluorChannel(i)).map((c) => c.key);
  const n = s.fcs.nEvents;
  const all = new Uint8Array(n).fill(1);
  const table = computePopulationStats(
    s,
    { root: { population_id: "root", name: "All Events", parent_id: null, children: [], gate_refs: [], gate_logic: "and" } } as never,
    "root",
    { root: all },
    { root: n },
    channels,
    ["median"],
    space,
  );
  const row = table.rows[0];
  return table.columns
    .filter((c) => c.key.includes("::"))
    .map((c) => row.cells[c.key])
    .filter((v): v is number => v != null);
}

describe("MFI precision in the transformed value space", () => {
  it("keeps the values distinguishable", () => {
    const vals = medians("transformed");
    expect(vals.length).toBeGreaterThan(2);
    // The failure mode: every value in [0,1] rounded to 1 dp collapses onto a handful of values.
    const atOneDp = new Set(vals.map((v) => v.toFixed(1)));
    const atFourSf = new Set(vals.map((v) => significantNumber(v, 4)));
    expect(atFourSf.size).toBeGreaterThanOrEqual(atOneDp.size);
    // ...and the stored value must not already be rounded, or no formatter could recover it.
    expect(vals.some((v) => Math.abs(v * 10 - Math.round(v * 10)) > 1e-9)).toBe(true);
  });

  it("still reads sensibly in raw space, where values are large", () => {
    const vals = medians("raw");
    expect(vals.length).toBeGreaterThan(2);
    for (const v of vals) {
      const shown = significantNumber(v, 4);
      expect(shown).not.toMatch(/e/i);            // no exponent for ordinary channel values
      expect(Number(shown)).toBeCloseTo(v, Math.abs(v) >= 1000 ? -1 : 1);
    }
  });

  it("formats across the range a value space can produce", () => {
    // Four significant figures, trailing zeros trimmed, at every magnitude these columns hit.
    expect(significantNumber(0.4839182, 4)).toBe("0.4839");
    expect(significantNumber(0.1, 4)).toBe("0.1");
    expect(significantNumber(12.34567, 4)).toBe("12.35");
    expect(significantNumber(48392.7, 4)).toBe("48393");
    expect(significantNumber(-0.02391, 4)).toBe("-0.02391");
    expect(significantNumber(0, 4)).toBe("0");
  });
});
