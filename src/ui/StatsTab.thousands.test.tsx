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

/** One flow file whose FL1-A median is 12,345.6 (shown to the unit) and FL2-A median 0.25, raw. */
function flowSample(): Sample {
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: 3,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL1-A", marker: null, bits: 32, range: 262144 },
      { index: 2, name: "FL2-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [
      Float32Array.from([100, 200, 300]),
      Float32Array.from([1000, 12345.6, 250000]),
      Float32Array.from([0.1, 0.25, 0.4]),
    ],
    spillover: null,
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

describe("StatsTab MFI columns", () => {
  it("separate thousands as the counts do, and the CSV keeps plain digits", async () => {
    const sample = flowSample();
    const rootPopulation: Population = {
      population_id: "root",
      name: "All Events",
      gate_refs: [],
      gate_logic: "and",
      parent_id: null,
      children: [],
      event_count: 3,
      percent_of_parent: 100,
    };
    const state = {
      ...initialCoreState(),
      populations: { root: rootPopulation },
      root_population_id: "root",
      active_population_id: "root",
    };
    const keyOf = (pnn: string) => sample.channels.find((channel) => channel.pnn === pnn)!.key;
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    act(() => root.render(
      <StatsTab
        samples={[{ id: "f1", name: "D1.fcs", sample }]}
        activeSampleId="f1"
        state={state}
        derived={recompute(sample, state)}
        defaultChannels={[keyOf("FL1-A"), keyOf("FL2-A")]}
        dataRevisionKey="0"
      />,
    ));
    const cell = (heading: string) => {
      const headings = [...host.querySelectorAll("thead th")].map((node) => node.textContent ?? "");
      return host.querySelectorAll("tbody tr")[0].querySelectorAll("td")[headings.findIndex((text) => text.includes(heading))].textContent;
    };
    expect(cell("FL1-A Median")).toBe("12,346");
    expect(cell("FL2-A Median")).toBe("0.25");

    const copy = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Copy CSV")!;
    await act(async () => copy.click());
    const csv = String(writeText.mock.calls[0][0]);
    expect(csv).toContain("12345.6");
    expect(csv).not.toContain("12,3");
  });
});
