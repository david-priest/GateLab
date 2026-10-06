// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrategyTab } from "./StrategyTab";
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  renderer.renderStrategyGrid.mockClear();
  renderer.renderMultiStrategyGrid.mockClear();
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
async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await vi.runAllTimersAsync(); });
}

/** Two files of three events on the workspace tree; the Lymphocytes rectangle holds one event of each. */
function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const child = newPopulation("Lymphocytes", [], rootPop.population_id);
  const gate = newGate("Lymph_gate", "rectangle", "FSC-A", "SSC-A", [[0, 0], [15, 35]]);
  child.gate_refs = [{ gate_id: gate.gate_id, include: true }];
  rootPop.children = [child.population_id];
  Object.assign(state, {
    gates: { [gate.gate_id]: gate },
    gate_order: [gate.gate_id],
    populations: { [rootPop.population_id]: rootPop, [child.population_id]: child },
    root_population_id: rootPop.population_id,
    active_population_id: child.population_id,
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
    ],
    columns: [Float32Array.from([10, 20, 30]), Float32Array.from([30, 20, 10])],
  };
  const files: FigureSample[] = [
    { id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) },
    { id: "D2", name: "D2.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) },
  ];
  return { state, files, childId: child.population_id };
}

const lastPayload = () =>
  renderer.renderStrategyGrid.mock.calls.at(-1)![1] as { steps: Record<string, unknown>[]; strategy_context_title?: string };
const status = () => host.querySelector('[role="status"]')!.textContent;

describe("a pooled Strategy tab", () => {
  it("draws the Gating tab's pool, says what it pooled, and returns to one file when the pool is off", async () => {
    const fx = fixture();
    const onPoolChange = vi.fn();
    const props = {
      state: fx.state as CoreState,
      sample: fx.files[0].sample,
      sampleName: "D1.fcs",
      derived: { masks: {} } as Derived,
      globalScales: {},
      configRef: { current: null },
      dataRevision: 0,
      densityColorPower: 1,
      onDensityColorPowerChange: vi.fn(),
      onFitChannels: vi.fn(),
      files: fx.files,
      poolable: true,
      onPoolChange,
    };
    act(() => root.render(<I18nProvider><StrategyTab {...props} poolIds={["D1", "D2"]} /></I18nProvider>));
    await flush();
    expect(renderer.renderStrategyGrid).toHaveBeenCalled();
    const payload = lastPayload();
    expect(payload.steps).toHaveLength(1);
    expect(payload.steps[0]).toMatchObject({ gate_name: "Lymph_gate", n_before: 6, n_after: 2, pct_pass: 33.3 });
    expect(payload.steps[0].x).toHaveLength(6);
    expect(payload.strategy_context_title).toBe("Lymphocytes · 2 files pooled");
    expect(host.textContent).toContain("2 files pooled · Main");
    expect(status()).toBe("1 strategy steps · 2 files pooled");

    const pool = [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes("Pool checked files"))!.querySelector("input")!;
    expect(pool.checked).toBe(true);
    act(() => pool.click());
    expect(onPoolChange).toHaveBeenCalledWith(false);

    act(() => root.render(<I18nProvider><StrategyTab {...props} poolIds={null} /></I18nProvider>));
    await flush();
    expect(lastPayload().steps[0]).toMatchObject({ n_before: 3, n_after: 1 });
    expect(lastPayload().steps[0].x).toHaveLength(3);
    expect(lastPayload().strategy_context_title).toBe("Lymphocytes · D1.fcs");
    expect(host.textContent).toContain("D1.fcs · Main");
    expect(status()).toBe("1 strategy steps · current file and hierarchy");
  });

  it("says when nothing is pooled, and names the files the Gating tab left out", async () => {
    const fx = fixture();
    const props = {
      state: fx.state as CoreState,
      sample: fx.files[0].sample,
      sampleName: "D1.fcs",
      derived: { masks: {} } as Derived,
      globalScales: {},
      configRef: { current: null },
      dataRevision: 0,
      densityColorPower: 1,
      onDensityColorPowerChange: vi.fn(),
      onFitChannels: vi.fn(),
      files: fx.files,
      poolable: true,
      onPoolChange: vi.fn(),
    };
    act(() => root.render(<I18nProvider><StrategyTab {...props} poolIds={[]} /></I18nProvider>));
    await flush();
    expect(status()).toBe("Nothing is pooled: check the files to pool in the file list.");

    act(() => root.render(<I18nProvider><StrategyTab {...props} poolIds={["D1"]} poolNote="Not pooled, different panel: D2.fcs" /></I18nProvider>));
    await flush();
    expect(status()).toBe("1 strategy steps · 1 files pooled · Not pooled, different panel: D2.fcs");
  });
});
