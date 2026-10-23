import { readFileSync } from "node:fs";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as icons from "./icons";

describe("interface icons", () => {
  const names = Object.keys(icons).filter((name) => /Icon$/.test(name));

  it("are 16 px, drawn with the draw tools' one stroke width, and hidden from assistive technology", () => {
    for (const name of ["ChevronIcon", "ChevronDownIcon", "CloseIcon", "UndoIcon", "RedoIcon", "ResetIcon", "RefreshIcon", "ArrowLeftIcon", "ArrowRightIcon", "ArrowUpIcon", "ArrowDownIcon", "MinusIcon", "DuplicateIcon"]) {
      expect(names).toContain(name);
      const Icon = icons[name as keyof typeof icons] as ComponentType;
      const svg = renderToStaticMarkup(<Icon />);
      expect(svg, name).toMatch(/width="16" height="16" viewBox="0 0 16 16"/);
      expect(svg, name).toMatch(/stroke-width="1.4"/);
      expect(svg, name).toMatch(/aria-hidden="true"/);
    }
    expect(renderToStaticMarkup(<icons.RectIcon />)).toMatch(/stroke-width="1.4"/);
  });

  it("turn the disclosure chevron when open", () => {
    // The turn is on a span around the svg: closed and open each name their angle, with no
    // transition, so closing always shows it pointing right.
    for (const open of [false, true, false, true, false]) {
      const markup = renderToStaticMarkup(<icons.ChevronIcon open={open} />);
      expect(markup).toMatch(open ? /^<span class="gl-icon-chevron is-open"/ : /^<span class="gl-icon-chevron"/);
      expect(markup).toMatch(/<svg[^>]*class="gl-icon"/);
    }
    const tokens = readFileSync("src/tokens.css", "utf8");
    expect(tokens).toMatch(/\.gl-icon-chevron \{[^}]*transform: rotate\(0deg\); \}/);
    expect(tokens).not.toMatch(/\.gl-icon-chevron[^{]*\{[^}]*transition/);
    expect(tokens).toMatch(/\.gl-icon-chevron\.is-open \{ transform: rotate\(90deg\); \}/);
    expect(tokens).not.toMatch(/@keyframes/);
  });
});

describe("design tokens", () => {
  const tokens = readFileSync("src/tokens.css", "utf8");
  const styles = readFileSync("src/styles.css", "utf8");

  it("are loaded before any rule that reads them", () => {
    expect(styles.startsWith('@import "./tokens.css";')).toBe(true);
  });

  it("hold four type sizes, none below 11 px", () => {
    const sizes = [...tokens.matchAll(/--gl-font-size-[a-z]+: (\d+)px;/g)].map((match) => Number(match[1]));
    expect(sizes).toEqual([11, 12, 13, 15]);
  });

  it("put spacing on the 4 px grid", () => {
    const spaces = [...tokens.matchAll(/--gl-space-\d+: (\d+)px;/g)].map((match) => Number(match[1]));
    expect(spaces).toEqual([4, 8, 12, 16, 24]);
  });

  it("define no variable a rule already reads with a fallback", () => {
    for (const name of ["--border", "--ink", "--danger", "--gl-accent", "--gl-accent-soft", "--gl-border", "--gl-muted"]) {
      expect(tokens, name).not.toMatch(new RegExp(`${name}:`));
    }
  });
});
