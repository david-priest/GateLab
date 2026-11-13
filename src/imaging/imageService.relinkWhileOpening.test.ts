// Relinking a sample's cell images while the first file is still opening: the first open's answer
// is ignored, and the sample is described by the file now linked; the worker neither keeps nor answers a dropped open.
import { describe, expect, it } from "vitest";
import { CVW_WORKER_PROTOCOL, type CvwWorkerResponse, type RenderLane } from "./cvwProtocol";
import { buildSyntheticCvw, gaussianBlob } from "./cvwFixture";
import { createCvwWorkerRuntime } from "./cvwWorkerRuntime";
import { ImageService, type ImageWorkerLike } from "./imageService";
import type { CvwImageSource } from "./imageSource";
import { defaultChannelDisplay } from "./imageWallSettings";
import { memoryFile } from "../testDirectory";

const names = new Map<number, string>([[2, "LightLoss (Imaging)"], [3, "FSC"], [4, "SSC (Imaging)"], [5, "A"], [6, "B"], [7, "C"]]);
const blob = gaussianBlob(50, 512, 6, 260);
const imaged = { samples: 1024, carriers: Array.from({ length: 20 }, (_, i) => ({ slot: 4, row: 40 + i, amplitude: blob(40 + i) })) };
const fileA = buildSyntheticCvw([imaged, { noWaveform: true }, { noWaveform: true }]);
const fileB = buildSyntheticCvw([{ noWaveform: true }, imaged, imaged]);

const source = (name: string, bytes: Uint8Array): CvwImageSource => ({
  kind: "cvw", fileName: name, file: memoryFile(name, bytes), handle: null, eventCount: 3, recordingId: "r",
  channelNames: names, pixelAspectRatio: 0.3, display: defaultChannelDisplay(names), mask: null,
});

class RuntimeWorker implements ImageWorkerLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private readonly runtime = createCvwWorkerRuntime({
    emit: (response) => { queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<unknown>)); },
    yieldToEventLoop: async () => undefined,
    makeBitmap: async () => null,
  });
  constructor(readonly lane: RenderLane | "count") {}
  postMessage(message: unknown): void { this.runtime.dispatch(message); }
  terminate(): void {}
}

describe("relinking cell images while the first file opens", () => {
  it("describes the file linked last, and keeps that description", async () => {
    const service = new ImageService({ workerFactory: (lane) => new RuntimeWorker(lane), timeoutMs: 0, countWorkers: 1 });
    service.attach("S1", source("D1_A.cvw", fileA));
    const first = service.info("S1");
    service.detach("S1");
    service.attach("S1", source("D1_B.cvw", fileB));
    const info = await service.info("S1");
    await first.catch(() => undefined);
    expect(Array.from(info.hasImage)).toEqual([0, 1, 1]);
    expect(Array.from(service.knownInfo("S1")!.hasImage)).toEqual([0, 1, 1]);
  });

  it("does not keep or answer an open whose file was dropped before it finished", async () => {
    const log: CvwWorkerResponse[] = [];
    const runtime = createCvwWorkerRuntime({ emit: (response) => { log.push(response); }, yieldToEventLoop: async () => undefined, makeBitmap: async () => null });
    const tag = { protocol: CVW_WORKER_PROTOCOL } as const;
    runtime.dispatch({ ...tag, type: "open-source", fileKey: "S1", source: { kind: "file", file: memoryFile("D1_A.cvw", fileA) }, eventCount: 3, scaleSample: 0 });
    runtime.dispatch({ ...tag, type: "drop-source", fileKey: "S1" });
    await runtime.idle();
    expect(log).toEqual([]);
    runtime.dispatch({ ...tag, type: "render", requestId: "x1", fileKey: "S1", eventIndex: 0, lane: "batch", spec: {
      display: defaultChannelDisplay(names), scale: { 4: 1 }, exposure: 1, hop: 16, composite: true, channels: [4],
    } });
    await runtime.idle();
    expect(log.at(-1)).toMatchObject({ type: "error", requestId: "x1" });
  });
});
