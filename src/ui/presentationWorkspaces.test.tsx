// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { initialCoreState, recompute } from "../store";
import { newGate, newPopulation, newRootPopulation } from "../engine/models";
import { cloneHierarchyTree, storeHierarchy } from "../engine/hierarchies";
import { Sample } from "../engine/sample";
import { createDefaultLayoutWorkspace, normalizeLayoutWorkspace } from "../engine/layout";
import { LayoutTab } from "./LayoutTab";
import { ProportionsTab } from "./ProportionsTab";
import { MetadataTab } from "./MetadataTab";
import { clearPersistedTabState, restorePlottingState, savedPlottingState } from "./tabState";
import { styledFigurePlot } from "./FigureGrid";
import { defaultIllustrationConfig } from "../engine/figureDefaults";
import { sampleDisplayId } from "../engine/metadata";

vi.mock("../plots/loadPlots", () => ({ loadMiniPlots: () => ({ renderMiniPlot: (host: HTMLElement, config: Record<string, unknown>) => { host.textContent = String(config.title); }, renderStrategyGrid: () => {} }) }));

function fixture() {
  const state = initialCoreState(), root = newRootPopulation();
  const gate = newGate("CD4_positive", "rectangle", "FSC-A", "SSC-A", [[0, 0], [150, 150]]);
  gate.space = "raw";
  const population = newPopulation("CD4_positive", [{ gate_id: gate.gate_id, include: true }], root.population_id);
  root.children = [population.population_id];
  Object.assign(state, { gates: { [gate.gate_id]: gate }, gate_order: [gate.gate_id], populations: { [root.population_id]: root, [population.population_id]: population }, root_population_id: root.population_id, active_population_id: population.population_id });
  const copy = cloneHierarchyTree(state.populations, root.population_id, state.gates, state.gate_order);
  const leaf = { ...storeHierarchy({ id: "leaf", name: "D2 copy" }, { ...state, ...copy }), source_hierarchy_id: "main", source_population_ids: Object.fromEntries(Object.entries(copy.idMap).map(([a, b]) => [b, a])), source_gate_ids: Object.fromEntries(Object.entries(copy.gateIdMap).map(([a, b]) => [b, a])), owner_sample_id: "D2" };
  const copiedGate = leaf.gates[copy.gateIdMap[gate.gate_id]];
  if (copiedGate.gate_type === "rectangle") copiedGate.vertices = [[0, 0], [50, 50]];
  state.hierarchies.push(leaf); state.stored_hierarchies.leaf = leaf;
  const files = [1, 2].map(i => ({ id: `D${i}`, name: `D${i}.fcs`, hierarchyId: i === 1 ? "main" : "leaf", sample: new Sample({ version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {}, spillover: null, channels: ["FSC-A", "SSC-A"].map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })), columns: [Float32Array.from([10, 100, 200]), Float32Array.from([10, 100, 200])] }) }));
  return { state, root, population, leaf, files };
}
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); clearPersistedTabState(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); clearPersistedTabState(); vi.unstubAllGlobals(); });
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); }); };
const change = (input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => act(() => { const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });

describe("presentation workspaces", () => {
  it("keeps file-local Layout plots when another file becomes active, and edits small text inline", async () => {
    const f = fixture(); let workspace = createDefaultLayoutWorkspace();
    workspace.sheets[0].items = [
      { id: "plot", x: 20, y: 60, width: 280, height: 280, z: 0, recipe: { kind: "biplot", sampleId: "D2", populationId: f.leaf.root_population_id!, xChannel: "FSC-A", yChannel: "SSC-A", displayMode: "contour" } },
      { id: "text", x: 20, y: 20, width: 64, height: 24, z: 1, recipe: { kind: "text", text: "Panel A", fontSize: 12 } },
    ];
    const render = (activeSampleId: string) => act(() => root.render(<LayoutTab workspace={workspace} onChange={next => { workspace = next; render(activeSampleId); }} samples={f.files} activeSampleId={activeSampleId} activePopulationId={f.root.population_id} state={f.state} globalScales={{}} defaultX="FSC-A" defaultY="SSC-A" illustrationConfig={null} dataRevision={0} densityColorPower={1} onOpenInGating={() => {}} />));
    render("D1"); await settle(); expect(host.querySelector(".gl-layout-plot-host")?.textContent).toContain("D2.fcs");
    render("D2"); await settle(); expect(host.querySelector(".gl-layout-plot-host")?.textContent).toContain("D2.fcs");
    const text = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Layout text"]')!;
    change(text, "Panel B"); act(() => text.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(workspace.sheets[0].items[1].recipe).toMatchObject({ text: "Panel B" });
    expect(normalizeLayoutWorkspace(workspace).sheets[0].items[1]).toMatchObject({ width: 64, height: 24, showFrame: false });
  });
  it("plots each file's tailored memberships and facets by file, without pooling replicates", () => {
    const f = fixture();
    restorePlottingState({ "prop.facetSel": "__sample__" });
    act(() => root.render(<ProportionsTab samples={f.files} activeSampleId="D1" state={f.state} derived={recompute(f.files[0].sample, f.state)} metadata={{ D1: { condition: "control" }, D2: { condition: "treated" } }} metadataColumns={[]} divisionProfiles={{}} dataRevisionKey="0" />));
    expect(host.querySelectorAll("svg.gl-prop-panel")).toHaveLength(2);
    const titles = [...host.querySelectorAll(".gl-prop-mark title")].map(node => node.textContent);
    expect(titles).toContain("CD4_positive: 66.7%"); expect(titles).toContain("CD4_positive: 33.3%");
    expect(savedPlottingState()["prop.facetSel"]).toBe("__sample__");
  });
  it("scales all figure fonts only when requested and forwards contour count", () => {
    const config = defaultIllustrationConfig(); config.scaleFontsWithPlot = false;
    expect(styledFigurePlot({}, config, 560, true).font_sizes).toMatchObject({ tick: config.fontTick });
    config.scaleFontsWithPlot = true; config.contourLevels = 6;
    expect(styledFigurePlot({}, config, 560, true)).toMatchObject({ contour_levels: 6, font_sizes: { tick: config.fontTick * 2, axis_label: config.fontAxis * 2, title: config.fontTitle * 2, gate_label: config.fontGate * 2 } });
  });
  it("offers editable Sample IDs without editing filenames or internal file identities", () => {
    const f = fixture(), onSetCell = vi.fn(), noop = () => {};
    act(() => root.render(<MetadataTab samples={f.files} metadata={{}} columns={[]} onSetCell={onSetCell} onAddColumn={noop} onRenameColumn={noop} onDeleteColumn={noop} onImport={noop} populationRows={[]} populationMetadata={{}} populationColumns={[]} onSetPopCell={noop} onAddPopColumn={noop} onRenamePopColumn={noop} onDeletePopColumn={noop} />));
    expect(host.textContent).toContain("Filename (read-only)");
    const cell = [...host.querySelectorAll<HTMLInputElement>("tbody input")].find(input => input.value === "D1.fcs")!;
    expect(cell).toBeTruthy(); change(cell, "control"); act(() => cell.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(onSetCell).toHaveBeenCalledWith("D1", "sample_id", "control");
    expect(f.files[0].name).toBe("D1.fcs"); expect(f.files[0].id).toBe("D1");
    expect(sampleDisplayId("D1.fcs", { sample_id: "control" })).toBe("control");
  });
  it("rejects invalid persisted Plotting controls", () => {
    restorePlottingState({ "prop.files": [4], "prop.plotType": "invalid", "prop.height": 9999, "prop.palette": "plasma", "other.key": true });
    expect(savedPlottingState()).toEqual({ "prop.height": 800, "prop.palette": "plasma" });
  });
});
