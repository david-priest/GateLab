// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrategyTab } from "./StrategyTab";
import { initialCoreState, type Derived } from "../store";
import { newRootPopulation } from "../engine/models";
import type { Sample } from "../engine/sample";

const renderer = vi.hoisted(() => ({
  renderStrategyGrid: vi.fn(),
  renderMultiStrategyGrid: vi.fn(),
}));
vi.mock("../plots/loadPlots", () => ({ loadMiniPlots: () => renderer }));
vi.mock("../engine/strategy", () => ({
  computeGatingStrategy: () => [{ x_channel: "FSC-A", y_channel: "SSC-A" }],
  buildStrategyPayload: () => ({}),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("Strategy preview lifecycle", () => {
  it("disables export until current settings are painted and cancels work after leaving", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const state = initialCoreState(),
      population = newRootPopulation();
    Object.assign(state, {
      populations: { [population.population_id]: population },
      root_population_id: population.population_id,
      active_population_id: population.population_id,
    });
    const props = {
      state,
      sample: {} as Sample,
      sampleName: "D1.fcs",
      derived: { masks: {} } as Derived,
      globalScales: {},
      configRef: { current: null },
      dataRevision: 0,
      densityColorPower: 1,
      onDensityColorPowerChange: vi.fn(),
      onFitChannels: vi.fn(),
    };
    const svg = () =>
      [...host.querySelectorAll("button")].find(
        (b) => b.textContent === "SVG",
      )!;
    try {
      act(() => root.render(<StrategyTab {...props} />));
      expect(svg().disabled).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(svg().disabled).toBe(false);
      expect(renderer.renderStrategyGrid).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain("D1.fcs · Main");
      act(() => root.render(<StrategyTab {...props} dataRevision={1} />));
      expect(svg().disabled).toBe(true);
      act(() => root.render(<div>Gating</div>));
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(renderer.renderStrategyGrid).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
