// attach.ts — turn a picked `.cvw` into the description a sample carries. Reads the header and
// the metadata (a few kilobytes), checks the file is this sample's, and seeds the display
// settings from the FCS keyword. The index and the waveforms are the worker's business.

import { openCvwSummary } from "./cvw";
import type { CvwImageSource } from "./imageSource";
import { chorusImagingMask, defaultChannelDisplay } from "./imageWallSettings";

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
