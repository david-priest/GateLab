import { describe, expect, it } from "vitest";
import {
  channelIsUnlabelled,
  createScreenJob,
  runCompensationScreen,
  screenPairEvents,
  suggestedCoefficient,
  type ScreenPair,
  type ScreenResult,
} from "./screenPairs";
import {
  matrixFrom,
  PANEL,
  simulatePanel,
  TRUE_SPILL,
  withCoefficient,
} from "./syntheticPanel.fixture";

const pair = (result: ScreenResult, source: string, receiver: string): ScreenPair => {
  const found = result.pairs.find((candidate) => candidate.source === source && candidate.receiver === receiver);
  if (!found) throw new Error(`${source} > ${receiver} was not screened`);
  return found;
};
const flagged = (result: ScreenResult) =>
  result.pairs.filter(({ verdict }) => verdict === "above-data" || verdict === "below-floor");

describe("channelIsUnlabelled", () => {
  it("reads a channel with no marker, or only its own isotope, as carrying no antibody", () => {
    expect(channelIsUnlabelled({ pnn: "Dy161Di", marker: null })).toBe(true);
    expect(channelIsUnlabelled({ pnn: "Dy161Di", marker: "Dy161Di" })).toBe(true);
    expect(channelIsUnlabelled({ pnn: "Dy161Di", marker: "161Dy" })).toBe(true);
    expect(channelIsUnlabelled({ pnn: "Dy161Di", marker: "161Dy_marker_a" })).toBe(false);
    expect(channelIsUnlabelled({ pnn: "Dy161Di", marker: "marker_a" })).toBe(false);
    // A marker name that happens to parse as an isotope is a marker.
    expect(channelIsUnlabelled({ pnn: "Dy161Di", marker: "B220" })).toBe(false);
  });
});

describe("the screen with the matrix the instrument has", () => {
  const simulated = simulatePanel();
  const result = runCompensationScreen(simulated.data, matrixFrom(TRUE_SPILL));

  it("asks for no pair's attention", () => {
    expect(flagged(result)).toEqual([]);
  });

  it("finds the bright pairs consistent, with the true value inside the floor and the bound", () => {
    for (const [source, receiver] of [
      ["Nd143Di", "Tb159Di"],
      ["Nd144Di", "Gd160Di"],
      ["Nd145Di", "Dy161Di"],
      ["Nd143Di", "Nd144Di"],
    ]) {
      const read = pair(result, source, receiver);
      const truth = TRUE_SPILL[source][receiver];
      expect(read.verdict).toBe("consistent");
      expect(read.floor!.upperBound).toBeGreaterThanOrEqual(truth);
      expect(read.floorLower!).toBeLessThanOrEqual(truth);
      expect(read.floor!.slope).toBeGreaterThan(truth * 0.8);
    }
  });

  it("says a source too dim to show the matrix value is too dim", () => {
    expect(pair(result, "Er167Di", "Er168Di").verdict).toBe("too-dim");
  });

  it("gives only an upper bound where every source-bright cell carries the receiver's marker", () => {
    const read = pair(result, "Yb171Di", "Yb172Di");
    expect(read.verdict).toBe("upper-bound-only");
    expect(read.upperBoundReason).not.toBeNull();
    expect(read.floor!.upperBound).toBeGreaterThanOrEqual(TRUE_SPILL.Yb171Di.Yb172Di);
  });

  it("calls a cap the events cannot bring under the plausible maximum a cap, not agreement", () => {
    // Nd144 and Nd145 mark the same cells: the receiver's floor says nothing about a coefficient.
    for (const [source, receiver] of [["Nd144Di", "Nd145Di"], ["Nd145Di", "Nd144Di"]]) {
      const read = pair(result, source, receiver);
      expect(read.floor!.upperBound).toBeGreaterThan(result.settings.plausibleMaximum);
      expect(read.verdict).toBe("upper-bound-only");
    }
    expect(result.pairs.some((read) => read.upperBoundReason === "loose-bound")).toBe(true);
    for (const read of result.pairs) {
      if (read.verdict === "consistent") expect(read.floor!.upperBound).toBeLessThanOrEqual(result.settings.plausibleMaximum);
    }
  });

  it("marks the receiver that carries no antibody", () => {
    expect(pair(result, "Nd145Di", "Dy161Di").receiverUnlabelled).toBe(true);
    expect(pair(result, "Nd143Di", "Tb159Di").receiverUnlabelled).toBe(false);
  });

  it("leaves pairs without a coefficient or a physical route out unless every pair is asked for", () => {
    expect(result.pairs.some(({ source, receiver }) => source === "Nd143Di" && receiver === "Lu175Di")).toBe(false);
    const all = runCompensationScreen(simulated.data, matrixFrom(TRUE_SPILL), { pairs: "all" });
    const coexpressed = pair(all, "Nd143Di", "Lu175Di");
    // Markers on the same cells with no route for spillover: never read as a missing coefficient.
    expect(coexpressed.verdict).not.toBe("below-floor");
    expect(flagged(all)).toEqual([]);
  });

  // Six simulated panels screened in full: too long for the default 5 s beside a full run.
  it("holds over other draws of the events", { timeout: 30_000 }, () => {
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const again = runCompensationScreen(simulatePanel({ seed }).data, matrixFrom(TRUE_SPILL), { pairs: "all" });
      expect(flagged(again).map(({ source, receiver }) => `${source}>${receiver}`)).toEqual([]);
    }
  });
});

describe("a coefficient the matrix lacks", () => {
  const simulated = simulatePanel();

  it("is found, with the value the events support", () => {
    const result = runCompensationScreen(
      simulated.data,
      matrixFrom(withCoefficient(TRUE_SPILL, "Nd143Di", "Tb159Di", 0)),
    );
    expect(flagged(result).map(({ source, receiver }) => `${source}>${receiver}`)).toEqual(["Nd143Di>Tb159Di"]);
    const read = result.pairs[0];
    expect(read.verdict).toBe("below-floor");
    expect(read.coefficient).toBe(0);
    expect(read.floor!.slope).toBeGreaterThan(0.008);
    expect(read.floor!.upperBound).toBeGreaterThanOrEqual(0.01);
    expect(read.floor!.upperBound).toBeLessThan(0.012);
    expect(read.impact).toBeGreaterThan(10);
  });

  it("is found when it is too low rather than absent", () => {
    const result = runCompensationScreen(
      simulated.data,
      matrixFrom(withCoefficient(TRUE_SPILL, "Nd145Di", "Dy161Di", 0.004)),
    );
    expect(flagged(result).map(({ source, receiver, verdict }) => `${source}>${receiver} ${verdict}`))
      .toEqual(["Nd145Di>Dy161Di below-floor"]);
  });

  it("is found on a pair the matrix and the instrument both lack, when spiked into the events", () => {
    // Gd160 → Dy161 is M+1; the instrument has no such spillover until it is added to the counts.
    const base = runCompensationScreen(simulated.data, matrixFrom(TRUE_SPILL));
    expect(pair(base, "Gd160Di", "Dy161Di").verdict).toBe("consistent");
    for (const [added, found] of [[0.004, false], [0.02, true], [0.05, true]] as const) {
      const result = runCompensationScreen(
        simulated.spike("Gd160Di", "Dy161Di", added),
        matrixFrom(TRUE_SPILL),
      );
      const read = pair(result, "Gd160Di", "Dy161Di");
      expect(read.verdict === "below-floor").toBe(found);
      if (found) {
        expect(read.floor!.slope).toBeGreaterThan(added * 0.7);
        expect(read.floor!.upperBound).toBeGreaterThanOrEqual(added);
      }
    }
  });
});

describe("a coefficient larger than the instrument's", () => {
  const simulated = simulatePanel();

  it("is found where the receiver's floor is clean", () => {
    const result = runCompensationScreen(
      simulated.data,
      matrixFrom(withCoefficient(TRUE_SPILL, "Nd145Di", "Dy161Di", 0.036)),
    );
    expect(flagged(result).map(({ source, receiver, verdict }) => `${source}>${receiver} ${verdict}`))
      .toEqual(["Nd145Di>Dy161Di above-data"]);
    expect(result.pairs[0].impact).toBeGreaterThan(10);
  });

  it("cannot be shown where the receiver's marker is on the source's cells", () => {
    // Three times the true value, but marker_c is on every Nd144-bright cell: the events allow it.
    const result = runCompensationScreen(
      simulated.data,
      matrixFrom(withCoefficient(TRUE_SPILL, "Nd144Di", "Nd145Di", 0.09)),
    );
    expect(pair(result, "Nd144Di", "Nd145Di").verdict).not.toBe("above-data");
  });

  it("does not make its neighbours look wrong", () => {
    const result = runCompensationScreen(
      simulated.data,
      matrixFrom(withCoefficient(TRUE_SPILL, "Nd143Di", "Nd144Di", 0.06)),
    );
    expect(flagged(result).map(({ source, receiver, verdict }) => `${source}>${receiver} ${verdict}`))
      .toEqual(["Nd143Di>Nd144Di above-data"]);
  });
});

describe("the oxide pairs read together", () => {
  it("are near 1 when the matrix is the instrument's", () => {
    const { oxide } = runCompensationScreen(simulatePanel().data, matrixFrom(TRUE_SPILL));
    expect(oxide).not.toBeNull();
    expect(oxide!.pairs.length).toBe(3);
    expect(oxide!.shared).toBe(false);
    expect(oxide!.ratio).toBeGreaterThan(0.8);
    expect(oxide!.ratio).toBeLessThan(1.1);
  });

  it("show one shared factor when the run forms more oxide than the matrix's run did", () => {
    // The matrix holds the oxide coefficients of an earlier run; this run's are 2.5 times those.
    const run: Record<string, Record<string, number>> = {};
    for (const [source, row] of Object.entries(TRUE_SPILL)) run[source] = { ...row };
    run.Nd143Di.Tb159Di *= 2.5;
    run.Nd144Di.Gd160Di *= 2.5;
    run.Nd145Di.Dy161Di *= 2.5;
    const { oxide, pairs } = runCompensationScreen(simulatePanel({ spill: run }).data, matrixFrom(TRUE_SPILL));
    expect(oxide!.shared).toBe(true);
    expect(oxide!.pairs.length).toBe(3);
    expect(oxide!.ratio).toBeGreaterThan(2.1);
    expect(oxide!.ratio).toBeLessThan(2.6);
    expect(pairs.filter(({ verdict }) => verdict === "below-floor").map(({ interaction }) => interaction))
      .toEqual(["oxide (+16)", "oxide (+16)", "oxide (+16)"]);
  });
});

describe("the screen in steps", () => {
  it("takes one step per matrix source in the file and gives the same result as one run", () => {
    const simulated = simulatePanel({ events: 8_000 });
    const matrix = matrixFrom(TRUE_SPILL);
    const job = createScreenJob(simulated.data, matrix);
    expect(job.stepCount).toBe(PANEL.length);
    let steps = 1;
    while (job.step()) steps++;
    expect(steps).toBe(PANEL.length);
    expect(job.result()).toEqual(runCompensationScreen(simulated.data, matrix));
  });

  it("reads one pair alone to the same numbers as within the whole screen", () => {
    const simulated = simulatePanel({ events: 8_000 });
    const matrix = matrixFrom(TRUE_SPILL);
    const whole = pair(runCompensationScreen(simulated.data, matrix), "Nd144Di", "Gd160Di");
    const job = createScreenJob(simulated.data, matrix, {}, {
      only: (source, receiver) => source === "Nd144Di" && receiver === "Gd160Di",
    });
    expect(job.stepCount).toBe(1);
    while (job.step()) { /* one source */ }
    expect(job.result().pairs).toEqual([whole]);
  });

  it("names the sources it could not read", () => {
    const simulated = simulatePanel({ events: 300 });
    const result = runCompensationScreen(simulated.data, matrixFrom(TRUE_SPILL));
    expect(result.pairs).toEqual([]);
    expect(result.unreadSources.length).toBe(PANEL.length);
    expect(result.unreadSources[0].reason).toBe("few-events");
  });

  it("screens only channels the file holds", () => {
    const simulated = simulatePanel({ events: 8_000 });
    const matrix = matrixFrom(TRUE_SPILL);
    const wider = {
      sourceChannels: [...matrix.sourceChannels, "Ho165Di"],
      receiverChannels: [...matrix.receiverChannels, "Ho165Di"],
      matrix: [...matrix.matrix.map((row) => [...row, 0.01]), [...matrix.sourceChannels.map(() => 0), 1]],
    };
    const result = runCompensationScreen(simulated.data, wider);
    expect(result.pairs.some(({ source, receiver }) => source === "Ho165Di" || receiver === "Ho165Di")).toBe(false);
  });
});

describe("the value to stage", () => {
  const simulated = simulatePanel();

  it("is the floor's slope for a coefficient that is missing, and staging it settles the pair", () => {
    const lacking = withCoefficient(TRUE_SPILL, "Nd143Di", "Tb159Di", 0);
    const read = pair(runCompensationScreen(simulated.data, matrixFrom(lacking)), "Nd143Di", "Tb159Di");
    const value = suggestedCoefficient(read)!;
    expect(value).toBe(read.floor!.slope);
    expect(value).toBeGreaterThan(0.008);
    expect(value).toBeLessThanOrEqual(0.0102);
    const staged = runCompensationScreen(simulated.data, matrixFrom(withCoefficient(TRUE_SPILL, "Nd143Di", "Tb159Di", value)));
    expect(pair(staged, "Nd143Di", "Tb159Di").verdict).toBe("consistent");
  });

  it("is the upper bound for a coefficient above the data, and staging it settles the pair", () => {
    const high = withCoefficient(TRUE_SPILL, "Nd145Di", "Dy161Di", 0.036);
    const read = pair(runCompensationScreen(simulated.data, matrixFrom(high)), "Nd145Di", "Dy161Di");
    const value = suggestedCoefficient(read)!;
    expect(value).toBe(read.floor!.upperBound);
    const staged = runCompensationScreen(simulated.data, matrixFrom(withCoefficient(TRUE_SPILL, "Nd145Di", "Dy161Di", value)));
    expect(pair(staged, "Nd145Di", "Dy161Di").verdict).toBe("consistent");
  });

  it("is absent for a pair that asks for no attention", () => {
    const result = runCompensationScreen(simulated.data, matrixFrom(TRUE_SPILL));
    for (const read of result.pairs) expect(suggestedCoefficient(read)).toBeNull();
  });
});

describe("the events of a pair as fitted", () => {
  it("are the source's own signal and the receiver with the other sources' spillover taken off", () => {
    const simulated = simulatePanel({ events: 8_000 });
    const matrix = matrixFrom(TRUE_SPILL);
    // Nd145 receives 3% of Nd144; Dy161 receives only from Nd145.
    const events = screenPairEvents(simulated.data, matrix, "Nd145Di", "Dy161Di")!;
    const stored = simulated.data.values("Nd145Di")!;
    const neighbour = simulated.data.values("Nd144Di")!;
    const receiver = simulated.data.values("Dy161Di")!;
    for (const event of [0, 17, 4_000, 7_999]) {
      expect(events.source[event]).toBeCloseTo(stored[event] - 0.03 * neighbour[event], 9);
      expect(events.receiver[event]).toBeCloseTo(receiver[event], 9);
    }
    expect(screenPairEvents(simulated.data, matrix, "Ho165Di", "Dy161Di")).toBeNull();
  });
});
