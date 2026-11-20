// @vitest-environment jsdom
// More than one gating plot on the page: each further plot is the patched renderer evaluated
// again, with its own container, clip paths, state and bus. Run in jsdom with a canvas context
// that draws nothing; what is read is the SVG each instance builds.
// Synthetic gates g1 and g2 on channels A and B.

import { beforeAll, describe, expect, it } from "vitest";
import { gatingPlotInstanceSource, loadPlotInstance, loadPlots, plotContainerId } from "./loadPlots";

beforeAll(() => {
  const noop = new Proxy({}, { get: (_t, key) => (key === "getImageData" || key === "createImageData" ? () => ({ data: new Uint8ClampedArray(4) }) : key === "measureText" ? () => ({ width: 1 }) : () => undefined) });
  HTMLCanvasElement.prototype.getContext = (() => noop) as never;
  const proto = SVGElement.prototype as unknown as Record<string, unknown>;
  proto.getBBox = () => ({ x: 0, y: 0, width: 20, height: 10 });
  proto.getComputedTextLength = () => 20;
  for (const instance of [0, 1, 2]) {
    const container = document.createElement("div");
    container.id = plotContainerId(instance);
    Object.defineProperty(container, "clientWidth", { value: 400 });
    Object.defineProperty(container, "clientHeight", { value: 400 });
    document.body.appendChild(container);
  }
});

const b64 = (values: number[]) => btoa(String.fromCharCode(...new Uint8Array(Float32Array.from(values).buffer)));
const rectangle = (id: string) => ({
  gate_id: id, name: id, gate_type: "rectangle", x_channel: "A", y_channel: "B", color: "#e41a1c",
  vertices: [[50, 50], [70, 50], [70, 70], [50, 70]],
});
const payload = (gateIds: string[]) => ({
  x_b64: b64([10, 50, 90]), y_b64: b64([10, 50, 90]), n_events: 3,
  x_label: "A", y_label: "B", x_range: [0, 100], y_range: [0, 100], channels: ["A", "B"],
  display_mode: "dots", point_alpha: 1, point_size: 1, selected_gate_id: null,
  gates: gateIds.map(rectangle), gate_references: [],
});
const savedGates = (instance: number) =>
  document.querySelectorAll(`#${plotContainerId(instance)} svg .saved-gate`).length;

describe("the container of each plot", () => {
  it("is the id the renderer has always drawn into for the first, and numbered for the rest", () => {
    expect(plotContainerId(0)).toBe("cytof-plot-container");
    expect(plotContainerId(1)).toBe("cytof-plot-container-2");
    expect(plotContainerId(3)).toBe("cytof-plot-container-4");
  });
});

describe("the script of a further plot", () => {
  it("draws into its own container, with clip paths and an api of its own", () => {
    const source = gatingPlotInstanceSource(
      "const CTNR = 'cytof-plot-container'; attr('id', 'cytof-clip-xaxis'); url(#cytof-clip); window.CytofD3 = {};", 2);
    expect(source).toContain('"cytof-plot-container-3"');
    expect(source).toContain("cytof-clip-i3-xaxis");
    expect(source).toContain("url(#cytof-clip-i3)");
    expect(source).toContain("__gatelabPlot.CytofD3 = {}");
    expect(source).not.toContain("window.CytofD3");
  });

  it("refuses a script it cannot make a second plot from", () => {
    expect(() => gatingPlotInstanceSource("window.CytofD3 = {};", 1)).toThrow(/second plot/);
  });
});

describe("two gating plots on one page", () => {
  it("gives the first plot the engine it has always had, and each further plot one of its own, once", () => {
    const first = loadPlotInstance(0);
    expect(first).toBe(loadPlots());
    const second = loadPlotInstance(1);
    expect(second.CytofD3).not.toBe(first.CytofD3);
    expect(second.bus).not.toBe(first.bus);
    expect(loadPlotInstance(1)).toBe(second);
    expect(loadPlotInstance(2).CytofD3).not.toBe(second.CytofD3);
    // The page's api is still the first plot's.
    expect((window as unknown as { CytofD3: unknown }).CytofD3).toBe(first.CytofD3);
  });

  it("draws each in its own container from its own payload", () => {
    const first = loadPlotInstance(0).CytofD3;
    const second = loadPlotInstance(1).CytofD3;
    expect(first.render(payload(["g1"]), "navigate")).toBe(true);
    expect(second.render(payload(["g1", "g2"]), "navigate")).toBe(true);
    expect(savedGates(0)).toBe(1);
    expect(savedGates(1)).toBe(2);
    // A redraw of one leaves the other as it was.
    first.render(payload([]), "navigate");
    expect(savedGates(0)).toBe(0);
    expect(savedGates(1)).toBe(2);
    second.clear();
    first.render(payload(["g1"]), "navigate");
    expect(savedGates(0)).toBe(1);
  });

  it("clips each plot by its own rectangle", () => {
    loadPlotInstance(0).CytofD3.render(payload(["g1"]), "navigate");
    loadPlotInstance(1).CytofD3.render(payload(["g1"]), "navigate");
    const ids = (instance: number) =>
      [...document.querySelectorAll(`#${plotContainerId(instance)} svg clipPath`)].map((node) => node.id).sort();
    expect(ids(0)).toEqual(["cytof-clip", "cytof-clip-xaxis", "cytof-clip-yaxis"]);
    expect(ids(1)).toEqual(["cytof-clip-i2", "cytof-clip-i2-xaxis", "cytof-clip-i2-yaxis"]);
    expect(document.querySelectorAll("#cytof-clip")).toHaveLength(1);
  });

  it("reports a plot's events on that plot's bus alone", () => {
    const first = loadPlotInstance(0);
    const second = loadPlotInstance(1);
    const heard: string[] = [];
    const offs = [
      first.bus.on("axis_label_click", () => heard.push("first")),
      second.bus.on("axis_label_click", () => heard.push("second")),
    ];
    first.CytofD3.render(payload([]), "navigate");
    second.CytofD3.render(payload([]), "navigate");
    // The second plot's own shim is what its script calls; the page's Shiny is the first plot's.
    (window as unknown as { Shiny: { setInputValue(name: string, value: unknown): void } }).Shiny.setInputValue("axis_label_click", {});
    expect(heard).toEqual(["first"]);
    offs.forEach((off) => off());
  });
});
