// proportionsSettings.ts — the Plotting tab's settings as one plain object. The field names are
// the tab's persisted keys without their `prop.` prefix, so a saved workspace's plotting state
// and a Layout block's snapshot of the chart are the same shape. This module has no workspace
// knowledge, so the layout model can normalise a saved block without one.

import { OVERLAY_PALETTES, type PaletteName } from "./palettes";

/** The Group, Replicate unit and Facet pickers' value for the file itself, and for no facet. */
export const PROPORTIONS_SAMPLE_FACTOR = "__sample__";
export const PROPORTIONS_NO_FACTOR = "";

export interface ProportionsSettings {
  /** The files drawn, by id. */
  files: string[];
  hierarchy: string;
  categoryKind: "population" | "division";
  plotType: "stacked" | "box";
  /** The population the composition is shown within; the root when unset or gone. */
  parent: string;
  selectedPops: string[];
  includeUngated: boolean;
  groupSel: string;
  unitSel: string;
  facetSel: string;
  palette: PaletteName;
  averagePerUnit: boolean;
  fontTick: number;
  fontAxis: number;
  fontLegend: number;
  height: number;
  grid: boolean;
  points: boolean;
  legend: boolean;
  pointRadius: number;
}

export const PROPORTIONS_NUMERIC_RANGES: Record<string, [number, number]> = {
  fontTick: [5, 20],
  fontAxis: [5, 24],
  fontLegend: [5, 20],
  height: [140, 800],
  pointRadius: [0.5, 5],
};

/** The presentation defaults; the workspace-bound fields are filled by `defaultProportionsSettings`. */
export const BASE_PROPORTIONS_SETTINGS: ProportionsSettings = {
  files: [],
  hierarchy: "",
  categoryKind: "population",
  plotType: "stacked",
  parent: "",
  selectedPops: [],
  includeUngated: true,
  groupSel: PROPORTIONS_SAMPLE_FACTOR,
  unitSel: PROPORTIONS_SAMPLE_FACTOR,
  facetSel: PROPORTIONS_NO_FACTOR,
  palette: "paired",
  averagePerUnit: true,
  fontTick: 9,
  fontAxis: 10,
  fontLegend: 11,
  height: 280,
  grid: true,
  points: true,
  legend: true,
  pointRadius: 2,
};

/** A settings object from anything saved: known fields within range over the defaults given, the rest dropped. */
export function normalizeProportionsSettings(value: unknown, defaults: ProportionsSettings = BASE_PROPORTIONS_SETTINGS): ProportionsSettings {
  const out: ProportionsSettings = { ...defaults, files: [...defaults.files], selectedPops: [...defaults.selectedPops] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const candidate = value as Record<string, unknown>;
  for (const key of ["files", "selectedPops"] as const) {
    const list = candidate[key];
    if (Array.isArray(list) && list.every((entry) => typeof entry === "string")) out[key] = [...list];
  }
  for (const key of ["hierarchy", "parent", "groupSel", "unitSel", "facetSel"] as const) {
    if (typeof candidate[key] === "string") out[key] = candidate[key] as string;
  }
  if (candidate.categoryKind === "population" || candidate.categoryKind === "division") out.categoryKind = candidate.categoryKind;
  if (candidate.plotType === "stacked" || candidate.plotType === "box") out.plotType = candidate.plotType;
  if (OVERLAY_PALETTES.some((palette) => palette.value === candidate.palette)) out.palette = candidate.palette as PaletteName;
  for (const key of ["includeUngated", "averagePerUnit", "grid", "points", "legend"] as const) {
    if (typeof candidate[key] === "boolean") out[key] = candidate[key] as boolean;
  }
  for (const [key, [min, max]] of Object.entries(PROPORTIONS_NUMERIC_RANGES)) {
    const number = candidate[key];
    if (typeof number === "number" && Number.isFinite(number)) (out as unknown as Record<string, number>)[key] = Math.max(min, Math.min(max, number));
  }
  return out;
}
