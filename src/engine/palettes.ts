// palettes.ts — colour palettes for the Proportions tab, ported from GateLabR OVERLAY_PALETTES
// (data_utils.R:182-215). `paired` (matches the Division Div0..DivN colours) and `default`
// (Tableau) are the exact hardcoded ramps. The sequential colormaps (viridis, plasma, cividis,
// inferno) and the qualitative Set 2 / Dark 3 are sampled from embedded anchor stops so GateLab
// needs no colour package (R used grDevices::hcl.colors). Visually equivalent for a preview.

export type PaletteName = "paired" | "default" | "viridis" | "plasma" | "cividis" | "inferno" | "magma" | "turbo" | "jet" | "greys" | "set2" | "dark3";

export const OVERLAY_PALETTES: { value: PaletteName; label: string }[] = [
  { value: "paired", label: "Paired (matches Division)" },
  { value: "default", label: "Tableau (default)" },
  { value: "viridis", label: "Viridis" },
  { value: "plasma", label: "Plasma" },
  { value: "cividis", label: "Cividis" },
  { value: "inferno", label: "Inferno" },
  { value: "set2", label: "Set 2" },
  { value: "dark3", label: "Dark 3" },
];

/**
 * Palettes offered when the overlay is a continuous marker rather than a set of categories.
 *
 * Only sequential ramps appear here. A qualitative palette (Paired, Tableau, Set 2) carries no
 * order: sampled across 256 levels it cycles hues, so a brighter event can come back a colour
 * that reads as lower than a dimmer one, which makes the colour bar a lie. They stay available
 * for the categorical overlays, where cycling hues is the point.
 */
export const MARKER_PALETTES: { value: PaletteName; label: string }[] = [
  { value: "viridis", label: "Viridis" },
  { value: "magma", label: "Magma" },
  { value: "plasma", label: "Plasma" },
  { value: "inferno", label: "Inferno" },
  { value: "cividis", label: "Cividis (colour-blind safe)" },
  { value: "turbo", label: "Turbo" },
  { value: "jet", label: "Jet (FlowJo-like)" },
  { value: "greys", label: "Greys" },
];

/** The marker palette a workspace starts on: perceptually uniform, and safe for most readers. */
export const DEFAULT_MARKER_PALETTE: PaletteName = "viridis";

const PAIRED = ["#a6cee3", "#1f78b4", "#b2df8a", "#33a02c", "#fb9a99", "#e31a1c",
  "#fdbf6f", "#ff7f00", "#cab2d6", "#6a3d9a", "#ffff99", "#b15928"];
const TABLEAU = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b",
  "#e377c2", "#7f7f7f", "#bcbd22", "#17becf", "#aec7e8", "#ffbb78", "#98df8a",
  "#ff9896", "#c5b0d5", "#c49c94", "#f7b6d2", "#c7c7c7", "#dbdb8d", "#9edae5"];
const SET2 = ["#66c2a5", "#fc8d62", "#8da0cb", "#e78ac3", "#a6d854", "#ffd92f", "#e5c494", "#b3b3b3"];
const DARK3 = ["#e16a86", "#ca8a04", "#909800", "#00a396", "#00a2d3", "#9183e6", "#d05fb0", "#606060"];

// Sequential colormap anchors (matplotlib), low→high; sampled at k evenly-spaced points.
const VIRIDIS = ["#440154", "#472d7b", "#3b528b", "#2c728e", "#21918c", "#28ae80", "#5ec962", "#addc30", "#fde725"];
const PLASMA = ["#0d0887", "#5402a3", "#8b0aa5", "#b93289", "#db5c68", "#f48849", "#febd2a", "#f0f921"];
const CIVIDIS = ["#00204d", "#00336f", "#39486b", "#575d6d", "#707173", "#8a8779", "#a69d75", "#c4b56c", "#e4cf5b", "#ffea46"];
const INFERNO = ["#000004", "#1b0c41", "#4a0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9b06", "#f7d13d", "#fcffa4"];
const MAGMA = ["#000004", "#180f3d", "#440f76", "#721f81", "#9e2f7f", "#cd4071", "#f1605d", "#fd9668", "#feca8d", "#fcfdbf"];
const TURBO = ["#30123b", "#4145ab", "#4675ed", "#39a2fc", "#1bcfd4", "#24eca6", "#61fc6c", "#a4fc3b", "#d1e834", "#f3c63a",
  "#fe9b2d", "#f36315", "#d93806", "#b11901", "#7a0403"];
// The FlowJo/legacy "jet" ramp, for readers who expect a cytometry plot to look like one. It is
// not perceptually uniform -- that is the whole reason viridis is the default here -- but a
// marker histogram read against a decade of published figures is easier in the familiar colours.
const JET = ["#00007f", "#0000ff", "#007fff", "#00ffff", "#7fff7f", "#ffff00", "#ff7f00", "#ff0000", "#7f0000"];
const GREYS = ["#f0f0f0", "#252525"];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex([r, g, b]: [number, number, number]): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
/** Sample k evenly-spaced colours across the anchor stops (continuous colormap). */
function sampleRamp(anchors: string[], k: number): string[] {
  if (k <= 1) return [anchors[0]];
  const rgb = anchors.map(hexToRgb);
  const out: string[] = [];
  for (let i = 0; i < k; i++) {
    const t = (i / (k - 1)) * (rgb.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(rgb.length - 1, lo + 1);
    const f = t - lo;
    out.push(rgbToHex([
      rgb[lo][0] + (rgb[hi][0] - rgb[lo][0]) * f,
      rgb[lo][1] + (rgb[hi][1] - rgb[lo][1]) * f,
      rgb[lo][2] + (rgb[hi][2] - rgb[lo][2]) * f,
    ]));
  }
  return out;
}
/** Qualitative ramp: first k if enough, else interpolate to k (mirrors R colorRampPalette). */
function qualRamp(base: string[], k: number): string[] {
  if (k <= base.length) return base.slice(0, k);
  return sampleRamp(base, k);
}

/** Fixed number of population colour slots. Population colours are sampled at THIS count (not at the
 * live population count), so slot→colour is invariant to how many populations exist — which is what
 * freezes the palette when a population is added or removed. */
export const POP_COLOR_SLOTS = 12;
/** The "ungated" remainder colour — a fixed neutral grey, never a palette slot, so it can't shift. */
export const UNGATED_COLOR = "#cccccc";
/** Stable colour for a population's colour slot in the given palette (see POP_COLOR_SLOTS). */
export function populationColor(name: PaletteName, slot: number | undefined): string {
  const ramp = paletteColors(name, POP_COLOR_SLOTS);
  const s = typeof slot === "number" ? slot : 0;
  return ramp[((s % POP_COLOR_SLOTS) + POP_COLOR_SLOTS) % POP_COLOR_SLOTS];
}

/** k colours for a named palette (port of overlay_color_palette). */
export function paletteColors(name: PaletteName, k: number): string[] {
  const n = Math.max(1, Math.floor(k));
  switch (name) {
    case "paired": return qualRamp(PAIRED, n);
    case "default": return qualRamp(TABLEAU, n);
    case "set2": return qualRamp(SET2, n);
    case "dark3": return qualRamp(DARK3, n);
    case "viridis": return sampleRamp(VIRIDIS, n);
    case "plasma": return sampleRamp(PLASMA, n);
    case "cividis": return sampleRamp(CIVIDIS, n);
    case "inferno": return sampleRamp(INFERNO, n);
    case "magma": return sampleRamp(MAGMA, n);
    case "turbo": return sampleRamp(TURBO, n);
    case "jet": return sampleRamp(JET, n);
    case "greys": return sampleRamp(GREYS, n);
    default: return qualRamp(PAIRED, n);
  }
}
