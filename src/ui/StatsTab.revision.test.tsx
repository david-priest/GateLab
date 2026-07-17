// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "../engine/fcs";
import type { Population } from "../engine/models";
import { Sample } from "../engine/sample";
import { initialCoreState, recompute } from "../store";
import { clearPersistedTabState } from "./tabState";
import { StatsTab } from "./StatsTab";
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

describe("StatsTab Sample revisions", () => {
  it("refreshes a selected non-active sample after its assay changes in place", () => {
    const active = flowSample(5);
    const inactive = flowSample();
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
    const fl2 = inactive.channels.find((channel) => channel.pnn === "FL2-A")!.key;
    function Harness() {
      const dataRevisionKey = useSampleDataRevisionKey(samples);
      return (
        <StatsTab
          samples={samples}
          activeSampleId="active"
          state={state}
          derived={recompute(active, state)}
          defaultChannels={[fl2]}
          dataRevisionKey={dataRevisionKey}
        />
      );
    }

    act(() => root.render(<Harness />));
    const selector = host.querySelector<HTMLSelectElement>(".gl-stats-opt-group select")!;
    act(() => {
      selector.value = "inactive";
      selector.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const medianCell = () => {
      const headings = [...host.querySelectorAll("thead th")].map((node) => node.textContent ?? "");
      const column = headings.findIndex((text) => text.includes("FL2-A Median"));
      return host.querySelectorAll("tbody tr")[0].querySelectorAll("td")[column].textContent;
    };
    expect(medianCell()).toBe("25");

    act(() => inactive.setCompensation(true));
    expect(inactive.dataRevision).toBe(1);
    expect(medianCell()).toBe("10");
  });
});
