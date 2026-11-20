import { describe, expect, it } from "vitest";
import { checkBrightness, checkSettings, fmoResiduals } from "./controlChecks";
import { planControls } from "./controlPlan";
import { estimateSpillover } from "./spilloverEstimate";
import { beadControl, CELLS, PANEL, syntheticControl, TRUE_SPILLOVER, type SyntheticFile } from "./syntheticControls.fixture";

const VOLTS = [500, 520, 610, 640, 450, 470];
const SETTINGS = { voltages: VOLTS, cytometer: "Analyser R123", acquired: "18-NOV-2026" };
const CHANNELS = [...PANEL];

function controls(overrides: (fluor: number) => object = () => ({})): SyntheticFile[] {
  return PANEL.map((_, fluor) => beadControl(fluor, { id: `c${fluor}`, fileName: `${PANEL[fluor]}.fcs`, ...SETTINGS, ...overrides(fluor) }));
}

describe("checkSettings", () => {
  it("finds nothing where every file was run alike", () => {
    const sample = syntheticControl({ id: "s", particle: CELLS, ...SETTINGS });
    expect(checkSettings(controls(), [sample], CHANNELS)).toEqual([]);
  });

  it("names the control run at another voltage than the rest", () => {
    const files = controls((fluor) => (fluor === 2 ? { voltages: VOLTS.map((volts, j) => (j === 4 ? 480 : volts)) } : {}));
    expect(checkSettings(files, [], CHANNELS)).toEqual([
      { code: "setting-differs", setting: "voltage", fileId: "c2", channel: "BV421-A", value: 480, expected: 450 },
    ]);
  });

  it("names the file that differs from most, sample or control", () => {
    const changed = VOLTS.map((volts, j) => (j === 0 ? 540 : volts));
    const sample = syntheticControl({ id: "s", particle: CELLS, ...SETTINGS, voltages: changed });
    // One sample against six controls: the sample is the one that differs.
    expect(checkSettings(controls(), [sample], CHANNELS)).toEqual([
      { code: "setting-differs", setting: "voltage", fileId: "s", channel: "FITC-A", value: 540, expected: 500 },
    ]);
    // Eight samples against six controls: the controls are.
    const samples = Array.from({ length: 8 }, (_, k) => syntheticControl({ id: `s${k}`, particle: CELLS, ...SETTINGS, voltages: changed, events: 200 }));
    const findings = checkSettings(controls(), samples, CHANNELS);
    expect(findings).toHaveLength(PANEL.length);
    expect(findings[0]).toEqual({ code: "setting-differs", setting: "voltage", fileId: "c0", channel: "FITC-A", value: 500, expected: 540 });
    // As many of one as of the other: the samples' setting is the expected one.
    const even = checkSettings(controls().slice(0, 2), samples.slice(0, 2), CHANNELS);
    expect(even.map((finding) => (finding as { fileId: string }).fileId)).toEqual(["c0", "c1"]);
  });

  it("says which channels cannot be compared, and reports another cytometer or date", () => {
    const files = controls((fluor) => ({
      voltages: VOLTS.map((volts, j) => (j === 5 ? null : volts)),
      ...(fluor === 1 ? { cytometer: "Analyser R999" } : {}),
      ...(fluor === 3 ? { acquired: "02-NOV-2026" } : {}),
    }));
    expect(checkSettings(files, [], CHANNELS)).toEqual([
      { code: "settings-not-recorded", channels: ["BV510-A"] },
      { code: "cytometer-differs", fileId: "c1", cytometer: "Analyser R999", expected: "Analyser R123" },
      { code: "date-differs", fileId: "c3", acquired: "02-NOV-2026", expected: "18-NOV-2026" },
    ]);
  });
});

describe("checkBrightness", () => {
  it("flags the channel in which a stained sample is brighter than its control reaches", () => {
    const files = controls();
    const plan = planControls(files);
    const estimate = estimateSpillover(files, CHANNELS, plan.specs);
    // Bead controls sit at 40,000. The sample's FITC cells are at 100,000 and its PE cells at 5,000.
    const sample = syntheticControl({
      id: "s", particle: CELLS, seed: 91, events: 20_000,
      stains: [
        { fluor: 0, fraction: 0.3, brightness: 100_000, spread: 0.3 },
        { fluor: 1, fraction: 0.3, brightness: 5000, spread: 0.3 },
      ],
    });
    const findings = checkBrightness(files, CHANNELS, plan.specs, estimate.matrix, sample);
    expect(findings.map((finding) => finding.channel)).toEqual(CHANNELS);
    const byChannel = Object.fromEntries(findings.map((finding) => [finding.channel, finding]));
    expect(byChannel["FITC-A"].exceeds).toBe(true);
    expect(byChannel["FITC-A"].ratio).toBeGreaterThan(2);
    expect(byChannel["PE-A"].exceeds).toBe(false);
    expect(byChannel["PE-A"].ratio).toBeGreaterThan(0.1);
    expect(byChannel["PE-A"].ratio).toBeLessThan(0.3);
    // PE is read after compensation: FITC at 100,000 puts 12,000 into PE before it.
    expect(byChannel["PE-A"].sampleTop).toBeLessThan(12_000);
    // Channels the sample is not stained in sit near zero.
    expect(Math.abs(byChannel["APC-A"].ratio)).toBeLessThan(0.05);
  });
});

describe("fmoResiduals", () => {
  // An FMO control for BV510: FITC, PE and BV421 each on a part of the cells, APC on all of them,
  // PE-Cy7 on none, nothing in BV510.
  const fmo = syntheticControl({
    id: "fmo", fileName: "FMO BV510.fcs", particle: CELLS, seed: 92, events: 30_000,
    stains: [
      { fluor: 0, fraction: 0.3, brightness: 20_000, spread: 0.4 },
      { fluor: 1, fraction: 0.4, brightness: 20_000, spread: 0.4 },
      { fluor: 4, fraction: 0.35, brightness: 20_000, spread: 0.4 },
      { fluor: 3, fraction: 1, brightness: 20_000, spread: 0.4 },
    ],
  });

  it("finds no residual with the true matrix, and gives none for a channel with one population", () => {
    const residuals = fmoResiduals(fmo, "BV510-A", CHANNELS, TRUE_SPILLOVER);
    expect(residuals.map((residual) => residual.source).sort()).toEqual(["BV421-A", "FITC-A", "PE-A"]);
    for (const residual of residuals) {
      expect(Math.abs(residual.residual), residual.source).toBeLessThan(0.004);
      expect(residual.flagged).toBe(false);
      expect(residual.receiver).toBe("BV510-A");
    }
  });

  it("reports what is left of a wrong coefficient, with its sign", () => {
    // BV421 into BV510 is 0.25: 0.20 leaves 0.05 uncompensated. FITC into BV510 is 0.03: 0.06 takes 0.03 too much.
    const wrong = TRUE_SPILLOVER.map((row) => [...row]);
    wrong[4][5] = 0.2;
    wrong[0][5] = 0.06;
    const residuals = Object.fromEntries(fmoResiduals(fmo, "BV510-A", CHANNELS, wrong).map((residual) => [residual.source, residual]));
    expect(residuals["BV421-A"].residual).toBeGreaterThan(0.04);
    expect(residuals["BV421-A"].residual).toBeLessThan(0.06);
    expect(residuals["BV421-A"].flagged).toBe(true);
    expect(residuals["FITC-A"].residual).toBeGreaterThan(-0.04);
    expect(residuals["FITC-A"].residual).toBeLessThan(-0.02);
    expect(residuals["FITC-A"].flagged).toBe(true);
    expect(residuals["PE-A"].flagged).toBe(false);
  });

  it("gives nothing for a channel the matrix does not have, or a matrix that cannot be inverted", () => {
    expect(fmoResiduals(fmo, "BV605-A", CHANNELS, TRUE_SPILLOVER)).toEqual([]);
    expect(fmoResiduals(fmo, "BV510-A", CHANNELS, TRUE_SPILLOVER.map(() => PANEL.map(() => 1)))).toEqual([]);
  });
});
