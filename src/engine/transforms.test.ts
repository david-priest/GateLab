import { describe, it, expect } from "vitest";
import {
  Logicle,
  arcsinh,
  arcsinhInverse,
  quantileType7,
  estimateLogicleW,
  resolveLogicleT,
  isQcChannel,
  isScatterChannel,
  isMetalChannel,
  hasFlowSuffix,
  detectInstrumentType,
  transformChannel,
} from "./transforms";
import logicleOracle from "./__fixtures__/logicle_oracle.json";
import transformOracle from "./__fixtures__/transform_oracle.json";

// ---------------------------------------------------------------------------
// Logicle forward/inverse vs flowutils oracle (the flowCore reference algorithm)
// ---------------------------------------------------------------------------

describe("Logicle vs flowutils oracle", () => {
  for (const c of logicleOracle.cases) {
    const { t, w, m, a } = c.params;
    const lg = new Logicle(t, w, m, a);

    it(`forward T=${t} W=${w} M=${m} A=${a}`, () => {
      c.values.forEach((v, i) => {
        expect(lg.scale(v)).toBeCloseTo(c.forward[i], 9);
      });
    });

    it(`inverse∘forward reconstructs display→raw T=${t} W=${w} A=${a}`, () => {
      // Invert the oracle's forward values; must match the oracle's own inverse.
      c.forward.forEach((disp, i) => {
        expect(lg.inverse(disp)).toBeCloseTo(c.inverse_of_forward[i], 6);
      });
    });
  }

  it("round-trips a raw value through scale→inverse", () => {
    const lg = new Logicle(262144, 0.5, 4.5, 0);
    for (const v of [-500, -1, 0, 1, 250, 12345, 260000]) {
      expect(lg.inverse(lg.scale(v))).toBeCloseTo(v, 3);
    }
  });
});

// ---------------------------------------------------------------------------
// arcsinh
// ---------------------------------------------------------------------------

describe("arcsinh", () => {
  it("matches Math.asinh(x/cf) and round-trips", () => {
    expect(arcsinh(150, 150)).toBeCloseTo(Math.asinh(1), 12);
    expect(arcsinh(0, 5)).toBe(0);
    for (const v of [-300, 0, 42, 5000]) {
      expect(arcsinhInverse(arcsinh(v, 5), 5)).toBeCloseTo(v, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// Quantile type 7 (R default / numpy 'linear')
// ---------------------------------------------------------------------------

describe("quantileType7", () => {
  it("matches R type-7 on [1..5]", () => {
    const x = [1, 2, 3, 4, 5];
    expect(quantileType7(x, 0.05)).toBeCloseTo(1.2, 12); // h=0.2
    expect(quantileType7(x, 0.5)).toBeCloseTo(3.0, 12);
    expect(quantileType7(x, 0.999)).toBeCloseTo(4.996, 12);
  });
  it("handles singletons and empties", () => {
    expect(quantileType7([7], 0.5)).toBe(7);
    expect(Number.isNaN(quantileType7([], 0.5))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W / T estimation (GateLabR .estimate_logicle_w / .resolve_logicle_t)
// ---------------------------------------------------------------------------

describe("W/T estimation", () => {
  it("resolveLogicleT floors at 262144", () => {
    expect(resolveLogicleT([1, 2, 3])).toBe(262144);
    // a column whose q99.9 is above the floor keeps its own T
    const big = Array.from({ length: 1000 }, (_, i) => 300000 + i);
    expect(resolveLogicleT(big)).toBeGreaterThan(262144);
  });
  it("returns default 0.5 when 5th percentile >= 0", () => {
    expect(estimateLogicleW([1, 2, 3, 4, 5], 262144)).toBe(0.5);
  });
  it("computes W from a negative 5th percentile per the formula", () => {
    const vals = [-50, -50, -50, -50, -50, 100, 100, 100, 100, 100];
    const q5 = quantileType7([...vals].sort((p, q) => p - q), 0.05);
    const absQ = Math.max(Math.abs(q5), 1);
    const expected = Math.max(0.1, Math.min((4.5 - Math.log10(262144 / absQ)) / 2, 2.0));
    expect(estimateLogicleW(vals, 262144)).toBeCloseTo(expected, 12);
  });
});

// ---------------------------------------------------------------------------
// Channel classification (fcs_import.R)
// ---------------------------------------------------------------------------

describe("channel classification", () => {
  it("QC / scatter / metal / flow-suffix predicates", () => {
    expect(isQcChannel("Time")).toBe(true);
    expect(isQcChannel("Event_length")).toBe(true);
    expect(isScatterChannel("FSC-A")).toBe(true);
    expect(isScatterChannel("SSC-H")).toBe(true);
    expect(isScatterChannel("Time")).toBe(false);
    expect(isScatterChannel("CD3")).toBe(false);
    expect(hasFlowSuffix("PE-Cy7-A")).toBe(true);
    expect(hasFlowSuffix("CD3")).toBe(false);
    // metals
    expect(isMetalChannel("Ce140Di")).toBe(true);
    expect(isMetalChannel("89Y")).toBe(true);
    expect(isMetalChannel("Nd144")).toBe(true);
    // fluorophore labels with flow suffixes are NOT metal
    expect(isMetalChannel("V500-A")).toBe(false);
    expect(isMetalChannel("FSC-A")).toBe(false);
  });

  it("detects flow from Aria III channels", () => {
    expect(detectInstrumentType(transformOracle.channels)).toBe("flow");
  });

  it("detects CyTOF from a metal panel", () => {
    const cytof = ["Time", "Event_length", "89Y", "Ce140Di", "Nd144Di", "Er167Di", "Ir193Di"];
    expect(detectInstrumentType(cytof)).toBe("cytof");
  });

  // Regression (tx-01): the faithful detector — now wired into parseFcs — must classify
  // vendor scatter names the old crude FSC/SSC-only heuristic missed as flow.
  it("detects flow from Beckman-style scatter names (FS INT / SS LOG)", () => {
    const beckman = ["FS INT", "SS INT", "SS LOG", "FL1 INT", "FL2 INT", "TIME"];
    expect(detectInstrumentType(beckman)).toBe("flow");
  });

  it("detects flow from Sony BSC scatter names", () => {
    const sony = ["FSC-A", "BSC-A", "SSC-A", "FITC-A", "PE-A", "Time"];
    expect(detectInstrumentType(sony)).toBe("flow");
  });
});

// ---------------------------------------------------------------------------
// End-to-end flow display transform vs the real-FCS GateLabR oracle
// (transformChannel computes T/W internally from the full column)
// ---------------------------------------------------------------------------

describe("transformChannel vs real-FCS GateLabR oracle", () => {
  for (const c of transformOracle.cases) {
    it(`${c.channel} (${c.kind})`, () => {
      const out = transformChannel(c.raw_full, c.channel, "flow");
      c.sample_idx.forEach((idx, k) => {
        // logicle ~1e-6 (Halley vs Halley); scatter/qc exact to float precision
        const prec = c.kind === "signal" ? 6 : 5;
        expect(out[idx]).toBeCloseTo(c.display_sample[k], prec);
      });
    });
  }

  it("recovers the oracle's estimated T and W for a signal channel", () => {
    const pe = transformOracle.cases.find((c) => c.channel === "PE-A")!;
    const t = resolveLogicleT(pe.raw_full);
    const w = estimateLogicleW(pe.raw_full, t);
    expect(t).toBeCloseTo(pe.meta.T!, 6);
    expect(w).toBeCloseTo(pe.meta.W!, 9);
  });
});
