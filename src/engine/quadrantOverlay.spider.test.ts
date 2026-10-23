// Where a spider quadrant's labels go: inside the quadrant each names, however the arms lean.
import { describe, it, expect } from "vitest";
import { Sample } from "./sample";
import { spiderOverlayShape } from "./quadrantOverlay";
import { gateMaskQuadrant } from "./gates";
import { newQuadrantGate, validArms, type QuadrantArms, type QuadrantGate } from "./models";
import type { FcsFile } from "./fcs";

function d1(): FcsFile {
  return {
    version: "FCS3.1", nEvents: 2, instrument: "flow", keywords: {},
    channels: [
      { index: 0, name: "FL1-A", marker: null, bits: 32, range: 1024 },
      { index: 1, name: "FL2-A", marker: null, bits: 32, range: 1024 },
    ],
    columns: [Float32Array.from([1, 2]), Float32Array.from([1, 2])],
    spillover: null,
  } as unknown as FcsFile;
}

describe("spider quadrant label places", () => {
  const sample = new Sample(d1());
  const [x, y] = sample.channels.map((c) => c.key);
  const spider = (center: [number, number], arms: QuadrantArms): QuadrantGate => ({
    ...newQuadrantGate("D1 spider", x, y, center),
    arms,
    space: "display",
    transforms: { [x]: { kind: "identity" }, [y]: { kind: "identity" } },
  });
  it.each([
    // The x−/y+ quadrant here spans 257 degrees about the centre, and its polygon's mean lies in x+/y−.
    ["a quadrant wider than a half-turn", [1, 9], { left: [0, 0], up: [10, 10], down: [5, 0], right: [10, 5] }],
    ["FlowJo 11's example", [148.53, 125.82], { down: [124.07, 0], right: [256, 121.45], up: [99.97, 256], left: [0, 79.15] }],
  ] as const)("puts each label inside its own quadrant: %s", (_why, center, arms) => {
    const g = spider([...center] as [number, number], arms as unknown as QuadrantArms);
    expect(validArms(g.center, g.arms)).toBe(true);
    const shape = spiderOverlayShape(sample, g, x, y, false)!;
    const back = shape.anchors.map(([ax, ay]) => [sample.displayToGate(g, x, ax), sample.displayToGate(g, y, ay)]);
    back.forEach(([ax, ay], k) => {
      const inQ = [1, 2, 3, 4].map((q) => gateMaskQuadrant([ax], [ay], g.center, q, undefined, g.arms)[0]);
      expect([k + 1, inQ]).toEqual([k + 1, [1, 2, 3, 4].map((q) => (q === k + 1 ? 1 : 0))]);
    });
  });

  it("puts each label where it can be seen and dragged when its quadrant reaches far past the view", () => {
    // A box spanning the file's outliers, 1000 units each way, and a view of 0-100: each label
    // used to sit at its triangle's centroid hundreds of units out, held to the frame only for
    // drawing, so a drag started from there and the label left the plot.
    const g = spider([40, 50], { down: [30, -1000], right: [1000, 60], up: [55, 1000], left: [-1000, 45] });
    const toDisplay = (ch: string, v: number) => sample.gateToDisplay(g, ch, v);
    const view = { x: [toDisplay(x, 0), toDisplay(x, 100)] as [number, number], y: [toDisplay(y, 0), toDisplay(y, 100)] as [number, number] };
    const back = (shape: { anchors: [number, number][] }) =>
      shape.anchors.map(([ax, ay]) => [sample.displayToGate(g, x, ax), sample.displayToGate(g, y, ay)] as [number, number]);
    back(spiderOverlayShape(sample, g, x, y, false, view)!).forEach(([ax, ay], k) => {
      expect([k + 1, ax >= 0 && ax <= 100 && ay >= 0 && ay <= 100]).toEqual([k + 1, true]);
      const inQ = [1, 2, 3, 4].map((q) => gateMaskQuadrant([ax], [ay], g.center, q, undefined, g.arms)[0]);
      expect([k + 1, inQ]).toEqual([k + 1, [1, 2, 3, 4].map((q) => (q === k + 1 ? 1 : 0))]);
    });
    // Without the view the places are the whole triangles' centroids, far outside it.
    expect(back(spiderOverlayShape(sample, g, x, y, false)!).some(([ax, ay]) => ax < 0 || ax > 100 || ay < 0 || ay > 100)).toBe(true);
  });
});
