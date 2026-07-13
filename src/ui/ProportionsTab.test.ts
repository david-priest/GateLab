import { describe, expect, it } from "vitest";
import { compactChartLabel, proportionPanelLayout } from "./ProportionsTab";

describe("Proportions chart layout", () => {
  it("keeps a single ordinary sample label horizontal and fully inside the SVG", () => {
    const layout = proportionPanelLayout("stacked", ["Concatenated.fcs"], 1, 13);

    expect(layout.rotateLabels).toBe(false);
    expect(layout.width).toBe(360);
    expect(layout.height).toBe(layout.margin.top + 240 + layout.margin.bottom);
  });

  it("expands stacked plots for additional groups instead of compressing the bars", () => {
    const layout = proportionPanelLayout("stacked", ["A", "B", "C", "D", "E", "F"], 6, 9);

    expect(layout.width - layout.margin.left - layout.margin.right).toBe(6 * 72);
  });

  it("gives category-heavy boxplots enough horizontal room", () => {
    const layout = proportionPanelLayout("box", Array.from({ length: 35 }, (_, i) => String(i + 1)), 2, 9);

    expect(layout.width - layout.margin.left - layout.margin.right).toBe(35 * 54);
  });

  it("reserves extra bottom space for genuinely crowded labels", () => {
    const layout = proportionPanelLayout(
      "stacked",
      ["A very long sample filename that cannot fit within its allocated slot", "control"],
      2,
      11,
    );

    expect(layout.rotateLabels).toBe(true);
    expect(layout.margin.bottom).toBeGreaterThan(68);
  });

  it("middle-ellipsizes extreme labels while preserving both identifying ends", () => {
    expect(compactChartLabel("donor-01_very_long_sample_description_stimulated.fcs", 24)).toBe("donor-01_very_l…ated.fcs");
  });
});
