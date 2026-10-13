// imageWallSettings.ts — how each image channel is shown: the colour it is tinted, where its
// black and white points sit, its gamma and smoothing, and whether it is in the composite at all.
// A FACSDiscover S8 FCS carries what Chorus's own image wall used, in the keyword
// BD_IMAGEWALL_SETTINGS:
//
//   {"ExportImages":true,"ChannelSettings":[{"ChannelName":"LightLoss (Imaging)","ChannelNumber":2,
//     "Enabled":true,"Color":12434877,"Threshold":0.0,"Saturation":0.8,"Gamma":1.0,"Smoothing":1}, …]}
//
// so those are the defaults a file opens with. Color is a Windows COLORREF, 0x00BBGGRR: the
// 598 nm channel's 3325695 = 0x32BEFF is orange read that way and sky blue read as RGB.

export interface ChannelDisplay {
  /** The channel slot in the waveform file (2–7). */
  readonly slot: number;
  readonly name: string;
  readonly enabled: boolean;
  /** `#rrggbb`. */
  readonly colour: string;
  /** Black point, as a fraction of the channel's full scale. */
  readonly threshold: number;
  /** White point, as a fraction of the channel's full scale. */
  readonly saturation: number;
  readonly gamma: number;
  /** 0 or 1 is none; larger values blur with a box of that radius minus one. */
  readonly smoothing: number;
}

export const IMAGE_WALL_SETTINGS_KEYWORD = "BD_IMAGEWALL_SETTINGS";

/** The palette for a file without the keyword, by slot: grey, yellow, cyan, green, orange, red. */
const DEFAULT_COLOURS: Readonly<Record<number, string>> = {
  2: "#bdbdbd",
  3: "#ffff40",
  4: "#80ffff",
  5: "#00ff00",
  6: "#ffbe32",
  7: "#ff0000",
};

export function colourRefToHex(colorRef: number): string {
  const n = Math.max(0, Math.floor(colorRef)) & 0xffffff;
  const r = n & 0xff;
  const g = (n >> 8) & 0xff;
  const b = (n >> 16) & 0xff;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * The display settings for the channels of a file: Chorus's own when the keyword is present and
 * well formed, otherwise a fixed palette with every channel on. `channelNames` (slot → name,
 * from the waveform file) decides which slots exist; a keyword entry for a slot that is not in
 * it is ignored, and a slot the keyword does not mention gets the default.
 */
export function defaultChannelDisplay(
  channelNames: ReadonlyMap<number, string>,
  keywords: Readonly<Record<string, string>> = {},
): ChannelDisplay[] {
  const fromKeyword = new Map<number, Partial<ChannelDisplay>>();
  const raw = keywords[IMAGE_WALL_SETTINGS_KEYWORD];
  if (raw) {
    try {
      const doc = JSON.parse(raw) as { ChannelSettings?: unknown };
      const entries = Array.isArray(doc?.ChannelSettings) ? doc.ChannelSettings : [];
      for (const entry of entries as Record<string, unknown>[]) {
        if (typeof entry?.ChannelNumber !== "number") continue;
        const threshold = Math.min(Math.max(finite(entry.Threshold, 0), 0), 1);
        const saturation = Math.min(Math.max(finite(entry.Saturation, 0.8), 0), 1);
        fromKeyword.set(entry.ChannelNumber, {
          enabled: entry.Enabled === true,
          colour: typeof entry.Color === "number" ? colourRefToHex(entry.Color) : undefined,
          threshold,
          saturation: saturation > threshold ? saturation : Math.min(1, threshold + 0.05),
          gamma: Math.min(Math.max(finite(entry.Gamma, 1), 0.1), 10),
          smoothing: Math.min(Math.max(Math.round(finite(entry.Smoothing, 1)), 0), 8),
        });
      }
    } catch {
      // A malformed keyword is the instrument's problem, not a reason to show nothing.
    }
  }
  const slots = [...channelNames.keys()].sort((a, b) => a - b);
  return slots.map((slot) => {
    const given = fromKeyword.get(slot);
    return {
      slot,
      name: channelNames.get(slot) ?? `Channel ${slot}`,
      enabled: given ? given.enabled === true : true,
      colour: given?.colour ?? DEFAULT_COLOURS[slot] ?? "#ffffff",
      threshold: given?.threshold ?? 0,
      saturation: given?.saturation ?? 0.8,
      gamma: given?.gamma ?? 1,
      smoothing: given?.smoothing ?? 1,
    };
  });
}

export const FIRE_SETTINGS_KEYWORD = "BDFIRESETTINGS";

/** Chorus's mask definition: the image channel it thresholds and the threshold as a fraction of full scale. */
export interface ImagingMask {
  readonly slot: number;
  readonly fraction: number;
}

/**
 * The mask Chorus computed its per-event image features with, from BDFIRESETTINGS
 * (`ImagingMaskSettings.MaskConfiguration[0]`: an InputChannelId, the image channel slot, and a
 * Threshold on the 16-bit pixel scale, 8192 on every file seen). Null when the file has none.
 */
export function chorusImagingMask(keywords: Readonly<Record<string, string>>): ImagingMask | null {
  const raw = keywords[FIRE_SETTINGS_KEYWORD];
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw) as { ImagingMaskSettings?: { MaskConfiguration?: unknown } };
    const first = Array.isArray(doc?.ImagingMaskSettings?.MaskConfiguration) ? doc.ImagingMaskSettings!.MaskConfiguration[0] as Record<string, unknown> : null;
    if (!first || typeof first.InputChannelId !== "number" || typeof first.Threshold !== "number") return null;
    const fraction = first.Threshold / 65535;
    if (!(fraction > 0) || fraction >= 1) return null;
    return { slot: first.InputChannelId, fraction };
  } catch {
    return null;
  }
}

/** True when the file carries Chorus's own wall settings. */
export function hasImageWallSettings(keywords: Readonly<Record<string, string>>): boolean {
  return typeof keywords[IMAGE_WALL_SETTINGS_KEYWORD] === "string";
}
