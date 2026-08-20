import { describe, it, expect } from "vitest";
import { gateRefLabel } from "./gateRefLabel";

describe("gateRefLabel", () => {
  it("leaves an included reference as the plain gate name", () => {
    expect(gateRefLabel("Lymphocytes", true)).toBe("Lymphocytes");
  });

  it("spells out NOT rather than prefixing a hyphen", () => {
    // "-CD4" reads as a marker name in cytometry, where "CD4-" means CD4-negative.
    expect(gateRefLabel("CD4", false)).toBe("NOT CD4");
    expect(gateRefLabel("CD4", false)).not.toContain("-CD4");
  });

  it("keeps the quadrant suffix outside the NOT prefix", () => {
    expect(gateRefLabel("Quad", true, 2)).toBe("Quad [Q2]");
    expect(gateRefLabel("Quad", false, 2)).toBe("NOT Quad [Q2]");
  });
});
