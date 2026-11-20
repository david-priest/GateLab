import { describe, expect, it } from "vitest";
import { detectControls } from "./controlDetection";
import {
  BEADS,
  beadControl,
  CELLS,
  cellControl,
  PANEL,
  syntheticControl,
  TRUE_SPILLOVER,
  type SyntheticFile,
} from "./syntheticControls.fixture";

const NAMES = ["FITC", "PE", "PE-Cy7", "APC", "BV421", "BV510"];

/** A Diva-style set: one bead control per channel and an unstained tube, named as Diva names them. */
function namedSet(): SyntheticFile[] {
  return [
    ...PANEL.map((_, fluor) =>
      beadControl(fluor, { id: `c${fluor}`, fileName: `Compensation Controls_${NAMES[fluor]} Stained Control.fcs` })),
    syntheticControl({ id: "u", fileName: "Compensation Controls_Unstained Control.fcs", particle: BEADS, seed: 50 }),
  ];
}

/** The same tubes with names that say nothing. */
function anonymousSet(): SyntheticFile[] {
  return [
    ...PANEL.map((_, fluor) => beadControl(fluor, { id: `c${fluor}`, fileName: `Specimen_001_Tube_00${fluor + 1}.fcs` })),
    syntheticControl({ id: "u", fileName: "Specimen_001_Tube_007.fcs", particle: BEADS, seed: 50 }),
  ];
}

describe("detectControls", () => {
  it("reads a named set: every control by name and signal, the unstained tube by name", () => {
    const detection = detectControls(namedSet());
    expect(detection.channels.map((channel) => channel.key)).toEqual([...PANEL]);
    PANEL.forEach((channel, fluor) => {
      expect(detection.controls[fluor]).toMatchObject({
        fileId: `c${fluor}`, role: "single-stain", channel, matchedBy: "name-and-signal", duplicate: false, notes: [],
      });
    });
    expect(detection.controls[6]).toMatchObject({ role: "unstained", matchedBy: "name", channel: null });
    expect(detection.channelsWithoutControl).toEqual([]);
  });

  it("finds each control's channel and the unstained tube from the signal alone", () => {
    const detection = detectControls(anonymousSet());
    PANEL.forEach((channel, fluor) => {
      expect(detection.controls[fluor]).toMatchObject({ role: "single-stain", channel, matchedBy: "signal", duplicate: false });
      expect(detection.controls[fluor].fold).toBeGreaterThan(50);
    });
    expect(detection.controls[6]).toMatchObject({ role: "unstained", matchedBy: "signal", brightest: null });
  });

  it("works on cells with an unstained file of the same cells", () => {
    const files = [
      ...PANEL.map((_, fluor) => cellControl(fluor, { id: `c${fluor}`, fileName: `tube ${fluor + 1}.fcs` })),
      syntheticControl({ id: "u", fileName: "tube 7.fcs", particle: CELLS, seed: 51 }),
    ];
    const detection = detectControls(files);
    PANEL.forEach((channel, fluor) => expect(detection.controls[fluor]).toMatchObject({ role: "single-stain", channel }));
    expect(detection.controls[6].role).toBe("unstained");
  });

  it("gives a control its own channel when it is brighter in a neighbour, once the neighbour's control has taken that", () => {
    // BV421 spills into BV510 at 1.6: its control is brightest in BV510.
    const spillover = TRUE_SPILLOVER.map((row) => [...row]);
    spillover[4][5] = 1.6;
    const files = [
      ...PANEL.map((_, fluor) => beadControl(fluor, { id: `c${fluor}`, fileName: `t${fluor}.fcs`, spillover })),
      syntheticControl({ id: "u", fileName: "t9.fcs", particle: BEADS, seed: 50 }),
    ];
    const detection = detectControls(files);
    expect(detection.controls[4]).toMatchObject({ role: "single-stain", channel: "BV421-A", duplicate: false });
    expect(detection.controls[4].brightest?.channel).toBe("BV510-A");
    expect(detection.controls[5]).toMatchObject({ role: "single-stain", channel: "BV510-A", duplicate: false });
  });

  it("marks the dimmer of two controls for one channel as a duplicate", () => {
    const files = anonymousSet();
    files.push(syntheticControl({
      id: "second-fitc", fileName: "extra.fcs", particle: BEADS, seed: 60,
      stains: [{ fluor: 0, fraction: 0.5, brightness: 9000 }],
    }));
    const detection = detectControls(files);
    expect(detection.controls[0]).toMatchObject({ channel: "FITC-A", duplicate: false });
    expect(detection.controls[7]).toMatchObject({ role: "single-stain", channel: "FITC-A", duplicate: true, matchedBy: "signal" });
  });

  it("does not use a file stained with more than one fluorochrome", () => {
    // A sample: every cell carries APC (a marker on all cells), a third carry FITC, a fifth PE.
    const sample = syntheticControl({
      id: "sample", fileName: "D1 treated.fcs", particle: CELLS, seed: 70,
      stains: [
        { fluor: 3, fraction: 1, brightness: 30_000, spread: 0.4 },
        { fluor: 0, fraction: 0.33, brightness: 15_000, spread: 0.5 },
        { fluor: 1, fraction: 0.2, brightness: 12_000, spread: 0.5 },
      ],
    });
    const detection = detectControls([...anonymousSet(), sample]);
    expect(detection.controls[7].role).toBe("mixed");
    expect(detection.controls[7].independentChannels).toEqual(expect.arrayContaining(["FITC-A", "PE-A"]));
    // The real controls are untouched by its presence.
    PANEL.forEach((channel, fluor) => expect(detection.controls[fluor]).toMatchObject({ role: "single-stain", channel, duplicate: false }));
  });

  it("does not take spillover for a second stain, however large", () => {
    const spillover = TRUE_SPILLOVER.map((row) => [...row]);
    spillover[4][5] = 0.9;
    const files = PANEL.map((_, fluor) => cellControl(fluor, { id: `c${fluor}`, fileName: `t${fluor}.fcs`, spillover }));
    files.push(syntheticControl({ id: "u", fileName: "t9.fcs", particle: CELLS, seed: 51 }));
    const detection = detectControls(files);
    expect(detection.controls.filter((control) => control.role === "mixed")).toEqual([]);
  });

  it("keeps the channel a name gives and says so when the signal is elsewhere or absent", () => {
    const files = namedSet();
    // Named PE, stained with APC: PE holds no signal.
    files[1] = beadControl(3, { id: "c1", fileName: "Compensation Controls_PE Stained Control.fcs", seed: 61 });
    // Named PE-Cy7, stained with FITC at high voltage: PE-Cy7 holds some FITC spillover (0.01).
    files[2] = syntheticControl({
      id: "c2", fileName: "Compensation Controls_PE-Cy7 Stained Control.fcs", particle: BEADS, seed: 62,
      stains: [{ fluor: 0, fraction: 0.5, brightness: 150_000 }],
    });
    const detection = detectControls(files);
    expect(detection.controls[1]).toMatchObject({
      role: "single-stain", channel: "PE-A", matchedBy: "name", notes: ["named-channel-has-no-signal"],
    });
    expect(detection.controls[1].brightest?.channel).toBe("APC-A");
    expect(detection.controls[2]).toMatchObject({
      role: "single-stain", channel: "PE-Cy7-A", matchedBy: "name", notes: ["name-and-signal-disagree"],
    });
  });

  it("keeps a control that holds a few beads carried over from the tube before", () => {
    const files = namedSet();
    // The APC tube with 3% of the BV510 tube's beads in it.
    const apc = beadControl(3, { id: "c3", fileName: "Compensation Controls_APC Stained Control.fcs", events: 4850 });
    const carried = syntheticControl({ id: "x", particle: BEADS, seed: 64, events: 150, stains: [{ fluor: 5, fraction: 1, brightness: 40_000 }] });
    const columns = PANEL.map((_, j) => Float32Array.from([...apc.columns[j], ...carried.columns[j]]));
    files[3] = { ...apc, eventCount: 5000, columns, values: (pnn) => columns[PANEL.indexOf(pnn as (typeof PANEL)[number])] ?? null, scatter: undefined };
    const detection = detectControls(files);
    expect(detection.controls[3]).toMatchObject({ role: "single-stain", channel: "APC-A", matchedBy: "name-and-signal", duplicate: false });
    // The same with nothing in the names.
    const anonymous = files.map((file, f) => ({ ...file, fileName: `Tube_00${f + 1}.fcs` }));
    expect(detectControls(anonymous).controls[3]).toMatchObject({ role: "single-stain", channel: "APC-A", matchedBy: "signal" });
  });

  it("keeps a cell control in which a few of the positive cells are bright in another channel", () => {
    // One in fifteen of the APC-positive cells is autofluorescent in FITC.
    const files = PANEL.map((_, fluor) => cellControl(fluor, { id: `c${fluor}`, fileName: `t${fluor}.fcs` }));
    files[3] = syntheticControl({
      id: "c3", fileName: "t3.fcs", particle: CELLS, seed: 65,
      stains: [{ fluor: 3, fraction: 0.6, brightness: 20_000, spread: 0.5 }, { fluor: 0, fraction: 0.04, brightness: 6000, spread: 0.4 }],
    });
    files.push(syntheticControl({ id: "u", fileName: "t9.fcs", particle: CELLS, seed: 51 }));
    expect(detectControls(files).controls[3]).toMatchObject({ role: "single-stain", channel: "APC-A", independentChannels: [] });
  });

  it("does not let a word in a sample's name make it a control", () => {
    // A stained sample named for a setting, brighter in APC than the APC control is.
    const sample = syntheticControl({
      id: "sample", fileName: "D2 treated higher APC voltage.fcs", particle: CELLS, seed: 72,
      stains: [
        { fluor: 5, fraction: 0.6, brightness: 90_000, spread: 0.4 },
        { fluor: 3, fraction: 0.3, brightness: 60_000, spread: 0.5 },
        { fluor: 1, fraction: 0.3, brightness: 20_000, spread: 0.5 },
      ],
    });
    const detection = detectControls([...namedSet(), sample]);
    expect(detection.controls[7].role).toBe("mixed");
    expect(detection.controls[3]).toMatchObject({ role: "single-stain", channel: "APC-A", duplicate: false });
  });

  it("reads an unnamed file bright in a named control's channel as a sample, not a second control", () => {
    // A sorted population positive for one marker, beside controls that are all named.
    const sorted = syntheticControl({
      id: "purity", fileName: "Specimen_001_D1 purity.fcs", particle: CELLS, seed: 73, events: 1200,
      stains: [{ fluor: 2, fraction: 0.95, brightness: 60_000, spread: 0.4 }],
    });
    const detection = detectControls([...namedSet(), sorted]);
    expect(detection.controls[7]).toMatchObject({ role: "mixed", channel: "PE-Cy7-A", duplicate: false });
    expect(detection.controls[2]).toMatchObject({ role: "single-stain", channel: "PE-Cy7-A", duplicate: false });
    // Among controls with nothing in their names it could be a second control, and is offered as one.
    expect(detectControls([...anonymousSet(), sorted]).controls[7].role).toBe("single-stain");
  });

  it("sets an FMO control aside by its name, with the channel it leaves out", () => {
    const fmo = syntheticControl({
      id: "fmo", fileName: "FMO BV510.fcs", particle: CELLS, seed: 71,
      stains: [0, 1, 2, 3, 4].map((fluor) => ({ fluor, fraction: 0.3, brightness: 20_000, spread: 0.5 })),
    });
    const detection = detectControls([...anonymousSet(), fmo]);
    expect(detection.controls[7]).toMatchObject({ role: "fmo", channel: "BV510-A", matchedBy: "name", duplicate: false });
    // It takes no channel from the controls, and BV510 still has its own.
    expect(detection.channelsWithoutControl).toEqual([]);
    expect(detection.controls[5]).toMatchObject({ role: "single-stain", channel: "BV510-A" });
  });

  it("reads an FMO control named for a marker only the samples carry", () => {
    const markers = [null, null, null, null, null, "CD45RA"];
    const stains = [0, 1, 2, 3, 4].map((fluor) => ({ fluor, fraction: 0.3, brightness: 20_000, spread: 0.5 }));
    const sample = syntheticControl({ id: "s", fileName: "D1 treated.fcs", particle: CELLS, seed: 74, markers, stains: [...stains, { fluor: 5, fraction: 0.4, brightness: 20_000, spread: 0.5 }] });
    const fmo = syntheticControl({ id: "fmo", fileName: "D1 FMO CD45RA.fcs", particle: CELLS, seed: 75, markers, stains });
    const detection = detectControls([...anonymousSet(), sample, fmo]);
    expect(detection.controls[8]).toMatchObject({ role: "fmo", channel: "BV510-A", matchedBy: "name" });
    expect(detection.controls[7].role).toBe("mixed");
  });

  it("lists the channels left without a control", () => {
    const files = anonymousSet().filter((file) => file.id !== "c2" && file.id !== "c5");
    expect(detectControls(files).channelsWithoutControl).toEqual(["PE-Cy7-A", "BV510-A"]);
  });

  it("reads two files", () => {
    const detection = detectControls([
      beadControl(0, { id: "a", fileName: "a.fcs" }),
      beadControl(1, { id: "b", fileName: "b.fcs" }),
    ]);
    expect(detection.controls.map((control) => control.channel)).toEqual(["FITC-A", "PE-A"]);
  });

  it("calls a file with a little signal unknown, not a control", () => {
    const files = anonymousSet();
    files.push(syntheticControl({
      id: "dim", fileName: "odd.fcs", particle: BEADS, seed: 63,
      stains: [{ fluor: 1, fraction: 0.5, brightness: 600 }],
    }));
    expect(detectControls(files).controls[7]).toMatchObject({ role: "unknown", channel: null, notes: ["weak-signal"] });
  });

  it("reads bead or cell from the name", () => {
    const detection = detectControls([
      beadControl(0, { id: "a", fileName: "FITC CompBeads.fcs" }),
      cellControl(1, { id: "b", fileName: "PE PBMC.fcs" }),
      beadControl(2, { id: "c", fileName: "PE-Cy7.fcs" }),
    ]);
    expect(detection.controls.map((control) => control.particle)).toEqual(["beads", "cells", null]);
  });

  it("returns nothing for no files", () => {
    expect(detectControls([])).toEqual({ channels: [], controls: [], channelsWithoutControl: [] });
  });
});
