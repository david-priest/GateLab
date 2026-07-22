import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import {
  buildCompensationPairPreview,
  compensationUpperTailEvidence,
  deterministicCompensationEventIndices,
} from "./compensationPairPreview";
import { Sample, type CompensatedLayerInput } from "./sample";
import type { PersistedCompensatedLayerBinding } from "./workspaceCompensation";

function sampleWithCompensation(): Sample {
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: 5,
    instrument: "cytof",
    keywords: {},
    channels: [
      { index: 0, name: "Y89Di", marker: "CD45", bits: 32, range: 1000 },
      { index: 1, name: "Cd106Di", marker: "CD32", bits: 32, range: 1000 },
    ],
    columns: [
      Float32Array.from([0, 5, 10, 15, 1000]),
      Float32Array.from([0, 10, 20, 30, 2000]),
    ],
    spillover: null,
  };
  const sample = new Sample(fcs);
  const binding: PersistedCompensatedLayerBinding = {
    profileId: "profile",
    profileHash: `sha256:${"a".repeat(64)}`,
    matrixHash: `sha256:${"b".repeat(64)}`,
    kind: "cytof-spillover",
    method: "nnls",
    includedPnns: ["Y89Di", "Cd106Di"],
    channelBindings: sample.channels.map((channel, index) => ({
      pnn: channel.pnn,
      fcsColumnIndex: channel.columnIndex,
      matrixSourceIndex: index,
      matrixReceiverIndex: index,
      included: true,
    })),
    transformBinding: { kind: "cytof-asinh", cofactor: 5 },
  };
  const layer: CompensatedLayerInput = {
    metadata: binding,
    columns: [
      { pnn: "Y89Di", fcsColumnIndex: 0, values: Float32Array.from([0, 4, 8, 12, 800]) },
      { pnn: "Cd106Di", fcsColumnIndex: 1, values: Float32Array.from([0, 6, 12, 18, 1200]) },
    ],
  };
  sample.installCompensatedLayer(layer);
  return sample;
}

function sampleWithResidualSlope(): Sample {
  const nEvents = 1_000;
  const source = Float32Array.from({ length: nEvents }, (_, event) =>
    event < 800 ? event % 21 : 1_000 + event % 201);
  const receiverOriginal = Float32Array.from({ length: nEvents }, (_, event) =>
    100 + 0.05 * source[event] + (event % 17) - 8);
  const receiverCompensated = Float32Array.from({ length: nEvents }, (_, event) =>
    100 + 0.02 * source[event] + (event % 17) - 8);
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents,
    instrument: "cytof",
    keywords: {},
    channels: [
      { index: 0, name: "Y89Di", marker: "Source", bits: 32, range: 10_000 },
      { index: 1, name: "Cd106Di", marker: "Receiver", bits: 32, range: 10_000 },
    ],
    columns: [source, receiverOriginal],
    spillover: null,
  };
  const sample = new Sample(fcs);
  const binding: PersistedCompensatedLayerBinding = {
    profileId: "residual-profile",
    profileHash: `sha256:${"c".repeat(64)}`,
    matrixHash: `sha256:${"d".repeat(64)}`,
    kind: "cytof-spillover",
    method: "nnls",
    includedPnns: ["Y89Di", "Cd106Di"],
    channelBindings: sample.channels.map((channel, index) => ({
      pnn: channel.pnn,
      fcsColumnIndex: channel.columnIndex,
      matrixSourceIndex: index,
      matrixReceiverIndex: index,
      included: true,
    })),
    transformBinding: { kind: "cytof-asinh", cofactor: 5 },
  };
  sample.installCompensatedLayer({
    metadata: binding,
    columns: [
      { pnn: "Y89Di", fcsColumnIndex: 0, values: source },
      { pnn: "Cd106Di", fcsColumnIndex: 1, values: receiverCompensated },
    ],
  });
  return sample;
}

function flowSampleWithCompensation(): Sample {
  const originalSource = Float32Array.from([-1_000, -100, 0, 100, 1_000, 10_000, 100_000]);
  const originalReceiver = Float32Array.from([-500, -50, 0, 200, 2_000, 20_000, 200_000]);
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: originalSource.length,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "PE-A", marker: "CD3", bits: 32, range: 262_144 },
      { index: 1, name: "APC-A", marker: "CD19", bits: 32, range: 262_144 },
    ],
    columns: [originalSource, originalReceiver],
    spillover: null,
  };
  const sample = new Sample(fcs);
  const binding: PersistedCompensatedLayerBinding = {
    profileId: "flow-profile",
    profileHash: `sha256:${"e".repeat(64)}`,
    matrixHash: `sha256:${"f".repeat(64)}`,
    kind: "flow-spillover",
    method: "matrix-inverse",
    includedPnns: ["PE-A", "APC-A"],
    channelBindings: sample.channels.map((channel, index) => ({
      pnn: channel.pnn,
      fcsColumnIndex: channel.columnIndex,
      matrixSourceIndex: index,
      matrixReceiverIndex: index,
      included: true,
    })),
    transformBinding: { kind: "flow-linear" },
  };
  sample.installCompensatedLayer({
    metadata: binding,
    columns: [
      { pnn: "PE-A", fcsColumnIndex: 0, values: Float32Array.from(originalSource, (value) => value * 0.9) },
      { pnn: "APC-A", fcsColumnIndex: 1, values: Float32Array.from(originalReceiver, (value) => value * 0.8) },
    ],
  });
  return sample;
}

describe("compensation pair preview", () => {
  it("distinguishes a high-expression point/curve from broad linear association", () => {
    const eventCount = 2_400;
    const source = Array.from({ length: eventCount }, (_, index) => index / (eventCount - 1) * 10);
    const noise = source.map((_, index) => ((index * 17) % 29 - 14) * 0.015);
    const broad = source.map((value, index) => 1.5 + 0.24 * value + noise[index]);
    const curved = source.map((value, index) =>
      1.5 + 0.24 * value + noise[index] + (value > 8.2 ? (value - 8.2) ** 2 * 1.8 : 0));

    const broadEvidence = compensationUpperTailEvidence(source, broad);
    const curvedEvidence = compensationUpperTailEvidence(source, curved);

    expect(Math.abs(broadEvidence.excessMad ?? 99)).toBeLessThan(3);
    expect(Math.abs(broadEvidence.slopeDeltaMad ?? 99)).toBeLessThan(1);
    expect(curvedEvidence.excessMad).toBeGreaterThan(5);
    expect(curvedEvidence.slopeDeltaMad).toBeGreaterThan(1);
  });

  it("samples a frozen population deterministically and reports its eligible total", () => {
    const sample = sampleWithCompensation();
    const mask = Uint8Array.from([0, 1, 0, 1, 1]);
    const fixed = deterministicCompensationEventIndices(sample.fcs.nEvents, 2, mask);
    expect(Array.from(fixed)).toEqual([1, 4]);

    const result = buildCompensationPairPreview(sample, "Y89Di", "Cd106Di", {
      eventMask: mask,
      fixedEventIndices: fixed,
      eligibleEventCount: 3,
    });
    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.preview.eventCount).toBe(2);
    expect(result.preview.totalEvents).toBe(3);
  });

  it("rejects a frozen event selection that escapes the chosen population", () => {
    const sample = sampleWithCompensation();
    expect(buildCompensationPairPreview(sample, "Y89Di", "Cd106Di", {
      eventMask: Uint8Array.from([0, 1, 0, 1, 1]),
      fixedEventIndices: Uint32Array.from([0, 1]),
    })).toEqual({
      ready: false,
      reason: "The frozen compensation event selection is no longer valid.",
    });
  });

  it("uses the same events and locked axes for the two real assay layers", () => {
    const result = buildCompensationPairPreview(sampleWithCompensation(), "Y89Di", "Cd106Di", {
      maxEvents: 4,
    });
    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.preview.eventCount).toBe(4);
    expect(result.preview.totalEvents).toBe(5);
    expect(result.preview.original.x).toHaveLength(4);
    expect(result.preview.original.y).toHaveLength(4);
    expect(result.preview.compensated.x).toHaveLength(4);
    expect(result.preview.compensated.y).toHaveLength(4);
    expect(result.preview.original.y).not.toEqual(result.preview.compensated.y);
    expect(result.preview.original.zeroPile).toEqual({ source: 1, receiver: 1, corner: 1 });
    expect(result.preview.compensated.zeroPile).toEqual({ source: 1, receiver: 1, corner: 1 });
    expect(result.preview.original.x.every((value) => value >= result.preview.xRange[0] && value <= result.preview.xRange[1])).toBe(true);
    expect(result.preview.xRange[1]).toBeGreaterThan(result.preview.xRange[0]);
    expect(result.preview.yRange[1]).toBeGreaterThan(result.preview.yRange[0]);
    // CyTOF metal channels take linear ticks (channelTicks → null), exactly like the Gating tab —
    // so the biplot axis matches Gating with no instrument special-casing.
    expect(result.preview.xTicks).toBeNull();
    expect(result.preview.yTicks).toBeNull();
  });

  it("uses the flow channel transform to supply shared FlowJo-style decade ticks", () => {
    const result = buildCompensationPairPreview(
      flowSampleWithCompensation(),
      "PE-A",
      "APC-A",
    );
    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.preview.xTicks?.tick_mode).toBe("logicle");
    expect(result.preview.yTicks?.tick_mode).toBe("logicle");
    expect(result.preview.xTicks?.major_labels).toContain("0");
    expect(result.preview.xTicks?.major_labels.some((label) => label === "1K" || label === "10K"))
      .toBe(true);
    expect(result.preview.original.x).toHaveLength(result.preview.compensated.x.length);
  });

  it("explains when no compensated layer is installed", () => {
    const sample = sampleWithCompensation();
    sample.removeCompensatedLayer();
    expect(buildCompensationPairPreview(sample, "Y89Di", "Cd106Di")).toEqual({
      ready: false,
      reason: "Apply compensation to compare Original and Compensated data.",
    });
  });

  it("reports conservative source-associated residual evidence without declaring a coefficient", () => {
    const result = buildCompensationPairPreview(
      sampleWithResidualSlope(),
      "Y89Di",
      "Cd106Di",
      { maxEvents: 1_000 },
    );
    expect(result.ready).toBe(true);
    if (!result.ready) return;
    expect(result.preview.evidence.status).toBe("ready");
    expect(result.preview.evidence.sourceLowEvents).toBeGreaterThanOrEqual(190);
    expect(result.preview.evidence.sourceHighEvents).toBeGreaterThanOrEqual(190);
    expect(result.preview.evidence.destinationNegativeEvents).toBeGreaterThan(900);
    expect(result.preview.evidence.normalizedNegativeShift).toBeGreaterThan(1);
    expect(result.preview.evidence.residualSlope).toBeCloseTo(0.02, 2);
    expect(result.preview.evidence.upperTailExcessMad).not.toBeNull();
    expect(result.preview.evidence.upperTailSlopeDeltaMad).not.toBeNull();
  });

  it("does not invent plots for a matrix channel absent from the FCS", () => {
    expect(buildCompensationPairPreview(sampleWithCompensation(), "Y89Di", "Xe131Di")).toEqual({
      ready: false,
      reason: "This matrix pair is not present in the FCS file, so a data biplot cannot be drawn.",
    });
  });
});
