import { describe, expect, it } from "vitest";
import type { PopulationMap } from "./models";
import type { Sample } from "./sample";
import type { IllustrationOptions, IllustrationSampleSource } from "./illustration";
import {
  buildIllustrationLayoutPayload,
  moveIllustrationDimension,
  normalizeIllustrationLayout,
  type IllustrationDimensionLayout,
} from "./illustrationLayout";

function source(id: string, values: readonly number[]): IllustrationSampleSource {
  const column = Float32Array.from(values);
  const sample = {
    fcs: { nEvents: column.length },
    gateAssayData: () => ({ n: column.length, forGate: () => [column] }),
    index: (key: string) => key === "X" ? 0 : undefined,
    displayColumn: () => column,
    channelTicks: () => null,
    labelForKey: () => "Signal X",
    gateToDisplay: (_gate: unknown, _key: string, value: number) => value,
    displayToGate: (_gate: unknown, _key: string, value: number) => value,
  } as unknown as Sample;
  return {
    id,
    name: `${id}.fcs`,
    sample,
    masks: {
      all: new Uint8Array(column.length).fill(1),
      positive: Uint8Array.from(values.map((_, index) => Number(index % 2 === 0))),
    },
    eventCount: {
      all: column.length,
      positive: Math.ceil(column.length / 2),
    },
  };
}

const populations: PopulationMap = {
  all: {
    population_id: "all", name: "All Events", gate_refs: [], gate_logic: "and",
    parent_id: null, children: ["positive"], event_count: null, percent_of_parent: null,
  },
  positive: {
    population_id: "positive", name: "Positive", gate_refs: [], gate_logic: "and",
    parent_id: "all", children: [], event_count: null, percent_of_parent: null,
  },
};

const options: IllustrationOptions = {
  displayMode: "scatter",
  maxEvents: 10_000,
  nColumns: 4,
  plotSize: 200,
  fitToColumns: true,
  contourThreshold: 5,
  pointAlpha: 0.4,
  densityColorPower: 1.6,
  pointSize: 1,
  kdeBandwidth: 0,
  colorByPop: true,
  overlayPops: false,
  populationColors: { all: "#111111", positive: "#2255aa" },
  histLineWidth: 1.5,
  histFill: false,
  histFillAlpha: 0.2,
  histOverlayMode: "blend",
  histLayout: "grid",
  ridgeOverlap: 0.7,
  ridgeColGap: 8,
  ridgeGradient: true,
  pubStyle: false,
  gateLineWidth: 1.5,
  fontSizes: { tick: 9, axis_label: 12, gate_label: 10, title: 12 },
  scaleFontsWithPlot: true,
};

const sources = [source("D1", [1, 2]), source("D2", [10, 20, 30])];

function build(layout: IllustrationDimensionLayout) {
  return buildIllustrationLayoutPayload(
    sources, "D1", {}, [], populations, ["all", "positive"], ["X"], null, {},
    options, layout,
  );
}

describe("Illustration dimension layout", () => {
  it("moves whole dimensions while preserving exactly one placement", () => {
    const initial = normalizeIllustrationLayout({
      rows: ["files", "populations"], columns: ["channels"], overlay: [],
    });
    const columns = moveIllustrationDimension(initial, "files", "columns", 0);
    expect(columns).toEqual({
      rows: ["populations"],
      columns: ["files", "channels"],
      overlay: [],
    });
    const overlaid = moveIllustrationDimension(columns, "populations", "overlay");
    expect(overlaid).toEqual({
      rows: [],
      columns: ["files", "channels"],
      overlay: ["populations"],
    });
  });

  it("never permits channels to become an overlay", () => {
    const repaired = normalizeIllustrationLayout({
      rows: [], columns: [], overlay: ["channels", "files", "files"],
    });
    expect(repaired.overlay).toEqual(["files"]);
    expect(repaired.columns).toContain("channels");
    expect(new Set([...repaired.rows, ...repaired.columns, ...repaired.overlay]).size).toBe(3);
  });

  it("can put FCS files on columns instead of fixed rows", () => {
    const payload = build({
      rows: ["populations"], columns: ["files", "channels"], overlay: [],
    });
    expect(payload.rowGroups.map((group) => group[0].label)).toEqual(["All Events", "Positive"]);
    expect(payload.columnGroups.map((group) => group.map(({ label }) => label).join(" / ")))
      .toEqual(["D1.fcs / Signal X", "D2.fcs / Signal X"]);
    expect(payload.panels).toHaveLength(4);
    expect(payload.panels[0].config?.x).toEqual([1, 2]);
    expect(payload.panels[1].config?.x).toEqual([10, 20, 30]);
  });

  it("pools files and overlays populations only when those dimensions are on Overlay", () => {
    const pooled = build({ rows: ["populations"], columns: ["channels"], overlay: ["files"] });
    expect(pooled.panels[0].config?.x).toEqual([1, 2, 10, 20, 30]);
    expect(pooled.overlayLabel).toBe("Files pooled (2)");

    const overlaid = build({ rows: [], columns: ["channels"], overlay: ["files", "populations"] });
    expect(overlaid.panels).toHaveLength(1);
    expect(overlaid.panels[0].config?.x).toEqual([1, 2, 10, 20, 30]);
    expect(overlaid.panels[0].config?.overlay_traces).toEqual([
      expect.objectContaining({ name: "Positive", x: [1, 10, 30] }),
    ]);
    expect(overlaid.panels[0].config?.gates).toEqual([]);
  });
});
