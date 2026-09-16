// Quadrant population names under both schemes. Synthetic labels throughout.

import { describe, it, expect } from "vitest";
import { quadrantPopulationNames, shortChannelLabel, isQuadrantNaming } from "./quadrantNames";

describe("quadrantPopulationNames", () => {
  it("names by signs in quadrant order x-y+, x+y+, x+y-, x-y-", () => {
    expect(quadrantPopulationNames("signs", "CD4", "CD8")).toEqual(["CD4- CD8+", "CD4+ CD8+", "CD4+ CD8-", "CD4- CD8-"]);
  });

  it("names DN, DP and the single positives by the marker that is on", () => {
    expect(quadrantPopulationNames("dndp", "CD4", "CD8")).toEqual(["CD8 SP", "DP", "CD4 SP", "DN"]);
  });

  it("falls back to x and y for an empty label", () => {
    expect(quadrantPopulationNames("signs", " ", "")).toEqual(["x- y+", "x+ y+", "x+ y-", "x- y-"]);
  });
});

describe("shortChannelLabel", () => {
  it("takes the marker, else the detector, else the key", () => {
    expect(shortChannelLabel({ marker: "CD4", pnn: "FITC-A" }, "CD4 (FITC-A)")).toBe("CD4");
    expect(shortChannelLabel({ marker: "FITC-A", pnn: "FITC-A" }, "FITC-A")).toBe("FITC-A");
    expect(shortChannelLabel({ marker: "", pnn: "FSC-A" }, "FSC-A")).toBe("FSC-A");
    expect(shortChannelLabel(undefined, "Time")).toBe("Time");
  });
});

describe("isQuadrantNaming", () => {
  it("accepts the two schemes and nothing else", () => {
    expect(isQuadrantNaming("signs")).toBe(true);
    expect(isQuadrantNaming("dndp")).toBe(true);
    expect(isQuadrantNaming("positives")).toBe(false);
    expect(isQuadrantNaming(null)).toBe(false);
  });
});
