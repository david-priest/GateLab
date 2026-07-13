// compensation.ts — fluorescence spillover compensation, ported 1:1 from GateLabR
// fcs_import.R (.extract_display_spillover + compensate_matrix).
//
// Compensation is applied to RAW (linear) fluorescence values before any display transform,
// exactly as flowCore does: X_fluor := X_fluor · solve(S). Scatter / QC / unmatched columns
// pass through untouched. An identity spillover (already-compensated / spectral-unmixed
// export) is treated as "no compensation".

export interface DisplaySpillover {
  channels: string[]; // display-name fluorochrome channels (in matrix order)
  matrix: number[][]; // channels.length × channels.length
}

/**
 * Map a raw ($PnN-named) $SPILLOVER into display space and keep only fluorochrome channels.
 * Port of .extract_display_spillover. Returns null when there are <2 usable channels or the
 * matrix is effectively identity (nothing to compensate).
 */
export function extractDisplaySpillover(
  spill: { channels: string[]; matrix: number[][] } | null,
  pnnToKey: (pnn: string) => string | null,
  isScatter: (key: string) => boolean,
  isQc: (key: string) => boolean,
): DisplaySpillover | null {
  if (!spill || spill.channels.length < 2) return null;
  if (spill.matrix.length !== spill.channels.length) return null;

  const disp = spill.channels.map((pnn) => pnnToKey(pnn));
  const keepIdx: number[] = [];
  for (let i = 0; i < disp.length; i++) {
    const d = disp[i];
    if (d != null && !isScatter(d) && !isQc(d)) keepIdx.push(i);
  }
  if (keepIdx.length < 2) return null;

  const channels = keepIdx.map((i) => disp[i] as string);
  const matrix = keepIdx.map((i) => keepIdx.map((j) => spill.matrix[i][j]));

  // Identity (all off-diagonals ~0) → no-op.
  let offDiagZero = true;
  for (let i = 0; i < matrix.length && offDiagZero; i++) {
    for (let j = 0; j < matrix.length; j++) {
      if (i !== j && Math.abs(matrix[i][j]) >= 1e-8) { offDiagZero = false; break; }
    }
  }
  if (offDiagZero) return null;

  return { channels, matrix };
}

/** Invert a square matrix (Gauss–Jordan with partial pivoting). Null if singular. */
export function invertMatrix(m: number[][]): number[][] | null {
  const n = m.length;
  if (n === 0 || m.some((r) => r.length !== n)) return null;
  // augmented [m | I]
  const a = m.map((row, i) => [...row.map(Number), ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) return null; // singular
    if (piv !== col) { const t = a[col]; a[col] = a[piv]; a[piv] = t; }
    const d = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/**
 * Compensate fluorochrome columns: out[·,j] = Σ_k in[·,k] · inv[k,j]  (in · solve(S)).
 * `fluorColumns` are the raw columns in matrix (channel) order; returns new columns in the
 * same order. Port of compensate_matrix's `mat[,fl] %*% inv`.
 */
export function compensate(fluorColumns: ArrayLike<number>[], inv: number[][]): Float32Array[] {
  const p = fluorColumns.length;
  const n = fluorColumns[0]?.length ?? 0;
  const out = Array.from({ length: p }, () => new Float32Array(n));
  for (let e = 0; e < n; e++) {
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let k = 0; k < p; k++) s += fluorColumns[k][e] * inv[k][j];
      out[j][e] = s;
    }
  }
  return out;
}
