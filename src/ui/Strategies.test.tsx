// @vitest-environment jsdom
// The Strategy tab's strategies: a tab each, every one with its own controls, undo and redo over
// them, and the Strategy record the workspace saves.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrategiesTab } from "./Strategies";
import type { StrategyConfig } from "./StrategyTab";
import { FIRST_STRATEGY } from "./strategySet";
import { clearPersistedTabState } from "./tabState";
import { I18nProvider } from "./i18n";
import { initialCoreState, type CoreState, type Derived } from "../store";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import type { FigureSample } from "../engine/figure";

const renderer = vi.hoisted(() => ({
  renderStrategyGrid: vi.fn(),
  renderMultiStrategyGrid: vi.fn(),
}));
vi.mock("../plots/loadPlots", () => ({ loadMiniPlots: () => renderer }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  clearPersistedTabState();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await vi.runAllTimersAsync(); });
}

/** All Events › Lymphocytes (FSC-A/SSC-A) › B cells (CD19/CD3), and T cells beside B cells. */
function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const lymph = newPopulation("Lymphocytes", [], rootPop.population_id);
  const lymphGate = newGate("Lymph_gate", "rectangle", "FSC-A", "SSC-A", [[0, 0], [15, 35]]);
  lymph.gate_refs = [{ gate_id: lymphGate.gate_id, include: true }];
  const bcells = newPopulation("B cells", [], lymph.population_id);
  const bGate = newGate("B_gate", "rectangle", "CD19", "CD3", [[5, 0], [40, 20]]);
  bcells.gate_refs = [{ gate_id: bGate.gate_id, include: true }];
  const tcells = newPopulation("T cells", [], lymph.population_id);
  const tGate = newGate("T_gate", "rectangle", "CD19", "CD3", [[0, 20], [5, 40]]);
  tcells.gate_refs = [{ gate_id: tGate.gate_id, include: true }];
  rootPop.children = [lymph.population_id];
  lymph.children = [bcells.population_id, tcells.population_id];
  Object.assign(state, {
    gates: { [lymphGate.gate_id]: lymphGate, [bGate.gate_id]: bGate, [tGate.gate_id]: tGate },
    gate_order: [lymphGate.gate_id, bGate.gate_id, tGate.gate_id],
    populations: { [rootPop.population_id]: rootPop, [lymph.population_id]: lymph, [bcells.population_id]: bcells, [tcells.population_id]: tcells },
    root_population_id: rootPop.population_id,
    active_population_id: bcells.population_id,
    active_hierarchy_id: DEFAULT_HIERARCHY_ID,
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
      { index: 2, name: "CD19", marker: null, bits: 32, range: 262144 },
      { index: 3, name: "CD3", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from([10, 20, 30]), Float32Array.from([30, 20, 10]), Float32Array.from([10, 20, 30]), Float32Array.from([5, 10, 15])],
  };
  const files: FigureSample[] = [{ id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) }];
  return { state: state as CoreState, files, lymphId: lymph.population_id, bcellsId: bcells.population_id, tcellsId: tcells.population_id };
}

type Fixture = ReturnType<typeof fixture>;
const derived = { masks: {} } as Derived;
const globalScales = {};

function tab(fx: Fixture, configRef: { current: StrategyConfig | null }, extra: { state?: CoreState; onConfigChange?: () => void } = {}) {
  return (
    <I18nProvider>
      <StrategiesTab
        state={extra.state ?? fx.state}
        sample={fx.files[0].sample}
        sampleName="D1.fcs"
        derived={derived}
        globalScales={globalScales}
        configRef={configRef}
        dataRevision={0}
        densityColorPower={1}
        onDensityColorPowerChange={vi.fn()}
        onFitChannels={vi.fn()}
        files={fx.files}
        poolIds={null}
        checkedSampleIds={[]}
        onViewFile={vi.fn()}
        activeSampleId="D1"
        onConfigChange={extra.onConfigChange}
      />
    </I18nProvider>
  );
}

const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Strategies"] [role="tab"]')];
const tabNames = () => tabs().map((b) => b.textContent);
const shownTab = () => tabs().find((b) => b.getAttribute("aria-selected") === "true")?.textContent;
const tabNamed = (name: string) => tabs().find((b) => b.textContent === name)!;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!;
const labelled = (text: string) => [...host.querySelectorAll<HTMLLabelElement>(".gl-strategy-inspector label")].find((l) => l.textContent?.trim().startsWith(text))!;
const population = () => labelled("Population").querySelector("select")!;
const fullPath = () => labelled("Full path from root").querySelector("input")!;
const multiple = () => labelled("Multiple pops").querySelector("input")!;
const columns = () => labelled("Columns").querySelector("input")!;
const menuItem = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')].find((b) => b.textContent === label)!;

async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
  await flush();
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}
async function rightClick(element: HTMLElement) {
  await act(async () => { element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); });
}
async function open(fx: Fixture, configRef: { current: StrategyConfig | null }, extra: Parameters<typeof tab>[2] = {}) {
  act(() => root.render(tab(fx, configRef, extra)));
  await flush();
}
/** Leave the tab and come back, as a switch to another tab and back does. */
async function reopen(fx: Fixture, configRef: { current: StrategyConfig | null }, extra: Parameters<typeof tab>[2] = {}) {
  act(() => root.render(<div>Gating</div>));
  await open(fx, configRef, extra);
}

describe("the Strategy tab's strategies", () => {
  it("opens as one strategy; a new one opens on the defaults, and each keeps its own controls", async () => {
    const fx = fixture();
    const configRef = { current: null as StrategyConfig | null };
    await open(fx, configRef);
    expect(tabNames()).toEqual(["Strategy 1"]);
    expect(shownTab()).toBe("Strategy 1");
    expect(population().value).toBe(fx.bcellsId);

    await choose(population(), fx.lymphId);
    await click(fullPath());
    await click(button("+"));
    expect(tabNames()).toEqual(["Strategy 1", "Strategy 2"]);
    expect(shownTab()).toBe("Strategy 2");
    // The new strategy: the tree's selection, and the path not from the root.
    expect(population().value).toBe(fx.bcellsId);
    expect(fullPath().checked).toBe(false);
    await click(multiple());

    await click(tabNamed("Strategy 1"));
    expect(shownTab()).toBe("Strategy 1");
    expect(multiple().checked).toBe(false);
    expect(population().value).toBe(fx.lymphId);
    expect(fullPath().checked).toBe(true);

    await click(tabNamed("Strategy 2"));
    expect(multiple().checked).toBe(true);
  });

  it("writes the shown strategy as the record's own fields and the others in its list", async () => {
    const fx = fixture();
    const configRef = { current: null as StrategyConfig | null };
    await open(fx, configRef);
    await choose(population(), fx.lymphId);
    await click(button("+"));
    await click(multiple());

    const record = configRef.current!;
    expect(record).toMatchObject({ mode: "multi", popId: fx.bcellsId });
    const list = record.strategies!;
    expect(list.items.map((item) => item.name)).toEqual(["Strategy 1", "Strategy 2"]);
    expect(list.items[0]).toMatchObject({ id: FIRST_STRATEGY.id, config: { mode: "single", popId: fx.lymphId } });
    expect(list.items[1].config).toBeUndefined();
    expect(list.activeId).toBe(list.items[1].id);
    expect(list.seenPopulationId).toBe(fx.bcellsId);

    // Showing the other strategy moves the fields with it.
    await click(tabNamed("Strategy 1"));
    expect(configRef.current).toMatchObject({ mode: "single", popId: fx.lymphId });
    expect(configRef.current!.strategies!.items[1]).toMatchObject({ config: { mode: "multi" } });
    expect(configRef.current!.strategies!.items[0].config).toBeUndefined();
  });

  it("comes back as it was left when the tab is opened again", async () => {
    const fx = fixture();
    const configRef = { current: null as StrategyConfig | null };
    await open(fx, configRef);
    await choose(population(), fx.lymphId);
    await click(button("+"));
    await click(tabNamed("Strategy 1"));

    await reopen(fx, configRef);
    expect(tabNames()).toEqual(["Strategy 1", "Strategy 2"]);
    expect(shownTab()).toBe("Strategy 1");
    // The tree's selection is still B cells: the strategy keeps the population it was given.
    expect(population().value).toBe(fx.lymphId);
  });

  it("the shown strategy follows the tree's selection when it changes, here or while away; the others keep theirs", async () => {
    const fx = fixture();
    const configRef = { current: null as StrategyConfig | null };
    await open(fx, configRef);
    await choose(population(), fx.lymphId);
    await click(button("+"));
    expect(population().value).toBe(fx.bcellsId);

    // Selected in the tree with the tab open.
    const onTcells = { ...fx.state, active_population_id: fx.tcellsId };
    await open(fx, configRef, { state: onTcells });
    expect(population().value).toBe(fx.tcellsId);
    await click(tabNamed("Strategy 1"));
    expect(population().value).toBe(fx.lymphId);

    // Selected in the tree while another tab was shown.
    await reopen(fx, configRef, { state: fx.state });
    expect(shownTab()).toBe("Strategy 1");
    expect(population().value).toBe(fx.bcellsId);
    await click(tabNamed("Strategy 2"));
    expect(population().value).toBe(fx.tcellsId);
  });

  it("opens a record saved before the tabs as one strategy, on the tree's selection as it did then", async () => {
    const fx = fixture();
    const first = { current: null as StrategyConfig | null };
    await open(fx, first);
    await choose(population(), fx.lymphId);
    await click(fullPath());
    const { strategies: _list, ...saved } = first.current!;

    const configRef = { current: saved as StrategyConfig };
    await reopen(fx, configRef);
    expect(tabNames()).toEqual(["Strategy 1"]);
    expect(fullPath().checked).toBe(true);
    expect(population().value).toBe(fx.bcellsId);
  });

  it("renames, duplicates, reorders and deletes from the tab", async () => {
    const fx = fixture();
    const configRef = { current: null as StrategyConfig | null };
    await open(fx, configRef);
    await click(fullPath());

    await act(async () => { tabNamed("Strategy 1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    const field = host.querySelector<HTMLInputElement>(".gl-layout-sheet-rename")!;
    field.value = "B cell sort";
    await act(async () => { field.blur(); });
    await flush();
    expect(tabNames()).toEqual(["B cell sort"]);
    // The strategy was not redrawn from its saved controls for a rename.
    expect(fullPath().checked).toBe(true);

    await rightClick(tabNamed("B cell sort"));
    await click(menuItem("Duplicate"));
    expect(tabNames()).toEqual(["B cell sort", "B cell sort copy"]);
    expect(shownTab()).toBe("B cell sort copy");
    expect(fullPath().checked).toBe(true);

    await rightClick(tabNamed("B cell sort copy"));
    await click(menuItem("Move left"));
    expect(tabNames()).toEqual(["B cell sort copy", "B cell sort"]);
    expect(configRef.current!.strategies!.items.map((item) => item.name)).toEqual(["B cell sort copy", "B cell sort"]);

    await rightClick(tabNamed("B cell sort copy"));
    await click(menuItem("Delete"));
    expect(tabNames()).toEqual(["B cell sort"]);
    expect(shownTab()).toBe("B cell sort");
    // The last strategy cannot be deleted.
    await rightClick(tabNamed("B cell sort"));
    expect(menuItem("Delete").disabled).toBe(true);
  });
});

describe("undo and redo on the Strategy tab", () => {
  it("take back and restore a control", async () => {
    const fx = fixture();
    const configRef = { current: null as StrategyConfig | null };
    await open(fx, configRef);
    expect(button("Undo").disabled).toBe(true);
    await click(fullPath());
    expect(button("Undo").disabled).toBe(false);
    await click(button("Undo"));
    expect(fullPath().checked).toBe(false);
    expect(button("Undo").disabled).toBe(true);
    await click(button("Redo"));
    expect(fullPath().checked).toBe(true);
    expect(configRef.current).toMatchObject({ fullPath: true });
  });

  it("bring back a deleted strategy with its controls, and take back a new one", async () => {
    const fx = fixture();
    const configRef = { current: null as StrategyConfig | null };
    await open(fx, configRef);
    await click(button("+"));
    await click(multiple());
    await click(tabNamed("Strategy 1"));

    await rightClick(tabNamed("Strategy 2"));
    await click(menuItem("Delete"));
    expect(tabNames()).toEqual(["Strategy 1"]);
    await click(button("Undo"));
    expect(tabNames()).toEqual(["Strategy 1", "Strategy 2"]);
    await click(tabNamed("Strategy 2"));
    expect(multiple().checked).toBe(true);

    // Back past the mode, then the new strategy itself.
    await click(button("Undo"));
    expect(multiple().checked).toBe(false);
    await click(button("Undo"));
    expect(tabNames()).toEqual(["Strategy 1"]);
    await click(button("Redo"));
    expect(tabNames()).toEqual(["Strategy 1", "Strategy 2"]);
  });

  it("keep a value typed in one field as one step", async () => {
    const fx = fixture();
    const configRef = { current: null as StrategyConfig | null };
    await open(fx, configRef);
    const field = columns();
    expect(field.value).toBe("4");
    act(() => field.focus());
    await type(field, "1");
    await type(field, "12");
    expect(configRef.current).toMatchObject({ nColumns: 12 });
    act(() => field.blur());
    await click(button("Undo"));
    expect(columns().value).toBe("4");
    expect(button("Undo").disabled).toBe(true);
  });

  it("answer Cmd-Z and Shift-Cmd-Z while the tab is shown", async () => {
    const fx = fixture();
    const configRef = { current: null as StrategyConfig | null };
    await open(fx, configRef);
    await click(fullPath());
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); });
    await flush();
    expect(fullPath().checked).toBe(false);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true, bubbles: true, cancelable: true })); });
    await flush();
    expect(fullPath().checked).toBe(true);
  });

  it("keep their steps while another tab is shown", async () => {
    const fx = fixture();
    const configRef = { current: null as StrategyConfig | null };
    await open(fx, configRef);
    await click(fullPath());
    await reopen(fx, configRef);
    expect(fullPath().checked).toBe(true);
    await click(button("Undo"));
    expect(fullPath().checked).toBe(false);
  });
});

describe("the workspace is told of a change to the strategies", () => {
  it("when a control or the list changes, not when the tab opens or another strategy is shown", async () => {
    const fx = fixture();
    const configRef = { current: null as StrategyConfig | null };
    const onConfigChange = vi.fn();
    await open(fx, configRef, { onConfigChange });
    expect(onConfigChange).not.toHaveBeenCalled();
    await click(fullPath());
    expect(onConfigChange).toHaveBeenCalledTimes(1);
    await click(button("+"));
    expect(onConfigChange).toHaveBeenCalledTimes(2);
    await click(tabNamed("Strategy 1"));
    await click(tabNamed("Strategy 2"));
    expect(onConfigChange).toHaveBeenCalledTimes(2);
    await reopen(fx, configRef, { onConfigChange });
    expect(onConfigChange).toHaveBeenCalledTimes(2);
  });
});
