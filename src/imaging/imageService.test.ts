import { describe, expect, it, vi } from "vitest";
import type { CvwWorkerResponse, RenderLane, RenderSpecMessage } from "./cvwProtocol";
import { buildSyntheticCvw, gaussianBlob } from "./cvwFixture";
import { createCvwWorkerRuntime } from "./cvwWorkerRuntime";
import { ImageService, RenderCancelled, type ImageWorkerLike } from "./imageService";
import type { CvwImageSource } from "./imageSource";
import { defaultChannelDisplay } from "./imageWallSettings";
import { memoryFile } from "../testDirectory";

const names = new Map<number, string>([[2, "LightLoss (Imaging)"], [3, "FSC"], [4, "SSC (Imaging)"], [5, "A"], [6, "B"], [7, "C"]]);

const sscBlob = gaussianBlob(50, 512, 6, 260);
const bytes = buildSyntheticCvw([
  { samples: 1024, carriers: Array.from({ length: 20 }, (_, i) => ({ slot: 4, row: 40 + i, amplitude: sscBlob(40 + i) })) },
  { noWaveform: true },
  { samples: 768 },
]);

const source = (): CvwImageSource => ({
  kind: "cvw",
  fileName: "tube A.cvw",
  file: memoryFile("tube A.cvw", bytes),
  handle: null,
  eventCount: 3,
  recordingId: "r",
  channelNames: names,
  pixelAspectRatio: 0.3,
  display: defaultChannelDisplay(names),
  mask: { slot: 4, fraction: 8192 / 65535 },
});

const spec = (over: Partial<RenderSpecMessage> = {}): RenderSpecMessage => ({
  display: defaultChannelDisplay(names),
  scale: { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 },
  exposure: 1,
  hop: 16,
  composite: true,
  channels: [],
  ...over,
});

/** A worker running the real runtime in-process, answering on a microtask like a real one. */
class RuntimeWorker implements ImageWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: unknown[] = [];
  terminated = false;
  private readonly runtime = createCvwWorkerRuntime({
    emit: (response) => { queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<unknown>)); },
    yieldToEventLoop: async () => undefined,
    makeBitmap: async () => null,
  });
  constructor(readonly lane: RenderLane | "count") {}
  postMessage(message: unknown): void {
    this.sent.push(message);
    this.runtime.dispatch(message);
  }
  terminate(): void { this.terminated = true; }
  idle(): Promise<void> { return this.runtime.idle(); }
}

function serviceWithWorkers(options: ConstructorParameters<typeof ImageService>[0] = {}) {
  const workers: RuntimeWorker[] = [];
  const service = new ImageService({
    workerFactory: (lane) => { const w = new RuntimeWorker(lane); workers.push(w); return w; },
    timeoutMs: 0,
    // One worker unless a test asks for the pool: the lane tests count workers by lane.
    countWorkers: 1,
    ...options,
  });
  return { service, workers };
}

describe("ImageService", () => {
  it("opens a file on first use and reports what it holds", async () => {
    const { service, workers } = serviceWithWorkers();
    service.attach("f1", source());
    const info = await service.info("f1");
    expect(info.eventCount).toBe(3);
    expect(info.imageCount).toBe(2);
    expect(Array.from(info.hasImage)).toEqual([1, 0, 1]);
    expect(workers.map((w) => w.lane)).toEqual(["interactive"]);
    expect(service.knownInfo("f1")).toBe(info);
  });

  it("renders, caches, and serves the cached picture at once", async () => {
    const { service, workers } = serviceWithWorkers();
    service.attach("f1", source());
    const first = await service.render("f1", 0, spec(), "interactive").promise;
    expect(first.kind).toBe("image");
    if (first.kind !== "image") return;
    expect(first.image.cols).toBe(49);
    const renders = workers[0].sent.filter((m) => (m as { type: string }).type === "render");
    expect(renders).toHaveLength(1);
    expect(service.cached("f1", 0, spec())).toBe(first);
    const again = await service.render("f1", 0, spec(), "interactive").promise;
    expect(again).toBe(first);
    expect(workers[0].sent.filter((m) => (m as { type: string }).type === "render")).toHaveLength(1);
    // A different setting is a different picture.
    const other = await service.render("f1", 0, spec({ exposure: 2 }), "interactive").promise;
    expect(other).not.toBe(first);
  });

  it("answers no-image for an event without one, and caches that too", async () => {
    const { service } = serviceWithWorkers();
    service.attach("f1", source());
    expect(await service.render("f1", 1, spec(), "batch").promise).toEqual({ kind: "no-image" });
    expect(service.cached("f1", 1, spec())).toEqual({ kind: "no-image" });
  });

  it("uses one worker per lane and opens the file on each", async () => {
    const { service, workers } = serviceWithWorkers();
    service.attach("f1", source());
    await service.render("f1", 0, spec(), "interactive").promise;
    await service.render("f1", 2, spec(), "batch").promise;
    expect(workers.map((w) => w.lane)).toEqual(["interactive", "batch"]);
    const opens = workers[1].sent.filter((m) => (m as { type: string }).type === "open-source");
    expect(opens).toHaveLength(1);
    expect((opens[0] as { scaleSample?: number }).scaleSample).toBe(0);
  });

  it("shares one request between callers and cancels it only when every caller has", async () => {
    const { service, workers } = serviceWithWorkers();
    service.attach("f1", source());
    service.suspend("batch");
    const a = service.render("f1", 2, spec(), "batch");
    const b = service.render("f1", 2, spec(), "batch");
    a.cancel();
    await expect(a.promise).rejects.toBeInstanceOf(RenderCancelled);
    service.resume("batch");
    const result = await b.promise;
    expect(result.kind).toBe("image");
    expect(workers[0].sent.filter((m) => (m as { type: string }).type === "render")).toHaveLength(1);
  });

  it("holds batch work while suspended and sends it on resume", async () => {
    const { service, workers } = serviceWithWorkers();
    service.attach("f1", source());
    service.suspend("batch");
    const handle = service.render("f1", 2, spec(), "batch");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(workers).toHaveLength(0);
    service.resume("batch");
    expect((await handle.promise).kind).toBe("image");
  });

  it("cancels a sent request at the worker, and rejects the caller", async () => {
    const { service, workers } = serviceWithWorkers();
    service.attach("f1", source());
    await service.info("f1");
    const handle = service.render("f1", 2, spec(), "interactive");
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    handle.cancel();
    await expect(handle.promise).rejects.toBeInstanceOf(RenderCancelled);
    await workers[0].idle();
    expect(workers[0].sent.some((m) => (m as { type: string }).type === "cancel")).toBe(true);
  });

  it("rejects a render for a file that is attached but not found", async () => {
    const { service } = serviceWithWorkers();
    service.attach("f1", { ...source(), file: null });
    await expect(service.render("f1", 0, spec(), "interactive").promise).rejects.toThrow(/has not been found/);
  });

  it("rejects a file the worker refuses", async () => {
    const { service } = serviceWithWorkers();
    service.attach("f1", { ...source(), eventCount: 9 });
    await expect(service.info("f1")).rejects.toThrow(/3 events and the FCS has 9/);
  });

  it("times out a request the worker never answers", async () => {
    vi.useFakeTimers();
    try {
      const silent: ImageWorkerLike = { onmessage: null, postMessage: () => undefined, terminate: () => undefined };
      const service = new ImageService({ workerFactory: () => silent, timeoutMs: 50 });
      service.attach("f1", source());
      const info = service.info("f1");
      let settled = false;
      info.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(100);
      // Opening never answers either; the render that waits on it is what times out.
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches a file: drops it at the workers and forgets its pictures", async () => {
    const { service, workers } = serviceWithWorkers();
    service.attach("f1", source());
    await service.render("f1", 0, spec(), "interactive").promise;
    service.detach("f1");
    expect(service.hasSource("f1")).toBe(false);
    expect(service.cached("f1", 0, spec())).toBeNull();
    expect(workers[0].sent.some((m) => (m as { type: string }).type === "drop-source")).toBe(true);
  });

  it("disposes: terminates the workers and rejects what was pending", async () => {
    const { service, workers } = serviceWithWorkers();
    service.attach("f1", source());
    service.suspend("interactive");
    const handle = service.render("f1", 0, spec(), "interactive");
    await service.info("f1").catch(() => undefined);
    service.dispose();
    await expect(handle.promise).rejects.toBeInstanceOf(RenderCancelled);
    expect(workers.every((w) => w.terminated)).toBe(true);
    expect(service.hasSource("f1")).toBe(false);
  });

  it("evicts the oldest pictures beyond its budget", async () => {
    const { service } = serviceWithWorkers({ bitmapBudgetBytes: 104 * 49 * 4 + 10 });
    service.attach("f1", source());
    const first = await service.render("f1", 0, spec(), "batch").promise;
    expect(service.cached("f1", 0, spec())).toBe(first);
    await service.render("f1", 2, spec(), "batch").promise;
    expect(service.cached("f1", 0, spec())).toBeNull();
  });

  it("classifies a file once for every caller, with progress, and remembers the result", async () => {
    const { service, workers } = serviceWithWorkers();
    service.attach("f1", source());
    const progress: number[] = [];
    const a = service.classify("f1", (done) => progress.push(done));
    const b = service.classify("f1");
    const result = await a.promise;
    expect(await b.promise).toBe(result);
    expect(Array.from(result.objectCount)).toEqual([1, 255, 0]);
    expect(progress.at(-1)).toBe(3);
    expect(service.classification("f1")).toBe(result);
    expect(workers.filter((w) => w.lane === "batch")).toHaveLength(1);
    expect(workers[0].sent.filter((m) => (m as { type: string }).type === "classify")).toHaveLength(1);
    const again = service.classify("f1");
    expect(await again.promise).toBe(result);
    service.detach("f1");
    expect(service.classification("f1")).toBeNull();
  });

  it("classifies on a batch lane that opened without measuring, carrying the known scale", async () => {
    const { service, workers } = serviceWithWorkers();
    service.attach("f1", source());
    await service.info("f1");
    const result = await service.classify("f1").promise;
    expect(Array.from(result.objectCount)).toEqual([1, 255, 0]);
    const batch = workers.find((w) => w.lane === "batch")!;
    expect((batch.sent.find((m) => (m as { type: string }).type === "open-source") as { scaleSample?: number }).scaleSample).toBe(0);
    const sent = batch.sent.find((m) => (m as { type: string }).type === "classify") as { options?: { scale?: Record<number, number> } };
    expect(sent.options?.scale?.[4]).toBeGreaterThan(0);
  });

  it("splits a count over a pool of workers, a range each, and joins it to what one worker finds", async () => {
    // 600 events: a blob, no waveform, an empty picture, over and over.
    const many = buildSyntheticCvw(Array.from({ length: 600 }, (_, i) => (i % 3 === 0
      ? { samples: 1024, carriers: Array.from({ length: 20 }, (_, r) => ({ slot: 4, row: 40 + r, amplitude: sscBlob(40 + r) })) }
      : i % 3 === 1 ? { noWaveform: true } : { samples: 768 })));
    const big = (): CvwImageSource => ({ ...source(), fileName: "tube B.cvw", file: memoryFile("tube B.cvw", many), eventCount: 600 });
    const alone = serviceWithWorkers();
    alone.service.attach("f1", big());
    const one = await alone.service.classify("f1").promise;
    const pooled = serviceWithWorkers({ countWorkers: 3 });
    pooled.service.attach("f1", big());
    const progress: number[] = [];
    const split = await pooled.service.classify("f1", (done) => progress.push(done)).promise;
    // Three pool workers, each counting its own third; the batch lane only opened the file.
    const count = pooled.workers.filter((w) => w.lane === "count");
    expect(count).toHaveLength(3);
    const ranges = count.map((w) => (w.sent.find((m) => (m as { type: string }).type === "classify") as { options: { range: { start: number; end: number } } }).options.range);
    expect(ranges).toEqual([{ start: 0, end: 200 }, { start: 200, end: 400 }, { start: 400, end: 600 }]);
    expect(pooled.workers.find((w) => w.lane === "batch")!.sent.some((m) => (m as { type: string }).type === "classify")).toBe(false);
    // The joined answer is the single worker's, event for event.
    expect(Array.from(split.objectCount)).toEqual(Array.from(one.objectCount));
    expect(Array.from(split.objectArea)).toEqual(Array.from(one.objectArea));
    expect(Object.keys(split.features!).sort()).toEqual(Object.keys(one.features!).sort());
    for (const key of Object.keys(one.features!)) expect(Array.from(split.features![key])).toEqual(Array.from(one.features![key]));
    expect(split.objectCount[0]).toBe(1);
    expect(split.objectCount[1]).toBe(255);
    expect(progress.at(-1)).toBe(600);
    expect(progress.every((d, k) => k === 0 || d >= progress[k - 1] - 200)).toBe(true);
    // A second file reuses the pool.
    pooled.service.attach("f2", big());
    await pooled.service.classify("f2").promise;
    expect(pooled.workers.filter((w) => w.lane === "count")).toHaveLength(3);
  });

  it("stops every share of a split count when it is cancelled", async () => {
    const many = buildSyntheticCvw(Array.from({ length: 600 }, () => ({ samples: 768 })));
    const { service, workers } = serviceWithWorkers({ countWorkers: 2 });
    service.attach("f1", { ...source(), file: memoryFile("tube C.cvw", many), eventCount: 600 });
    const handle = service.classify("f1");
    // Let the shares start, then cancel.
    for (let i = 0; i < 10_000 && workers.filter((w) => w.lane === "count" && w.sent.some((m) => (m as { type: string }).type === "classify")).length < 2; i++) {
      await Promise.resolve();
    }
    handle.cancel();
    await expect(handle.promise).rejects.toBeInstanceOf(RenderCancelled);
    const pool = workers.filter((w) => w.lane === "count");
    expect(pool).toHaveLength(2);
    for (const w of pool) {
      const classify = w.sent.find((m) => (m as { type: string }).type === "classify") as { requestId: string };
      const cancel = w.sent.find((m) => (m as { type: string }).type === "cancel") as { requestIds: string[] } | undefined;
      expect(cancel?.requestIds).toContain(classify.requestId);
    }
    expect(service.classification("f1")).toBeNull();
    service.dispose();
    expect(pool.every((w) => w.terminated)).toBe(true);
  });

  it("stops a classification when its last caller cancels", async () => {
    const { service, workers } = serviceWithWorkers();
    service.attach("f1", source());
    service.suspend("batch");
    const a = service.classify("f1");
    const b = service.classify("f1");
    a.cancel();
    expect(service.classification("f1")).toBeNull();
    b.cancel();
    await expect(b.promise).rejects.toBeInstanceOf(RenderCancelled);
    await expect(a.promise).rejects.toBeInstanceOf(RenderCancelled);
    service.resume("batch");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(workers.every((w) => !w.sent.some((m) => (m as { type: string }).type === "classified"))).toBe(true);
  });

  it("ignores a response that has no protocol tag", async () => {
    const { service, workers } = serviceWithWorkers();
    service.attach("f1", source());
    await service.info("f1");
    expect(() => workers[0].onmessage?.({ data: { type: "image" } } as MessageEvent<unknown>)).not.toThrow();
    expect(() => workers[0].onmessage?.({ data: null } as MessageEvent<unknown>)).not.toThrow();
    const stray: CvwWorkerResponse = { protocol: "gatelab.cvw-worker.v1", type: "cancelled", requestId: "never" };
    expect(() => workers[0].onmessage?.({ data: stray } as MessageEvent<unknown>)).not.toThrow();
  });
});
