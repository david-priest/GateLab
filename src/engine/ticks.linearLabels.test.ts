// A linear axis labels each tick with its own value, a fractional step included.
import { describe, expect, it } from "vitest";
import { linearScatterTicks } from "./ticks";

describe("the labels of linear ticks", () => {
  it("labels a step of 0.5 with the halves", () => {
    const ticks = linearScatterTicks([0, 4])!;
    expect(ticks.major_pos).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
    expect(ticks.major_labels).toEqual(["0", "0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4"]);
  });

  it("labels a step of 0.2 across 1 without repeating a label", () => {
    const ticks = linearScatterTicks([0, 2])!;
    expect(ticks.major_labels).toEqual(["0", "0.2", "0.4", "0.6", "0.8", "1", "1.2", "1.4", "1.6", "1.8", "2"]);
  });

  it("leaves whole numbers and the K and M forms as they were", () => {
    expect(linearScatterTicks([0, 30])!.major_labels).toEqual(["0", "5", "10", "15", "20", "25", "30"]);
    expect(linearScatterTicks([0, 1000])!.major_labels).toEqual(["0", "100", "200", "300", "400", "500", "600", "700", "800", "900", "1K"]);
    expect(linearScatterTicks([0, 262144])!.major_labels.slice(0, 4)).toEqual(["0", "20K", "40K", "60K"]);
  });
});
