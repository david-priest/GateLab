// imageSource.ts — what a sample knows about its cell images, and what a workspace records.
// The decoding itself lives in the worker; these are the small, cloneable descriptions that
// App.tsx keeps on a SampleEntry (never any image data) and writes into a .gatelab file (never
// the file itself: images are linked, not copied).

import type { CellImageRecord } from "../engine/workspace";
import type { ChannelDisplay, ImagingMask } from "./imageWallSettings";
import type { TiffNaming } from "./tiffFolder";

export type ImageSourceKind = "cvw" | "tiff-folder";

/** A `.cvw` waveform file attached to a sample. */
export interface CvwImageSource {
  readonly kind: "cvw";
  readonly fileName: string;
  /** The file to read ranges from; null for a source recorded in a workspace but not yet found. */
  readonly file: File | null;
  readonly handle: FileSystemFileHandle | null;
  /** Display-only path below a folder chosen this session. */
  readonly sourcePath?: string;
  readonly eventCount: number;
  readonly recordingId: string;
  /** Slot → channel name, from the file's metadata. */
  readonly channelNames: ReadonlyMap<number, string>;
  /** Column pitch over row pitch at the native hop. */
  readonly pixelAspectRatio: number;
  /** How the file's channels are shown, seeded from the FCS keyword. */
  readonly display: readonly ChannelDisplay[];
  /** The mask Chorus computed its image features with, when the FCS records it. */
  readonly mask: ImagingMask | null;
}

/** A folder of extracted TIFFs (BD CellView Image Extractor, FlowJo) attached to a sample. */
export interface TiffFolderImageSource {
  readonly kind: "tiff-folder";
  /** The folder's name, shown where a `.cvw` shows its file name. */
  readonly fileName: string;
  /** The folder, for reading files on demand; null when it came as files or is not yet found. */
  readonly handle: FileSystemDirectoryHandle | null;
  /** The files by FCS event index, when the folder came as files (a drop, or a browser without directory handles). */
  readonly files: Readonly<Record<number, File>> | null;
  readonly sourcePath?: string;
  /** The FCS's event count, which every file's index is below. */
  readonly eventCount: number;
  readonly imageCount: number;
  readonly naming: TiffNaming;
  readonly channelNames: ReadonlyMap<number, string>;
  readonly pixelAspectRatio: number;
  readonly display: readonly ChannelDisplay[];
  readonly mask: ImagingMask | null;
}

export type CellImageSource = CvwImageSource | TiffFolderImageSource;

/** What a workspace file records about an attached source: enough to find and check it again. */
export function imageRecordOf(source: CellImageSource): CellImageRecord {
  if (source.kind === "tiff-folder") {
    return { kind: "tiff-folder", fileName: source.fileName, eventCount: source.eventCount, naming: { ...source.naming } };
  }
  return {
    kind: "cvw",
    fileName: source.fileName,
    eventCount: source.eventCount,
    ...(source.recordingId ? { recordingId: source.recordingId } : {}),
  };
}
