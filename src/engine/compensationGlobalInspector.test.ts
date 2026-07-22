import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import {
  buildCompensationGlobalInspectorDataset,
  buildCompensationGlobalPairPreview,
  compensationDensitySmoothingRadiusForPlot,
  compensationSharedDensityCeiling,
} from "./compensationGlobalInspector";
import { Sample } from "./sample";
import type { PersistedCompensatedLayerBinding } from "./workspaceCompensation";

function compensatedSample(): Sample {
  const eventCount = 500;
  const source = Float32Array.from({ length: eventCount }, (_, index) => index);
  const receiver = Float32Array.from({ length: eventCount }, (_, index) => index * 2 + index % 7);
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: eventCount,
    instrument: "cytof",
    keywords: {},
    channels: [
      { index: 0, name: "Y89Di", marker: "Source", bits: 32, range: 10_000 },
      { index: 1, name: "Cd106Di", marker: "Receiver", bits: 32, range: 10_000 },
    ],
    columns: [source, receiver],
    spillover: null,
  };
  const sample = new Sample(fcs);
  const metadata: PersistedCompensatedLayerBinding = {
    profileId: "global-inspector",
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
  sample.installCompensatedLayer({
    metadata,
    columns: [
      { pnn: "Y89Di", fcsColumnIndex: 0, values: Float32Array.from(source, (value) => value * 0.9) },
      { pnn: "Cd106Di", fcsColumnIndex: 1, values: Float32Array.from(receiver, (value) => value * 0.7) },
    ],
  }, { activeLayer: "compensated" });
  return sample;
}

function compensatedFlowSample(): Sample {
  const raw = Float32Array.from([-1_000, -100, 0, 100, 1_000, 10_000, 100_000]);
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: raw.length,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "PE-A", marker: "CD3", bits: 32, range: 262_144 },
      { index: 1, name: "APC-A", marker: "CD19", bits: 32, range: 262_144 },
    ],
    columns: [raw, Float32Array.from(raw, (value) => value * 2)],
    spillover: null,
  };
  const sample = new Sample(fcs);
  const metadata: PersistedCompensatedLayerBinding = {
    profileId: "flow-global-inspector",
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
    metadata,
    columns: [
      { pnn: "PE-A", fcsColumnIndex: 0, values: Float32Array.from(raw, (value) => value * 0.9) },
      { pnn: "APC-A", fcsColumnIndex: 1, values: Float32Array.from(raw, (value) => value * 1.8) },
    ],
  }, { activeLayer: "compensated" });
  return sample;
}

describe("global compensation inspector", () => {
  it("freezes one event sample and one set of axes for both assay layers", () => {
    const sample = compensatedSample();
    const dataset = buildCompensationGlobalInspectorDataset(sample, ["Y89Di", "Cd106Di"], {
      maxEvents: 125,
    });
    expect(dataset.ready).toBe(true);
    if (!dataset.ready) return;
    const pair = buildCompensationGlobalPairPreview(dataset.dataset, "Y89Di", "Cd106Di");
    expect(pair.ready).toBe(true);
    if (!pair.ready) return;

    expect(pair.preview.eventCount).toBe(125);
    expect(pair.preview.original.x).toHaveLength(125);
    expect(pair.preview.compensated.x).toHaveLength(125);
    expect(pair.preview.original.x).not.toEqual(pair.preview.compensated.x);
    expect(pair.preview.eventSignature).toBe(dataset.dataset.eventSignature);
    expect(pair.preview.xRange).toBe(dataset.dataset.channels.get("Y89Di")?.range);
    expect(pair.preview.yRange).toBe(dataset.dataset.channels.get("Cd106Di")?.range);
  });

  it("freezes transformed decade ticks with each flow channel projection", () => {
    const dataset = buildCompensationGlobalInspectorDataset(
      compensatedFlowSample(),
      ["PE-A", "APC-A"],
    );
    expect(dataset.ready).toBe(true);
    if (!dataset.ready) return;
    const pair = buildCompensationGlobalPairPreview(dataset.dataset, "PE-A", "APC-A");
    expect(pair.ready).toBe(true);
    if (!pair.ready) return;
    expect(pair.preview.xTicks?.tick_mode).toBe("logicle");
    expect(pair.preview.yTicks?.tick_mode).toBe("logicle");
    expect(pair.preview.xTicks).toBe(dataset.dataset.channels.get("PE-A")?.ticks);
    expect(pair.preview.yTicks).toBe(dataset.dataset.channels.get("APC-A")?.ticks);
  });

  it("uses one finite colour ceiling for the Original/Compensated flip", () => {
    const dataset = buildCompensationGlobalInspectorDataset(
      compensatedSample(),
      ["Y89Di", "Cd106Di"],
      { maxEvents: 200 },
    );
    expect(dataset.ready).toBe(true);
    if (!dataset.ready) return;
    const pair = buildCompensationGlobalPairPreview(dataset.dataset, "Y89Di", "Cd106Di");
    expect(pair.ready).toBe(true);
    if (!pair.ready) return;
    const ceiling = compensationSharedDensityCeiling(pair.preview);
    const smootherCeiling = compensationSharedDensityCeiling(pair.preview, 0.95, 4);
    const higherContrastCeiling = compensationSharedDensityCeiling(pair.preview, 0.95, 3, 2.4);
    expect(Number.isFinite(ceiling)).toBe(true);
    expect(ceiling).toBeGreaterThan(0);
    expect(Number.isFinite(smootherCeiling)).toBe(true);
    expect(smootherCeiling).toBeGreaterThan(0);
    expect(higherContrastCeiling).toBeGreaterThan(ceiling);
  });

  it("keeps the apparent density blur stable as compensation plots resize", () => {
    const setting = 6;
    const smallRadius = compensationDensitySmoothingRadiusForPlot(setting, 160);
    const referenceRadius = compensationDensitySmoothingRadiusForPlot(setting, 220);
    const largeRadius = compensationDensitySmoothingRadiusForPlot(setting, 420);

    expect(smallRadius).toBeGreaterThan(referenceRadius);
    expect(referenceRadius).toBe(setting);
    expect(largeRadius).toBeLessThan(referenceRadius);
    const projectedBlurPixels = [
      smallRadius * (160 - 50) / 256,
      referenceRadius * (220 - 50) / 256,
      largeRadius * (420 - 50) / 256,
    ];
    expect(Math.max(...projectedBlurPixels) - Math.min(...projectedBlurPixels)).toBeLessThan(0.01);
  });

  it("fails closed when no compensated assay is installed", () => {
    const sample = compensatedSample();
    sample.removeCompensatedLayer();
    expect(buildCompensationGlobalInspectorDataset(sample, ["Y89Di"]).ready).toBe(false);
  });
});
