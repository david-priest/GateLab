// @vitest-environment jsdom
//
// A file whose $PnS is "CD19" resolves to the identity key "CD19", so the detector never appears
// on an axis even though $PnN still holds it and the Panel tab shows it. Reported on the S6
// workspace, where every fluorescence channel read as a bare marker.

import { describe, it, expect } from "vitest";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";

/**
 * A file that carries BOTH a $PnS marker and a $PnN detector, which is the case the control
 * exists for. The Aria fixture has no $PnS at all, so it cannot exercise this.
 */
function load(): Sample {
  const col = (v: number[]) => Float32Array.from(v);
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: 4,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: "SSC-A", bits: 32, range: 262144 },
      { index: 2, name: "BV421-A", marker: "CD19", bits: 32, range: 262144 },
      { index: 3, name: "Alexa Fluor 647-A", marker: "CD45RB", bits: 32, range: 262144 },
    ],
    columns: [
      col([100, 5000, 100, 5000]), col([100, 100, 5000, 5000]),
      col([10, 900, 40, 1200]), col([5, 700, 60, 1500]),
    ],
  };
  return new Sample(fcs);
}

describe("naming channels with or without their detector", () => {
  it("shows the identity key alone by default, as it always has", () => {
    const s = load();
    expect(s.labelMode).toBe("marker");
    s.channels.forEach((c, i) => expect(s.channelLabel(i)).toBe(c.key));
  });

  it("adds the detector from $PnN when asked — the reported case", () => {
    // $PnS "CD19" on detector "BV421-A" resolves to the identity key "CD19", so the fluorophore
    // vanished from every axis even though the file still carried it.
    const s = load();
    const cd19 = s.index("CD19")!;
    expect(s.channelLabel(cd19)).toBe("CD19");

    s.setChannelLabelMode("channel-marker");
    expect(s.channelLabel(cd19)).toBe("CD19 (BV421-A)");
    expect(s.channelLabel(s.index("CD45RB")!)).toBe("CD45RB (Alexa Fluor 647-A)");
  });

  it("does not double up when the marker IS the detector", () => {
    // Scatter channels typically have $PnS equal to $PnN, or none at all. "FSC-A (FSC-A)"
    // would be noise.
    const s = load();
    s.setChannelLabelMode("channel-marker");
    s.channels.forEach((c, i) => {
      if (!c.marker || c.marker.trim() === "" || c.marker === c.pnn) {
        expect(s.channelLabel(i)).toBe(c.pnn || c.key);
      }
    });
  });

  it("lets a Panel-tab rename win in either mode", () => {
    const s = load();
    const idx = s.index("CD19")!;
    s.setChannelLabel(idx, "My name");
    for (const mode of ["marker", "channel-marker"] as const) {
      s.setChannelLabelMode(mode);
      expect(s.channelLabel(idx)).toBe("My name");
    }
  });

  it("cannot move a gate — it renames nothing", () => {
    // The identity key is what gates, masks and compensation are keyed on. Switching the label
    // mode must leave every one of them untouched.
    const s = load();
    const keysBefore = s.channelNames();
    s.setChannelLabelMode("channel-marker");
    expect(s.channelNames()).toEqual(keysBefore);
    // ...and the reverse lookup still resolves, so axis pickers keep working.
    const idx = s.index("CD19")!;
    expect(s.keyForLabel(s.channelLabel(idx))).toBe(s.channels[idx].key);
  });
});
