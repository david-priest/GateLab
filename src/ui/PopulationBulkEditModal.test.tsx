// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreReducer, initialCoreState, type CoreState } from "../store";
import { BulkRenameModal } from "./CrudModals";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", {
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
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

function stateWithPopulation(): CoreState {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
  state = coreReducer(state, {
    type: "addGate",
    gateType: "rectangle",
    xChannel: "X",
    yChannel: "Y",
    vertices: [[0, 0], [1, 1]],
    name: "CD3+",
    createPop: {
      name: "Cells",
      parentId: state.root_population_id!,
    },
  });
  return state;
}

function textFile(name: string, text: string): File {
  const file = new File([text], name, { type: "text/csv" });
  Object.defineProperty(file, "text", { value: async () => text });
  return file;
}

describe("BulkRenameModal population definitions", () => {
  it("validates before applying and emits one atomic update", async () => {
    const state = stateWithPopulation();
    const population = Object.values(state.populations).find(({ name }) => name === "Cells")!;
    const onConfirm = vi.fn();
    act(() => root.render(
      <BulkRenameModal state={state} onCancel={vi.fn()} onConfirm={onConfirm} />,
    ));

    const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const csv = [
      "population_id,current_population,new_population,gate_names",
      `${state.root_population_id},All Events,All Events,`,
      `${population.population_id},Cells,T cells,`,
    ].join("\n");
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [textFile("population.csv", csv)],
    });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Validated — no changes have been applied yet.");
    expect(host.textContent).toContain("1 renames");
    expect(host.textContent).toContain("1 gate definitions changed");

    const apply = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Apply changes")!;
    act(() => apply.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        popId: population.population_id,
        name: "T cells",
        gateRefs: [],
      }),
    ]));
  });
});
