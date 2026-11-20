// screenInput.ts — a loaded file as the screen reads it.
//
// The screen works on plain columns (screenPairs.ts), so it can be tested without an FCS file.
// This is the one place a loaded file is turned into them. Values are the stored measurements
// (the Original layer) whatever assay the file is showing: a coefficient read from compensated
// values would be what that compensation left behind, not the spillover.

import type { Sample } from "../engine/sample";
import type { ScreenData } from "./screenPairs";

/** The stored counts of `sample` for a fixed set of events, in the order given. */
export function screenDataFromSample(sample: Sample, eventIndices: Uint32Array): ScreenData {
  const indexByPnn = new Map(sample.channels.map((channel, index) => [channel.pnn, index]));
  const cache = new Map<string, Float64Array>();
  return {
    eventCount: eventIndices.length,
    channels: sample.channels.map((channel) => ({ pnn: channel.pnn, marker: channel.marker })),
    values(pnn) {
      const cached = cache.get(pnn);
      if (cached) return cached;
      const index = indexByPnn.get(pnn);
      if (index === undefined) return null;
      const column = sample.originalColumnData(index);
      const values = new Float64Array(eventIndices.length);
      for (let event = 0; event < values.length; event++) values[event] = column[eventIndices[event]];
      cache.set(pnn, values);
      return values;
    },
  };
}
