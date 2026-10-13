// pointIndex.ts — the nearest plotted point to a cursor. A uniform grid over the plotted points
// in display space, built once per payload (at most PLOT_CAP points, so a few milliseconds),
// answered in constant time per hover. The radius is anisotropic because the two axes have
// unrelated units: it is a circle in pixels, mapped to display units per axis by the caller.

export interface PointIndex {
  readonly size: number;
  /** The plotted point within the ellipse (rx, ry) of (x, y), nearest in that metric, or null. */
  nearest(x: number, y: number, rx: number, ry: number): number | null;
}

export interface PointIndexOptions {
  /** Grid cells per axis; 128 by default. */
  readonly cells?: number;
  /** Refuse to index more points than this (the "all events" plot cap); a million by default. */
  readonly maxPoints?: number;
  /** Only the points this accepts are indexed (those with an image); the rest are never found. */
  readonly include?: (k: number) => boolean;
}

/** Build the index, or null when there is nothing to index or too much. */
export function buildPointIndex(xd: Float32Array, yd: Float32Array, options: PointIndexOptions = {}): PointIndex | null {
  const n = Math.min(xd.length, yd.length);
  const maxPoints = options.maxPoints ?? 1_000_000;
  if (n === 0 || n > maxPoints) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xd[i];
    const y = yd[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const include = options.include;
  const cells = Math.max(1, Math.floor(options.cells ?? 128));
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const cellOf = (x: number, y: number): number => {
    const cx = Math.min(cells - 1, Math.max(0, Math.floor(((x - minX) / spanX) * cells)));
    const cy = Math.min(cells - 1, Math.max(0, Math.floor(((y - minY) / spanY) * cells)));
    return cy * cells + cx;
  };
  // Counting sort of the points into cells (CSR layout): cellStart[c]..cellStart[c+1] index `items`.
  const cellStart = new Int32Array(cells * cells + 1);
  const cellOfPoint = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const x = xd[i];
    const y = yd[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (include && !include(i)) continue;
    const c = cellOf(x, y);
    cellOfPoint[i] = c;
    cellStart[c + 1]++;
  }
  for (let c = 0; c < cells * cells; c++) cellStart[c + 1] += cellStart[c];
  const fill = cellStart.slice(0, cells * cells);
  const items = new Int32Array(cellStart[cells * cells]);
  for (let i = 0; i < n; i++) {
    const c = cellOfPoint[i];
    if (c < 0) continue;
    items[fill[c]++] = i;
  }
  const indexed = items.length;
  return {
    size: indexed,
    nearest(x, y, rx, ry) {
      if (!(rx > 0) || !(ry > 0)) return null;
      const cx0 = Math.max(0, Math.floor(((x - rx - minX) / spanX) * cells));
      const cx1 = Math.min(cells - 1, Math.floor(((x + rx - minX) / spanX) * cells));
      const cy0 = Math.max(0, Math.floor(((y - ry - minY) / spanY) * cells));
      const cy1 = Math.min(cells - 1, Math.floor(((y + ry - minY) / spanY) * cells));
      if (cx1 < 0 || cy1 < 0 || cx0 > cells - 1 || cy0 > cells - 1) return null;
      let best = -1;
      let bestD = 1;
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = cy * cells + cx;
          for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
            const i = items[k];
            const dx = (xd[i] - x) / rx;
            const dy = (yd[i] - y) / ry;
            const d = dx * dx + dy * dy;
            if (d <= bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      return best >= 0 ? best : null;
    },
  };
}
