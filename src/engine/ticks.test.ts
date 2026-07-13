import { describe, it, expect } from "vitest";
import { logicleTicks, scatterTicks } from "./ticks";
import { Logicle } from "./transforms";

// Flow-signal logicle axis (GateLabR generate_logicle_ticks). GateLab's Logicle maps to
// [0,1], so ticks are computed over that display range and must land inside it.
describe("logicleTicks", () => {
  const lg = new Logicle(262144, 0.5, 4.5, 0);
  const fwd = (v: number) => lg.scale(v);
  const inv = (v: number) => lg.inverse(v);
  const t = logicleTicks(fwd, inv, [0, 1], 262144)!;

  it("produces FlowJo-style decade labels, not raw display numbers", () => {
    expect(t.tick_mode).toBe("logicle");
    expect(t.major_labels).toContain("0");
    // decade majors abbreviated K/M (100, 1K, 10K, 100K …) — never a bare display value
    expect(t.major_labels).toContain("1K");
    for (const lab of t.major_labels) {
      expect(lab).toMatch(/^-?(\d+(\.\d+)?[KM]?)$|^0$/);
    }
  });

  it("returns positions in the visible display range, ascending, with unlabeled minors", () => {
    expect(t.major_pos.length).toBe(t.major_labels.length);
    for (const p of t.major_pos) expect(p).toBeGreaterThanOrEqual(0), expect(p).toBeLessThanOrEqual(1);
    const sorted = [...t.major_pos].sort((a, b) => a - b);
    expect(t.major_pos).toEqual(sorted);
    expect(t.minor_pos.length).toBeGreaterThan(0);
    for (const p of t.minor_pos) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      expect(t.major_pos).not.toContain(p); // minors are distinct from majors
    }
  });

  it("places the '0' tick at forward(0)", () => {
    const zeroIdx = t.major_labels.indexOf("0");
    expect(zeroIdx).toBeGreaterThanOrEqual(0);
    expect(t.major_pos[zeroIdx]).toBeCloseTo(fwd(0), 6);
  });

  it("clamps decades for an out-of-domain range (no 1e19 tick blow-up)", () => {
    // hi = 5 is ~5x beyond GateLab's [0,1] logicle display top (e.g. a foreign global scale).
    // Without the T-based clamp, inverse(5) extrapolates to ~1e19 and floods the axis with decades.
    const blown = logicleTicks(fwd, inv, [0, 5], 262144)!;
    expect(blown.major_pos.length).toBeLessThan(15);
    for (const lab of blown.major_labels) expect(lab).toMatch(/^-?(\d+(\.\d+)?[KM]?)$|^0$/);
  });
});

// Scatter (FSC/SSC) axis: asinh(raw/150) display, raw-unit decade labels.
describe("scatterTicks", () => {
  const cf = 150;
  const fwd = (v: number) => Math.asinh(v / cf);
  const inv = (v: number) => cf * Math.sinh(v);
  // Visible display range spanning ~0 up to asinh(1e6/150) ≈ 9.5.
  const t = scatterTicks(fwd, inv, [fwd(0), fwd(1e6)], cf)!;

  it("labels decades in raw units with K/M abbreviations", () => {
    expect(t.tick_mode).toBe("scatter_log10");
    expect(t.major_labels).toContain("1K");
    expect(t.major_labels).toContain("10K");
    expect(t.major_labels).toContain("100K");
    expect(t.major_labels).toContain("1M");
  });

  it("positions match the forward transform of each labelled decade", () => {
    const i = t.major_labels.indexOf("10K");
    expect(t.major_pos[i]).toBeCloseTo(fwd(1e4), 6);
    // minors sit between decades and carry no label
    expect(t.minor_pos.length).toBeGreaterThan(0);
  });

  it("returns null for a degenerate range", () => {
    expect(scatterTicks(fwd, inv, [1, 1], cf)).toBeNull();
  });
});
