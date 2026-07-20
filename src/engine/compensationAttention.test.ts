import { describe, expect, it } from "vitest";
import type { CompensationPairEvidence } from "./compensationPairPreview";
import {
  assessCompensationEvidence,
  rankConservativeCompensationAttention,
} from "./compensationAttention";

function evidence(
  shift: number,
  slope: number,
  zeroDelta = 0,
  upperTailExcessMad = 0,
  upperTailSlopeDeltaMad = 0,
): CompensationPairEvidence {
  return {
    status: "ready",
    sourceLowEvents: 100,
    sourceHighEvents: 100,
    destinationNegativeEvents: 500,
    normalizedNegativeShift: shift,
    residualSlope: slope,
    upperTailExcessMad,
    upperTailSlopeDeltaMad,
    receiverZeroDeltaFraction: zeroDelta,
  };
}

describe("conservative compensation attention ranking", () => {
  it("does not mistake positive biological association for spillover evidence", () => {
    const ranked = rankConservativeCompensationAttention([
      { coefficient: 0.03, physicalPrior: 1, evidence: evidence(12, 0.4) },
      { coefficient: 0.03, physicalPrior: 1, evidence: evidence(-0.8, -0.003) },
    ], "cytof");

    expect(ranked.map(({ index }) => index)).toEqual([1]);
    expect(ranked[0].reason).toBe("multiple-overcompensation-signals");
  });

  it("recognises a new NNLS zero pile without relying on positive correlation", () => {
    const ranked = rankConservativeCompensationAttention([
      { coefficient: 0.02, physicalPrior: 1, evidence: evidence(3, 0.2, 0.025) },
    ], "cytof");

    expect(ranked).toMatchObject([{ index: 0, reason: "new-zero-pile" }]);
  });

  it("rejects weak negative noise relative to the installed coefficient", () => {
    const ranked = rankConservativeCompensationAttention([
      { coefficient: 0.10, physicalPrior: 1, evidence: evidence(-0.1, -0.001) },
    ], "flow");

    expect(ranked).toEqual([]);
  });

  it("requires explicit control-data mode before positive residual association is shortlisted", () => {
    const input = { coefficient: 0.03, physicalPrior: 1, evidence: evidence(4, 0.08) };

    expect(rankConservativeCompensationAttention([input], "cytof", "biological")).toEqual([]);
    expect(assessCompensationEvidence(input, "cytof", "biological")).toMatchObject({
      category: "positive-association-only",
      label: "Positive association only · control required",
      automaticFollowup: false,
    });
    expect(rankConservativeCompensationAttention([input], "cytof", "control")).toMatchObject([{
      index: 0,
      category: "undercompensation-like",
      reason: "multiple-undercompensation-signals",
    }]);
  });

  it("recognises physically plausible high-tail structure without calling it proof in biological data", () => {
    const plausible = {
      coefficient: 0.03,
      physicalPrior: 1,
      evidence: evidence(0.1, 0.0001, 0, 6, 2),
    };
    const implausible = { ...plausible, physicalPrior: 0 };

    expect(assessCompensationEvidence(plausible, "cytof", "biological")).toMatchObject({
      category: "high-tail-structure",
      reason: "high-tail-curve",
      automaticFollowup: true,
    });
    expect(rankConservativeCompensationAttention([plausible], "cytof", "biological")).toHaveLength(1);
    expect(rankConservativeCompensationAttention([implausible], "cytof", "biological")).toEqual([]);
  });
});
