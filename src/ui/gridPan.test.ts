// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { attachGridPan } from "./gridPan";

function grid() {
  document.body.innerHTML = `
    <div id="g">
      <div class="mini-plot-cell" data-plot-key="a"><canvas></canvas><svg><g class="x-axis"><path class="domain"></path></g><g class="y-axis"><path class="domain"></path></g><g data-gate-id="g1"></g></svg></div>
    </div>`;
  const container = document.getElementById("g") as HTMLElement;
  const cell = container.querySelector<HTMLElement>(".mini-plot-cell")!;
  cell.getBoundingClientRect = () => new DOMRect(100, 100, 200, 200);
  // The axes' domains place the plot's data area at (150, 120) … (290, 260) in client pixels.
  (cell.querySelector(".x-axis .domain") as SVGElement).getBoundingClientRect = () => new DOMRect(150, 260, 140, 1);
  (cell.querySelector(".y-axis .domain") as SVGElement).getBoundingClientRect = () => new DOMRect(150, 120, 1, 140);
  return { container, cell, canvas: cell.querySelector("canvas") as HTMLCanvasElement };
}

const mouse = (target: EventTarget, type: string, x: number, y: number, extra: MouseEventInit = {}) =>
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: type === "mouseup" ? 0 : 1, ...extra }));

describe("attachGridPan", () => {
  it("pans a panel: the data layer follows the pointer, and the ranges moved by the drag are committed on release", () => {
    const { container, canvas } = grid();
    const commit = vi.fn();
    const detach = attachGridPan(container, () => ({ xKey: "FSC-A", yKey: "SSC-A", xr: [0, 140], yr: [0, 140] }), commit);
    mouse(canvas, "mousedown", 220, 190);
    mouse(window, "mousemove", 250, 190); // 30 px right over a 140 px plot of 140 units: 30 units
    expect(canvas.style.transform).toContain("translate(30px, 0px)");
    mouse(window, "mouseup", 250, 190);
    expect(canvas.style.transform).toBe("");
    expect(commit).toHaveBeenCalledTimes(1);
    const [panel, xr, yr] = commit.mock.calls[0];
    expect(panel.xKey).toBe("FSC-A");
    expect(xr[0]).toBeCloseTo(-30, 6);
    expect(xr[1]).toBeCloseTo(110, 6);
    expect(yr).toEqual([0, 140]);
    detach();
  });

  it("leaves a gate label's drag, a panel it cannot name, and a press that did not move alone", () => {
    const { container, cell, canvas } = grid();
    const commit = vi.fn();
    attachGridPan(container, (c) => (c.getAttribute("data-plot-key") === "a" ? { xKey: "x", yKey: "y", xr: [0, 1], yr: [0, 1] } : null), commit);
    mouse(cell.querySelector("[data-gate-id]")!, "mousedown", 200, 150);
    mouse(window, "mousemove", 230, 150);
    mouse(window, "mouseup", 230, 150);
    expect(commit).not.toHaveBeenCalled();
    mouse(canvas, "mousedown", 200, 150);
    mouse(window, "mouseup", 200, 150);
    expect(commit).not.toHaveBeenCalled();
    cell.setAttribute("data-plot-key", "other");
    mouse(canvas, "mousedown", 200, 150);
    mouse(window, "mousemove", 240, 150);
    mouse(window, "mouseup", 240, 150);
    expect(commit).not.toHaveBeenCalled();
  });
});
