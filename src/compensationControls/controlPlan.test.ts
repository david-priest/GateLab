import { describe, expect, it } from "vitest";
import { eventIndices } from "./controlFile";
import { planControl, planControls, scatterDiffers, unstainedFor } from "./controlPlan";
import { estimateSpillover } from "./spilloverEstimate";
import { BEADS, beadControl, CELLS, cellControl, PANEL, syntheticControl, TRUE_SPILLOVER } from "./syntheticControls.fixture";

const FITC = 0;
const unstainedCells = () => syntheticControl({ id: "u", fileName: "unstained.fcs", particle: CELLS, seed: 51 });
const unstainedBeads = () => syntheticControl({ id: "ub", fileName: "beads only.fcs", particle: BEADS, seed: 52 });
/** Cells that are all positive for one fluorochrome: no negative population of their own. */
const allPositive = (fluor: number) => syntheticControl({
  id: `line${fluor}`, fileName: `line ${PANEL[fluor]}.fcs`, particle: CELLS, seed: 80 + fluor,
  stains: [{ fluor, fraction: 1, brightness: 20_000, spread: 0.4 }],
});

describe("planControl", () => {
  it("uses the control's own negative population where it has one", () => {
    const control = beadControl(FITC, { id: "c" });
    const planned = planControl([control, unstainedCells()], "c", "FITC-A", [unstainedCells()]);
    expect(planned).toMatchObject({ negativeSource: "internal", negativeFileId: "c", problem: null, scatterDiffers: false });
    expect(planned.spec?.positive).toMatchObject({ fileId: "c", lower: planned.split?.positiveLower });
    expect(planned.spec?.negative).toMatchObject({ fileId: "c", upper: planned.split?.negativeUpper });
  });

  it("uses the unstained control where every event of the control is positive", () => {
    const control = allPositive(FITC);
    const unstained = unstainedCells();
    const planned = planControl([control, unstained], control.id, "FITC-A", [unstained]);
    expect(planned).toMatchObject({ negativeSource: "unstained", negativeFileId: "u", problem: null, scatterDiffers: false });
    expect(planned.split?.bimodal).toBe(false);
    // Positive events start above the unstained file's own values, and nearly all of the control is above.
    const own = control.values("FITC-A")!;
    expect(eventIndices(planned.spec!.positive, own).length).toBeGreaterThan(0.99 * control.eventCount);
    expect(eventIndices({ fileId: "u", lower: planned.spec!.positive.lower }, unstained.values("FITC-A")!).length)
      .toBeLessThan(0.002 * unstained.eventCount);
  });

  it("says what is missing when there are no negative events to use", () => {
    const control = allPositive(FITC);
    expect(planControl([control], control.id, "FITC-A", [])).toMatchObject({ spec: null, problem: "no-unstained-control" });
    expect(planControl([control, unstainedCells()], control.id, "FITC-A", [unstainedCells()], { negative: "internal" }))
      .toMatchObject({ spec: null, problem: "no-negative-population" });
  });

  it("uses the unstained control when asked, keeping the control's own positive boundary", () => {
    const control = cellControl(FITC, { id: "c" });
    const planned = planControl([control, unstainedCells()], "c", "FITC-A", [unstainedCells()], { negative: "unstained" });
    expect(planned.negativeSource).toBe("unstained");
    expect(planned.spec?.positive.lower).toBe(planned.split?.positiveLower);
    expect(planned.spec?.negative).toEqual({ fileId: "u", mask: null });
  });

  it("flags an unstained control of other particles, and prefers one of the same", () => {
    const control = allPositive(FITC);
    expect(scatterDiffers(control, unstainedBeads())).toBe(true);
    expect(scatterDiffers(control, unstainedCells())).toBe(false);
    expect(unstainedFor(control, [unstainedBeads(), unstainedCells()])?.id).toBe("u");
    const onlyBeads = planControl([control, unstainedBeads()], control.id, "FITC-A", [unstainedBeads()]);
    expect(onlyBeads).toMatchObject({ negativeSource: "unstained", negativeFileId: "ub", scatterDiffers: true });
  });

  it("splits and takes events inside a gated population only", () => {
    const control = beadControl(FITC, { id: "c" });
    // A population holding the first half of the file.
    const mask = Uint8Array.from({ length: control.eventCount }, (_, event) => (event < control.eventCount / 2 ? 1 : 0));
    const planned = planControl([control], "c", "FITC-A", [], { populations: { c: mask } });
    const own = control.values("FITC-A")!;
    const positive = eventIndices(planned.spec!.positive, own);
    const negative = eventIndices(planned.spec!.negative, own);
    expect(Math.max(...positive, ...negative)).toBeLessThan(control.eventCount / 2);
    expect(positive.length + negative.length).toBeGreaterThan(0.48 * control.eventCount);
  });
});

describe("beads or cells", () => {
  it("reads the kind from the name, then from the peaks", () => {
    const unnamedBeads = planControl([beadControl(FITC, { id: "c" })], "c", "FITC-A", []);
    expect(unnamedBeads).toMatchObject({ kind: "beads", kindFrom: "peaks" });
    const unnamedCells = planControl([cellControl(FITC, { id: "c" })], "c", "FITC-A", []);
    expect(unnamedCells).toMatchObject({ kind: "cells", kindFrom: "peaks" });
    // A name says more than a broad peak does.
    const named = planControl([cellControl(FITC, { id: "c", fileName: "FITC CompBeads.fcs" })], "c", "FITC-A", []);
    expect(named).toMatchObject({ kind: "beads", kindFrom: "name" });
    const chosen = planControl([beadControl(FITC, { id: "c" })], "c", "FITC-A", [], { kind: "cells" });
    expect(chosen).toMatchObject({ kind: "cells", kindFrom: "chosen", negativeSource: "internal" });
  });

  it("does not calculate a bead control without a negative peak against unstained cells", () => {
    const control = allPositive(FITC);
    const unstained = unstainedCells();
    // As cells (read from its peaks, or chosen) the unstained cells are its negative events.
    expect(planControl([control, unstained], control.id, "FITC-A", [unstained]))
      .toMatchObject({ kind: "cells", negativeSource: "unstained", negativeReason: "no-own-peak", problem: null });
    // Positive beads alone, with unstained cells: a fault, because the cells' background is not the beads'.
    const beads = syntheticControl({
      id: "pos", fileName: "FITC beads.fcs", particle: BEADS, seed: 84,
      stains: [{ fluor: FITC, fraction: 1, brightness: 40_000 }],
    });
    expect(planControl([beads, unstained], "pos", "FITC-A", [unstained]))
      .toMatchObject({ kind: "beads", negativeSource: null, spec: null, problem: "no-negative-population" });
    // Unless the unstained tube is asked for outright.
    expect(planControl([beads, unstained], "pos", "FITC-A", [unstained], { negative: "unstained" }))
      .toMatchObject({ negativeSource: "unstained", negativeReason: "chosen", problem: null, scatterDiffers: true });
  });

  it("uses an unstained tube of the same beads for bead controls that hold positive beads alone", () => {
    // A universal negative: every stained tube holds positive beads only.
    const files = [
      ...PANEL.map((_, fluor) => syntheticControl({
        id: `p${fluor}`, fileName: `${PANEL[fluor].replace("-A", "")} beads.fcs`, particle: BEADS, seed: 110 + fluor,
        stains: [{ fluor, fraction: 1, brightness: 40_000 }],
      })),
      unstainedBeads(),
    ];
    const plan = planControls(files);
    expect(plan.controls.map((control) => `${control.kind} ${control.negativeSource} ${control.negativeReason}`))
      .toEqual(PANEL.map(() => "beads unstained no-own-peak"));
    const estimate = estimateSpillover(files, [...PANEL], plan.specs);
    TRUE_SPILLOVER.forEach((row, i) => row.forEach((value, j) => {
      expect(Math.abs(estimate.matrix[i][j] - value)).toBeLessThanOrEqual(0.002 + 0.02 * value);
    }));
  });

  it("does not take single beads and doublets for a negative and a positive population", () => {
    // Every bead positive, one in twelve events a doublet: two peaks, both far above the unstained beads.
    const control = syntheticControl({
      id: "d", fileName: "tube 3.fcs", particle: BEADS, seed: 85,
      stains: [{ fluor: FITC, fraction: 1, brightness: 30_000 }, { fluor: FITC, fraction: 0.08, brightness: 30_000 }],
    });
    const unstained = unstainedBeads();
    const planned = planControl([control, unstained], "d", "FITC-A", [unstained]);
    expect(planned.split?.bimodal).toBe(true);
    expect(planned).toMatchObject({ negativeSource: "unstained", negativeFileId: "ub", negativeReason: "own-peak-not-negative", problem: null });
    // Every bead is a positive event: single beads and doublets alike.
    expect(eventIndices(planned.spec!.positive, control.values("FITC-A")!).length).toBeGreaterThan(4990);
    // Without an unstained tube of the same beads there is nothing to tell by, and the two peaks are used.
    expect(planControl([control], "d", "FITC-A", [])).toMatchObject({ negativeSource: "internal", negativeReason: "own-peak" });
    expect(planControl([control, unstainedCells()], "d", "FITC-A", [unstainedCells()])).toMatchObject({ negativeSource: "internal" });
  });

  it("uses the unstained tube where a control has few negative events of its own", () => {
    const control = syntheticControl({
      id: "few", fileName: "tube 4.fcs", particle: BEADS, seed: 86,
      stains: [{ fluor: FITC, fraction: 0.975, brightness: 40_000 }],
    });
    const unstained = unstainedBeads();
    const planned = planControl([control, unstained], "few", "FITC-A", [unstained]);
    expect(planned.split!.negativeCount).toBeLessThan(200);
    expect(planned).toMatchObject({ negativeSource: "unstained", negativeReason: "own-peak-small", problem: null });
    expect(planned.spec!.positive.lower).toBe(planned.split!.positiveLower);
    // Asked for, its own negative events are used all the same.
    expect(planControl([control, unstained], "few", "FITC-A", [unstained], { negative: "internal" }))
      .toMatchObject({ negativeSource: "internal", negativeReason: "chosen" });
  });
});

describe("planControls", () => {
  it("plans a mixed set: bead controls on their own negatives, a cell line on the unstained cells", () => {
    const files = [
      ...PANEL.map((_, fluor) => (fluor === 3
        ? allPositive(3)
        : beadControl(fluor, { id: `c${fluor}`, fileName: `t${fluor}.fcs` }))),
      unstainedCells(),
    ];
    const plan = planControls(files);
    expect(plan.controls.map((control) => control.channel)).toEqual([...PANEL]);
    expect(plan.controls.map((control) => control.negativeSource))
      .toEqual(["internal", "internal", "internal", "unstained", "internal", "internal"]);
    expect(plan.specs).toHaveLength(PANEL.length);
    const estimate = estimateSpillover(files, [...PANEL], plan.specs);
    TRUE_SPILLOVER.forEach((row, i) => row.forEach((value, j) => {
      expect(Math.abs(estimate.matrix[i][j] - value)).toBeLessThanOrEqual(0.003 + 0.03 * value);
    }));
  });

  it("leaves out duplicates and files with more than one stain, and plans nothing it cannot calculate", () => {
    const files = [
      beadControl(0, { id: "a", fileName: "a.fcs" }),
      beadControl(1, { id: "b", fileName: "b.fcs" }),
      allPositive(2),
      syntheticControl({
        id: "dimmer", fileName: "d.fcs", particle: BEADS, seed: 60,
        stains: [{ fluor: 0, fraction: 0.5, brightness: 9000 }],
      }),
    ];
    const plan = planControls(files);
    expect(plan.controls.map((control) => control.fileId)).toEqual(["a", "b", "line2"]);
    expect(plan.controls[2]).toMatchObject({ spec: null, problem: "no-unstained-control" });
    expect(plan.specs.map((spec) => spec.channel)).toEqual(["FITC-A", "PE-A"]);
  });
});
