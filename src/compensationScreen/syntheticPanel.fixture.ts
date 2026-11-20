// syntheticPanel.fixture.ts — a stained mass-cytometry sample simulated from a known spillover matrix.
//
// Each event belongs to one population and has a true signal per channel: log-normal about the
// channel's level where the population carries the marker, a small background otherwise. What is
// counted in channel j is a Poisson draw about the event's own signal there plus, for every other
// channel i, its signal times S[i][j]; counts are written as a mass cytometer writes them (a
// count n spread over (n - 1, n], zero staying zero). Seeded, so every test reads the same events.

import { seededNormal, seededRandom } from "../compensationControls/syntheticControls.fixture";
import type { ScreenData, ScreenMatrix } from "./screenPairs";

export interface PanelChannel {
  readonly pnn: string;
  readonly marker: string | null;
  /** Median signal of a positive event, counts. */
  readonly level: number;
  /** The populations that carry the marker; "all" for a marker on every event. */
  readonly on: readonly string[] | "all";
}

/**
 * Populations P1, P2, P3 and a remainder. The pairs the tests read:
 *   Nd143 → Tb159  oxide, receiver's marker on other cells (a clean floor)
 *   Nd144 → Nd145  M+1, receiver's marker on the same cells (co-expression)
 *   Nd144 → Gd160  oxide, receiver's marker on every cell, unrelated to the source
 *   Nd145 → Dy161  oxide, receiver without an antibody
 *   Er167 → Er168  M+1, source too dim to read
 *   Yb171 → Yb172  M+1, receiver's marker on every source-bright cell
 *   Nd143 → Lu175  no physical route, markers on the same cells
 */
export const PANEL: readonly PanelChannel[] = [
  { pnn: "Nd143Di", marker: "143Nd_marker_a", level: 3000, on: ["P1"] },
  { pnn: "Nd144Di", marker: "144Nd_marker_b", level: 4000, on: ["P2"] },
  { pnn: "Nd145Di", marker: "145Nd_marker_c", level: 900, on: ["P2"] },
  { pnn: "Tb159Di", marker: "159Tb_marker_d", level: 600, on: ["P3"] },
  { pnn: "Gd160Di", marker: "160Gd_marker_e", level: 300, on: "all" },
  { pnn: "Dy161Di", marker: "161Dy", level: 0, on: [] },
  { pnn: "Er167Di", marker: "167Er_marker_f", level: 25, on: ["P3"] },
  { pnn: "Er168Di", marker: "168Er_marker_g", level: 400, on: ["P1"] },
  { pnn: "Yb171Di", marker: "171Yb_marker_h", level: 2500, on: ["P1"] },
  { pnn: "Yb172Di", marker: "172Yb_marker_i", level: 1500, on: ["P1"] },
  { pnn: "Lu175Di", marker: "175Lu_marker_j", level: 800, on: ["P1"] },
];

export const POPULATIONS: readonly Readonly<{ name: string; fraction: number }>[] = [
  { name: "P1", fraction: 0.25 },
  { name: "P2", fraction: 0.25 },
  { name: "P3", fraction: 0.2 },
  { name: "rest", fraction: 0.3 },
];

/** Source → receiver → coefficient: the spillover the simulated instrument has. */
export const TRUE_SPILL: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  Nd143Di: { Tb159Di: 0.01, Nd144Di: 0.02 },
  Nd144Di: { Nd145Di: 0.03, Gd160Di: 0.01, Nd143Di: 0.005 },
  Nd145Di: { Dy161Di: 0.012 },
  Er167Di: { Er168Di: 0.02 },
  Yb171Di: { Yb172Di: 0.005 },
};

export function matrixFrom(
  spill: Readonly<Record<string, Readonly<Record<string, number>>>>,
  panel: readonly PanelChannel[] = PANEL,
): ScreenMatrix {
  const channels = panel.map((channel) => channel.pnn);
  return {
    sourceChannels: channels,
    receiverChannels: channels,
    matrix: channels.map((source) => channels.map((receiver) =>
      source === receiver ? 1 : spill[source]?.[receiver] ?? 0)),
  };
}

/** A copy of `spill` with one coefficient replaced. */
export function withCoefficient(
  spill: Readonly<Record<string, Readonly<Record<string, number>>>>,
  source: string,
  receiver: string,
  value: number,
): Record<string, Record<string, number>> {
  const copy: Record<string, Record<string, number>> = {};
  for (const [key, row] of Object.entries(spill)) copy[key] = { ...row };
  copy[source] = { ...(copy[source] ?? {}), [receiver]: value };
  return copy;
}

function poisson(mean: number, random: () => number, normal: () => number): number {
  if (!(mean > 0)) return 0;
  if (mean > 40) return Math.max(0, Math.round(mean + Math.sqrt(mean) * normal()));
  const limit = Math.exp(-mean);
  let count = 0;
  let product = random();
  while (product > limit) {
    count++;
    product *= random();
  }
  return count;
}

export interface SimulatedPanel {
  readonly data: ScreenData;
  /** Add Poisson counts of mean `coefficient` × the source's true signal to a receiver: a spike-in. */
  spike(source: string, receiver: string, coefficient: number): ScreenData;
}

export function simulatePanel(options: Readonly<{
  events?: number;
  seed?: number;
  spill?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  panel?: readonly PanelChannel[];
}> = {}): SimulatedPanel {
  const events = options.events ?? 40_000;
  const panel = options.panel ?? PANEL;
  const spill = options.spill ?? TRUE_SPILL;
  const random = seededRandom(options.seed ?? 1);
  const normal = seededNormal(random);
  const signal = panel.map(() => new Float64Array(events));
  for (let event = 0; event < events; event++) {
    let draw = random();
    let population = POPULATIONS[POPULATIONS.length - 1].name;
    for (const candidate of POPULATIONS) {
      if (draw < candidate.fraction) { population = candidate.name; break; }
      draw -= candidate.fraction;
    }
    panel.forEach((channel, index) => {
      const positive = channel.level > 0 && (channel.on === "all" || channel.on.includes(population));
      signal[index][event] = positive
        ? channel.level * Math.exp(0.6 * normal())
        : 0.4 * Math.exp(0.5 * normal());
    });
  }
  const indexOf = new Map(panel.map((channel, index) => [channel.pnn, index]));
  const counted = (receiver: number, extra?: { source: number; coefficient: number }): Float64Array => {
    const values = new Float64Array(events);
    for (let event = 0; event < events; event++) {
      let mean = signal[receiver][event];
      for (const [source, row] of Object.entries(spill)) {
        const coefficient = row[panel[receiver].pnn];
        if (coefficient) mean += coefficient * signal[indexOf.get(source)!][event];
      }
      if (extra) mean += extra.coefficient * signal[extra.source][event];
      const count = poisson(mean, random, normal);
      values[event] = count === 0 ? 0 : count - random();
    }
    return values;
  };
  const columns = new Map(panel.map((channel, index) => [channel.pnn, counted(index)]));
  const dataWith = (map: Map<string, Float64Array>): ScreenData => ({
    eventCount: events,
    channels: panel.map((channel) => ({ pnn: channel.pnn, marker: channel.marker })),
    values: (pnn) => map.get(pnn) ?? null,
  });
  return {
    data: dataWith(columns),
    spike(source, receiver, coefficient) {
      const copy = new Map(columns);
      copy.set(receiver, counted(indexOf.get(receiver)!, { source: indexOf.get(source)!, coefficient }));
      return dataWith(copy);
    },
  };
}
