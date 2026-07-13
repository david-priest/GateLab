// multiStrategy.ts — the Strategy tab's MULTI-POPULATION mode, ported from GateLabR
// compute_multi_pop_strategy (app.R:6674-6898) + render_multi_strategy_tab node/tick
// assembly (app.R:6900-7114), rendered by mini_plot.js renderMultiStrategyGrid.
//
// Several selected populations are laid out in a shared-hierarchy 2D grid:
//   • col = total gates applied root→parent (get_gate_depth) — shared ancestry aligns.
//   • row = DFS order of the selected populations (siblings sorted case-insensitively
//     by name), compacted to remove gaps.
// One node per distinct (parent_pop, x_channel, y_channel): it plots the PARENT events
// (in DISPLAY space) with every gate that its relevant children draw on those channels
// overlaid. Parent masks come from `masks` (derived.masks) — we do NOT re-run gating.
//
// Coordinate handling mirrors buildStrategyPayload / gatePayload exactly: masks/percentages
// run in GATING space (sample.gatingData()); plotted values + gate vertices + axis ranges
// are DISPLAY space; axis labels are the Panel display labels (sample.labelForKey).

import type { Sample } from "./sample";
import type { Gate, GateRef, Population, PopulationMap } from "./models";
import { getGateMask } from "./gates";
import type { AxisTicks } from "./ticks";
import { computeRangeFromValues, type StrategyFontSizes } from "./strategy";
import { displayLabelOffset } from "../plots/gatePayload";

const round1 = (x: number): number => Math.round(x * 10) / 10;

// ── Node payload shapes (final render form — display labels/vertices/ranges baked in) ──
export interface MultiStrategyGate {
  gate_id: string;
  name: string; // the child population's name (drawn as the gate label)
  gate_type: string;
  vertices: [number, number][]; // DISPLAY space (empty for quadrant gates → not drawn)
  color: string;
  label_offset: [number, number] | null; // DISPLAY space
  percent_of_parent: number | null;
  include: boolean;
}

export interface MultiStrategyNode {
  node_id: string; // "parent_id|x_ch|y_ch"
  parent_pop_id: string;
  parent_pop_name: string;
  x_channel: string; // DISPLAY LABEL (axis label; identity keys drive the math)
  y_channel: string; // DISPLAY LABEL
  row: number;
  col: number;
  n_events: number; // parent population size (pre-downsample)
  x_range: [number, number];
  y_range: [number, number];
  x: number[]; // parent events, display space, downsampled
  y: number[];
  gates: MultiStrategyGate[];
  x_is_logicle: boolean;
  x_logicle_ticks: AxisTicks | null;
  y_is_logicle: boolean;
  y_logicle_ticks: AxisTicks | null;
}

// ── Internal accumulation (gating-space vertices, channel keys) ──
interface RawEntry {
  gate_id: string;
  name: string;
  gate_type: string;
  vertices: [number, number][]; // GATING space
  color: string;
  label_offset: [number, number] | null;
  include: boolean;
}
interface RawNode {
  parent_id: string;
  x_channel: string; // key
  y_channel: string; // key
  gate_entries: RawEntry[];
}

export interface MultiStrategyComputeOptions {
  maxEvents: number; // 0/Infinity = all events
  globalScales: Record<string, [number, number]>;
}

/** Gating-space vertices for a gate (quadrant → none). Rectangles keep their stored corners. */
function gatingVertices(gate: Gate): [number, number][] {
  if (gate.gate_type === "quadrant") return [];
  return gate.vertices;
}

/** Display-space overlay vertices for a gate (rectangles → AABB corners), like strategy.ts. */
function displayVerticesOf(sample: Sample, xCh: string, yCh: string, gate: Gate): [number, number][] {
  if (gate.gate_type === "quadrant") return [];
  const toD = (vx: number, vy: number): [number, number] => [
    sample.gatingToDisplay(xCh, vx),
    sample.gatingToDisplay(yCh, vy),
  ];
  if (gate.gate_type === "rectangle") {
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const [vx, vy] of gate.vertices) {
      if (vx < xmin) xmin = vx;
      if (vx > xmax) xmax = vx;
      if (vy < ymin) ymin = vy;
      if (vy > ymax) ymax = vy;
    }
    return [toD(xmin, ymin), toD(xmax, ymin), toD(xmax, ymax), toD(xmin, ymax)];
  }
  return gate.vertices.map(([vx, vy]) => toD(vx, vy));
}

/** Widen [lo,hi] to also cover the given coords (expand_range_for_vertices). */
function expandRange(r: [number, number], coords: number[]): [number, number] {
  let lo = r[0];
  let hi = r[1];
  for (const c of coords) {
    if (Number.isFinite(c)) {
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
  }
  return [lo, hi];
}

/**
 * Lay out gate-step plots for several selected populations in a shared 2D grid.
 * Ported faithfully from compute_multi_pop_strategy; parent masks come from `masks`.
 */
export function computeMultiPopStrategy(
  sample: Sample,
  gates: Record<string, Gate>,
  populations: PopulationMap,
  rootId: string,
  masks: Record<string, Uint8Array>,
  selectedPopIds: string[],
  opts: MultiStrategyComputeOptions,
): MultiStrategyNode[] {
  const n = sample.fcs.nEvents;
  if (selectedPopIds.length === 0 || n === 0) return [];
  const useAll = !Number.isFinite(opts.maxEvents) || opts.maxEvents <= 0;
  const cap = opts.maxEvents;

  // ── Relevant pops = selected + all their ancestors up to (and including) root ──
  const relevant = new Set<string>();
  for (const selId of selectedPopIds) {
    if (!(selId in populations)) continue;
    let cur: string | null = selId;
    while (cur) {
      relevant.add(cur);
      if (cur === rootId) break;
      const parent: string | null = populations[cur]?.parent_id ?? null;
      if (parent === null) break;
      cur = parent;
    }
  }

  // ── Raw node map: key = "parent_id|x_ch|y_ch"; collects gate overlays per node ──
  const nodesRaw = new Map<string, RawNode>();
  for (const popId of relevant) {
    if (popId === rootId) continue;
    const pop = populations[popId];
    if (!pop) continue;
    const parentId = pop.parent_id;
    if (parentId === null) continue;
    if (!relevant.has(parentId) && parentId !== rootId) continue;
    for (const ref of pop.gate_refs ?? ([] as GateRef[])) {
      const gate = gates[ref.gate_id];
      if (!gate) continue;
      const nodeKey = `${parentId}|${gate.x_channel}|${gate.y_channel}`;
      let node = nodesRaw.get(nodeKey);
      if (!node) {
        node = { parent_id: parentId, x_channel: gate.x_channel, y_channel: gate.y_channel, gate_entries: [] };
        nodesRaw.set(nodeKey, node);
      }
      if (node.gate_entries.some((g) => g.gate_id === ref.gate_id)) continue; // dedup within node
      node.gate_entries.push({
        gate_id: ref.gate_id,
        name: pop.name || popId,
        gate_type: gate.gate_type,
        vertices: gatingVertices(gate),
        color: gate.color,
        label_offset: gate.label_offset,
        include: ref.include,
      });
    }
  }
  if (nodesRaw.size === 0) return [];

  // ── col = total gates applied from root to reach parent_id's events ──
  const getGateDepth = (popId: string): number => {
    if (popId === rootId) return 0;
    let depth = 0;
    let cur: string | null = popId;
    while (cur && cur !== rootId) {
      const pp: Population | undefined = populations[cur];
      if (!pp) break;
      depth += (pp.gate_refs ?? []).length;
      cur = pp.parent_id;
    }
    return depth;
  };

  // ── row = DFS order of selected pops (siblings sorted case-insensitively by name) ──
  const orderedSelected: string[] = [];
  const selectedSet = new Set(selectedPopIds);
  const visited = new Set<string>();
  const visitPop = (pid: string): void => {
    if (visited.has(pid)) return;
    visited.add(pid);
    if (selectedSet.has(pid)) orderedSelected.push(pid);
    let children = Object.keys(populations).filter((cid) => (populations[cid].parent_id ?? "") === pid);
    if (children.length > 1) {
      children = children.sort((a, b) => {
        const na = (populations[a].name || a).toLowerCase();
        const nb = (populations[b].name || b).toLowerCase();
        return na < nb ? -1 : na > nb ? 1 : 0;
      });
    }
    for (const child of children) if (relevant.has(child)) visitPop(child);
  };
  visitPop(rootId);
  const ordered = orderedSelected.length > 0 ? orderedSelected : selectedPopIds.slice();

  const selRow = new Map<string, number>();
  ordered.forEach((pid, i) => selRow.set(pid, i));

  // A pop's row: its own selected-row, else the min row of any selected descendant, else 0.
  const getPopRow = (popId: string): number => {
    const own = selRow.get(popId);
    if (own !== undefined) return own;
    const descRows: number[] = [];
    for (const [sid, r] of selRow) {
      let cur: string | null = sid;
      while (cur) {
        if (cur === popId) { descRows.push(r); break; }
        cur = populations[cur]?.parent_id ?? null;
      }
    }
    return descRows.length > 0 ? Math.min(...descRows) : 0;
  };

  // ── Compact rows (remove gaps) ──
  const rawRows = [...nodesRaw.values()].map((nr) => getPopRow(nr.parent_id));
  const uniqueRows = [...new Set(rawRows)].sort((a, b) => a - b);
  const rowMap = new Map<number, number>();
  uniqueRows.forEach((r, i) => rowMap.set(r, i));

  const data = sample.gatingData();

  // ── Build result nodes with event data + ranges + ticks ──
  const result: MultiStrategyNode[] = [];
  for (const [nodeKey, nr] of nodesRaw) {
    const parentId = nr.parent_id;
    const parentPop = populations[parentId];

    const parentMask = parentId === rootId ? null : masks[parentId];
    // root → all events; others → their derived mask.
    let nTotal = 0;
    if (parentId === rootId) {
      nTotal = n;
    } else {
      if (!parentMask) continue;
      for (let i = 0; i < parentMask.length; i++) if (parentMask[i]) nTotal++;
      if (nTotal === 0) continue;
    }

    const xCh = nr.x_channel;
    const yCh = nr.y_channel;
    const xIdx = sample.index(xCh);
    const yIdx = sample.index(yCh);
    if (xIdx === undefined || yIdx === undefined) continue;

    // Parent event indices, evenly downsampled (round(seq(1, N, length.out = cap))).
    const parentIdx: number[] = [];
    if (parentId === rootId) {
      for (let i = 0; i < n; i++) parentIdx.push(i);
    } else {
      for (let i = 0; i < parentMask!.length; i++) if (parentMask![i]) parentIdx.push(i);
    }
    let sampleIdx = parentIdx;
    if (!useAll && parentIdx.length > cap) {
      sampleIdx = new Array(cap);
      const denom = cap > 1 ? cap - 1 : 1;
      for (let k = 0; k < cap; k++) sampleIdx[k] = parentIdx[Math.round((k * (parentIdx.length - 1)) / denom)];
    }

    const xCol = sample.displayColumn(xIdx);
    const yCol = sample.displayColumn(yIdx);
    const xVals = sampleIdx.map((i) => xCol[i]);
    const yVals = sampleIdx.map((i) => yCol[i]);

    // Base range: global-scale override, else R's per-node data-driven zoom — computed from THIS
    // node's downsampled parent values (app.R:6817), not the channel's full display range — then
    // expanded for gate geometry. (Behavioural change: multi-pop panels now frame each node's own
    // data rather than sharing one global axis.)
    let xRange: [number, number] = opts.globalScales[xCh] ?? computeRangeFromValues(xVals);
    let yRange: [number, number] = opts.globalScales[yCh] ?? computeRangeFromValues(yVals);

    const gatesOut: MultiStrategyGate[] = [];
    for (const ge of nr.gate_entries) {
      const gateDef = gates[ge.gate_id];
      // percent_of_parent: gate mask ∩ parent mask (include vs exclude), like the R.
      let pct: number | null = null;
      if (gateDef && nTotal > 0) {
        const gm = getGateMask(gateDef, data);
        let nChild = 0;
        if (parentId === rootId) {
          for (let i = 0; i < gm.length; i++) {
            const pass = ge.include ? gm[i] : gm[i] ? 0 : 1;
            if (pass) nChild++;
          }
        } else {
          for (let i = 0; i < gm.length; i++) {
            if (!parentMask![i]) continue;
            const pass = ge.include ? gm[i] : gm[i] ? 0 : 1;
            if (pass) nChild++;
          }
        }
        pct = round1((nChild / nTotal) * 100);
      }

      const displayVerts = gateDef
        ? displayVerticesOf(sample, xCh, yCh, gateDef)
        : ge.vertices.map(([vx, vy]): [number, number] => [
            sample.gatingToDisplay(xCh, vx),
            sample.gatingToDisplay(yCh, vy),
          ]);

      // Expand axis ranges to keep gate boundaries (and an explicit label) visible.
      if (displayVerts.length > 0) {
        xRange = expandRange(xRange, displayVerts.map((v) => v[0]));
        yRange = expandRange(yRange, displayVerts.map((v) => v[1]));
        const lo = ge.label_offset; // only expand for a user-set offset (matches R)
        if (lo) {
          const cx = displayVerts.reduce((s, v) => s + v[0], 0) / displayVerts.length;
          const cy = displayVerts.reduce((s, v) => s + v[1], 0) / displayVerts.length;
          const ox = Number(lo[0]);
          const oy = Number(lo[1]);
          if (Number.isFinite(ox) && Number.isFinite(cx)) xRange = expandRange(xRange, [cx + ox]);
          if (Number.isFinite(oy) && Number.isFinite(cy)) yRange = expandRange(yRange, [cy + oy]);
        }
      }

      gatesOut.push({
        gate_id: ge.gate_id,
        name: ge.name,
        gate_type: ge.gate_type,
        vertices: displayVerts,
        color: ge.color,
        // Same label position as the main plot: user offset, else auto "above the gate".
        label_offset: ge.label_offset ?? displayLabelOffset(displayVerts),
        percent_of_parent: pct,
        include: ge.include,
      });
    }

    const rawRow = getPopRow(parentId);
    const compactRow = rowMap.get(rawRow) ?? rawRow;

    // Ticks depend on the (expanded) visible range — same as buildStrategyPayload.
    const xTicks = sample.channelTicks(xIdx, xRange);
    const yTicks = sample.channelTicks(yIdx, yRange);

    result.push({
      node_id: nodeKey,
      parent_pop_id: parentId,
      parent_pop_name: parentPop?.name ?? parentId,
      x_channel: sample.labelForKey(xCh),
      y_channel: sample.labelForKey(yCh),
      row: compactRow,
      col: getGateDepth(parentId),
      n_events: nTotal,
      x_range: xRange,
      y_range: yRange,
      x: xVals,
      y: yVals,
      gates: gatesOut,
      x_is_logicle: xTicks !== null,
      x_logicle_ticks: xTicks,
      y_is_logicle: yTicks !== null,
      y_logicle_ticks: yTicks,
    });
  }

  // ── Resolve (row, col) collisions ──────────────────────────────────────────
  // When a parent has children gated on different channel pairs, all those nodes
  // share a (row, col) (both depend only on parent_id). Walk each row in col order
  // and bump duplicate cols to the next free slot (tie-break by node_id → stable).
  if (result.length > 1) {
    const byRow = new Map<number, MultiStrategyNode[]>();
    for (const nd of result) {
      const arr = byRow.get(nd.row);
      if (arr) arr.push(nd);
      else byRow.set(nd.row, [nd]);
    }
    for (const arr of byRow.values()) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => a.col - b.col || (a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0));
      let prevCol = -1;
      for (const nd of arr) {
        const newCol = Math.max(nd.col, prevCol + 1);
        nd.col = newCol;
        prevCol = newCol;
      }
    }
  }

  return result;
}

// ── renderMultiStrategyGrid payload assembly ────────────────────────────────
export interface MultiStrategyPayloadOptions {
  displayMode: string;
  plotSize: number;
  contourThreshold: number;
  pointAlpha: number;
  pointSize: number;
  kdeBandwidth: number;
  pubStyle: boolean; // black gates, no label background
  gateLineWidth: number;
  fontSizes: StrategyFontSizes;
  contextTitle?: string;
}

/** Assemble the object passed to CytofMiniPlot.renderMultiStrategyGrid. */
export function buildMultiStrategyPayload(
  nodes: MultiStrategyNode[],
  opts: MultiStrategyPayloadOptions,
): Record<string, unknown> {
  const titleFs = Math.max(8, Math.min(24, (opts.fontSizes.title || 10) + 1));
  return {
    containerId: "strategy-grid-container",
    nodes,
    strategy_context_title: opts.contextTitle,
    strategy_context_title_font: titleFs,
    display_mode: opts.displayMode,
    plot_size: opts.plotSize,
    contour_threshold: opts.contourThreshold,
    point_alpha: opts.pointAlpha,
    point_size: opts.pointSize,
    kde_bandwidth: opts.kdeBandwidth,
    font_sizes: opts.fontSizes,
    gate_style: { pub_style: opts.pubStyle, line_width: opts.gateLineWidth },
  };
}
