import { describe, expect, it } from "vitest";
import { holdFocusZoomOnAppleTouch, isAppleTouchDevice, viewportWithoutFocusZoom } from "./iosViewport";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

describe("Safari's zoom on a focused control", () => {
  it("is held on an iPhone and on an iPad that asks for desktop sites, and nowhere else", () => {
    expect(isAppleTouchDevice({ userAgent: IPHONE, maxTouchPoints: 5 })).toBe(true);
    expect(isAppleTouchDevice({ userAgent: IPAD_DESKTOP, maxTouchPoints: 5 })).toBe(true);
    // The same user agent on a Mac, which has no touch points.
    expect(isAppleTouchDevice({ userAgent: IPAD_DESKTOP, maxTouchPoints: 0 })).toBe(false);
    expect(isAppleTouchDevice({ userAgent: ANDROID, maxTouchPoints: 5 })).toBe(false);
  });

  it("adds maximum-scale=1 to the viewport once, and leaves a viewport that sets one alone", () => {
    const added = viewportWithoutFocusZoom("width=device-width, initial-scale=1.0");
    expect(added).toBe("width=device-width, initial-scale=1.0, maximum-scale=1");
    expect(viewportWithoutFocusZoom(added)).toBe(added);
    expect(viewportWithoutFocusZoom("width=device-width, maximum-scale=2")).toBe("width=device-width, maximum-scale=2");
  });

  it("rewrites the page's viewport only on an Apple touch device", () => {
    const meta = { content: "width=device-width, initial-scale=1.0" };
    const doc = { querySelector: () => meta } as unknown as Document;
    holdFocusZoomOnAppleTouch(doc, { userAgent: ANDROID, maxTouchPoints: 5 } as Navigator);
    expect(meta.content).toBe("width=device-width, initial-scale=1.0");
    holdFocusZoomOnAppleTouch(doc, { userAgent: IPHONE, maxTouchPoints: 5 } as Navigator);
    expect(meta.content).toBe("width=device-width, initial-scale=1.0, maximum-scale=1");
  });
});
