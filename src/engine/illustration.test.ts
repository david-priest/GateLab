import { describe, expect, it } from "vitest";
import type { PopulationMap } from "./models";
import type { Sample } from "./sample";
import {
  buildMultiSampleIllustrationPayload,
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
