import { describe, expect, it } from "vitest";
import { controlSession, sessionDetection, sessionOriginControls, type SessionChoices } from "./controlSession";
import { BEADS, beadControl, CELLS, PANEL, syntheticControl, TRUE_SPILLOVER, type SyntheticFile } from "./syntheticControls.fixture";

/** Six bead controls, an unstained tube and a stained sample, with names that say nothing. */
function experiment(): SyntheticFile[] {
  return [
    ...PANEL.map((_, fluor) => beadControl(fluor, { id: `c${fluor}`, fileName: `Tube_00${fluor + 1}.fcs` })),
    syntheticControl({ id: "u", fileName: "Tube_007.fcs", particle: BEADS, seed: 50 }),
    syntheticControl({
      id: "sample", fileName: "D1 treated.fcs", particle: CELLS, seed: 70,
      stains: [
        { fluor: 3, fraction: 1, brightness: 12_000, spread: 0.4 },
        { fluor: 0, fraction: 0.33, brightness: 9_000, spread: 0.5 },
        { fluor: 1, fraction: 0.2, brightness: 8_000, spread: 0.5 },
      ],
    }),
  ];
}

const session = (files: SyntheticFile[], choices: SessionChoices = {}) => controlSession(sessionDetection(files, choices), choices);

describe("controlSession", () => {
  it("gives the matrix, the roles and the checks with nothing chosen", () => {
    const result = session(experiment());
    expect(result.files.map((entry) => entry.role)).toEqual([...PANEL.map(() => "single-stain"), "unstained", "mixed"]);
    expect(result.matrixChannels).toEqual([...PANEL]);
    expect(result.channelsWithoutControl).toEqual([]);
    TRUE_SPILLOVER.forEach((row, i) => row.forEach((value, j) => {
      expect(Math.abs(result.estimate!.matrix[i][j] - value)).toBeLessThanOrEqual(0.002 + 0.02 * value);
    }));
    expect(result.files[0]).toMatchObject({ chosen: false, duplicate: false, boundariesMoved: false });
    expect(result.files[0].negativeUpper).toBe(result.files[0].planned!.split!.negativeUpper);
    expect(result.files[0].positiveLower).toBe(result.files[0].planned!.split!.positiveLower);
    expect(result.files[0].row).toMatchObject({ channel: "FITC-A", source: "control" });
    // The sample is checked against the controls, and is dimmer than they are.
    expect(result.brightness).toHaveLength(1);
    expect(result.brightness[0].fileId).toBe("sample");
    expect(result.brightness[0].findings.every((finding) => !finding.exceeds)).toBe(true);
    expect(result.reference).toBeNull();
  });

  it("uses the file the user gives a channel, and makes the detected one a duplicate", () => {
    const files = experiment();
    // A second FITC control, dimmer: detected as a duplicate.
    files.push(syntheticControl({
      id: "second", fileName: "Tube_009.fcs", particle: BEADS, seed: 60,
      stains: [{ fluor: 0, fraction: 0.5, brightness: 9000 }],
    }));
    const detected = session(files);
    expect(detected.files[0].duplicate).toBe(false);
    expect(detected.files[8]).toMatchObject({ role: "single-stain", channel: "FITC-A", duplicate: true, planned: null });
    const chosen = session(files, { second: { role: "single-stain", channel: "FITC-A" } });
    expect(chosen.files[8]).toMatchObject({ chosen: true, duplicate: false });
    expect(chosen.files[8].row?.positiveFileId).toBe("second");
    expect(chosen.files[0]).toMatchObject({ duplicate: true, spec: null, row: null });
    // The dimmer control gives the same coefficients.
    expect(Math.abs(chosen.estimate!.matrix[0][1] - 0.12)).toBeLessThan(0.006);
  });

  it("moves a channel's control when the user corrects a file's channel", () => {
    const moved = session(experiment(), { c2: { channel: "APC-A" } });
    expect(moved.files[2]).toMatchObject({ channel: "APC-A", chosen: true, duplicate: false });
    expect(moved.files[3]).toMatchObject({ channel: "APC-A", duplicate: true });
    expect(moved.channelsWithoutControl).toContain("PE-Cy7-A");
    // The file is brightest elsewhere than the channel it was given, which the detection keeps for the interface to say.
    expect(moved.files[2].detected.brightest?.channel).toBe("PE-Cy7-A");
    expect(moved.files[2].row).toMatchObject({ channel: "APC-A", positiveFileId: "c2" });
  });

  it("calculates from the boundaries the user moved", () => {
    const files = experiment();
    const before = session(files);
    const split = before.files[1].planned!.split!;
    const after = session(files, { c1: { negativeUpper: split.negativeUpper * 0.8, positiveLower: split.positiveLower * 1.02 } });
    expect(after.files[1]).toMatchObject({
      boundariesMoved: true, negativeUpper: split.negativeUpper * 0.8, positiveLower: split.positiveLower * 1.02,
    });
    expect(after.files[1].row!.positiveCount).toBeLessThan(before.files[1].row!.positiveCount);
    expect(after.files[1].row!.negativeCount).toBeLessThanOrEqual(before.files[1].row!.negativeCount);
    expect(Math.abs(after.estimate!.matrix[1][2] - 0.08)).toBeLessThan(0.004);
    // Other controls are as they were.
    expect(after.estimate!.matrix[0]).toEqual(before.estimate!.matrix[0]);
  });

  it("takes each set as an interval where the user gives it an outer boundary", () => {
    const files = experiment();
    // A PE control with a second, brighter peak of doublets: a quarter of the positive beads at twice the signal.
    files[1] = syntheticControl({
      id: "c1", fileName: "Tube_002.fcs", particle: BEADS, seed: 87,
      stains: [
        { fluor: 1, fraction: 0.5, brightness: 40_000, spread: 0.06 },
        { fluor: 1, fraction: 0.25, brightness: 40_000, spread: 0.06 },
      ],
    });
    const before = session(files);
    expect(before.files[1]).toMatchObject({ negativeLower: null, positiveUpper: null, boundariesMoved: false });
    const own = Array.from(files[1].values("PE-A")!);
    const positiveLower = before.files[1].positiveLower!;
    const negativeUpper = before.files[1].negativeUpper!;
    // The positive events up to 60,000 are the singlets; the negative events from 20 leave out the lowest.
    const after = session(files, { c1: { positiveUpper: 60_000, negativeLower: 20 } });
    expect(after.files[1]).toMatchObject({ negativeLower: 20, negativeUpper, positiveLower, positiveUpper: 60_000, boundariesMoved: true });
    expect(after.files[1].row).toMatchObject({
      positiveCount: own.filter((value) => value >= positiveLower && value < 60_000).length,
      negativeCount: own.filter((value) => value >= 20 && value < negativeUpper).length,
    });
    expect(after.files[1].row!.positiveCount).toBeLessThan(before.files[1].row!.positiveCount);
    expect(after.files[1].row!.positiveMedian).toBeLessThan(before.files[1].row!.positiveMedian);
    expect(Math.abs(after.estimate!.matrix[1][2] - 0.08)).toBeLessThan(0.004);
    // The record of what the row was calculated from carries both boundaries of each set.
    const origin = sessionOriginControls(after).find((control) => control.channel === "PE-A")!;
    expect(origin.events).toMatchObject({ lower: positiveLower, upper: 60_000 });
    expect(origin.negative).toMatchObject({ lower: 20, upper: negativeUpper });
    // An outer boundary alone does not stand in for a negative population that was not found.
    files[1] = syntheticControl({
      id: "c1", fileName: "PE beads.fcs", particle: BEADS, seed: 81,
      stains: [{ fluor: 1, fraction: 1, brightness: 40_000, spread: 0.08 }],
    });
    files[6] = syntheticControl({ id: "u", fileName: "unstained cells.fcs", particle: CELLS, seed: 51 });
    expect(session(files, { c1: { positiveUpper: 60_000 } }).files[1].spec).toBeNull();
  });

  it("takes the user's two boundaries where no negative population was found", () => {
    const files = experiment();
    // A PE control with nine in ten beads positive, read as beads by its name: the split still finds both peaks.
    // One with every event positive has none, and as beads it is not calculated.
    files[1] = syntheticControl({
      id: "c1", fileName: "PE beads.fcs", particle: BEADS, seed: 81,
      stains: [{ fluor: 1, fraction: 1, brightness: 40_000, spread: 0.08 }],
    });
    // The unstained tube is of cells: it cannot stand in for the beads' negative.
    files[6] = syntheticControl({ id: "u", fileName: "unstained cells.fcs", particle: CELLS, seed: 51 });
    const found = session(files);
    expect(found.files[1].planned).toMatchObject({ kind: "beads", problem: "no-negative-population", spec: null });
    expect(found.matrixChannels).not.toContain("PE-A");
    // Marking the lowest tenth as negative and the top half as positive makes it a control again.
    const sorted = Array.from(files[1].values("PE-A")!).sort((a, b) => a - b);
    const marked = session(files, { c1: { negativeUpper: sorted[500], positiveLower: sorted[2500] } });
    expect(marked.files[1]).toMatchObject({ negativeUpper: sorted[500], positiveLower: sorted[2500], boundariesMoved: true });
    expect(marked.matrixChannels).toContain("PE-A");
    expect(marked.files[1].row).toMatchObject({ positiveCount: 2500, negativeCount: 500 });
  });

  it("leaves out a file the user ignores, and a channel whose control gives no row", () => {
    const files = experiment();
    const without = session(files, { c4: { role: "ignored" } });
    expect(without.files.map((entry) => entry.file.id)).not.toContain("c4");
    expect(without.matrixChannels).toEqual(PANEL.filter((channel) => channel !== "BV421-A"));
    expect(without.channelsWithoutControl).toEqual(["BV421-A"]);
    expect(without.estimate!.matrix).toHaveLength(5);
    // The unstained tube given as the BV421 control has no signal there.
    const none = session(files, { c4: { role: "ignored" }, u: { role: "single-stain", channel: "BV421-A" } });
    expect(none.matrixChannels).not.toContain("BV421-A");
    expect(none.files.find((entry) => entry.file.id === "u")).toMatchObject({ duplicate: false, role: "single-stain" });
  });

  it("sets aside files whose channels are not the controls'", () => {
    const files: SyntheticFile[] = [
      ...experiment(),
      syntheticControl({ id: "other1", fileName: "panel B 1.fcs", panel: ["FITC-A", "PE-A"], particle: CELLS, seed: 90 }),
      syntheticControl({ id: "other2", fileName: "panel B 2.fcs", panel: ["FITC-A", "PE-A"], particle: CELLS, seed: 91 }),
    ];
    const base = sessionDetection(files);
    expect(base.otherChannels).toEqual(["other1", "other2"]);
    expect(base.files).toHaveLength(8);
    expect(controlSession(base).matrixChannels).toEqual([...PANEL]);
    // Two named controls of one panel outweigh more files of another.
    const other = { panel: ["FITC-A", "PE-A", "PerCP-A"], spillover: [[1, 0.1, 0], [0.02, 1, 0], [0, 0, 1]] };
    const named = [
      beadControl(0, { id: "a", fileName: "FITC.fcs" }),
      beadControl(1, { id: "b", fileName: "PE.fcs" }),
      syntheticControl({ id: "s1", fileName: "D1 control.fcs", particle: CELLS, seed: 91, ...other }),
      syntheticControl({ id: "s2", fileName: "D2 control.fcs", particle: CELLS, seed: 92, ...other }),
      syntheticControl({ id: "s3", fileName: "D3 control.fcs", particle: CELLS, seed: 93, ...other }),
    ];
    expect(sessionDetection(named).files.map((file) => file.id)).toEqual(["a", "b"]);
  });

  it("takes in a sample recorded with one parameter more than the controls", () => {
    const more = [...PANEL, "DAPI-A"];
    const wider = TRUE_SPILLOVER.map((row) => [...row, 0]).concat([[0, 0, 0, 0, 0, 0, 1]]);
    const files = [
      ...experiment().slice(0, 7),
      syntheticControl({
        id: "wide", fileName: "D2 treated.fcs", particle: CELLS, seed: 94, panel: more, spillover: wider,
        stains: [{ fluor: 3, fraction: 1, brightness: 12_000, spread: 0.4 }, { fluor: 0, fraction: 0.33, brightness: 9_000, spread: 0.5 }],
      }),
    ];
    const base = sessionDetection(files);
    expect(base.otherChannels).toEqual([]);
    const result = controlSession(base);
    expect(result.channels.map((channel) => channel.pnn)).toEqual([...PANEL]);
    expect(result.files[7]).toMatchObject({ role: "mixed" });
    expect(result.brightness.map((entry) => entry.fileId)).toEqual(["wide"]);
  });

  it("compares with the embedded matrix of a sample of the set", () => {
    const files = experiment();
    const embedded = { channels: [...PANEL], matrix: TRUE_SPILLOVER.map((row) => [...row]) };
    embedded.matrix[4][5] = 0.2;
    const withMatrix = [...files.slice(0, 7), { ...files[7], embedded }];
    const result = controlSession(sessionDetection(withMatrix));
    expect(result.reference?.fileId).toBe("sample");
    expect(result.reference?.differences).toHaveLength(30);
    expect(result.reference?.differences[0]).toMatchObject({ source: "BV421-A", receiver: "BV510-A", reference: 0.2 });
    expect(result.reference!.differences[0].difference).toBeGreaterThan(0.04);
  });

  it("records what each row was calculated from", () => {
    const files = experiment();
    files[3] = syntheticControl({
      id: "c3", fileName: "Tube_004.fcs", particle: CELLS, seed: 83,
      stains: [{ fluor: 3, fraction: 1, brightness: 20_000, spread: 0.4 }],
    });
    files[6] = syntheticControl({ id: "u", fileName: "unstained cells.fcs", particle: CELLS, seed: 51 });
    const result = session(files);
    const origin = sessionOriginControls(result);
    expect(origin.map((control) => control.channel)).toEqual([...PANEL]);
    expect(origin[0]).toEqual({
      channel: "FITC-A",
      row: "control",
      events: { fileName: "Tube_001.fcs", count: result.files[0].row!.positiveCount, lower: result.files[0].positiveLower },
      negative: { fileName: "Tube_001.fcs", count: result.files[0].row!.negativeCount, upper: result.files[0].negativeUpper },
    });
    // The APC control has no negative cells: its negative events are the unstained tube's, all of them.
    expect(origin[3].negative).toEqual({ fileName: "unstained cells.fcs", count: 5000 });
    expect(origin[3].events.fileName).toBe("Tube_004.fcs");
  });
});
