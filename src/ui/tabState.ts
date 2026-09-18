// tabState.ts — session-scoped tab-state persistence.
//
// Tabs unmount when you switch away and remount when you return, so plain useState resets every
// visit. This is a drop-in useState replacement that stashes each value in a module-level store
// keyed by a stable string, so a tab returns in the state you left it (until the page reloads).
// Use it for GLOBAL tab config (which populations/channels are selected, plot type, palette…) —
// NOT for per-sample state (dye channel, division boundaries), which belongs to the sample.
//
// This is deliberately lighter than the Illustration/Strategy configRef pattern: no interface, no
// prop threading through App — just swap `useState(x)` → `usePersistedTabState("tab.field", x)`.
// Like configRef it is in-session only (not written to the workspace file).

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { OVERLAY_PALETTES } from "../engine/palettes";
import { normalizeProportionsSettings, type ProportionsSettings } from "../engine/proportionsSettings";

const store: Record<string, unknown> = {};

/** useState, but the value survives this tab unmounting/remounting (keyed by `key`, session-scoped). */
export function usePersistedTabState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() =>
    key in store
      ? (store[key] as T)
      : typeof initial === "function"
        ? (initial as () => T)()
        : initial,
  );
  useEffect(() => {
    store[key] = value;
  }, [key, value]);
  return [value, setValue];
}

/** Drop persisted tab state (e.g. when a fresh workspace is opened, so stale selections don't leak). */
export function clearPersistedTabState(): void {
  for (const k of Object.keys(store)) delete store[k];
}

export function savedPlottingState(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(store).filter(([key]) => key.startsWith("prop.")),
  );
}

/**
 * The Plotting tab's settings as it would show them now: what the store holds over the defaults
 * given, so a chart can be taken from the tab whether or not it has been opened.
 */
export function readProportionsSettings(defaults: ProportionsSettings): ProportionsSettings {
  const held = Object.fromEntries(
    Object.entries(store).filter(([key]) => key.startsWith("prop.")).map(([key, value]) => [key.slice(5), value]),
  );
  return normalizeProportionsSettings(held, defaults);
}

/** Put a chart's settings into the Plotting tab, so it opens showing that chart. */
export function writeProportionsSettings(settings: ProportionsSettings): void {
  for (const [key, value] of Object.entries(settings)) store[`prop.${key}`] = structuredClone(value);
}

/** Only known presentation settings are restored; malformed values fall back to UI defaults. */
export function restorePlottingState(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const entries = value as Record<string, unknown>;
  const enums: Record<string, string[]> = {
    categoryKind: ["population", "division"],
    plotType: ["stacked", "box"],
    palette: OVERLAY_PALETTES.map((palette) => palette.value),
  };
  const numeric: Record<string, [number, number]> = {
    fontTick: [5, 20],
    fontAxis: [5, 24],
    fontLegend: [5, 20],
    height: [140, 800],
    pointRadius: [0.5, 5],
  };
  for (const [key, item] of Object.entries(entries)) {
    if (!key.startsWith("prop.")) continue;
    const field = key.slice(5);
    if (
      enums[field]?.includes(item as string) ||
      (["groupSel", "unitSel", "facetSel", "hierarchy", "parent"].includes(field) &&
        typeof item === "string") ||
      ([
        "includeUngated",
        "averagePerUnit",
        "grid",
        "points",
        "legend",
      ].includes(field) &&
        typeof item === "boolean") ||
      (["selectedPops", "files"].includes(field) &&
        Array.isArray(item) &&
        item.every((id) => typeof id === "string"))
    )
      store[key] = item;
    else if (
      numeric[field] &&
      typeof item === "number" &&
      Number.isFinite(item)
    )
      store[key] = Math.max(
        numeric[field][0],
        Math.min(numeric[field][1], item),
      );
  }
}
