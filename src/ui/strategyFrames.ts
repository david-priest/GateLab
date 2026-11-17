// The axis frames the Strategy and Layout tabs draw gates in: the Gating tab's automatic frame where
// no global scale sets one.
//
// The strategy engine frames a channel by its global scale, else by its outermost events
// (computeRangeFromValues). A channel never opened on the Gating tab has no global scale, so on a
// FACSDiscover S8 file, where $PnR is 2^31 and a few events reach far past the cells, a CD27 axis
// ran to 1000M with the cells in one corner. The engine is frozen (AGENTS.md), so the frames are
// completed here, before it is called.

import type { Gate } from "../engine/models";
import type { Sample } from "../engine/sample";

type Frames = Record<string, [number, number]>;

/**
 * `globalScales`, with the automatic frame of each channel a gate of `gates` is drawn on that no
 * global scale sets: `sample.displayRange`, the 0.1st to 99.9th percentiles padded and held below
 * $PnR, the frame the Scales tab shows for an unset channel. The same object when every channel is set.
 */
export function strategyFrames(sample: Sample, gates: Readonly<Record<string, Gate>>, globalScales: Frames): Frames {
  let out: Frames | null = null;
  for (const gate of Object.values(gates)) {
    for (const channel of [gate.x_channel, gate.y_channel]) {
      if ((out ?? globalScales)[channel]) continue;
      const index = sample.index(channel);
      if (index === undefined) continue;
      out ??= { ...globalScales };
      out[channel] = sample.displayRange(index);
    }
  }
  return out ?? globalScales;
}
