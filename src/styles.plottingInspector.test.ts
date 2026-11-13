// The Plotting tab's side panel is one column. Its section bodies inherit flex-wrap: wrap from the
// generic control-section rule; laid out as columns of a definite height they wrapped into further
// columns to the right of the 330 px panel, and Facet, Replicate unit and Arrange dimensions could
// be reached only by scrolling the panel sideways (2026-11-12).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");
const rule = (selector: string): string => {
  const at = styles.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return styles.slice(at, styles.indexOf("}", at));
};

describe("Plotting side panel", () => {
  it("stacks every section's controls in one column that does not wrap", () => {
    const body = rule(".gl-plotting-inspector .gl-control-sections, .gl-plotting-inspector .gl-control-section-body");
    expect(body).toMatch(/flex-direction: column;/);
    expect(body).toMatch(/flex-wrap: nowrap;/);
  });
});
