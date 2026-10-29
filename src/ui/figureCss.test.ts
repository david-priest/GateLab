// The figure inspector's tabs hide their sections with the `hidden` attribute, and figure.css
// hides them with `.gl-figure-fields section[hidden] { display: none; }`. A rule that names a
// section by its id outranks that one, so if it sets a display it must not apply while the section
// is hidden: `#figure-section-data { display: flex }` kept the Data section, its population list
// and "Saved figures & presets" on screen above every other tab's controls.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("figure.css", () => {
  const css = readFileSync("src/ui/figure.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));

  it("hides a hidden section even where a rule names it by id and sets its display", () => {
    const offending = rules
      .filter(({ selector, body }) =>
        /#figure-section-/.test(selector) &&
        /(^|;)\s*display\s*:\s*(?!none)/.test(body) &&
        !selector.includes(":not([hidden])"))
      .map(({ selector }) => selector);
    expect(offending).toEqual([]);
  });

  it("still lets the Data section fill the inspector while it is shown", () => {
    expect(rules.some(({ selector, body }) =>
      selector === ".gl-figure-fields > #figure-section-data:not([hidden])" && /display:\s*flex/.test(body))).toBe(true);
  });
});
