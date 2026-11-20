// syntheticControls.fixture.ts — compensation controls simulated from a known spillover matrix.
//
// Each event has a true signal per fluorochrome (zero for a negative event); what is measured in
// channel j is the sum over fluorochromes of signal × S[i][j], plus the particle's own background
// in that channel, electronic noise, and photon noise that grows with the square root of the
// signal. Seeded, so every test reads the same events.

import type { ControlChannel, ControlFile } from "./controlFile";

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededNormal(random: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

export const PANEL = ["FITC-A", "PE-A", "PE-Cy7-A", "APC-A", "BV421-A", "BV510-A"] as const;

/** Rows source, columns receiver, in PANEL order. */
export const TRUE_SPILLOVER: number[][] = [
  [1, 0.12, 0.01, 0, 0, 0.03],
  [0.02, 1, 0.08, 0, 0, 0],
  [0, 0.015, 1, 0.04, 0, 0],
  [0, 0, 0.06, 1, 0, 0],
  [0, 0, 0, 0, 1, 0.25],
  [0.05, 0, 0, 0, 0.09, 1],
];

export interface Particle {
  /** Median background per channel. */
  readonly background: readonly number[];
  /** Median forward and side scatter. */
  readonly scatter: readonly [number, number];
}

export const BEADS: Particle = { background: [60, 50, 30, 40, 80, 70], scatter: [60_000, 40_000] };
export const CELLS: Particle = { background: [250, 120, 40, 60, 400, 500], scatter: [110_000, 25_000] };

export interface Stain {
  /** Index into the panel. */
  readonly fluor: number;
  /** Fraction of events positive. */
  readonly fraction: number;
  /** Median true signal of a positive event. */
  readonly brightness: number;
  /** Spread of the positive signal (SD of its natural log); 0.08 is a bead peak, 0.6 a cell population. */
  readonly spread?: number;
}

export interface SyntheticOptions {
  readonly id: string;
  readonly fileName?: string;
  readonly labels?: readonly string[];
  readonly stains?: readonly Stain[];
  readonly events?: number;
  readonly particle?: Particle;
  readonly seed?: number;
  readonly spillover?: readonly (readonly number[])[];
  readonly panel?: readonly string[];
  readonly markers?: readonly (string | null)[];
  readonly range?: number;
  /** Detector voltage per channel, as $PnV would record it. */
  readonly voltages?: readonly (number | null)[];
  readonly cytometer?: string | null;
  readonly acquired?: string | null;
}

export interface SyntheticFile extends ControlFile {
  /** Per stain, one byte per event: non-zero where the event is positive for it. */
  readonly positive: readonly Uint8Array[];
  readonly columns: readonly Float32Array[];
}

export function syntheticControl(options: SyntheticOptions): SyntheticFile {
  const panel = options.panel ?? PANEL;
  const spillover = options.spillover ?? TRUE_SPILLOVER;
  const particle = options.particle ?? BEADS;
  const stains = options.stains ?? [];
  const n = options.events ?? 5000;
  const range = options.range ?? 262144;
  const random = seededRandom(options.seed ?? 1);
  const normal = seededNormal(random);
  const columns = panel.map(() => new Float32Array(n));
  const forward = new Float32Array(n);
  const side = new Float32Array(n);
  const positive = stains.map(() => new Uint8Array(n));

  for (let event = 0; event < n; event++) {
    const signal = panel.map(() => 0);
    stains.forEach((stain, s) => {
      if (random() >= stain.fraction) return;
      positive[s][event] = 1;
      signal[stain.fluor] += stain.brightness * Math.exp((stain.spread ?? 0.08) * normal());
    });
    panel.forEach((_, j) => {
      let light = particle.background[j] * Math.exp(0.25 * normal());
      for (let i = 0; i < panel.length; i++) light += signal[i] * spillover[i][j];
      const measured = light + Math.sqrt(Math.max(light, 0)) * normal() + 15 * normal();
      columns[j][event] = Math.min(measured, range - 1);
    });
    forward[event] = particle.scatter[0] * (1 + 0.08 * normal());
    side[event] = particle.scatter[1] * (1 + 0.08 * normal());
  }

  const channels: ControlChannel[] = panel.map((pnn, j) => {
    const marker = options.markers?.[j] ?? null;
    return { key: marker ?? pnn, pnn, marker, range, voltage: options.voltages?.[j] ?? null, gain: null };
  });
  const indexByKey = new Map(channels.map((channel, j) => [channel.pnn, j]));
  return {
    id: options.id,
    fileName: options.fileName ?? `${options.id}.fcs`,
    labels: options.labels ?? [],
    eventCount: n,
    channels,
    values: (key) => {
      const j = indexByKey.get(key);
      return j === undefined ? null : columns[j];
    },
    scatter: { forward, side },
    cytometer: options.cytometer ?? null,
    acquired: options.acquired ?? null,
    positive,
    columns,
  };
}

/** A bead control for one fluorochrome: half the beads positive, in a tight peak. */
export function beadControl(fluor: number, options: Partial<SyntheticOptions> & { id: string }): SyntheticFile {
  return syntheticControl({
    stains: [{ fluor, fraction: 0.5, brightness: 40_000, spread: 0.08 }],
    particle: BEADS,
    seed: 100 + fluor,
    ...options,
  });
}

/** A cell control for one fluorochrome: a fraction of the cells positive, in a broad population. */
export function cellControl(
  fluor: number,
  options: Partial<SyntheticOptions> & { id: string },
  fraction = 0.3,
): SyntheticFile {
  return syntheticControl({
    stains: [{ fluor, fraction, brightness: 20_000, spread: 0.5 }],
    particle: CELLS,
    seed: 200 + fluor,
    ...options,
  });
}
