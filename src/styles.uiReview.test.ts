// Four faults David found reviewing 0.10.0, each a rule another rule outweighed or never had:
// tick labels that changed face with the interface language, gate-list badges cut off at the
// bottom, the Illustration right-click menu drawn as the figure workspace's buttons, and the plot
// toolbar's "?" squeezed to a dot by the toolbar's button padding.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");
const figure = readFileSync("src/ui/figure.css", "utf8");
const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
};

describe("0.10.0 review fixes", () => {
  it("names the family of d3's axis groups, so ticks do not follow the page's language", () => {
    expect(rule(styles, 'svg g[font-family="sans-serif"]')).toMatch(/font-family: Helvetica, Arial, sans-serif;/);
  });

  it("draws the gate's space badge as a block whose bordered box fits the name's line", () => {
    const badge = rule(styles, ".gate-space-badge");
    expect(badge).toMatch(/display: inline-block;/);
    expect(badge).toMatch(/line-height: 12px;/);
  });

  it("keeps menus opened in the figure workspace in the app's menu look", () => {
    const item = rule(figure, ".gl-figure-workspace .gl-menu-item");
    expect(item).toMatch(/border: none;/);
    expect(item).toMatch(/background: none;/);
    expect(item).toMatch(/padding: 5px 10px;/);
  });

  it("keeps the plot toolbar's help button unpadded, so its icon is drawn at full size", () => {
    const hint = rule(styles, ".gl-pool-toolbar .gl-help-hint");
    expect(hint).toMatch(/padding: 0;/);
    expect(hint).toMatch(/border: 0;/);
  });
});
