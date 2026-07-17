// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { divisionLevelCounts } from "../engine/division";
import type { FcsFile } from "../engine/fcs";
import type { Population } from "../engine/models";
import { Sample } from "../engine/sample";
import { initialCoreState, recompute } from "../store";
import { ProportionsTab } from "./ProportionsTab";
import { clearPersistedTabState } from "./tabState";
import { useSampleDataRevisionKey } from "./useSampleDataRevisions";

function flowSample(offset = 0): Sample {
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: 4,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL1-A", marker: null, bits: 32, range: 262144 },
      { index: 2, name: "FL2-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [
      Float32Array.from([100, 200, 300, 400]),
      Float32Array.from([0, 20, 40, 60].map((value) => value + offset)),
      Float32Array.from([10, 20, 30, 40]),
    ],
    spillover: {
      channels: ["FL1-A", "FL2-A"],
      matrix: [[1, 0.5], [0, 1]],
    },
  };
  return new Sample(fcs);
}

function bestSeparatingBoundary(original: number[], compensated: number[]): number {
  const values = [...new Set([...original, ...compensated])].sort((a, b) => a - b);
  const candidates = values.slice(0, -1).map((value, index) => (value + values[index + 1]) / 2);
  let best = candidates[0];
  let bestDelta = -1;
  for (const candidate of candidates) {
    const originalAbove = original.filter((value) => value >= candidate).length;
    const compensatedAbove = compensated.filter((value) => value >= candidate).length;
    const delta = Math.abs(originalAbove - compensatedAbove);
    if (delta > bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  if (!(bestDelta > 0)) throw new Error("Fixture does not separate Original and Compensated display values.");
  return best;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearPersistedTabState();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearPersistedTabState();
  vi.unstubAllGlobals();
});

describe("ProportionsTab Sample revisions", () => {
  it("rebuilds its all-sample division model when an inactive assay changes", () => {
    const active = flowSample(5);
    const inactive = flowSample();
    const probe = flowSample();
    const fl2 = inactive.channels.find((channel) => channel.pnn === "FL2-A")!.key;
    const idx = inactive.index(fl2)!;
    const originalDisplay = Array.from(inactive.displayColumn(idx));
    probe.setCompensation(true);
    const boundary = bestSeparatingBoundary(
      originalDisplay,
      Array.from(probe.displayColumn(probe.index(fl2)!)),
    );
    const samples = [
      { id: "active", name: "active.fcs", sample: active },
      { id: "inactive", name: "inactive.fcs", sample: inactive },
    ];
    const rootPopulation: Population = {
      population_id: "root",
      name: "All Events",
      gate_refs: [],
      gate_logic: "and",
      parent_id: null,
      children: [],
      event_count: 4,
      percent_of_parent: 100,
    };
    const state = {
      ...initialCoreState(),
      populations: { root: rootPopulation },
      root_population_id: "root",
      active_population_id: "root",
    };
    let divisionProfiles: Record<string, { channelKey: string; boundaries: number[]; n: number }> = {
      active: { channelKey: fl2, boundaries: [boundary], n: 1 },
      inactive: { channelKey: fl2, boundaries: [boundary], n: 1 },
    };
    function Harness() {
      const dataRevisionKey = useSampleDataRevisionKey(samples);
      return (
        <ProportionsTab
          samples={samples}
          activeSampleId="active"
          state={state}
          derived={recompute(active, state)}
          metadata={{}}
          metadataColumns={[]}
          divisionProfiles={divisionProfiles}
          dataRevisionKey={dataRevisionKey}
        />
      );
    }

    act(() => root.render(<Harness />));
    const divisionRadio = host.querySelectorAll<HTMLInputElement>('input[name="prop-cat"]')[1];
    act(() => divisionRadio.click());
    const titles = () => [...host.querySelectorAll(".gl-prop-mark title")].map((node) => node.textContent);
    const before = titles();
    const beforeCounts = divisionLevelCounts(inactive.displayColumn(idx), [boundary]);

    act(() => inactive.setCompensation(true));
    const afterCounts = divisionLevelCounts(inactive.displayColumn(idx), [boundary]);
    expect(afterCounts).not.toEqual(beforeCounts);
    expect(titles()).not.toEqual(before);

    act(() => {
      divisionProfiles = {
        active: { channelKey: fl2, boundaries: [boundary], n: 1 },
      };
      root.render(<Harness />);
    });
    expect(host.textContent).toContain("1 sample without a compatible division profile is excluded");
    const axisTitles = [...host.querySelectorAll("svg text title")].map((node) => node.textContent);
    expect(axisTitles).toContain("active.fcs");
    expect(axisTitles).not.toContain("inactive.fcs");
  });
});
