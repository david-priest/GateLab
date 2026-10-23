import { describe, expect, it } from "vitest";
import { axisWindowBounds, clampToAxisWindow } from "./axisWindow";

describe("the view window of a biex axis", () => {
  const table: [number, number] = [0, 256];

  it("stops a pan at either end, keeping the width", () => {
    expect(clampToAxisWindow([-40, 200], table)).toEqual([0, 240]);
    expect(clampToAxisWindow([100, 300], table)).toEqual([56, 256]);
  });

  it("leaves a range inside the table alone, so a zoom in is untouched", () => {
    expect(clampToAxisWindow([20, 120], table)).toEqual([20, 120]);
    expect(clampToAxisWindow([0, 256], table)).toEqual([0, 256]);
  });

  it("stops a zoom out at the full table", () => {
    expect(clampToAxisWindow([-100, 400], table)).toEqual([0, 256]);
    expect(clampToAxisWindow([10, 300], table)).toEqual([0, 256]);
  });

  it("leaves an axis with no ends as it is", () => {
    expect(clampToAxisWindow([-3, 9], null)).toEqual([-3, 9]);
  });

  it("bounds only a channel shown on biex", () => {
    const sample = (scale: string) => ({ fluorScale: () => scale, fluorBiexParams: () => (scale === "biex" ? { channelRange: 256 } : null) });
    expect(axisWindowBounds(sample("biex"), 2)).toEqual([0, 256]);
    expect(axisWindowBounds(sample("logicle"), 2)).toBeNull();
    expect(axisWindowBounds(sample("arcsinh"), 2)).toBeNull();
    expect(axisWindowBounds(sample("biex"), undefined)).toBeNull();
  });
});
