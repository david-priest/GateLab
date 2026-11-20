import { describe, expect, it } from "vitest";
import { seededNormal, seededRandom } from "../compensationControls/syntheticControls.fixture";
import {
  estimateFloor,
  FLOOR_QUANTILE,
  groupEventsBySource,
  MIN_GROUP_EVENTS,
  poissonRateAtQuantile,
} from "./floorEstimate";

function poisson(mean: number, random: () => number, normal: () => number): number {
  if (mean > 40) return Math.max(0, Math.round(mean + Math.sqrt(mean) * normal()));
  const limit = Math.exp(-mean);
  let count = 0;
  let product = random();
  while (product > limit) { count++; product *= random(); }
  return count;
}

/** A source bright on a quarter of events, and a receiver that holds `spill` of it plus what `own` gives. */
function simulate(spill: number, own: (bright: boolean, normal: () => number) => number, seed = 7, events = 30_000) {
  const random = seededRandom(seed);
  const normal = seededNormal(random);
  const source = new Float64Array(events);
  const receiver = new Float64Array(events);
  for (let event = 0; event < events; event++) {
    const bright = random() < 0.25;
    const signal = bright ? 2000 * Math.exp(0.6 * normal()) : 0.4;
    source[event] = poisson(signal, random, normal);
    receiver[event] = poisson(spill * signal + own(bright, normal), random, normal);
  }
  return { source, receiver };
}

describe("poissonRateAtQuantile", () => {
  it("is the rate that leaves the stated fraction at zero for a floor of zero", () => {
    // P(count = 0) = exp(-rate) = 0.25.
    expect(poissonRateAtQuantile(0, 0.25)).toBeCloseTo(Math.log(4), 6);
  });

  it("is above the floor by the normal distance for a large count", () => {
    const rate = poissonRateAtQuantile(1000, 0.25);
    expect(rate).toBeGreaterThan(1000);
    expect(rate - 0.6745 * Math.sqrt(rate)).toBeCloseTo(1000, -1);
  });

  it("rises with the floor", () => {
    const rates = [0, 1, 5, 20, 100].map((value) => poissonRateAtQuantile(value, FLOOR_QUANTILE));
    for (let index = 1; index < rates.length; index++) expect(rates[index]).toBeGreaterThan(rates[index - 1]);
  });
});

describe("groupEventsBySource", () => {
  it("gives the lower half as one group and smaller groups up the bright tail", () => {
    const { source } = simulate(0, () => 0);
    const grouped = groupEventsBySource(source);
    expect(grouped.usable).toBe(true);
    if (!grouped.usable) return;
    const { groups, centres, span } = grouped.source;
    expect(groups.length).toBeGreaterThanOrEqual(4);
    for (const group of groups) expect(group.length).toBeGreaterThanOrEqual(MIN_GROUP_EVENTS);
    for (let index = 1; index < centres.length; index++) expect(centres[index]).toBeGreaterThanOrEqual(centres[index - 1]);
    expect(span).toBeGreaterThan(1000);
  });

  it("refuses too few events and a source that does not vary", () => {
    expect(groupEventsBySource(new Float64Array(100))).toEqual({ usable: false, reason: "few-events" });
    expect(groupEventsBySource(new Float64Array(5000).fill(3))).toEqual({ usable: false, reason: "no-range" });
  });
});

describe("estimateFloor", () => {
  const fit = (spill: number, own: (bright: boolean, normal: () => number) => number, seed?: number) => {
    const { source, receiver } = simulate(spill, own, seed);
    const grouped = groupEventsBySource(source);
    if (!grouped.usable) throw new Error("no groups");
    return estimateFloor(grouped.source, receiver);
  };

  it("brackets the spillover of a receiver that holds nothing else", () => {
    for (const spill of [0.005, 0.02, 0.06]) {
      for (const seed of [1, 2, 3, 4, 5]) {
        const floor = fit(spill, () => 0.4, seed);
        // The floor sits under the mean of the spill by its counting noise; the bound is above it.
        expect(floor.slope).toBeLessThanOrEqual(spill * 1.02);
        expect(floor.slope).toBeGreaterThan(spill * 0.75);
        // The bound carries a 1.96 standard-error allowance, so it is a bound at about the 97.5%
        // level, not a certainty: over these 15 draws it is never more than 2% under the truth.
        expect(floor.upperBound).toBeGreaterThanOrEqual(spill * 0.98);
        expect(floor.upperBound).toBeLessThan(spill * 1.4);
        expect(floor.tightness).toBeLessThan(2);
      }
    }
  });

  it("reads no slope where there is no spillover", () => {
    const floor = fit(0, () => 0.4);
    expect(Math.abs(floor.slope)).toBeLessThan(0.0005);
    expect(floor.upperBound).toBeLessThan(0.002);
  });

  it("is not raised by a marker on every cell that does not follow the source", () => {
    const floor = fit(0.02, (_bright, normal) => 300 * Math.exp(0.5 * normal()));
    expect(floor.referenceFloor).toBeGreaterThan(150);
    expect(floor.upperBound).toBeGreaterThanOrEqual(0.02);
    expect(floor.slope).toBeGreaterThan(0.012);
    expect(floor.slope).toBeLessThan(0.025);
  });

  it("still brackets the spillover when a third of the bright events carry the receiver's marker", () => {
    const floor = fit(0.02, (bright, normal) => bright && normal() > 0.43 ? 500 * Math.exp(0.5 * normal()) : 0.4);
    expect(floor.slope).toBeGreaterThan(0.015);
    expect(floor.slope).toBeLessThan(0.024);
    expect(floor.upperBound).toBeGreaterThanOrEqual(0.02);
  });

  it("gives a wide floor, and only an upper bound, when every bright event carries the receiver's marker", () => {
    const floor = fit(0.02, (bright, normal) => bright ? 500 * Math.exp(0.6 * normal()) : 0.4);
    expect(floor.upperBound).toBeGreaterThanOrEqual(0.02);
    expect(floor.slope).toBeGreaterThan(0.05);
    expect(floor.tightness).toBeGreaterThan(3);
  });
});
