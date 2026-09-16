/**
 * Names for a quadrant gate's four populations.
 *
 * The store numbers the quadrants Q1 = x- y+, Q2 = x+ y+, Q3 = x+ y-, Q4 = x- y-. Two ways to
 * name them: by signs ("CD4- CD8+", "CD4+ CD8+", "CD4+ CD8-", "CD4- CD8-"), and the DN/DP/SP
 * convention of thymocyte gating ("CD8 SP", "DP", "CD4 SP", "DN"), where SP names the marker
 * that is on. The labels are the axes' short labels: the marker where the channel has one, else
 * the detector.
 */

export type QuadrantNaming = "signs" | "dndp";

export const QUADRANT_NAMINGS: readonly QuadrantNaming[] = ["signs", "dndp"];

export function isQuadrantNaming(value: unknown): value is QuadrantNaming {
  return value === "signs" || value === "dndp";
}

/** The four names, in quadrant order Q1 to Q4. */
export function quadrantPopulationNames(
  scheme: QuadrantNaming,
  xLabel: string,
  yLabel: string,
): [string, string, string, string] {
  const x = xLabel.trim() || "x";
  const y = yLabel.trim() || "y";
  if (scheme === "dndp") return [`${y} SP`, "DP", `${x} SP`, "DN"];
  return [`${x}- ${y}+`, `${x}+ ${y}+`, `${x}+ ${y}-`, `${x}- ${y}-`];
}

/** The marker where the channel has one, else the detector: "CD4" rather than "CD4 (FITC-A)". */
export function shortChannelLabel(
  channel: { marker?: string | null; pnn?: string | null } | undefined,
  key: string,
): string {
  const marker = channel?.marker?.trim();
  if (marker && marker !== channel?.pnn) return marker;
  return channel?.pnn?.trim() || key;
}

const STORAGE_KEY = "gatelab.quadrantNaming";

/** The scheme chosen last time, so the modal opens on it; DN/DP/SP until a choice is made. */
export function rememberedQuadrantNaming(): QuadrantNaming {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isQuadrantNaming(stored) ? stored : "dndp";
  } catch {
    return "dndp";
  }
}

export function rememberQuadrantNaming(scheme: QuadrantNaming): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, scheme);
  } catch {
    // Storage is a convenience; the choice still applies to this gate.
  }
}
