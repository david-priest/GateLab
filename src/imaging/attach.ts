// attach.ts — turn a picked `.cvw` into the description a sample carries. Reads the header and
// the metadata (a few kilobytes), checks the file is this sample's, and seeds the display
// settings from the FCS keyword. The index and the waveforms are the worker's business.

import { openCvwSummary } from "./cvw";
import type { CvwImageSource, TiffFolderImageSource } from "./imageSource";
import { chorusImagingMask, defaultChannelDisplay } from "./imageWallSettings";
import { readTiffPages } from "./tiff";
import { inferTiffNaming, tiffChannelNames, tiffEventIndexOf, type TiffNaming } from "./tiffFolder";

type IterableDirectoryHandle = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };

export interface TiffFolderInput {
  /** The folder's name, shown where a `.cvw` shows its file name. */
  readonly folderName: string;
  /** The folder itself, read on demand; or its files, when it came as files. One of the two. */
  readonly handle: FileSystemDirectoryHandle | null;
  readonly files: readonly File[] | null;
  readonly sourcePath?: string;
}

/**
 * Open a folder of extracted TIFFs as the images of `target`: the files are listed (the
 * `00000000`-style subfolders of the extractor, or the folder itself), their naming read from the
 * first, every index checked against the FCS's event count, and the channels taken from the
 * first file's pages. Nothing else is read until an image is asked for.
 */
export async function attachTiffFolder(input: TiffFolderInput, target: AttachTarget): Promise<TiffFolderImageSource> {
  const names: string[] = [];
  let layout: TiffNaming["layout"] = "flat";
  let firstBlob: (() => Promise<Blob>) | null = null;
  const filesByIndex: Record<number, File> = {};
  if (input.files) {
    for (const file of input.files) {
      if (!/\.tiff?$/i.test(file.name)) continue;
      names.push(file.name);
      const parts = ((file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "").split("/");
      if (parts.length >= 2 && /^\d{8}$/.test(parts[parts.length - 2])) layout = "subfolders";
    }
  } else if (input.handle) {
    const dirs: FileSystemDirectoryHandle[] = [];
    for await (const entry of (input.handle as IterableDirectoryHandle).values()) {
      if (entry.kind === "directory" && /^\d{8}$/.test(entry.name)) dirs.push(entry as FileSystemDirectoryHandle);
    }
    if (dirs.length > 0) layout = "subfolders";
    else dirs.push(input.handle);
    for (const dir of dirs) {
      for await (const entry of (dir as IterableDirectoryHandle).values()) {
        if (entry.kind === "file" && /\.tiff?$/i.test(entry.name)) {
          names.push(entry.name);
          if (!firstBlob) { const handle = entry as FileSystemFileHandle; firstBlob = () => handle.getFile(); }
        }
      }
    }
  }
  if (names.length === 0) throw new ImageAttachError(`${input.folderName} holds no .tiff files`);
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const naming = inferTiffNaming(names[0], layout);
  if (!naming) throw new ImageAttachError(`${input.folderName}: ${names[0]} is not named <tube>_<event number>.tiff, as the extractor names its files`);
  let imageCount = 0;
  let largest = -1;
  for (const name of names) {
    const e = tiffEventIndexOf(name, naming);
    if (e === null) continue;
    imageCount++;
    if (e > largest) largest = e;
  }
  if (imageCount === 0) throw new ImageAttachError(`${input.folderName}: no file is named like ${names[0]}`);
  if (largest >= target.nEvents) {
    throw new ImageAttachError(
      `${input.folderName} names event ${largest.toLocaleString()} but the FCS has ${target.nEvents.toLocaleString()} events; it is not this file's`,
    );
  }
  if (input.files) {
    for (const file of input.files) {
      const e = tiffEventIndexOf(file.name, naming);
      if (e !== null) { filesByIndex[e] = file; if (!firstBlob) { const f = file; firstBlob = async () => f; } }
    }
  }
  if (!firstBlob) throw new ImageAttachError(`${input.folderName}: no file could be read`);
  const pages = readTiffPages(await (await firstBlob()).arrayBuffer());
  const channelNames = tiffChannelNames(pages);
  return {
    kind: "tiff-folder",
    fileName: input.folderName,
    handle: input.handle,
    files: input.files ? filesByIndex : null,
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    eventCount: target.nEvents,
    imageCount,
    naming,
    channelNames,
    pixelAspectRatio: 0.3,
    display: defaultChannelDisplay(channelNames, target.keywords),
    mask: chorusImagingMask(target.keywords),
  };
}

export interface AttachTarget {
  /** The FCS's event count ($TOT as read). */
  readonly nEvents: number;
  readonly keywords: Readonly<Record<string, string>>;
}

export class ImageAttachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageAttachError";
  }
}

/**
 * Open `file` as the images of `target`. A file whose event count is not the sample's is refused:
 * a subset GateLab exported shares its basename with the original, and its events are not the
 * waveform file's.
 */
export async function attachCellImages(
  file: File,
  handle: FileSystemFileHandle | null,
  target: AttachTarget,
  sourcePath?: string,
): Promise<CvwImageSource> {
  let summary;
  try {
    summary = await openCvwSummary({ kind: "file", file });
  } catch (cause) {
    throw new ImageAttachError(`${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const { header, metadata } = summary;
  if (header.eventCount !== target.nEvents) {
    throw new ImageAttachError(
      `${file.name} holds ${header.eventCount.toLocaleString()} events but the FCS has ${target.nEvents.toLocaleString()}; ` +
        "it is not this file's recording",
    );
  }
  return {
    kind: "cvw",
    fileName: file.name,
    file,
    handle,
    ...(sourcePath ? { sourcePath } : {}),
    eventCount: header.eventCount,
    recordingId: metadata.recordingId,
    channelNames: metadata.channelNames,
    pixelAspectRatio: metadata.lasers[0].pixelAspectRatio,
    display: defaultChannelDisplay(metadata.channelNames, target.keywords),
    mask: chorusImagingMask(target.keywords),
  };
}
