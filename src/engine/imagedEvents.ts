// imagedEvents.ts — which events of an S8 file have an image. The instrument writes a per-event
// WaveformPresent column into the FCS (1 when the event's waveform, and so its image, was
// recorded); it is the same flag the waveform file's index carries, available the moment the FCS
// is parsed. Tiny and dependency-free, so App can colour a plot by it and the hover probe can
// skip the events without one before any imaging code has loaded.

import type { FcsFile } from "./fcs";

export const WAVEFORM_PRESENT_CHANNEL = "WaveformPresent";

/** One byte per event, 1 when it has an image; null when the file has no such column. */
export function imagedEventFlags(fcs: FcsFile): Uint8Array | null {
  const at = fcs.channels.findIndex((channel) => channel.name === WAVEFORM_PRESENT_CHANNEL);
  if (at < 0) return null;
  const column = fcs.columns[at];
  if (!column) return null;
  const flags = new Uint8Array(fcs.nEvents);
  for (let i = 0; i < flags.length; i++) flags[i] = column[i] ? 1 : 0;
  return flags;
}
