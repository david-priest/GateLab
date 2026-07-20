import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENSITY_COLOR_POWER,
  densityColorFraction,
  normalizeDensityColorPower,
} from "./pseudocolor";

describe("pseudocolour density transfer", () => {
  it("defaults to a restrained warm-colour ramp and clamps UI values", () => {
    expect(normalizeDensityColorPower(undefined)).toBe(DEFAULT_DENSITY_COLOR_POWER);
    expect(normalizeDensityColorPower(0.1)).toBe(0.8);
    expect(normalizeDensityColorPower(9)).toBe(2.4);
    expect(normalizeDensityColorPower(1.64)).toBe(1.6);
  });

  it("reserves warm palette positions for denser event cores at the default", () => {
    expect(densityColorFraction(0.5, DEFAULT_DENSITY_COLOR_POWER)).toBeCloseTo(0.33, 2);
    expect(densityColorFraction(0.75, DEFAULT_DENSITY_COLOR_POWER)).toBeCloseTo(0.63, 2);
    expect(densityColorFraction(1, DEFAULT_DENSITY_COLOR_POWER)).toBe(1);
  });
});
