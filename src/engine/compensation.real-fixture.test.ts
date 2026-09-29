import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compensate, invertMatrix } from "./compensation";
import {
  DEFAULT_FLOW_SOLVER_SETTINGS,
  solveFlowCompensation,
} from "./flowCompensationEngine";
import { parseFcs, type NumericColumn } from "./fcs";
import { Sample } from "./sample";
import { ARIA_III_DIR, FIXTURES_ROOT } from "../testFixtures";

const FIXTURE_ROOT = process.env.GATELAB_COMP_FIXTURES ?? ARIA_III_DIR;

const PAIRS = [
  ["sample_Bcell_check.fcs", "sample_Bcell_check_COMPENSATED.fcs"],
  ["sample_Bmem_purity_large.fcs", "sample_Bmem_purity_large_COMPENSATED.fcs"],
  ["sample_Bmem_purity_small.fcs", "sample_Bmem_purity_small_COMPENSATED.fcs"],
  ["sample_PBMC_check.fcs", "sample_PBMC_check_COMPENSATED.fcs"],
] as const;

function loadFcs(path: string) {
  const buffer = readFileSync(path);
  return parseFcs(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

function firstMismatch(actual: ArrayLike<number>, expected: ArrayLike<number>): number | null {
  if (actual.length !== expected.length) return 0;
  for (let index = 0; index < actual.length; index++) {
    if (!Object.is(actual[index], expected[index])) return index;
  }
  return null;
}

function namedColumn(
  channels: { name: string }[],
  columns: NumericColumn[],
  name: string,
): NumericColumn {
  const index = channels.findIndex((channel) => channel.name === name);
  if (index < 0) throw new Error(`Missing FCS channel ${name}`);
  return columns[index];
}

const hasFixtures = PAIRS.every(([rawName, referenceName]) =>
  existsSync(`${FIXTURE_ROOT}/${rawName}`) &&
  existsSync(`${FIXTURE_ROOT}/compensated_reference/${referenceName}`),
);

describe.runIf(hasFixtures)("flowCore Aria III compensation oracle", () => {
  for (const [rawName, referenceName] of PAIRS) {
    it(`${rawName} matches the complete flowCore-compensated reference`, () => {
      const raw = loadFcs(`${FIXTURE_ROOT}/${rawName}`);
      const reference = loadFcs(
        `${FIXTURE_ROOT}/compensated_reference/${referenceName}`,
      );
      expect(raw.nEvents).toBe(reference.nEvents);
      expect(raw.channels.map((channel) => channel.name)).toEqual(
        reference.channels.map((channel) => channel.name),
      );
      expect(raw.spillover).not.toBeNull();

      const spillover = raw.spillover!;
      const inverse = invertMatrix(spillover.matrix);
      expect(inverse).not.toBeNull();
      const measured = spillover.channels.map((name) =>
        namedColumn(raw.channels, raw.columns, name),
      );
      const expected = spillover.channels.map((name) =>
        namedColumn(reference.channels, reference.columns, name),
      );
      const actual = compensate(measured, inverse!);
      const exactEngine = solveFlowCompensation(
        measured,
        spillover.matrix,
        DEFAULT_FLOW_SOLVER_SETTINGS,
        { output: "float32", validateMeasuredValues: false },
      ).columns;

      for (let channel = 0; channel < actual.length; channel++) {
        expect(
          firstMismatch(actual[channel], expected[channel]),
          `${spillover.channels[channel]} differs from the flowCore reference`,
        ).toBeNull();
        expect(
          firstMismatch(exactEngine[channel], expected[channel]),
          `${spillover.channels[channel]} differs through the exact flow engine`,
        ).toBeNull();
      }

      const compensatedNames = new Set(spillover.channels);
      for (const channel of raw.channels) {
        if (compensatedNames.has(channel.name)) continue;
        expect(
          firstMismatch(
            namedColumn(raw.channels, raw.columns, channel.name),
            namedColumn(reference.channels, reference.columns, channel.name),
          ),
          `${channel.name} should pass through unchanged`,
        ).toBeNull();
      }
    });
  }

  it("the verified row-major orientation differs from inverse(transpose(S))", () => {
    const raw = loadFcs(`${FIXTURE_ROOT}/sample_Bmem_purity_small.fcs`);
    const reference = loadFcs(
      `${FIXTURE_ROOT}/compensated_reference/sample_Bmem_purity_small_COMPENSATED.fcs`,
    );
    const spillover = raw.spillover!;
    const transposed = spillover.matrix[0].map((_, column) =>
      spillover.matrix.map((row) => row[column]),
    );
    const measured = spillover.channels.map((name) =>
      namedColumn(raw.channels, raw.columns, name),
    );
    const incorrectlyTransposed = compensate(measured, invertMatrix(transposed)!);
    const firstExpected = namedColumn(
      reference.channels,
      reference.columns,
      spillover.channels[0],
    );

    expect(firstMismatch(incorrectlyTransposed[0], firstExpected)).not.toBeNull();
  });

  it("the explicit Sample layer matches the complete flowCore reference", () => {
    const raw = loadFcs(`${FIXTURE_ROOT}/sample_Bmem_purity_small.fcs`);
    const reference = loadFcs(
      `${FIXTURE_ROOT}/compensated_reference/sample_Bmem_purity_small_COMPENSATED.fcs`,
    );
    const sample = new Sample(raw);
    const originalReferences = sample.channels.map((_, index) =>
      sample.originalColumnData(index)
    );
    const originalValues = originalReferences.map((column) => Array.from(column));

    sample.setCompensation(true);

    expect(sample.activeLayer).toBe("compensated");
    expect(sample.dataRevision).toBe(1);
    for (let index = 0; index < sample.channels.length; index++) {
      const pnn = sample.channels[index].pnn;
      expect(
        firstMismatch(
          sample.compensatedColumnData(index),
          namedColumn(reference.channels, reference.columns, pnn),
        ),
        `${pnn} differs at the Sample assay-layer boundary`,
      ).toBeNull();
      expect(sample.originalColumnData(index)).toBe(originalReferences[index]);
      expect(Array.from(sample.originalColumnData(index))).toEqual(originalValues[index]);
    }
  });
});

/**
 * Cytek SpectroFlo writes "APPLY COMPENSATION: TRUE" beside a non-identity $SPILLOVER. FCS 3.1
 * says stored data are always uncompensated, and the data agree: in the FMO control that lacks the
 * CD14 dye (Super Bright 645), the events brightest in BUV661 sit in Super Bright 645 at about
 * S[BUV661→SB645] times their BUV661 value as stored, and near zero once the file's matrix is
 * applied. Had SpectroFlo stored them compensated, applying the matrix would push them to minus
 * that amount instead. So GateLab's compensation is the first and only application.
 */
const PBMC_FMO_CD14_PATH =
  `${FIXTURES_ROOT}/PUBLIC - Screenshot Safe/Human PBMC 17-color spectral flow demo/controls/FMO_CD14_Unmixed.fcs`;

describe.runIf(existsSync(PBMC_FMO_CD14_PATH))("Cytek 'APPLY COMPENSATION: TRUE' data are stored uncompensated", () => {
  it("brings an absent dye's channel to zero with ONE application of the file's matrix", () => {
    const fcs = loadFcs(PBMC_FMO_CD14_PATH);
    expect(fcs.keywords["APPLY COMPENSATION"]?.trim()).toBe("TRUE");
    const sample = new Sample(fcs);
    const src = sample.spillover!;
    const from = src.channels.findIndex((c) => c.startsWith("CD11c"));
    const into = src.channels.findIndex((c) => c.startsWith("CD14"));
    expect(from).toBeGreaterThanOrEqual(0);
    expect(into).toBeGreaterThanOrEqual(0);
    const coefficient = src.matrix[from][into];
    expect(coefficient).toBeLessThan(-0.05);
    const x = sample.index(src.channels[from])!;
    const y = sample.index(src.channels[into])!;
    const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    const bright = (col: ArrayLike<number>) => {
      const sorted = Array.from(col).sort((a, b) => a - b);
      const cut = sorted[Math.floor(sorted.length * 0.98)];
      return Array.from(col, (v, i) => (v >= cut ? i : -1)).filter((i) => i >= 0);
    };
    const xs = sample.originalColumnData(x);
    const idx = bright(xs);
    const expectedStored = coefficient * median(idx.map((i) => xs[i]));
    const stored = median(idx.map((i) => sample.originalColumnData(y)[i]));
    sample.setCompensation(true);
    expect(sample.compensationEnabled).toBe(true);
    const compensated = median(idx.map((i) => sample.compensatedColumnData(y)[i]));
    // Stored: within 15% of the spill the matrix predicts; compensated: within a tenth of it of 0.
    expect(Math.abs(stored - expectedStored)).toBeLessThan(0.15 * Math.abs(expectedStored));
    expect(Math.abs(compensated)).toBeLessThan(0.1 * Math.abs(expectedStored));
  });
});
