// Illustration's population list: its rows are labels inside .gl-figure-fields, whose label rule
// lets a row wrap. A deep row whose tree lines, box and swatch left too little room put its name on
// a line of its own at the panel's left, detached from its box (2026-11-12).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const figure = readFileSync("src/ui/figure.css", "utf8");
const rule = (selector: string): string => {
  const at = figure.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return figure.slice(at, figure.indexOf("}", at));
};

describe("Illustration population rows", () => {
  it("keep each population's name on its row, shrinking it rather than wrapping", () => {
    expect(rule(".gl-figure-fields .gl-strategy-pop-row")).toMatch(/flex-wrap: nowrap;/);
    expect(rule(".gl-figure-fields .gl-strategy-pop-name")).toMatch(/min-width: 0;/);
    // Placed after the label rule it overrides, at higher specificity.
    expect(figure.indexOf(".gl-figure-fields .gl-strategy-pop-row {")).toBeGreaterThan(figure.indexOf(".gl-figure-fields label {"));
  });
});
