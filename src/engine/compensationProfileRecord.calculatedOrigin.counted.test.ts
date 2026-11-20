// @vitest-environment jsdom
// A matrix calculated from single-stained controls is stored with a "calculated" origin. The
// origin is a record of where the matrix came from and no part of what is applied: a file
// compensated on a calculated matrix holds the same values, and a gate on it the same events, as
// on the same matrix imported from a file.
import { describe, expect, it } from "vitest";
import { compensate, invertMatrix } from "./compensation";
import { validateAndCanonicalizeCompensationMatrix } from "./compensationProfile";
import {
  createCompensationBaselineProfile,
  validateCompensationProfileRecord,
  type CompensationProfileOrigin,
  type CompensationProfileRecord,
} from "./compensationProfileRecord";
import type { FcsFile } from "./fcs";
import { columnsForGate, getGateMask } from "./gates";
import { newGate, type Gate } from "./models";
import { Sample } from "./sample";

// Four events: FL1 only (its FL2 is all spillover), FL2 only, both, neither.
const FL1 = [1000, 0, 1000, 0];
const FL2 = [500, 400, 900, 0];

const fcs = (): FcsFile => ({
  version: "FCS3.1", nEvents: 4, instrument: "flow", keywords: {}, spillover: null,
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "FL1-A", marker: null, bits: 32, range: 262144 },
    { index: 2, name: "FL2-A", marker: null, bits: 32, range: 262144 },
  ],
  columns: [Float32Array.from([100, 200, 300, 400]), Float32Array.from(FL1), Float32Array.from(FL2)],
} as unknown as FcsFile);

const CALCULATED: CompensationProfileOrigin = {
  type: "calculated",
  estimator: "median-difference",
  estimatorVersion: "1",
  controls: [
    {
      channel: "FL1-A",
      row: "control",
      events: { fileName: "FL1 Stained Control.fcs", count: 2400, lower: 1500 },
      negative: { fileName: "FL1 Stained Control.fcs", count: 2500, upper: 40 },
    },
    { channel: "FL2-A", row: "none" },
  ],
};
const IMPORTED: CompensationProfileOrigin = { type: "uploaded", fileName: "matrix.csv", format: "csv", sourceColumnHeader: "" };

/** FL1 spills into FL2 at 0.5. */
async function record(profileId: string, origin: CompensationProfileOrigin): Promise<CompensationProfileRecord> {
  const matrix = validateAndCanonicalizeCompensationMatrix(
    { sourceChannels: ["FL1-A", "FL2-A"], receiverChannels: ["FL1-A", "FL2-A"], matrix: [[1, 0.5], [0, 1]] },
    "flow-spillover",
  );
  if (!matrix.ok) throw new Error("invalid matrix");
  const created = await createCompensationBaselineProfile({
    kind: "flow-spillover",
    method: "matrix-inverse",
    solverVersion: "flow-lu-v1",
    solverSettings: { singularTolerance: 1e-12, conditionWarningThreshold: 1e8 },
    matrix: matrix.value,
  }, { profileId, name: "FL1 into FL2", createdAt: "2026-11-18T00:00:00.000Z", origin });
  // As a saved workspace returns it.
  return validateCompensationProfileRecord(JSON.parse(JSON.stringify(created)));
}

/** The file with the record's matrix applied and shown. */
function compensatedOn(profile: CompensationProfileRecord): Sample {
  const sample = new Sample(fcs());
  const inverse = invertMatrix(profile.scientific.matrix.matrix.map((row) => [...row]))!;
  const [fl1, fl2] = compensate([Float32Array.from(FL1), Float32Array.from(FL2)], inverse);
  sample.installCompensatedLayer({
    metadata: {
      profileId: profile.profileId, profileHash: profile.profileHash, matrixHash: profile.matrixHash,
      kind: "flow-spillover", method: "matrix-inverse",
      includedPnns: ["FL1-A", "FL2-A"],
      channelBindings: [
        { pnn: "FL1-A", fcsColumnIndex: 1, matrixSourceIndex: 0, matrixReceiverIndex: 0, included: true },
        { pnn: "FL2-A", fcsColumnIndex: 2, matrixSourceIndex: 1, matrixReceiverIndex: 1, included: true },
      ],
      transformBinding: { kind: "flow-linear" },
    },
    columns: [
      { pnn: "FL1-A", fcsColumnIndex: 1, values: fl1 },
      { pnn: "FL2-A", fcsColumnIndex: 2, values: fl2 },
    ],
  } as never);
  sample.setActiveLayer("compensated");
  return sample;
}

/** FL2 from 300 up, any FL1. */
function fl2Positive(sample: Sample): number[] {
  const [, fl1, fl2] = sample.channels.map((channel) => channel.key);
  const gate: Gate = {
    ...newGate("FL2_positive", "rectangle", fl1, fl2, [[-100, 300], [2000, 300], [2000, 2000], [-100, 2000]]),
    space: "raw",
    bounds: "half-open",
  };
  return Array.from(getGateMask(gate, columnsForGate(sample.gateAssayData(), gate)));
}

describe("a file compensated on a calculated matrix", () => {
  it("is gated on the same events as on the same matrix imported", async () => {
    const calculated = await record("calculated", CALCULATED);
    const imported = await record("imported", IMPORTED);
    expect(calculated.origin).toEqual(CALCULATED);
    expect(calculated.matrixHash).toBe(imported.matrixHash);
    expect(calculated.profileHash).toBe(imported.profileHash);

    // Stored values: the FL1-only event passes the gate on its spillover (500).
    expect(fl2Positive(new Sample(fcs()))).toEqual([1, 1, 1, 0]);
    // Compensated, FL2 is 0, 400, 400, 0: the FL2-only event and the double positive.
    expect(fl2Positive(compensatedOn(calculated))).toEqual([0, 1, 1, 0]);
    expect(fl2Positive(compensatedOn(imported))).toEqual([0, 1, 1, 0]);
  });
});
