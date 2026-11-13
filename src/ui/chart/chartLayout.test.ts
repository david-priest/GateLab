import { describe, expect, it } from "vitest";
import { cellPanelLayout } from "../CellValuesChart";
import { proportionPanelLayout } from "../ProportionsChart";
import { labelWidths, leftForTurnedLabels, rotatedLabelsLeft } from "./chartLayout";

const REACH = Math.cos((35 * Math.PI) / 180);
const files = (n: number) => Array.from({ length: n }, (_, i) => `D${(i % 3) + 1}_treated_long_sample_name_${String(i + 1).padStart(2, "0")}.fcs`);

/** How far each turned label's start lies right of the panel's left edge (negative: cut off). */
function labelClearance(layout: { width: number; margin: { left: number; right: number } }, labels: readonly string[], tickFont: number): number[] {
  const step = (layout.width - layout.margin.left - layout.margin.right) / labels.length;
  // Each label as drawn: shortened to 30 characters, about 0.58 em a character.
  return labels.map((label, i) => layout.margin.left + step * (i + 0.5) - Math.min(label.length, 30) * tickFont * 0.58 * REACH);
}

describe("left margin for turned category labels", () => {
  it("is the furthest a turned label reaches past the plot's left edge, plus the pad", () => {
    // A 100 px label ending 10 px into the plot reaches 81.9 - 10 px past it.
    expect(rotatedLabelsLeft([100], 20)).toBe(Math.ceil(100 * REACH - 10 + 3));
    // The second label, longer, reaches further than the first.
    expect(rotatedLabelsLeft([20, 200], 20)).toBe(Math.ceil(200 * REACH - 30 + 3));
    expect(rotatedLabelsLeft([10], 200)).toBe(0);
  });

  it("measures each label at about 0.58 em a character, shortened as drawn", () => {
    const [short, long] = labelWidths(["D1", "D1_treated"], 10);
    expect(short).toBeCloseTo(11.6);
    expect(long).toBeCloseTo(58);
    expect(labelWidths(["x".repeat(40)], 10, 30)[0]).toBeCloseTo(174);
  });

  it("raises the margin of a panel of set width until the first label fits, though the plot narrows", () => {
    const widths = [150, 150, 150, 150];
    const innerAt = (left: number) => 300 - left - 14;
    const left = leftForTurnedLabels(48, widths, innerAt);
    expect(left).toBeGreaterThan(48);
    expect(left + innerAt(left) / widths.length / 2 - 150 * REACH).toBeGreaterThanOrEqual(0);
  });

  it("leaves the margin when the labels already fit", () => {
    expect(leftForTurnedLabels(48, [20, 20], () => 400)).toBe(48);
  });

  it("keeps every turned file label inside a one-panel-for-all-files per-cell summary of set width", () => {
    // The Illustration summary with files down the rows: one panel, a cell wide, twenty files.
    const labels = files(20);
    const layout = cellPanelLayout("violin", labels, ["0", "50K", "100K", "150K"], 9, 120, 0, 11, 260);
    expect(layout.rotateLabels).toBe(true);
    expect(layout.width).toBe(260);
    expect(Math.min(...labelClearance(layout, labels, 9))).toBeGreaterThanOrEqual(0);
  });

  it("keeps turned file labels inside a per-cell chart fitted to its contents", () => {
    const labels = files(2);
    const layout = cellPanelLayout("violin", labels, ["0", "100K"], 9, 200);
    expect(layout.rotateLabels).toBe(true);
    expect(Math.min(...labelClearance(layout, labels, 9))).toBeGreaterThanOrEqual(0);
  });

  it("keeps turned file labels inside a proportion chart, fitted and of set width", () => {
    const labels = files(2);
    const fitted = proportionPanelLayout("box", labels, 2, 9);
    expect(fitted.rotateLabels).toBe(true);
    expect(Math.min(...labelClearance(fitted, labels, 9))).toBeGreaterThanOrEqual(0);
    const many = files(12);
    const set = proportionPanelLayout("stacked", many, 12, 9, 320);
    expect(set.rotateLabels).toBe(true);
    expect(set.width).toBe(320);
    expect(Math.min(...labelClearance(set, many, 9))).toBeGreaterThanOrEqual(0);
  });

  it("does not change a panel whose labels stay level", () => {
    const layout = cellPanelLayout("violin", ["A", "B"], ["0", "100K"], 9, 200);
    expect(layout.rotateLabels).toBe(false);
    expect(layout.margin.left).toBe(Math.max(48, Math.round(28 + 4 * 9 * 0.6)));
  });
});
