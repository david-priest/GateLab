import { describe, expect, it } from "vitest";
import { layoutIllustrationPicker } from "./illustrationPickerColumns";

describe("layoutIllustrationPicker", () => {
  it("balances shorter lists across all available columns", () => {
    const items = Array.from({ length: 10 }, (_, i) => i + 1);
    const layout = layoutIllustrationPicker(items, 4, 15);

    expect(layout.columns.map((column) => column.length)).toEqual([3, 3, 2, 2]);
    expect(layout.columns.flat()).toEqual(items);
    expect(layout.lastColumnScrollable).toBe(false);
  });

  it("puts overflow in the last column after four visible pages", () => {
    const items = Array.from({ length: 68 }, (_, i) => i + 1);
    const layout = layoutIllustrationPicker(items, 4, 15);

    expect(layout.columns.map((column) => column.length)).toEqual([15, 15, 15, 23]);
    expect(layout.columns.flat()).toEqual(items);
    expect(layout.lastColumnScrollable).toBe(true);
  });

  it("adapts the same ordering to narrower two-column panels", () => {
    const items = Array.from({ length: 9 }, (_, i) => i + 1);
    const layout = layoutIllustrationPicker(items, 2, 15);

    expect(layout.columns.map((column) => column.length)).toEqual([5, 4]);
    expect(layout.columns.flat()).toEqual(items);
    expect(layout.lastColumnScrollable).toBe(false);
  });
});
