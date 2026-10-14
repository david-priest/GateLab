import { describe, expect, it } from "vitest";
import type { ImagePlanes } from "./cvwDecode";
import type { ChannelDisplay } from "./imageWallSettings";
import { OUTLINE_RGB, boxBlur, channelBrightness, channelRgba, compositeRgba, measureScale, paintOutline, renderKey } from "./render";

const display = (slot: number, over: Partial<ChannelDisplay> = {}): ChannelDisplay => ({
  slot, name: `ch${slot}`, enabled: true, colour: "#ff0000", threshold: 0, saturation: 1, gamma: 1, smoothing: 1, ...over,
});

const planes = (rows: number, cols: number, fill: (slot: number, r: number, c: number) => number, slots = [2, 3]): ImagePlanes => ({
  rows,
  cols,
  slots,
  aspect: 0.3,
  planes: slots.map((slot) => {
    const plane = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) plane[r * cols + c] = fill(slot, r, c);
    return plane;
  }),
});

describe("paintOutline", () => {
  it("paints the mask's boundary pixels and nothing else", () => {
    const rows = 7;
    const cols = 7;
    const mask = new Uint8Array(rows * cols);
    for (let r = 2; r <= 4; r++) for (let c = 2; c <= 4; c++) mask[r * cols + c] = 1;
    const rgba = new Uint8ClampedArray(rows * cols * 4).fill(0);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    paintOutline(rgba, mask, rows, cols);
    const painted: number[] = [];
    for (let i = 0; i < rows * cols; i++) if (rgba[i * 4] === OUTLINE_RGB[0] && rgba[i * 4 + 2] === OUTLINE_RGB[2]) painted.push(i);
    const ring = [];
    for (let r = 2; r <= 4; r++) for (let c = 2; c <= 4; c++) if (r !== 3 || c !== 3) ring.push(r * cols + c);
    expect(painted).toEqual(ring);
    expect(rgba[(3 * cols + 3) * 4]).toBe(0);
  });
  it("treats the picture's edge as outside", () => {
    const mask = new Uint8Array(4).fill(1);
    const rgba = new Uint8ClampedArray(16);
    paintOutline(rgba, mask, 2, 2);
    for (let i = 0; i < 4; i++) expect(rgba[i * 4 + 1]).toBe(OUTLINE_RGB[1]);
  });
});

describe("channelBrightness", () => {
  it("stretches between the black and white points and applies gamma", () => {
    const plane = Float32Array.from([0, 25, 50, 75, 100]);
    const linear = channelBrightness(plane, 1, 5, display(2, { threshold: 0.25, saturation: 0.75 }), 100, 1);
    expect(Array.from(linear).map((v) => +v.toFixed(2))).toEqual([0, 0, 0.5, 1, 1]);
    const gamma = channelBrightness(plane, 1, 5, display(2, { gamma: 2 }), 100, 1);
    expect(gamma[2]).toBeCloseTo(Math.sqrt(0.5), 2);
    const exposed = channelBrightness(plane, 1, 5, display(2), 100, 2);
    expect(exposed[2]).toBeCloseTo(1, 2);
  });

  it("smooths with a box when smoothing is above 1", () => {
    const plane = new Float32Array(9);
    plane[4] = 9;
    // Each pass averages over the neighbours that exist, so an edge is not darkened by padding.
    const blurred = boxBlur(plane, 3, 3, 1);
    expect(blurred[4]).toBeCloseTo(1, 5);
    expect(blurred[0]).toBeCloseTo(2.25, 5);
    expect(blurred[1]).toBeCloseTo(1.5, 5);
    const bright = channelBrightness(plane, 3, 3, display(2, { smoothing: 2 }), 9, 1);
    expect(bright[0]).toBeCloseTo(2.25 / 9, 3);
  });
});

describe("compositeRgba and channelRgba", () => {
  it("adds the enabled channels' colours and ignores disabled ones", () => {
    const image = planes(1, 2, (slot, _r, c) => (slot === 2 ? (c === 0 ? 1 : 0) : 1));
    const spec = {
      display: [display(2, { colour: "#ff0000" }), display(3, { colour: "#0000ff", enabled: false })],
      scale: { 2: 1, 3: 1 },
      exposure: 1,
    };
    const rgba = compositeRgba(image, spec);
    expect(Array.from(rgba)).toEqual([255, 0, 0, 255, 0, 0, 0, 255]);
    const both = compositeRgba(image, { ...spec, display: [display(2, { colour: "#ff0000" }), display(3, { colour: "#0000ff" })] });
    expect(Array.from(both)).toEqual([255, 0, 255, 255, 0, 0, 255, 255]);
  });

  it("renders one channel tinted or in grey", () => {
    const image = planes(1, 1, () => 0.5);
    const spec = { display: [display(2, { colour: "#00ff00" }), display(3)], scale: { 2: 1, 3: 1 }, exposure: 1 };
    expect(Array.from(channelRgba(image, spec, 2))).toEqual([0, 128, 0, 255]);
    expect(Array.from(channelRgba(image, spec, 2, false))).toEqual([128, 128, 128, 255]);
    expect(Array.from(channelRgba(image, spec, 9))).toEqual([0, 0, 0, 0]);
  });
});

describe("measureScale and renderKey", () => {
  it("takes a high percentile of every pixel per slot", () => {
    const a = planes(1, 100, (_slot, _r, c) => c);
    const b = planes(1, 100, (_slot, _r, c) => 100 + c);
    const scale = measureScale([a, b], 0.9, 0);
    expect(scale[2]).toBe(180);
    expect(scale[3]).toBe(180);
    expect(measureScale([])).toEqual({});
    // Noise alone: the floor of twenty medians wins over the percentile.
    const noise = planes(1, 1000, (_slot, _r, c) => 1 + (c % 10) / 10);
    const floored = measureScale([noise]);
    expect(floored[2]).toBeCloseTo(20 * 1.5, 5);
    // A transmitted-light slot keeps the percentile: its background is the signal.
    expect(measureScale([noise], 0.999, 20, [2])[2]).toBeCloseTo(1.9, 5);
  });

  it("changes the key whenever a setting that changes the pixels changes", () => {
    const spec = { display: [display(2)], scale: { 2: 10 }, exposure: 1 };
    const base = renderKey(spec, 16);
    expect(renderKey(spec, 32)).not.toBe(base);
    expect(renderKey({ ...spec, exposure: 2 }, 16)).not.toBe(base);
    expect(renderKey({ ...spec, scale: { 2: 20 } }, 16)).not.toBe(base);
    expect(renderKey({ ...spec, display: [display(2, { enabled: false })] }, 16)).not.toBe(base);
    expect(renderKey({ ...spec, display: [display(2, { colour: "#00ff00" })] }, 16)).not.toBe(base);
    expect(renderKey({ display: [display(2)], scale: { 2: 10 }, exposure: 1 }, 16)).toBe(base);
  });
});
