// valueAxis.ts — the Plotting charts' value-axis settings: the typed limits, an axis fitted to the
// values rather than held to 0, whether the panels share one axis, and the clip a limited axis
// asks its marks for.

import { linearTicks, type CellValueAxis } from "../../engine/cellValuesModel";
import type { ProportionsSettings } from "../../engine/proportionsSettings";

/** A drawn value axis; `clip` when typed limits set it, so marks beyond them are cut at the plot's edge. */
export type ChartAxisFrame = CellValueAxis & { clip?: boolean };

/** A linear value scale: its ends and its major ticks; `clip` as above. */
export interface ChartScale {
  min: number;
  max: number;
  ticks: number[];
  clip?: boolean;
}

/** What a chart's value axis is asked to be, from its settings. */
export interface ValueAxisOptions {
  /** The typed limits, in the units the axis is labelled in; null is automatic. */
  min: number | null;
  max: number | null;
  /** Start at 0, rather than fit the values with headroom. */
  fromZero: boolean;
  /** One axis over every panel, rather than one per panel. */
  shared: boolean;
}

/** Whether a chart's panels share one value axis: as set, else as each chart kind draws it unless told. */
export function sharesValueAxis(settings: Pick<ProportionsSettings, "valueKind" | "plotType" | "xAxis" | "shareValueAxis"> & Partial<Pick<ProportionsSettings, "populationsTogether">>): boolean {
  if (typeof settings.shareValueAxis === "boolean") return settings.shareValueAxis;
  if (settings.valueKind === "cells") return true;
  // A statistic with the populations together is a panel per facet, sharing one axis as with a panel per group.
  if (settings.valueKind === "statistic") return settings.xAxis === "populations" || !!settings.populationsTogether;
  return settings.plotType === "stacked";
}

/** A chart's value-axis options from its settings. Bars start at 0 whatever is set, as a bar's length is its value. */
export function valueAxisOptions(
  settings: Pick<ProportionsSettings, "valueKind" | "plotType" | "xAxis" | "shareValueAxis" | "valueFromZero" | "valueMin" | "valueMax"> & Partial<Pick<ProportionsSettings, "populationsTogether">>,
): ValueAxisOptions {
  return {
    min: settings.valueMin ?? null,
    max: settings.valueMax ?? null,
    fromZero: settings.plotType === "bar" || settings.valueFromZero !== false,
    shared: sharesValueAxis(settings),
  };
}

/** The typed limits as a pair, either end null for automatic; null when neither is set or they make no range. */
export function typedLimits(min: number | null | undefined, max: number | null | undefined): [number | null, number | null] | null {
  const lo = typeof min === "number" && Number.isFinite(min) ? min : null;
  const hi = typeof max === "number" && Number.isFinite(max) ? max : null;
  if (lo === null && hi === null) return null;
  if (lo !== null && hi !== null && !(hi > lo)) return null;
  return [lo, hi];
}

/**
 * A scale fitted to the values with headroom, not held to 0: round ticks from a step below the
 * lowest value to a step above the highest, kept within `bounds` (0 to 100% for a share).
 */
export function fittedScale(values: readonly number[], bounds: [number, number] = [-Infinity, Infinity], count = 5): ChartScale {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values)
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  if (!Number.isFinite(lo)) return { min: 0, max: 1, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] };
  if (!(hi > lo)) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  const rough = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? magnitude * 10;
  const min = Math.max(bounds[0], Math.floor((lo - step * 0.15) / step) * step);
  const max = Math.min(bounds[1], Math.ceil((hi + step * 0.15) / step) * step);
  const ticks: number[] = [];
  for (let i = Math.ceil(min / step - 1e-9); i * step <= max + step * 1e-6; i++) ticks.push(Number((i * step).toPrecision(12)));
  return { min, max, ticks };
}

/** The scale within the typed limits, its ticks found again for them; as it was when none are set or they make no range with it. */
export function limitedScale(scale: ChartScale, limits: [number | null, number | null] | null): ChartScale {
  if (!limits) return scale;
  const min = limits[0] ?? scale.min;
  const max = limits[1] ?? scale.max;
  if (!(max > min)) return scale;
  return { min, max, ticks: linearTicks(min, max), clip: true };
}
