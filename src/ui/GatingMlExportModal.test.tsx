// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatingMlExportModal } from "./CrudModals";
import { I18nProvider } from "./i18n";
import { initialCoreState, type CoreState } from "../store";
import { linkChildToParent, newGateRef, newPopulation, newRootPopulation, type Gate, type PopulationMap } from "../engine/models";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** Two gates; "A or B" at the top level, "Beneath" under it and "Further" under that. */
function stateWithTopLevelOr(): CoreState {
  const gate = (id: string): Gate => ({
    gate_id: id, name: id, gate_type: "rectangle", x_channel: "X", y_channel: "Y",
    vertices: [[0, 0], [1, 1]], color: "#000000", label_offset: null,
  } as Gate);
  const rootPop = newRootPopulation();
  let populations: PopulationMap = { [rootPop.population_id]: rootPop };
  const add = (name: string, refs: string[], parent: string, logic: "and" | "or" = "and") => {
    const p = newPopulation(name, refs.map((r) => newGateRef(r, true)), parent, logic);
    populations[p.population_id] = p;
    populations = linkChildToParent(populations, p.population_id, parent);
    return p.population_id;
  };
  const or = add("A or B", ["A", "B"], rootPop.population_id, "or");
  const beneath = add("Beneath", ["A"], or);
  add("Further", ["B"], beneath);
  return {
    ...initialCoreState(),
    gates: { A: gate("A"), B: gate("B") }, gate_order: ["A", "B"], populations, root_population_id: rootPop.population_id,
  };
}

describe("the Gating-ML export dialog", () => {
  it("names what the Cytobank format leaves out beneath an OR population, and still exports", () => {
    const onExport = vi.fn();
    act(() => root.render(
      <I18nProvider><GatingMlExportModal state={stateWithTopLevelOr()} onCancel={vi.fn()} onExport={onExport} /></I18nProvider>,
    ));
    const select = host.querySelector("select")!;
    act(() => {
      select.value = "cytobank";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const alert = [...host.querySelectorAll('[role="alert"]')].map((el) => el.textContent ?? "").join(" ");
    expect(alert).toMatch(/cannot hold a population beneath an OR population/);
    expect(alert).toMatch(/Beneath, and 2 populations in all, will not be included/);
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Export")!;
    expect(button.disabled).toBe(false);
    act(() => button.click());
    expect(onExport).toHaveBeenCalledWith("cytobank");
  });
});
