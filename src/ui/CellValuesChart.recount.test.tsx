// @vitest-environment jsdom
// The per-cell chart counts its cells again only when what it draws from changes: not for a style
// change, and not when App hands the tab the same files in a new array. Synthetic file D1.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { I18nProvider } from "./i18n";
import { PlottingTab } from "./PlottingTab";
import { clearPersistedTabState, restorePlottingState } from "./tabState";

const built = vi.hoisted(() => ({ count: 0 }));
vi.mock("../engine/cellValuesModel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine/cellValuesModel")>();
  return {
    ...actual,
    buildCellValuesModel: (...args: Parameters<typeof actual.buildCellValuesModel>) => {
      built.count++;
      return actual.buildCellValuesModel(...args);
    },
  };
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearPersistedTabState();
  built.count = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Per-cell chart: when it counts again", () => {
  it("is not rebuilt for a new array of the same files or a style change, and is for another channel", () => {
    const state = initialCoreState();
    const rootPop = newRootPopulation();
    const child = newPopulation("All", [], rootPop.population_id);
    rootPop.children = [child.population_id];
    Object.assign(state, {
      populations: { [rootPop.population_id]: rootPop, [child.population_id]: child },
      root_population_id: rootPop.population_id,
      active_population_id: rootPop.population_id,
    });
    const fcs: FcsFile = {
      version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {}, spillover: null,
      channels: [
        { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from([10, 20, 30]), Float32Array.from([30, 20, 10])],
    };
    const file = { id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
    restorePlottingState({ "prop.valueKind": "cells", "prop.plotType": "violin" });
    // App holds these between renders; only the files array is new each time.
    const metadata = {};
    const derived = recompute(file.sample, state as CoreState);
    const render = () =>
      act(() =>
        root.render(
          <I18nProvider>
            <PlottingTab
              samples={[{ ...file }]}
              activeSampleId="D1"
              state={state as CoreState}
              derived={derived}
              metadata={metadata}
              metadataColumns={[]}
              divisionProfiles={{}}
              dataRevisionKey="r1"
            />
          </I18nProvider>,
        ),
      );
    render();
    const first = built.count;
    expect(first).toBeGreaterThan(0);
    render();
    render();
    expect(built.count).toBe(first);
    // A style change: the grid.
    const grid = [...host.querySelectorAll("label")].find((l) => l.textContent?.trim() === "Grid lines")!.querySelector("input")!;
    act(() => grid.click());
    expect(built.count).toBe(first);
    // Another channel is counted again.
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Channel"]')!;
    act(() => {
      select.value = "SSC-A";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(built.count).toBe(first + 1);
  });
});
