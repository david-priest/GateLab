// @vitest-environment jsdom
// The gate line width, the selected gate's extra pixel and the labels of gates without colour, as the
// renderer draws them: the patched cytof renderer is run in jsdom with a canvas context that draws
// nothing, and the strokes and fills are read off the SVG.
// Synthetic gates g1 to g4 on channels A and B.

import { beforeAll, describe, expect, it } from "vitest";
import { loadPlots } from "./loadPlots";

type Api = ReturnType<typeof loadPlots>["CytofD3"];
let api: Api;

beforeAll(() => {
  // jsdom has no canvas; the points are not what this test reads.
  const noop = new Proxy({}, { get: (_t, key) => (key === "getImageData" || key === "createImageData" ? () => ({ data: new Uint8ClampedArray(4) }) : key === "measureText" ? () => ({ width: 10 }) : () => undefined) });
  HTMLCanvasElement.prototype.getContext = (() => noop) as never;
  // Nor SVG layout: labels measure as a small box.
  const proto = SVGElement.prototype as unknown as Record<string, unknown>;
  proto.getBBox = () => ({ x: 0, y: 0, width: 20, height: 10 });
  proto.getComputedTextLength = () => 20;
  const container = document.createElement("div");
  container.id = "cytof-plot-container";
  Object.defineProperty(container, "clientWidth", { value: 400 });
  Object.defineProperty(container, "clientHeight", { value: 400 });
  document.body.appendChild(container);
  api = loadPlots().CytofD3;
});

const b64 = (values: number[]) => {
  const bytes = new Uint8Array(Float32Array.from(values).buffer);
  return btoa(String.fromCharCode(...bytes));
};
const gate = (id: string, type: string, extra: Record<string, unknown>) => ({
  gate_id: id, name: id, gate_type: type, x_channel: "A", y_channel: "B", color: "#e41a1c", ...extra,
});
function payload(width: number | undefined, selected: string | null, gateStyle?: Record<string, unknown>) {
  return {
    x_b64: b64([10, 50, 90]), y_b64: b64([10, 50, 90]), n_events: 3,
    x_label: "A", y_label: "B", x_range: [0, 100], y_range: [0, 100], channels: ["A", "B"],
    display_mode: "dots", point_alpha: 1, point_size: 1, selected_gate_id: selected,
    ...(width === undefined ? {} : { gate_line_width: width }),
    ...(gateStyle ? { gate_style: gateStyle } : {}),
    gates: [
      gate("g1", "polygon", { vertices: [[10, 10], [40, 10], [40, 40]] }),
      gate("g2", "rectangle", { vertices: [[50, 50], [70, 50], [70, 70], [50, 70]] }),
      gate("g3", "quadrant", { center: [30, 30], quadrant_pcts: [10, 20, 30, 40] }),
    ],
    gate_references: [gate("g4", "polygon", { vertices: [[60, 10], [90, 10], [90, 40]] })],
  };
}
/** The stroke widths of the visible outlines, by kind. */
function widths() {
  const svg = document.querySelector("#cytof-plot-container svg")!;
  const visible = (els: Element[]) => els.filter((el) => el.getAttribute("stroke") !== "rgba(0,0,0,0)")
    .map((el) => el.getAttribute("stroke-width"));
  return {
    quadrant: visible([...svg.querySelectorAll(".quadrant-gate .q-vline, .quadrant-gate .q-hline")]),
    reference: visible([...svg.querySelectorAll(".gate-reference path")]),
    outlines: [...svg.querySelectorAll(".saved-gate:not(.quadrant-gate)")].map((g) =>
      visible([...g.querySelectorAll("path, polygon, rect, ellipse")]).filter((w) => w !== null)),
  };
}

describe("gate line width", () => {
  it("draws every kind at the renderer's 1.5 without a width", () => {
    expect(api.render(payload(undefined, null), "navigate")).toBe(true);
    const w = widths();
    expect(w.quadrant).toEqual(["1.5", "1.5"]);
    expect(w.reference).toEqual(["1.5"]);
    expect(w.outlines.flat().every((x) => x === "1.5")).toBe(true);
    expect(w.outlines.flat().length).toBeGreaterThanOrEqual(2);
  });

  it("draws every kind at the payload's width, quadrant lines and dashed versions included", () => {
    api.render(payload(3, null), "navigate");
    let w = widths();
    expect(w.quadrant).toEqual(["3", "3"]);
    expect(w.reference).toEqual(["3"]);
    expect(w.outlines.flat().every((x) => x === "3")).toBe(true);
    api.render(payload(0.5, null), "navigate");
    w = widths();
    expect(w.quadrant).toEqual(["0.5", "0.5"]);
    expect(w.outlines.flat().every((x) => x === "0.5")).toBe(true);
  });

  it("draws a selected gate 1 px thicker, with nothing under it", () => {
    api.render(payload(2, "g3"), "navigate");
    let w = widths();
    expect(w.quadrant).toEqual(["3", "3"]);
    expect(w.outlines.flat().every((x) => x === "2")).toBe(true);
    expect(w.reference).toEqual(["2"]);
    api.render(payload(2, "g1"), "navigate");
    w = widths();
    expect(w.quadrant).toEqual(["2", "2"]);
    // The polygon at 3, the rectangle at 2.
    expect(w.outlines.flat().sort()).toEqual(["2", "3"]);
    expect(document.querySelectorAll(".gate-halo")).toHaveLength(0);
  });

  it("draws a label as black text on a white backing of the asked opacity when gates have no colour", () => {
    const label = () => {
      const g = document.querySelector(".gate-label")!;
      const rect = g.querySelector("rect")!, text = g.querySelector("text")!;
      return { fill: rect.getAttribute("fill"), opacity: rect.getAttribute("fill-opacity"), text: text.getAttribute("fill") };
    };
    api.render(payload(1.5, null), "navigate");
    expect(label()).toEqual({ fill: "#e41a1c", opacity: "0.85", text: "white" });
    api.render(payload(1.5, null, { pub_style: true, label_background: 0.5 }), "navigate");
    expect(label()).toEqual({ fill: "#ffffff", opacity: "0.5", text: "#000000" });
    api.render(payload(1.5, null, { pub_style: true, label_background: 0 }), "navigate");
    expect(label().opacity).toBe("0");
    const quadrantBacking = [...document.querySelectorAll(".quadrant-label rect")].map((r) => r.getAttribute("fill-opacity"));
    expect(quadrantBacking.length).toBeGreaterThan(0);
    expect(quadrantBacking.every((o) => o === "0")).toBe(true);
  });
});
