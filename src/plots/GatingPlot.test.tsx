// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plot = vi.hoisted(() => ({
  render: vi.fn((_payload: Record<string, unknown>, _mode?: string) => {
    const container = document.getElementById("cytof-plot-container");
    if (!container || container.querySelector("canvas")) return;
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    container.appendChild(canvas);
  }),
  setMode: vi.fn(),
  clear: vi.fn(),
  clearPendingEdit: vi.fn(),
}));

const plotBus = vi.hoisted(() => {
  const listeners: Record<string, ((value: unknown) => void)[]> = {};
  return {
    on: vi.fn((name: string, callback: (value: unknown) => void) => {
      (listeners[name] ||= []).push(callback);
      return () => {
        listeners[name] = (listeners[name] || []).filter((item) => item !== callback);
      };
    }),
    emit(name: string, value: unknown) {
      for (const callback of listeners[name] || []) callback(value);
    },
  };
});

vi.mock("./loadPlots", () => ({
  loadPlots: () => ({
    CytofD3: plot,
    bus: plotBus,
  }),
}));

import { GatingPlot } from "./GatingPlot";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

interface MountedPlot {
  host: HTMLDivElement;
  root: Root;
  setWidth: (width: number) => void;
}

const mounted: MountedPlot[] = [];

function mountPlot(visible = true, initialWidth = 800): MountedPlot {
  let width = initialWidth;
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { configurable: true, get: () => width });
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<GatingPlot payload={{ points: [1] }} visible={visible} />));
  const result = { host, root, setWidth: (next: number) => (width = next) };
  mounted.push(result);
  return result;
}

function flush(milliseconds = 20): void {
  act(() => vi.advanceTimersByTime(milliseconds));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  plot.render.mockClear();
  plot.setMode.mockClear();
  plot.clearPendingEdit.mockClear();
});

afterEach(() => {
  for (const item of mounted.splice(0)) {
    act(() => item.root.unmount());
    item.host.remove();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GatingPlot render lifecycle", () => {
  it("applies configurable typography and repaints when a font size changes", () => {
    const payload = { points: [1] };
    let width = 800;
    const host = document.createElement("div");
    Object.defineProperty(host, "clientWidth", { configurable: true, get: () => width });
    document.body.appendChild(host);
    const root = createRoot(host);
    const item = { host, root, setWidth: (next: number) => (width = next) };
    mounted.push(item);

    act(() => root.render(
      <GatingPlot
        payload={payload}
        fontSizes={{ tick: 10, axis: 13, title: 9, gate: 11 }}
      />,
    ));
    flush();

    const container = host.querySelector<HTMLElement>("#cytof-plot-container")!;
    expect(container.style.getPropertyValue("--gl-gating-font-tick")).toBe("10px");
    expect(container.style.getPropertyValue("--gl-gating-font-axis")).toBe("13px");
    expect(container.style.getPropertyValue("--gl-gating-font-title")).toBe("9px");
    expect(container.style.getPropertyValue("--gl-gating-font-gate")).toBe("11px");

    plot.render.mockClear();
    act(() => root.render(
      <GatingPlot
        payload={payload}
        fontSizes={{ tick: 14, axis: 13, title: 9, gate: 11 }}
      />,
    ));
    flush();
    expect(plot.render).toHaveBeenCalledTimes(1);
    expect(container.style.getPropertyValue("--gl-gating-font-tick")).toBe("14px");
  });

  it("renders when the host is laid out even though the empty plot container has zero width", () => {
    const { host } = mountPlot();

    expect(host.querySelector<HTMLDivElement>("#cytof-plot-container")?.clientWidth).toBe(0);
    flush();

    expect(plot.render).toHaveBeenCalledTimes(1);
    expect(host.querySelector("canvas")).not.toBeNull();
  });

  it("renders when a previously hidden gating tab becomes visible", () => {
    const item = mountPlot(false);
    flush(500);
    expect(plot.render).not.toHaveBeenCalled();

    act(() => item.root.render(<GatingPlot payload={{ points: [1] }} visible />));
    flush();

    expect(plot.render).toHaveBeenCalledTimes(1);
  });

  it("recovers after layout remains unavailable beyond the old four-second retry limit", () => {
    const item = mountPlot(true, 0);
    flush(5_000);
    expect(plot.render).not.toHaveBeenCalled();

    item.setWidth(800);
    flush(200);

    expect(plot.render).toHaveBeenCalledTimes(1);
  });

  it("survives repeated hidden, zero-width, payload, and visible transitions", () => {
    const item = mountPlot();
    flush();
    expect(plot.render).toHaveBeenCalledTimes(1);

    for (let cycle = 1; cycle <= 40; cycle++) {
      item.setWidth(0);
      act(() => item.root.render(
        <GatingPlot payload={{ cycle, points: [cycle] }} visible={false} />,
      ));
      flush(250);

      item.setWidth(800);
      act(() => item.root.render(
        <GatingPlot payload={{ cycle, points: [cycle] }} visible />,
      ));
      flush();
    }

    expect(plot.render).toHaveBeenCalledTimes(41);
    const calls = plot.render.mock.calls;
    const latestPayload = calls[calls.length - 1][0] as {
      cycle: number;
      force_full: boolean;
      _plot_seq: number;
    };
    expect(latestPayload.cycle).toBe(40);
    expect(latestPayload.force_full).toBe(true);
    expect(calls.every(([payload]) => (payload as { force_full?: boolean }).force_full === true)).toBe(true);
    const sequences = calls.map(([payload]) => (payload as { _plot_seq: number })._plot_seq);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(item.host.querySelector("canvas")).not.toBeNull();
  });

  it("cancels a zero-width retry while hidden and resumes with the latest payload", () => {
    const item = mountPlot(true, 0);
    flush(50);
    expect(plot.render).not.toHaveBeenCalled();

    act(() => item.root.render(
      <GatingPlot payload={{ version: "hidden-latest" }} visible={false} />,
    ));
    item.setWidth(800);
    flush(1_000);
    expect(plot.render).not.toHaveBeenCalled();

    act(() => item.root.render(
      <GatingPlot payload={{ version: "visible-latest" }} visible />,
    ));
    flush();
    expect(plot.render).toHaveBeenCalledTimes(1);
    expect(plot.render.mock.calls[0][0]).toMatchObject({ version: "visible-latest" });
  });

  it("keeps dragged geometry pending until the current callback has committed and rendered it", () => {
    const original: [number, number][] = [[1, 1], [3, 1], [2, 3]];
    const moved: [number, number][] = [[5, 4], [7, 4], [6, 6]];
    const staleCallback = vi.fn();
    const currentCallback = vi.fn();
    const item = mountPlot();

    act(() => item.root.render(
      <GatingPlot
        payload={{ points: [1], gates: [{ gate_id: "gate-1", vertices: original }] }}
        onGateEdit={staleCallback}
      />,
    ));
    flush();

    // Callback props change as App state / the active sample changes. The bus subscription
    // must call the current callback rather than the closure captured when the plot mounted.
    act(() => item.root.render(
      <GatingPlot
        payload={{ points: [1], gates: [{ gate_id: "gate-1", vertices: original }] }}
        onGateEdit={currentCallback}
      />,
    ));

    act(() => plotBus.emit("gate_edit", {
      gate_id: "gate-1",
      vertices: moved,
      seq: 42,
    }));

    expect(staleCallback).not.toHaveBeenCalled();
    expect(currentCallback).toHaveBeenCalledWith(expect.objectContaining({
      gate_id: "gate-1",
      vertices: moved,
    }));
    // Releasing here lets cytof_plot.js flush a queued render containing the old gate.
    expect(plot.clearPendingEdit).not.toHaveBeenCalled();

    act(() => item.root.render(
      <GatingPlot
        payload={{ points: [1], gates: [{ gate_id: "gate-1", vertices: original }] }}
        onGateEdit={currentCallback}
      />,
    ));
    flush();
    expect(plot.clearPendingEdit).not.toHaveBeenCalled();

    act(() => item.root.render(
      <GatingPlot
        payload={{ points: [1], gates: [{ gate_id: "gate-1", vertices: moved }] }}
        onGateEdit={currentCallback}
      />,
    ));
    flush();

    expect(plot.clearPendingEdit).toHaveBeenCalledTimes(1);
    expect(plot.clearPendingEdit).toHaveBeenCalledWith("gate-1", 42);
    expect(plot.clearPendingEdit.mock.invocationCallOrder[0]).toBeLessThan(
      plot.render.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("routes an axis-picker update through the latest sample callback", () => {
    const item = mountPlot();
    const previousSampleCallback = vi.fn();
    const activeSampleCallback = vi.fn();

    act(() => item.root.render(
      <GatingPlot payload={{ points: [1] }} onAxisLabelClick={previousSampleCallback} />,
    ));
    act(() => item.root.render(
      <GatingPlot payload={{ points: [1] }} onAxisLabelClick={activeSampleCallback} />,
    ));
    act(() => plotBus.emit("axis_label_click", { axis: "x", selected: "CD19" }));

    expect(previousSampleCallback).not.toHaveBeenCalled();
    expect(activeSampleCallback).toHaveBeenCalledWith({ axis: "x", selected: "CD19" });
  });

  it("routes a quadrant drag through the latest workspace callback", () => {
    const item = mountPlot();
    const callbackFromEmptyWorkspace = vi.fn();
    const callbackFromLoadedWorkspace = vi.fn();

    act(() => item.root.render(
      <GatingPlot
        payload={{ points: [1], gates: [] }}
        onQuadrantMove={callbackFromEmptyWorkspace}
      />,
    ));
    act(() => item.root.render(
      <GatingPlot
        payload={{ points: [1], gates: [{ gate_id: "quadrant-1", center: [2, 3] }] }}
        onQuadrantMove={callbackFromLoadedWorkspace}
      />,
    ));
    act(() => plotBus.emit("gate_quadrant_move", {
      gate_id: "quadrant-1",
      center: [5, 7],
    }));

    expect(callbackFromEmptyWorkspace).not.toHaveBeenCalled();
    expect(callbackFromLoadedWorkspace).toHaveBeenCalledWith({
      gate_id: "quadrant-1",
      center: [5, 7],
    });
  });
});
