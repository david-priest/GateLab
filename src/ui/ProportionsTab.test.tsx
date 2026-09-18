// @vitest-environment jsdom
// The Plotting tab's hand-off to the Layout tab: the chart as shown, as one settings object.
// Synthetic samples D1 and D2 on one tree; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { I18nProvider } from "./i18n";
import { ProportionsTab } from "./ProportionsTab";
import { clearPersistedTabState } from "./tabState";

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
  vi.unstubAllGlobals();
});

function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const child = newPopulation("Lymphocytes", [], rootPop.population_id);
  rootPop.children = [child.population_id];
  Object.assign(state, {
    populations: { [rootPop.population_id]: rootPop, [child.population_id]: child },
    root_population_id: rootPop.population_id,
    active_population_id: rootPop.population_id,
  });
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: 3,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from([10, 20, 30]), Float32Array.from([30, 20, 10])],
  };
  const samples = [
    { id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) },
    { id: "D2", name: "D2.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) },
  ];
  return { state: state as CoreState, samples, rootId: rootPop.population_id, childId: child.population_id };
}

function mount(fx: ReturnType<typeof fixture>, onAddToLayout?: (settings: unknown) => void) {
  act(() =>
    root.render(
      <I18nProvider>
        <ProportionsTab
          samples={fx.samples}
          activeSampleId="D1"
          state={fx.state}
          derived={recompute(fx.samples[0].sample, fx.state)}
          metadata={{ D1: { donor: "D1", day: "7" }, D2: { donor: "D2", day: "0" } }}
          metadataColumns={[{ name: "day" }, { name: "donor" }]}
          divisionProfiles={{}}
          dataRevisionKey="r1"
          onAddToLayout={onAddToLayout}
        />
      </I18nProvider>,
    ),
  );
}
const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);

describe("Plotting tab: Add to Layout", () => {
  it("hands the chart as shown to the Layout tab, as one settings object", () => {
    const fx = fixture();
    const onAddToLayout = vi.fn();
    mount(fx, onAddToLayout);
    expect(host.querySelector("#gl-prop-svg")).not.toBeNull();
    act(() => button("Add to Layout")!.click());
    expect(onAddToLayout).toHaveBeenCalledTimes(1);
    expect(onAddToLayout.mock.calls[0][0]).toMatchObject({
      files: ["D1", "D2"],
      hierarchy: DEFAULT_HIERARCHY_ID,
      parent: fx.rootId,
      selectedPops: [fx.childId],
      categoryKind: "population",
      plotType: "stacked",
      groupSel: "day",
      includeUngated: true,
      height: 280,
      legend: true,
    });
    // A change on the tab is in the next hand-off.
    const boxplot = [...host.querySelectorAll<HTMLInputElement>('input[name="prop-type"]')][1];
    act(() => boxplot.click());
    act(() => button("Add to Layout")!.click());
    expect(onAddToLayout.mock.calls[1][0]).toMatchObject({ plotType: "box" });
  });

  it("is not offered without a Layout tab to add to", () => {
    mount(fixture());
    expect(button("Add to Layout")).toBeUndefined();
  });
});
