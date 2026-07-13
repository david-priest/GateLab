import { describe, it, expect } from "vitest";
import { OVERLAY_PALETTES, paletteColors, populationColor, POP_COLOR_SLOTS } from "./palettes";

describe("palettes", () => {
  it("offers the 8 GateLabR OVERLAY_PALETTES", () => {
    expect(OVERLAY_PALETTES.map((p) => p.value)).toEqual([
      "paired", "default", "viridis", "plasma", "cividis", "inferno", "set2", "dark3",
    ]);
  });

  it("qualitative palette: first k when enough, interpolates when more", () => {
    expect(paletteColors("paired", 3)).toEqual(["#a6cee3", "#1f78b4", "#b2df8a"]);
    expect(paletteColors("paired", 14)).toHaveLength(14); // > 12 base → ramp
  });

  it("returns k valid hex colours for every palette", () => {
    for (const p of OVERLAY_PALETTES) {
      const cols = paletteColors(p.value, 6);
      expect(cols).toHaveLength(6);
      cols.forEach((c) => expect(c).toMatch(/^#[0-9a-f]{6}$/i));
    }
  });

  it("sequential palette samples endpoints (viridis dark→yellow)", () => {
    const v = paletteColors("viridis", 2);
    expect(v[0].toLowerCase()).toBe("#440154");
    expect(v[1].toLowerCase()).toBe("#fde725");
  });
});

describe("populationColor — a slot's colour is invariant to the population count", () => {
  it("slot → colour is sampled at POP_COLOR_SLOTS, not at the live count", () => {
    // The frozen guarantee: the same slot yields the same colour no matter how many pops exist.
    expect(populationColor("default", 0)).toBe("#1f77b4"); // Tableau[0]
    expect(populationColor("default", 3)).toBe(populationColor("default", 3));
    expect(populationColor("default", 0)).not.toBe(populationColor("default", 1));
  });
  it("wraps by POP_COLOR_SLOTS and tolerates undefined", () => {
    expect(populationColor("default", POP_COLOR_SLOTS)).toBe(populationColor("default", 0));
    expect(populationColor("default", undefined)).toBe(populationColor("default", 0));
  });
});
