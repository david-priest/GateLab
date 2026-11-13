// The frame a summary panel is drawn in: as wide as the columns it spans, and one panel high when
// it spans rows only (the files down the rows), where a chart stretched down every row could not
// be read.

import { describe, expect, it } from "vitest";
import type { FigurePanel } from "../engine/figure";
import { FIGURE_GRID_SPACING, summaryFrame } from "./FigureGrid";

const panel = (span?: { rows: number; columns: number }) => ({ ...(span ? { span } : {}) }) as FigurePanel;

describe("A summary panel's frame", () => {
  it("is unset for a panel that spans nothing", () => {
    expect(summaryFrame(panel(), 200)).toBeUndefined();
  });

  it("spans its columns, one panel high, with the columns' pitch for its marks", () => {
    expect(summaryFrame(panel({ rows: 1, columns: 3 }), 200)).toEqual({
      width: 3 * 200 + 2 * FIGURE_GRID_SPACING,
      height: 200,
      columns: { count: 3, pitch: 200 + FIGURE_GRID_SPACING },
    });
  });

  it("is one panel wide and one panel high when it spans rows only", () => {
    expect(summaryFrame(panel({ rows: 10, columns: 1 }), 200)).toEqual({ width: 200, height: 200 });
  });

  it("covers a block of rows and columns", () => {
    expect(summaryFrame(panel({ rows: 2, columns: 3 }), 200)).toEqual({ width: 3 * 200 + 2 * FIGURE_GRID_SPACING, height: 2 * 200 + FIGURE_GRID_SPACING });
  });
});
