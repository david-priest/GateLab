// @vitest-environment jsdom

// A panel's title is fitted to the panel's width, whole in its tooltip, so a narrow panel (seven
// to a chart in a Layout block) does not cut its title at both edges.
// Synthetic file names only.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChartPanel, panelTitleChars, panelTitleShown } from "./ChartPanel";
import { CHART_TITLE_CHARS } from "./chartFormat";

const TITLE = "Sample ID: Sample 1.fcs";

function shownTitle(width: number, titleFont: number) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<ChartPanel width={width} height={100} title={TITLE} titleFont={titleFont}>{null}</ChartPanel>);
  const text = host.querySelector("text")!;
  return { tooltip: text.querySelector("title")!.textContent, shown: text.lastChild!.textContent! };
}

describe("A chart panel's title", () => {
  it("is whole in a panel wide enough for it", () => {
    expect(shownTitle(400, 13)).toEqual({ tooltip: TITLE, shown: TITLE });
  });

  it("says the value alone of a column and its value in a narrow panel, and is whole in its tooltip", () => {
    expect(shownTitle(130, 13)).toEqual({ tooltip: TITLE, shown: "Sample 1.fcs" });
  });

  it("is shortened in the middle when the value alone is still too long, keeping its end", () => {
    const shown = panelTitleShown("Sample ID: D1_treated_replicate_1.fcs", 130, 13);
    expect(shown).toContain("…");
    expect(shown.startsWith("D1_")).toBe(true);
    expect(shown.endsWith("1.fcs")).toBe(true);
    // Counted as the panel layouts count a title: no wider than the panel less its edges.
    expect(shown.length * 13 * 0.62).toBeLessThanOrEqual(130 - 8);
    // A title of several parts keeps them all.
    expect(panelTitleShown("CD4_positive · condition: control", 130, 13).startsWith("CD4_po")).toBe(true);
    // A panel wide enough for a chart's longest title shortens one longer than that as before.
    expect(panelTitleShown("condition_with_a_long_synthetic_column_name: treated", 400, 11)).toBe("condition_with_a_long_s…ame: treated");
  });

  it("is never shortened past 12 characters nor shown longer than the chart's longest title", () => {
    expect(panelTitleChars(40, 16)).toBe(12);
    expect(panelTitleChars(2000, 11)).toBe(CHART_TITLE_CHARS);
  });
});
