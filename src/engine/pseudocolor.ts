export const DEFAULT_DENSITY_COLOR_POWER = 1.6;
export const MIN_DENSITY_COLOR_POWER = 0.8;
export const MAX_DENSITY_COLOR_POWER = 2.4;
export const DENSITY_COLOR_POWER_STEP = 0.1;

/**
 * Clamp the pseudocolour density transfer exponent to the range exposed by the UI.
 * Higher values reserve yellow/red for progressively denser event cores; event positions,
 * density estimates, and the number of displayed events are unchanged.
 */
export function normalizeDensityColorPower(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_DENSITY_COLOR_POWER;
  const clamped = Math.max(MIN_DENSITY_COLOR_POWER, Math.min(MAX_DENSITY_COLOR_POWER, parsed));
  return Number((Math.round(clamped / DENSITY_COLOR_POWER_STEP) * DENSITY_COLOR_POWER_STEP).toFixed(1));
}

/** Map a density fraction to the jet-palette position used by GateLab's renderers. */
export function densityColorFraction(densityFraction: number, power: number): number {
  const fraction = Number.isFinite(densityFraction)
    ? Math.max(0, Math.min(1, densityFraction))
    : 0;
  return Math.pow(fraction, normalizeDensityColorPower(power));
}
