// @vitest-environment jsdom
// The Plotting chart's corner grip: a drag re-lays the chart out at a new panel width and plot
// height, shown live and kept on release as one change; Escape cancels; double-click fits the
// panels to their contents. Synthetic files D1 and D2 (control, treated); nothing here is a real
// experiment.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HIERARCHY_ID } from "../engine/hierarchies";
import { newGate, newGateRef, newPopulation, newRootPopulation } from "../engine/models";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { initialCoreState, recompute, type CoreState } from "../store";
import { I18nProvider } from "./i18n";
import { PlottingTab } from "./PlottingTab";
import { clearPersistedTabState, savedPlottingState } from "./tabState";
import { resizedChart } from "./chart/ChartResizeHandle";
import { PlottingChartsTab } from "./PlottingCharts";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearPersistedTabState();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  const small = { ...newGate("Small", "rectangle", "FSC-A", "SSC-A", [[0, 0], [25, 1000]]), space: "raw" as const };
  const smallPop = newPopulation("CD4_positive", [newGateRef(small.gate_id)], rootPop.population_id);
  rootPop.children = [smallPop.population_id];
  Object.assign(state, {
    gates: { [small.gate_id]: small },
    gate_order: [small.gate_id],
    populations: { [rootPop.population_id]: rootPop, [smallPop.population_id]: smallPop },
    root_population_id: rootPop.population_id,
    active_population_id: rootPop.population_id,
  });
  const file = (id: string, fsc: number[]) => {
    const fcs: FcsFile = {
      version: "FCS3.1",
      nEvents: fsc.length,
      instrument: "flow",
      keywords: {},
      spillover: null,
      channels: [
        { index: 0, name: "SSC-A", marker: null, bits: 32, range: 262144 },
        { index: 1, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      ],
      columns: [Float32Array.from(fsc.map(() => 100)), Float32Array.from(fsc)],
    };
    return { id, name: `${id}.fcs`, hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) };
  };
  return { state: state as CoreState, samples: [file("D1", [10, 20, 30]), file("D2", [15, 18, 35])] };
}

function mount(fx: ReturnType<typeof fixture>, callbacks: Record<string, unknown>) {
  act(() =>
    root.render(
      <I18nProvider>
        <PlottingTab
          samples={fx.samples}
          activeSampleId="D1"
          state={fx.state}
          derived={recompute(fx.samples[0].sample, fx.state)}
          metadata={{ D1: { condition: "control" }, D2: { condition: "treated" } }}
          metadataColumns={[{ name: "condition" }]}
          divisionProfiles={{}}
          dataRevisionKey="r1"
          {...callbacks}
        />
      </I18nProvider>,
    ),
  );
}

const handle = () => host.querySelector<HTMLDivElement>(".gl-prop-chart-resize")!;
const panelWidths = () => [...host.querySelectorAll("svg.gl-prop-panel")].map((svg) => Number(svg.getAttribute("width")));
const pointer = (type: string, x: number, y: number, target: EventTarget = window) =>
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
  });
function perCell() {
  act(() => [...host.querySelectorAll<HTMLInputElement>('input[name="prop-value"]')][1].click());
}

describe("Plotting: the chart's corner grip", () => {
  it("shares a drag over the panels in a row and the rows, within the fields' bounds", () => {
    expect(resizedChart({ panelWidth: 200, height: 280, columns: 2, rows: 1 }, 100, 60)).toEqual({ panelWidth: 250, height: 340 });
    expect(resizedChart({ panelWidth: 200, height: 280, columns: 1, rows: 2 }, 0, 60)).toEqual({ panelWidth: 200, height: 310 });
    expect(resizedChart({ panelWidth: 200, height: 280, columns: 1, rows: 1 }, -500, -500)).toEqual({ panelWidth: 120, height: 140 });
    expect(resizedChart({ panelWidth: 700, height: 700, columns: 1, rows: 1 }, 500, 500)).toEqual({ panelWidth: 800, height: 800 });
  });

  it("redraws the panels while dragging and keeps the size on release; Escape puts it back", () => {
    mount(fixture(), {});
    perCell();
    // Two panels, a row of them (jsdom places every panel at the top).
    const before = panelWidths();
    expect(before).toHaveLength(2);
    const height = savedPlottingState()["prop.height"] as number;
    expect(savedPlottingState()["prop.panelWidth"]).toBe(0);
    const widest = Math.max(...before);
    pointer("pointerdown", 500, 400, handle());
    pointer("pointermove", 600, 460);
    // Drawn at the new width while dragging, not yet kept.
    expect(panelWidths().every((width) => width === widest + 50)).toBe(true);
    expect(host.querySelector(".gl-prop-chart-resize-size")?.textContent).toBe(`Panel width ${widest + 50} px, plot height ${height + 60} px`);
    expect(savedPlottingState()["prop.panelWidth"]).toBe(0);
    pointer("pointerup", 600, 460);
    expect(savedPlottingState()["prop.panelWidth"]).toBe(widest + 50);
    expect(savedPlottingState()["prop.height"]).toBe(height + 60);
    expect(host.querySelector(".gl-prop-chart-resize-size")).toBeNull();
    // Escape during a drag leaves the size as it was.
    pointer("pointerdown", 500, 400, handle());
    pointer("pointermove", 700, 400);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    pointer("pointerup", 700, 400);
    expect(savedPlottingState()["prop.panelWidth"]).toBe(widest + 50);
    expect(panelWidths().every((width) => width === widest + 50)).toBe(true);
    // Double-click fits the panels to their contents again.
    act(() => { handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(savedPlottingState()["prop.panelWidth"]).toBe(0);
    expect(panelWidths()).toEqual(before);
  });

  it("makes one undo step of a drag, however far the pointer moved", () => {
    const fx = fixture();
    act(() =>
      root.render(
        <I18nProvider>
          <PlottingChartsTab
            samples={fx.samples}
            activeSampleId="D1"
            state={fx.state}
            derived={recompute(fx.samples[0].sample, fx.state)}
            metadata={{ D1: { condition: "control" }, D2: { condition: "treated" } }}
            metadataColumns={[{ name: "condition" }]}
            divisionProfiles={{}}
            dataRevisionKey="r1"
          />
        </I18nProvider>,
      ),
    );
    perCell();
    pointer("pointerdown", 500, 400, handle());
    for (let x = 510; x <= 600; x += 10) pointer("pointermove", x, 400 + (x - 500) / 2);
    pointer("pointerup", 600, 450);
    expect(savedPlottingState()["prop.panelWidth"]).not.toBe(0);
    const undo = () => act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Undo")!.click());
    // One Undo takes the whole drag back, the per-cell chart staying; the next takes the chart kind back.
    undo();
    expect(savedPlottingState()["prop.panelWidth"]).toBe(0);
    expect(savedPlottingState()["prop.valueKind"]).toBe("cells");
    undo();
    expect(savedPlottingState()["prop.valueKind"]).toBe("proportion");
  });
});
