import { describe, expect, it } from "vitest";
import { parseCompensationMatrixTable } from "./compensationMatrixImport";
import {
  compensationMatrixCsvFileName,
  compensationMatrixRImportSnippet,
  serializeCompensationMatrixCsv,
} from "./compensationMatrixExport";

describe("compensation matrix CSV export", () => {
  it("preserves exact fractional coefficients and source-row orientation", () => {
    const exactFraction = 0.029123456789012345;
    const csv = serializeCompensationMatrixCsv({
      sourceChannels: ["89Y_CD45", "113In, barcode"],
      receiverChannels: ["Y89Di", 'In113"Di'],
      matrix: [
        [1, exactFraction],
        [-0, 1e-12],
      ],
    });

    expect(csv).toContain(String(exactFraction));
    expect(csv).toContain("1e-12");
    expect(csv).not.toContain("-0");
    const parsed = parseCompensationMatrixTable(csv);
    expect(parsed.input.sourceChannels).toEqual(["89Y_CD45", "113In, barcode"]);
    expect(parsed.input.receiverChannels).toEqual(["Y89Di", 'In113"Di']);
    expect(parsed.input.matrix).toEqual([
      [1, exactFraction],
      [0, 1e-12],
    ]);
  });

  it("quotes embedded newlines and rejects malformed numeric matrices", () => {
    const csv = serializeCompensationMatrixCsv({
      sourceChannels: ["source\nchannel"],
      receiverChannels: ["receiver"],
      matrix: [[1]],
    });
    expect(parseCompensationMatrixTable(csv).input.sourceChannels).toEqual(["source\nchannel"]);

    expect(() => serializeCompensationMatrixCsv({
      sourceChannels: ["A"],
      receiverChannels: ["A", "B"],
      matrix: [[1]],
    })).toThrow(/receiver channel axis/);
    expect(() => serializeCompensationMatrixCsv({
      sourceChannels: ["A"],
      receiverChannels: ["A"],
      matrix: [[Number.NaN]],
    })).toThrow(/not finite/);
  });

  it("builds a safe filename and a directly usable base-R import snippet", () => {
    const fileName = compensationMatrixCsvFileName("WingLab QQ beads sm full.csv");
    expect(fileName).toBe("WingLab_QQ_beads_sm_full_spill_matrix.csv");
    expect(compensationMatrixCsvFileName("WingLab", "working")).toBe(
      "WingLab_working_spill_matrix.csv",
    );
    expect(compensationMatrixRImportSnippet(fileName)).toBe([
      "spill <- as.matrix(read.csv(",
      '  "WingLab_QQ_beads_sm_full_spill_matrix.csv",',
      "  row.names = 1,",
      "  check.names = FALSE,",
      '  fileEncoding = "UTF-8"',
      "))",
      'storage.mode(spill) <- "double"',
    ].join("\n"));
  });
});
