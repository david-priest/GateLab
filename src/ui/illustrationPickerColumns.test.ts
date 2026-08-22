import { describe, expect, it } from "vitest";
import { layoutIllustrationPicker } from "./illustrationPickerColumns";

// Columns exist to hold overflow, not to consume the width on offer. Taking every column the
// panel could fit spread fourteen channels over four columns of four, each three-quarters empty
// and harder to scan than one column would have been. Width still caps the count.

describe("layoutIllustrationPicker", () => {
  it("keeps a list that fits in ONE column", () => {
    const items = Array.from({ length: 10 }, (_, i) => i + 1);
    const layout = layoutIllustrationPicker(items, 4, { visibleRows: 15 });

    expect(layout.columns.map((c) => c.length)).toEqual([10]);
    expect(layout.columns.flat()).toEqual(items);
    expect(layout.lastColumnScrollable).toBe(false);
  });

  it("opens a second column only once the first is full", () => {
    const exactlyFull = layoutIllustrationPicker(
      Array.from({ length: 15 }, (_, i) => i + 1), 4, { visibleRows: 15 });
    expect(exactlyFull.columns.map((c) => c.length)).toEqual([15]);

    const oneMore = layoutIllustrationPicker(
      Array.from({ length: 16 }, (_, i) => i + 1), 4, { visibleRows: 15 });
    expect(oneMore.columns).toHaveLength(2);
    expect(oneMore.columns.flat()).toHaveLength(16);
  });

  it("never leaves an empty column", () => {
    // The old layout produced [10, 0, 0, 0] for a short hierarchy: three empty columns drawn
    // with dividers between them.
    for (const n of [1, 5, 10, 15, 16, 31, 45]) {
      const layout = layoutIllustrationPicker(
        Array.from({ length: n }, (_, i) => i + 1), 4, { visibleRows: 15 });
      expect(layout.columns.every((c) => c.length > 0), `n=${n}`).toBe(true);
      expect(layout.columns.flat()).toHaveLength(n);
    }
  });

  it("still puts overflow in the last column once every column is used", () => {
    const items = Array.from({ length: 68 }, (_, i) => i + 1);
    const layout = layoutIllustrationPicker(items, 4, { visibleRows: 15 });

    expect(layout.columns.map((c) => c.length)).toEqual([15, 15, 15, 23]);
    expect(layout.columns.flat()).toEqual(items);
    expect(layout.lastColumnScrollable).toBe(true);
  });

  it("is still capped by the width the panel actually has", () => {
    // 45 items want three columns; a narrow panel offering two gets two, with the rest
    // scrolling in the last.
    const items = Array.from({ length: 45 }, (_, i) => i + 1);
    const layout = layoutIllustrationPicker(items, 2, { visibleRows: 15 });

    expect(layout.columns).toHaveLength(2);
    expect(layout.lastColumnScrollable).toBe(true);
    expect(layout.columns.flat()).toEqual(items);
  });

  it("fills a hierarchy's left column before continuing right", () => {
    const layout = layoutIllustrationPicker(
      Array.from({ length: 32 }, (_, i) => i + 1), 4,
      { visibleRows: 15, distribution: "fill-first" });

    expect(layout.columns.map((c) => c.length)).toEqual([15, 15, 2]);
    expect(layout.columns.flat()).toHaveLength(32);
    expect(layout.lastColumnScrollable).toBe(false);
  });

  it("preserves reading order in every arrangement", () => {
    for (const n of [3, 14, 19, 40, 68]) {
      for (const avail of [1, 2, 3, 4]) {
        const items = Array.from({ length: n }, (_, i) => i + 1);
        const layout = layoutIllustrationPicker(items, avail, { visibleRows: 15 });
        expect(layout.columns.flat(), `n=${n} avail=${avail}`).toEqual(items);
      }
    }
  });
});
