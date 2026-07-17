// compensation.ts — fluorescence spillover compensation, ported 1:1 from GateLabR
// fcs_import.R (.extract_display_spillover + compensate_matrix).
//
// Compensation is applied to RAW (linear) fluorescence values before any display transform,
// exactly as flowCore does: X_fluor := X_fluor · solve(S). Scatter / QC / unmatched columns
// pass through untouched. An identity spillover (already-compensated / spectral-unmixed
// export) is treated as "no compensation".

import {
  FlowCompensationError,
  prepareFlowCompensation,
} from "./flowCompensationEngine";

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

/**
 * Compatibility wrapper returning an LU-derived inverse. Null for malformed, singular, or
 * numerically unsafe matrices. New preview/Apply code should use flowCompensationEngine so it
 * also receives the stability and reconstruction diagnostics.
 */
export function invertMatrix(m: number[][]): number[][] | null {
  try {
    return prepareFlowCompensation(m).inverse.map((row) => Array.from(row));
  } catch (error) {
    if (error instanceof FlowCompensationError) return null;
    throw error;
  }
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
