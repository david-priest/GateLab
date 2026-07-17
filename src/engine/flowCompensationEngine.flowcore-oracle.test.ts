import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import oracle from "./__fixtures__/flowcore_compensation_oracle.json";
import { solveFlowCompensation } from "./flowCompensationEngine";

function eventRowsToColumns(events: readonly (readonly number[])[]): Float64Array[] {
  const channelCount = events[0]?.length ?? 0;
  return Array.from(
    { length: channelCount },
    (_, channel) => Float64Array.from(events.map((event) => event[channel])),
  );
}

function expectFlowCoreParity(
  columns: readonly ArrayLike<number>[],
  expectedEvents: readonly (readonly number[])[],
  caseName: string,
): void {
  expect(columns).toHaveLength(expectedEvents[0]?.length ?? 0);
  for (let event = 0; event < expectedEvents.length; event++) {
    for (let channel = 0; channel < columns.length; channel++) {
      const actual = columns[channel][event];
      const expected = expectedEvents[event][channel];
      // This is a cross-language/LAPACK oracle, not a self-reconstruction check. The tolerance
      // is far below Float32 storage precision while allowing harmless final Float64 rounding.
      const tolerance = 1e-9 + 2e-12 * Math.max(Math.abs(actual), Math.abs(expected));
      expect(
        Math.abs(actual - expected),
        `${caseName}, event ${event + 1}, channel ${channel + 1}`,
      ).toBeLessThanOrEqual(tolerance);
    }
  }
}

describe("committed flowCore 2.16.0 exact-flow oracle", () => {
  it("records the scientific orientation and generation environment", () => {
    expect(oracle.schema).toBe("gatelab.flowcore-compensation-oracle.v1");
    expect(oracle.orientation).toBe("source-rows-receiver-columns");
    expect(oracle.generation).toContain("flowCore::compensate");
    expect(oracle.generatedBy.flowCore).toBe("2.16.0");
    const bytes = readFileSync(
      new URL("./__fixtures__/flowcore_compensation_oracle.json", import.meta.url),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "dfc803da001b69942c73b9b1fe2c6f99048e900d74be461ed591827eb3791332",
    );
  });

  for (const fixture of oracle.cases) {
    it(`${fixture.name}: matches current and edited complete-matrix solves`, () => {
      const measured = eventRowsToColumns(fixture.measuredEvents);
      const current = solveFlowCompensation(measured, fixture.currentMatrix);
      const candidate = solveFlowCompensation(measured, fixture.candidateMatrix);
      expectFlowCoreParity(
        current.columns,
        fixture.currentCompensatedEvents,
        `${fixture.name} current`,
      );
      expectFlowCoreParity(
        candidate.columns,
        fixture.candidateCompensatedEvents,
        `${fixture.name} candidate`,
      );
    });
  }
});
