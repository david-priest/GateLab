// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedDivisionBoundaries } from "../engine/division";
import type { FcsFile } from "../engine/fcs";
import type { Population } from "../engine/models";
import { Sample } from "../engine/sample";
import { initialCoreState, recompute } from "../store";
import { DivisionTab } from "./DivisionTab";
import { clearPersistedTabState } from "./tabState";

const plot = vi.hoisted(() => ({
  render: vi.fn(),
  clear: vi.fn(),
  on: vi.fn(() => () => undefined),
}));

vi.mock("../plots/loadPlots", () => ({
  loadDivisionPlots: () => ({
    api: { render: plot.render, clear: plot.clear },
    bus: { on: plot.on },
  }),
}));

function flowSample(): Sample {
  const n = 240;
  const ctv = Array.from({ length: n }, (_, i) =>
    i < n / 2 ? 700 + (i % 19) * 14 : 5200 + (i % 23) * 31);
  const spillSource = Array.from({ length: n }, (_, i) =>
    i % 3 === 0 ? 6000 + (i % 17) * 80 : 150 + (i % 11) * 9);
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: n,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL1-A", marker: "CTV", bits: 32, range: 262144 },
      { index: 2, name: "FL2-A", marker: "CD3", bits: 32, range: 262144 },
    ],
    columns: [
      Float32Array.from({ length: n }, (_, i) => 10000 + i),
      Float32Array.from(ctv),
      Float32Array.from(spillSource),
    ],
    spillover: {
      channels: ["FL1-A", "FL2-A"],
      matrix: [[1, 0.45], [0.15, 1]],
    },
  };
  return new Sample(fcs);
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  clearPersistedTabState();
  plot.render.mockClear();
  plot.clear.mockClear();
  plot.on.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearPersistedTabState();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DivisionTab coordinate revisions", () => {
  it("reseeds numeric boundaries after the active assay changes coordinate space", () => {
    const sample = flowSample();
    const rootPopulation: Population = {
      population_id: "root",
      name: "All Events",
      gate_refs: [],
      gate_logic: "and",
      parent_id: null,
      children: [],
      event_count: sample.fcs.nEvents,
      percent_of_parent: 100,
    };
    const state = {
      ...initialCoreState(),
      populations: { root: rootPopulation },
      root_population_id: "root",
      active_population_id: "root",
    };
    const dyeIndex = sample.index("CTV")!;
    const renderTab = () => (
      <DivisionTab
        sample={sample}
        sampleName="sample.fcs"
        derived={recompute(sample, state)}
        savedProfile={null}
        profileStale={false}
        onApply={vi.fn()}
        dataRevision={sample.dataRevision}
      />
    );

    act(() => root.render(renderTab()));
    act(() => vi.runAllTimers());
    const original = seedDivisionBoundaries(sample.displayColumn(dyeIndex), 6);
    const firstPayload = plot.render.mock.calls.at(-1)?.[0] as { boundaries: number[] };
    expect(firstPayload.boundaries).toEqual(original);

    act(() => {
      sample.setCompensation(true);
      root.render(renderTab());
    });
    act(() => vi.runAllTimers());
    const compensated = seedDivisionBoundaries(sample.displayColumn(dyeIndex), 6);
    const secondPayload = plot.render.mock.calls.at(-1)?.[0] as { boundaries: number[] };

    expect(sample.dataRevision).toBe(1);
    expect(compensated).not.toEqual(original);
    expect(secondPayload.boundaries).toEqual(compensated);
  });
});
