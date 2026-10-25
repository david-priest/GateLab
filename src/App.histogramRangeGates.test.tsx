// @vitest-environment jsdom
//
// The Gating tab's histogram view: a range gate drawn on it holds the events between its ends, and
// dragging an end recounts them; a range imported from Gating-ML (a one-dimensional
// RectangleGate) is drawn on it with its count, and an end with no bound stays open when the other
// end is dragged. Every gate here is drawn or dragged with pointer gestures on the real histogram,
// at pixel positions placed between known events, and its population's count is asserted.
//
// Synthetic file D1: FSC-A 100..1000 in steps of 100 (linear), and FITC-A across the logicle
// axis's negative, linear and log parts, so a drawn bound is converted through a non-linear
// display transform before it is stored.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import { decodeFloat32Base64 } from "./engine/encode";

interface CapturedPlotProps {
  payload: { x_b64: string; x_range: [number, number] };
  onAxisLabelClick: (e: { axis: "x" | "y"; selected: string }) => void;
}
const plotHarness = vi.hoisted(() => ({ props: null as CapturedPlotProps | null }));
vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: CapturedPlotProps) => {
    plotHarness.props = props;
    return <div data-testid="gating-plot" />;
  },
}));

const FITC = [-200, -50, 0, 30, 150, 600, 2500, 9000, 40000, 150000];

function syntheticFcs(): FcsFile {
  return {
    version: "FCS3.1",
    nEvents: 10,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      { index: 2, name: "FITC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [
      Float32Array.from({ length: 10 }, (_, i) => (i + 1) * 100),
      Float32Array.from({ length: 10 }, () => 500),
      Float32Array.from(FITC),
    ],
    spillover: null,
  };
}
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => syntheticFcs() };
});

import App from "./App";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  plotHarness.props = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  plotHarness.props = null;
  uuid = 0;
});

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

async function loadFile(names = ["D1.fcs"]): Promise<void> {
  act(() => root.render(<App />));
  const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
    .find((candidate) => !candidate.hasAttribute("webkitdirectory"))!;
  const bytes = Uint8Array.from([1]);
  const files = names.map((name) => {
    const fcs = new File([bytes], name);
    Object.defineProperty(fcs, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
    return fcs;
  });
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
}

// The gating-import input: its accept list starts with .xml (and may grow, e.g. .flowjo).
async function importXml(xml: string): Promise<void> {
  const xmlInput = host.querySelector<HTMLInputElement>('input[accept^=".xml,"]')!;
  const file = new File([xml], "gates.xml", { type: "text/xml" });
  Object.defineProperty(file, "text", { value: async () => xml });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(xml).buffer });
  Object.defineProperty(xmlInput, "files", { configurable: true, value: [file] });
  await act(async () => { xmlInput.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  await settle();
  const importButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Import");
  if (importButton) {
    act(() => importButton.click());
    await settle();
    await settle();
  }
}

const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
const popRow = (name: string) =>
  [...host.querySelectorAll(".pop-row")].map((r) => r.textContent?.replace(/\s+/g, " ").trim()).find((t) => t?.includes(name));

/** The histogram's SVG, measured as laid out at its own size from the page's left edge. */
function histogram() {
  const svg = host.querySelector<SVGSVGElement>('[data-testid="histogram-plot"] svg')!;
  const width = Number(svg.getAttribute("width"));
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width, height: 400, right: width, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
  // The component's margins: 52 px left, 18 px right.
  const [x0, x1] = plotHarness.props!.payload.x_range;
  const px = (v: number) => 52 + ((v - x0) / (x1 - x0)) * (width - 70);
  return { svg, px };
}

/** Display values of the events, as the plot draws them, in ascending order. */
const sortedDisplay = () => [...decodeFloat32Base64(plotHarness.props!.payload.x_b64)].sort((a, b) => a - b);
const between = (values: number[], i: number) => (values[i] + values[i + 1]) / 2;

function drag(target: Element, svg: SVGSVGElement, fromPx: number, toPx: number): void {
  const at = (el: Element, type: string, clientX: number) =>
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 }));
  act(() => { at(target, "pointerdown", fromPx); });
  act(() => { at(svg, "pointermove", (fromPx + toPx) / 2); });
  act(() => { at(svg, "pointermove", toPx); });
  act(() => { at(svg, "pointerup", toPx); });
}

describe("range gates on the histogram view", () => {
  it.each([true, false])("keeps a shared bisector edit in one Undo step when both ranges tailored is %s", async (both) => {
    await loadFile(["D1.fcs", "D2.fcs"]);
    const view = async (name: string) => {
      const row = [...host.querySelectorAll<HTMLElement>(".gl-sample-row")].find((r) => r.textContent?.includes(name))!;
      act(() => row.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));await settle();
    };
    const rootPopulation = async () => {
      act(() => [...host.querySelectorAll<HTMLElement>(".pop-row")].find((r) => r.querySelector(".pop-row-name")?.textContent === "All Events")!.click());await settle();
    };
    const members = async (file: string, name: string, wanted: number[]) => {
      await view(file);
      act(() => [...host.querySelectorAll<HTMLElement>(".pop-row")].find((r) => r.querySelector(".pop-row-name")?.textContent === name)!.click());await settle();
      expect(sortedDisplay()).toEqual(wanted);
    };
    await view("D1.fcs");await rootPopulation();
    act(() => host.querySelector<HTMLButtonElement>('button[data-tool="histogram"]')!.click());await settle();
    let h = histogram();act(() => host.querySelector<HTMLButtonElement>('button[data-tool="draw-bisector"]')!.click());
    act(() => h.svg.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: h.px(550), button: 0 })));
    act(() => h.svg.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: h.px(550), button: 0 })));await settle();
    act(() => button("Create 2 ranges")!.click());await settle();await rootPopulation();
    for (const name of both ? ["FSC-A- gate", "FSC-A+ gate"] : ["FSC-A- gate"]) {
      const row = [...host.querySelectorAll<HTMLElement>(".gate-card")].find((r) => r.querySelector(".gate-card-name")?.textContent?.trim() === name)!;
      act(() => row.querySelector<HTMLInputElement>(".gate-tailor-switch input")!.click());await settle();
    }
    h = histogram();const lower = [...host.querySelectorAll(".gl-range-label")].find((g) => g.textContent?.startsWith("FSC-A- gate"))!.getAttribute("data-gate-id");
    drag(host.querySelector(`.gl-range-hi[data-gate-id="${lower}"]`)!, h.svg, h.px(550), h.px(750));await settle();
    await members("D1.fcs", "FSC-A-", [100, 200, 300, 400, 500, 600, 700]);
    await members("D1.fcs", "FSC-A+", [800, 900, 1000]);
    await members("D2.fcs", "FSC-A-", [100, 200, 300, 400, 500]);
    await members("D2.fcs", "FSC-A+", both ? [600, 700, 800, 900, 1000] : [800, 900, 1000]);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })));await settle();
    for (const file of ["D1.fcs", "D2.fcs"]) {
      await members(file, "FSC-A-", [100, 200, 300, 400, 500]);
      await members(file, "FSC-A+", [600, 700, 800, 900, 1000]);
    }
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true, bubbles: true, cancelable: true })));await settle();
    await members("D1.fcs", "FSC-A-", [100, 200, 300, 400, 500, 600, 700]);
    await members("D1.fcs", "FSC-A+", [800, 900, 1000]);
    await members("D2.fcs", "FSC-A-", [100, 200, 300, 400, 500]);
    await members("D2.fcs", "FSC-A+", both ? [600, 700, 800, 900, 1000] : [800, 900, 1000]);
  });

  it("edits only the viewed file's tailored range, retaining its other end, with Undo and Redo", async () => {
    await loadFile(["D1.fcs", "D2.fcs"]);
    const view = async (name: string) => {
      const row = [...host.querySelectorAll<HTMLElement>(".gl-sample-row")].find((r) => r.textContent?.includes(name))!;
      act(() => row.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
      await settle();
    };
    const rootPopulation = async () => {
      act(() => [...host.querySelectorAll<HTMLElement>(".pop-row")].find((r) => r.querySelector(".pop-row-name")?.textContent === "All Events")!.click());
      await settle();
    };
    const members = async (file: string, wanted: number[]) => {
      await view(file);
      act(() => [...host.querySelectorAll<HTMLElement>(".pop-row")].find((r) => r.querySelector(".pop-row-name")?.textContent === "R1")!.click());
      await settle();
      expect(sortedDisplay()).toEqual(wanted);
      expect(popRow("R1")).toContain(`${wanted.length}(${wanted.length * 10}% pnt`);
    };
    await view("D1.fcs");await rootPopulation();
    act(() => host.querySelector<HTMLButtonElement>('button[data-tool="histogram"]')!.click());await settle();
    let h = histogram();
    act(() => host.querySelector<HTMLButtonElement>('button[data-tool="draw-range"]')!.click());
    drag(h.svg, h.svg, h.px(450), h.px(950));await settle();
    const name = host.querySelector<HTMLInputElement>(".gl-modal input:not([type=checkbox])")!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "R1");name.dispatchEvent(new Event("input", { bubbles: true })); });
    const population = [...host.querySelectorAll<HTMLInputElement>('.gl-modal input[type=checkbox]')].find(i => i.parentElement?.textContent?.includes("Also create a population"))!;
    if (!population.checked) act(() => population.click());
    act(() => button("Create")!.click());await settle();await rootPopulation();
    expect(popRow("R1")).toContain("5(50% pnt");
    act(() => host.querySelector<HTMLInputElement>(".gate-card .gate-tailor-switch input")!.click());
    await settle();
    h = histogram();
    drag(host.querySelector(".gl-range-lo")!, h.svg, h.px(450), h.px(750));await settle();
    await members("D1.fcs", [800, 900]);
    await members("D2.fcs", [500, 600, 700, 800, 900]);
    await view("D1.fcs");await rootPopulation();h = histogram();
    // The untouched lower end must come from the file's 750, rather than the tree's 450.
    drag(host.querySelector(".gl-range-hi")!, h.svg, h.px(950), h.px(850));await settle();
    await members("D1.fcs", [800]);
    await members("D2.fcs", [500, 600, 700, 800, 900]);
    const history = async (shiftKey: boolean) => {
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey, bubbles: true, cancelable: true })));
      await settle();
    };
    await history(false);await members("D1.fcs", [800, 900]);
    await history(true);await members("D1.fcs", [800]);
    await members("D2.fcs", [500, 600, 700, 800, 900]);
  });

  it("counts the events a drawn range holds on a logicle axis, recounts when an end is dragged, and Undo restores it", async () => {
    await loadFile();
    act(() => plotHarness.props!.onAxisLabelClick({ axis: "x", selected: "FITC-A" }));
    await settle();
    // The view toggle leads the tool strip in both views, so it does not move when the tools change.
    const strip = () => [...host.querySelectorAll<HTMLButtonElement>(".gl-controls button[data-tool]")].map((b) => b.dataset.tool);
    expect(strip()[0]).toBe("histogram");
    act(() => host.querySelector<HTMLButtonElement>('button[data-tool="histogram"]')!.click());
    await settle();
    expect(host.querySelector('[data-testid="histogram-plot"]')).not.toBeNull();
    expect(strip()[0]).toBe("histogram");
    // The scatter tools give way to the range tool.
    expect(host.querySelector('button[data-tool="draw-rect"]')).toBeNull();

    const values = sortedDisplay();
    expect(values).toHaveLength(10);
    const { svg, px } = histogram();
    act(() => host.querySelector<HTMLButtonElement>('button[data-tool="draw-range"]')!.click());
    // From between 30 and 150 to between 9000 and 40000: 150, 600, 2500 and 9000.
    drag(svg, svg, px(between(values, 3)), px(between(values, 7)));
    await settle();
    const createPopulation = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((candidate) => candidate.parentElement?.textContent?.includes("Also create a population"))!;
    act(() => createPopulation.click());
    act(() => button("Create")!.click());
    await settle();

    expect(popRow("Gate_1")).toContain("4(40% pnt");
    // Creating the population plots it; back on All Events the label counts within all ten.
    act(() => [...host.querySelectorAll<HTMLElement>(".pop-row")].find((r) => r.textContent?.includes("All Events"))!.click());
    await settle();
    const gate = () => host.querySelector(".gl-range-gate")!;
    const part = (cls: string) => host.querySelector(`.${cls}[data-gate-id="${gate().getAttribute("data-gate-id")}"]`);
    expect(part("gl-range-label")!.textContent).toContain("40.0%");

    // The upper end, dragged past 40000: five events.
    const { svg: svg2, px: px2 } = histogram();
    drag(part("gl-range-hi")!, svg2, px2(between(values, 7)), px2(between(values, 8)));
    await settle();
    expect(popRow("Gate_1")).toContain("5(50% pnt");
    expect(part("gl-range-label")!.textContent).toContain("50.0%");

    // The label, dragged down and to the left: it moves and stays there, and no count changes.
    const label = part("gl-range-label")!;
    const pill = () => label.querySelector("rect")!;
    const before = [Number(pill().getAttribute("x")), Number(pill().getAttribute("y"))];
    act(() => { label.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 300, clientY: 40, button: 0 })); });
    act(() => { svg2.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: 260, clientY: 140, button: 0 })); });
    act(() => { svg2.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: 260, clientY: 140, button: 0 })); });
    await settle();
    const after = [Number(part("gl-range-label")!.querySelector("rect")!.getAttribute("x")), Number(part("gl-range-label")!.querySelector("rect")!.getAttribute("y"))];
    expect(after[0]).toBeCloseTo(before[0] - 40, 6);
    expect(after[1]).toBeCloseTo(before[1] + 100, 6);
    expect(popRow("Gate_1")).toContain("5(50% pnt");

    // The bar, dragged so that the lower end moves up past 150: both ends move by the same amount
    // on screen, and the gate holds what lies between them (half-open: lower end in, upper out).
    const shift = between(values, 4) - between(values, 3);
    drag(part("gl-range-body")!, svg2, px2(between(values, 5)), px2(between(values, 5) + shift));
    await settle();
    const lo = between(values, 3) + shift;
    const hi = between(values, 8) + shift;
    const held = values.filter((v) => v >= lo && v < hi).length;
    expect(held).toBeGreaterThan(0);
    expect(popRow("Gate_1")).toContain(`${held}(${held * 10}% pnt`);

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); });
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); });
    await settle();
    expect(popRow("Gate_1")).toContain("4(40% pnt");
  });

  it("draws an imported one-dimensional Gating-ML range with its count, and keeps its open end open when the other is dragged", async () => {
    await loadFile();
    // FSC-A at or above 450: 500 to 1000, six events; no upper bound.
    await importXml(
      '<?xml version="1.0" encoding="UTF-8"?>\n<gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"' +
      ' xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">' +
      '<gating:RectangleGate gating:id="R1"><gating:dimension gating:min="450"><data-type:fcs-dimension data-type:name="FSC-A" /></gating:dimension>' +
      "</gating:RectangleGate></gating:Gating-ML>",
    );
    expect(popRow("R1")).toContain("6(60% pnt");

    act(() => host.querySelector<HTMLButtonElement>('button[data-tool="histogram"]')!.click());
    await settle();
    const gate = () => host.querySelector(".gl-range-gate")!;
    const part = (cls: string) => host.querySelector(`.${cls}[data-gate-id="${gate().getAttribute("data-gate-id")}"]`);
    expect(gate()).not.toBeNull();
    expect(part("gl-range-label")!.textContent).toContain("60.0%");
    expect(part("gl-range-lo")).not.toBeNull();
    expect(part("gl-range-hi")).toBeNull();

    // The lower end, from 450 to between 700 and 800: 800, 900 and 1000.
    const values = sortedDisplay();
    const { svg, px } = histogram();
    const lo = part("gl-range-lo")!;
    drag(lo, svg, Number(lo.getAttribute("x1")), px(between(values, 6)));
    await settle();
    expect(popRow("R1")).toContain("3(30% pnt");
    expect(part("gl-range-hi")).toBeNull();
  });

  it("splits all events between a bisector's two ranges, moves both with the shared handle, and undoes each step at once", async () => {
    await loadFile();
    act(() => host.querySelector<HTMLButtonElement>('button[data-tool="histogram"]')!.click());
    await settle();
    // FSC-A is 100 to 1000; the split between 500 and 600 leaves five events on each side.
    const values = sortedDisplay();
    const { svg, px } = histogram();
    act(() => host.querySelector<HTMLButtonElement>('button[data-tool="draw-bisector"]')!.click());
    const at = px(between(values, 4));
    act(() => { svg.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: at, button: 0 })); });
    act(() => { svg.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: at, button: 0 })); });
    await settle();
    expect(host.textContent).toContain("Create bisector");
    act(() => button("Create 2 ranges")!.click());
    await settle();
    expect(popRow("FSC-A-")).toContain("5(50% pnt");
    expect(popRow("FSC-A+")).toContain("5(50% pnt");

    act(() => [...host.querySelectorAll<HTMLElement>(".pop-row")].find((r) => r.textContent?.includes("All Events"))!.click());
    await settle();
    // Fit with two open-ended ranges on the axis, after the view was stretched far past the data:
    // Fit returns to the data, and the open ends do not hold the axis out.
    const frame = [...plotHarness.props!.payload.x_range];
    {
      const { svg: s0, px: p0 } = histogram();
      const plot = s0.querySelector(":scope > rect")!;
      const at = (el: Element, type: string, clientX: number) =>
        act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0, shiftKey: true })); });
      const grab = frame[0] + (frame[1] - frame[0]) * 0.8;
      at(plot, "pointerdown", p0(grab));
      at(s0, "pointermove", p0(frame[0] + (frame[1] - frame[0]) * 0.1));
      at(s0, "pointerup", p0(frame[0] + (frame[1] - frame[0]) * 0.1));
      await settle();
      expect(plotHarness.props!.payload.x_range[1]).toBeGreaterThan(frame[1] * 4);
    }
    act(() => button("Fit data + gates")!.click());
    await settle();
    expect(plotHarness.props!.payload.x_range[0]).toBeCloseTo(frame[0], 6);
    expect(plotHarness.props!.payload.x_range[1]).toBeCloseTo(frame[1], 6);
    const idOf = (name: string) => [...host.querySelectorAll(".gl-range-label")].find((g) => g.textContent?.startsWith(name))!.getAttribute("data-gate-id")!;
    const low = idOf("FSC-A- gate");
    const high = idOf("FSC-A+ gate");
    // Each has one open end, and the two meet at the split.
    expect(host.querySelector(`.gl-range-lo[data-gate-id="${low}"]`)).toBeNull();
    expect(host.querySelector(`.gl-range-hi[data-gate-id="${high}"]`)).toBeNull();
    const shared = host.querySelector(`.gl-range-hi[data-gate-id="${low}"]`)!;
    expect(shared.getAttribute("x1")).toBe(host.querySelector(`.gl-range-lo[data-gate-id="${high}"]`)!.getAttribute("x1"));

    // The shared handle, to between 700 and 800: seven below, three above, still all ten.
    const { svg: svg2, px: px2 } = histogram();
    drag(shared, svg2, Number(shared.getAttribute("x1")), px2(between(values, 6)));
    await settle();
    expect(popRow("FSC-A-")).toContain("7(70% pnt");
    expect(popRow("FSC-A+")).toContain("3(30% pnt");

    const undo = () => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); });
    undo();
    await settle();
    expect(popRow("FSC-A-")).toContain("5(50% pnt");
    expect(popRow("FSC-A+")).toContain("5(50% pnt");
    undo();
    await settle();
    expect(popRow("FSC-A-")).toBeUndefined();
    expect(popRow("FSC-A+")).toBeUndefined();
  });

  it("pans the histogram's axis into the X channel's scale, and Fit brings back the data and its ranges, Y untouched", async () => {
    await loadFile();
    act(() => host.querySelector<HTMLButtonElement>('button[data-tool="histogram"]')!.click());
    await settle();
    const before = [...plotHarness.props!.payload.x_range];
    const yBefore = [...(plotHarness.props!.payload as unknown as { y_range: [number, number] }).y_range];
    const { svg, px } = histogram();
    const plot = svg.querySelector(":scope > rect")!;
    const mid = (before[0] + before[1]) / 2;
    const span = before[1] - before[0];
    drag(plot, svg, px(mid), px(mid + span / 10));
    await settle();
    const after = plotHarness.props!.payload.x_range;
    expect(after[0]).toBeCloseTo(before[0] - span / 10, 0);
    expect(after[1]).toBeCloseTo(before[1] - span / 10, 0);
    expect((plotHarness.props!.payload as unknown as { y_range: [number, number] }).y_range).toEqual(yBefore);

    act(() => button("Fit data + gates")!.click());
    await settle();
    const fitted = plotHarness.props!.payload.x_range;
    expect(fitted[0]).toBeLessThanOrEqual(100);
    expect(fitted[1]).toBeGreaterThanOrEqual(1000);
    // With no gates on the axis, Fit is the automatic frame the view opened on.
    expect(fitted[0]).toBeCloseTo(before[0], 6);
    expect(fitted[1]).toBeCloseTo(before[1], 6);
    expect((plotHarness.props!.payload as unknown as { y_range: [number, number] }).y_range).toEqual(yBefore);
  });
});
