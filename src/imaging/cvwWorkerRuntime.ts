// cvwWorkerRuntime.ts — everything the image worker does, in a form the tests can drive without
// a Worker (cvw.worker.ts is the thin shell). It opens waveform files, keeps their indexes, reads
// one event's block at a time, decodes it, renders it under the display settings it was asked
// for, and answers with a bitmap or the raw pixels. Two lanes: "interactive" (hover) is
// latest-wins, so a request that is already behind the cursor is dropped before a byte is read;
// "batch" (the wall) is first in, first out, yielding between items so a cancel can land.

import { type CvwFile, cvwBlockRange, hasImageFlags, openCvw } from "./cvw";
import { NATIVE_HOP, decodeEvent, type ImagePlanes } from "./cvwDecode";
import {
  CVW_WORKER_PROTOCOL,
  isCvwWorkerRequest,
  responseTransferables,
  type CvwWorkerEmit,
  type CvwWorkerRequest,
  type CvwWorkerResponse,
  type OpenSourceRequest,
  type ClassifyRequest,
  type RenderedPicture,
  type RenderRequest,
} from "./cvwProtocol";
import { MASK_FEATURE_KEYS, OBJECT_CLASS_UNKNOWN, countObjectsWithMask, countedMask, maskFeatures, planeOf, sscSlotOf } from "./objectCount";
import { readRange } from "./readRange";
import { channelRgba, compositeRgba, measureScale, paintOutline, type RenderSpec } from "./render";
import { readTiffPages } from "./tiff";
import { planesFromTiff, tiffChannelNames, tiffEventIndexOf, tiffFileNameFor, tiffLightLossSlot, tiffSubfolderFor } from "./tiffFolder";

export type MakeBitmap = (pixels: Uint8ClampedArray, width: number, height: number) => Promise<ImageBitmap | null>;

export interface CvwWorkerRuntimeOptions {
  readonly emit: CvwWorkerEmit;
  /** Test seam; production yields to a macrotask so cancel messages can run between items. */
  readonly yieldToEventLoop?: () => Promise<void>;
  /** How many bytes of decoded planes to keep; 64 MB by default. */
  readonly planeBudgetBytes?: number;
  /** How a picture becomes a bitmap; null means "send the pixels". */
  readonly makeBitmap?: MakeBitmap;
}

interface CvwOpenSource {
  readonly kind: "cvw";
  readonly file: CvwFile;
  readonly flags: Uint8Array;
  scale: Record<number, number>;
}

/** A folder of extracted TIFFs: one file per imaged event, read on demand. */
interface TiffOpenSource {
  readonly kind: "tiff";
  readonly getFile: (eventIndex: number) => Promise<Blob | null>;
  readonly flags: Uint8Array;
  readonly channelNames: Map<number, string>;
  readonly lightLossSlot: number | null;
  scale: Record<number, number>;
}

type OpenSource = CvwOpenSource | TiffOpenSource;

/** The directory iteration the File System Access API gives and the DOM lib does not declare. */
type IterableDirectoryHandle = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };

const channelNamesOf = (source: OpenSource): ReadonlyMap<number, string> =>
  source.kind === "cvw" ? source.file.metadata.channelNames : source.channelNames;

interface CachedPlanes {
  readonly planes: ImagePlanes;
  readonly bytes: number;
}

const DEFAULT_PLANE_BUDGET = 64 * 1024 * 1024;
const DEFAULT_SCALE_SAMPLE = 48;

const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** createImageBitmap from RGBA bytes where the worker has it; otherwise the caller gets pixels. */
const defaultMakeBitmap: MakeBitmap = async (pixels, width, height) => {
  if (typeof createImageBitmap !== "function" || typeof ImageData !== "function") return null;
  try {
    // The pixels are always a fresh, unshared buffer; the lib types cannot see that.
    return await createImageBitmap(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height));
  } catch {
    return null;
  }
};

const planeBytes = (planes: ImagePlanes): number => planes.planes.reduce((n, p) => n + p.byteLength, 0);

export interface CvwWorkerRuntime {
  dispatch(message: unknown): void;
  /** Settles when nothing is queued or running; for the tests. */
  idle(): Promise<void>;
}

export function createCvwWorkerRuntime(options: CvwWorkerRuntimeOptions): CvwWorkerRuntime {
  const emit = (response: CvwWorkerResponse) => options.emit(response, responseTransferables(response));
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYield;
  const makeBitmap = options.makeBitmap ?? defaultMakeBitmap;
  let planeBudget = options.planeBudgetBytes ?? DEFAULT_PLANE_BUDGET;

  const sources = new Map<string, OpenSource>();
  const opening = new Map<string, Promise<void>>();
  const planes = new Map<string, CachedPlanes>();
  let planesHeld = 0;
  const cancelled = new Set<string>();
  const interactive: RenderRequest[] = [];
  const batch: RenderRequest[] = [];
  const classifyQueue: ClassifyRequest[] = [];
  let latestHoverSeq = -1;
  let pumping: Promise<void> | null = null;

  const tag = { protocol: CVW_WORKER_PROTOCOL } as const;

  function rememberPlanes(key: string, image: ImagePlanes): void {
    const bytes = planeBytes(image);
    if (bytes > planeBudget) return;
    const existing = planes.get(key);
    if (existing) {
      planes.delete(key);
      planesHeld -= existing.bytes;
    }
    while (planesHeld + bytes > planeBudget && planes.size > 0) {
      const oldest = planes.keys().next().value as string;
      planesHeld -= planes.get(oldest)!.bytes;
      planes.delete(oldest);
    }
    planes.set(key, { planes: image, bytes });
    planesHeld += bytes;
  }

  function takePlanes(key: string): ImagePlanes | null {
    const hit = planes.get(key);
    if (!hit) return null;
    // Refresh: a Map iterates in insertion order, so re-inserting makes it the newest.
    planes.delete(key);
    planes.set(key, hit);
    return hit.planes;
  }

  async function decodeAt(source: OpenSource, fileKey: string, eventIndex: number, hop: number): Promise<ImagePlanes | null> {
    // An extracted TIFF has one resolution, so the hop is not part of its key.
    const key = source.kind === "tiff" ? `${fileKey}:${eventIndex}:tiff` : `${fileKey}:${eventIndex}:${hop}`;
    const cached = takePlanes(key);
    if (cached) return cached;
    let image: ImagePlanes;
    if (source.kind === "tiff") {
      if (!source.flags[eventIndex]) return null;
      const blob = await source.getFile(eventIndex);
      if (!blob) return null;
      image = planesFromTiff(readTiffPages(await blob.arrayBuffer()));
    } else {
      const range = cvwBlockRange(source.file, eventIndex);
      if (!range) return null;
      const block = await readRange(source.file.source, range.offset, range.length);
      image = decodeEvent(block, source.file.metadata, { hop });
    }
    rememberPlanes(key, image);
    return image;
  }

  /** The full scale per channel, from a spread of imaged events. */
  async function measureSourceScale(source: OpenSource, fileKey: string, wanted: number, noFloorSlots: number[]): Promise<Record<number, number>> {
    const imaged: number[] = [];
    for (let i = 0; i < source.flags.length; i++) if (source.flags[i]) imaged.push(i);
    const step = Math.max(1, Math.floor(imaged.length / wanted));
    const sample: ImagePlanes[] = [];
    for (let k = 0; k < imaged.length && sample.length < wanted; k += step) {
      const image = await decodeAt(source, fileKey, imaged[k], NATIVE_HOP);
      if (image) sample.push(image);
    }
    return measureScale(sample, undefined, undefined, noFloorSlots);
  }

  /** A folder of extracted TIFFs: which events have a file, their channels from the first file, and the scale. */
  async function openTiff(request: OpenSourceRequest): Promise<void> {
    const spec = request.source;
    if (spec.kind !== "tiff-folder" && spec.kind !== "tiff-files") return;
    const flags = new Uint8Array(request.eventCount);
    let count = 0;
    const note = (e: number): boolean => {
      if (e >= request.eventCount) {
        emit({ ...tag, type: "source-error", fileKey: request.fileKey, message: `the folder names event ${e.toLocaleString()} but the FCS has ${request.eventCount.toLocaleString()} events; it is not this file's` });
        return false;
      }
      if (!flags[e]) { flags[e] = 1; count++; }
      return true;
    };
    let getFile: (eventIndex: number) => Promise<Blob | null>;
    if (spec.kind === "tiff-files") {
      for (const key of Object.keys(spec.files)) if (!note(Number(key))) return;
      getFile = async (e) => spec.files[e] ?? null;
    } else {
      const { handle, naming } = spec;
      const dirs: FileSystemDirectoryHandle[] = [];
      if (naming.layout === "subfolders") {
        for await (const entry of (handle as IterableDirectoryHandle).values()) if (entry.kind === "directory" && /^\d{8}$/.test(entry.name)) dirs.push(entry as FileSystemDirectoryHandle);
      } else dirs.push(handle);
      for (const dir of dirs) {
        for await (const entry of (dir as IterableDirectoryHandle).values()) {
          if (entry.kind !== "file") continue;
          const e = tiffEventIndexOf(entry.name, naming);
          if (e !== null && !note(e)) return;
        }
      }
      getFile = async (e) => {
        try {
          const dir = naming.layout === "subfolders" ? await handle.getDirectoryHandle(tiffSubfolderFor(e)) : handle;
          return await (await dir.getFileHandle(tiffFileNameFor(naming, e))).getFile();
        } catch {
          return null;
        }
      };
    }
    if (count === 0) {
      emit({ ...tag, type: "source-error", fileKey: request.fileKey, message: "the folder holds no files named like the extractor's (<name>_<event number>.tiff)" });
      return;
    }
    const first = flags.indexOf(1);
    const blob = await getFile(first);
    if (!blob) {
      emit({ ...tag, type: "source-error", fileKey: request.fileKey, message: `the folder's file for event ${first} could not be read` });
      return;
    }
    const pages = readTiffPages(await blob.arrayBuffer());
    const source: TiffOpenSource = { kind: "tiff", getFile, flags, channelNames: tiffChannelNames(pages), lightLossSlot: tiffLightLossSlot(pages), scale: {} };
    sources.set(request.fileKey, source);
    const wanted = request.scaleSample ?? DEFAULT_SCALE_SAMPLE;
    if (wanted > 0) source.scale = await measureSourceScale(source, request.fileKey, wanted, source.lightLossSlot === null ? [] : [source.lightLossSlot]);
    emit({
      ...tag,
      type: "source-ready",
      fileKey: request.fileKey,
      eventCount: request.eventCount,
      imageCount: count,
      hasImage: flags.slice(),
      scale: source.scale,
      channelNames: Object.fromEntries(source.channelNames),
      pixelAspectRatio: 0.3,
      recordingId: "",
    });
  }

  async function openSource(request: OpenSourceRequest): Promise<void> {
    try {
      if (request.source.kind === "tiff-folder" || request.source.kind === "tiff-files") {
        await openTiff(request);
        return;
      }
      const file = await openCvw(request.source);
      if (file.header.eventCount !== request.eventCount) {
        emit({
          ...tag,
          type: "source-error",
          fileKey: request.fileKey,
          message: `the waveform file has ${file.header.eventCount.toLocaleString()} events and the FCS has ${request.eventCount.toLocaleString()}`,
        });
        return;
      }
      const flags = hasImageFlags(file.index);
      const source: CvwOpenSource = { kind: "cvw", file, flags, scale: {} };
      sources.set(request.fileKey, source);
      // Full scale per channel, from a spread of imaged events decoded at the thumbnail hop. Light
      // loss is transmitted light: its background is the signal, so no noise floor.
      const wanted = request.scaleSample ?? DEFAULT_SCALE_SAMPLE;
      if (wanted > 0) source.scale = await measureSourceScale(source, request.fileKey, wanted, [file.metadata.lasers[0].lightlossIndex]);
      let imageCount = 0;
      for (let i = 0; i < flags.length; i++) imageCount += flags[i];
      emit({
        ...tag,
        type: "source-ready",
        fileKey: request.fileKey,
        eventCount: file.header.eventCount,
        imageCount,
        hasImage: flags.slice(),
        scale: source.scale,
        channelNames: Object.fromEntries(file.metadata.channelNames),
        pixelAspectRatio: file.metadata.lasers[0].pixelAspectRatio,
        recordingId: file.metadata.recordingId,
      });
    } catch (cause) {
      emit({ ...tag, type: "source-error", fileKey: request.fileKey, message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  async function picture(pixels: Uint8ClampedArray, width: number, height: number): Promise<RenderedPicture> {
    const bitmap = await makeBitmap(pixels, width, height);
    return bitmap ? { width, height, bitmap } : { width, height, pixels };
  }

  async function render(request: RenderRequest): Promise<void> {
    if (cancelled.delete(request.requestId)) {
      emit({ ...tag, type: "cancelled", requestId: request.requestId });
      return;
    }
    if (request.lane === "interactive" && (request.hoverSeq ?? 0) < latestHoverSeq) {
      emit({ ...tag, type: "cancelled", requestId: request.requestId });
      return;
    }
    const pending = opening.get(request.fileKey);
    if (pending) await pending;
    // The cursor may have moved on while the file was opening.
    if (request.lane === "interactive" && (request.hoverSeq ?? 0) < latestHoverSeq) {
      emit({ ...tag, type: "cancelled", requestId: request.requestId });
      return;
    }
    const source = sources.get(request.fileKey);
    if (!source) {
      emit({ ...tag, type: "error", requestId: request.requestId, message: "the waveform file is not open", retryable: true });
      return;
    }
    try {
      const image = await decodeAt(source, request.fileKey, request.eventIndex, request.spec.hop);
      if (!image) {
        emit({ ...tag, type: "no-image", requestId: request.requestId, fileKey: request.fileKey, eventIndex: request.eventIndex });
        return;
      }
      if (cancelled.delete(request.requestId) || (request.lane === "interactive" && (request.hoverSeq ?? 0) < latestHoverSeq)) {
        emit({ ...tag, type: "cancelled", requestId: request.requestId });
        return;
      }
      const spec: RenderSpec = { display: request.spec.display, scale: request.spec.scale, exposure: request.spec.exposure };
      // The outline of the counted objects, from the same mask the object count uses, at this hop.
      let outline: Uint8Array | null = null;
      if (request.spec.outline) {
        const slot = request.spec.outline.slot ?? sscSlotOf(channelNamesOf(source));
        const maskScale = request.spec.scale[slot] ?? source.scale[slot] ?? 0;
        const plane = planeOf(image.planes, image.slots, slot);
        if (plane && maskScale > 0) {
          const minArea = Math.max(4, Math.round(20 * NATIVE_HOP / Math.max(1, request.spec.hop)));
          outline = countedMask(plane, image.rows, image.cols, maskScale, { fraction: request.spec.outline.fraction, minArea });
        }
      }
      const outlined = (rgba: Uint8ClampedArray): Uint8ClampedArray => {
        if (outline) paintOutline(rgba, outline, image.rows, image.cols);
        return rgba;
      };
      const composite = request.spec.composite
        ? await picture(outlined(compositeRgba(image, spec)), image.cols, image.rows)
        : null;
      const channels: Record<number, RenderedPicture> = {};
      for (const slot of request.spec.channels) {
        channels[slot] = await picture(outlined(channelRgba(image, spec, slot)), image.cols, image.rows);
      }
      emit({
        ...tag,
        type: "image",
        requestId: request.requestId,
        fileKey: request.fileKey,
        eventIndex: request.eventIndex,
        rows: image.rows,
        cols: image.cols,
        aspect: image.aspect,
        composite,
        channels,
      });
    } catch (cause) {
      emit({
        ...tag,
        type: "error",
        requestId: request.requestId,
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
      });
    }
  }

  /**
   * Count the objects of every imaged event. Runs between renders, in slices, so a hover is
   * never held up by it and a cancel lands between slices; progress goes out every slice.
   */
  async function classify(request: ClassifyRequest): Promise<void> {
    const source = sources.get(request.fileKey);
    if (!source) {
      emit({ ...tag, type: "error", requestId: request.requestId, message: "the waveform file is not open", retryable: true });
      return;
    }
    const { flags } = source;
    const total = flags.length;
    const objectCount = new Uint8Array(total).fill(OBJECT_CLASS_UNKNOWN);
    const objectArea = new Uint32Array(total);
    const features: Record<string, Float32Array> = Object.fromEntries(MASK_FEATURE_KEYS.map((key) => [key, new Float32Array(total)]));
    const ssc = request.options?.slot ?? sscSlotOf(channelNamesOf(source));
    const scale = request.options?.scale?.[ssc] ?? source.scale[ssc] ?? 0;
    if (!(scale > 0)) {
      emit({ ...tag, type: "error", requestId: request.requestId, message: "the file's full scale is not known yet", retryable: true });
      return;
    }
    const slice = 48;
    try {
      for (let start = 0; start < total; start += slice) {
        if (cancelled.delete(request.requestId)) {
          emit({ ...tag, type: "cancelled", requestId: request.requestId });
          return;
        }
        // A hover that arrived meanwhile goes first.
        while (interactive.length > 0) {
          await render(interactive.shift()!);
        }
        const end = Math.min(total, start + slice);
        for (let i = start; i < end; i++) {
          if (!flags[i]) continue;
          let image: ImagePlanes | null;
          if (source.kind === "cvw") {
            // One slot straight from the block, without keeping the planes.
            const range = cvwBlockRange(source.file, i);
            if (!range) continue;
            const block = await readRange(source.file.source, range.offset, range.length);
            image = decodeEvent(block, source.file.metadata, { hop: NATIVE_HOP, slots: [ssc] });
          } else {
            image = await decodeAt(source, request.fileKey, i, NATIVE_HOP);
          }
          if (!image) continue;
          const plane = planeOf(image.planes, image.slots, ssc);
          if (!plane) continue;
          const result = countObjectsWithMask(plane, image.rows, image.cols, scale, request.options);
          objectCount[i] = Math.min(254, result.count);
          objectArea[i] = result.totalArea;
          const measured = maskFeatures(result.mask, plane, image.rows, image.cols, image.aspect, scale);
          for (const key of MASK_FEATURE_KEYS) features[key][i] = measured[key];
        }
        emit({ ...tag, type: "classify-progress", requestId: request.requestId, fileKey: request.fileKey, done: end, total });
        await yieldToEventLoop();
      }
      // A cancel that arrived during the last slice still wins.
      if (cancelled.delete(request.requestId)) {
        emit({ ...tag, type: "cancelled", requestId: request.requestId });
        return;
      }
      emit({ ...tag, type: "classified", requestId: request.requestId, fileKey: request.fileKey, objectCount, objectArea, features });
    } catch (cause) {
      emit({ ...tag, type: "error", requestId: request.requestId, message: cause instanceof Error ? cause.message : String(cause), retryable: false });
    }
  }

  async function pump(): Promise<void> {
    while (interactive.length > 0 || batch.length > 0 || classifyQueue.length > 0) {
      const next = interactive.shift() ?? batch.shift();
      if (next) {
        if (cancelled.delete(next.requestId)) {
          // A request cancelled while queued costs nothing: answer it and take the next one without
          // yielding, or a wall of a few thousand tiles that was hidden holds the lane for seconds.
          emit({ ...tag, type: "cancelled", requestId: next.requestId });
          continue;
        }
        await render(next);
      } else {
        const job = classifyQueue.shift()!;
        const pending = opening.get(job.fileKey);
        if (pending) await pending;
        await classify(job);
      }
      await yieldToEventLoop();
    }
  }

  function schedule(): void {
    if (pumping) return;
    pumping = pump().finally(() => { pumping = null; if (interactive.length || batch.length || classifyQueue.length) schedule(); });
  }

  function dispatch(message: unknown): void {
    if (!isCvwWorkerRequest(message)) return;
    const request = message as CvwWorkerRequest;
    switch (request.type) {
      case "open-source": {
        const task = openSource(request).finally(() => { if (opening.get(request.fileKey) === task) opening.delete(request.fileKey); });
        opening.set(request.fileKey, task);
        return;
      }
      case "render": {
        if (request.lane === "interactive") {
          latestHoverSeq = Math.max(latestHoverSeq, request.hoverSeq ?? 0);
          interactive.push(request);
        } else {
          batch.push(request);
        }
        schedule();
        return;
      }
      case "classify": {
        classifyQueue.push(request);
        schedule();
        return;
      }
      case "cancel": {
        for (const id of request.requestIds) cancelled.add(id);
        return;
      }
      case "drop-source": {
        sources.delete(request.fileKey);
        for (const key of [...planes.keys()]) {
          if (key.startsWith(`${request.fileKey}:`)) {
            planesHeld -= planes.get(key)!.bytes;
            planes.delete(key);
          }
        }
        return;
      }
      case "set-budget": {
        planeBudget = Math.max(0, request.planeBytes);
        while (planesHeld > planeBudget && planes.size > 0) {
          const oldest = planes.keys().next().value as string;
          planesHeld -= planes.get(oldest)!.bytes;
          planes.delete(oldest);
        }
        return;
      }
    }
  }

  async function idle(): Promise<void> {
    while (pumping || opening.size > 0) {
      await Promise.all([pumping ?? Promise.resolve(), ...opening.values()]);
    }
  }

  return { dispatch, idle };
}
