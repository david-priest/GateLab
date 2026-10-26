// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatingMlExportModal } from "./CrudModals";
import { I18nProvider } from "./i18n";
import { initialCoreState, type CoreState } from "../store";
import { linkChildToParent, newGateRef, newPopulation, newRootPopulation, type Gate, type PopulationMap, type TransformSpec } from "../engine/models";
import { Sample } from "../engine/sample";

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

  it("says that tailored coordinates are not written, naming the tree and the files, and only then", () => {
    const render = (fileNames: string[]) => act(() => root.render(
      <I18nProvider>
        <GatingMlExportModal state={stateWithTopLevelOr()} onCancel={vi.fn()} onExport={vi.fn()} tailoring={{ treeName: "Main", fileNames }} />
      </I18nProvider>,
    ));
    const alerts = () => [...host.querySelectorAll('[role="alert"]')].map((el) => el.textContent ?? "").join(" ");
    render(["D1.fcs", "D2.fcs"]);
    expect(alerts()).toContain("those of the tree drawn now, Main. 2 file(s) are gated with tailored gates");
    expect(alerts()).toContain("not written: D1.fcs, D2.fcs.");
    render(["D1", "D2", "D3", "D4", "D5", "D6", "D7"]);
    expect(alerts()).toContain("not written: D1, D2, D3, D4, D5 and 2 more.");
    render([]);
    expect(alerts()).not.toContain("tailored");
  });

  it("names the gates each format writes other than as drawn, for the format chosen", () => {
    // Synthetic D1.fcs: a logicle rectangle, a biex polygon and a raw rectangle.
    const sample = new Sample({
      version: "FCS3.1", nEvents: 4, instrument: "flow", keywords: {}, spillover: null,
      channels: ["FSC-A", "FL1-A", "FL2-A"].map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
      columns: [[1000, 50000, 90000, 120000], [-50, 200, 3000, 40000], [-20, 900, 6000, 20000]].map((c) => Float32Array.from(c)),
    });
    const [fsc, fl1, fl2] = sample.channels.map((c) => c.key);
    const logicle: TransformSpec = { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 };
    const biex: TransformSpec = { kind: "biex", maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -10, channelRange: 256 };
    const gates: Record<string, Gate> = {
      g1: { gate_id: "g1", name: "CD4_positive", gate_type: "rectangle", x_channel: fl1, y_channel: fl2, color: "#000000", label_offset: null,
        vertices: [[0.5, 0.5], [0.9, 0.5], [0.9, 0.9], [0.5, 0.9]], space: "display", transforms: { [fl1]: logicle, [fl2]: logicle } } as Gate,
      g2: { gate_id: "g2", name: "Lymphocytes", gate_type: "polygon", x_channel: fl1, y_channel: fl2, color: "#000000", label_offset: null,
        vertices: [[60, 60], [200, 80], [180, 220]], space: "display", transforms: { [fl1]: biex, [fl2]: biex } } as Gate,
      g3: { gate_id: "g3", name: "Cells", gate_type: "rectangle", x_channel: fsc, y_channel: fl1, color: "#000000", label_offset: null,
        vertices: [[0, 0], [100000, 0], [100000, 100000], [0, 100000]], space: "raw" } as Gate,
    };
    const rootPop = newRootPopulation();
    let populations: PopulationMap = { [rootPop.population_id]: rootPop };
    for (const id of Object.keys(gates)) {
      const p = newPopulation(`${gates[id].name}_cells`, [newGateRef(id, true)], rootPop.population_id);
      populations[p.population_id] = p;
      populations = linkChildToParent(populations, p.population_id, rootPop.population_id);
    }
    const state: CoreState = { ...initialCoreState(), gates, gate_order: ["g1", "g2", "g3"], populations, root_population_id: rootPop.population_id };
    act(() => root.render(
      <I18nProvider><GatingMlExportModal state={state} sample={sample} onCancel={vi.fn()} onExport={vi.fn()} /></I18nProvider>,
    ));
    const alerts = () => [...host.querySelectorAll('[role="alert"]')].map((el) => el.textContent ?? "");
    // Standard: logicle is declared, so only the biex polygon is named.
    expect(alerts().some((a) => /arcsinh/.test(a))).toBe(false);
    expect(alerts().filter((a) => /written in raw units/.test(a))).toEqual([
      expect.stringMatching(/^1 gate \(Lymphocytes\) is written in raw units, being drawn on FlowJo biex/),
    ]);
    const select = host.querySelector("select")!;
    act(() => {
      select.value = "cytobank";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const arcsinh = alerts().filter((a) => /arcsinh/.test(a));
    expect(arcsinh).toHaveLength(1);
    expect(arcsinh[0]).toMatch(/has no logicle or Hyperlog transform: 1 gate \(CD4_positive\) drawn on logicle or Hyperlog axes is written on arcsinh axes \(cofactor 150\)/);
    expect(arcsinh[0]).toMatch(/The standard format keeps logicle and Hyperlog\./);
    expect(alerts().filter((a) => /written in raw units/.test(a))).toHaveLength(1);
    expect(alerts().join(" ")).not.toMatch(/Cells/);
  });
});
