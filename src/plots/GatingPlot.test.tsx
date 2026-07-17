// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plot = vi.hoisted(() => ({
  render: vi.fn((_payload: Record<string, unknown>, _mode?: string): boolean => {
    const container = document.getElementById("cytof-plot-container");
    if (!container || container.querySelector("canvas")) return true;
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    container.appendChild(canvas);
    return true;
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
  plot.clear.mockClear();
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

  it("rejects events from the previously painted interaction context until the new token is painted", () => {
    const item = mountPlot();
    const payload = { points: [1] };
    const onNewGate = vi.fn();
    const onGateEdit = vi.fn();
    const onQuadrantMove = vi.fn();
    const onGateSelect = vi.fn();
    const onAxisLabelClick = vi.fn();
    const onGateLabelMove = vi.fn();
    const renderWithToken = (interactionToken: string) => (
      <GatingPlot
        payload={payload}
        interactionToken={interactionToken}
        onNewGate={onNewGate}
        onGateEdit={onGateEdit}
        onQuadrantMove={onQuadrantMove}
        onGateSelect={onGateSelect}
        onAxisLabelClick={onAxisLabelClick}
        onGateLabelMove={onGateLabelMove}
      />
    );
    const newGate = {
      gate_type: "rectangle",
      vertices: [[1, 1], [3, 3]],
      x_channel: "X",
      y_channel: "Y",
    };
    const gateEdit = {
      gate_id: "gate-1",
      vertices: [[5, 4], [7, 6]],
      seq: 91,
    };

    act(() => item.root.render(renderWithToken("sample-a:revision-1")));
    act(() => plotBus.emit("new_gate", newGate));
    expect(onNewGate).not.toHaveBeenCalled();
    flush();
    expect(plot.render).toHaveBeenCalled();
    plot.render.mockClear();
    plot.clearPendingEdit.mockClear();

    // React now describes context B, but the rAF paint has not run: the canvas still shows A.
    // Keeping the payload object stable also proves that the token itself schedules the repaint.
    act(() => item.root.render(renderWithToken("sample-b:revision-2")));
    act(() => {
      plotBus.emit("new_gate", newGate);
      plotBus.emit("gate_edit", gateEdit);
      plotBus.emit("gate_quadrant_move", { gate_id: "quadrant-1", center: [8, 9] });
      plotBus.emit("gate_select", "gate-1");
      plotBus.emit("axis_label_click", { axis: "x", selected: "CD19" });
      plotBus.emit("gate_label_move", { gate_id: "gate-1", label_offset: [4, 5] });
    });

    expect(onNewGate).not.toHaveBeenCalled();
    expect(onGateEdit).not.toHaveBeenCalled();
    expect(onQuadrantMove).not.toHaveBeenCalled();
    expect(onGateSelect).not.toHaveBeenCalled();
    expect(onAxisLabelClick).not.toHaveBeenCalled();
    expect(onGateLabelMove).not.toHaveBeenCalled();
    expect(plot.clearPendingEdit).toHaveBeenCalledTimes(1);
    expect(plot.clearPendingEdit).toHaveBeenCalledWith("gate-1", 91);
    expect(plot.render).not.toHaveBeenCalled();

    flush();
    expect(plot.render).toHaveBeenCalledTimes(1);

    act(() => {
      plotBus.emit("new_gate", newGate);
      plotBus.emit("gate_edit", gateEdit);
      plotBus.emit("gate_quadrant_move", { gate_id: "quadrant-1", center: [8, 9] });
      plotBus.emit("gate_select", "gate-1");
      plotBus.emit("axis_label_click", { axis: "x", selected: "CD19" });
      plotBus.emit("gate_label_move", { gate_id: "gate-1", label_offset: [4, 5] });
    });

    expect(onNewGate).toHaveBeenCalledTimes(1);
    expect(onGateEdit).toHaveBeenCalledTimes(1);
    expect(onQuadrantMove).toHaveBeenCalledTimes(1);
    expect(onGateSelect).toHaveBeenCalledTimes(1);
    expect(onAxisLabelClick).toHaveBeenCalledTimes(1);
    expect(onGateLabelMove).toHaveBeenCalledTimes(1);
    expect(plot.clearPendingEdit).toHaveBeenCalledTimes(1);
  });

  it("does not mark a deferred render as the painted interaction context", () => {
    const item = mountPlot();
    const payload = { points: [1] };
    const onNewGate = vi.fn();
    const renderWithToken = (interactionToken: string) => (
      <GatingPlot
        payload={payload}
        interactionToken={interactionToken}
        onNewGate={onNewGate}
      />
    );
    const newGate = {
      gate_type: "rectangle" as const,
      vertices: [[1, 1], [3, 3]] as [number, number][],
      x_channel: "X",
      y_channel: "Y",
    };

    act(() => item.root.render(renderWithToken("sample-a")));
    flush();
    plot.render.mockClear();

    // Mirrors cytof_plot.js returning without painting because a D3 drag is active.
    plot.render.mockImplementationOnce(() => false);
    act(() => item.root.render(renderWithToken("sample-b")));
    flush();
    expect(plot.render).toHaveBeenCalledTimes(1);

    act(() => plotBus.emit("new_gate", newGate));
    expect(onNewGate).not.toHaveBeenCalled();

    // The wrapper retries; only the successful paint opens the new interaction context.
    flush(120);
    expect(plot.render).toHaveBeenCalledTimes(2);
    act(() => plotBus.emit("new_gate", newGate));
    expect(onNewGate).toHaveBeenCalledTimes(1);
  });

  it("clears a pending gate edit before painting a different interaction context", () => {
    const item = mountPlot();
    const original: [number, number][] = [[1, 1], [3, 1], [2, 3]];
    const moved: [number, number][] = [[5, 4], [7, 4], [6, 6]];
    const onGateEdit = vi.fn();
    const renderContext = (interactionToken: string, vertices: [number, number][]) => (
      <GatingPlot
        payload={{ points: [1], gates: [{ gate_id: "gate-1", vertices }] }}
        interactionToken={interactionToken}
        onGateEdit={onGateEdit}
      />
    );

    act(() => item.root.render(renderContext("sample-a:original", original)));
    flush();
    plot.render.mockClear();
    plot.clearPendingEdit.mockClear();

    act(() => plotBus.emit("gate_edit", {
      gate_id: "gate-1",
      vertices: moved,
      seq: 108,
    }));
    expect(onGateEdit).toHaveBeenCalledTimes(1);
    expect(plot.clearPendingEdit).not.toHaveBeenCalled();

    // Context B reuses the gate id but its payload cannot acknowledge A-space vertices.
    act(() => item.root.render(renderContext("sample-b:compensated", original)));
    flush();

    expect(plot.clearPendingEdit).toHaveBeenCalledTimes(1);
    expect(plot.clearPendingEdit).toHaveBeenCalledWith("gate-1", 108);
    expect(plot.clearPendingEdit.mock.invocationCallOrder[0]).toBeLessThan(
      plot.render.mock.invocationCallOrder[0],
    );
  });

  it("clears singleton renderer state when unmounted with a pending gate edit", () => {
    const item = mountPlot();
    const vertices: [number, number][] = [[1, 1], [3, 1], [2, 3]];
    act(() => item.root.render(
      <GatingPlot
        payload={{ gates: [{ gate_id: "gate-1", vertices }] }}
        interactionToken="workspace-a"
        onGateEdit={() => undefined}
      />,
    ));
    flush();
    plot.clear.mockClear();

    act(() => plotBus.emit("gate_edit", {
      gate_id: "gate-1",
      vertices: [[5, 4], [7, 4], [6, 6]],
      seq: 109,
    }));
    act(() => item.root.render(<></>));

    expect(plot.clear).toHaveBeenCalledTimes(1);
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
