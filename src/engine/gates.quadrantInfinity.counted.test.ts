// A curled quadrant with one arm left straight decides an event at an infinite coordinate by
// that straight arm.
import { describe, expect, it } from "vitest";
import { gateMaskQuadrant } from "./gates";

describe("curled quadrant: a flat arm turns NaN at an infinite coordinate", () => {
  it("an event at x = +Infinity, above a flat horizontal arm, is in the upper-right quadrant", () => {
    // kx = 0: the horizontal divider is flat at y = 0 everywhere; ky bends only the vertical one.
    const curl = { power: 1.5, kx: 0, ky: 0.012 };
    const q = [1, 2, 3, 4].map((k) => gateMaskQuadrant([Infinity], [5], [0, 0], k, curl)[0]);
    expect(q).toEqual([0, 1, 0, 0]);
  });
  it("the same with the axes exchanged: y = +Infinity right of a flat vertical arm", () => {
    const curl = { power: 1.5, kx: 0.012, ky: 0 };
    const q = [1, 2, 3, 4].map((k) => gateMaskQuadrant([5], [Infinity], [0, 0], k, curl)[0]);
    expect(q).toEqual([0, 1, 0, 0]);
  });
});
