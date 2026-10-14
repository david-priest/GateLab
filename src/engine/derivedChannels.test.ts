import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { gateMaskRectangle } from "./gates";
import { Sample } from "./sample";
import { DERIVED_OBJECT_AREA, DERIVED_OBJECT_COUNT, countFromDerivedChannels, decodeDerivedChannel, encodeDerivedChannel, isDerivedChannelRecord } from "./derivedChannels";
import { WORKSPACE_FEATURES, requiredWorkspaceFeatures } from "./workspaceFeatures";

function flowFile(): FcsFile {
  const names = ["FSC-A", "SSC-A", "Size (FSC)", "Time"];
  return {
    version: "FCS3.1", nEvents: 6, instrument: "flow", keywords: {}, spillover: null,
    channels: names.map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144, ...(name === "Size (FSC)" ? { feature: "MaskSize" } : {}) })),
    columns: names.map((_, index) => Float32Array.from([10, 20, 30, 40, 50, 60].map((v) => v + index))),
  };
}

describe("derived channels on a Sample", () => {
  it("adds a channel on the end, keeps the file's keys and indices, and gates on it", () => {
    const s = new Sample(flowFile());
    const before = s.channels.map((c) => c.key);
    const idx = s.addDerivedChannel({ name: "Objects in image", feature: "ObjectCount", range: 8, values: Uint8Array.from([1, 2, 1, 0, 3, 1]) });
    expect(idx).toBe(4);
    expect(s.channels.slice(0, 4).map((c) => c.key)).toEqual(before);
    expect(s.index("Objects in image")).toBe(4);
    expect(s.isDerivedChannel(4)).toBe(true);
    expect(s.isDerivedChannel(0)).toBe(false);
    expect(Array.from(s.displayColumn(4))).toEqual([1, 2, 1, 0, 3, 1]);
    // A rectangle on count 2..3 against FSC-A keeps events 1 and 4.
    const mask = gateMaskRectangle(s.gatingColumn(4), s.gatingColumn(0), [[1.5, 0], [3.5, 100]]);
    expect(Array.from(mask)).toEqual([0, 1, 0, 0, 1, 0]);
  });
  it("replaces the values of a derived channel by name, drops caches, and refuses a file channel or a wrong length", () => {
    const s = new Sample(flowFile());
    s.addDerivedChannel({ name: "Single cell class", feature: "CellClass", range: 5, values: Uint8Array.from([0, 0, 1, 2, 4, 0]) });
    expect(s.displayColumn(4)[2]).toBe(1);
    let revisions = 0;
    s.subscribeDataRevision(() => { revisions++; });
    const again = s.addDerivedChannel({ name: "Single cell class", feature: "CellClass", range: 5, values: Uint8Array.from([0, 1, 1, 2, 4, 0]) });
    expect(again).toBe(4);
    expect(s.channels.length).toBe(5);
    expect(s.displayColumn(4)[1]).toBe(1);
    expect(revisions).toBe(1);
    expect(() => s.addDerivedChannel({ name: "FSC-A", feature: "x", range: 1, values: new Uint8Array(6) })).toThrow(/channel of the file/);
    expect(() => s.addDerivedChannel({ name: "Short", feature: "x", range: 1, values: new Uint8Array(5) })).toThrow(/5 values/);
  });
  it("lists its derived channels for the workspace, which round-trip through the record", () => {
    const s = new Sample(flowFile());
    s.addDerivedChannel({ name: "Objects in image", feature: "ObjectCount", range: 8, values: Uint8Array.from([1, 2, 1, 0, 3, 1]) });
    s.addDerivedChannel({ name: "Object area (GateLab mask)", feature: "ObjectArea", range: 70000, values: Uint32Array.from([120, 240, 130, 0, 65540, 110]) });
    const specs = s.derivedChannels();
    expect(specs.map((d) => [d.name, d.feature, d.range])).toEqual([["Objects in image", "ObjectCount", 8], ["Object area (GateLab mask)", "ObjectArea", 70000]]);
    const records = specs.map(encodeDerivedChannel);
    expect(records.map((r) => r.dtype)).toEqual(["u8", "u32"]);
    expect(records.every(isDerivedChannelRecord)).toBe(true);
    const back = records.map((r) => decodeDerivedChannel(r, 6));
    expect(Array.from(back[0].values)).toEqual([1, 2, 1, 0, 3, 1]);
    expect(back[1].values).toBeInstanceOf(Uint32Array);
    expect(Array.from(back[1].values)).toEqual([120, 240, 130, 0, 65540, 110]);
    expect(() => decodeDerivedChannel(records[0], 7)).toThrow(/6 values for a file of 7/);
    expect(isDerivedChannelRecord({ ...records[0], dtype: "i64" })).toBe(false);
    const f32 = encodeDerivedChannel({ name: "score", feature: "Score", range: 1, values: Float64Array.from([0.5, 0.25, 1, 0, 0, 0]) });
    expect(f32.dtype).toBe("f32");
    expect(Array.from(decodeDerivedChannel(f32, 6).values)).toEqual([0.5, 0.25, 1, 0, 0, 0]);
  });
  it("is a workspace feature an older GateLab refuses", () => {
    const record = encodeDerivedChannel({ name: "Objects in image", feature: "ObjectCount", range: 8, values: new Uint8Array(6) });
    expect(requiredWorkspaceFeatures({ samples: [{ fileName: "D1.fcs", derived: [record] }] })).toEqual([WORKSPACE_FEATURES.derivedChannels]);
    expect(requiredWorkspaceFeatures({ samples: [{ fileName: "D1.fcs", derived: [] }] })).toEqual([]);
  });
});

describe("countFromDerivedChannels", () => {
  it("rebuilds the worker's count from a reopened file's channels, 255 for an unimaged event", () => {
    const s = new Sample(flowFile());
    expect(countFromDerivedChannels(s, null)).toBeNull();
    s.addDerivedChannel({ name: DERIVED_OBJECT_COUNT, feature: "ObjectCount", range: 8, values: Uint8Array.from([1, 0, 2, 0, 3, 1]) });
    expect(countFromDerivedChannels(s, null)).toBeNull();
    s.addDerivedChannel({ name: DERIVED_OBJECT_AREA, feature: "ObjectArea", range: 400, values: Uint32Array.from([120, 0, 300, 0, 390, 110]) });
    s.addDerivedChannel({ name: "Perimeter (GateLab mask)", feature: "MaskPerimeter", range: 80, values: Float32Array.from([40, 0, 70, 0, 75, 38]) });
    const imaged = Uint8Array.from([1, 0, 1, 1, 1, 1]);
    const count = countFromDerivedChannels(s, imaged)!;
    expect(Array.from(count.objectCount)).toEqual([1, 255, 2, 0, 3, 1]);
    expect(Array.from(count.objectArea)).toEqual([120, 0, 300, 0, 390, 110]);
    expect(Object.keys(count.features!)).toEqual(["perimeter"]);
    expect(Array.from(count.features!.perimeter)).toEqual([40, 0, 70, 0, 75, 38]);
    // A channel of the file by the same name (not derived) does not count.
    const other = new Sample({ ...flowFile(), channels: [...flowFile().channels, { index: 4, name: DERIVED_OBJECT_COUNT, marker: null, bits: 32, range: 8 }], columns: [...flowFile().columns, new Float32Array(6)] });
    expect(countFromDerivedChannels(other, null)).toBeNull();
  });
});
