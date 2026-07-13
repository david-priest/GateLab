// ticks.ts — display-space axis ticks for logicle (flow signal) and scatter (FSC/SSC)
// channels, so fluorophore axes read as FlowJo-style decade labels (0, 100, 1K, 10K, …)
// instead of the raw display-space numbers.
//
// Ported 1:1 from GateLabR (inst/app/R/fcs_import.R):
//   • generate_logicle_ticks  → logicleTicks   (tick_mode "logicle")
//   • generate_scatter_ticks  → scatterTicks   (tick_mode "scatter_log10")
// CyTOF metal + QC channels return NULL (D3's default linear ticks — matches
// generate_channel_ticks in app.R, which deliberately does NOT decade-label CyTOF asinh).
//
// KEY: positions are produced by the CHANNEL'S OWN forward transform, so they land in
// GateLab's [0,1] logicle display space (flowutils convention) rather than GateLabR's
// flowCore [0, M=4.5] space — i.e. they line up with the plotted points, no rescaling.

export interface AxisTicks {
  major_pos: number[];
  major_labels: string[];
  minor_pos: number[];
  tick_mode: "logicle" | "scatter_log10";
}

type Fwd = (raw: number) => number; // raw → display
type Inv = (disp: number) => number; // display → raw

/** R seq(from, to, by = ±1): ascending if to >= from, else descending. Inclusive. */
function rSeq(from: number, to: number): number[] {
  const out: number[] = [];
  if (to >= from) for (let i = from; i <= to; i++) out.push(i);
  else for (let i = from; i >= to; i--) out.push(i);
  return out;
}

const uniqSort = (xs: number[]): number[] =>
  Array.from(new Set(xs)).sort((a, b) => a - b);

/** Drop float noise for clean power-of-ten labels ("100", "1.5", "10"). */
const trimNum = (x: number): string => String(Math.round(x * 1e6) / 1e6);

/** R signif(x, digits) → shortest string. */
const signif = (x: number, digits: number): string =>
  trimNum(Number(x.toPrecision(digits)));

// generate_logicle_ticks fmt_label: sign + K/M abbreviation of the RAW value.
function fmtLogicleLabel(v: number): string {
  const a = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (a === 0) return "0";
  if (a >= 1e6) return s + trimNum(a / 1e6) + "M";
  if (a >= 1e3) return s + trimNum(a / 1e3) + "K";
  return s + trimNum(a);
}

// generate_scatter_ticks fmt_label: signif-rounded K/M abbreviation.
function fmtScatterLabel(v: number): string {
  const a = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (a < 1e-9) return "0";
  if (a >= 1e6) return s + signif(a / 1e6, 3) + "M";
  if (a >= 1e3) return s + signif(a / 1e3, 3) + "K";
  if (a >= 1) return s + String(Math.round(a));
  return s + signif(a, 2);
}

/**
 * Flow-signal (logicle) axis ticks — decade majors (…,-1K,-100,0,100,1K,10K,…) with
 * 2–9× minors, all forward-transformed into display space and clipped to [lo, hi].
 * `tVal` is the channel's logicle T (used as the fallback raw range at the edges).
 */
export function logicleTicks(
  forward: Fwd,
  inverse: Inv,
  axisRange: [number, number],
  tVal: number,
): AxisTicks | null {
  try {
    const lo = axisRange[0];
    const hi = axisRange[1];
    let rawLo = inverse(lo);
    let rawHi = inverse(hi);
    if (!Number.isFinite(rawLo)) rawLo = -tVal;
    if (!Number.isFinite(rawHi)) rawHi = tVal;

    // Cap the decade span at ~2 above the channel's T so an out-of-domain display value (a stale or
    // foreign global scale, e.g. hi beyond the logicle top) can't extrapolate the inverse to absurd
    // decades (the "…000000M" / ~1e19 tick blow-up). T bounds the real data scale.
    const tExp = Number.isFinite(tVal) && tVal > 0 ? Math.ceil(Math.log10(tVal)) : 6;
    const maxPosExp = Math.min(Math.ceil(Math.log10(Math.max(rawHi, 100))), tExp + 2);
    let minNegExp = rawLo < -1 ? Math.ceil(Math.log10(Math.abs(rawLo))) : 2;
    minNegExp = Math.min(minNegExp, 5); // up to -100K on the negative side

    const posDecades = rSeq(2, maxPosExp).map((e) => Math.pow(10, e)); // 100 … raw_hi
    const negDecades = rSeq(2, minNegExp).map((e) => -Math.pow(10, e));

    const majorRaw = uniqSort([...negDecades, 0, ...posDecades]);

    // Minor ticks: full 2–9 multipliers per decade (proper log spacing).
    let minorRaw: number[] = [];
    for (const d of posDecades) for (let m = 2; m <= 9; m++) minorRaw.push(d * m);
    for (const d of negDecades.map(Math.abs)) for (let m = 2; m <= 9; m++) minorRaw.push(-(d * m));
    const majorSet = new Set(majorRaw);
    minorRaw = uniqSort(minorRaw).filter((x) => !majorSet.has(x));

    const majorPos: number[] = [];
    const majorLabels: string[] = [];
    for (const raw of majorRaw) {
      const d = forward(raw);
      if (Number.isFinite(d) && d >= lo && d <= hi) {
        majorPos.push(d);
        majorLabels.push(fmtLogicleLabel(raw));
      }
    }
    const minorPos: number[] = [];
    for (const raw of minorRaw) {
      const d = forward(raw);
      if (Number.isFinite(d) && d >= lo && d <= hi) minorPos.push(d);
    }
    return { major_pos: majorPos, major_labels: majorLabels, minor_pos: minorPos, tick_mode: "logicle" };
  } catch {
    return null;
  }
}

/**
 * Scatter (FSC/SSC) axis ticks — displayed in asinh(raw/cofactor) space, labelled with
 * canonical log decades in raw units (1K, 10K, 100K). Majors at 10^n, minors at 2–9×10^n.
 */
export function scatterTicks(
  forward: Fwd,
  inverse: Inv,
  axisRange: [number, number],
  cofactor: number,
): AxisTicks | null {
  try {
    let cf = cofactor;
    if (!Number.isFinite(cf) || cf <= 0) cf = 150;
    const lo = axisRange[0];
    const hi = axisRange[1];
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;

    const rawLo = inverse(lo);
    const rawHi = inverse(hi);
    const rawMin = Math.min(rawLo, rawHi);
    const rawMax = Math.max(rawLo, rawHi);

    const decadesInRange = (vmin: number, vmax: number): number[] => {
      if (!Number.isFinite(vmin) || !Number.isFinite(vmax) || vmax <= 0) return [];
      const eLo = Math.floor(Math.log10(Math.max(vmin, 1e-9)));
      const eHi = Math.ceil(Math.log10(vmax));
      return rSeq(eLo, eHi);
    };

    let posMaj: number[] = [];
    let posMin: number[] = [];
    let negMaj: number[] = [];
    let negMin: number[] = [];

    if (rawMax > 0) {
      // If the range includes zero, start around the linear-to-log transition scale.
      let posFloor = rawMin > 0 ? rawMin : cf / 10;
      posFloor = Math.max(posFloor, 1e-9);
      const exps = decadesInRange(posFloor, rawMax);
      if (exps.length) {
        const pow = exps.map((e) => Math.pow(10, e));
        posMaj = pow;
        for (const p of pow) for (let m = 2; m <= 9; m++) posMin.push(m * p);
      }
    }
    if (rawMin < 0) {
      const negAbsMax = Math.abs(rawMin);
      let negAbsFloor = rawMax < 0 ? Math.abs(rawMax) : cf / 10;
      negAbsFloor = Math.max(negAbsFloor, 1e-9);
      const exps = decadesInRange(negAbsFloor, negAbsMax);
      if (exps.length) {
        const pow = exps.map((e) => Math.pow(10, e));
        negMaj = pow.map((p) => -p);
        for (const p of pow) for (let m = 2; m <= 9; m++) negMin.push(-(m * p));
      }
    }

    const spansZero = rawMin <= 0 && rawMax >= 0;
    let majorRaw = uniqSort([...negMaj, ...(spansZero ? [0] : []), ...posMaj]).filter(
      (x) => x >= rawMin && x <= rawMax && Number.isFinite(x),
    );
    const majorSet = new Set(majorRaw);
    const minorRaw = uniqSort([...negMin, ...posMin]).filter(
      (x) => x >= rawMin && x <= rawMax && Number.isFinite(x) && !majorSet.has(x),
    );
    if (majorRaw.length === 0 && spansZero) majorRaw = [0];

    return {
      major_pos: majorRaw.map(forward),
      major_labels: majorRaw.map(fmtScatterLabel),
      minor_pos: minorRaw.map(forward),
      tick_mode: "scatter_log10",
    };
  } catch {
    return null;
  }
}
