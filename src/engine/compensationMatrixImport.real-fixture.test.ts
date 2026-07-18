import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CompensationMatrixTableError,
  parseCompensationMatrixTable,
} from "./compensationMatrixImport";
import { validateAndCanonicalizeCompensationMatrix } from "./compensationProfile";
import { reportMatrixCompatibility } from "./compensationCompatibility";
import {
  adaptCytofSpilloverMatrix,
  compensateCytofRange,
  prepareCytofNnls,
} from "./cytofCompensationEngine";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";

const cytofMatrixPath =
  process.env.GATELAB_CYTOF_SPILL_MATRIX ??
  "/Users/davidpriest/code/archive/snakemake-experiments/SLE_AIM_test_260325_snakemake/results/compensation/spillover_matrix_beads.csv";
const flowUnnamedRowsPath =
  process.env.GATELAB_FLOW_SPILL_MATRIX ??
  "/Users/davidpriest/code/gatelabr-test-fcs/conventional_comp_AriaIII/spillover_matrix_embedded.csv";
const wingLabMatrixPath =
  process.env.GATELAB_WINGLAB_CYTOF_SPILL_MATRIX ??
  "/Users/davidpriest/My Drive (davidpriest@cider.osaka-u.ac.jp)/Wing Lab/Large Projects/HyperIgM/260519 Second round of mass phenotyping/data/Compensation/WingLab_QQ_beads_sm_full.csv";
const wingLabFcsPath =
  process.env.GATELAB_WINGLAB_CYTOF_FCS ??
  "/Users/davidpriest/My Drive (davidpriest@cider.osaka-u.ac.jp)/Wing Lab/Large Projects/HyperIgM/260519 Second round of mass phenotyping/data/Tube2 FCS/FCS/Tube2_concat_23.fcs";

describe("local real compensation matrix import fixtures", () => {
  (existsSync(cytofMatrixPath) ? it : it.skip)(
    "parses and validates the native-R 46-source × 61-receiver CyTOF matrix",
    () => {
      const parsed = parseCompensationMatrixTable(
        readFileSync(cytofMatrixPath, "utf8"),
      );
      expect(parsed.format).toEqual({ delimiter: "csv", sourceColumnHeader: "" });
      expect(parsed.input.sourceChannels).toHaveLength(46);
      expect(parsed.input.receiverChannels).toHaveLength(61);
      expect(parsed.input.matrix).toHaveLength(46);
      expect(parsed.input.matrix.every((row) => row.length === 61)).toBe(true);
      const sourceIndex = new Map(
        parsed.input.sourceChannels.map((channel, index) => [channel, index]),
      );
      const receiverIndex = new Map(
        parsed.input.receiverChannels.map((channel, index) => [channel, index]),
      );
      expect(
        parsed.input.matrix[sourceIndex.get("Cd106Di")!][receiverIndex.get("In113Di")!],
      ).toBe(0.00416385811388164);
      expect(
        parsed.input.matrix[sourceIndex.get("Cd110Di")!][receiverIndex.get("Cd111Di")!],
      ).toBe(0.0111776952110552);

      const result = validateAndCanonicalizeCompensationMatrix(
        parsed.input,
        "cytof-spillover",
      );
      expect(result.ok).toBe(true);
      expect(result.diagnostics).toMatchObject({
        sourceCount: 46,
        receiverCount: 61,
        isSquare: false,
        coefficientMin: 0,
        coefficientMax: 1,
      });
    },
  );

  (existsSync(flowUnnamedRowsPath) ? it : it.skip)(
    "refuses to align a flow CSV whose R row names are only positional integers",
    () => {
      const parsed = parseCompensationMatrixTable(
        readFileSync(flowUnnamedRowsPath, "utf8"),
      );
      expect(parsed.input.sourceChannels).toEqual(["1", "2", "3", "4", "5", "6"]);
      const result = validateAndCanonicalizeCompensationMatrix(
        parsed.input,
        "flow-spillover",
      );
      expect(result.ok).toBe(false);
      expect(result.errors.map(({ code }) => code)).toEqual(
        expect.arrayContaining(["flow-channel-set-mismatch", "source-missing-receiver"]),
      );
    },
  );

  (existsSync(wingLabMatrixPath) && existsSync(wingLabFcsPath) ? it : it.skip)(
    "matches and numerically solves the reviewed Wing Lab matrix against a real Tube 2 CyTOF FCS",
    () => {
      const parsed = parseCompensationMatrixTable(readFileSync(wingLabMatrixPath, "utf8"));
      const validated = validateAndCanonicalizeCompensationMatrix(
        parsed.input,
        "cytof-spillover",
      );
      if (!validated.ok) throw new Error(validated.errors.map(({ message }) => message).join(" "));
      const bytes = readFileSync(wingLabFcsPath);
      const fcs = parseFcs(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
      const sample = new Sample(fcs);
      const exactSamplePnns = new Set(sample.channels.map(({ pnn }) => pnn));
      const includedChannels = validated.value.receiverChannels.filter((pnn) =>
        exactSamplePnns.has(pnn)
      );
      const compatibility = reportMatrixCompatibility({
        kind: "cytof-spillover",
        matrix: validated.value,
        sampleChannels: sample.channels,
        includedChannels,
      });

      expect(sample.instrument).toBe("cytof");
      expect(compatibility.blockers).toEqual([]);
      expect(compatibility.canApply).toBe(true);
      expect(compatibility.includedChannels).toEqual(includedChannels);
      expect(includedChannels.length).toBeGreaterThan(40);

      const adapted = adaptCytofSpilloverMatrix(validated.value, includedChannels);
      const plan = prepareCytofNnls(includedChannels, adapted);
      const eventCount = Math.min(3, sample.fcs.nEvents);
      const measured = includedChannels.map((pnn) => {
        const index = sample.channels.findIndex((channel) => channel.pnn === pnn);
        return Float64Array.from(sample.originalColumnData(index).subarray(0, eventCount));
      });
      const compensated = includedChannels.map(() => new Float64Array(eventCount));
      compensateCytofRange(measured, plan, compensated);
      expect(compensated).toHaveLength(includedChannels.length);
      expect(compensated.every((column) => Array.from(column).every((value) => Number.isFinite(value) && value >= 0))).toBe(true);
    },
  );

  it("rejects a long-form spill-edge table instead of treating percentages as a dense matrix", () => {
    expect(() =>
      parseCompensationMatrixTable(
        "emitting_metal,receiving_metal,spill_pct\nY89Di,In113Di,0.2\n",
      ),
    ).toThrow(CompensationMatrixTableError);
    try {
      parseCompensationMatrixTable(
        "emitting_metal,receiving_metal,spill_pct\nY89Di,In113Di,0.2\n",
      );
    } catch (error) {
      expect(error).toMatchObject({ code: "missing-source-column", row: 1, column: 1 });
    }
  });
});
