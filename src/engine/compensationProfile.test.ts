import { describe, expect, it } from "vitest";
import {
  canonicalizeCompensationProfileHashInput,
  hashCompensationMatrix,
  hashCompensationProfile,
  serializeCanonicalCompensationMatrix,
  validateAndCanonicalizeCompensationMatrix,
  type CanonicalCompensationMatrix,
  type CompensationMatrixInput,
  type CompensationProfileHashInput,
} from "./compensationProfile";

const FLOW_SOLVER_SETTINGS = {
  singularTolerance: 1e-12,
  conditionWarningThreshold: 1e8,
} as const;

const NNLS_SOLVER_SETTINGS = {
  tolerance: 1e-10,
  kktTolerance: 1e-9,
  maxIterations: 1000,
  adaptationVersion: "identity-backed-v1",
} as const;

function validFlowInput(): CompensationMatrixInput {
  return {
    sourceChannels: ["B", "A"],
    receiverChannels: ["B", "A"],
    matrix: [
      [1, 0],
      [0.1, 1],
    ],
  };
}

function requireValid(
  input: CompensationMatrixInput,
  kind: "flow-spillover" | "cytof-spillover",
): CanonicalCompensationMatrix {
  const result = validateAndCanonicalizeCompensationMatrix(input, kind);
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.errors)).toBe(true);
  if (!result.ok) throw new Error("Expected a valid compensation matrix.");
  return result.value;
}

function issueCodes(result: ReturnType<typeof validateAndCanonicalizeCompensationMatrix>) {
  return result.errors.map(({ code }) => code);
}

describe("compensation matrix validation and canonicalization", () => {
  it("normalizes exact PnNs and reindexes both axes into canonical order", () => {
    const canonical = requireValid(validFlowInput(), "flow-spillover");
    expect(canonical.sourceChannels).toEqual(["A", "B"]);
    expect(canonical.receiverChannels).toEqual(["A", "B"]);
    expect(canonical.matrix).toEqual([
      [1, 0.1],
      [0, 1],
    ]);
  });

  it("produces the same canonical matrix and hash after independent row/column reorder", async () => {
    const first = requireValid(validFlowInput(), "flow-spillover");
    const second = requireValid(
      {
        sourceChannels: ["A", "B"],
        receiverChannels: ["A", "B"],
        matrix: [
          [1, 0.1],
          [0, 1],
        ],
      },
      "flow-spillover",
    );
    expect(first).toEqual(second);
    expect(await hashCompensationMatrix(first)).toBe(await hashCompensationMatrix(second));
  });

  it("freezes a deep copy and never mutates or aliases the input", () => {
    const input = validFlowInput();
    const before = structuredClone(input);
    const canonical = requireValid(input, "flow-spillover");
    expect(input).toEqual(before);
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical.matrix)).toBe(true);
    expect(Object.isFrozen(canonical.matrix[0])).toBe(true);

    (input.matrix[0] as number[])[0] = 999;
    expect(canonical.matrix[1][1]).toBe(1);
  });

  it("uses Unicode NFC without case-folding PnNs", () => {
    const canonical = requireValid(
      {
        sourceChannels: [" B ", "A\u0301"],
        receiverChannels: ["Á", "B"],
        matrix: [
          [0, 1],
          [1, 0.1],
        ],
      },
      "flow-spillover",
    );
    expect(canonical.sourceChannels).toEqual(["B", "Á"]);
    expect(canonical.receiverChannels).toEqual(["B", "Á"]);

    const mismatch = validateAndCanonicalizeCompensationMatrix(
      {
        sourceChannels: ["A", "b"],
        receiverChannels: ["A", "B"],
        matrix: [
          [1, 0],
          [0, 1],
        ],
      },
      "flow-spillover",
    );
    expect(issueCodes(mismatch)).toContain("flow-channel-set-mismatch");
  });

  it("rejects duplicates after normalization, blanks, ragged rows, and non-finite values", () => {
    const duplicate = validateAndCanonicalizeCompensationMatrix(
      {
        sourceChannels: ["Á", "A\u0301"],
        receiverChannels: ["Á", "B"],
        matrix: [
          [1, 0],
          [0, 1],
        ],
      },
      "flow-spillover",
    );
    expect(issueCodes(duplicate)).toContain("duplicate-channel");

    const malformed = validateAndCanonicalizeCompensationMatrix(
      {
        sourceChannels: [" ", "B"],
        receiverChannels: ["A", "B"],
        matrix: [[Number.NaN], [Number.POSITIVE_INFINITY, 1]],
      },
      "flow-spillover",
    );
    expect(issueCodes(malformed)).toEqual(
      expect.arrayContaining([
        "blank-channel",
        "matrix-column-count",
        "non-finite-coefficient",
      ]),
    );

    const untrustedValues = validateAndCanonicalizeCompensationMatrix(
      {
        sourceChannels: ["A", "B"],
        receiverChannels: ["A", "B"],
        matrix: [
          [1, null],
          [false, 1],
        ],
      } as unknown as CompensationMatrixInput,
      "flow-spillover",
    );
    expect(issueCodes(untrustedValues).filter((code) => code === "non-finite-coefficient"))
      .toHaveLength(2);

    const untrustedShape = validateAndCanonicalizeCompensationMatrix(
      {
        sourceChannels: ["A", null],
        receiverChannels: "not-an-array",
        matrix: [[1], false],
      } as unknown as CompensationMatrixInput,
      "flow-spillover",
    );
    expect(untrustedShape.ok).toBe(false);
    expect(issueCodes(untrustedShape)).toEqual(
      expect.arrayContaining([
        "invalid-channel-axis",
        "invalid-channel-type",
        "invalid-matrix-row",
      ]),
    );

    const nullInput = validateAndCanonicalizeCompensationMatrix(
      null as unknown as CompensationMatrixInput,
      "flow-spillover",
    );
    expect(nullInput.ok).toBe(false);
    expect(issueCodes(nullInput)).toContain("invalid-matrix-input");
  });

  it("rejects invalid flow shapes, channel sets, diagonals, and singular matrices", () => {
    const nonSquare = validateAndCanonicalizeCompensationMatrix(
      {
        sourceChannels: ["A"],
        receiverChannels: ["A", "B"],
        matrix: [[1, 0]],
      },
      "flow-spillover",
    );
    expect(issueCodes(nonSquare)).toEqual(
      expect.arrayContaining(["flow-matrix-not-square", "flow-channel-set-mismatch"]),
    );

    const nonUnit = validateAndCanonicalizeCompensationMatrix(
      {
        sourceChannels: ["A", "B"],
        receiverChannels: ["A", "B"],
        matrix: [
          [0.9, 0.1],
          [0, 1],
        ],
      },
      "flow-spillover",
    );
    expect(issueCodes(nonUnit)).toContain("non-unit-diagonal");

    const singular = validateAndCanonicalizeCompensationMatrix(
      {
        sourceChannels: ["A", "B"],
        receiverChannels: ["A", "B"],
        matrix: [
          [1, 1],
          [1, 1],
        ],
      },
      "flow-spillover",
    );
    expect(issueCodes(singular)).toContain("singular-matrix");
  });

  it("accepts rectangular CyTOF matrices but enforces receiver diagonals and fractional values", () => {
    const rectangular = validateAndCanonicalizeCompensationMatrix(
      {
        sourceChannels: ["Y89Di", "In113Di"],
        receiverChannels: ["In115Di", "In113Di", "Y89Di"],
        matrix: [
          [0.02, 0.01, 1],
          [0, 1, 0.03],
        ],
      },
      "cytof-spillover",
    );
    expect(rectangular.ok).toBe(true);
    if (rectangular.ok) {
      expect(rectangular.value.sourceChannels).toEqual(["In113Di", "Y89Di"]);
      expect(rectangular.value.receiverChannels).toEqual(["In113Di", "In115Di", "Y89Di"]);
      expect(rectangular.value.matrix).toEqual([
        [1, 0, 0.03],
        [0.01, 0.02, 1],
      ]);
      const independentlyReordered = requireValid(
        {
          sourceChannels: ["In113Di", "Y89Di"],
          receiverChannels: ["Y89Di", "In115Di", "In113Di"],
          matrix: [
            [0.03, 0, 1],
            [1, 0.02, 0.01],
          ],
        },
        "cytof-spillover",
      );
      expect(independentlyReordered).toEqual(rectangular.value);
    }

    const invalid = validateAndCanonicalizeCompensationMatrix(
      {
        sourceChannels: ["Y89Di"],
        receiverChannels: ["Y89Di", "In113Di"],
        matrix: [[1, -0.1]],
      },
      "cytof-spillover",
    );
    expect(issueCodes(invalid)).toContain("negative-coefficient");

    const likelyPercent = validateAndCanonicalizeCompensationMatrix(
      {
        sourceChannels: ["Y89Di"],
        receiverChannels: ["Y89Di", "In113Di"],
        matrix: [[1, 2.5]],
      },
      "cytof-spillover",
    );
    expect(issueCodes(likelyPercent)).toContain("coefficient-over-one");

    const missingReceiver = validateAndCanonicalizeCompensationMatrix(
      {
        sourceChannels: ["Y89Di"],
        receiverChannels: ["In113Di"],
        matrix: [[0.1]],
      },
      "cytof-spillover",
    );
    expect(issueCodes(missingReceiver)).toContain("source-missing-receiver");
  });

  it("warns rather than silently rescaling a flow coefficient over 100%", () => {
    const result = validateAndCanonicalizeCompensationMatrix(
      {
        sourceChannels: ["A", "B"],
        receiverChannels: ["A", "B"],
        matrix: [
          [1, 1.2],
          [0, 1],
        ],
      },
      "flow-spillover",
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.map(({ code }) => code)).toContain("coefficient-over-one");
    if (result.ok) expect(result.value.matrix[0][1]).toBe(1.2);
  });

  it("accepts a one-channel identity baseline and warns on ill conditioning", () => {
    expect(
      validateAndCanonicalizeCompensationMatrix(
        { sourceChannels: ["A"], receiverChannels: ["A"], matrix: [[1]] },
        "flow-spillover",
      ).ok,
    ).toBe(true);

    const illConditioned = validateAndCanonicalizeCompensationMatrix(
      {
        sourceChannels: ["A", "B"],
        receiverChannels: ["A", "B"],
        matrix: [
          [1, 0.999999999],
          [0.999999999, 1],
        ],
      },
      "flow-spillover",
    );
    expect(illConditioned.ok).toBe(true);
    expect(illConditioned.warnings.map(({ code }) => code)).toContain(
      "ill-conditioned-matrix",
    );
  });
});

describe("stable compensation matrix and profile hashes", () => {
  it("uses a frozen IEEE-754 serialization vector", async () => {
    const matrix = requireValid(validFlowInput(), "flow-spillover");
    expect(serializeCanonicalCompensationMatrix(matrix)).toBe(
      '{"schema":"gatelab.compensation-matrix.v1","orientation":"source-rows-receiver-columns","sourceChannels":["A","B"],"receiverChannels":["A","B"],"matrixHex":[["3ff0000000000000","3fb999999999999a"],["0000000000000000","3ff0000000000000"]]}',
    );
    expect(await hashCompensationMatrix(matrix)).toBe(
      "sha256:cee29e9d6bbcda7d199e7a471e7312ca2942235dc65df16c3335f02d5a8ce47e",
    );
  });

  it("normalizes negative zero but changes the hash for a coefficient edit", async () => {
    const zero = requireValid(validFlowInput(), "flow-spillover");
    const negativeZero = requireValid(
      {
        sourceChannels: ["B", "A"],
        receiverChannels: ["B", "A"],
        matrix: [
          [1, -0],
          [0.1, 1],
        ],
      },
      "flow-spillover",
    );
    const edited = requireValid(
      {
        sourceChannels: ["B", "A"],
        receiverChannels: ["B", "A"],
        matrix: [
          [1, 0],
          [0.11, 1],
        ],
      },
      "flow-spillover",
    );
    expect(await hashCompensationMatrix(negativeZero)).toBe(
      await hashCompensationMatrix(zero),
    );
    expect(await hashCompensationMatrix(edited)).not.toBe(
      await hashCompensationMatrix(zero),
    );
  });

  it("canonicalizes CyTOF included-channel order and binds solver version", async () => {
    const matrix = requireValid(
      {
        sourceChannels: ["A", "B"],
        receiverChannels: ["C", "B", "A"],
        matrix: [
          [0, 0.1, 1],
          [0.2, 1, 0],
        ],
      },
      "cytof-spillover",
    );
    const first = {
      kind: "cytof-spillover" as const,
      method: "nnls" as const,
      solverVersion: "lawson-hanson-v1",
      solverSettings: NNLS_SOLVER_SETTINGS,
      matrix,
      includedChannels: ["C", "A", "B"],
    };
    const reordered = { ...first, includedChannels: ["B", "C", "A"] };
    const reorderedSettings = {
      ...first,
      solverSettings: {
        maxIterations: 1000,
        adaptationVersion: "identity-backed-v1",
        kktTolerance: 1e-9,
        tolerance: 1e-10,
      },
    };
    const upgraded = { ...first, solverVersion: "lawson-hanson-v2" };
    const retuned = {
      ...first,
      solverSettings: { ...first.solverSettings, tolerance: 1e-8 },
    };

    expect(canonicalizeCompensationProfileHashInput(first).includedChannels).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(await hashCompensationProfile(first)).toBe(
      await hashCompensationProfile(reordered),
    );
    expect(await hashCompensationProfile(first)).toBe(
      await hashCompensationProfile(reorderedSettings),
    );
    expect(await hashCompensationProfile(first)).toBe(
      "sha256:6bb78647a6cba62b781d7dc13dfe44bc02bcf1dcd93add993732a4a6933f8629",
    );
    expect(await hashCompensationProfile(first)).not.toBe(
      await hashCompensationProfile(upgraded),
    );
    expect(await hashCompensationProfile(first)).not.toBe(
      await hashCompensationProfile(retuned),
    );
    expect(await hashCompensationProfile(first)).not.toBe(
      await hashCompensationProfile({ ...first, includedChannels: ["A", "B"] }),
    );
  });

  it("rejects forged canonical matrices before hashing", async () => {
    const matrix = requireValid(validFlowInput(), "flow-spillover");
    await expect(
      hashCompensationMatrix({
        ...matrix,
        schema: "forged-schema",
      } as unknown as CanonicalCompensationMatrix),
    ).rejects.toThrow("schema");
    await expect(
      hashCompensationMatrix({
        ...matrix,
        sourceChannels: ["", "B"],
      } as unknown as CanonicalCompensationMatrix),
    ).rejects.toThrow("not canonical");

    const rectangular = requireValid(
      {
        sourceChannels: ["A"],
        receiverChannels: ["A", "B"],
        matrix: [[1, 0.1]],
      },
      "cytof-spillover",
    );
    expect(() =>
      canonicalizeCompensationProfileHashInput({
        kind: "flow-spillover",
        method: "matrix-inverse",
        solverVersion: "flow-v1",
        solverSettings: FLOW_SOLVER_SETTINGS,
        matrix: rectangular,
      }),
    ).toThrow("invalid for flow-spillover");
  });

  it("rejects invalid profile hash inputs at runtime", () => {
    const matrix = requireValid(validFlowInput(), "flow-spillover");
    expect(() =>
      canonicalizeCompensationProfileHashInput({
        kind: "cytof-spillover",
        method: "nnls",
        solverVersion: " ",
        solverSettings: NNLS_SOLVER_SETTINGS,
        matrix,
        includedChannels: ["A"],
      }),
    ).toThrow("solverVersion");
    expect(() =>
      canonicalizeCompensationProfileHashInput({
        kind: "cytof-spillover",
        method: "nnls",
        solverVersion: "nnls-v1",
        solverSettings: NNLS_SOLVER_SETTINGS,
        matrix,
        includedChannels: ["missing"],
      }),
    ).toThrow("not a matrix receiver");

    expect(() =>
      canonicalizeCompensationProfileHashInput({
        kind: "flow-spillover",
        method: "nnls",
        solverVersion: "bad-v1",
        solverSettings: {},
        matrix,
      } as unknown as CompensationProfileHashInput),
    ).toThrow("require the 'matrix-inverse' method");

    expect(() =>
      canonicalizeCompensationProfileHashInput({
        kind: "flow-spillover",
        method: "matrix-inverse",
        solverVersion: "bad-v1",
        solverSettings: FLOW_SOLVER_SETTINGS,
        matrix: {
          ...matrix,
          orientation: "receiver-rows-source-columns",
        },
      } as unknown as CompensationProfileHashInput),
    ).toThrow("orientation");

    expect(() =>
      canonicalizeCompensationProfileHashInput({
        kind: "cytof-spillover",
        method: "nnls",
        solverVersion: "nnls-v1",
        solverSettings: NNLS_SOLVER_SETTINGS,
        matrix,
        includedChannels: ["A", " A "],
      }),
    ).toThrow("unique channels");

    expect(() =>
      canonicalizeCompensationProfileHashInput({
        kind: "cytof-spillover",
        method: "nnls",
        solverVersion: "nnls-v1",
        solverSettings: {
          ...NNLS_SOLVER_SETTINGS,
          tolerence: 1e-10,
        },
        matrix,
        includedChannels: ["A"],
      } as unknown as CompensationProfileHashInput),
    ).toThrow("require exactly");

    expect(() =>
      canonicalizeCompensationProfileHashInput({
        kind: "cytof-spillover",
        method: "nnls",
        solverVersion: "nnls-v1",
        solverSettings: { ...NNLS_SOLVER_SETTINGS, tolerance: -1 },
        matrix,
        includedChannels: ["A"],
      }),
    ).toThrow("tolerances must be positive");

    expect(() =>
      canonicalizeCompensationProfileHashInput({
        kind: "flow-spillover",
        method: "matrix-inverse",
        solverVersion: "flow-v1",
        matrix,
      } as unknown as CompensationProfileHashInput),
    ).toThrow("solverSettings");
  });

  it("keeps the persisted v1 solver-setting acceptance boundary", () => {
    const matrix = requireValid(validFlowInput(), "flow-spillover");
    const canonical = canonicalizeCompensationProfileHashInput({
      kind: "flow-spillover",
      method: "matrix-inverse",
      solverVersion: "legacy-flow-v1",
      // Earlier v3 workspaces permitted any positive tolerance and threshold >= 1. The exact
      // engine may refuse to execute nonsensical settings, but loading/hashing must stay stable.
      solverSettings: {
        singularTolerance: 2,
        conditionWarningThreshold: 1,
      },
      matrix,
    });
    expect(canonical.solverSettings).toEqual([
      { key: "conditionWarningThreshold", value: 1 },
      { key: "singularTolerance", value: 2 },
    ]);
  });
});
