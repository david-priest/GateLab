import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import oracle from "./__fixtures__/cytof_nnls_oracle.json";
import {
  adaptCytofSpilloverMatrix,
  compensateCytofRange,
  prepareCytofNnls,
  type CytofNnlsPlan,
} from "./cytofCompensationEngine";
import {
  hashCompensationMatrix,
  hashCompensationProfile,
  validateAndCanonicalizeCompensationMatrix,
  type CanonicalCompensationMatrix,
  type NnlsSolverSettingsInput,
} from "./compensationProfile";
import { gateMaskRectangle } from "./gates";
import type { Vertex } from "./models";

function requireCanonicalMatrix(
  fixture: (typeof oracle.cases)[number],
): CanonicalCompensationMatrix {
  const result = validateAndCanonicalizeCompensationMatrix(
    fixture.matrixInput,
    "cytof-spillover",
  );
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.errors)).toBe(true);
  if (!result.ok) throw new Error("The committed R oracle matrix is invalid.");
  return result.value;
}

function solveCompleteFixture(
  fixture: (typeof oracle.cases)[number],
  plan: CytofNnlsPlan,
): number[][] {
  const inputPositions = fixture.includedChannels.map((channel) =>
    fixture.inputChannels.indexOf(channel));
  expect(inputPositions.every((position) => position >= 0)).toBe(true);
  const measuredColumns = inputPositions.map((position) =>
    Float64Array.from(fixture.measuredEvents, (event) => event[position]));
  const solvedColumns = measuredColumns.map(() =>
    new Float64Array(fixture.measuredEvents.length));
  compensateCytofRange(measuredColumns, plan, solvedColumns);

  const output = fixture.measuredEvents.map((event) => Array.from(event));
  for (let included = 0; included < inputPositions.length; included++) {
    const outputPosition = inputPositions[included];
    for (let event = 0; event < output.length; event++) {
      output[event][outputPosition] = solvedColumns[included][event];
    }
  }
  return output;
}

function expectRnnlsParity(
  actualEvents: readonly (readonly number[])[],
  expectedEvents: readonly (readonly number[])[],
  caseName: string,
): void {
  expect(actualEvents).toHaveLength(expectedEvents.length);
  for (let event = 0; event < expectedEvents.length; event++) {
    expect(actualEvents[event]).toHaveLength(expectedEvents[event].length);
    for (let channel = 0; channel < expectedEvents[event].length; channel++) {
      const actual = actualEvents[event][channel];
      const expected = expectedEvents[event][channel];
      // Independent Lawson-Hanson vs GateLab coordinate/QR solve. The absolute term is the
      // scientific comparison target; the tiny relative term permits final Float64 rounding
      // for the oracle's 10^6-scale event without approaching Float32 storage precision.
      const tolerance = 1e-9 + 2e-12 * Math.max(Math.abs(actual), Math.abs(expected));
      expect(
        Math.abs(actual - expected),
        `${caseName}, event ${event + 1}, channel ${channel + 1}`,
      ).toBeLessThanOrEqual(tolerance);
    }
  }
}

describe("committed R nnls 1.6 CyTOF compensation oracle", () => {
  it("pins the independent generator, public source subset, and fixture bytes", () => {
    expect(oracle.schema).toBe("gatelab.cytof-nnls-oracle.v1");
    expect(oracle.orientation).toBe("source-rows-receiver-columns");
    expect(oracle.generation).toBe("nnls::nnls(t(identity_backed_S), measured)$x");
    expect(oracle.generatedBy.nnls).toBe("1.6");
    expect(oracle.publicSource.doi).toBe("10.1038/nbt.2317");
    expect(oracle.publicSource.fileSha256).toBe(
      "d2a70d9d63eb4c99248e14ff508518bc554a065a6fbde59be522a7fabf6a635f",
    );
    const bytes = readFileSync(
      new URL("./__fixtures__/cytof_nnls_oracle.json", import.meta.url),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "1c8ecd9cad71e342eb7d43542d66bb6eb61eb2c35b25c9f0b2ba190f8d359a64",
    );
  });

  for (const fixture of oracle.cases) {
    it(`${fixture.name}: matches R numerical, identity, ordering, and gating contracts`, async () => {
      const canonical = requireCanonicalMatrix(fixture);
      expect(await hashCompensationMatrix(canonical)).toBe(fixture.expected.matrixHash);
      expect(await hashCompensationProfile({
        kind: "cytof-spillover",
        method: "nnls",
        solverVersion: oracle.solverContract.solverVersion,
        solverSettings: oracle.solverContract.solverSettings as NnlsSolverSettingsInput,
        matrix: canonical,
        includedChannels: fixture.includedChannels,
      })).toBe(fixture.expected.profileHash);

      const adapted = adaptCytofSpilloverMatrix(canonical, fixture.includedChannels);
      expect(adapted).toEqual(fixture.expected.adaptedMatrix);
      const plan = prepareCytofNnls(
        fixture.includedChannels,
        adapted,
        oracle.solverContract.solverSettings as NnlsSolverSettingsInput,
      );
      const actualEvents = solveCompleteFixture(fixture, plan);
      expectRnnlsParity(actualEvents, fixture.expected.compensatedEvents, fixture.name);

      const excludedPositions = fixture.inputChannels.flatMap((_, position) =>
        fixture.includedChannels.includes(fixture.inputChannels[position]) ? [] : [position]);
      for (let event = 0; event < actualEvents.length; event++) {
        for (const position of excludedPositions) {
          expect(actualEvents[event][position]).toBe(fixture.measuredEvents[event][position]);
        }
      }

      const gate = fixture.gateCheck;
      expect(gate.space).toBe("asinh-compensated");
      const xPosition = fixture.inputChannels.indexOf(gate.xChannel);
      const yPosition = fixture.inputChannels.indexOf(gate.yChannel);
      const x = actualEvents.map((event) => Math.asinh(event[xPosition] / gate.cofactor));
      const y = actualEvents.map((event) => Math.asinh(event[yPosition] / gate.cofactor));
      const mask = gateMaskRectangle(x, y, gate.vertices as Vertex[]);
      const members = Array.from(mask, (included, index) => included ? index + 1 : 0)
        .filter((index) => index > 0);
      expect(members).toEqual(gate.memberRowsOneBased);
    });
  }
});
