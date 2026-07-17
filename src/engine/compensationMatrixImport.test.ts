import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CompensationMatrixTableError,
  parseCompensationMatrixTable,
  transposeCompensationMatrixInput,
} from "./compensationMatrixImport";
import {
  hashCompensationMatrix,
  validateAndCanonicalizeCompensationMatrix,
  type CompensationKind,
  type MatrixValidationResult,
} from "./compensationProfile";

const nativeRFixture = readFileSync(
  new URL("./__fixtures__/compensation_matrix_native_r.csv", import.meta.url),
  "utf8",
);

function parseError(
  text: string,
  options: Parameters<typeof parseCompensationMatrixTable>[1] = {},
): CompensationMatrixTableError {
  try {
    parseCompensationMatrixTable(text, options);
  } catch (error) {
    if (error instanceof CompensationMatrixTableError) return error;
    throw error;
  }
  throw new Error("Expected compensation matrix parsing to fail.");
}

function validate(text: string, kind: CompensationKind): MatrixValidationResult {
  return validateAndCanonicalizeCompensationMatrix(
    parseCompensationMatrixTable(text).input,
    kind,
  );
}

function validationCodes(result: MatrixValidationResult): string[] {
  return result.errors.map(({ code }) => code);
}

describe("parseCompensationMatrixTable", () => {
  it("parses the native base-R write.csv(matrix) shape without changing coefficient scale", () => {
    const parsed = parseCompensationMatrixTable(nativeRFixture);
    expect(parsed.format).toEqual({ delimiter: "csv", sourceColumnHeader: "" });
    expect(parsed.input.sourceChannels).toEqual(["A", "B", "C"]);
    expect(parsed.input.receiverChannels).toEqual(["A", "B", "C"]);
    expect(parsed.input.matrix).toEqual([
      [1, 0.02, 0],
      [0, 1, 0.03],
      [0.01, 0, 1],
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.input.matrix[0])).toBe(true);
  });

  it.each(["", "X", "row.names", "channel", " SOURCE "])(
    "accepts the supported '%s' source-column spelling",
    (sourceHeader) => {
      const parsed = parseCompensationMatrixTable(
        `${sourceHeader},A\nA,1\n`,
      );
      expect(parsed.input.sourceChannels).toEqual(["A"]);
      expect(parsed.format.sourceColumnHeader).toBe(sourceHeader);
    },
  );

  it("parses an explicit channel-column export", () => {
    const parsed = parseCompensationMatrixTable(
      "channel,A,B\nA,1,0.125\nB,0.25,1\n",
    );
    expect(parsed.input).toEqual({
      sourceChannels: ["A", "B"],
      receiverChannels: ["A", "B"],
      matrix: [
        [1, 0.125],
        [0.25, 1],
      ],
    });
  });

  it("auto-detects TSV and handles quoted tabs, delimiters, quotes, and numbers", () => {
    const parsed = parseCompensationMatrixTable(
      'channel\t"A\tone"\t"B""two"\n"A\tone"\t"1"\t"2e-3"\n"B""two"\t.5\t1.\n',
    );
    expect(parsed.format.delimiter).toBe("tsv");
    expect(parsed.input.receiverChannels).toEqual(["A\tone", 'B"two']);
    expect(parsed.input.sourceChannels).toEqual(["A\tone", 'B"two']);
    expect(parsed.input.matrix).toEqual([
      [1, 0.002],
      [0.5, 1],
    ]);
  });

  it("handles quoted commas in channel identities", () => {
    const parsed = parseCompensationMatrixTable(
      'channel,"A,one",B\n"A,one",1,0\nB,0,1\n',
    );
    expect(parsed.input.sourceChannels[0]).toBe("A,one");
    expect(parsed.input.receiverChannels[0]).toBe("A,one");
  });

  it("accepts a BOM, CRLF records, and wholly blank records", () => {
    const parsed = parseCompensationMatrixTable(
      "\uFEFF\r\n\r\nchannel,A,B\r\nA,1,0\r\n\r\nB,0,1\r\n",
    );
    expect(parsed.input.sourceChannels).toEqual(["A", "B"]);
    expect(parsed.input.matrix).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("accepts strict decimal and scientific forms while preserving negative zero", () => {
    const parsed = parseCompensationMatrixTable(
      "channel,A,B,C,D,E,F\nA,+1,.5,1.,1e-3,-0,0E2\n",
    );
    expect(parsed.input.matrix[0].slice(0, 4)).toEqual([1, 0.5, 1, 0.001]);
    expect(Object.is(parsed.input.matrix[0][4], -0)).toBe(true);
    expect(parsed.input.matrix[0][5]).toBe(0);
  });

  it("preserves row and column identity independently before canonicalization", () => {
    const parsed = parseCompensationMatrixTable(
      "channel,B,A\nA,0.2,1\nB,1,0.05\n",
    );
    expect(parsed.input.sourceChannels).toEqual(["A", "B"]);
    expect(parsed.input.receiverChannels).toEqual(["B", "A"]);
    expect(parsed.input.matrix).toEqual([
      [0.2, 1],
      [1, 0.05],
    ]);

    const result = validateAndCanonicalizeCompensationMatrix(
      parsed.input,
      "flow-spillover",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sourceChannels).toEqual(["A", "B"]);
      expect(result.value.receiverChannels).toEqual(["A", "B"]);
      expect(result.value.matrix).toEqual([
        [1, 0.2],
        [0.05, 1],
      ]);
    }
  });

  it("parses a valid rectangular CyTOF matrix but does not coerce it into flow compensation", () => {
    const text =
      "channel,Y89Di,In113Di,In115Di\n" +
      "Y89Di,1,0.002,0\n" +
      "In113Di,0,1,0.011\n";
    const cytof = validate(text, "cytof-spillover");
    expect(cytof.ok).toBe(true);

    const flow = validate(text, "flow-spillover");
    expect(flow.ok).toBe(false);
    expect(validationCodes(flow)).toEqual(
      expect.arrayContaining(["flow-matrix-not-square", "flow-channel-set-mismatch"]),
    );
  });

  it("accepts a one-channel identity matrix", () => {
    expect(validate(",A\nA,1\n", "flow-spillover").ok).toBe(true);
  });

  it("never interprets imported coefficients as percentages", () => {
    const flow = validate("channel,A,B\nA,1,1.2\nB,0,1\n", "flow-spillover");
    expect(flow.ok).toBe(true);
    if (flow.ok) {
      expect(flow.value.matrix[0][1]).toBe(1.2);
      expect(flow.warnings.map(({ code }) => code)).toContain("coefficient-over-one");
    }

    const cytof = validate("channel,A,B\nA,1,1.2\n", "cytof-spillover");
    expect(cytof.ok).toBe(false);
    expect(validationCodes(cytof)).toContain("coefficient-over-one");
  });

  it("canonicalizes and hashes independently shuffled rows and columns identically", async () => {
    const first = validateAndCanonicalizeCompensationMatrix(
      parseCompensationMatrixTable("channel,A,B\nA,1,0.2\nB,0.05,1\n").input,
      "flow-spillover",
    );
    const shuffled = validateAndCanonicalizeCompensationMatrix(
      parseCompensationMatrixTable("channel,B,A\nB,1,0.05\nA,0.2,1\n").input,
      "flow-spillover",
    );
    expect(first.ok).toBe(true);
    expect(shuffled.ok).toBe(true);
    if (first.ok && shuffled.ok) {
      expect(shuffled.value).toEqual(first.value);
      expect(await hashCompensationMatrix(shuffled.value)).toBe(
        await hashCompensationMatrix(first.value),
      );
    }
  });

  it("transposes axes and coefficients only after an explicit action", () => {
    const original = parseCompensationMatrixTable(
      "channel,A,B,C\nA,1,2,3\nB,4,5,6\n",
    ).input;
    const transposed = transposeCompensationMatrixInput(original);
    expect(transposed.sourceChannels).toEqual(["A", "B", "C"]);
    expect(transposed.receiverChannels).toEqual(["A", "B"]);
    expect(transposed.matrix).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
    expect(original.matrix).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(Object.isFrozen(transposed.matrix[0])).toBe(true);
  });

  it("rejects empty, undelimited, and ambiguous input", () => {
    expect(parseError(" \r\n ").code).toBe("empty-file");
    expect(parseError("channel;A\nA;1\n").code).toBe("missing-delimiter");
    const mixed = "channel,A\tmarker,B\nA\tmarker,1,0\nB,0,1\n";
    expect(parseError(mixed).code).toBe("ambiguous-delimiter");
    expect(
      parseCompensationMatrixTable(mixed, { delimiter: "csv" }).input.receiverChannels,
    ).toEqual(["A\tmarker", "B"]);
  });

  it("returns controlled errors for malformed runtime arguments", () => {
    expect(parseError(null as unknown as string).code).toBe("invalid-input");
    expect(
      parseError("channel,A\nA,1\n", {
        delimiter: "semicolon" as unknown as "csv",
      }).code,
    ).toBe("invalid-delimiter");
  });

  it("rejects tables without a recoverable named source column", () => {
    const error = parseError("A,B\n1,0\n0,1\n");
    expect(error.code).toBe("missing-source-column");
    expect(error.column).toBe(1);
  });

  it("rejects a missing receiver axis or missing source rows", () => {
    expect(parseError("channel\nA\n", { delimiter: "csv" }).code).toBe(
      "missing-receiver-columns",
    );
    expect(parseError("channel,A\n").code).toBe("missing-data-rows");
  });

  it("rejects missing source identities and non-rectangular rows", () => {
    expect(parseError("channel,A\n,1\n").code).toBe("missing-source-channel");
    expect(parseError("channel,A,B\nA,1\n").code).toBe("row-width");
    expect(parseError("channel,A,B\nA,1,0,2\n").code).toBe("row-width");
    expect(parseError("channel,A,B\nA,1,\n").code).toBe("invalid-coefficient");
  });

  it.each(["", "NaN", "Inf", "Infinity", "0x10", "true", "10%", "1foo", "1,000", "1e999"])(
    "rejects the non-decimal coefficient token '%s'",
    (token) => {
      const quoted = token.includes(",") ? `"${token}"` : token;
      const error = parseError(`channel,A\nA,${quoted}\n`);
      expect(error.code).toBe("invalid-coefficient");
      expect(error.row).toBe(2);
      expect(error.column).toBe(2);
    },
  );

  it("rejects malformed quoted fields", () => {
    expect(parseError('channel,A\n"A,1\n').code).toBe("malformed-quoted-field");
    expect(parseError('channel,A\n"A"x,1\n').code).toBe("malformed-quoted-field");
    expect(parseError('channel,A\nA"x,1\n').code).toBe("malformed-quoted-field");
  });

  it("leaves duplicate, blank, range, diagonal, and modality checks to the domain validator", () => {
    const duplicate = validate("channel,A,A\nA,1,0\n", "flow-spillover");
    expect(validationCodes(duplicate)).toContain("duplicate-channel");

    const blank = validate("channel,A, \nA,1,0\n", "flow-spillover");
    expect(validationCodes(blank)).toContain("blank-channel");

    const negative = validate("channel,A,B\nA,1,-0.1\nB,0,1\n", "flow-spillover");
    expect(validationCodes(negative)).toContain("negative-coefficient");

    const nonUnit = validate("channel,A\nA,0.9\n", "flow-spillover");
    expect(validationCodes(nonUnit)).toContain("non-unit-diagonal");

    const singular = validate("channel,A,B\nA,1,1\nB,1,1\n", "flow-spillover");
    expect(validationCodes(singular)).toContain("singular-matrix");
  });

  it("does not case-fold PnN identities or align unnamed rows by position", () => {
    const caseMismatch = validate("channel,A\na,1\n", "flow-spillover");
    expect(validationCodes(caseMismatch)).toContain("flow-channel-set-mismatch");

    const numericRows = validate(",A,B\n1,1,0\n2,0,1\n", "flow-spillover");
    expect(validationCodes(numericRows)).toEqual(
      expect.arrayContaining(["flow-channel-set-mismatch", "source-missing-receiver"]),
    );
  });

  it("rejects transpose requests whose array dimensions do not match their named axes", () => {
    expect(() =>
      transposeCompensationMatrixInput({
        sourceChannels: ["A", "B"],
        receiverChannels: ["A"],
        matrix: [[1]],
      }),
    ).toThrow("dimensions, and coefficients are valid");
    expect(() =>
      transposeCompensationMatrixInput(null as unknown as Parameters<
        typeof transposeCompensationMatrixInput
      >[0]),
    ).toThrow("named axes");
    expect(() =>
      transposeCompensationMatrixInput({
        sourceChannels: ["A"],
        receiverChannels: ["A"],
        matrix: [["1" as unknown as number]],
      }),
    ).toThrow("coefficients are valid");
  });
});
