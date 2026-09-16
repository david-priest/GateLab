import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKER_COLOR_POWER,
  MARKER_COLOUR_LEVELS,
  MARKER_MISSING_LEVEL,
  MAX_MARKER_COLOR_POWER,
  MIN_MARKER_COLOR_POWER,
  markerColourFraction,
  normalizeMarkerColorPower,
  markerColourLevel,
  markerColourLevels,
  markerColourPalette,
  markerColourScale,
  markerColourTicks,
} from "./markerColour";
import { LOWER_QUANTILE, UPPER_QUANTILE, robustAxisRange } from "./axisRange";
import { MARKER_PALETTES, UNGATED_COLOR, paletteColors } from "./palettes";

const ramp = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("markerColourScale", () => {
  it("spans the same quantiles the axis fit uses", () => {
    // The axis pads its range by 5%; the colour scale deliberately does not. Both must
    // otherwise describe the same interval, or a marker read off the bar and the same marker
    // read off an axis disagree about where the data ends.
    const values = ramp(10_000);
    const scale = markerColourScale([values]);
    const [axisLo, axisHi] = robustAxisRange(values);
    const pad = (scale.hi - scale.lo) * 0.05;
    expect(scale.lo).toBeCloseTo(axisLo + pad, 6);
    expect(scale.hi).toBeCloseTo(axisHi - pad, 6);
  });

  it("ignores the extreme tails, so one bright event cannot flatten the ramp", () => {
    const bulk = ramp(10_000);
    const withOutlier = [...bulk, 1e9];
    expect(markerColourScale([withOutlier]).hi).toBeLessThan(20_000);
  });

  it("pools every column so one colour means one marker level across files", () => {
    const dim = Array.from({ length: 5_000 }, () => 10);
    const bright = Array.from({ length: 5_000 }, () => 1_000);
    const pooled = markerColourScale([dim, bright]);
    // Pooled, the dim file sits at the bottom of the ramp and the bright file at the top.
    expect(markerColourLevel(10, pooled)).toBe(1);
    expect(markerColourLevel(1_000, pooled)).toBe(MARKER_COLOUR_LEVELS);
    // Scaled separately they would both fill their own ramp and look identical, which is the
    // failure this pooling exists to prevent.
    expect(markerColourLevel(10, markerColourScale([dim])))
      .toBe(markerColourLevel(1_000, markerColourScale([bright])));
  });

  it("gives a constant channel a usable scale instead of dividing by zero", () => {
    const scale = markerColourScale([Array.from({ length: 100 }, () => 7)]);
    expect(scale.hi).toBeGreaterThan(scale.lo);
    expect(markerColourLevel(7, scale)).toBe(1);
  });

  it("survives an empty or wholly non-finite column", () => {
    expect(markerColourScale([])).toEqual({ lo: 0, hi: 1 });
    expect(markerColourScale([[NaN, Infinity]])).toEqual({ lo: 0, hi: 1 });
  });

  it("uses the exported quantile rule rather than a second copy of it", () => {
    expect(LOWER_QUANTILE).toBe(0.001);
    expect(UPPER_QUANTILE).toBe(0.999);
  });
});

describe("markerColourLevel", () => {
  const scale = { lo: 0, hi: 100 };

  it("maps the ends of the scale to the ends of the palette", () => {
    expect(markerColourLevel(0, scale)).toBe(1);
    expect(markerColourLevel(100, scale)).toBe(MARKER_COLOUR_LEVELS);
  });

  it("is monotonic, so a brighter event is never given a lower level", () => {
    let previous = -1;
    for (let v = 0; v <= 100; v += 0.25) {
      const level = markerColourLevel(v, scale);
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });

  it("clamps beyond the ramp rather than wrapping or dropping the event", () => {
    // An event brighter than the 99.9th percentile is still an event. Wrapping would paint the
    // brightest cells with the dimmest colour, which is worse than saturating them.
    expect(markerColourLevel(-1e6, scale)).toBe(1);
    expect(markerColourLevel(1e6, scale)).toBe(MARKER_COLOUR_LEVELS);
  });

  it("keeps every level addressable by a uint8", () => {
    const levels = markerColourLevels(ramp(1_000).map((i) => i / 10), scale);
    expect(levels).toBeInstanceOf(Uint8Array);
    for (const level of levels) expect(level).toBeLessThanOrEqual(MARKER_COLOUR_LEVELS);
  });

  it("gives a value with no reading the missing colour, not the bottom of the ramp", () => {
    // A NaN is "this event has no measurement here", which is a different statement from "this
    // event is negative for this marker". Colouring it at the ramp's floor asserts the second.
    expect(markerColourLevel(NaN, scale)).toBe(MARKER_MISSING_LEVEL);
    expect(markerColourLevel(scale.lo, scale)).not.toBe(MARKER_MISSING_LEVEL);
  });
});

describe("marker palettes", () => {
  it("supplies a colour for every level the index can address", () => {
    for (const { value } of MARKER_PALETTES) {
      const palette = markerColourPalette(value);
      // The renderer indexes this array with the level directly, and cannot notice an off-by-one.
      expect(palette).toHaveLength(MARKER_COLOUR_LEVELS + 1);
      expect(palette[MARKER_MISSING_LEVEL]).toBe(UNGATED_COLOR);
      for (const colour of palette) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("addresses the ramp with the levels markerColourLevel produces", () => {
    const palette = markerColourPalette("viridis");
    const ramp255 = paletteColors("viridis", MARKER_COLOUR_LEVELS);
    const scale = { lo: 0, hi: 1 };
    expect(palette[markerColourLevel(0, scale)]).toBe(ramp255[0]);
    expect(palette[markerColourLevel(1, scale)]).toBe(ramp255[MARKER_COLOUR_LEVELS - 1]);
  });

  it("offers only ordered ramps, since the bar claims the colours are ordered", () => {
    // A qualitative palette cycles hues when sampled at 256 levels, so a brighter event can come
    // back a colour that reads as lower. Luminance need not be monotonic (turbo and jet are not),
    // but consecutive levels must be near-neighbours rather than unrelated hues.
    for (const { value } of MARKER_PALETTES) {
      const colours = paletteColors(value, MARKER_COLOUR_LEVELS);
      const rgb = colours.map((c) => [
        parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16),
      ]);
      let worst = 0;
      for (let i = 1; i < rgb.length; i++) {
        const step = Math.max(
          Math.abs(rgb[i][0] - rgb[i - 1][0]),
          Math.abs(rgb[i][1] - rgb[i - 1][1]),
          Math.abs(rgb[i][2] - rgb[i - 1][2]),
        );
        worst = Math.max(worst, step);
      }
      expect(worst, `${value} jumps between adjacent levels`).toBeLessThan(12);
    }
  });
});

describe("marker contrast", () => {
  const scale = { lo: 0, hi: 100 };

  it("defaults to the value that changes nothing", () => {
    expect(DEFAULT_MARKER_COLOR_POWER).toBe(1);
    expect(markerColourFraction(25, scale)).toBeCloseTo(0.25, 10);
    expect(markerColourLevel(50, scale)).toBe(markerColourLevel(50, scale, 1));
  });

  it("moves where the ramp's contrast sits without moving the ends", () => {
    // Above 1 the bright colours are held back for the brightest events; below 1 they come in
    // earlier. Either way the ends are still the ends, or the colour bar would be lying about
    // the range it labels.
    expect(markerColourFraction(50, scale, 2)).toBeLessThan(0.5);
    expect(markerColourFraction(50, scale, 0.5)).toBeGreaterThan(0.5);
    for (const power of [0.3, 1, 3]) {
      expect(markerColourLevel(0, scale, power)).toBe(1);
      expect(markerColourLevel(100, scale, power)).toBe(MARKER_COLOUR_LEVELS);
    }
  });

  it("stays monotonic at every exposed exponent", () => {
    for (const power of [MIN_MARKER_COLOR_POWER, 1, 1.6, MAX_MARKER_COLOR_POWER]) {
      let previous = -1;
      for (let v = -20; v <= 120; v += 0.5) {
        const level = markerColourLevel(v, scale, power);
        expect(level).toBeGreaterThanOrEqual(previous);
        previous = level;
      }
    }
  });

  it("puts a tick where the event of that value is actually coloured", () => {
    // The bar positions its labels through markerColourFraction, the same function that decides
    // an event's colour. If they ever came apart the key would describe a plot that is not there.
    for (const power of [0.5, 1, 2.4]) {
      for (const value of [0, 12.5, 50, 87.5, 100]) {
        const barPosition = markerColourFraction(value, scale, power);
        const level = markerColourLevel(value, scale, power);
        expect(Math.round(barPosition * MARKER_COLOUR_LEVELS)).toBeCloseTo(level - 1, -0.5);
      }
    }
  });

  it("clamps and rounds the exponent to what the slider can express", () => {
    expect(normalizeMarkerColorPower(99)).toBe(MAX_MARKER_COLOR_POWER);
    expect(normalizeMarkerColorPower(-4)).toBe(MIN_MARKER_COLOR_POWER);
    expect(normalizeMarkerColorPower("1.64")).toBe(1.6);
    expect(normalizeMarkerColorPower("nonsense")).toBe(DEFAULT_MARKER_COLOR_POWER);
  });
});

describe("markerColourTicks", () => {
  it("labels both ends of the bar", () => {
    const ticks = markerColourTicks({ lo: 2, hi: 10 }, 3);
    expect(ticks).toEqual([2, 6, 10]);
  });
});
