import { describe, expect, it } from "vitest";
import {
  adaptCytofSpilloverMatrix,
  compensateCytofRange,
  createCytofNnlsExecutionStats,
  prepareCytofNnls,
  solveCytofNnlsEvent,
} from "./cytofCompensationEngine";
import { validateAndCanonicalizeCompensationMatrix } from "./compensationProfile";

function canonical(
  sourceChannels: readonly string[],
  receiverChannels: readonly string[],
  matrix: readonly (readonly number[])[],
) {
  const result = validateAndCanonicalizeCompensationMatrix(
    { sourceChannels, receiverChannels, matrix },
    "cytof-spillover",
  );
  if (!result.ok) throw new Error(result.errors.map(({ message }) => message).join(" "));
  return result.value;
}

describe("CyTOF identity-backed NNLS", () => {
  it("uses source rows, receiver columns, and A = transpose(S)", () => {
    const plan = prepareCytofNnls(
      ["A", "B"],
      [
        [1, 0.2],
        [0.1, 1],
      ],
    );
    const output = new Float64Array(2);
    const diagnostics = solveCytofNnlsEvent(plan, new Float64Array([10.4, 6]), output);
    expect(output[0]).toBeCloseTo(10, 12);
    expect(output[1]).toBeCloseTo(4, 12);
    expect(diagnostics.converged).toBe(true);
    expect(diagnostics.residualNorm).toBeLessThan(1e-12);
    expect(diagnostics.kktViolation).toBeLessThan(1e-10);
  });

  it("enforces non-negativity instead of emitting flow-style negative values", () => {
    const plan = prepareCytofNnls(["A", "B"], [[1, 0], [0, 1]]);
    const output = new Float64Array(2);
    solveCytofNnlsEvent(plan, new Float64Array([3, -2]), output);
    expect(Array.from(output)).toEqual([3, 0]);
  });

  it("adapts rectangular imports with identity emitters for receiver-only channels", () => {
    const imported = canonical(
      ["A", "B"],
      ["A", "B", "C"],
      [
        [1, 0.1, 0.2],
        [0.05, 1, 0.3],
      ],
    );
    const adapted = adaptCytofSpilloverMatrix(imported, ["A", "C"]);
    expect(adapted).toEqual([
      [1, 0.2],
      [0, 1],
    ]);
    const plan = prepareCytofNnls(["A", "C"], adapted);
    const output = new Float64Array(2);
    solveCytofNnlsEvent(plan, new Float64Array([5, 8]), output);
    expect(output[0]).toBeCloseTo(5, 12);
    expect(output[1]).toBeCloseTo(7, 12);
  });

  it("omits coefficients touching an explicitly excluded channel", () => {
    const imported = canonical(
      ["A", "B", "C"],
      ["A", "B", "C"],
      [
        [1, 0.1, 0.2],
        [0.05, 1, 0.3],
        [0.02, 0.04, 1],
      ],
    );
    expect(adaptCytofSpilloverMatrix(imported, ["A", "C"])).toEqual([
      [1, 0.2],
      [0.02, 1],
    ]);
  });

  it("uses the identical event solver for ranged column application", () => {
    const plan = prepareCytofNnls(
      ["A", "B"],
      [
        [1, 0.2],
        [0.1, 1],
      ],
    );
    const measured = [
      new Float64Array([10.4, 5.2, 0]),
      new Float64Array([6, 3, 2]),
    ];
    const output = [new Float64Array(3), new Float64Array(3)];
    compensateCytofRange(measured, plan, output);
    expect(Array.from(output[0])).toEqual(expect.arrayContaining([
      expect.closeTo(10, 12),
      expect.closeTo(5, 12),
      0,
    ]));
    expect(Array.from(output[1])).toEqual(expect.arrayContaining([
      expect.closeTo(4, 12),
      expect.closeTo(2, 12),
      expect.closeTo(2, 12),
    ]));
  });

  it("QR-polishes a coordinate-identified active set before using the full fallback", () => {
    const plan = prepareCytofNnls(
      ["A", "B", "C"],
      [
        [1, 0.5, 0.12],
        [0.5, 1, 0.08],
        [0.12, 0.08, 1],
      ],
    );
    const measured = [
      Float64Array.of(11.6),
      Float64Array.of(7.4),
      Float64Array.of(6.36),
    ];
    const output = measured.map(() => new Float64Array(1));
    const stats = createCytofNnlsExecutionStats();

    compensateCytofRange(measured, plan, output, { executionStats: stats });

    expect(output.map((column) => column[0])).toEqual([
      expect.closeTo(10, 12),
      expect.closeTo(2, 12),
      expect.closeTo(5, 12),
    ]);
    expect(stats).toEqual({
      coordinateConvergedEvents: 0,
      activeSetPolishedEvents: 1,
      qrFallbackEvents: 0,
      coordinateIterations: 8,
      maxCoordinateIterations: 8,
    });
  });

  it("retains the full active-set fallback when the coordinate support fails KKT review", () => {
    const plan = prepareCytofNnls(
      ["A", "B", "C"],
      [
        [1, 0.43, 0.04],
        [0.44, 1, 0.1],
        [0.39, 0.27, 1],
      ],
    );
    const measured = [Float64Array.of(34), Float64Array.of(57), Float64Array.of(38)];
    const output = measured.map(() => new Float64Array(1));
    const stats = createCytofNnlsExecutionStats();

    compensateCytofRange(measured, plan, output, { executionStats: stats });

    expect(output.map((column) => column[0])).toEqual([
      0,
      expect.closeTo(48.014009963631224, 10),
      expect.closeTo(33.18009159485496, 10),
    ]);
    expect(stats.qrFallbackEvents).toBe(1);
    expect(stats.activeSetPolishedEvents).toBe(0);
  });

  it("satisfies the NNLS KKT conditions across varied sparse spill systems", () => {
    const count = 8;
    const matrix = Array.from({ length: count }, (_, source) =>
      Array.from({ length: count }, (__, receiver) => {
        if (source === receiver) return 1;
        return (source * 11 + receiver * 7) % 5 === 0
          ? ((source + receiver) % 4 + 1) * 0.0075
          : 0;
      }),
    );
    const plan = prepareCytofNnls(
      Array.from({ length: count }, (_, index) => `Ch${index + 1}`),
      matrix,
    );

    for (let event = 0; event < 40; event++) {
      const measured = Float64Array.from({ length: count }, (_, channel) =>
        ((event + 3) * (channel + 5) * 17) % 113 - (channel % 3 === 0 ? 7 : 0)
      );
      const output = new Float64Array(count);
      const diagnostics = solveCytofNnlsEvent(plan, measured, output);
      const measuredScale = Math.max(1, ...Array.from(measured, Math.abs));
      const zeroThreshold = plan.settings.tolerance * measuredScale;
      const kktThreshold = plan.settings.kktTolerance * measuredScale;
      const residual = Float64Array.from({ length: count }, (_, receiver) => {
        let reconstructed = 0;
        for (let source = 0; source < count; source++) {
          reconstructed += plan.design[receiver][source] * output[source];
        }
        return measured[receiver] - reconstructed;
      });

      expect(diagnostics.converged).toBe(true);
      expect(diagnostics.kktViolation).toBeLessThanOrEqual(kktThreshold);
      for (let source = 0; source < count; source++) {
        let gradient = 0;
        for (let receiver = 0; receiver < count; receiver++) {
          gradient += plan.design[receiver][source] * residual[receiver];
        }
        expect(output[source]).toBeGreaterThanOrEqual(0);
        if (output[source] > zeroThreshold) {
          expect(Math.abs(gradient)).toBeLessThanOrEqual(kktThreshold);
        } else {
          expect(gradient).toBeLessThanOrEqual(kktThreshold);
        }
      }
    }
  });
});
