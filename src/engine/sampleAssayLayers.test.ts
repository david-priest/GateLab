import { describe, expect, it, vi } from "vitest";
import { parseFcs, type FcsFile } from "./fcs";
import { exportPopulationFcs } from "./fcsExport";
import { exportGatingML } from "./gatingmlExport";
import { compensate, invertMatrix } from "./compensation";
import {
  Sample,
  type CompensatedLayerInput,
} from "./sample";
import type { Sha256Digest } from "./compensationProfile";
import type { PersistedCompensatedLayerBinding } from "./workspaceCompensation";
import type { Gate, PopulationMap } from "./models";

const digest = (character: string): Sha256Digest =>
  `sha256:${character.repeat(64)}` as Sha256Digest;

function flowFcs(
  spillover: FcsFile["spillover"] = null,
): FcsFile {
  return {
    version: "FCS3.1",
    nEvents: 4,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL1-A", marker: "CD3", bits: 32, range: 262144 },
      { index: 2, name: "FL2-A", marker: "CD19", bits: 32, range: 262144 },
      { index: 3, name: "Time", marker: null, bits: 32, range: 262144 },
    ],
    columns: [
      Float32Array.from([100, 200, 300, 400]),
      Float32Array.from([10, 20, 30, 40]),
      Float32Array.from([1, 2, 3, 4]),
      Float32Array.from([0, 1, 2, 3]),
    ],
    spillover,
  };
}

function flowBinding(
  overrides: Partial<PersistedCompensatedLayerBinding> = {},
): PersistedCompensatedLayerBinding {
  return {
    profileId: "flow-profile-a",
    profileHash: digest("a"),
    matrixHash: digest("b"),
    kind: "flow-spillover",
    method: "matrix-inverse",
    includedPnns: ["FL1-A", "FL2-A"],
    channelBindings: [
      {
        pnn: "FL1-A",
        fcsColumnIndex: 1,
        matrixSourceIndex: 0,
        matrixReceiverIndex: 0,
        included: true,
      },
      {
        pnn: "FL2-A",
        fcsColumnIndex: 2,
        matrixSourceIndex: 1,
        matrixReceiverIndex: 1,
        included: true,
      },
    ],
    transformBinding: { kind: "flow-linear" },
    ...overrides,
  };
}

function flowLayer(
  metadata: PersistedCompensatedLayerBinding = flowBinding(),
): CompensatedLayerInput {
  return {
    metadata,
    columns: [
      { pnn: "FL1-A", fcsColumnIndex: 1, values: Float32Array.from([9, 18, 27, 36]) },
      { pnn: "FL2-A", fcsColumnIndex: 2, values: Float32Array.from([-1, -2, -3, -4]) },
    ],
  };
}

function cytofFcs(): FcsFile {
  return {
    version: "FCS3.1",
    nEvents: 3,
    instrument: "cytof",
    keywords: {},
    channels: [
      { index: 0, name: "Time", marker: null, bits: 32, range: 1000 },
      { index: 1, name: "Y89Di", marker: "CD45", bits: 32, range: 1000 },
      { index: 2, name: "In113Di", marker: "Barcode", bits: 32, range: 1000 },
    ],
    columns: [
      Float32Array.from([1, 2, 3]),
      Float32Array.from([10, 20, 30]),
      Float32Array.from([100, 200, 300]),
    ],
    spillover: null,
  };
}

function cytofBinding(): PersistedCompensatedLayerBinding {
  return {
    profileId: "cytof-profile-a",
    profileHash: digest("c"),
    matrixHash: digest("d"),
    kind: "cytof-spillover",
    method: "nnls",
    includedPnns: ["Y89Di", "In113Di"],
    channelBindings: [
      {
        pnn: "Y89Di",
        fcsColumnIndex: 1,
        matrixSourceIndex: 0,
        matrixReceiverIndex: 0,
        included: true,
      },
      {
        pnn: "In113Di",
        fcsColumnIndex: 2,
        matrixSourceIndex: 1,
        matrixReceiverIndex: 1,
        included: true,
      },
    ],
    transformBinding: { kind: "cytof-asinh", cofactor: 5 },
  };
}

function invalidationSpy(sample: Sample) {
  return vi.spyOn(
    sample as unknown as { invalidateAll(): void },
    "invalidateAll",
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

describe("Sample explicit assay layers", () => {
  it("starts in Original and refuses to label missing data as compensated", () => {
    const sample = new Sample(flowFcs());
    const displayBefore = sample.displayColumn(sample.index("CD3")!);
    const spy = invalidationSpy(sample);

    expect(sample.activeLayer).toBe("original");
    expect(sample.dataRevision).toBe(0);
    expect(sample.compensatedLayerStatus()).toEqual({ state: "missing" });
    expect(() => sample.compensatedColumnData(sample.index("CD3")!)).toThrow(
      "no complete result is installed",
    );
    expect(() => sample.setActiveLayer("compensated")).toThrow(
      "no complete result is installed",
    );
    expect(() => exportPopulationFcs(sample, null, "compensated")).toThrow(
      "no complete result is installed",
    );
    expect(sample.displayColumn(sample.index("CD3")!)).toBe(displayBefore);
    expect(sample.dataRevision).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("installs by exact $PnN/FCS identity while Original remains active", () => {
    const sample = new Sample(flowFcs());
    const cd3 = sample.index("CD3")!;
    const scatter = sample.index("FSC-A")!;
    const originalCd3 = sample.originalColumnData(cd3);
    const originalBytes = Array.from(originalCd3);
    const displayBefore = sample.displayColumn(cd3);
    const spy = invalidationSpy(sample);

    sample.installCompensatedLayer(flowLayer());

    expect(sample.activeLayer).toBe("original");
    expect(sample.compensatedLayerStatus(flowBinding()).state).toBe("ready");
    expect(Array.from(sample.compensatedColumnData(cd3))).toEqual([9, 18, 27, 36]);
    expect(sample.compensatedColumnData(scatter)).toBe(sample.originalColumnData(scatter));
    expect(sample.rawColumnData(cd3)).toBe(originalCd3);
    expect(Array.from(sample.originalColumnData(cd3))).toEqual(originalBytes);
    expect(sample.displayColumn(cd3)).not.toBe(displayBefore);
    expect(Array.from(sample.displayColumn(cd3))).toEqual(Array.from(displayBefore));
    expect(sample.dataRevision).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);

    const exported = parseFcs(toArrayBuffer(exportPopulationFcs(sample, null, "compensated")));
    expect(Array.from(exported.columns[1])).toEqual([9, 18, 27, 36]);
    expect(Array.from(exported.columns[0])).toEqual(Array.from(sample.originalColumnData(scatter)));
  });

  it("routes every active linear/display/gating consumer through one layer switch", () => {
    const sample = new Sample(flowFcs());
    const cd3 = sample.index("CD3")!;
    const original = sample.originalColumnData(cd3);
    const displayOriginal = sample.displayColumn(cd3);
    const gatingData = sample.gatingData();
    sample.installCompensatedLayer(flowLayer());
    const inactiveDisplay = sample.displayColumn(cd3);
    const inactiveRange = sample.displayRange(cd3);
    const spy = invalidationSpy(sample);

    sample.setActiveLayer("compensated", flowBinding());

    expect(sample.rawColumnData(cd3)).toBe(sample.compensatedColumnData(cd3));
    expect(sample.gatingColumn(cd3)).toBe(sample.compensatedColumnData(cd3));
    expect(gatingData.column("CD3")).toBe(sample.compensatedColumnData(cd3));
    expect(sample.displayColumn(cd3)).not.toBe(inactiveDisplay);
    expect(sample.displayRange(cd3)).not.toBe(inactiveRange);
    expect(sample.displayColumn(cd3)).not.toBe(displayOriginal);
    expect(sample.activeLayer).toBe("compensated");
    expect(sample.dataRevision).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);

    sample.setActiveLayer("compensated");
    expect(sample.dataRevision).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);

    sample.setActiveLayer("original");
    expect(sample.rawColumnData(cd3)).toBe(original);
    expect(sample.gatingColumn(cd3)).toBe(original);
    expect(gatingData.column("CD3")).toBe(original);
    expect(Array.from(sample.displayColumn(cd3))).toEqual(Array.from(displayOriginal));
    expect(sample.dataRevision).toBe(3);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("installs-and-activates and removes-and-restores atomically", () => {
    const sample = new Sample(flowFcs());
    const cd3 = sample.index("CD3")!;
    const original = sample.originalColumnData(cd3);
    const originalRefs = sample.channels.map((_, index) => sample.originalColumnData(index));
    const originalValues = originalRefs.map((column) => Array.from(column));
    const spy = invalidationSpy(sample);

    sample.installCompensatedLayer(flowLayer(), { activeLayer: "compensated" });
    const compensatedDisplay = sample.displayColumn(cd3);
    const compensatedRange = sample.displayRange(cd3);
    expect(sample.activeLayer).toBe("compensated");
    expect(sample.dataRevision).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);

    sample.removeCompensatedLayer();
    expect(sample.activeLayer).toBe("original");
    expect(sample.compensatedLayerStatus()).toEqual({ state: "missing" });
    expect(sample.rawColumnData(cd3)).toBe(original);
    expect(sample.displayColumn(cd3)).not.toBe(compensatedDisplay);
    expect(sample.displayRange(cd3)).not.toBe(compensatedRange);
    for (let index = 0; index < originalRefs.length; index++) {
      expect(sample.originalColumnData(index)).toBe(originalRefs[index]);
      expect(Array.from(sample.originalColumnData(index))).toEqual(originalValues[index]);
    }
    expect(sample.dataRevision).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);

    sample.removeCompensatedLayer();
    expect(sample.dataRevision).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("distinguishes a ready installed layer from a stale expected profile", () => {
    const sample = new Sample(flowFcs());
    sample.installCompensatedLayer(flowLayer());
    const expectedOtherRevision = flowBinding({
      profileId: "flow-profile-b",
      profileHash: digest("e"),
      matrixHash: digest("f"),
      includedPnns: ["FL2-A", "FL1-A"],
    });
    const stale = sample.compensatedLayerStatus(expectedOtherRevision);

    expect(stale.state).toBe("stale");
    if (stale.state === "stale") {
      expect(stale.reasons).toEqual(expect.arrayContaining([
        "profile-id-mismatch",
        "profile-hash-mismatch",
        "matrix-hash-mismatch",
        "included-pnns-mismatch",
      ]));
    }
    expect(sample.compensatedLayerStatus().state).toBe("ready");
    expect(() => sample.setActiveLayer("compensated", expectedOtherRevision)).toThrow("stale");
    expect(sample.activeLayer).toBe("original");
    expect(sample.dataRevision).toBe(1);
  });

  it("never lets the legacy embedded toggle select a profile-derived layer", () => {
    const sample = new Sample(flowFcs({
      channels: ["FL1-A", "FL2-A"],
      matrix: [[1, 0.1], [0.2, 1]],
    }));
    sample.installCompensatedLayer(flowLayer());

    expect(() => sample.setCompensation(true)).toThrow(
      "profile-derived layer is installed",
    );
    expect(sample.activeLayer).toBe("original");
    expect(sample.dataRevision).toBe(1);

    sample.setActiveLayer("compensated", flowBinding());
    expect(() => sample.setCompensation(true)).toThrow(
      "profile-derived layer is installed",
    );
    expect(sample.activeLayer).toBe("compensated");
    expect(sample.dataRevision).toBe(2);
  });

  it("blocks Gating-ML from mislabelling an active profile as embedded FCS compensation", () => {
    const sample = new Sample(flowFcs({
      channels: ["FL1-A", "FL2-A"],
      matrix: [[1, 0.1], [0.2, 1]],
    }));
    sample.installCompensatedLayer(flowLayer(), { activeLayer: "compensated" });
    const gate: Gate = {
      gate_id: "gate-1",
      name: "Signal",
      gate_type: "rectangle",
      x_channel: "CD3",
      y_channel: "CD19",
      vertices: [[0, 0], [30, 3]],
      color: "#377eb8",
      label_offset: null,
    };
    const populations: PopulationMap = {
      root: {
        population_id: "root",
        name: "All Events",
        gate_refs: [],
        gate_logic: "and",
        parent_id: null,
        children: ["signal"],
        event_count: 4,
        percent_of_parent: 100,
      },
      signal: {
        population_id: "signal",
        name: "Signal",
        gate_refs: [{ gate_id: gate.gate_id, include: true }],
        gate_logic: "and",
        parent_id: "root",
        children: [],
        event_count: null,
        percent_of_parent: null,
      },
    };

    expect(() => exportGatingML({
      gates: { [gate.gate_id]: gate },
      gate_order: [gate.gate_id],
      populations,
      root_population_id: "root",
      sample,
      format: "standard",
    })).toThrow("uploaded or edited compensation profile");
  });

  it("rejects malformed replacements transactionally", () => {
    const cases: Array<{ name: string; input: CompensatedLayerInput }> = [
      {
        name: "display marker used as identity",
        input: {
          ...flowLayer(),
          columns: [
            { pnn: "CD3", fcsColumnIndex: 1, values: Float32Array.from([1, 2, 3, 4]) },
            flowLayer().columns[1],
          ],
        },
      },
      {
        name: "swapped FCS output index",
        input: {
          ...flowLayer(),
          columns: [
            { pnn: "FL1-A", fcsColumnIndex: 2, values: Float32Array.from([1, 2, 3, 4]) },
            flowLayer().columns[1],
          ],
        },
      },
      {
        name: "missing included output",
        input: { ...flowLayer(), columns: [flowLayer().columns[0]] },
      },
      {
        name: "duplicate output",
        input: {
          ...flowLayer(),
          columns: [flowLayer().columns[0], flowLayer().columns[0], flowLayer().columns[1]],
        },
      },
      {
        name: "wrong event count",
        input: {
          ...flowLayer(),
          columns: [
            { pnn: "FL1-A", fcsColumnIndex: 1, values: Float32Array.from([1, 2]) },
            flowLayer().columns[1],
          ],
        },
      },
      {
        name: "non-finite event",
        input: {
          ...flowLayer(),
          columns: [
            { pnn: "FL1-A", fcsColumnIndex: 1, values: Float32Array.from([1, 2, NaN, 4]) },
            flowLayer().columns[1],
          ],
        },
      },
      {
        name: "marker in persisted binding",
        input: flowLayer(flowBinding({
          includedPnns: ["CD3", "FL2-A"],
          channelBindings: [
            { ...flowBinding().channelBindings[0], pnn: "CD3" },
            flowBinding().channelBindings[1],
          ],
        })),
      },
      {
        name: "wrong persisted FCS binding",
        input: flowLayer(flowBinding({
          channelBindings: [
            { ...flowBinding().channelBindings[0], fcsColumnIndex: 2 },
            flowBinding().channelBindings[1],
          ],
        })),
      },
      {
        name: "duplicate matrix receiver index",
        input: flowLayer(flowBinding({
          channelBindings: [
            flowBinding().channelBindings[0],
            { ...flowBinding().channelBindings[1], matrixReceiverIndex: 0 },
          ],
        })),
      },
      {
        name: "duplicate matrix source index",
        input: flowLayer(flowBinding({
          channelBindings: [
            flowBinding().channelBindings[0],
            { ...flowBinding().channelBindings[1], matrixSourceIndex: 0 },
          ],
        })),
      },
      {
        name: "null conventional-flow source index",
        input: flowLayer(flowBinding({
          channelBindings: [
            { ...flowBinding().channelBindings[0], matrixSourceIndex: null },
            flowBinding().channelBindings[1],
          ],
        })),
      },
      {
        name: "excluded conventional-flow binding",
        input: flowLayer(flowBinding({
          includedPnns: ["FL1-A"],
          channelBindings: [
            flowBinding().channelBindings[0],
            { ...flowBinding().channelBindings[1], included: false },
          ],
        })),
      },
      {
        name: "non-contiguous conventional-flow receiver coverage",
        input: flowLayer(flowBinding({
          channelBindings: [
            flowBinding().channelBindings[0],
            { ...flowBinding().channelBindings[1], matrixReceiverIndex: 2 },
          ],
        })),
      },
      {
        name: "wrong modality",
        input: {
          metadata: {
            ...flowBinding(),
            kind: "cytof-spillover",
            method: "nnls",
            transformBinding: { kind: "cytof-asinh", cofactor: 5 },
          },
          columns: flowLayer().columns,
        },
      },
      {
        name: "unknown modality",
        input: {
          metadata: {
            ...flowBinding(),
            kind: "unknown",
          } as unknown as PersistedCompensatedLayerBinding,
          columns: flowLayer().columns,
        },
      },
      {
        name: "unknown transform",
        input: {
          metadata: {
            ...flowBinding(),
            transformBinding: { kind: "unknown" },
          } as unknown as PersistedCompensatedLayerBinding,
          columns: flowLayer().columns,
        },
      },
    ];

    for (const candidate of cases) {
      const sample = new Sample(flowFcs());
      const original = Array.from(sample.originalColumnData(sample.index("CD3")!));
      sample.installCompensatedLayer(flowLayer(), { activeLayer: "compensated" });
      const displayBefore = sample.displayColumn(sample.index("CD3")!);
      const valuesBefore = Array.from(sample.rawColumnData(sample.index("CD3")!));
      const spy = invalidationSpy(sample);

      expect(
        () => sample.installCompensatedLayer(candidate.input, { activeLayer: "compensated" }),
        candidate.name,
      ).toThrow();
      expect(sample.activeLayer, candidate.name).toBe("compensated");
      expect(sample.compensatedLayerStatus(flowBinding()).state, candidate.name).toBe("ready");
      expect(Array.from(sample.rawColumnData(sample.index("CD3")!)), candidate.name).toEqual(valuesBefore);
      expect(Array.from(sample.originalColumnData(sample.index("CD3")!)), candidate.name).toEqual(original);
      expect(sample.displayColumn(sample.index("CD3")!), candidate.name).toBe(displayBefore);
      expect(sample.dataRevision, candidate.name).toBe(1);
      expect(spy, candidate.name).not.toHaveBeenCalled();
    }
  });

  it("rejects an exact binding when the sample itself has duplicate $PnNs", () => {
    const fcs = flowFcs();
    fcs.channels[2] = { ...fcs.channels[2], name: "FL1-A", marker: "CD19" };
    const sample = new Sample(fcs);
    const metadata = flowBinding({
      includedPnns: ["FL1-A"],
      channelBindings: [flowBinding().channelBindings[0]],
    });

    expect(() => sample.installCompensatedLayer({
      metadata,
      columns: [flowLayer().columns[0]],
    })).toThrow("does not match this sample");
    expect(sample.compensatedLayerStatus()).toEqual({ state: "missing" });
    expect(sample.dataRevision).toBe(0);
  });

  it("uses compensated counts before the CyTOF asinh display/gating transform", () => {
    const sample = new Sample(cytofFcs());
    const binding = cytofBinding();
    const cd45 = sample.index("CD45")!;
    const originalDisplay = sample.displayColumn(cd45);
    const originalGating = sample.gatingColumn(cd45);
    const originalRange = sample.displayRange(cd45);
    sample.installCompensatedLayer({
      metadata: binding,
      columns: [
        { pnn: "Y89Di", fcsColumnIndex: 1, values: Float32Array.from([5, 10, 15]) },
        { pnn: "In113Di", fcsColumnIndex: 2, values: Float32Array.from([50, 100, 150]) },
      ],
    }, { activeLayer: "compensated" });

    expect(Array.from(sample.rawColumnData(cd45))).toEqual([5, 10, 15]);
    expect(sample.displayColumn(cd45)).not.toBe(originalDisplay);
    expect(sample.gatingColumn(cd45)).not.toBe(originalGating);
    expect(sample.displayRange(cd45)).not.toBe(originalRange);
    expect(Array.from(sample.displayColumn(cd45))).toEqual(
      [5, 10, 15].map((value) => expect.closeTo(Math.asinh(value / 5), 6)),
    );
    expect(Array.from(sample.gatingColumn(cd45))).toEqual(Array.from(sample.displayColumn(cd45)));
    expect(sample.rawColumnData(sample.index("Time")!)).toBe(
      sample.originalColumnData(sample.index("Time")!),
    );

    const revision = sample.dataRevision;
    sample.setInstrumentMode("flow");
    expect(sample.activeLayer).toBe("original");
    const status = sample.compensatedLayerStatus();
    expect(status.state).toBe("stale");
    if (status.state === "stale") expect(status.reasons).toContain("sample-kind-mismatch");
    expect(sample.dataRevision).toBe(revision + 1);
  });

  it("marks a CyTOF layer stale and returns to Original when its bound cofactor changes", () => {
    const sample = new Sample(cytofFcs());
    const binding = cytofBinding();
    const cd45 = sample.index("CD45")!;
    sample.installCompensatedLayer({
      metadata: binding,
      columns: [
        { pnn: "Y89Di", fcsColumnIndex: 1, values: Float32Array.from([5, 10, 15]) },
        { pnn: "In113Di", fcsColumnIndex: 2, values: Float32Array.from([50, 100, 150]) },
      ],
    }, { activeLayer: "compensated" });
    const compensatedDisplay = sample.displayColumn(cd45);
    const revision = sample.dataRevision;
    const spy = invalidationSpy(sample);

    sample.setCytofCofactor(10);

    expect(sample.activeLayer).toBe("original");
    const status = sample.compensatedLayerStatus();
    expect(status.state).toBe("stale");
    if (status.state === "stale") {
      expect(status.reasons).toContain("transform-binding-mismatch");
    }
    expect(() => sample.compensatedColumnData(cd45)).toThrow("transform-binding-mismatch");
    expect(sample.displayColumn(cd45)).not.toBe(compensatedDisplay);
    expect(sample.displayColumn(cd45)[0]).toBeCloseTo(Math.asinh(10 / 10), 6);
    expect(sample.dataRevision).toBe(revision + 1);
    expect(spy).toHaveBeenCalledTimes(1);

    sample.setCytofCofactor(5);
    expect(sample.compensatedLayerStatus(binding).state).toBe("ready");
    expect(sample.activeLayer).toBe("original");
  });

  it("revises an inactive layer when context changes its ready/stale status", () => {
    const sample = new Sample(cytofFcs());
    const binding = cytofBinding();
    sample.installCompensatedLayer({
      metadata: binding,
      columns: [
        { pnn: "Y89Di", fcsColumnIndex: 1, values: Float32Array.from([5, 10, 15]) },
        { pnn: "In113Di", fcsColumnIndex: 2, values: Float32Array.from([50, 100, 150]) },
      ],
    });
    expect(sample.activeLayer).toBe("original");
    expect(sample.dataRevision).toBe(1);

    sample.setCytofCofactor(10);
    expect(sample.compensatedLayerStatus().state).toBe("stale");
    expect(sample.dataRevision).toBe(2);

    sample.setCytofCofactor(5);
    expect(sample.compensatedLayerStatus(binding).state).toBe("ready");
    expect(sample.dataRevision).toBe(3);

    sample.setInstrumentMode("flow");
    expect(sample.compensatedLayerStatus().state).toBe("stale");
    expect(sample.dataRevision).toBe(4);
  });

  it("passes an explicitly excluded CyTOF receiver through in access and export", () => {
    const sample = new Sample(cytofFcs());
    const binding: PersistedCompensatedLayerBinding = {
      ...cytofBinding(),
      includedPnns: ["Y89Di"],
      channelBindings: [
        cytofBinding().channelBindings[0],
        { ...cytofBinding().channelBindings[1], included: false },
      ],
    };
    const cd45 = sample.index("CD45")!;
    const barcode = sample.index("Barcode")!;
    sample.installCompensatedLayer({
      metadata: binding,
      columns: [
        { pnn: "Y89Di", fcsColumnIndex: 1, values: Float32Array.from([5, 10, 15]) },
      ],
    });

    expect(sample.activeLayer).toBe("original");
    expect(Array.from(sample.compensatedColumnData(cd45))).toEqual([5, 10, 15]);
    expect(sample.compensatedColumnData(barcode)).toBe(sample.originalColumnData(barcode));

    const exported = parseFcs(toArrayBuffer(exportPopulationFcs(sample, null, "compensated")));
    expect(Array.from(exported.columns[1])).toEqual([5, 10, 15]);
    expect(Array.from(exported.columns[2])).toEqual([100, 200, 300]);
  });
});

describe("legacy embedded-$SPILLOVER bridge", () => {
  it("produces the same complete output as the existing flow calculation", () => {
    const matrix = [[1, 0.1], [0.2, 1]];
    const sample = new Sample(flowFcs({ channels: ["FL1-A", "FL2-A"], matrix }));
    const cd3 = sample.index("CD3")!;
    const cd19 = sample.index("CD19")!;
    const originalCd3 = sample.originalColumnData(cd3);
    const expected = compensate(
      [sample.originalColumnData(cd3), sample.originalColumnData(cd19)],
      invertMatrix(matrix)!,
    );
    const spy = invalidationSpy(sample);

    sample.setCompensation(true);

    expect(sample.compensationEnabled).toBe(true);
    expect(sample.activeLayer).toBe("compensated");
    expect(sample.dataRevision).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sample.compensatedLayerStatus().state).toBe("ready");
    expect(sample.compensatedLayerStatus(flowBinding()).state).toBe("stale");
    expect(Array.from(sample.compensatedColumnData(cd3))).toEqual(Array.from(expected[0]));
    expect(Array.from(sample.compensatedColumnData(cd19))).toEqual(Array.from(expected[1]));
    expect(sample.originalColumnData(cd3)).toBe(originalCd3);

    sample.setCompensation(false);
    expect(sample.activeLayer).toBe("original");
    expect(sample.compensatedLayerStatus()).toEqual({ state: "missing" });
    expect(sample.rawColumnData(cd3)).toBe(originalCd3);
    expect(sample.dataRevision).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["absent", null],
    ["singular", { channels: ["FL1-A", "FL2-A"], matrix: [[1, 1], [1, 1]] }],
  ])("fails closed for %s embedded spillover", (_label, spillover) => {
    const sample = new Sample(flowFcs(spillover));
    const cd3 = sample.index("CD3")!;
    const gatingBefore = sample.gatingColumn(cd3);
    const spy = invalidationSpy(sample);

    sample.setCompensation(true);

    expect(sample.activeLayer).toBe("original");
    expect(sample.compensationEnabled).toBe(false);
    expect(sample.compensatedLayerStatus()).toEqual({ state: "missing" });
    expect(sample.gatingColumn(cd3)).toBe(gatingBefore);
    expect(sample.dataRevision).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
