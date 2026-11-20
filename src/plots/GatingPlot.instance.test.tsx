// @vitest-environment jsdom
// A gating plot that is one of several: it draws with the engine of its own instance, into that
// instance's container, and a plot that is only looked at takes no keys.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const engines = vi.hoisted(() => {
  const make = () => ({
    render: vi.fn(() => true),
    setMode: vi.fn(),
    clear: vi.fn(),
    clearPendingEdit: vi.fn(),
    cancelPolygonDraft: vi.fn(() => true),
    undoPolygonVertex: vi.fn(() => true),
  });
  const bus = () => ({ send: vi.fn(), has: vi.fn(() => true), on: vi.fn(() => () => undefined) });
  return { first: make(), third: make(), firstBus: bus(), thirdBus: bus() };
});

vi.mock("./loadPlots", () => ({
  loadPlots: () => ({ CytofD3: engines.first, bus: engines.firstBus }),
  loadPlotInstance: (instance: number) => {
    if (instance !== 2) throw new Error(`unexpected instance ${instance}`);
    return { CytofD3: engines.third, bus: engines.thirdBus };
  },
  plotContainerId: (instance: number) => `cytof-plot-container-${instance + 1}`,
}));

import { GatingPlot } from "./GatingPlot";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
  host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { configurable: true, get: () => 800 });
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

const flush = () => act(() => vi.advanceTimersByTime(20));
const press = (key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => { document.body.dispatchEvent(event); });
  return event;
};

describe("a gating plot that is one of several", () => {
  it("draws with its own instance's engine, in its own container", () => {
    act(() => root.render(<GatingPlot instance={2} payload={{ points: [1] }} />));
    flush();
    expect(host.querySelector("#cytof-plot-container-3")).not.toBeNull();
    expect(host.querySelector("#cytof-plot-container")).toBeNull();
    expect(engines.third.render).toHaveBeenCalledTimes(1);
    expect(engines.first.render).not.toHaveBeenCalled();
    expect(engines.thirdBus.on).toHaveBeenCalled();
    expect(engines.firstBus.on).not.toHaveBeenCalled();
  });

  it("is the first plot, in the container the renderer has always used, when no instance is given", () => {
    act(() => root.render(<GatingPlot payload={{ points: [1] }} />));
    flush();
    expect(host.querySelector("#cytof-plot-container")).not.toBeNull();
    expect(engines.first.render).toHaveBeenCalledTimes(1);
    expect(engines.third.render).not.toHaveBeenCalled();
  });

  it("takes Escape and Backspace when it is worked on, and neither when it is only looked at", () => {
    act(() => root.render(<GatingPlot instance={2} payload={{ points: [1] }} />));
    flush();
    expect(press("Escape").defaultPrevented).toBe(true);
    expect(engines.third.cancelPolygonDraft).toHaveBeenCalledTimes(1);

    act(() => root.render(<GatingPlot instance={2} passive payload={{ points: [1] }} />));
    flush();
    expect(press("Escape").defaultPrevented).toBe(false);
    expect(press("Backspace").defaultPrevented).toBe(false);
    expect(engines.third.cancelPolygonDraft).toHaveBeenCalledTimes(1);
    expect(engines.third.undoPolygonVertex).not.toHaveBeenCalled();
  });
});
