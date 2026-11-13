// @vitest-environment jsdom
// Folds draw the app's chevron, not the browser's disclosure triangle (David, 2026-11-10: "There are
// still some small collapse triangles"): the summary component, the CSS that hides the native marker
// and turns the chevron, and a sweep that no fold in the app is left with a bare <summary>.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FoldSummary } from "./FoldSummary";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("FoldSummary", () => {
  it("heads a fold with the chevron icon before its text, hidden from assistive technology", () => {
    act(() => root.render(<details><FoldSummary>Typography</FoldSummary><p>body</p></details>));
    const summary = host.querySelector("details > summary")!;
    expect(summary.classList.contains("gl-fold-summary")).toBe(true);
    expect(summary.textContent).toBe("Typography");
    const mark = summary.firstElementChild!;
    expect(mark.classList.contains("gl-fold-mark")).toBe(true);
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.querySelector(".gl-icon-chevron svg")).not.toBeNull();
  });

  it("leaves the details uncontrolled, so a click on the heading still opens and closes it", () => {
    act(() => root.render(<details><FoldSummary>Saved figures & presets</FoldSummary><p>body</p></details>));
    const details = host.querySelector("details")!;
    const summary = details.querySelector("summary")!;
    expect(details.open).toBe(false);
    act(() => summary.click());
    expect(details.open).toBe(true);
    act(() => summary.click());
    expect(details.open).toBe(false);
  });
});

describe("fold summary styles", () => {
  const styles = readFileSync("src/styles.css", "utf8");
  const figure = readFileSync("src/ui/figure.css", "utf8");

  it("hides the native marker and turns the chevron down while the fold is open", () => {
    expect(styles).toMatch(/\.gl-fold-summary \{[^}]*list-style: none;/);
    expect(styles).toMatch(/\.gl-fold-summary::-webkit-details-marker \{ display: none; \}/);
    expect(styles).toMatch(/details\[open\] > \.gl-fold-summary \.gl-icon-chevron \{ transform: rotate\(90deg\); \}/);
  });

  it("draws no text triangle before the metadata fold's heading", () => {
    expect(figure).not.toMatch(/\.gl-figure-facets-fold[^{]*::before/);
  });
});

describe("folds across the app", () => {
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });

  it("heads every <details> with FoldSummary unless it is a popover, which hides its own marker", () => {
    const bare: string[] = [];
    for (const file of sources("src")) {
      if (file.endsWith(join("ui", "FoldSummary.tsx"))) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/<summary\b/g)) {
        const opened = text.lastIndexOf("<details", match.index);
        const tag = opened < 0 ? "" : text.slice(opened, text.indexOf(">", opened));
        if (!/gl-popover|gl-header-notes/.test(tag)) {
          bare.push(`${file}:${text.slice(0, match.index).split("\n").length}`);
        }
      }
    }
    expect(bare).toEqual([]);
  });
});
