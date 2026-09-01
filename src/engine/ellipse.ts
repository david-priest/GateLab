// Ellipse gate geometry. The gate stores the Gating-ML form — mean, covariance, distanceSquare —
// and everything here derives from it, so there is exactly one representation and no axis/angle
// state that could drift from it.

import type { EllipseGate } from "./models";

/**
 * Eigen-decomposition of the symmetric 2×2 covariance, as the ellipse's principal axes.
 *
 * Returns the half-axis LENGTHS for the boundary at the gate's distanceSquare (Gating-ML defines
 * the boundary as (p−μ)ᵀ Σ⁻¹ (p−μ) = D², so a principal half-axis is √(λ·D²)) and the rotation
 * of the major axis, which is also what Cytobank's definition JSON wants (major/minor/angle).
 */
export function ellipseAxes(g: EllipseGate): { major: number; minor: number; angle: number } {
  return axesFromCovariance(g.covariance, g.distance_square);
}

/** The same decomposition for a covariance that is not attached to a gate. */
export function axesFromCovariance(
  cov: [[number, number], [number, number]], distanceSquare: number,
): { major: number; minor: number; angle: number } {
  const [[a, b], [, c]] = cov;
  const tr = a + c;
  const det = a * c - b * b;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc; // larger eigenvalue
  const l2 = tr / 2 - disc;
  const angle = Math.abs(b) < 1e-300 ? (a >= c ? 0 : Math.PI / 2) : Math.atan2(l1 - a, b);
  return {
    major: Math.sqrt(Math.max(0, l1 * distanceSquare)),
    minor: Math.sqrt(Math.max(0, l2 * distanceSquare)),
    angle,
  };
}

/**
 * The inverse of axesFromCovariance: Σ = R·diag(major²/D², minor²/D²)·Rᵀ, so that the boundary
 * at the given distanceSquare has exactly these half-axes. axesFromCovariance ∘ this is the
 * identity (up to the angle's π ambiguity), and the round trip is pinned in tests — it is what
 * makes handle edits lossless.
 */
export function covarianceFromAxes(
  major: number, minor: number, angle: number, distanceSquare: number,
): [[number, number], [number, number]] {
  const l1 = (major * major) / distanceSquare;
  const l2 = (minor * minor) / distanceSquare;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  return [
    [l1 * ca * ca + l2 * sa * sa, (l1 - l2) * ca * sa],
    [(l1 - l2) * ca * sa, l1 * sa * sa + l2 * ca * ca],
  ];
}

/**
 * The boundary sampled as a closed ring in the gate's own space.
 *
 * This is how an ellipse participates in every vertex-shaped pipeline — axis fitting, display
 * outlines, the plot payload — without those pipelines learning any ellipse mathematics: they
 * receive a polygon that IS the boundary to sampling resolution, and the existing outline
 * machinery then bends it through display transforms exactly as it bends any polygon.
 */
export function ellipseBoundary(g: EllipseGate, n = 64): [number, number][] {
  const { major, minor, angle } = ellipseAxes(g);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const px = major * Math.cos(t);
    const py = minor * Math.sin(t);
    out.push([g.mean[0] + px * ca - py * sa, g.mean[1] + px * sa + py * ca]);
  }
  return out;
}

/**
 * Membership, vectorised by the caller: the quadratic form (p−μ)ᵀ Σ⁻¹ (p−μ) ≤ D².
 *
 * Returns the three inverse coefficients so the per-event loop is three multiplies — Σ⁻¹ for a
 * symmetric 2×2 is closed-form. A degenerate covariance (det ≤ 0) admits no interior and every
 * event is outside, which is the safe failure for a malformed file.
 */
export function ellipseQuadraticForm(
  g: EllipseGate,
): { ia: number; ib: number; ic: number; valid: boolean } {
  const [[a, b], [, c]] = g.covariance;
  const det = a * c - b * b;
  if (!(det > 0) || !Number.isFinite(det)) return { ia: 0, ib: 0, ic: 0, valid: false };
  return { ia: c / det, ib: -b / det, ic: a / det, valid: true };
}
