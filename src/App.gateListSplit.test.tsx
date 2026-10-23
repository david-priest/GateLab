// @vitest-environment jsdom
// The divider between the gate list and the population tree: dragging it sets the gate list's
// height, the tree keeps 200 px, the height is remembered per viewer, and a double-click returns
// it to 200 px. Nothing is loaded; the side pane is drawn empty.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => null,
}));
import App from "./App";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try { localStorage.removeItem("gatelab.gateListHeight"); } catch { /* none */ }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** jsdom lays nothing out, so each panel is given its height. */
function sized(selector: string, height: number): void {
  const el = host.querySelector<HTMLElement>(selector)!;
  el.getBoundingClientRect = () => ({ height, width: 300, top: 0, left: 0, right: 300, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}
const listHeight = () => host.querySelector<HTMLElement>(".gl-side")!.style.getPropertyValue("--gl-gate-list-height");
function drag(fromY: number, toY: number): void {
  const split = host.querySelector<HTMLElement>(".gl-side-split")!;
  act(() => { split.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: fromY })); });
  act(() => { window.dispatchEvent(new MouseEvent("mousemove", { clientY: toY })); });
  act(() => { window.dispatchEvent(new MouseEvent("mouseup", { clientY: toY })); });
}

describe("gate list height divider", () => {
  it("drags the gate list taller and shorter, within bounds, and remembers it", () => {
    act(() => root.render(<App />));
    expect(listHeight()).toBe("200px");
    sized(".gate-list-panel", 200);
    sized(".population-tree-panel", 400);
    drag(300, 360);
    expect(listHeight()).toBe("260px");
    expect(localStorage.getItem("gatelab.gateListHeight")).toBe("260");
    expect(document.body.classList.contains("gl-row-resizing")).toBe(false);
    // The tree keeps 200 px: 200 + (400 − 200) is the most the list can take.
    drag(300, 900);
    expect(listHeight()).toBe("400px");
    drag(300, -900);
    expect(listHeight()).toBe("80px");
    act(() => { host.querySelector(".gl-side-split")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(listHeight()).toBe("200px");
  });

  it("opens at the remembered height", () => {
    localStorage.setItem("gatelab.gateListHeight", "320");
    act(() => root.render(<App />));
    expect(listHeight()).toBe("320px");
  });
});
