import { describe, expect, it } from "vitest";
import { layoutIllustrationPicker } from "./illustrationPickerColumns";

describe("layoutIllustrationPicker", () => {
  it("balances shorter lists across all available columns", () => {
    const items = Array.from({ length: 10 }, (_, i) => i + 1);
    const layout = layoutIllustrationPicker(items, 4, { visibleRows: 15 });

    expect(layout.columns.map((column) => column.length)).toEqual([3, 3, 2, 2]);
    expect(layout.columns.flat()).toEqual(items);
    expect(layout.lastColumnScrollable).toBe(false);
  });

  it("puts overflow in the last column after four visible pages", () => {
    const items = Array.from({ length: 68 }, (_, i) => i + 1);
    const layout = layoutIllustrationPicker(items, 4, { visibleRows: 15 });

    expect(layout.columns.map((column) => column.length)).toEqual([15, 15, 15, 23]);
    expect(layout.columns.flat()).toEqual(items);
    expect(layout.lastColumnScrollable).toBe(true);
  });

  it("adapts the same ordering to narrower two-column panels", () => {
    const items = Array.from({ length: 9 }, (_, i) => i + 1);
    const layout = layoutIllustrationPicker(items, 2, { visibleRows: 15 });

    expect(layout.columns.map((column) => column.length)).toEqual([5, 4]);
    expect(layout.columns.flat()).toEqual(items);
    expect(layout.lastColumnScrollable).toBe(false);
  });

  it("fills a hierarchy's left column before continuing into the next column", () => {
    const shortHierarchy = Array.from({ length: 10 }, (_, i) => i + 1);
    const longerHierarchy = Array.from({ length: 32 }, (_, i) => i + 1);

    const shortLayout = layoutIllustrationPicker(shortHierarchy, 4, {
      visibleRows: 15,
      distribution: "fill-first",
    });
    const longerLayout = layoutIllustrationPicker(longerHierarchy, 4, {
      visibleRows: 15,
      distribution: "fill-first",
    });

    expect(shortLayout.columns.map((column) => column.length)).toEqual([10, 0, 0, 0]);
    expect(longerLayout.columns.map((column) => column.length)).toEqual([15, 15, 2, 0]);
    expect(longerLayout.columns.flat()).toEqual(longerHierarchy);
    expect(longerLayout.lastColumnScrollable).toBe(false);
  });
});
