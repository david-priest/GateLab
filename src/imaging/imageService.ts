// imageService.ts — the app's handle on cell images. One per workspace, made the first time an
// image is wanted (App imports this module dynamically), it owns up to two workers, one per lane,
// and a cache of the bitmaps they return, so a cell the cursor has already passed paints at once.
// Nothing here knows about React; the hooks and panels sit on top of `render`.

import type { CellImageSource } from "./imageSource";
import {
  CVW_WORKER_PROTOCOL,
  type CvwWorkerRequest,
  type CvwWorkerResponse,
  type ImageResponse,
  type RenderLane,
  type RenderSpecMessage, type ImageSourceSpec,
} from "./cvwProtocol";
import { renderKey } from "./render";

export interface ImageWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror?: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

export type ImageWorkerFactory = (lane: RenderLane) => ImageWorkerLike;

export interface SourceInfo {
  readonly eventCount: number;
  readonly imageCount: number;
  /** One byte per event, 1 when it has an image. */
  readonly hasImage: Uint8Array;
  readonly scale: Readonly<Record<number, number>>;
  readonly channelNames: Readonly<Record<number, string>>;
  readonly pixelAspectRatio: number;
  readonly recordingId: string;
}

export type RenderResult =
  | { readonly kind: "image"; readonly image: ImageResponse }
  | { readonly kind: "no-image" };

/** Objects counted in every imaged event of a file (objectCount.ts). */
export interface Classification {
  /** Per event; OBJECT_CLASS_UNKNOWN (255) for an event without an image. */
  readonly objectCount: Uint8Array;
  readonly objectArea: Uint32Array;
  /** What the mask measures per event (objectCount.ts MASK_FEATURE_KEYS); absent from an older worker's answer. */
  readonly features?: Readonly<Record<string, Float32Array>>;
}

export interface ClassifyHandle {
  readonly promise: Promise<Classification>;
  cancel(): void;
}

export interface RenderHandle {
  readonly promise: Promise<RenderResult>;
  /** Give the request up; the promise rejects with RenderCancelled unless another caller shares it. */
  cancel(): void;
}

export class RenderCancelled extends Error {
  constructor() {
    super("render cancelled");
    this.name = "RenderCancelled";
  }
}

export interface ImageServiceOptions {
  readonly workerFactory?: ImageWorkerFactory;
  /** Bytes of bitmaps to keep on the main thread; 128 MB by default. */
  readonly bitmapBudgetBytes?: number;
  /** A request older than this is answered with a retryable error; 10 s by default. 0 disables. */
  readonly timeoutMs?: number;
}

interface Waiter {
  readonly resolve: (result: RenderResult) => void;
  readonly reject: (error: Error) => void;
}

interface Pending {
  readonly requestId: string;
  readonly lane: RenderLane;
  readonly cacheKey: string;
  readonly waiters: Waiter[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Sent to the worker already; a cancel after this goes to the worker too. */
  sent: boolean;
}

interface CachedImage {
  readonly result: RenderResult;
  readonly bytes: number;
}

interface Lane {
  worker: ImageWorkerLike | null;
  /** Sources opened on this lane's worker, by file key. */
  readonly opened: Map<string, Promise<SourceInfo>>;
  suspended: boolean;
  /** Requests held while the lane is suspended. */
  readonly held: Array<() => void>;
}

const DEFAULT_BITMAP_BUDGET = 128 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

function defaultWorkerFactory(lane: RenderLane): ImageWorkerLike {
  return new Worker(new URL("./cvw.worker.ts", import.meta.url), { type: "module", name: `gatelab-images-${lane}` }) as ImageWorkerLike;
}

function pictureBytes(image: ImageResponse): number {
  const per = image.cols * image.rows * 4;
  return per * ((image.composite ? 1 : 0) + Object.keys(image.channels).length);
}

function closeBitmaps(result: RenderResult): void {
  if (result.kind !== "image") return;
  result.image.composite?.bitmap?.close?.();
  for (const picture of Object.values(result.image.channels)) picture.bitmap?.close?.();
}

function infoOf(response: CvwWorkerResponse & { type: "source-ready" }): SourceInfo {
  return {
    eventCount: response.eventCount,
    imageCount: response.imageCount,
    hasImage: response.hasImage,
    scale: response.scale,
    channelNames: response.channelNames,
    pixelAspectRatio: response.pixelAspectRatio,
    recordingId: response.recordingId,
  };
}

export class ImageService {
  private readonly factory: ImageWorkerFactory;
  private readonly bitmapBudget: number;
  private readonly timeoutMs: number;
  private readonly lanes: Record<RenderLane, Lane> = {
    interactive: { worker: null, opened: new Map(), suspended: false, held: [] },
    batch: { worker: null, opened: new Map(), suspended: false, held: [] },
  };
  private readonly sources = new Map<string, CellImageSource>();
  private readonly sourceInfo = new Map<string, SourceInfo>();
  private readonly sourceListeners = new Set<(response: CvwWorkerResponse) => void>();
  private readonly pending = new Map<string, Pending>();
  private readonly inflight = new Map<string, Pending>();
  private readonly classifications = new Map<string, Classification>();
  private readonly classifying = new Map<string, {
    readonly requestId: string;
    readonly promise: Promise<Classification>;
    resolve: (c: Classification) => void;
    reject: (e: Error) => void;
    readonly listeners: Set<(done: number, total: number) => void>;
  }>();
  private readonly cache = new Map<string, CachedImage>();
  private cacheHeld = 0;
  private hoverSeq = 0;
  private nextId = 0;
  private disposed = false;

  constructor(options: ImageServiceOptions = {}) {
    this.factory = options.workerFactory ?? defaultWorkerFactory;
    this.bitmapBudget = options.bitmapBudgetBytes ?? DEFAULT_BITMAP_BUDGET;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Register a sample's source; the workers open it when a lane first needs it. */
  attach(fileKey: string, source: CellImageSource): void {
    if (this.sources.get(fileKey) === source) return;
    this.detach(fileKey);
    this.sources.set(fileKey, source);
  }

  detach(fileKey: string): void {
    if (!this.sources.has(fileKey)) return;
    this.sources.delete(fileKey);
    this.sourceInfo.delete(fileKey);
    this.classifications.delete(fileKey);
    const running = this.classifying.get(fileKey);
    if (running) {
      this.classifying.delete(fileKey);
      running.reject(new RenderCancelled());
    }
    for (const lane of Object.values(this.lanes)) {
      lane.opened.delete(fileKey);
      lane.worker?.postMessage({ protocol: CVW_WORKER_PROTOCOL, type: "drop-source", fileKey } satisfies CvwWorkerRequest);
    }
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${fileKey}:`)) this.evict(key);
    }
  }

  hasSource(fileKey: string): boolean {
    return this.sources.has(fileKey);
  }

  /** What the worker found in the file; opens it on the interactive lane if nothing has. */
  info(fileKey: string): Promise<SourceInfo> {
    const known = this.sourceInfo.get(fileKey);
    if (known) return Promise.resolve(known);
    return this.ensureOpen("interactive", fileKey);
  }

  /** What is already known about a file, without waiting. */
  knownInfo(fileKey: string): SourceInfo | null {
    return this.sourceInfo.get(fileKey) ?? null;
  }

  /** The objects counted for a file, when that has been done. */
  classification(fileKey: string): Classification | null {
    return this.classifications.get(fileKey) ?? null;
  }

  /**
   * Count the objects in every imaged event of a file, on the batch lane. One run per file is
   * shared by every caller; `onProgress` is called per slice. Cancelling with no caller left
   * stops the worker.
   */
  classify(fileKey: string, onProgress?: (done: number, total: number) => void): ClassifyHandle {
    const known = this.classifications.get(fileKey);
    if (known) return { promise: Promise.resolve(known), cancel: () => undefined };
    let run = this.classifying.get(fileKey);
    if (!run) {
      const requestId = `cls-${++this.nextId}`;
      let resolve!: (c: Classification) => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<Classification>((res, rej) => { resolve = res; reject = rej; });
      promise.catch(() => undefined);
      run = { requestId, promise, resolve, reject, listeners: new Set() };
      this.classifying.set(fileKey, run);
      const started = run;
      void this.ensureOpen("batch", fileKey).then(() => {
        if (this.classifying.get(fileKey) !== started) return;
        const mask = this.sources.get(fileKey)?.mask ?? null;
        // The batch lane opens without measuring once the file is known, so the scale travels with the request.
        const scale = this.sourceInfo.get(fileKey)?.scale;
        const options = { ...(mask ? { slot: mask.slot, fraction: mask.fraction } : {}), ...(scale ? { scale } : {}) };
        this.lane("batch").worker!.postMessage({
          protocol: CVW_WORKER_PROTOCOL,
          type: "classify",
          requestId,
          fileKey,
          ...(Object.keys(options).length ? { options } : {}),
        } satisfies CvwWorkerRequest);
      }).catch((error: unknown) => {
        if (this.classifying.get(fileKey) !== started) return;
        this.classifying.delete(fileKey);
        started.reject(error instanceof Error ? error : new Error(String(error)));
      });
    }
    const active = run;
    if (onProgress) active.listeners.add(onProgress);
    let cancelled = false;
    return {
      promise: active.promise,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        if (onProgress) active.listeners.delete(onProgress);
        if (active.listeners.size > 0 || this.classifying.get(fileKey) !== active) return;
        this.classifying.delete(fileKey);
        this.lanes.batch.worker?.postMessage({ protocol: CVW_WORKER_PROTOCOL, type: "cancel", requestIds: [active.requestId] } satisfies CvwWorkerRequest);
        active.reject(new RenderCancelled());
      },
    };
  }

  /** The cached result for an event, when there is one, so a hover paints without a round trip. */
  cached(fileKey: string, eventIndex: number, spec: RenderSpecMessage): RenderResult | null {
    const key = this.cacheKey(fileKey, eventIndex, spec);
    const hit = this.cache.get(key);
    if (!hit) return null;
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit.result;
  }

  /** Render one event. The same event under the same settings already in flight is shared. */
  render(fileKey: string, eventIndex: number, spec: RenderSpecMessage, lane: RenderLane): RenderHandle {
    const cacheKey = this.cacheKey(fileKey, eventIndex, spec);
    const hit = this.cached(fileKey, eventIndex, spec);
    if (hit) return { promise: Promise.resolve(hit), cancel: () => undefined };
    const existing = this.inflight.get(cacheKey);
    if (existing && existing.lane === lane) return this.join(existing);
    const requestId = `img-${++this.nextId}`;
    const hoverSeq = lane === "interactive" ? ++this.hoverSeq : undefined;
    const pending: Pending = { requestId, lane, cacheKey, waiters: [], timer: null, sent: false };
    this.pending.set(requestId, pending);
    this.inflight.set(cacheKey, pending);
    const send = () => {
      if (!this.pending.has(requestId)) return;
      void this.ensureOpen(lane, fileKey).then(() => {
        if (!this.pending.has(requestId)) return;
        pending.sent = true;
        if (this.timeoutMs > 0) {
          pending.timer = setTimeout(
            () => this.fail(requestId, new Error("the image worker did not answer; reload the page if this persists")),
            this.timeoutMs,
          );
        }
        this.lane(lane).worker!.postMessage({
          protocol: CVW_WORKER_PROTOCOL,
          type: "render",
          requestId,
          fileKey,
          eventIndex,
          lane,
          ...(hoverSeq !== undefined ? { hoverSeq } : {}),
          spec,
        } satisfies CvwWorkerRequest);
      }).catch((error: unknown) => this.fail(requestId, error instanceof Error ? error : new Error(String(error))));
    };
    const target = this.lanes[lane];
    if (target.suspended) target.held.push(send);
    else send();
    return this.join(pending);
  }

  /** Hold a lane's new work while its view is hidden; nothing already sent is cancelled. */
  suspend(lane: RenderLane): void {
    this.lanes[lane].suspended = true;
  }

  resume(lane: RenderLane): void {
    const target = this.lanes[lane];
    target.suspended = false;
    for (const send of target.held.splice(0)) send();
  }

  dispose(): void {
    this.disposed = true;
    for (const pending of [...this.pending.values()]) {
      this.settle(pending);
      for (const waiter of pending.waiters) waiter.reject(new RenderCancelled());
    }
    for (const lane of Object.values(this.lanes)) {
      lane.worker?.terminate();
      lane.worker = null;
      lane.opened.clear();
      lane.held.length = 0;
    }
    for (const key of [...this.cache.keys()]) this.evict(key);
    for (const run of this.classifying.values()) run.reject(new RenderCancelled());
    this.classifying.clear();
    this.classifications.clear();
    this.sources.clear();
    this.sourceInfo.clear();
  }

  private join(pending: Pending): RenderHandle {
    let waiter: Waiter | null = null;
    const promise = new Promise<RenderResult>((resolve, reject) => {
      waiter = { resolve, reject };
      pending.waiters.push(waiter);
    });
    return {
      promise,
      cancel: () => {
        if (!waiter || !this.pending.has(pending.requestId)) return;
        const at = pending.waiters.indexOf(waiter);
        if (at < 0) return;
        pending.waiters.splice(at, 1);
        waiter.reject(new RenderCancelled());
        if (pending.waiters.length > 0) return;
        this.settle(pending);
        if (pending.sent) {
          this.lanes[pending.lane].worker?.postMessage(
            { protocol: CVW_WORKER_PROTOCOL, type: "cancel", requestIds: [pending.requestId] } satisfies CvwWorkerRequest,
          );
        }
      },
    };
  }

  private cacheKey(fileKey: string, eventIndex: number, spec: RenderSpecMessage): string {
    const outline = (spec.outline ? `|o${spec.outline.slot ?? ""}:${spec.outline.fraction ?? ""}` : "") + (spec.grey && spec.grey.length ? `|g${[...spec.grey].sort((a, b) => a - b).join(",")}` : "");
    const extras = `c${spec.composite ? 1 : 0}|s${[...spec.channels].sort((a, b) => a - b).join(",")}${outline}`;
    return `${fileKey}:${eventIndex}:${renderKey(spec, spec.hop)}|${extras}`;
  }

  private lane(lane: RenderLane): Lane {
    const target = this.lanes[lane];
    if (!target.worker) {
      if (this.disposed) throw new Error("the image service has been disposed");
      const worker = this.factory(lane);
      worker.onmessage = (event) => this.receive(event.data);
      worker.onerror = (event) => {
        for (const pending of [...this.pending.values()]) {
          if (pending.lane !== lane) continue;
          this.fail(pending.requestId, new Error(`the image worker failed${event?.message ? `: ${event.message}` : ""}; reload the page if this persists`));
        }
      };
      target.worker = worker;
    }
    return target;
  }

  private ensureOpen(lane: RenderLane, fileKey: string): Promise<SourceInfo> {
    const target = this.lane(lane);
    const known = target.opened.get(fileKey);
    if (known) return known;
    const source = this.sources.get(fileKey);
    if (!source) return Promise.reject(new Error("no cell images are attached to this file"));
    let spec: ImageSourceSpec;
    if (source.kind === "tiff-folder") {
      if (source.handle) spec = { kind: "tiff-folder", handle: source.handle, naming: source.naming };
      else if (source.files) spec = { kind: "tiff-files", files: source.files };
      else return Promise.reject(new Error(`the cell images folder ${source.fileName} has not been found`));
    } else {
      if (!source.file) return Promise.reject(new Error(`the cell images file ${source.fileName} has not been found`));
      spec = { kind: "file", file: source.file };
    }
    const promise = new Promise<SourceInfo>((resolve, reject) => {
      const listener = (response: CvwWorkerResponse) => {
        if (response.type === "source-ready" && response.fileKey === fileKey) {
          this.sourceListeners.delete(listener);
          const info = infoOf(response);
          // The scale is measured once, by whichever lane opened the file first.
          const merged = this.sourceInfo.get(fileKey) ?? info;
          this.sourceInfo.set(fileKey, merged);
          resolve(merged);
        } else if (response.type === "source-error" && response.fileKey === fileKey) {
          this.sourceListeners.delete(listener);
          target.opened.delete(fileKey);
          reject(new Error(response.message));
        }
      };
      this.sourceListeners.add(listener);
      target.worker!.postMessage({
        protocol: CVW_WORKER_PROTOCOL,
        type: "open-source",
        fileKey,
        source: spec,
        eventCount: source.eventCount,
        ...(this.sourceInfo.has(fileKey) ? { scaleSample: 0 } : {}),
      } satisfies CvwWorkerRequest);
    });
    target.opened.set(fileKey, promise);
    return promise;
  }

  private receive(data: unknown): void {
    const response = data as CvwWorkerResponse;
    if (!response || response.protocol !== CVW_WORKER_PROTOCOL) return;
    if (response.type === "source-ready" || response.type === "source-error") {
      for (const listener of [...this.sourceListeners]) listener(response);
      return;
    }
    if (response.type === "classify-progress" || response.type === "classified") {
      const run = this.classifying.get(response.fileKey);
      if (!run || run.requestId !== response.requestId) return;
      if (response.type === "classify-progress") {
        for (const listener of [...run.listeners]) listener(response.done, response.total);
        return;
      }
      const result: Classification = { objectCount: response.objectCount, objectArea: response.objectArea, features: response.features };
      this.classifications.set(response.fileKey, result);
      this.classifying.delete(response.fileKey);
      run.resolve(result);
      return;
    }
    const classifyRun = [...this.classifying.entries()].find(([, run]) => run.requestId === response.requestId);
    if (classifyRun) {
      const [fileKey, run] = classifyRun;
      this.classifying.delete(fileKey);
      run.reject(response.type === "cancelled" ? new RenderCancelled() : new Error(response.type === "error" ? response.message : "classification failed"));
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) {
      if (response.type === "image") closeBitmaps({ kind: "image", image: response });
      return;
    }
    this.settle(pending);
    if (response.type === "image") {
      const result: RenderResult = { kind: "image", image: response };
      this.remember(pending.cacheKey, result, pictureBytes(response));
      for (const waiter of pending.waiters) waiter.resolve(result);
    } else if (response.type === "no-image") {
      const result: RenderResult = { kind: "no-image" };
      this.remember(pending.cacheKey, result, 0);
      for (const waiter of pending.waiters) waiter.resolve(result);
    } else if (response.type === "cancelled") {
      for (const waiter of pending.waiters) waiter.reject(new RenderCancelled());
    } else {
      for (const waiter of pending.waiters) waiter.reject(new Error(response.message));
    }
  }

  private settle(pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    this.pending.delete(pending.requestId);
    if (this.inflight.get(pending.cacheKey) === pending) this.inflight.delete(pending.cacheKey);
  }

  private fail(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.settle(pending);
    for (const waiter of pending.waiters) waiter.reject(error);
  }

  private remember(key: string, result: RenderResult, bytes: number): void {
    if (bytes > this.bitmapBudget) return;
    if (this.cache.has(key)) this.evict(key);
    while (this.cacheHeld + bytes > this.bitmapBudget && this.cache.size > 0) {
      this.evict(this.cache.keys().next().value as string);
    }
    this.cache.set(key, { result, bytes });
    this.cacheHeld += bytes;
  }

  private evict(key: string): void {
    const hit = this.cache.get(key);
    if (!hit) return;
    this.cache.delete(key);
    this.cacheHeld -= hit.bytes;
    closeBitmaps(hit.result);
  }
}

/** The one service of the page, made on first use. */
let shared: ImageService | null = null;

export function sharedImageService(): ImageService {
  if (!shared) shared = new ImageService();
  return shared;
}

/** Throw the shared service away (a new workspace); the next use makes a fresh one. */
export function resetSharedImageService(): void {
  shared?.dispose();
  shared = null;
}
