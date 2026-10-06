import { describe, expect, it } from "vitest";
import { defaultIllustrationConfig, figureStyle } from "./figureDefaults";

describe("the figure's event cap", () => {
  it("is the preview cap, every event for the preview's All events switch, and every event for an export of all events", () => {
    const config = { ...defaultIllustrationConfig(), maxEvents: 2500 };
    expect(figureStyle(config).maxEvents).toBe(2500);
    expect(figureStyle({ ...config, allEvents: true }).maxEvents).toBe(Infinity);
    expect(figureStyle(config, true).maxEvents).toBe(Infinity);
    // The preview cap stays within the page budget and above nothing.
    expect(figureStyle({ ...config, maxEvents: 5_000_000 }).maxEvents).toBe(1_000_000);
    expect(figureStyle({ ...config, maxEvents: 0 }).maxEvents).toBe(10000);
  });
});
