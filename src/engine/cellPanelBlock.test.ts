import { describe, expect, it } from "vitest";
import type { ChannelDisplay } from "../imaging/imageWallSettings";
import {
  CELL_PANEL_GAP, CELL_PANEL_PADDING, cellPanelGeometry, cellPanelNaturalSize, cellPanelRenderParts, defaultCellPanel, normalizeCellPanelRecipe,
} from "./cellPanelBlock";

const d = (slot: number, name: string, enabled: boolean, colour = "#00ff00"): ChannelDisplay => ({
  slot, name, enabled, colour, threshold: 0.1, saturation: 0.8, gamma: 1, smoothing: 1,
});
const display = [d(2, "LightLoss (Imaging)", true, "#bdbdbd"), d(3, "FSC", false, "#ffff00"), d(5, "CD4", true, "#00ff00"), d(6, "CD8", true, "#ff0000")];
const cells = [{ event: 12, label: "Event 12" }, { event: 40, label: "Event 40 · single" }];

describe("defaultCellPanel", () => {
  it("puts LightLoss first in grey, the other channels in colour, and a merge of the switched-on fluorescence", () => {
    const panel = defaultCellPanel({ sampleId: "D1", fileName: "D1.fcs", cells, display, exposure: 1.5, mask: { slot: 4, fraction: 0.125 } });
    expect(panel.columns).toEqual([
      { kind: "channel", slot: 2, header: "LightLoss (Imaging)", grey: true },
      { kind: "channel", slot: 3, header: "FSC" },
      { kind: "channel", slot: 5, header: "CD4" },
      { kind: "channel", slot: 6, header: "CD8" },
      { kind: "merge", slots: [5, 6], header: "Merge" },
    ]);
    expect(panel).toMatchObject({ kind: "cellpanel", sampleId: "D1", exposure: 1.5, tile: 64, mask: { slot: 4, fraction: 0.125 }, showHeaders: true, showLabels: true });
    expect(panel.outline).toBeUndefined();
    // One fluorescence channel switched on is not worth a merge.
    const one = defaultCellPanel({ sampleId: "D1", fileName: "D1.fcs", cells, display: [display[0], display[2]], exposure: 1 });
    expect(one.columns.some((c) => c.kind === "merge")).toBe(false);
  });
});

describe("cellPanelGeometry", () => {
  const panel = defaultCellPanel({ sampleId: "D1", fileName: "D1.fcs", cells, display, exposure: 1 });
  it("lays cells as rows and columns as columns, with room for the labels and headers", () => {
    const g = cellPanelGeometry(panel);
    expect([g.rows, g.cols]).toEqual([2, 5]);
    expect(g.labelWidth).toBeGreaterThan(60);
    expect(g.headerHeight).toBeGreaterThan(0);
    expect(g.titleHeight).toBe(0);
    expect(g.width).toBe(g.gridX + 5 * 64 + 4 * CELL_PANEL_GAP + CELL_PANEL_PADDING);
    expect(cellPanelNaturalSize(panel)).toEqual({ width: g.width, height: g.height });
  });
  it("transposes, and drops the labels, headers or title when switched off or empty", () => {
    const t = cellPanelGeometry({ ...panel, transpose: true });
    expect([t.rows, t.cols]).toEqual([5, 2]);
    const bare = cellPanelGeometry({ ...panel, showHeaders: false, showLabels: false });
    expect([bare.labelWidth, bare.headerHeight]).toEqual([0, 0]);
    expect(cellPanelGeometry({ ...panel, title: "CD4 T cells" }).titleHeight).toBeGreaterThan(0);
  });
});

describe("cellPanelRenderParts", () => {
  it("asks for each column's channel once, the grey ones untinted, and a composite of the merge's channels with each gain applied", () => {
    const panel = { ...defaultCellPanel({ sampleId: "D1", fileName: "D1.fcs", cells, display, exposure: 1 }), gain: { 5: 2 } };
    const parts = cellPanelRenderParts(panel);
    expect(parts.channels).toEqual([2, 3, 5, 6]);
    expect(parts.grey).toEqual([2]);
    expect(parts.composite).toBe(true);
    expect(parts.display.filter((x) => x.enabled).map((x) => x.slot)).toEqual([5, 6]);
    const cd4 = parts.display.find((x) => x.slot === 5)!;
    expect(cd4.saturation).toBeCloseTo(0.4, 9);
    expect(cd4.threshold).toBeCloseTo(0.05, 9);
    expect(parts.display.find((x) => x.slot === 6)!.saturation).toBeCloseTo(0.8, 9);
    const noMerge = cellPanelRenderParts({ ...panel, columns: panel.columns.filter((c) => c.kind !== "merge") });
    expect(noMerge.composite).toBe(false);
    // A column switched off is not asked for and not laid out; a hidden merge makes no composite.
    const off = { ...panel, columns: panel.columns.map((c) => (c.slot === 3 || c.kind === "merge" ? { ...c, hidden: true } : c)) };
    const offParts = cellPanelRenderParts(off);
    expect(offParts.channels).toEqual([2, 5, 6]);
    expect(offParts.composite).toBe(false);
    expect(cellPanelGeometry(off).cols).toBe(3);
    expect(normalizeCellPanelRecipe(JSON.parse(JSON.stringify(off)))?.columns.filter((c) => c.hidden)).toHaveLength(2);
  });
});

describe("normalizeCellPanelRecipe", () => {
  it("round-trips a panel and drops what is malformed", () => {
    const panel = { ...defaultCellPanel({ sampleId: "D1", fileName: "D1.fcs", cells, display, exposure: 1, mask: { slot: 4 }, outline: true }), gain: { 5: 2 }, transpose: true, title: "Exemplars" };
    expect(normalizeCellPanelRecipe(JSON.parse(JSON.stringify(panel)))).toEqual(panel);
    const messy = { ...JSON.parse(JSON.stringify(panel)), cells: [{ event: -1 }, { event: 7 }], columns: [{ kind: "channel" }, { kind: "merge", slots: [5, 6], header: "M" }], gain: { 5: -1, x: 2 } };
    const fixed = normalizeCellPanelRecipe(messy)!;
    expect(fixed.cells).toEqual([{ event: 7, label: "Event 7" }]);
    expect(fixed.columns).toEqual([{ kind: "merge", slots: [5, 6], header: "M" }]);
    expect(fixed.gain).toBeUndefined();
    expect(normalizeCellPanelRecipe({ ...messy, cells: [] })).toBeNull();
    expect(normalizeCellPanelRecipe({ kind: "imagewall" })).toBeNull();
  });
});
