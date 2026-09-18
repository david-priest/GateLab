// hclust.ts — agglomerative clustering with average linkage (UPGMA), the default of
// seekit::plotExprHeatmap1 (hclust with "average" on Euclidean distances), for ordering the rows
// and columns of a summary heatmap and drawing their dendrograms. The inputs are small (tens of
// populations, tens of channels), so the plain O(n³) merge loop is the whole implementation.

export interface DendrogramNode {
  /** Leaf index for a leaf; -1 for a merge. */
  leaf: number;
  /** Merge height: the average distance between the two clusters joined. 0 for a leaf. */
  height: number;
  /** The leaves under this node, in drawing order. */
  leaves: number[];
  children?: [DendrogramNode, DendrogramNode];
}

export interface Clustering {
  /** Leaf indices in dendrogram order, left to right. */
  order: number[];
  root: DendrogramNode | null;
}

/** Euclidean distance over the dimensions both rows have, rescaled to the full dimension count. */
export function euclidean(a: readonly (number | null)[], b: readonly (number | null)[]): number {
  let sum = 0;
  let used = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    sum += (x - y) * (x - y);
    used++;
  }
  if (!used) return 0;
  return Math.sqrt((sum * a.length) / used);
}

/**
 * Cluster `n` items from a distance function. Ties are broken by the lower index pair, so the
 * result is deterministic for a given matrix; when two clusters merge, the one whose first leaf
 * comes first in the input stays on the left, which keeps the drawn order close to the input's.
 */
export function hclustAverage(n: number, distance: (i: number, j: number) => number): Clustering {
  if (n <= 0) return { order: [], root: null };
  const nodes: DendrogramNode[] = Array.from({ length: n }, (_, i) => ({ leaf: i, height: 0, leaves: [i] }));
  if (n === 1) return { order: [0], root: nodes[0] };
  // Distances between live clusters, keyed by their position in `nodes`.
  const d: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : distance(i, j))));
  const alive = new Set<number>(nodes.map((_, i) => i));
  while (alive.size > 1) {
    let best: [number, number] = [-1, -1];
    let bestD = Infinity;
    const ids = [...alive].sort((a, b) => a - b);
    for (let p = 0; p < ids.length; p++) {
      for (let q = p + 1; q < ids.length; q++) {
        const value = d[ids[p]][ids[q]];
        if (value < bestD) {
          bestD = value;
          best = [ids[p], ids[q]];
        }
      }
    }
    const [a, b] = best;
    const left = nodes[a].leaves[0] <= nodes[b].leaves[0] ? a : b;
    const right = left === a ? b : a;
    const merged: DendrogramNode = {
      leaf: -1,
      height: Number.isFinite(bestD) ? bestD : 0,
      leaves: [...nodes[left].leaves, ...nodes[right].leaves],
      children: [nodes[left], nodes[right]],
    };
    // Average linkage: the new cluster's distance to every other is the size-weighted mean.
    const na = nodes[a].leaves.length;
    const nb = nodes[b].leaves.length;
    const id = nodes.length;
    nodes.push(merged);
    d.push([]);
    for (const k of alive) {
      if (k === a || k === b) continue;
      const value = (na * d[a][k] + nb * d[b][k]) / (na + nb);
      d[id][k] = value;
      d[k][id] = value;
    }
    d[id][id] = 0;
    alive.delete(a);
    alive.delete(b);
    alive.add(id);
  }
  const root = nodes[[...alive][0]];
  return { order: [...root.leaves], root };
}

export interface DendrogramSegment {
  /** Position along the leaves' axis, in leaf units (0 = the first leaf's centre). */
  from: number;
  to: number;
  /** Heights of the two ends, in the dendrogram's distance units. */
  fromHeight: number;
  toHeight: number;
}

/**
 * The line segments of a dendrogram over leaves at positions 0, 1, 2, … in `order`: for each
 * merge, a vertical drop from each child to the merge height and a bar across between them.
 */
export function dendrogramSegments(root: DendrogramNode | null): { segments: DendrogramSegment[]; maxHeight: number } {
  const segments: DendrogramSegment[] = [];
  if (!root || !root.children) return { segments, maxHeight: 0 };
  const position = new Map<number, number>();
  root.leaves.forEach((leaf, index) => position.set(leaf, index));
  let maxHeight = 0;
  const centre = (node: DendrogramNode): number => {
    if (!node.children) return position.get(node.leaf) ?? 0;
    const [l, r] = node.children;
    return (centre(l) + centre(r)) / 2;
  };
  const walk = (node: DendrogramNode) => {
    if (!node.children) return;
    maxHeight = Math.max(maxHeight, node.height);
    const [l, r] = node.children;
    const cl = centre(l);
    const cr = centre(r);
    segments.push({ from: cl, to: cl, fromHeight: l.height, toHeight: node.height });
    segments.push({ from: cr, to: cr, fromHeight: r.height, toHeight: node.height });
    segments.push({ from: cl, to: cr, fromHeight: node.height, toHeight: node.height });
    walk(l);
    walk(r);
  };
  walk(root);
  return { segments, maxHeight };
}
