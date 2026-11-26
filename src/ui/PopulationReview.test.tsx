// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FcsFile } from "../engine/fcs";
import { cloneHierarchyTree, storeHierarchy } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import { coreReducer, initialCoreState } from "../store";
import { PopulationReview } from "./PopulationReview";

const draw = vi.hoisted(() => vi.fn());
vi.mock("../plots/loadPlots", () => ({ loadMiniPlots: () => ({ renderMiniPlot: draw }) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  draw.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function flush() { await act(async () => { await vi.runAllTimersAsync(); }); }

function fixture() {
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: 4, instrument: "flow", keywords: {}, spillover: null,
    channels: ["FSC-A", "SSC-A"].map((name, index) => ({ index, name, bits: 32, range: 1024, marker: null })),
    columns: [Float32Array.of(10, 20, 30, 40), Float32Array.of(1, 2, 3, 4)],
  };
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
  for (const [name, threshold] of [["Cells", 35], ["Target", 15]] as const) {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name,
      xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [threshold, 10]],
      createPop: { name, parentId: state.active_population_id! } });
  }
  const live = storeHierarchy(state.hierarchies[0], state);
  const clone = cloneHierarchyTree(live.populations, live.root_population_id!, live.gates, live.gate_order);
  const invert = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));
  const copy = { ...live, id: "copy", owner_sample_id: "D2", source_hierarchy_id: live.id,
    source_gate_ids: invert(clone.gateIdMap), source_population_ids: invert(clone.idMap),
    root_population_id: clone.root_population_id, gates: clone.gates, gate_order: clone.gate_order, populations: clone.populations };
  // D2's narrower parent holds only FSC-A=10; its own child still holds that event.
  const broadGate = copy.gates[clone.gateIdMap[live.gate_order[0]]];
  if (broadGate.gate_type !== "rectangle") throw Error("Expected a rectangle");
  broadGate.vertices = [[0, 0], [12, 10]];
  state = { ...state, hierarchies: [...state.hierarchies, copy], stored_hierarchies: { [copy.id]: copy } };
  const files = ["D1", "D2"].map((id, i) => ({ id, name: id + ".fcs", sample: new Sample(fcs), hierarchyId: i ? copy.id : live.id }));
  return { state, population: state.populations[state.active_population_id!], files, checked: ["D1", "D2"],
    reference: files[0].sample, referenceName: files[0].name, currentX: "FSC-A", currentY: "SSC-A",
    rangeOf: (key: string): [number, number] => key === "FSC-A" ? [-5, 80] : [-1, 6],
    underActiveTree: () => true, panelKeyOf: () => "panel", revision: "1", onClose: vi.fn() };
}

it("backgates a selected population in each file's own tree on shared axes and follows the chosen ancestor", async () => {
  const props = fixture();
  act(() => root.render(<PopulationReview {...props} />));
  await flush();
  expect(host.textContent).toContain("1 of 3 events");
  expect(host.textContent).toContain("1 of 1 events");
  const panels = draw.mock.calls.slice(-2).map(([, cfg]) => cfg);
  expect(panels.map(cfg => Array.from(cfg.x))).toEqual([[10, 20, 30], [10]]);
  expect(panels.map(cfg => Array.from(cfg.x_back))).toEqual([[10], [10]]);
  for (const cfg of panels) {
    expect(cfg.x_range).toEqual([-5, 80]);
    expect(cfg.y_range).toEqual([-1, 6]);
  }
  const select = host.querySelector("select")!;
  act(() => { select.value = "1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelectorAll("article")[1].textContent).toContain("1 of 4 events");
  const cfg = draw.mock.lastCall![1];
  expect(Array.from(cfg.x_back)).toEqual([10]);
  expect(cfg.gates[0].vertices.map(([x]: number[]) => x)).toContain(12);
});

it("reports an empty selection and excludes incompatible files without preparing a plot", async () => {
  const props = fixture();
  act(() => root.render(<PopulationReview {...props} checked={[]} />));
  await flush();
  expect(host.textContent).toContain("Select files in the file list");
  expect(draw).not.toHaveBeenCalled();
  act(() => root.render(<PopulationReview {...props} checked={["D2"]} underActiveTree={() => false} />));
  await flush();
  expect(host.textContent).toContain("D2.fcsOutside the active tree.");
  expect(host.textContent).not.toContain("D1.fcsOutside");
  expect(draw).not.toHaveBeenCalled();
});

it("projects a file with a different scatter transform onto the reference axes without changing its gate or membership", async () => {
  const props = fixture();
  const changed = props.files[1].sample;
  changed.setScatterScale(changed.index("FSC-A")!, "arcsinh");
  const original = Array.from(changed.displayColumn(changed.index("FSC-A")!));
  expect(original[0]).not.toBe(10);
  act(() => root.render(<PopulationReview {...props} />));
  await flush();
  expect(Array.from(draw.mock.lastCall![1].x_back)).toEqual([10]);
  expect(host.querySelectorAll("article")[1].textContent).toContain("1 of 1 events");
  expect(Array.from(changed.displayColumn(changed.index("FSC-A")!))).toEqual(original);
});

it("cancels preparation when the review closes before its first file", async () => {
  const props = fixture();
  act(() => root.render(<PopulationReview {...props} />));
  act(() => root.render(null));
  await flush();
  expect(draw).not.toHaveBeenCalled();
});
