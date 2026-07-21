import { describe, expect, it } from "vitest";
import {
  reportMatrixCompatibility,
  type MatrixCompatibilityReport,
  type SamplePnnChannel,
} from "./compensationCompatibility";
import {
  COMPENSATION_MATRIX_ORIENTATION,
  COMPENSATION_MATRIX_SCHEMA,
  validateAndCanonicalizeCompensationMatrix,
  type CanonicalCompensationMatrix,
  type CompensationKind,
  type CompensationMatrixInput,
} from "./compensationProfile";

function canonical(
  input: CompensationMatrixInput,
  kind: CompensationKind,
): CanonicalCompensationMatrix {
  const result = validateAndCanonicalizeCompensationMatrix(input, kind);
  if (!result.ok) {
    throw new Error(result.errors.map(({ message }) => message).join(" "));
  }
  return result.value;
}

function flowMatrix(offDiagonal = 0.1): CanonicalCompensationMatrix {
  return canonical(
    {
      sourceChannels: ["A", "B"],
      receiverChannels: ["A", "B"],
      matrix: [
        [1, offDiagonal],
        [0.05, 1],
      ],
    },
    "flow-spillover",
  );
}

function cytofMatrix(): CanonicalCompensationMatrix {
  return canonical(
    {
      sourceChannels: ["A", "B"],
      receiverChannels: ["A", "B", "C"],
      matrix: [
        [1, 0.1, 0.2],
        [0.05, 1, 0.3],
      ],
    },
    "cytof-spillover",
  );
}

function channels(...entries: Array<[string, number]>): SamplePnnChannel[] {
  return entries.map(([pnn, columnIndex]) => ({ pnn, columnIndex }));
}

function blockerCodes(report: MatrixCompatibilityReport): string[] {
  return report.blockers.map(({ code }) => code);
}

describe("reportMatrixCompatibility", () => {
  it("maps flow channels by exact $PnN and leaves extra FCS channels as pass-through", () => {
    const report = reportMatrixCompatibility({
      kind: "flow-spillover",
      matrix: flowMatrix(),
      sampleChannels: channels(["FSC-A", 0], ["B", 4], ["A", 2]),
    });
    expect(report.canApply).toBe(true);
    expect(report.requiresReview).toBe(false);
    expect(report.matchedChannels).toEqual(["A", "B"]);
    expect(report.matrixOnlyChannels).toEqual([]);
    expect(report.fcsOnlyChannels).toEqual(["FSC-A"]);
    expect(report.includedChannels).toEqual(["A", "B"]);
    expect(report.excludedChannels).toEqual([]);
    expect(report.bindings).toEqual([
      {
        pnn: "A",
        fcsColumnIndex: 2,
        matrixSourceIndex: 0,
        matrixReceiverIndex: 0,
        included: true,
      },
      {
        pnn: "B",
        fcsColumnIndex: 4,
        matrixSourceIndex: 1,
        matrixReceiverIndex: 1,
        included: true,
      },
    ]);
    expect(report.blockers).toEqual([]);
  });

  it("ignores cosmetic keys, labels, and markers completely", () => {
    const matrix = flowMatrix();
    const before = reportMatrixCompatibility({
      kind: "flow-spillover",
      matrix,
      sampleChannels: [
        { pnn: "A", columnIndex: 2, key: "CD3", label: "Old", marker: "marker-a" },
        { pnn: "B", columnIndex: 4, key: "CD19", label: "B cells", marker: "marker-b" },
      ] as unknown as SamplePnnChannel[],
    });
    const renamed = reportMatrixCompatibility({
      kind: "flow-spillover",
      matrix,
      sampleChannels: [
        { pnn: "A", columnIndex: 2, key: "Renamed A", label: "New", marker: "other" },
        { pnn: "B", columnIndex: 4, key: "Renamed B", label: "Other", marker: null },
      ] as unknown as SamplePnnChannel[],
    });
    expect(renamed).toEqual(before);
    expect(JSON.stringify(renamed)).not.toMatch(/Renamed|CD3|CD19|marker/);
  });

  it("never substitutes a cosmetic key for a nonmatching $PnN", () => {
    const report = reportMatrixCompatibility({
      kind: "flow-spillover",
      matrix: flowMatrix(),
      sampleChannels: [
        { pnn: "detector-1", columnIndex: 0, key: "A", label: "A" },
        { pnn: "detector-2", columnIndex: 1, key: "B", label: "B" },
      ] as unknown as SamplePnnChannel[],
    });
    expect(report.canApply).toBe(false);
    expect(report.matchedChannels).toEqual([]);
    expect(report.matrixOnlyChannels).toEqual(["A", "B"]);
    expect(blockerCodes(report)).toEqual(
      expect.arrayContaining(["empty-overlap", "missing-flow-channel"]),
    );
  });

  it("uses trim + NFC but remains case-sensitive", () => {
    const accented = canonical(
      { sourceChannels: ["É"], receiverChannels: ["É"], matrix: [[1]] },
      "flow-spillover",
    );
    expect(
      reportMatrixCompatibility({
        kind: "flow-spillover",
        matrix: accented,
        sampleChannels: channels(["  E\u0301 ", 0]),
      }).canApply,
    ).toBe(true);

    const caseMismatch = reportMatrixCompatibility({
      kind: "flow-spillover",
      matrix: canonical(
        { sourceChannels: ["A"], receiverChannels: ["A"], matrix: [[1]] },
        "flow-spillover",
      ),
      sampleChannels: channels(["a", 0]),
    });
    expect(caseMismatch.canApply).toBe(false);
    expect(caseMismatch.fcsOnlyChannels).toEqual(["a"]);
  });

  it("blocks a partial flow mapping and reports every missing required channel", () => {
    const report = reportMatrixCompatibility({
      kind: "flow-spillover",
      matrix: flowMatrix(),
      sampleChannels: channels(["A", 0], ["FSC-A", 1]),
    });
    expect(report.canApply).toBe(false);
    expect(report.matchedChannels).toEqual(["A"]);
    expect(report.matrixOnlyChannels).toEqual(["B"]);
    expect(report.fcsOnlyChannels).toEqual(["FSC-A"]);
    expect(report.blockers.find(({ code }) => code === "missing-flow-channel")?.channels).toEqual([
      "B",
    ]);
  });

  it("blocks a matrix with no exact FCS overlap", () => {
    const report = reportMatrixCompatibility({
      kind: "flow-spillover",
      matrix: flowMatrix(),
      sampleChannels: channels(["FSC-A", 0], ["SSC-A", 1]),
    });
    expect(blockerCodes(report)).toContain("empty-overlap");
    expect(report.bindings).toEqual([]);
  });

  it("supports rectangular CyTOF receiver-only channels with an explicit included set", () => {
    const report = reportMatrixCompatibility({
      kind: "cytof-spillover",
      matrix: cytofMatrix(),
      sampleChannels: channels(["D", 7], ["C", 5], ["A", 1], ["B", 3]),
      includedChannels: ["C", "A", "B"],
    });
    expect(report.canApply).toBe(true);
    expect(report.matchedChannels).toEqual(["A", "B", "C"]);
    expect(report.fcsOnlyChannels).toEqual(["D"]);
    expect(report.includedChannels).toEqual(["A", "B", "C"]);
    expect(report.receiverOnlyChannels).toEqual(["C"]);
    expect(report.receiverOnlyIncludedChannels).toEqual(["C"]);
    expect(report.bindings.find(({ pnn }) => pnn === "C")).toEqual({
      pnn: "C",
      fcsColumnIndex: 5,
      matrixSourceIndex: null,
      matrixReceiverIndex: 2,
      included: true,
    });
  });

  it("makes CyTOF inclusion and exclusion explicit without silently shrinking the set", () => {
    const report = reportMatrixCompatibility({
      kind: "cytof-spillover",
      matrix: cytofMatrix(),
      sampleChannels: channels(["A", 0], ["B", 1], ["C", 2]),
      includedChannels: ["C", "A"],
    });
    expect(report.canApply).toBe(true);
    expect(report.includedChannels).toEqual(["A", "C"]);
    expect(report.excludedChannels).toEqual(["B"]);
    expect(report.bindings.find(({ pnn }) => pnn === "B")?.included).toBe(false);
    expect(report.requiresReview).toBe(true);
    expect(report.excludedNonzeroEdges).toEqual([
      { sourcePnn: "A", receiverPnn: "B", coefficient: 0.1 },
      { sourcePnn: "B", receiverPnn: "A", coefficient: 0.05 },
      { sourcePnn: "B", receiverPnn: "C", coefficient: 0.3 },
    ]);
    expect(report.warnings.map(({ code }) => code)).toContain("nonzero-edges-excluded");
  });

  it("allows absent matrix channels only when they are excluded from the CyTOF solve", () => {
    const excluded = reportMatrixCompatibility({
      kind: "cytof-spillover",
      matrix: cytofMatrix(),
      sampleChannels: channels(["A", 0], ["B", 1], ["D", 2]),
      includedChannels: ["A", "B"],
    });
    expect(excluded.canApply).toBe(true);
    expect(excluded.matrixOnlyChannels).toEqual(["C"]);
    expect(excluded.excludedChannels).toEqual(["C"]);

    const included = reportMatrixCompatibility({
      kind: "cytof-spillover",
      matrix: cytofMatrix(),
      sampleChannels: channels(["A", 0], ["B", 1]),
      includedChannels: ["A", "B", "C"],
    });
    expect(included.canApply).toBe(false);
    expect(blockerCodes(included)).toContain("missing-included-channel");
    expect(
      included.blockers.find(({ code }) => code === "missing-included-channel")?.channels,
    ).toEqual(["C"]);
  });

  it("blocks unknown, blank, duplicate, and empty CyTOF included sets", () => {
    const sampleChannels = channels(["A", 0], ["B", 1], ["C", 2], ["D", 3]);
    const unknown = reportMatrixCompatibility({
      kind: "cytof-spillover",
      matrix: cytofMatrix(),
      sampleChannels,
      includedChannels: ["A", "D"],
    });
    expect(blockerCodes(unknown)).toContain("included-channel-not-receiver");
    expect(unknown.includedChannels).toEqual(["A"]);

    const malformed = reportMatrixCompatibility({
      kind: "cytof-spillover",
      matrix: cytofMatrix(),
      sampleChannels,
      includedChannels: ["A", " A ", " "],
    });
    expect(blockerCodes(malformed)).toEqual(
      expect.arrayContaining(["blank-included-channel", "duplicate-included-channel"]),
    );

    const empty = reportMatrixCompatibility({
      kind: "cytof-spillover",
      matrix: cytofMatrix(),
      sampleChannels,
      includedChannels: [],
    });
    expect(blockerCodes(empty)).toContain("empty-included-channels");
  });

  it("detects the actual adapted identity solve, including a selected source with no retained edge", () => {
    const report = reportMatrixCompatibility({
      kind: "cytof-spillover",
      matrix: cytofMatrix(),
      sampleChannels: channels(["A", 2]),
      includedChannels: ["A"],
    });
    expect(report.canApply).toBe(true);
    expect(report.requiresReview).toBe(true);
    expect(report.warnings.map(({ code }) => code)).toEqual([
      "identity-solve",
      "nonzero-edges-excluded",
    ]);
  });

  it("blocks duplicate required PnNs without choosing the first or last column", () => {
    const report = reportMatrixCompatibility({
      kind: "flow-spillover",
      matrix: flowMatrix(),
      sampleChannels: channels(["A", 1], ["A", 9], ["B", 2]),
    });
    expect(report.canApply).toBe(false);
    expect(report.duplicateSamplePnns).toEqual(["A"]);
    expect(blockerCodes(report)).toContain("duplicate-sample-pnn");
    expect(report.bindings.some(({ pnn }) => pnn === "A")).toBe(false);
    expect(report.matchedChannels).toEqual(["B"]);
  });

  it("uses the strict policy for duplicate or blank FCS-only PnNs too", () => {
    const duplicate = reportMatrixCompatibility({
      kind: "flow-spillover",
      matrix: flowMatrix(),
      sampleChannels: channels(["A", 0], ["B", 1], ["QC", 2], ["QC", 3]),
    });
    expect(duplicate.canApply).toBe(false);
    expect(duplicate.duplicateSamplePnns).toEqual(["QC"]);
    expect(duplicate.fcsOnlyChannels).toEqual(["QC"]);

    const blank = reportMatrixCompatibility({
      kind: "flow-spillover",
      matrix: flowMatrix(),
      sampleChannels: channels(["A", 0], ["B", 1], ["  ", 8]),
    });
    expect(blank.canApply).toBe(false);
    expect(blank.blankSampleColumnIndices).toEqual([8]);
    expect(blockerCodes(blank)).toContain("blank-sample-pnn");
  });

  it("blocks duplicate raw FCS column bindings and malformed runtime channel records", () => {
    const duplicateColumn = reportMatrixCompatibility({
      kind: "flow-spillover",
      matrix: flowMatrix(),
      sampleChannels: channels(["A", 0], ["B", 0]),
    });
    expect(blockerCodes(duplicateColumn)).toContain("duplicate-fcs-column-index");

    const malformed = reportMatrixCompatibility({
      kind: "flow-spillover",
      matrix: flowMatrix(),
      sampleChannels: [null, { pnn: "A", columnIndex: -1 }] as unknown as SamplePnnChannel[],
    });
    expect(blockerCodes(malformed)).toContain("invalid-sample-channel");
    expect(malformed.canApply).toBe(false);
    expect(
      malformed.blockers.find(({ code }) => code === "invalid-sample-channel")?.inputPositions,
    ).toEqual([0, 1]);

    const unsafeIndex = reportMatrixCompatibility({
      kind: "flow-spillover",
      matrix: flowMatrix(),
      sampleChannels: [
        { pnn: "A", columnIndex: Number.MAX_SAFE_INTEGER + 1 },
        { pnn: "B", columnIndex: 1 },
      ],
    });
    expect(blockerCodes(unsafeIndex)).toContain("invalid-sample-channel");
  });

  it("blocks an ambiguous included CyTOF channel separately from matrix absence", () => {
    const report = reportMatrixCompatibility({
      kind: "cytof-spillover",
      matrix: cytofMatrix(),
      sampleChannels: channels(["A", 1], ["A", 2], ["B", 3]),
      includedChannels: ["A", "B"],
    });
    expect(blockerCodes(report)).toEqual(
      expect.arrayContaining(["duplicate-sample-pnn", "ambiguous-included-channel"]),
    );
    expect(report.matrixOnlyChannels).not.toContain("A");
    expect(report.matchedChannels).not.toContain("A");
  });

  it("is invariant to sample, included-channel, and pre-canonical matrix ordering", () => {
    const firstMatrix = cytofMatrix();
    const shuffledMatrix = canonical(
      {
        sourceChannels: ["B", "A"],
        receiverChannels: ["C", "B", "A"],
        matrix: [
          [0.3, 1, 0.05],
          [0.2, 0.1, 1],
        ],
      },
      "cytof-spillover",
    );
    const first = reportMatrixCompatibility({
      kind: "cytof-spillover",
      matrix: firstMatrix,
      sampleChannels: channels(["A", 4], ["B", 2], ["C", 9], ["D", 1]),
      includedChannels: ["A", "B", "C"],
    });
    const reordered = reportMatrixCompatibility({
      kind: "cytof-spillover",
      matrix: shuffledMatrix,
      sampleChannels: channels(["D", 1], ["C", 9], ["B", 2], ["A", 4]),
      includedChannels: ["C", "A", "B"],
    });
    expect(reordered).toEqual(first);
  });

  it("surfaces matrix validation warnings as review requirements", () => {
    const report = reportMatrixCompatibility({
      kind: "flow-spillover",
      matrix: flowMatrix(1.2),
      sampleChannels: channels(["A", 0], ["B", 1]),
    });
    expect(report.canApply).toBe(true);
    expect(report.requiresReview).toBe(true);
    expect(report.matrixWarnings.map(({ code }) => code)).toContain("coefficient-over-one");
  });

  it("deep-freezes the report and does not mutate caller-owned channel arrays", () => {
    const sampleChannels = channels(["B", 2], ["A", 1]);
    const before = structuredClone(sampleChannels);
    const report = reportMatrixCompatibility({
      kind: "flow-spillover",
      matrix: flowMatrix(),
      sampleChannels,
    });
    expect(sampleChannels).toEqual(before);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.bindings)).toBe(true);
    expect(Object.isFrozen(report.bindings[0])).toBe(true);
    expect(Object.isFrozen(report.blockers)).toBe(true);
  });

  it("rejects forged canonical schemas, orientations, and modality mismatches", () => {
    const valid = flowMatrix();
    expect(() =>
      reportMatrixCompatibility({
        kind: "flow-spillover",
        matrix: { ...valid, schema: "wrong" } as unknown as CanonicalCompensationMatrix,
        sampleChannels: channels(["A", 0], ["B", 1]),
      }),
    ).toThrow("Unsupported compensation matrix schema");
    expect(() =>
      reportMatrixCompatibility({
        kind: "flow-spillover",
        matrix: {
          ...valid,
          orientation: "receiver-rows-source-columns",
        } as unknown as CanonicalCompensationMatrix,
        sampleChannels: channels(["A", 0], ["B", 1]),
      }),
    ).toThrow("Unsupported compensation matrix orientation");

    const rectangular = cytofMatrix();
    expect(rectangular.schema).toBe(COMPENSATION_MATRIX_SCHEMA);
    expect(rectangular.orientation).toBe(COMPENSATION_MATRIX_ORIENTATION);
    expect(() =>
      reportMatrixCompatibility({
        kind: "flow-spillover",
        matrix: rectangular,
        sampleChannels: channels(["A", 0], ["B", 1], ["C", 2]),
      }),
    ).toThrow("not valid for flow-spillover");

    expect(() =>
      reportMatrixCompatibility({
        kind: "anything",
        matrix: rectangular,
        sampleChannels: channels(["A", 0]),
        includedChannels: ["A"],
      } as unknown as Parameters<typeof reportMatrixCompatibility>[0]),
    ).toThrow("Unsupported compensation kind 'anything'");
  });
});
