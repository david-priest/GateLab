// A block zoomed to its frame settles on one zoom: the few pixels its text moves by under a new
// zoom are not taken as a new natural size, and a change at an unchanged zoom is.

import { describe, expect, it } from "vitest";
import { settleNaturalSize, type NaturalSize } from "./naturalSize";

/** The zoom a 300 px frame gives a block of this natural width, never enlarged. */
const fit = (size: NaturalSize) => Math.min(1, 300 / size.width);

describe("the natural size of a zoomed block", () => {
  it("settles on one zoom when the measured width moves with the zoom (654 px at one, 651 px at the next)", () => {
    // As measured in the browser: the figure measured 654 px at one zoom and 651 px at the zoom that gave.
    const widthAt = (zoom: number) => (zoom < 0.4588 ? 651 : 654);
    let previous: NaturalSize | null = null;
    let zoom = 1;
    const zooms: number[] = [];
    for (let pass = 0; pass < 6; pass++) {
      previous = settleNaturalSize(previous, { width: widthAt(zoom), height: 200, zoom });
      zoom = fit(previous);
      zooms.push(zoom);
    }
    expect(new Set(zooms.slice(1)).size).toBe(1);
  });

  it("takes a change measured at an unchanged zoom, however small", () => {
    const first = settleNaturalSize(null, { width: 654, height: 200, zoom: 0.5 });
    expect(settleNaturalSize(first, { width: 651, height: 200, zoom: 0.5 }).width).toBe(651);
  });

  it("takes a change larger than the zoom's rounding", () => {
    const first = settleNaturalSize(null, { width: 654, height: 200, zoom: 0.5 });
    expect(settleNaturalSize(first, { width: 700, height: 200, zoom: 0.46 }).width).toBe(700);
  });

  it("without the rule, the same widths alternate between two zooms", () => {
    const widthAt = (zoom: number) => (zoom < 0.4588 ? 651 : 654);
    let zoom = 1;
    const zooms: number[] = [];
    for (let pass = 0; pass < 6; pass++) {
      zoom = Math.min(1, 300 / widthAt(zoom));
      zooms.push(zoom);
    }
    expect(new Set(zooms).size).toBe(2);
  });
});
