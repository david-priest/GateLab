// imageSource.ts — what a sample knows about its cell images, and what a workspace records.
// The decoding itself lives in the worker; these are the small, cloneable descriptions that
// App.tsx keeps on a SampleEntry (never any image data) and writes into a .gatelab file (never
// the file itself: images are linked, not copied).

import type { CellImageRecord } from "../engine/workspace";
import type { ChannelDisplay, ImagingMask } from "./imageWallSettings";

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

export type CellImageSource = CvwImageSource;

/** What a workspace file records about an attached source: enough to find and check it again. */
export function imageRecordOf(source: CellImageSource): CellImageRecord {
  return {
    kind: "cvw",
    fileName: source.fileName,
    eventCount: source.eventCount,
    ...(source.recordingId ? { recordingId: source.recordingId } : {}),
  };
}
