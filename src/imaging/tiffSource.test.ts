// The TIFF-folder source end to end: the attach helper on files, the worker on a file set, and
// the workspace record.
import { describe, expect, it } from "vitest";
import { isCellImageRecord } from "../engine/workspace";
import { attachTiffFolder, ImageAttachError } from "./attach";
import { CVW_WORKER_PROTOCOL, type CvwWorkerResponse } from "./cvwProtocol";
import { createCvwWorkerRuntime } from "./cvwWorkerRuntime";
import { imageRecordOf } from "./imageSource";
import { defaultChannelDisplay } from "./imageWallSettings";
import { writeTiffPages } from "./tiff";
import { memoryFile } from "../testDirectory";

const NAMES = ["LightLoss (Imaging)", "FSC", "SSC (Imaging)", "A", "B", "C"];

/** One extracted TIFF: 104 carriers by `rows` time samples, a bright blob on SSC around the middle. */
function tiffFor(eventIndex: number, rows = 20): File {
  const pages = NAMES.map((name, k) => {
    const data = new Float32Array(104 * rows);
    for (let t = 0; t < rows; t++) {
      for (let c = 0; c < 104; c++) {
        const d2 = (c - 50) ** 2 / 36 + (t - rows / 2) ** 2 / 9;
        data[t * 104 + c] = k === 0 ? 30000 - 20000 * Math.exp(-d2) : k === 2 ? 60000 * Math.exp(-d2) : 2000 * Math.exp(-d2) * (k === 3 ? 1 : 0.1);
      }
    }
    return { width: 104, height: rows, name, data, xResolution: 73.3, yResolution: 88 };
  });
  return memoryFile(`Tube A_${String(eventIndex).padStart(8, "0")}.tiff`, writeTiffPages(pages));
}

const fcsTarget = { nEvents: 6, keywords: {} as Record<string, string> };

describe("a folder of extracted TIFFs", () => {
  it("attaches from its files: naming, counts, channels, and a refusal when an index is past the FCS", async () => {
    const files = [tiffFor(0), tiffFor(2), tiffFor(5)];
    const source = await attachTiffFolder({ folderName: "Tube A_images_20261009_1931_27", handle: null, files }, fcsTarget);
    expect(source.kind).toBe("tiff-folder");
    expect(source.naming).toEqual({ prefix: "Tube A_", digits: 8, suffix: ".tiff", layout: "flat" });
    expect(source.imageCount).toBe(3);
    expect(source.eventCount).toBe(6);
    expect([...source.channelNames.entries()]).toEqual([[2, "LightLoss (Imaging)"], [3, "FSC"], [4, "SSC (Imaging)"], [5, "A"], [6, "B"], [7, "C"]]);
    expect(Object.keys(source.files!).map(Number)).toEqual([0, 2, 5]);
    expect(source.display).toEqual(defaultChannelDisplay(source.channelNames, {}));
    await expect(attachTiffFolder({ folderName: "F", handle: null, files: [tiffFor(9)] }, fcsTarget)).rejects.toThrow(ImageAttachError);
    await expect(attachTiffFolder({ folderName: "F", handle: null, files: [memoryFile("notes.txt", new Uint8Array(3))] }, fcsTarget)).rejects.toThrow(/no \.tiff files/);
    const record = imageRecordOf(source);
    expect(record).toEqual({ kind: "tiff-folder", fileName: "Tube A_images_20261009_1931_27", eventCount: 6, naming: source.naming });
    expect(isCellImageRecord(record)).toBe(true);
    expect(isCellImageRecord({ kind: "tiff-folder", fileName: "F", eventCount: 6 })).toBe(false);
  });

  it("is opened, rendered and classified by the worker from a file set", async () => {
    const log: CvwWorkerResponse[] = [];
    const runtime = createCvwWorkerRuntime({ emit: (r) => { log.push(r); }, yieldToEventLoop: async () => undefined, makeBitmap: async () => null });
    const tag = { protocol: CVW_WORKER_PROTOCOL } as const;
    runtime.dispatch({ ...tag, type: "open-source", fileKey: "f1", source: { kind: "tiff-files", files: { 0: tiffFor(0), 2: tiffFor(2, 30), 5: tiffFor(5) } }, eventCount: 6, scaleSample: 3 });
    await runtime.idle();
    const ready = log.find((r) => r.type === "source-ready");
    expect(ready).toBeTruthy();
    if (ready?.type !== "source-ready") return;
    expect(ready.imageCount).toBe(3);
    expect(Array.from(ready.hasImage)).toEqual([1, 0, 1, 0, 0, 1]);
    expect(ready.channelNames[4]).toBe("SSC (Imaging)");
    expect(ready.scale[4]).toBeGreaterThan(0);
    const spec = { display: defaultChannelDisplay(new Map(NAMES.map((n, k) => [k + 2, n]))), scale: ready.scale, exposure: 1, hop: 64, composite: true, channels: [4] };
    runtime.dispatch({ ...tag, type: "render", requestId: "r1", fileKey: "f1", eventIndex: 2, lane: "batch", spec });
    runtime.dispatch({ ...tag, type: "render", requestId: "r2", fileKey: "f1", eventIndex: 1, lane: "batch", spec });
    await runtime.idle();
    const image = log.find((r) => r.type === "image");
    expect(image).toMatchObject({ requestId: "r1", eventIndex: 2, rows: 104, cols: 30 });
    if (image?.type === "image") expect(image.aspect).toBeCloseTo(88 / 73.3, 3);
    expect(log.find((r) => r.type === "no-image")).toMatchObject({ requestId: "r2", eventIndex: 1 });
    runtime.dispatch({ ...tag, type: "classify", requestId: "c1", fileKey: "f1" });
    await runtime.idle();
    const classified = log.find((r) => r.type === "classified");
    expect(classified).toBeTruthy();
    if (classified?.type !== "classified") return;
    expect(Array.from(classified.objectCount)).toEqual([1, 255, 1, 255, 255, 1]);
  });

  it("refuses a file set that names an event the FCS does not have", async () => {
    const log: CvwWorkerResponse[] = [];
    const runtime = createCvwWorkerRuntime({ emit: (r) => { log.push(r); }, yieldToEventLoop: async () => undefined, makeBitmap: async () => null });
    runtime.dispatch({ protocol: CVW_WORKER_PROTOCOL, type: "open-source", fileKey: "f1", source: { kind: "tiff-files", files: { 7: tiffFor(7) } }, eventCount: 6 });
    await runtime.idle();
    expect(log.find((r) => r.type === "source-error")).toMatchObject({ fileKey: "f1" });
  });
});
