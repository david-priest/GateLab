import { describe, expect, it } from "vitest";
import { ChannelScales } from "./channelScales";
import { Sample } from "./sample";
import { restoreChannelScales } from "./restoreChannelScales";

function sample(): Sample {
  return new Sample({
    version: "FCS3.1",
    nEvents: 3,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: ["FSC-A", "SSC-A", "FL1-A"].map((name, index) => ({
      index,
      name,
      marker: null,
      bits: 32,
      range: 262144,
    })),
    columns: [
      Float32Array.of(1000, 2000, 3000),
      Float32Array.of(1500, 2500, 3500),
      Float32Array.of(-100, 200, 10000),
    ],
  });
}
const saved = () => ({
  logicleW: { "FL1-A": 1.6 },
  scatterCofactor: { "FSC-A": 300, "FL1-A": 250 },
  scatterLinear: ["FSC-A"],
  fluorArcsinh: ["FL1-A"],
});

describe("workspace transform restoration", () => {
  it("replaces previous settings and uses the saved active file as channel authority", () => {
    const scales = new ChannelScales(),
      a = sample(),
      b = sample();
    scales.setScatterLinear(a.workspaceScaleContextKey, "SSC-A", true);
    scales.setLogicleW(a.workspaceScaleContextKey, "FL1-A", 0.2);
    restoreChannelScales(scales, [a, b], [{ logicleW: {} }, saved()], 1);
    a.attachChannelScales(scales);
    b.attachChannelScales(scales);
    for (const s of [a, b]) {
      expect(s.rawToDisplay("FSC-A", 2000)).toBe(2000);
      expect(s.scatterScale(1)).toBe("arcsinh");
      expect(s.currentLogicleW(2)).toBe(1.6);
      expect(s.currentScatterCofactor(0)).toBe(300);
      expect(s.fluorScale(2)).toBe("arcsinh");
    }
  });

  it("restores an arcsinh choice by the saved key, whatever class the channel turns out to be", () => {
    // The choice is saved under one key for every class that can make it. Restoring by class
    // would drop the key for a class the restorer does not know, so the list alone decides.
    const scales = new ChannelScales();
    const s = sample();
    restoreChannelScales(scales, [s], [{ logicleW: {}, fluorArcsinh: ["FL1-A", "FSC-A"] }], 0);
    expect(scales.isFluorArcsinh(s.workspaceScaleContextKey, "FL1-A")).toBe(true);
    // A scatter axis is never in the list; if it were, it would be ignored.
    expect(scales.isFluorArcsinh(s.workspaceScaleContextKey, "FSC-A")).toBe(false);
    s.attachChannelScales(scales);
    expect(s.fluorScale(2)).toBe("arcsinh");
    expect(s.scatterScale(0)).toBe("arcsinh");
  });

  it("does not resurrect detached settings when edited and saved again", () => {
    const s = sample(),
      scales = new ChannelScales();
    s.applyScatterLinearKeys(["FSC-A"]);
    s.applyFluorArcsinhKeys(["FL1-A"]);
    s.setLogicleW(2, 1.6);
    s.setScatterCofactor(0, 300);
    s.setFluorCofactor(2, 250);
    restoreChannelScales(scales, [s], [saved()], 0);
    s.attachChannelScales(scales);
    s.setScatterScale(0, "arcsinh");
    s.setFluorScale(2, "logicle");
    s.resetScatterCofactor(0);
    s.resetFluorCofactor(2);
    s.resetLogicleW(2);
    expect(s.scatterLinearKeys()).toEqual([]);
    expect(s.fluorArcsinhKeys()).toEqual([]);
    expect(s.scatterCofactorOverrides()).toEqual({});
    expect(s.logicleWOverrides()).toEqual({});
    expect(s.currentScatterCofactor(0)).toBe(150);
    expect(s.currentFluorCofactor(2)).toBe(150);
    expect(s.currentLogicleW(2)).toBe(s.ownAutoLogicleW(2));
    const reopened = sample();
    restoreChannelScales(
      new ChannelScales(),
      [reopened],
      [
        {
          logicleW: s.logicleWOverrides(),
          scatterCofactor: s.scatterCofactorOverrides(),
          scatterLinear: s.scatterLinearKeys(),
          fluorArcsinh: s.fluorArcsinhKeys(),
        },
      ],
      0,
    );
    expect(reopened.transformSpec("FSC-A")).toEqual(s.transformSpec("FSC-A"));
  });
});
