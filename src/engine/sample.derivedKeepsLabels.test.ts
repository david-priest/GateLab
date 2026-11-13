// A derived channel added after a channel was given a label leaves the label in place.
import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";

function flowFile(): FcsFile {
  return {
    version: "FCS3.1", nEvents: 2, instrument: "flow", keywords: { $FIL: "S1.fcs" }, spillover: null,
    channels: ["FSC-A", "FL1-A", "FL2-A"].map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: [Float32Array.from([1, 2]), Float32Array.from([3, 4]), Float32Array.from([5, 6])],
  } as FcsFile;
}
const derived = { name: "Objects", feature: "ObjectCount", range: 8, values: Float32Array.from([1, 2]) };

describe("a Panel-tab label and a derived channel", () => {
  it("keeps the label whichever is done first", () => {
    const addThenRename = new Sample(flowFile());
    addThenRename.addDerivedChannel(derived);
    addThenRename.setChannelLabel(addThenRename.index("FL1-A")!, "CD4_positive");
    expect(addThenRename.labelOverrides()).toEqual({ "FL1-A": "CD4_positive" });

    const renameThenAdd = new Sample(flowFile());
    renameThenAdd.setChannelLabel(renameThenAdd.index("FL1-A")!, "CD4_positive");
    renameThenAdd.addDerivedChannel(derived);
    expect(renameThenAdd.labelOverrides()).toEqual({ "FL1-A": "CD4_positive" });
    expect(renameThenAdd.labelForKey("FL1-A")).toBe("CD4_positive");
  });
});
