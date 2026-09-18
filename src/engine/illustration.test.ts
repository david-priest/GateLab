import { describe, expect, it } from "vitest";
import type { Gate, PopulationMap } from "./models";
import type { Sample } from "./sample";
import {
  buildIllustrationPayload,
  buildMultiSampleIllustrationPayload,
  cellLabelOffsets,
  treeLabelMove,
  type IllustrationOptions,
  type IllustrationSampleSource,
} from "./illustration";

function source(id: string, name: string, x: readonly number[]): IllustrationSampleSource {
  const column = Float32Array.from(x);
  const sample = {
    fcs: { nEvents: column.length },
    gatingData: () => [column],
    // Gates are now evaluated in their own coordinate space, so the payload asks for columns
    // per gate rather than once per sample. This stub has one space, so both resolve the same.
    gateAssayData: () => ({ n: column.length, forGate: () => [column] }),
    index: (key: string) => key === "X" ? 0 : undefined,
    displayColumn: () => column,
    channelTicks: () => null,
    labelForKey: (key: string) => key,
    gatingToDisplay: (_key: string, value: number) => value,
    gateToDisplay: (_gate: unknown, _key: string, value: number) => value,
    gateSpace: () => "raw",
  } as unknown as Sample;
  return {
    id,
    name,
    sample,
    masks: { pop: new Uint8Array(column.length).fill(1) },
    eventCount: { pop: column.length },
  };
}

const populations = {
  pop: {
    population_id: "pop",
    name: "Live cells",
    gate_refs: [],
    gate_logic: "and",
    parent_id: null,
    children: [],
    event_count: null,
    percent_of_parent: null,
  },
} satisfies PopulationMap;

const options: IllustrationOptions = {
  displayMode: "scatter",
  maxEvents: 10_000,
  nColumns: 2,
  plotSize: 200,
  fitToColumns: true,
  contourThreshold: 5,
  pointAlpha: 0.4,
  densityColorPower: 1,
  pointSize: 1,
  kdeBandwidth: 0,
  colorByPop: false,
  overlayPops: false,
  populationColors: { pop: "#123456" },
  histLineWidth: 1,
  histFill: false,
  histFillAlpha: 0.3,
  histOverlayMode: "blend",
  histLayout: "grid",
  ridgeOverlap: 0,
  ridgeColGap: 0,
  ridgeGradient: false,
  pubStyle: false,
  gateLineWidth: 1,
  fontSizes: { tick: 9, axis_label: 11, gate_label: 10, title: 12 },
  scaleFontsWithPlot: true,
};

describe("multi-sample Illustration payload", () => {
  const sources = [
    source("a", "donor-a.fcs", [1, 2]),
    source("b", "donor-b.fcs", [10, 20, 30]),
  ];

  it("keeps checked files as separate file-labelled rows by default", () => {
    const payload = buildMultiSampleIllustrationPayload(
      sources,
      "a",
      {},
      [],
      populations,
      ["pop"],
      ["X"],
      null,
      {},
      options,
      false,
    ) as {
      pop_ids: string[];
      pop_names: Record<string, string>;
      pop_counts: Record<string, number>;
      plots: Record<string, { x: number[] }>;
    };

    expect(payload.pop_ids).toEqual(["a::pop", "b::pop"]);
    expect(payload.pop_names).toEqual({
      "a::pop": "donor-a.fcs — Live cells",
      "b::pop": "donor-b.fcs — Live cells",
    });
    expect(payload.pop_counts).toEqual({ "a::pop": 2, "b::pop": 3 });
    expect(payload.plots["a::pop|X"].x).toEqual([1, 2]);
    expect(payload.plots["b::pop|X"].x).toEqual([10, 20, 30]);
  });

  it("pools matching populations only when combine is explicit", () => {
    const payload = buildMultiSampleIllustrationPayload(
      sources,
      "a",
      {},
      [],
      populations,
      ["pop"],
      ["X"],
      null,
      {},
      options,
      true,
    ) as {
      pop_ids: string[];
      pop_names: Record<string, string>;
      pop_counts: Record<string, number>;
      plots: Record<string, { x: number[]; n_events: number }>;
    };

    expect(payload.pop_ids).toEqual(["pop"]);
    expect(payload.pop_names).toEqual({ pop: "Live cells" });
    expect(payload.pop_counts).toEqual({ pop: 5 });
    expect(payload.plots["pop|X"].x).toEqual([1, 2, 10, 20, 30]);
    expect(payload.plots["pop|X"].n_events).toBe(5);
  });

  it("renders only explicitly selected FCS × population cells", () => {
    const payload = buildMultiSampleIllustrationPayload(
      sources,
      "a",
      {},
      [],
      populations,
      ["pop"],
      ["X"],
      null,
      {},
      options,
      false,
      { a: ["pop"], b: [] },
    ) as {
      pop_ids: string[];
      pop_counts: Record<string, number>;
      plots: Record<string, { x: number[] }>;
    };

    expect(payload.pop_ids).toEqual(["a::pop"]);
    expect(payload.pop_counts).toEqual({ "a::pop": 2 });
    expect(payload.plots["a::pop|X"].x).toEqual([1, 2]);
    expect(payload.plots["b::pop|X"]).toBeUndefined();
  });

  it("pools only samples selected for each population", () => {
    const payload = buildMultiSampleIllustrationPayload(
      sources,
      "a",
      {},
      [],
      populations,
      ["pop"],
      ["X"],
      null,
      {},
      options,
      true,
      { a: [], b: ["pop"] },
    ) as {
      pop_ids: string[];
      pop_counts: Record<string, number>;
      plots: Record<string, { x: number[]; n_events: number }>;
    };

    expect(payload.pop_ids).toEqual(["pop"]);
    expect(payload.pop_counts).toEqual({ pop: 3 });
    expect(payload.plots["pop|X"].x).toEqual([10, 20, 30]);
    expect(payload.plots["pop|X"].n_events).toBe(3);
  });
});

describe("Illustration gate overlays", () => {
  it("carries quadrant geometry and four population-relative counts into a biplot", () => {
    const x = Float32Array.from([1, 3, 3, 1]);
    const y = Float32Array.from([3, 3, 1, 1]);
    const columns = { X: x, Y: y };
    const sample = {
      fcs: { nEvents: x.length },
      gateAssayData: () => ({
        n: x.length,
        forGate: () => ({
          n: x.length,
          column: (key: string) => columns[key as keyof typeof columns],
        }),
      }),
      index: (key: string) => key === "X" ? 0 : key === "Y" ? 1 : undefined,
      displayColumn: (index: number) => index === 0 ? x : y,
      channelTicks: () => null,
      labelForKey: (key: string) => key,
      gateToDisplay: (_gate: unknown, _key: string, value: number) => value,
      displayToGate: (_gate: unknown, _key: string, value: number) => value,
    } as unknown as Sample;
    const gate = {
      gate_id: "quadrant-1",
      name: "Four-way split",
      gate_type: "quadrant",
      x_channel: "X",
      y_channel: "Y",
      center: [2, 2],
      color: "#123456",
      label_offset: null,
    } satisfies Gate;

    const payload = buildIllustrationPayload(
      sample,
      { "quadrant-1": gate },
      ["quadrant-1"],
      populations,
      { pop: new Uint8Array(x.length).fill(1) },
      { pop: x.length },
      ["pop"],
      ["X"],
      "Y",
      { X: [0, 4], Y: [0, 4] },
      options,
    ) as { gate_overlays: Record<string, Array<Record<string, unknown>>> };

    expect(payload.gate_overlays["pop|X"]).toEqual([expect.objectContaining({
      gate_id: "quadrant-1",
      gate_type: "quadrant",
      center: [2, 2],
      quadrant_counts: [1, 1, 1, 1],
      quadrant_pcts: [25, 25, 25, 25],
    })]);
  });
});

describe("Illustration label placements", () => {
  it("swaps a tree gate's offsets for a cell that shows the gate flipped, and a cell move maps back", () => {
    const gate = { label_offset: [1, 2] as [number, number], quadrant_label_offsets: [[3, 4] as [number, number], null, null, [5, 6] as [number, number]] };
    expect(cellLabelOffsets(gate, false)).toEqual({ label_offset: [1, 2], quadrant_label_offsets: [[3, 4], null, null, [5, 6]] });
    // Flipped: the axes swap, and the cell's top-left shows the gate's bottom-right quadrant.
    expect(cellLabelOffsets(gate, true)).toEqual({ label_offset: [2, 1], quadrant_label_offsets: [null, null, [4, 3], [6, 5]] });
    expect(cellLabelOffsets({ label_offset: null }, true)).toEqual({ label_offset: null });
    // A drag in the cell comes back in the gate's own orientation.
    expect(treeLabelMove([2, 1], undefined, true)).toEqual({ offset: [1, 2] });
    expect(treeLabelMove([4, 3], 2, true)).toEqual({ offset: [3, 4], quadrant: 0 });
    expect(treeLabelMove([4, 3], 1, false)).toEqual({ offset: [4, 3], quadrant: 1 });
  });

  it("marks an overlay drawn with its axes swapped, offsets swapped to match", () => {
    const x = Float32Array.from([1, 3, 3, 1]);
    const y = Float32Array.from([3, 3, 1, 1]);
    const columns = { X: x, Y: y };
    const sample = {
      fcs: { nEvents: x.length },
      gateAssayData: () => ({
        n: x.length,
        forGate: () => ({ n: x.length, column: (key: string) => columns[key as keyof typeof columns] }),
      }),
      index: (key: string) => key === "X" ? 0 : key === "Y" ? 1 : undefined,
      displayColumn: (index: number) => index === 0 ? x : y,
      channelTicks: () => null,
      labelForKey: (key: string) => key,
      gateToDisplay: (_gate: unknown, _key: string, value: number) => value,
      displayToGate: (_gate: unknown, _key: string, value: number) => value,
    } as unknown as Sample;
    // Drawn on (Y, X); the cell plots (X, Y).
    const gate = {
      gate_id: "rect-1", name: "Cells", gate_type: "rectangle", x_channel: "Y", y_channel: "X",
      vertices: [[0, 0], [2, 4]], color: "#123456", label_offset: [1, 2],
    } satisfies Gate;
    const payload = buildIllustrationPayload(
      sample, { "rect-1": gate }, ["rect-1"], populations,
      { pop: new Uint8Array(x.length).fill(1) }, { pop: x.length }, ["pop"], ["X"], "Y",
      { X: [0, 4], Y: [0, 4] }, options,
    ) as { gate_overlays: Record<string, Array<Record<string, unknown>>> };
    expect(payload.gate_overlays["pop|X"]).toEqual([expect.objectContaining({ gate_id: "rect-1", flipped: true, label_offset: [2, 1] })]);
  });
});
