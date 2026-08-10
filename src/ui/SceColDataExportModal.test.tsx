// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreReducer, initialCoreState } from "../store";
import { SceColDataExportModal } from "./SceColDataExportModal";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", {
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  uuid = 0;
});

describe("SceColDataExportModal", () => {
  it("surfaces collisions and exports explicit population/column mappings", () => {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
    state = coreReducer(state, {
      type: "addGate",
      gateType: "rectangle",
      xChannel: "X",
      yChannel: "Y",
      vertices: [[0, 0], [1, 1]],
      name: "CD3 gate",
      createPop: {
        name: "CD3+ cells",
        parentId: state.root_population_id!,
      },
    });
    const pop = Object.values(state.populations)
      .find(({ population_id }) => population_id !== state.root_population_id)!;
    const onExport = vi.fn();
    act(() => root.render(
      <SceColDataExportModal
        state={state}
        existingColumns={["CD3_cells"]}
        initialPopulationIds={[pop.population_id]}
        busy={false}
        onCancel={vi.fn()}
        onExport={onExport}
      />,
    ));

    expect(host.textContent).toContain("Overwrite existing colData column");
    const exportButton = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Export 1 population"))!;
    expect(exportButton.disabled).toBe(true);

    const overwrite = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.parentElement?.textContent?.includes("Overwrite existing"))!;
    act(() => overwrite.click());
    expect(exportButton.disabled).toBe(false);
    act(() => exportButton.click());

    expect(onExport).toHaveBeenCalledWith([{
      populationId: pop.population_id,
      populationName: "CD3+ cells",
      columnName: "CD3_cells",
      inLabel: "TRUE",
      outLabel: "FALSE",
    }], true);
  });
});
