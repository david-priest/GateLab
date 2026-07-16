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

vi.mock("./loadPlots", () => ({
  loadPlots: () => ({
    CytofD3: plot,
    bus: { on: vi.fn(() => vi.fn()) },
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
});
