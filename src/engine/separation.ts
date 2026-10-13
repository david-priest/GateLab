// separation.ts — which pair of channels best separates two classes of events on a biplot. Every
// pair is scored by how well a straight line through the biplot divides the classes: Fisher's
// discriminant direction for the pair (pooled covariance), the events projected onto it, and the
// area under the ROC curve of that projection (a rank statistic, so scale-free and robust to
// outliers; 0.5 is no separation, 1 is complete). Each channel alone is scored the same way, so a
// pair's gain over its better axis is visible. Values are taken in display space, the space a gate
// is drawn in. Thousands of events and a few hundred channels take a fraction of a second.

export interface SeparationColumn {
  readonly label: string;
  /** Display-space values, one per event. */
  readonly values: Float32Array;
  readonly kind: "detector" | "feature" | "other";
  /** The channel's index in the sample, for setting the axes. */
  readonly index: number;
}

export interface PairScore {
  readonly i: number;
  readonly j: number;
  /** AUC of the pair's discriminant projection, 0.5 to 1. */
  readonly auc: number;
  /** AUC of each axis alone. */
  readonly aucI: number;
  readonly aucJ: number;
}

export interface SeparationOptions {
  /** How many pairs to return; 8 by default. */
  readonly top?: number;
  /** Score only detector channels, the ones a sorter gates on without images. */
  readonly detectorsOnly?: boolean;
  /** At most this many events of each class are used, taken evenly; 2000 by default. */
  readonly maxEvents?: number;
}

/** Events of a class, thinned evenly to the cap. */
function membersOf(mask: Uint8Array, cap: number): Int32Array {
  let total = 0;
  for (let e = 0; e < mask.length; e++) if (mask[e]) total++;
  const take = Math.min(total, cap);
  const out = new Int32Array(take);
  if (take === 0) return out;
  const stride = total / take;
  let seen = 0;
  let next = 0;
  let k = 0;
  for (let e = 0; e < mask.length && k < take; e++) {
    if (!mask[e]) continue;
    if (seen >= next) { out[k++] = e; next += stride; }
    seen++;
  }
  return out;
}

/** AUC of scores for class A against class B, by the Mann–Whitney U with average ranks for ties. */
export function aucOf(scoresA: Float64Array, scoresB: Float64Array): number {
  const nA = scoresA.length;
  const nB = scoresB.length;
  if (nA === 0 || nB === 0) return 0.5;
  const n = nA + nB;
  const order = new Int32Array(n);
  const all = new Float64Array(n);
  all.set(scoresA);
  all.set(scoresB, nA);
  for (let k = 0; k < n; k++) order[k] = k;
  order.sort((a, b) => all[a] - all[b]);
  let rankSumA = 0;
  let k = 0;
  while (k < n) {
    let end = k;
    while (end + 1 < n && all[order[end + 1]] === all[order[k]]) end++;
    const rank = (k + end) / 2 + 1;
    for (let m = k; m <= end; m++) if (order[m] < nA) rankSumA += rank;
    k = end + 1;
  }
  const u = rankSumA - (nA * (nA + 1)) / 2;
  const auc = u / (nA * nB);
  return Math.max(auc, 1 - auc);
}

const finiteOnly = (values: Float32Array, members: Int32Array): Float64Array => {
  const out = new Float64Array(members.length);
  let k = 0;
  for (const e of members) { const v = values[e]; if (Number.isFinite(v)) out[k++] = v; }
  return out.subarray(0, k);
};

/** Fisher's direction for two channels and the projections of both classes onto it. */
function projectPair(xA: Float64Array, yA: Float64Array, xB: Float64Array, yB: Float64Array): [Float64Array, Float64Array] {
  const mean = (v: Float64Array) => { let s = 0; for (const x of v) s += x; return v.length ? s / v.length : 0; };
  const mxA = mean(xA), myA = mean(yA), mxB = mean(xB), myB = mean(yB);
  let sxx = 0, sxy = 0, syy = 0;
  const nA = Math.min(xA.length, yA.length), nB = Math.min(xB.length, yB.length);
  for (let k = 0; k < nA; k++) { const dx = xA[k] - mxA, dy = yA[k] - myA; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  for (let k = 0; k < nB; k++) { const dx = xB[k] - mxB, dy = yB[k] - myB; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const dof = Math.max(1, nA + nB - 2);
  sxx /= dof; sxy /= dof; syy /= dof;
  // A ridge keeps a degenerate pair (a constant channel, or two copies of one) from blowing up.
  const ridge = 1e-9 * (sxx + syy) + 1e-12;
  sxx += ridge; syy += ridge;
  const det = sxx * syy - sxy * sxy;
  const dmx = mxA - mxB, dmy = myA - myB;
  const wx = (syy * dmx - sxy * dmy) / det;
  const wy = (-sxy * dmx + sxx * dmy) / det;
  const project = (xs: Float64Array, ys: Float64Array, n: number) => {
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) out[k] = wx * xs[k] + wy * ys[k];
    return out;
  };
  return [project(xA, yA, nA), project(xB, yB, nB)];
}

/** Both classes' values of a column, finite only, aligned by event so a pair shares its rows. */
function alignedValues(columns: readonly SeparationColumn[], members: Int32Array): Float64Array[] {
  return columns.map((c) => {
    const out = new Float64Array(members.length);
    for (let k = 0; k < members.length; k++) out[k] = c.values[members[k]];
    return out;
  });
}

export function rankSeparatingPairs(
  columns: readonly SeparationColumn[],
  inA: Uint8Array,
  inB: Uint8Array,
  options: SeparationOptions = {},
): PairScore[] {
  const top = options.top ?? 8;
  const cap = options.maxEvents ?? 2000;
  const used = columns.map((c, i) => ({ c, i })).filter(({ c }) => !options.detectorsOnly || c.kind === "detector");
  if (used.length < 2) return [];
  const membersA = membersOf(inA, cap);
  const membersB = membersOf(inB, cap);
  if (membersA.length < 2 || membersB.length < 2) return [];
  const valuesA = alignedValues(used.map((u) => u.c), membersA);
  const valuesB = alignedValues(used.map((u) => u.c), membersB);
  // Rows where any of a pair's values is not finite are dropped per pair; singles likewise.
  const single = used.map((_, a) => aucOf(finiteOnly(used[a].c.values, membersA), finiteOnly(used[a].c.values, membersB)));
  const scores: PairScore[] = [];
  for (let a = 0; a < used.length; a++) {
    for (let b = a + 1; b < used.length; b++) {
      const keepA: number[] = [];
      for (let k = 0; k < membersA.length; k++) if (Number.isFinite(valuesA[a][k]) && Number.isFinite(valuesA[b][k])) keepA.push(k);
      const keepB: number[] = [];
      for (let k = 0; k < membersB.length; k++) if (Number.isFinite(valuesB[a][k]) && Number.isFinite(valuesB[b][k])) keepB.push(k);
      if (keepA.length < 2 || keepB.length < 2) continue;
      const pick = (src: Float64Array, keep: number[]) => Float64Array.from(keep, (k) => src[k]);
      const [pA, pB] = projectPair(pick(valuesA[a], keepA), pick(valuesA[b], keepA), pick(valuesB[a], keepB), pick(valuesB[b], keepB));
      const auc = aucOf(pA, pB);
      scores.push({ i: used[a].i, j: used[b].i, auc: Math.max(auc, single[a], single[b]), aucI: single[a], aucJ: single[b] });
    }
  }
  scores.sort((p, q) => q.auc - p.auc || (q.aucI + q.aucJ) - (p.aucI + p.aucJ));
  return scores.slice(0, top);
}
