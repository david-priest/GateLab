// compensationScreenText.ts — the words for one pair's reading by the compensation screen.
//
// One place, so the Check table and the coefficient panel say the same thing about a pair. The
// wording keeps to what the events show: a reading is of one file's events in one population,
// and where a marker on the same cells could explain a rising floor it says so.
import type { ScreenPair } from "../compensationScreen/screenPairs";

export type ScreenTone = "above" | "below" | "bound" | "consistent" | "dim";

export interface ScreenReading {
  readonly tone: ScreenTone;
  /** A source string for t(). */
  readonly label: string;
  /** A source string for t(), with the placeholders in `values`. */
  readonly detail: string;
  readonly values: Readonly<Record<string, string>>;
}

/** A coefficient as a percentage: two decimals below 10%, one from there. */
export function screenPercent(value: number): string {
  const percent = value * 100;
  return `${percent.toFixed(Math.abs(percent) >= 10 ? 1 : 2)}%`;
}

/** What the events support for the pair, as the table's short text. A source string for t() with its values. */
export function screenSupport(pair: ScreenPair): Readonly<{ text: string; values: Record<string, string> }> {
  const floor = pair.floor;
  if (!floor || pair.floorLower === null || pair.detectionLimit === null) return { text: "not read", values: {} };
  const bound = screenPercent(floor.upperBound);
  const lower = screenPercent(pair.floorLower);
  switch (pair.verdict) {
    case "above-data":
    case "upper-bound-only":
      return { text: "at most {bound}", values: { bound } };
    case "below-floor":
      return { text: "{lower} to {bound}", values: { lower, bound } };
    case "too-dim":
      return { text: "readable from {limit}", values: { limit: screenPercent(pair.detectionLimit) } };
    case "consistent":
      return pair.coefficient > 0
        ? { text: "{lower} to {bound}", values: { lower, bound } }
        : { text: "below {bound}", values: { bound: screenPercent(Math.max(floor.upperBound, pair.detectionLimit)) } };
  }
}

export function screenReading(pair: ScreenPair): ScreenReading {
  const floor = pair.floor;
  const values: Record<string, string> = {
    matrix: screenPercent(pair.coefficient),
    floor: floor ? screenPercent(floor.slope) : "",
    lower: pair.floorLower !== null ? screenPercent(pair.floorLower) : "",
    bound: floor ? screenPercent(floor.upperBound) : "",
    limit: pair.detectionLimit !== null ? screenPercent(pair.detectionLimit) : "",
    route: pair.interaction,
  };
  switch (pair.verdict) {
    case "above-data":
      return {
        tone: "above",
        label: "Matrix above the events",
        detail: "The matrix value ({matrix}) is more than these events allow (at most {bound}).",
        values,
      };
    case "below-floor":
      return pair.coefficient > 0
        ? {
            tone: "below",
            label: "Matrix below the floor",
            detail: "The receiver's floor rises with the source by {floor} ({lower} to {bound}); the matrix value is {matrix}.",
            values,
          }
        : {
            tone: "below",
            label: "Possible missing coefficient",
            detail: "The receiver's floor rises with the source by {floor} ({lower} to {bound}) on a pair with a physical route ({route}); the matrix holds no value.",
            values,
          };
    case "upper-bound-only":
      return {
        tone: "bound",
        label: "Upper bound only",
        detail: pair.upperBoundReason === "loose-bound"
          ? "These events only cap the coefficient at {bound}, above any spillover expected between two masses, so they neither support nor contradict the matrix value ({matrix})."
          : pair.upperBoundReason === "no-physical-route"
          ? "The receiver follows the source, but these masses have no physical route for spillover: read as a marker on the same cells. The events cap the coefficient at {bound}."
          : pair.upperBoundReason === "above-plausible"
            ? "The receiver rises with the source by {floor}, steeper than spillover: a marker on the same cells. The events cap the coefficient at {bound}; a population without the receiver's marker could read it."
            : "The receiver's marker is on the source's bright cells, so the events only cap the coefficient at {bound}. A population without the receiver's marker could read it.",
        values,
      };
    case "consistent":
      return {
        tone: "consistent",
        label: "Consistent",
        detail: pair.coefficient <= 0
          ? "No spillover is seen in these events; one of {limit} or more would show."
          : floor && pair.floorLower !== null && pair.coefficient >= pair.floorLower && pair.coefficient <= floor.upperBound
            ? "The matrix value ({matrix}) lies within what these events support ({lower} to {bound})."
            : "The matrix value ({matrix}) is outside what these events support ({lower} to {bound}), but by less than the screen's margin.",
        values,
      };
    case "too-dim":
      return {
        tone: "dim",
        label: "Source too dim",
        detail: pair.coefficient > 0
          ? "The source is not bright enough in these events to read the matrix value ({matrix}); a coefficient of {limit} or more would show."
          : "The source is not bright enough in these events to read this pair; only a coefficient of {limit} or more would show.",
        values,
      };
  }
}
