import { describe, expect, it } from "vitest";
import { chorusImagingMask, colourRefToHex, defaultChannelDisplay, hasImageWallSettings, hexToRgb } from "./imageWallSettings";

const names = new Map<number, string>([
  [2, "LightLoss (Imaging)"], [3, "FSC"], [4, "SSC (Imaging)"], [5, "Imaging_A"], [6, "Imaging_B"], [7, "Imaging_C"],
]);

const keyword = JSON.stringify({
  ExportImages: true,
  ChannelSettings: [
    { ChannelName: "LightLoss (Imaging)", ChannelNumber: 2, Enabled: true, Color: 12434877, Threshold: 0.0, Saturation: 0.8, Gamma: 1.0, Smoothing: 1 },
    { ChannelName: "FSC", ChannelNumber: 3, Enabled: false, Color: 4259839, Threshold: 0.1, Saturation: 0.9, Gamma: 2.0, Smoothing: 2 },
    { ChannelName: "Imaging_B", ChannelNumber: 6, Enabled: false, Color: 3325695, Threshold: 0.0, Saturation: 0.8, Gamma: 1.0, Smoothing: 1 },
    { ChannelName: "Imaging_C", ChannelNumber: 7, Enabled: false, Color: 255, Threshold: 0.0, Saturation: 0.8, Gamma: 1.0, Smoothing: 1 },
  ],
});

describe("colour refs", () => {
  it("reads a Windows COLORREF as 0x00BBGGRR", () => {
    expect(colourRefToHex(12434877)).toBe("#bdbdbd");
    expect(colourRefToHex(255)).toBe("#ff0000");
    expect(colourRefToHex(3325695)).toBe("#ffbe32");
    expect(colourRefToHex(65280)).toBe("#00ff00");
    expect(hexToRgb("#ffbe32")).toEqual([255, 190, 50]);
    expect(hexToRgb("junk")).toEqual([255, 255, 255]);
  });
});

describe("defaultChannelDisplay", () => {
  it("takes Chorus's settings from the keyword and fills the rest with defaults", () => {
    const display = defaultChannelDisplay(names, { BD_IMAGEWALL_SETTINGS: keyword });
    expect(display.map((d) => d.slot)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(display[0]).toEqual({ slot: 2, name: "LightLoss (Imaging)", enabled: true, colour: "#bdbdbd", threshold: 0, saturation: 0.8, gamma: 1, smoothing: 1 });
    expect(display[1]).toMatchObject({ slot: 3, enabled: false, colour: "#ffff40", threshold: 0.1, saturation: 0.9, gamma: 2, smoothing: 2 });
    // Slots the keyword does not mention keep the palette and are on.
    expect(display[2]).toMatchObject({ slot: 4, enabled: true, colour: "#80ffff" });
    expect(display[4]).toMatchObject({ slot: 6, enabled: false, colour: "#ffbe32" });
    expect(hasImageWallSettings({ BD_IMAGEWALL_SETTINGS: keyword })).toBe(true);
  });

  it("gives every channel the palette, on, when the keyword is absent or malformed", () => {
    const cases: Record<string, string>[] = [{}, { BD_IMAGEWALL_SETTINGS: "{not json" }, { BD_IMAGEWALL_SETTINGS: '{"ChannelSettings":"no"}' }];
    for (const keywords of cases) {
      const display = defaultChannelDisplay(names, keywords);
      expect(display).toHaveLength(6);
      expect(display.every((d) => d.enabled)).toBe(true);
      expect(display.find((d) => d.slot === 7)?.colour).toBe("#ff0000");
    }
    expect(hasImageWallSettings({})).toBe(false);
  });

  it("reads Chorus's mask definition from the FIRE settings", () => {
    const fire = JSON.stringify({ FrequencyInterval: 0, ImagingMaskSettings: { MaskConfiguration: [{ Threshold: 8192, InputChannelId: 4, MaskId: "A" }] } });
    expect(chorusImagingMask({ BDFIRESETTINGS: fire })).toEqual({ slot: 4, fraction: 8192 / 65535 });
    expect(chorusImagingMask({})).toBeNull();
    expect(chorusImagingMask({ BDFIRESETTINGS: "{bad" })).toBeNull();
    expect(chorusImagingMask({ BDFIRESETTINGS: JSON.stringify({ ImagingMaskSettings: { MaskConfiguration: [] } }) })).toBeNull();
    expect(chorusImagingMask({ BDFIRESETTINGS: JSON.stringify({ ImagingMaskSettings: { MaskConfiguration: [{ Threshold: 0, InputChannelId: 4 }] } }) })).toBeNull();
  });

  it("keeps the white point above the black point", () => {
    const bad = JSON.stringify({ ChannelSettings: [{ ChannelNumber: 2, Enabled: true, Threshold: 0.9, Saturation: 0.5 }] });
    const display = defaultChannelDisplay(names, { BD_IMAGEWALL_SETTINGS: bad });
    expect(display[0].threshold).toBe(0.9);
    expect(display[0].saturation).toBeGreaterThan(0.9);
  });
});
