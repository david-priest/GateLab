// @vitest-environment jsdom
//
// The histogram view's own arithmetic: binning, the interval a range gate is drawn as (with its
// open ends), and the display values a drawn or dragged gesture reports.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistogramPlot, histogramCounts, linearTicks, plotGateInterval, smoothCounts, type RangeEdit } from "./HistogramPlot";
import type { PlotGate } from "./gatePayload";

const range = (id: string, lo: number, hi: number, open?: [boolean, boolean]): PlotGate => ({
  gate_id: id,
  gate_type: "rectangle",
  x_channel: "FSC-A",
  y_channel: "FSC-A",
  color: "#d62728",
  name: id,
  label_offset: null,
  vertices: [[lo, lo], [hi, lo], [hi, hi], [lo, hi]],
  ...(open ? { unbounded: { x: open, y: open } } : {}),
  percent_of_parent: 40,
});

describe("histogram arithmetic", () => {
  it("bins values over the axis, the top edge in the last bin, and leaves out what is off the axis", () => {
    expect(histogramCounts([0, 0.5, 1, 9.99, 10, 11, -1, NaN], [0, 10], 10)).toEqual([2, 1, 0, 0, 0, 0, 0, 0, 0, 2]);
  });

  it("draws a range as its interval, the intersection of its two axes, with its open ends", () => {
    expect(plotGateInterval(range("A", 2, 5))).toEqual({ lo: 2, hi: 5, open: [false, false] });
    expect(plotGateInterval(range("B", 2, 1e12, [false, true]))).toEqual({ lo: 2, hi: 1e12, open: [false, true] });
    const twoIntervals: PlotGate = { ...range("C", 0, 0), vertices: [[1, 3], [6, 3], [6, 8], [1, 8]] };
    expect(plotGateInterval(twoIntervals)).toMatchObject({ lo: 3, hi: 6 });
    expect(plotGateInterval({ ...range("D", 0, 1), gate_type: "polygon" })).toBeNull();
  });

  it("smooths counts with a Gaussian that keeps their total away from the edges, and leaves them alone below a tenth of a bin", () => {
    const spike = [0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0];
    const smooth = smoothCounts(spike, 1);
    expect(smooth.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 6);
    expect(smooth[5]).toBeLessThan(10);
    expect(smooth[4]).toBeCloseTo(smooth[6], 12);
    expect(smooth[4]).toBeGreaterThan(smooth[3]);
    expect(smoothCounts(spike, 0.05)).toEqual(spike);
  });

  it("ticks a linear axis at a 1, 2 or 5 step", () => {
    expect(linearTicks([0, 1000])).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(linearTicks([-0.3, 0.3])).toEqual([-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3]);
  });
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function mount(props: Partial<Parameters<typeof HistogramPlot>[0]>) {
  act(() => root.render(
    <HistogramPlot
      values={Float32Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90])}
      xRange={[0, 100]}
      ticks={null}
      channel="FSC-A"
      channelOptions={[{ value: "FSC-A", label: "FSC-A" }]}
      onChannelChange={() => {}}
      gates={[]}
      selectedGateId={null}
      mode="navigate"
      {...props}
    />,
  ));
  const svg = host.querySelector("svg")!;
  // 560 px wide, 52 px left margin and 18 px right: 4.9 px per unit on [0, 100].
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 560, height: 403, right: 560, bottom: 403, x: 0, y: 0, toJSON: () => ({}) });
  const px = (v: number) => 52 + v * 4.9;
  const at = (el: Element, type: string, clientX: number) =>
    act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 })); });
  return { svg, px, at };
}

describe("HistogramPlot gestures", () => {
  it("draws steps when binned and a line through bin centres when smoothed, and changes no gate", () => {
    const onRangeEdit = vi.fn();
    mount({ gates: [range("A", 20, 50)], onRangeEdit });
    const curve = () => host.querySelector(".gl-histogram-curve")!.getAttribute("d")!;
    const smoothed = curve();
    const pressed = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
    expect(pressed("Smoothed").getAttribute("aria-pressed")).toBe("true");
    act(() => pressed("Binned").click());
    const binned = curve();
    expect(binned).not.toBe(smoothed);
    // Steps: two points per bin (256 by default), plus the baseline at each end.
    expect(binned.split("L").length - 1).toBe(2 * 256 + 1);
    expect(smoothed.split("L").length - 1).toBe(256 + 1);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Histogram smoothing width"]')!.disabled).toBe(true);
    expect(onRangeEdit).not.toHaveBeenCalled();
    act(() => pressed("Smoothed").click());
  });

  it("reports a drawn range in display units, in either direction, and ignores a click", () => {
    const onNewRange = vi.fn();
    const { svg, px, at } = mount({ mode: "draw-range", onNewRange });
    at(svg, "pointerdown", px(65));
    at(svg, "pointermove", px(25));
    at(svg, "pointerup", px(25));
    expect(onNewRange).toHaveBeenCalledTimes(1);
    const [lo, hi] = onNewRange.mock.calls[0];
    expect(lo).toBeCloseTo(25, 6);
    expect(hi).toBeCloseTo(65, 6);
    at(svg, "pointerdown", px(40));
    at(svg, "pointerup", px(40));
    expect(onNewRange).toHaveBeenCalledTimes(1);
  });

  it("reports only the end dragged, both bounded ends for the range's body, and never an open end", () => {
    const edits: RangeEdit[] = [];
    const onGateSelect = vi.fn();
    const { svg, px, at } = mount({
      gates: [range("A", 20, 50), range("B", 60, 1e12, [false, true])],
      onRangeEdit: (e) => edits.push(...e),
      onGateSelect,
    });
    const part = (id: string, cls: string) => host.querySelector(`.${cls}[data-gate-id="${id}"]`);
    at(part("A", "gl-range-hi")!, "pointerdown", px(50));
    at(svg, "pointermove", px(55));
    at(svg, "pointerup", px(55));
    expect(edits[0].gate_id).toBe("A");
    expect(edits[0].lo).toBeUndefined();
    expect(edits[0].hi).toBeCloseTo(55, 6);

    at(part("A", "gl-range-body")!, "pointerdown", px(30));
    at(svg, "pointermove", px(40));
    at(svg, "pointerup", px(40));
    expect(edits[1].lo).toBeCloseTo(30, 6);
    expect(edits[1].hi).toBeCloseTo(60, 6);

    expect(part("B", "gl-range-hi")).toBeNull();
    at(part("B", "gl-range-body")!, "pointerdown", px(80));
    at(svg, "pointermove", px(70));
    at(svg, "pointerup", px(70));
    expect(edits[2]).toEqual({ gate_id: "B", lo: expect.closeTo(50, 6) });
    expect(onGateSelect).toHaveBeenLastCalledWith("B");

    // The move area is the whole band, top to bottom, and both ends lie over every band.
    const body = part("A", "gl-range-body")!;
    expect(Number(body.getAttribute("y"))).toBe(14);
    expect(Number(body.getAttribute("height"))).toBeGreaterThan(300);
    const order = [...host.querySelectorAll(".gl-range-body, .gl-range-lo, .gl-range-hi")].map((el) => el.getAttribute("class"));
    expect(order.lastIndexOf("gl-range-body")).toBeLessThan(order.indexOf("gl-range-lo"));

    // A press with no movement selects and edits nothing.
    at(part("A", "gl-range-lo")!, "pointerdown", px(20));
    at(svg, "pointerup", px(20));
    expect(edits).toHaveLength(3);
    expect(onGateSelect).toHaveBeenLastCalledWith("A");
  });

  it("moves the ends of other ranges that meet a moved end, as one edit, unless Alt is held", () => {
    const batches: RangeEdit[][] = [];
    const { svg, px, at } = mount({
      gates: [range("A", -1e12, 50, [true, false]), range("B", 50, 1e12, [false, true]), range("C", 70, 90)],
      onRangeEdit: (e) => batches.push(e),
    });
    const part = (id: string, cls: string) => host.querySelector(`.${cls}[data-gate-id="${id}"]`)!;
    // A's upper end is B's lower end: dragging either moves both.
    at(part("A", "gl-range-hi"), "pointerdown", px(50));
    at(svg, "pointermove", px(60));
    at(svg, "pointerup", px(60));
    expect(batches[0]).toHaveLength(2);
    expect(batches[0][0]).toEqual({ gate_id: "A", hi: expect.closeTo(60, 6) });
    expect(batches[0][1]).toEqual({ gate_id: "B", lo: expect.closeTo(60, 6) });
    // B's body moves its one bounded end, and A's upper end with it; C, which meets nothing, stays.
    at(part("B", "gl-range-body"), "pointerdown", px(80));
    at(svg, "pointermove", px(75));
    at(svg, "pointerup", px(75));
    expect(batches[1].map((e) => e.gate_id)).toEqual(["B", "A"]);
    expect(batches[1][1].hi).toBeCloseTo(45, 6);
    // Alt moves the one range alone.
    act(() => { part("A", "gl-range-hi").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: px(50), button: 0, altKey: true })); });
    at(svg, "pointermove", px(40));
    at(svg, "pointerup", px(40));
    expect(batches[2]).toEqual([{ gate_id: "A", hi: expect.closeTo(40, 6) }]);
  });

  it("reports a bisector where the pointer is released", () => {
    const onNewBisector = vi.fn();
    const { svg, px, at } = mount({ mode: "draw-bisector", onNewBisector });
    at(svg, "pointerdown", px(30));
    at(svg, "pointermove", px(42));
    at(svg, "pointerup", px(42));
    expect(onNewBisector).toHaveBeenCalledTimes(1);
    expect(onNewBisector.mock.calls[0][0]).toBeCloseTo(42, 6);
  });

  it("drags a label to an offset in axis units and % of max, held inside the frame, without editing the gate", () => {
    const onLabelMove = vi.fn();
    const onRangeEdit = vi.fn();
    const { svg, px, at } = mount({ gates: [range("A", 20, 50)], onLabelMove, onRangeEdit });
    const label = host.querySelector('.gl-range-label[data-gate-id="A"]')!;
    const rect = () => label.querySelector("rect")!;
    // On its bar: the bar runs through the middle of the pill, with an arrowhead at each end, and
    // nothing fills the range.
    const bar = host.querySelector('.gl-range-gate[data-gate-id="A"] .gl-range-bar')!;
    const pill = rect();
    expect(Number(bar.getAttribute("y1"))).toBeCloseTo(Number(pill.getAttribute("y")) + Number(pill.getAttribute("height")) / 2, 6);
    expect(host.querySelectorAll('.gl-range-gate[data-gate-id="A"] .gl-range-arrow')).toHaveLength(2);
    expect(host.querySelectorAll('.gl-range-gate[data-gate-id="A"] .gl-range-bound')).toHaveLength(2);
    expect(host.querySelector('.gl-range-gate[data-gate-id="A"] rect')).toBeNull();
    const drag = (dx: number, dy: number) => {
      act(() => { label.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: px(35), clientY: 50, button: 0 })); });
      act(() => { svg.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: px(35) + dx, clientY: 50 + dy, button: 0 })); });
      act(() => { svg.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: px(35) + dx, clientY: 50 + dy, button: 0 })); });
    };
    drag(4.9 * 10, 0);
    expect(onLabelMove).toHaveBeenLastCalledWith("A", [expect.closeTo(10, 6), expect.closeTo(0, 6)]);
    // Far past the bottom and the right: held inside the frame.
    drag(2000, 2000);
    const [, [ox, oy]] = onLabelMove.mock.calls.at(-1)!;
    // The right edge is 65 units from the label's base; its centre stops half a label short of it.
    expect(ox).toBeGreaterThan(50);
    expect(ox).toBeLessThan(65);
    expect(oy).toBeLessThan(0);
    expect(oy).toBeGreaterThan(-100);
    expect(onRangeEdit).not.toHaveBeenCalled();
    void at;
  });

  it("pans the axis by a drag, stretches it with Shift (low end fixed), and commits once on release", () => {
    const onRangeChange = vi.fn();
    const { svg, px, at } = mount({ gates: [range("A", 20, 50)], onRangeChange });
    // A drag on the background, not on a range: 10 units to the right moves the view 10 down.
    const plot = host.querySelector("svg > rect")!;
    at(plot, "pointerdown", px(70));
    at(svg, "pointermove", px(75));
    expect(onRangeChange).not.toHaveBeenCalled();
    at(svg, "pointermove", px(80));
    at(svg, "pointerup", px(80));
    expect(onRangeChange).toHaveBeenCalledTimes(1);
    expect(onRangeChange.mock.calls[0][0][0]).toBeCloseTo(-10, 6);
    expect(onRangeChange.mock.calls[0][0][1]).toBeCloseTo(90, 6);
    // Shift: the value grabbed at 80 follows the pointer to 40, so the axis now ends at 200.
    act(() => { plot.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: px(80), button: 0, shiftKey: true })); });
    act(() => { svg.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: px(40), button: 0, shiftKey: true })); });
    act(() => { svg.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: px(40), button: 0, shiftKey: true })); });
    expect(onRangeChange.mock.calls[1][0][0]).toBeCloseTo(0, 6);
    expect(onRangeChange.mock.calls[1][0][1]).toBeCloseTo(200, 6);
    // A press without movement changes nothing.
    at(plot, "pointerdown", px(60));
    at(svg, "pointerup", px(60));
    expect(onRangeChange).toHaveBeenCalledTimes(2);
  });

  it("draws an open-ended range with one bound line and its arrow at the edge of the plot", () => {
    mount({ gates: [range("B", 60, 1e12, [false, true])] });
    const gate = host.querySelector('.gl-range-gate[data-gate-id="B"]')!;
    expect(gate.querySelectorAll(".gl-range-bound")).toHaveLength(1);
    const arrows = [...gate.querySelectorAll(".gl-range-arrow")].map((a) => a.getAttribute("d")!);
    // The right-hand arrow's tip is at the plot's right edge, 52 + 490 px.
    expect(arrows.some((d) => d.startsWith("M542,"))).toBe(true);
    expect(gate.querySelector("rect")).toBeNull();
  });

  it("runs the bar under a label that is wider than its range, so both arrows show", () => {
    mount({ gates: [range("A", 20, 50), { ...range("N", 60, 64), name: "a long range name" }] });
    const barY = (id: string) => Number(host.querySelector(`.gl-range-gate[data-gate-id="${id}"] .gl-range-bar`)!.getAttribute("y1"));
    const pill = (id: string) => host.querySelector(`.gl-range-label[data-gate-id="${id}"] rect`)!;
    const middle = (id: string) => Number(pill(id).getAttribute("y")) + Number(pill(id).getAttribute("height")) / 2;
    const bottom = (id: string) => Number(pill(id).getAttribute("y")) + Number(pill(id).getAttribute("height"));
    expect(barY("A")).toBeCloseTo(middle("A"), 6);
    expect(barY("N")).toBeGreaterThan(bottom("N"));
  });
});

describe("HistogramPlot type", () => {
  it("sets its channel picker and its y title at the plot's Axis size, and its ticks at the Tick size, as the scatter plot does", () => {
    const fonts = (axis: number, tick: number) => ({ tick, axis, title: 12, gate: 11 });
    mount({ fontSizes: fonts(13, 10) });
    const axisSize = () => (host.querySelector(".gl-histogram-axis") as HTMLElement).style.fontSize;
    const yTitle = () => [...host.querySelectorAll("svg text")].find((t) => t.textContent === "% of max")!.getAttribute("font-size");
    expect(axisSize()).toBe("13px");
    expect(yTitle()).toBe("13");
    expect([...host.querySelectorAll("svg text")].find((t) => t.textContent === "0")?.getAttribute("font-size")).toBe("10");
    mount({ fontSizes: fonts(18, 9) });
    expect(axisSize()).toBe("18px");
    expect(yTitle()).toBe("18");
  });
});
