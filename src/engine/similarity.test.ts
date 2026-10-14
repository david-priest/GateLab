import { describe, expect, it } from "vitest";
import { similarityScores, standardiseOverCandidates } from "./similarity";

describe("similarityScores", () => {
  const a = { values: Float32Array.from([0, 1, 2, 10, 11, 12, 100, NaN]) };
  const b = { values: Float32Array.from([0, 0, 0, 5, 5, 5, 50, 0]) };
  const all = Int32Array.from([0, 1, 2, 3, 4, 5, 6]);

  it("scores a picked cell 0, its neighbours low, the far cell high, and a non-candidate NaN", () => {
    const scores = similarityScores([a, b], [0], all, 8, { k: 1 });
    expect(scores[0]).toBe(0);
    expect(scores[1]).toBeLessThan(scores[3]);
    expect(scores[3]).toBeLessThan(scores[6]);
    expect(Number.isNaN(scores[7])).toBe(true);
  });
  it("averages the k nearest picks and never exceeds the farthest of them", () => {
    const one = similarityScores([a, b], [0, 5], all, 8, { k: 1 });
    const two = similarityScores([a, b], [0, 5], all, 8, { k: 2 });
    // Event 3 sits between the picks: with k = 1 its score is its distance to the nearer pick.
    expect(one[3]).toBeLessThan(two[3]);
    expect(two[5]).toBe(0);
    // Events 2 and 3 sit two units from their nearest pick on the same channel: alike by symmetry.
    expect(one[2]).toBeCloseTo(one[3], 9);
  });
  it("standardises each channel over the candidates so a wide channel does not drown a narrow one", () => {
    const wide = { values: Float32Array.from([0, 1000, 2000, 3000, 4000, 5000, 6000, 0]) };
    const narrow = { values: Float32Array.from([0, 1, 2, 3, 4, 5, 6, 0]) };
    const { scale, centre } = standardiseOverCandidates([wide, narrow], all);
    expect(centre[0]).toBe(3000);
    expect(centre[1]).toBe(3);
    expect(scale[0] * 1000).toBeCloseTo(scale[1], 9);
    const flat = { values: Float32Array.from([7, 7, 7, 7, 7, 7, 7, 7]) };
    expect(standardiseOverCandidates([flat], all).scale[0]).toBe(0);
    expect(Array.from(similarityScores([flat], [0], all, 8)).every((v) => Number.isNaN(v))).toBe(true);
  });
  it("is empty without picks or channels", () => {
    expect(Array.from(similarityScores([a], [], all, 8)).every((v) => Number.isNaN(v))).toBe(true);
    expect(Array.from(similarityScores([], [0], all, 8)).every((v) => Number.isNaN(v))).toBe(true);
  });
});
