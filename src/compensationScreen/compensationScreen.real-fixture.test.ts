// The screen on a real stained mass-cytometry file with a bead-derived matrix. Skips where the
// files are not configured (src/testFixtures.ts). The file's own readings are not asserted pair
// by pair: what is asserted is what must hold on any real file, by adding and removing known
// spillover.
//
// Set COMP_SCREEN_OUT to a file path to have the full reading written there.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deterministicCompensationEventIndices } from "../engine/compensationPairPreview";
import { parseCompensationMatrixTable } from "../engine/compensationMatrixImport";
import { parseFcs } from "../engine/fcs";
import { Sample } from "../engine/sample";
import { CYTOF_BEAD_MATRIX, CYTOF_WORKSPACE_FCS } from "../testFixtures";
import { screenDataFromSample } from "./screenInput";
import { runCompensationScreen, type ScreenData, type ScreenMatrix } from "./screenPairs";

const FCS = process.env.GATELAB_CYTOF_WORKSPACE_FCS ?? CYTOF_WORKSPACE_FCS;
const MATRIX = process.env.GATELAB_CYTOF_BEAD_MATRIX ?? CYTOF_BEAD_MATRIX;
const available = existsSync(FCS) && existsSync(MATRIX);
const onlyPair = (target: { source: string; receiver: string }) => ({
  only: (source: string, receiver: string) => source === target.source && receiver === target.receiver,
});

// Each test reads tens of thousands of events; the default 5 s is too short beside a full run.
const SLOW = 30_000;

describe.runIf(available)("the screen on a real stained file", () => {
  const load = () => {
    const buffer = readFileSync(FCS);
    const sample = new Sample(parseFcs(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)));
    const matrix: ScreenMatrix = parseCompensationMatrixTable(readFileSync(MATRIX, "utf8")).input;
    const data = screenDataFromSample(
      sample,
      deterministicCompensationEventIndices(sample.fcs.nEvents, 60_000),
    );
    return { data, matrix };
  };

  it("reads the stored counts, finds bright pairs it can read, and finishes quickly", { timeout: SLOW }, () => {
    const { data, matrix } = load();
    const started = performance.now();
    const result = runCompensationScreen(data, matrix);
    const elapsed = performance.now() - started;
    expect(result.pairs.length).toBeGreaterThan(50);
    expect(result.pairs.filter(({ verdict }) => verdict === "consistent").length).toBeGreaterThan(10);
    expect(elapsed).toBeLessThan(5_000);
    const out = process.env.COMP_SCREEN_OUT;
    if (out) {
      const percent = (value: number | null | undefined) => value == null ? "" : (100 * value).toFixed(3);
      const lines = [
        `# ${result.eventCount} events, ${result.pairs.length} pairs, ${elapsed.toFixed(0)} ms`,
        `# oxide ${JSON.stringify(result.oxide)}`,
        "source\treceiver\tinteraction\tunlabelled\tmatrix%\tfloor%\tfloorLower%\tupper%\ttightness\tspan\tlimit%\tverdict\treason\timpact",
        ...result.pairs.map((pair) => [
          pair.source, pair.receiver, pair.interaction, pair.receiverUnlabelled ? "yes" : "",
          percent(pair.coefficient), percent(pair.floor?.slope), percent(pair.floorLower), percent(pair.floor?.upperBound),
          pair.floor?.tightness.toFixed(1), pair.floor?.span.toFixed(0), percent(pair.detectionLimit),
          pair.verdict, pair.upperBoundReason ?? "", pair.impact.toFixed(1),
        ].join("\t")),
      ];
      writeFileSync(out, lines.join("\n"));
    }
  });

  it("finds a coefficient removed from the matrix, on pairs it read as consistent", { timeout: SLOW }, () => {
    const { data, matrix } = load();
    const base = runCompensationScreen(data, matrix);
    // Pairs the matrix and the events agree on, worth at least three times the smallest readable value.
    const readable = base.pairs.filter((pair) =>
      pair.verdict === "consistent" && pair.coefficient >= 3 * pair.detectionLimit! &&
      pair.floor!.tightness <= base.settings.tightnessLimit && pair.interaction !== "other");
    expect(readable.length).toBeGreaterThan(3);
    let found = 0;
    for (const target of readable) {
      const row = matrix.sourceChannels.indexOf(target.source);
      const column = matrix.receiverChannels.indexOf(target.receiver);
      const without: ScreenMatrix = {
        ...matrix,
        matrix: matrix.matrix.map((values, index) =>
          index === row ? values.map((value, at) => at === column ? 0 : value) : values),
      };
      const read = runCompensationScreen(data, without, {}, onlyPair(target)).pairs[0];
      if (read.verdict === "below-floor") found++;
    }
    expect(found).toBe(readable.length);
  });

  it("finds a coefficient three times too large, where the events bound it", { timeout: SLOW }, () => {
    const { data, matrix } = load();
    const base = runCompensationScreen(data, matrix);
    const bounded = base.pairs.filter((pair) =>
      pair.verdict === "consistent" && pair.coefficient >= 3 * pair.detectionLimit! &&
      pair.floor!.upperBound < pair.coefficient * 1.5);
    expect(bounded.length).toBeGreaterThan(3);
    let found = 0;
    for (const target of bounded) {
      const row = matrix.sourceChannels.indexOf(target.source);
      const column = matrix.receiverChannels.indexOf(target.receiver);
      const tripled: ScreenMatrix = {
        ...matrix,
        matrix: matrix.matrix.map((values, index) =>
          index === row ? values.map((value, at) => at === column ? value * 3 : value) : values),
      };
      const read = runCompensationScreen(data, tripled, {}, onlyPair(target)).pairs[0];
      if (read.verdict === "above-data") found++;
    }
    expect(found).toBe(bounded.length);
  });

  it("finds spillover added to the counts of a pair the matrix holds no value for", { timeout: SLOW }, () => {
    const { data, matrix } = load();
    const base = runCompensationScreen(data, matrix);
    // Zero-coefficient physical pairs with a bright source and a flat, tight floor.
    const quiet = base.pairs.filter((pair) =>
      pair.verdict === "consistent" && pair.coefficient === 0 && pair.interaction !== "other" &&
      pair.detectionLimit! <= 0.003 && pair.floor!.upperBound < 0.004).slice(0, 12);
    expect(quiet.length).toBeGreaterThan(2);
    let state = 12345;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    let read = 0;
    let found = 0;
    for (const target of quiet) {
      const source = data.values(target.source)!;
      const receiver = Float64Array.from(data.values(target.receiver)!);
      for (let event = 0; event < receiver.length; event++) {
        // 2% of the source, with counting noise (normal approximation; small means left out).
        const mean = 0.02 * source[event];
        if (mean > 0.5) receiver[event] += Math.max(0, mean + Math.sqrt(mean) * (random() + random() + random() - 1.5) * 2);
      }
      const spiked: ScreenData = {
        ...data,
        values: (pnn) => pnn === target.receiver ? receiver : data.values(pnn),
      };
      const pair = runCompensationScreen(spiked, matrix, {}, onlyPair(target)).pairs[0];
      // The added 2% is read back on every pair …
      if (pair.floor!.slope > 0.012 && pair.floor!.slope < 0.026 && pair.verdict !== "consistent") read++;
      // … and called a missing coefficient unless the receiver's own floor is too wide to say
      // (11 of 12 on the file this was written against, the twelfth at 3.02 against a limit of 3).
      if (pair.verdict === "below-floor") found++;
    }
    expect(read).toBe(quiet.length);
    expect(found).toBeGreaterThanOrEqual(Math.floor(quiet.length * 0.8));
  });
});
