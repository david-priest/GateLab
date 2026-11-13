// A zoomed linear axis gives each tick its own label, with the digits its step needs in K or M.
// An unzoomed axis keeps its short labels (0, 20K, 40K).
import { describe, expect, it } from "vitest";
import { linearScatterTicks } from "./ticks";

function parse(label: string): number {
  const m = /^(-?[0-9.]+)([KM]?)$/.exec(label)!;
  return Number(m[1]) * (m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : 1);
}

describe("the labels of a zoomed linear axis", () => {
  it("labels 100,100 to 100,400 as 100.1K to 100.4K", () => {
    expect(linearScatterTicks([100000, 101000])!.major_labels).toEqual(
      ["100K", "100.1K", "100.2K", "100.3K", "100.4K", "100.5K", "100.6K", "100.7K", "100.8K", "100.9K", "101K"],
    );
  });

  it("labels 999.2 as 999.2 and 1000 as 1K", () => {
    const labels = linearScatterTicks([999, 1001])!.major_labels;
    expect(labels).toContain("999.2");
    expect(labels).toContain("1K");
  });

  for (const range of [[100000, 101000], [262000, 262144], [1500000, 1510000], [999, 1001], [0.1, 0.13], [-1001, -999]] as [number, number][]) {
    it(`gives distinct labels that read as their ticks from ${range[0]} to ${range[1]}`, () => {
      const t = linearScatterTicks(range)!;
      const step = t.major_pos[1] - t.major_pos[0];
      expect(new Set(t.major_labels).size).toBe(t.major_labels.length);
      t.major_pos.forEach((p, i) => expect(Math.abs(parse(t.major_labels[i]) - p)).toBeLessThanOrEqual(step / 10));
    });
  }

  it("keeps the labels of an unzoomed axis", () => {
    expect(linearScatterTicks([0, 262144])!.major_labels).toEqual(["0", "20K", "40K", "60K", "80K", "100K", "120K", "140K", "160K", "180K", "200K", "220K", "240K", "260K"]);
    expect(linearScatterTicks([0, 4000000])!.major_labels).toEqual(["0", "500K", "1M", "1.5M", "2M", "2.5M", "3M", "3.5M", "4M"]);
  });
});
