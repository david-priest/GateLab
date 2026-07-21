import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyFlowMatrixEdits,
  compareFlowCompensation,
} from "./flowCompensationEngine";
import { parseFcs, type FcsFile, type NumericColumn } from "./fcs";

const FIXTURE_ROOT =
  "/Users/davidpriest/code/gatelabr-test-fcs/conventional_comp_AriaIII";
const FIXTURES = [
  "sample_Bcell_check.fcs",
  "sample_Bmem_purity_large.fcs",
  "sample_Bmem_purity_small.fcs",
  "sample_PBMC_check.fcs",
] as const;

function loadFcs(path: string): FcsFile {
  const bytes = readFileSync(path);
  return parseFcs(bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ));
}

function namedColumn(fcs: FcsFile, pnn: string): NumericColumn {
  const index = fcs.channels.findIndex(({ name }) => name === pnn);
  if (index < 0) throw new Error(`Missing FCS channel ${pnn}.`);
  return fcs.columns[index];
}

describe.runIf(FIXTURES.every((name) => existsSync(`${FIXTURE_ROOT}/${name}`)))(
  "real Aria III coefficient perturbations",
  () => {
    for (const fixture of FIXTURES) {
      it(`${fixture}: shows direct, propagated, sign-crossing, and reconstruction effects`, () => {
        const fcs = loadFcs(`${FIXTURE_ROOT}/${fixture}`);
        const spillover = fcs.spillover!;
        const measured = spillover.channels.map((pnn) => namedColumn(fcs, pnn));
        const measuredBefore = measured.map((column) => Array.from(column));
        const source = spillover.channels.indexOf("BV711-A");
        const receiver = spillover.channels.indexOf("BV786-A");
        expect(source).toBeGreaterThanOrEqual(0);
        expect(receiver).toBeGreaterThanOrEqual(0);
        expect(spillover.matrix[source][receiver]).toBeCloseTo(0.294759276942178, 14);

        const compareAt = (value: number) => compareFlowCompensation(
          measured,
          spillover.matrix,
          applyFlowMatrixEdits(spillover.matrix, [{ sourceIndex: source, receiverIndex: receiver, value }]),
          { sourceChannels: spillover.channels },
        );
        const modestLower = compareAt(0.27);
        const strongerLower = compareAt(0.24);
        const modestHigher = compareAt(0.32);
        const strongerHigher = compareAt(0.36);

        for (const comparison of [modestLower, strongerLower, modestHigher, strongerHigher]) {
          // BV786 is the receiver whose inferred signal is most affected, but the complete solve
          // correctly propagates the edit through every coupled channel rather than changing one pair.
          expect(comparison.impactRanking[0].channel).toBe("BV786-A");
          expect(comparison.impacts.filter(({ changedCount }) => changedCount > 0).length).toBe(6);
          expect(comparison.impactRanking[1].channel).toBe("APC-Cy7-A");
          expect(comparison.impacts.reduce(
            (total, impact) => total + impact.signCrossingCount,
            0,
          )).toBeGreaterThan(0);
          expect(comparison.candidate.reconstruction?.relativeBackwardError).toBeLessThan(1e-14);
        }

        // Larger coefficient departures must cause larger observed changes on this fixed dataset in
        // both directions. This is an effect test, not merely a second implementation parity check.
        expect(strongerLower.impacts[receiver].medianAbsoluteDelta).toBeGreaterThan(
          modestLower.impacts[receiver].medianAbsoluteDelta,
        );
        expect(strongerHigher.impacts[receiver].medianAbsoluteDelta).toBeGreaterThan(
          modestHigher.impacts[receiver].medianAbsoluteDelta,
        );
        expect(strongerLower.impacts[receiver].signCrossingCount).toBeGreaterThan(
          modestLower.impacts[receiver].signCrossingCount,
        );
        expect(strongerHigher.impacts[receiver].signCrossingCount).toBeGreaterThan(
          modestHigher.impacts[receiver].signCrossingCount,
        );

        expect(measured.map((column) => Array.from(column))).toEqual(measuredBefore);
      });
    }
  },
);
