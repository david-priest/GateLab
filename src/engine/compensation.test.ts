import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";
import { extractDisplaySpillover, invertMatrix, compensate } from "./compensation";
import { isScatterChannel, isQcChannel } from "./transforms";

const ARIA_SMALL =
  "/Users/davidpriest/code/gatelabr-test-fcs/conventional_comp_AriaIII/sample_Bmem_purity_small.fcs";
function loadArrayBuffer(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

describe("invertMatrix", () => {
  it("A · A⁻¹ = I", () => {
    const A = [
      [1, 0.1, 0.05],
      [0.2, 1, 0.1],
      [0.03, 0.15, 1],
    ];
    const inv = invertMatrix(A)!;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += A[i][k] * inv[k][j];
        expect(s).toBeCloseTo(i === j ? 1 : 0, 9);
      }
  });
  it("returns null for a singular matrix", () => {
    expect(invertMatrix([[1, 2], [2, 4]])).toBeNull();
  });
});

describe("compensate — X · solve(S) round-trips", () => {
  it("compensating then re-spilling (·S) recovers the raw values", () => {
    const S = [
      [1, 0.12, 0.03],
      [0.08, 1, 0.2],
      [0.01, 0.05, 1],
    ];
    const raw = [
      Float32Array.from([100, 500, 20, 3000]),
      Float32Array.from([50, 800, 5, 1200]),
      Float32Array.from([10, 60, 900, 40]),
    ];
    const comp = compensate(raw, invertMatrix(S)!);
    const back = compensate(comp, S); // comp · S = raw · S⁻¹ · S = raw
    for (let c = 0; c < 3; c++)
      for (let e = 0; e < 4; e++) expect(back[c][e]).toBeCloseTo(raw[c][e], 2);
  });
});

describe("Sample compensation (real Aria III $SPILLOVER)", () => {
  const sample = new Sample(parseFcs(loadArrayBuffer(ARIA_SMALL)));

  it("extracts a non-identity display-named spillover of the fluor channels", () => {
    expect(sample.hasCompensation).toBe(true);
    const s = sample.spillover!;
    expect(s.channels.length).toBeGreaterThanOrEqual(2);
    // all fluor (no scatter / QC)
    for (const ch of s.channels) {
      expect(isScatterChannel(ch)).toBe(false);
      expect(isQcChannel(ch)).toBe(false);
    }
  });

  it("toggling compensation changes fluor gating values but leaves scatter untouched", () => {
    const fluorKey = sample.spillover!.channels[0];
    const fluorIdx = sample.index(fluorKey)!;
    const scatterIdx = sample.channels.findIndex((c) => isScatterChannel(c.key));

    const fluorBefore = Array.from(sample.gatingColumn(fluorIdx).slice(0, 20));
    const scatterBefore = Array.from(sample.gatingColumn(scatterIdx).slice(0, 20));

    sample.setCompensation(true);
    const fluorAfter = Array.from(sample.gatingColumn(fluorIdx).slice(0, 20));
    const scatterAfter = Array.from(sample.gatingColumn(scatterIdx).slice(0, 20));

    expect(fluorAfter).not.toEqual(fluorBefore); // compensation moved the fluor values
    expect(scatterAfter).toEqual(scatterBefore); // scatter passes through

    sample.setCompensation(false);
    expect(Array.from(sample.gatingColumn(fluorIdx).slice(0, 20))).toEqual(fluorBefore); // reversible
  });

  it("direct extractDisplaySpillover drops identity matrices", () => {
    const ident = { channels: ["A", "B"], matrix: [[1, 0], [0, 1]] };
    expect(extractDisplaySpillover(ident, (p) => p, () => false, () => false)).toBeNull();
  });
});
