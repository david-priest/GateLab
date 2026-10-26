// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "../engine/fcs";
import { newGate, newGateRef, newPopulation, newRootPopulation, UNBOUNDED, type PopulationMap } from "../engine/models";
import { Sample } from "../engine/sample";
import { initialCoreState, recompute } from "../store";
import { clearPersistedTabState } from "./tabState";
import { StatsTab } from "./StatsTab";

// Eight events; CD4_positive holds the four with FL1-A at 500.
function synthetic(): Sample {
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: 8, instrument: "flow", keywords: {},
    channels: [
      { index: 0, name: "FL1-A", marker: "CD4", bits: 32, range: 262144 },
      { index: 1, name: "FL2-A", marker: "CD8", bits: 32, range: 262144 },
    ],
    columns: [
      new Float32Array([500, 500, 500, 5, 5, 5, 500, 5]),
      new Float32Array([500, 5, 5, 500, 500, 5, 500, 5]),
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

function render(minEvents: number | null, onMinEventsChange = vi.fn()) {
  const sample = synthetic();
  const [cd4, cd8] = sample.channels.map((c) => c.key);
  const gate = newGate("CD4 gate", "rectangle", cd4, cd8, [[100, -UNBOUNDED], [UNBOUNDED, UNBOUNDED]]);
  const all = newRootPopulation();
  const cd4Pos = newPopulation("CD4_positive", [newGateRef(gate.gate_id)], all.population_id);
  all.children = [cd4Pos.population_id];
  const populations: PopulationMap = { [all.population_id]: all, [cd4Pos.population_id]: cd4Pos };
  const state = {
    ...initialCoreState(),
    gates: { [gate.gate_id]: gate },
    gate_order: [gate.gate_id],
    populations,
    root_population_id: all.population_id,
    active_population_id: all.population_id,
  };
  act(() => root.render(
    <StatsTab
      samples={[{ id: "f1", name: "D1.fcs", sample }]}
      activeSampleId="f1"
      state={state}
      derived={recompute(sample, state)}
      defaultChannels={[cd4, cd8]}
      dataRevisionKey="0"
      minEvents={minEvents}
      onMinEventsChange={onMinEventsChange}
    />,
  ));
  return onMinEventsChange;
}

const rowClasses = () => [...host.querySelectorAll("tbody tr")].map((tr) => tr.className.includes("gl-stats-low"));

describe("StatsTab minimum events", () => {
  it("greys the rows whose count is below the minimum and says so", () => {
    render(5);
    expect(rowClasses()).toEqual([false, true]);
    expect(host.querySelectorAll("tbody tr")[1].getAttribute("title")).toBe("Count 4, below the minimum of 5");
    expect(host.textContent).toContain("Greyed: fewer than 5 events.");
  });

  it("greys nothing without a minimum, or when every count reaches it", () => {
    render(null);
    expect(rowClasses()).toEqual([false, false]);
    render(4);
    expect(rowClasses()).toEqual([false, false]);
    expect(host.textContent).not.toContain("Greyed");
  });

  it("applies a positive whole number and an empty field, and holds back anything else", () => {
    const onChange = render(null);
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Minimum events"]')!;
    const type = (value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    type("100");
    expect(onChange).toHaveBeenLastCalledWith(100);
    type("2.5");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("A whole number of events above 0.");
    type("");
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("shows the value of a workspace opened while the tab is showing", () => {
    render(null);
    const field = () => host.querySelector<HTMLInputElement>('input[aria-label="Minimum events"]')!;
    expect(field().value).toBe("");
    render(100);
    expect(field().value).toBe("100");
    render(null);
    expect(field().value).toBe("");
  });
});
