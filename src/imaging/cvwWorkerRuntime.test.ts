import { describe, expect, it } from "vitest";
import { CVW_WORKER_PROTOCOL, type CvwWorkerResponse, type RenderSpecMessage } from "./cvwProtocol";
import { buildSyntheticCvw, gaussianBlob } from "./cvwFixture";
import { createCvwWorkerRuntime } from "./cvwWorkerRuntime";
import { memoryFile } from "../testDirectory";
import { defaultChannelDisplay } from "./imageWallSettings";

const names = new Map<number, string>([[2, "LightLoss (Imaging)"], [3, "FSC"], [4, "SSC (Imaging)"], [5, "A"], [6, "B"], [7, "C"]]);

// Event 0 carries a blob on SSC wide enough in time and rows to be an object at hop 64.
const sscBlob = gaussianBlob(50, 512, 6, 260);
const file = () => memoryFile("tube A.cvw", buildSyntheticCvw([
  { samples: 1024, carriers: Array.from({ length: 20 }, (_, i) => ({ slot: 4, row: 40 + i, amplitude: sscBlob(40 + i) })) },
  { noWaveform: true },
  { samples: 768, carriers: [{ slot: 3, row: 20, amplitude: () => 300 }] },
]));

const spec = (over: Partial<RenderSpecMessage> = {}): RenderSpecMessage => ({
  display: defaultChannelDisplay(names),
  scale: { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 },
  exposure: 1,
  hop: 16,
  composite: true,
  channels: [3, 4],
  ...over,
});

const tag = { protocol: CVW_WORKER_PROTOCOL } as const;

function runtimeWithLog(options: Partial<Parameters<typeof createCvwWorkerRuntime>[0]> = {}) {
  const log: CvwWorkerResponse[] = [];
  const runtime = createCvwWorkerRuntime({
    emit: (response) => { log.push(response); },
    yieldToEventLoop: async () => undefined,
    makeBitmap: async () => null,
    ...options,
  });
  return { runtime, log };
}

describe("cvw worker runtime", () => {
  it("opens a file, reports which events have images, and measures the scale", async () => {
    const { runtime, log } = runtimeWithLog();
    runtime.dispatch({ ...tag, type: "open-source", fileKey: "f1", source: { kind: "file", file: file() }, eventCount: 3 });
    await runtime.idle();
    const ready = log.find((r) => r.type === "source-ready");
    expect(ready).toBeTruthy();
    if (ready?.type !== "source-ready") return;
    expect(ready.eventCount).toBe(3);
    expect(ready.imageCount).toBe(2);
    expect(Array.from(ready.hasImage)).toEqual([1, 0, 1]);
    expect(ready.channelNames[2]).toBe("LightLoss (Imaging)");
    expect(ready.pixelAspectRatio).toBe(0.3);
    expect(ready.scale[4]).toBeGreaterThan(0);
    expect(ready.scale[3]).toBeGreaterThan(0);
  });

  it("refuses a file whose event count is not the FCS's", async () => {
    const { runtime, log } = runtimeWithLog();
    runtime.dispatch({ ...tag, type: "open-source", fileKey: "f1", source: { kind: "file", file: file() }, eventCount: 5 });
    await runtime.idle();
    expect(log[0]).toMatchObject({ type: "source-error", fileKey: "f1" });
    expect((log[0] as { message: string }).message).toMatch(/3 events and the FCS has 5/);
  });

  it("renders an event as pixels when no bitmap can be made, and says so for an event without one", async () => {
    const { runtime, log } = runtimeWithLog();
    runtime.dispatch({ ...tag, type: "open-source", fileKey: "f1", source: { kind: "file", file: file() }, eventCount: 3 });
    await runtime.idle();
    const ready = log.find((r) => r.type === "source-ready");
    if (ready?.type !== "source-ready") throw new Error("not opened");
    const measured = spec({ scale: ready.scale });
    runtime.dispatch({ ...tag, type: "render", requestId: "r1", fileKey: "f1", eventIndex: 0, lane: "batch", spec: measured });
    runtime.dispatch({ ...tag, type: "render", requestId: "r2", fileKey: "f1", eventIndex: 1, lane: "batch", spec: measured });
    await runtime.idle();
    const image = log.find((r) => r.type === "image");
    expect(image).toBeTruthy();
    if (image?.type !== "image") return;
    expect(image.requestId).toBe("r1");
    expect(image.rows).toBe(104);
    expect(image.cols).toBe(49);
    expect(image.aspect).toBeCloseTo(0.3, 6);
    expect(image.composite?.pixels?.length).toBe(104 * 49 * 4);
    expect(Object.keys(image.channels).map(Number)).toEqual([3, 4]);
    expect(image.channels[4].pixels?.length).toBe(104 * 49 * 4);
    // The SSC picture (tinted cyan, so read its green byte) is brightest on row 50; FSC is dark.
    const ssc = image.channels[4].pixels!;
    let brightest = 0;
    let brightestRow = -1;
    for (let r = 0; r < 104; r++) {
      let rowMax = 0;
      for (let c = 0; c < 49; c++) rowMax = Math.max(rowMax, ssc[(r * 49 + c) * 4 + 1]);
      if (rowMax > brightest) { brightest = rowMax; brightestRow = r; }
    }
    expect(brightestRow).toBeGreaterThanOrEqual(48);
    expect(brightestRow).toBeLessThanOrEqual(52);
    expect(brightest).toBeGreaterThan(200);
    // The FSC channel carries nothing in this event: black, opaque.
    const fsc = image.channels[3].pixels!;
    for (let i = 0; i < fsc.length; i += 4) {
      expect(fsc[i] + fsc[i + 1] + fsc[i + 2]).toBe(0);
      expect(fsc[i + 3]).toBe(255);
    }
    expect(log.find((r) => r.type === "no-image")).toMatchObject({ requestId: "r2", eventIndex: 1 });
  });

  it("paints the counted objects' outline over the pictures when the spec asks for it", async () => {
    const { runtime, log } = runtimeWithLog();
    runtime.dispatch({ ...tag, type: "open-source", fileKey: "f1", source: { kind: "file", file: file() }, eventCount: 3, scaleSample: 3 });
    await runtime.idle();
    const ready = log.find((r) => r.type === "source-ready");
    if (ready?.type !== "source-ready") throw new Error("not opened");
    const plain = spec({ scale: ready.scale, hop: 64, channels: [4] });
    runtime.dispatch({ ...tag, type: "render", requestId: "p", fileKey: "f1", eventIndex: 0, lane: "batch", spec: plain });
    runtime.dispatch({ ...tag, type: "render", requestId: "o", fileKey: "f1", eventIndex: 0, lane: "batch", spec: { ...plain, outline: {} } });
    await runtime.idle();
    const magenta = (pixels: Uint8ClampedArray) => {
      let n = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 255 && pixels[i + 1] === 60 && pixels[i + 2] === 255) n++;
      return n;
    };
    const images = log.filter((r) => r.type === "image");
    const without = images.find((r) => r.type === "image" && r.requestId === "p");
    const withOutline = images.find((r) => r.type === "image" && r.requestId === "o");
    if (without?.type !== "image" || withOutline?.type !== "image") throw new Error("renders missing");
    expect(magenta(without.composite!.pixels!)).toBe(0);
    expect(magenta(withOutline.composite!.pixels!)).toBeGreaterThan(8);
    expect(magenta(withOutline.channels[4].pixels!)).toBe(magenta(withOutline.composite!.pixels!));
    // The outline rings the blob: rows around 50 carry it, the far corners do not.
    const px = withOutline.composite!.pixels!;
    const cols = withOutline.cols;
    let nearBlob = 0;
    for (let r = 44; r <= 56; r++) for (let c = 0; c < cols; c++) if (px[(r * cols + c) * 4] === 255 && px[(r * cols + c) * 4 + 2] === 255) nearBlob++;
    expect(nearBlob).toBeGreaterThan(0);
    expect(px[0]).not.toBe(255);
  });

  it("returns the channels the spec names as grey untinted", async () => {
    const { runtime, log } = runtimeWithLog();
    runtime.dispatch({ ...tag, type: "open-source", fileKey: "f1", source: { kind: "file", file: file() }, eventCount: 3, scaleSample: 3 });
    await runtime.idle();
    const ready = log.find((r) => r.type === "source-ready");
    if (ready?.type !== "source-ready") throw new Error("not opened");
    runtime.dispatch({ ...tag, type: "render", requestId: "g", fileKey: "f1", eventIndex: 0, lane: "batch", spec: spec({ scale: ready.scale, channels: [4], grey: [4], composite: false }) });
    await runtime.idle();
    const image = log.find((r) => r.type === "image" && r.requestId === "g");
    if (image?.type !== "image") throw new Error("no image");
    const px = image.channels[4].pixels!;
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] + px[i + 1] + px[i + 2] === 0) continue;
      lit++;
      expect(px[i]).toBe(px[i + 1]);
      expect(px[i + 1]).toBe(px[i + 2]);
    }
    expect(lit).toBeGreaterThan(10);
    expect(image.composite).toBeNull();
  });

  it("drops an interactive request that is already behind the latest one", async () => {
    const { runtime, log } = runtimeWithLog();
    runtime.dispatch({ ...tag, type: "open-source", fileKey: "f1", source: { kind: "file", file: file() }, eventCount: 3, scaleSample: 0 });
    runtime.dispatch({ ...tag, type: "render", requestId: "h1", fileKey: "f1", eventIndex: 0, lane: "interactive", hoverSeq: 1, spec: spec() });
    runtime.dispatch({ ...tag, type: "render", requestId: "h2", fileKey: "f1", eventIndex: 2, lane: "interactive", hoverSeq: 2, spec: spec() });
    await runtime.idle();
    expect(log.map((r) => [r.type, (r as { requestId?: string }).requestId])).toEqual([
      ["source-ready", undefined],
      ["cancelled", "h1"],
      ["image", "h2"],
    ]);
  });

  it("honours a cancel that arrives before the request is read", async () => {
    const { runtime, log } = runtimeWithLog();
    runtime.dispatch({ ...tag, type: "open-source", fileKey: "f1", source: { kind: "file", file: file() }, eventCount: 3, scaleSample: 0 });
    runtime.dispatch({ ...tag, type: "render", requestId: "b1", fileKey: "f1", eventIndex: 0, lane: "batch", spec: spec() });
    runtime.dispatch({ ...tag, type: "cancel", requestIds: ["b1"] });
    await runtime.idle();
    expect(log.find((r) => r.type === "cancelled")).toMatchObject({ requestId: "b1" });
    expect(log.find((r) => r.type === "image")).toBeUndefined();
  });

  it("drains a queue of cancelled renders without yielding between them", async () => {
    let yields = 0;
    const { runtime, log } = runtimeWithLog({ yieldToEventLoop: async () => { yields++; } });
    runtime.dispatch({ ...tag, type: "open-source", fileKey: "f1", source: { kind: "file", file: file() }, eventCount: 3, scaleSample: 0 });
    const ids = Array.from({ length: 200 }, (_, i) => `w${i}`);
    for (const id of ids) runtime.dispatch({ ...tag, type: "render", requestId: id, fileKey: "f1", eventIndex: 0, lane: "batch", spec: spec() });
    runtime.dispatch({ ...tag, type: "render", requestId: "thumb", fileKey: "f1", eventIndex: 2, lane: "batch", spec: spec() });
    runtime.dispatch({ ...tag, type: "cancel", requestIds: ids });
    await runtime.idle();
    expect(log.filter((r) => r.type === "cancelled")).toHaveLength(200);
    expect(log.find((r) => r.type === "image")).toMatchObject({ requestId: "thumb" });
    // One yield for the picture that was drawn, none for the two hundred that were not.
    expect(yields).toBeLessThanOrEqual(2);
  });

  it("answers with an error for a file that is not open, and after it was dropped", async () => {
    const { runtime, log } = runtimeWithLog();
    runtime.dispatch({ ...tag, type: "render", requestId: "x1", fileKey: "nope", eventIndex: 0, lane: "batch", spec: spec() });
    await runtime.idle();
    expect(log[0]).toMatchObject({ type: "error", requestId: "x1", retryable: true });
    runtime.dispatch({ ...tag, type: "open-source", fileKey: "f1", source: { kind: "file", file: file() }, eventCount: 3, scaleSample: 0 });
    await runtime.idle();
    runtime.dispatch({ ...tag, type: "drop-source", fileKey: "f1" });
    runtime.dispatch({ ...tag, type: "render", requestId: "x2", fileKey: "f1", eventIndex: 0, lane: "batch", spec: spec() });
    await runtime.idle();
    expect(log.at(-1)).toMatchObject({ type: "error", requestId: "x2" });
  });

  it("uses the bitmap maker when it gives one", async () => {
    const made: number[] = [];
    const fakeBitmap = { close: () => undefined } as unknown as ImageBitmap;
    const { runtime, log } = runtimeWithLog({ makeBitmap: async (_pixels, w) => { made.push(w); return fakeBitmap; } });
    runtime.dispatch({ ...tag, type: "open-source", fileKey: "f1", source: { kind: "file", file: file() }, eventCount: 3, scaleSample: 0 });
    runtime.dispatch({ ...tag, type: "render", requestId: "r1", fileKey: "f1", eventIndex: 2, lane: "batch", spec: spec({ channels: [] }) });
    await runtime.idle();
    const image = log.find((r) => r.type === "image");
    if (image?.type !== "image") throw new Error("no image");
    expect(image.composite?.bitmap).toBe(fakeBitmap);
    expect(image.composite?.pixels).toBeUndefined();
    expect(made).toEqual([33]);
  });

  it("counts the objects of every imaged event, reports progress, and can be cancelled", async () => {
    const { runtime, log } = runtimeWithLog();
    // Event 0 has a blob on SSC, event 1 no waveform, event 2 only an FSC carrier.
    runtime.dispatch({ ...tag, type: "open-source", fileKey: "f1", source: { kind: "file", file: file() }, eventCount: 3 });
    runtime.dispatch({ ...tag, type: "classify", requestId: "c1", fileKey: "f1" });
    await runtime.idle();
    const done = log.find((r) => r.type === "classified");
    expect(done).toBeTruthy();
    if (done?.type !== "classified") return;
    expect(Array.from(done.objectCount)).toEqual([1, 255, 0]);
    expect(done.objectArea[0]).toBeGreaterThan(20);
    expect(done.objectArea[2]).toBe(0);
    // The mask's measurements ride along: the blob has a boundary and a shape, the empty event none.
    expect(Object.keys(done.features)).toEqual(["perimeter", "circularity", "majorAxis", "minorAxis", "axisRatio", "diameter", "meanIntensity", "sdIntensity"]);
    expect(done.features.perimeter[0]).toBeGreaterThan(8);
    expect(done.features.axisRatio[0]).toBeGreaterThan(0.2);
    expect(done.features.axisRatio[0]).toBeLessThanOrEqual(1);
    expect(done.features.meanIntensity[0]).toBeGreaterThan(0);
    expect(done.features.perimeter[2]).toBe(0);
    expect(done.features.diameter[1]).toBe(0);
    expect(log.some((r) => r.type === "classify-progress" && r.done === 3 && r.total === 3)).toBe(true);
    // Cancelled before it starts: no result.
    runtime.dispatch({ ...tag, type: "classify", requestId: "c2", fileKey: "f1" });
    runtime.dispatch({ ...tag, type: "cancel", requestIds: ["c2"] });
    await runtime.idle();
    expect(log.filter((r) => r.type === "classified")).toHaveLength(1);
    expect(log.some((r) => r.type === "cancelled" && r.requestId === "c2")).toBe(true);
    // An unknown file is an error.
    runtime.dispatch({ ...tag, type: "classify", requestId: "c3", fileKey: "nope" });
    await runtime.idle();
    expect(log.at(-1)).toMatchObject({ type: "error", requestId: "c3" });
  });

  it("keeps decoded planes within its budget", async () => {
    const { runtime, log } = runtimeWithLog({ planeBudgetBytes: 1 });
    runtime.dispatch({ ...tag, type: "open-source", fileKey: "f1", source: { kind: "file", file: file() }, eventCount: 3, scaleSample: 0 });
    for (let k = 0; k < 3; k++) {
      runtime.dispatch({ ...tag, type: "render", requestId: `r${k}`, fileKey: "f1", eventIndex: 0, lane: "batch", spec: spec() });
    }
    await runtime.idle();
    expect(log.filter((r) => r.type === "image")).toHaveLength(3);
  });
});
