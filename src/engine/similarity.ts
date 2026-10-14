// similarity.ts — how far each cell is from a few cells picked by eye, over chosen channels, so a
// wall can be sorted by likeness to them and a range of the most alike made a population (FlowJo's
// Find Similar Images is a nearest-neighbour search on chosen parameters with no spatial term; this
// is the same idea). Each channel is standardised by its median and MAD over the candidates, so a
// wide channel does not drown a narrow one; a cell's score is its mean distance to its k nearest
// picked cells, 0 for a picked cell. Pure, and small enough to run on every imaged event at once.

export interface SimilarityColumn {
  readonly values: ArrayLike<number>;
}

export interface SimilarityOptions {
  /** Nearest picked cells averaged; 3 by default, or every pick when fewer. */
  readonly k?: number;
}

function median(sorted: Float64Array): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * Standardise each column over the candidates: (v − median) / MAD, with a MAD of 0 widened to
 * the column's interquartile spread, and a column with no spread at all left out (weight 0).
 */
export function standardiseOverCandidates(columns: readonly SimilarityColumn[], candidates: ArrayLike<number>): { scale: Float64Array; centre: Float64Array } {
  const centre = new Float64Array(columns.length);
  const scale = new Float64Array(columns.length);
  const buf = new Float64Array(candidates.length);
  columns.forEach((column, c) => {
    let n = 0;
    for (let i = 0; i < candidates.length; i++) {
      const v = column.values[candidates[i]];
      if (Number.isFinite(v)) buf[n++] = v;
    }
    const sorted = buf.subarray(0, n).slice().sort();
    const m = median(sorted);
    centre[c] = Number.isFinite(m) ? m : 0;
    for (let i = 0; i < n; i++) sorted[i] = Math.abs(sorted[i] - centre[c]);
    sorted.sort();
    let mad = median(sorted) * 1.4826;
    if (!(mad > 0) && n > 1) {
      const dev = buf.subarray(0, n).slice().sort();
      mad = (dev[Math.floor(0.75 * (n - 1))] - dev[Math.floor(0.25 * (n - 1))]) / 1.349;
    }
    scale[c] = mad > 0 ? 1 / mad : 0;
  });
  return { centre, scale };
}

/**
 * The mean standardised Euclidean distance from each candidate to its k nearest picked cells; NaN
 * for an event that is not a candidate, 0 for a picked cell. `n` is the file's event count.
 */
export function similarityScores(
  columns: readonly SimilarityColumn[],
  picks: ArrayLike<number>,
  candidates: ArrayLike<number>,
  n: number,
  options: SimilarityOptions = {},
): Float32Array {
  const out = new Float32Array(n).fill(NaN);
  const m = picks.length;
  if (m === 0 || columns.length === 0) return out;
  const k = Math.max(1, Math.min(options.k ?? 3, m));
  const { centre, scale } = standardiseOverCandidates(columns, candidates);
  const used: number[] = [];
  for (let c = 0; c < columns.length; c++) if (scale[c] > 0) used.push(c);
  if (used.length === 0) return out;
  // The picks, standardised once.
  const seed = new Float64Array(m * used.length);
  for (let p = 0; p < m; p++) {
    for (let u = 0; u < used.length; u++) {
      const c = used[u];
      const v = columns[c].values[picks[p]];
      seed[p * used.length + u] = Number.isFinite(v) ? (v - centre[c]) * scale[c] : 0;
    }
  }
  const picked = new Set<number>();
  for (let p = 0; p < m; p++) picked.add(picks[p]);
  const point = new Float64Array(used.length);
  const nearest = new Float64Array(k);
  for (let i = 0; i < candidates.length; i++) {
    const e = candidates[i];
    if (picked.has(e)) { out[e] = 0; continue; }
    for (let u = 0; u < used.length; u++) {
      const c = used[u];
      const v = columns[c].values[e];
      point[u] = Number.isFinite(v) ? (v - centre[c]) * scale[c] : 0;
    }
    nearest.fill(Infinity);
    for (let p = 0; p < m; p++) {
      let d2 = 0;
      const base = p * used.length;
      for (let u = 0; u < used.length; u++) { const diff = point[u] - seed[base + u]; d2 += diff * diff; }
      // Keep the k smallest.
      if (d2 < nearest[k - 1]) {
        let j = k - 1;
        while (j > 0 && nearest[j - 1] > d2) { nearest[j] = nearest[j - 1]; j--; }
        nearest[j] = d2;
      }
    }
    let sum = 0;
    for (let j = 0; j < k; j++) sum += Math.sqrt(nearest[j]);
    out[e] = sum / k;
  }
  return out;
}
