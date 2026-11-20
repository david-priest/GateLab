import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFcs } from "../engine/fcs";
import { Sample } from "../engine/sample";
import { ARIA_III_DIR, ARIA_SMALL } from "../testFixtures";
import { checkBrightness, checkSettings } from "./controlChecks";
import { controlFileFromSample } from "./controlFile";
import { planControls } from "./controlPlan";
import { compareSpillover, estimateSpillover } from "./spilloverEstimate";

// A FACSDiva compensation setup on a FACSymphony S6: six single-stained bead tubes and an
// unstained tube of 5,000 events each, and a sample of the same experiment whose $SPILLOVER is the
// matrix FACSDiva calculated from those tubes. FACSDiva's matrix is the reference.
const CONTROLS_DIR = `${ARIA_III_DIR}/single_stain_controls`;
const CHANNELS = ["PE-A", "PE-Cy7-A", "APC-A", "APC-Cy7-A", "BV786-A", "BV711-A"];

function load(path: string): Sample {
  const bytes = readFileSync(path);
  return new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
}

describe.runIf(existsSync(CONTROLS_DIR) && existsSync(ARIA_SMALL))("a matrix from a FACSDiva compensation setup", () => {
  const names = existsSync(CONTROLS_DIR) ? readdirSync(CONTROLS_DIR).filter((name) => name.endsWith(".fcs")).sort() : [];
  const files = names.map((name, index) => controlFileFromSample(load(`${CONTROLS_DIR}/${name}`), `f${index}`, name));
  const plan = planControls(files);

  it("reads every tube for what it is, by its name and by its signal", () => {
    expect(plan.detection.channels.map((channel) => channel.key)).toEqual(CHANNELS);
    const read = Object.fromEntries(names.map((name, f) => {
      const control = plan.detection.controls[f];
      return [name.replace("Compensation Controls_", "").replace(" Control.fcs", ""), `${control.role} ${control.channel} ${control.matchedBy}`];
    }));
    expect(read).toEqual({
      "APC Stained": "single-stain APC-A name-and-signal",
      "APC-Cy7 Stained": "single-stain APC-Cy7-A name-and-signal",
      "BV711 Stained": "single-stain BV711-A name-and-signal",
      "BV786 Stained": "single-stain BV786-A name-and-signal",
      "PE Stained": "single-stain PE-A name-and-signal",
      "PE-Cy7 Stained": "single-stain PE-Cy7-A name-and-signal",
      "Unstained": "unstained null name",
    });
    expect(plan.detection.controls.flatMap((control) => control.notes)).toEqual([]);
    expect(plan.detection.channelsWithoutControl).toEqual([]);
  });

  it("finds the same channels with the names taken away", () => {
    const anonymous = files.map((file, index) => ({ ...file, fileName: `Tube_00${index + 1}.fcs`, labels: [] }));
    const detection = planControls(anonymous).detection;
    expect(detection.controls.map((control) => `${control.role} ${control.channel}`)).toEqual(
      plan.detection.controls.map((control) => `${control.role} ${control.channel}`));
    expect(detection.controls.map((control) => control.matchedBy)).toEqual(files.map(() => "signal"));
  });

  it("uses each bead tube's own negative beads, and reads the tubes as beads from their peaks", () => {
    expect(plan.controls.map((control) => control.negativeSource)).toEqual(CHANNELS.map(() => "internal"));
    expect(plan.controls.map((control) => `${control.kind} ${control.kindFrom}`)).toEqual(CHANNELS.map(() => "beads peaks"));
    for (const control of plan.controls) {
      expect(control.split?.bimodal).toBe(true);
      expect(control.split!.positiveCount + control.split!.negativeCount).toBeGreaterThan(4700);
    }
  });

  it("agrees with the matrix FACSDiva calculated to within 0.002 in every coefficient", () => {
    const estimate = estimateSpillover(files, CHANNELS, plan.specs);
    expect(estimate.rows.map((row) => row.source)).toEqual(CHANNELS.map(() => "control"));
    expect(estimate.rows.flatMap((row) => row.warnings)).toEqual([]);
    const differences = compareSpillover(estimate, load(ARIA_SMALL).spillover!);
    expect(differences).toHaveLength(30);
    // Measured 2026-11-18: the largest is 0.0007 (PE-Cy7 into BV786, 0.2100 against 0.2093).
    expect(Math.abs(differences[0].difference)).toBeLessThan(0.002);
    // Every difference is within five of the estimate's own standard errors (the most measured: 3.7).
    for (const difference of differences) {
      expect(Math.abs(difference.difference)).toBeLessThan(5 * difference.uncertainty! + 1e-4);
    }
  });

  it("finds the experiment's samples run at the controls' settings, and dimmer than the controls", () => {
    const sample = controlFileFromSample(load(`${ARIA_III_DIR}/sample_PBMC_check.fcs`), "sample", "sample_PBMC_check.fcs");
    // With a stained sample among the files it is set aside, and the controls are read as before.
    const together = planControls([...files, sample]);
    expect(together.detection.controls[7].role).toBe("mixed");
    expect(together.controls.map((control) => control.fileId)).toEqual(plan.controls.map((control) => control.fileId));
    expect(files[0].channels.map((channel) => channel.voltage)).toEqual([655, 420, 590, 450, 453, 472]);
    expect(checkSettings(files, [sample], CHANNELS)).toEqual([]);
    const estimate = estimateSpillover(files, CHANNELS, plan.specs);
    const brightness = checkBrightness(files, CHANNELS, plan.specs, estimate.matrix, sample);
    expect(brightness.map((finding) => finding.channel)).toEqual(CHANNELS);
    // Measured 2026-11-18: the sample reaches at most 0.48 of a control's brightness (BV711).
    expect(brightness.every((finding) => !finding.exceeds && finding.ratio < 0.6)).toBe(true);
  });
});
