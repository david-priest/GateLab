import type { ChannelScales } from "./channelScales";
import type { Sample } from "./sample";
import type { WorkspaceSample } from "./workspace";

/** Replace the shared transform owner, not just the samples' detached fallback settings.
 * Call after assay restoration and validation, before rendering the saved axis ranges.
 * Older workspaces may disagree per file: the active file owns overlapping channels, with
 * the remaining files supplying channels/contexts it does not have. Absence means default.
 */
export function restoreChannelScales(
  scales: ChannelScales,
  samples: readonly Sample[],
  saved: readonly Pick<
    WorkspaceSample,
    "logicleW" | "scatterCofactor" | "scatterLinear" | "fluorArcsinh"
  >[],
  activeIndex: number,
): void {
  scales.clear();
  const seen = new Set<string>();
  const order = [
    activeIndex,
    ...samples
      .map((_, index) => index)
      .filter((index) => index !== activeIndex),
  ];
  for (const index of order) {
    const sample = samples[index],
      settings = saved[index];
    if (!sample || !settings) continue;
    const context = sample.workspaceScaleContextKey;
    for (const [channelIndex, channel] of sample.channels.entries()) {
      const key = channel.key;
      const identity = JSON.stringify([context, key]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const w = settings.logicleW?.[key];
      if (
        sample.isFluorChannel(channelIndex) &&
        w !== undefined &&
        Number.isFinite(w)
      ) {
        scales.setLogicleW(context, key, w);
      }
      const cofactor = settings.scatterCofactor?.[key];
      if (cofactor !== undefined && Number.isFinite(cofactor) && cofactor > 0) {
        scales.setScatterCofactor(context, key, cofactor);
      }
      if (sample.isScatterAxis(channelIndex)) {
        scales.setScatterLinear(
          context,
          key,
          settings.scatterLinear?.includes(key) ?? false,
        );
      }
      // Every class that can choose arcsinh over its default saves the choice under this key:
      // fluorescence, and the S8's imaging geometry features once they are a class of their
      // own (isFluorChannel is false for those). The registry was cleared above, so only the
      // listed keys need setting; a scatter axis never appears in the list.
      if (!sample.isScatterAxis(channelIndex) && settings.fluorArcsinh?.includes(key)) {
        scales.setFluorArcsinh(context, key, true);
      }
    }
  }
}
