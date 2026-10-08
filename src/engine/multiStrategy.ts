// multiStrategy.ts — the Strategy tab's MULTI-POPULATION mode, ported from GateLabR
// compute_multi_pop_strategy (app.R:6674-6898) + render_multi_strategy_tab node/tick
// assembly (app.R:6900-7114), rendered by mini_plot.js renderMultiStrategyGrid.
//
// Several selected populations are laid out in a shared-hierarchy 2D grid:
//   • col = total gates applied root→parent (get_gate_depth) — shared ancestry aligns.
//   • row = DFS order of the selected populations (using their persisted sibling
//     order), compacted to remove gaps.
// One node per distinct (parent_pop, x_channel, y_channel): it plots the PARENT events
// (in DISPLAY space) with every gate that its relevant children draw on those channels
// overlaid. Parent masks come from `masks` (derived.masks) — we do NOT re-run gating.
//
// Coordinate handling mirrors buildStrategyPayload / gatePayload exactly: masks/percentages
// run in each GATE's own space (sample.gateAssayData()); plotted values + gate vertices + axis ranges
// are DISPLAY space; axis labels are the Panel display labels (sample.labelForKey).
//
// The layout (multiStrategyLayout: nodes, counts, parent event indices) and the drawing of a
// node (finishMultiStrategyNode) are exported apart, so pooledStrategy.ts can draw one grid
// from several files' events.

import type { Sample } from "./sample";
import { ellipseBoundary } from "./ellipse";
import type { GateEdgeMode } from "../ui/gateEdgeModes";
import type { Gate, GateRef, Population, PopulationMap } from "./models";
import { columnsForGate, getGateMask } from "./gates";
import type { AxisTicks } from "./ticks";
import { computeRangeFromValues, thinEvenly, type StrategyFontSizes } from "./strategy";
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
  /** The gate holds a label offset the user set; only such a label may sit past the panel's axes. */
  label_placed?: boolean;
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
export interface RawEntry {
  gate_id: string;
  name: string; // the child population's name (drawn as the gate label)
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

/** A gate of a laid-out node: its entry, its definition when the tree still has it, and its count within the parent. */
export interface MultiStrategyLayoutGate {
  entry: RawEntry;
  gateDef: Gate | undefined;
  /** Events of the parent inside the gate (outside, for an excluding ref); null without a definition. */
  nChild: number | null;
}

/** A node laid out and counted, before its parent events are thinned and drawn. */
export interface MultiStrategyLayoutNode {
  node_id: string; // "parent_id|x_ch|y_ch"
  parent_id: string;
  parent_name: string;
  x_channel: string; // key
  y_channel: string; // key
  row: number;
  col: number;
  /** The parent population's event indices, every one. */
  parentIdx: number[];
  n_total: number;
  gates: MultiStrategyLayoutGate[];
}

export interface MultiStrategyComputeOptions {
  maxEvents: number; // 0/Infinity = all events
  globalScales: Record<string, [number, number]>;
}

/** Gating-space vertices for a gate (quadrant → none). Rectangles keep their stored corners. */
function gatingVertices(gate: Gate): [number, number][] {
  if (gate.gate_type === "quadrant") return [];
  if (gate.gate_type === "ellipse") return ellipseBoundary(gate);
  return gate.vertices;
}

/** Display-space overlay vertices for a gate (rectangles → AABB corners), like strategy.ts. */
function displayVerticesOf(sample: Sample, xCh: string, yCh: string, gate: Gate): [number, number][] {
  if (gate.gate_type === "quadrant") return [];
  const toD = (vx: number, vy: number): [number, number] => [
    sample.gateToDisplay(gate, xCh, vx),
    sample.gateToDisplay(gate, yCh, vy),
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
  if (gate.gate_type === "ellipse") return ellipseBoundary(gate).map(([vx, vy]) => toD(vx, vy));
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
 * Lay out gate-step plots for several selected populations in a shared 2D grid, counted but
 * not yet drawn: one node per (parent population, channel pair) with the parent's event
 * indices, the gates its relevant children draw there and each gate's count within the parent.
 * Ported faithfully from compute_multi_pop_strategy; parent masks come from `masks`.
 */
export function multiStrategyLayout(
  sample: Sample,
  gates: Record<string, Gate>,
  populations: PopulationMap,
  rootId: string,
  masks: Record<string, Uint8Array>,
  selectedPopIds: readonly string[],
): MultiStrategyLayoutNode[] {
  const n = sample.fcs.nEvents;
  if (selectedPopIds.length === 0 || n === 0) return [];

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

  // ── row = DFS order of selected pops (using the persisted population order) ──
  const orderedSelected: string[] = [];
  const selectedSet = new Set(selectedPopIds);
  const visited = new Set<string>();
  const visitPop = (pid: string): void => {
    if (visited.has(pid)) return;
    visited.add(pid);
    if (selectedSet.has(pid)) orderedSelected.push(pid);
    const children = [...new Set(populations[pid]?.children ?? [])].filter(
      (cid) => populations[cid]?.parent_id === pid,
    );
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

  const data = sample.gateAssayData();

  // ── Build the nodes with their parent indices and gate counts ──
  const result: MultiStrategyLayoutNode[] = [];
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
    if (sample.index(xCh) === undefined || sample.index(yCh) === undefined) continue;

    const parentIdx: number[] = [];
    if (parentId === rootId) {
      for (let i = 0; i < n; i++) parentIdx.push(i);
    } else {
      for (let i = 0; i < parentMask!.length; i++) if (parentMask![i]) parentIdx.push(i);
    }

    const gatesOut: MultiStrategyLayoutGate[] = [];
    for (const ge of nr.gate_entries) {
      const gateDef = gates[ge.gate_id];
      // nChild: gate mask ∩ parent mask (include vs exclude), like the R.
      let nChild: number | null = null;
      if (gateDef && nTotal > 0) {
        const gm = getGateMask(gateDef, columnsForGate(data, gateDef));
        nChild = 0;
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
      }
      gatesOut.push({ entry: ge, gateDef, nChild });
    }

    const rawRow = getPopRow(parentId);
    const compactRow = rowMap.get(rawRow) ?? rawRow;

    result.push({
      node_id: nodeKey,
      parent_id: parentId,
      parent_name: parentPop?.name ?? parentId,
      x_channel: xCh,
      y_channel: yCh,
      row: compactRow,
      col: getGateDepth(parentId),
      parentIdx,
      n_total: nTotal,
      gates: gatesOut,
    });
  }

  // ── Resolve (row, col) collisions ──────────────────────────────────────────
  // When a parent has children gated on different channel pairs, all those nodes
  // share a (row, col) (both depend only on parent_id). Walk each row in col order
  // and bump duplicate cols to the next free slot (tie-break by node_id → stable).
  if (result.length > 1) {
    const byRow = new Map<number, MultiStrategyLayoutNode[]>();
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

/**
 * A node as drawn on `sample`'s display space: the parent events given, the ranges from the
 * global scale or those events, widened to keep each gate and an explicit label in view, and
 * the gates given with their percentages (a gate left out of `gates` is not drawn).
 */
export function finishMultiStrategyNode(
  sample: Sample,
  node: MultiStrategyLayoutNode,
  xVals: number[],
  yVals: number[],
  nEvents: number,
  gates: readonly { entry: RawEntry; gateDef: Gate | undefined; pct: number | null }[],
  globalScales: Record<string, [number, number]>,
): MultiStrategyNode {
  const xCh = node.x_channel;
  const yCh = node.y_channel;
  const xIdx = sample.index(xCh)!;
  const yIdx = sample.index(yCh)!;

  // Base range: global-scale override, else R's per-node data-driven zoom — computed from THIS
  // node's downsampled parent values (app.R:6817), not the channel's full display range — then
  // expanded for gate geometry. (Behavioural change: multi-pop panels now frame each node's own
  // data rather than sharing one global axis.)
  let xRange: [number, number] = globalScales[xCh] ?? computeRangeFromValues(xVals);
  let yRange: [number, number] = globalScales[yCh] ?? computeRangeFromValues(yVals);

  const gatesOut: MultiStrategyGate[] = [];
  for (const { entry: ge, gateDef, pct } of gates) {
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
      label_placed: ge.label_offset != null,
      percent_of_parent: pct,
      include: ge.include,
    });
  }

  // Ticks depend on the (expanded) visible range — same as buildStrategyPayload.
  const xTicks = sample.channelTicks(xIdx, xRange);
  const yTicks = sample.channelTicks(yIdx, yRange);

  return {
    node_id: node.node_id,
    parent_pop_id: node.parent_id,
    parent_pop_name: node.parent_name,
    x_channel: sample.labelForKey(xCh),
    y_channel: sample.labelForKey(yCh),
    row: node.row,
    col: node.col,
    n_events: nEvents,
    x_range: xRange,
    y_range: yRange,
    x: xVals,
    y: yVals,
    gates: gatesOut,
    x_is_logicle: xTicks !== null,
    x_logicle_ticks: xTicks,
    y_is_logicle: yTicks !== null,
    y_logicle_ticks: yTicks,
  };
}

/**
 * Lay out gate-step plots for several selected populations in a shared 2D grid, drawn from
 * one file: each node's parent events evenly downsampled to the cap (round(seq(1, N,
 * length.out = cap))), and each gate labelled with its share of the parent.
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
  return multiStrategyLayout(sample, gates, populations, rootId, masks, selectedPopIds).map((node) => {
    const sampleIdx = thinEvenly(node.parentIdx, opts.maxEvents);
    const xCol = sample.displayColumn(sample.index(node.x_channel)!);
    const yCol = sample.displayColumn(sample.index(node.y_channel)!);
    return finishMultiStrategyNode(
      sample,
      node,
      sampleIdx.map((i) => xCol[i]),
      sampleIdx.map((i) => yCol[i]),
      node.n_total,
      node.gates.map(({ entry, gateDef, nChild }) => ({
        entry,
        gateDef,
        pct: nChild === null ? null : round1((nChild / node.n_total) * 100),
      })),
      opts.globalScales,
    );
  });
}

// ── renderMultiStrategyGrid payload assembly ────────────────────────────────
export interface MultiStrategyPayloadOptions {
  displayMode: string;
  plotSize: number;
  contourThreshold: number;
  pointAlpha: number;
  densityColorPower: number;
  pointSize: number;
  kdeBandwidth: number;
  pubStyle: boolean; // black gates, no label background
  gateLineWidth: number;
  gateEdgeMode?: GateEdgeMode;
  /** What a gate's label says; the renderer reads it as gate_style.label_format. */
  gateLabelFormat?: string;
  /** Contour lines per panel; the renderer's default when absent. */
  contourLevels?: number;
  /** Gate labels in bold. */
  gateLabelBold?: boolean;
  /** Under publication style, a white backing behind each label at this opacity (0 none … 1). */
  labelBackground?: number;
  /** The gap between the grid's cells, px; the renderer's 8 when absent. */
  gridGap?: number;
  /** Canvas pixels per CSS pixel for every panel; the display's ratio when absent. */
  canvasScale?: number;
  /**
   * Called when a gate's label is dragged on a panel, with the label's new offset from the
   * gate in the panel's display units (and the quadrant for a quadrant gate); offering it is
   * what makes the labels draggable. Carried to the renderer as gate_style.on_label_move.
   */
  onLabelMove?: (gateId: string, offset: [number, number], quadrant?: number) => void;
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
    contour_levels: opts.contourLevels,
    grid_gap: opts.gridGap,
    canvas_scale: opts.canvasScale,
    point_alpha: opts.pointAlpha,
    density_color_power: opts.densityColorPower,
    point_size: opts.pointSize,
    kde_bandwidth: opts.kdeBandwidth,
    font_sizes: opts.fontSizes,
    gate_style: {
      pub_style: opts.pubStyle,
      line_width: opts.gateLineWidth,
      gate_edge_mode: opts.gateEdgeMode ?? "straight-bow",
      label_format: opts.gateLabelFormat ?? "name-percent",
      ...(opts.onLabelMove ? { on_label_move: opts.onLabelMove } : {}),
      ...(opts.gateLabelBold ? { label_weight: "bold" } : {}),
      ...(opts.labelBackground !== undefined ? { label_background: opts.labelBackground } : {}),
    },
  };
}

/** The panels a panel's gates lead to, in gate order; shared by the two layouts. */
function childPanelsOf(
  nodes: readonly MultiStrategyNode[],
  populations: Record<string, { parent_id: string | null; gate_refs: { gate_id: string }[] }>,
): (node: MultiStrategyNode) => MultiStrategyNode[] {
  const panelsOf = new Map<string, MultiStrategyNode[]>();
  for (const node of nodes) panelsOf.set(node.parent_pop_id, [...(panelsOf.get(node.parent_pop_id) ?? []), node]);
  const childrenOf = new Map<string, { popId: string; gateIds: Set<string> }[]>();
  for (const [popId, pop] of Object.entries(populations)) {
    if (!pop.parent_id) continue;
    childrenOf.set(pop.parent_id, [...(childrenOf.get(pop.parent_id) ?? []), { popId, gateIds: new Set(pop.gate_refs.map((ref) => ref.gate_id)) }]);
  }
  return (node) => {
    const out: MultiStrategyNode[] = [];
    for (const gate of node.gates) {
      for (const child of childrenOf.get(node.parent_pop_id) ?? []) {
        if (!child.gateIds.has(gate.gate_id)) continue;
        for (const panel of panelsOf.get(child.popId) ?? []) if (panel !== node && !out.includes(panel)) out.push(panel);
      }
    }
    return out;
  };
}

/**
 * The nodes laid out as a tidy tree: a column per depth; a panel's first child shares its row and
 * each later child's subtree starts below the previous one's, so a subtree is a block of rows and
 * the grid has one row per leaf; a population drawn on a second channel pair stacks under its
 * first rather than taking a column of its own. Compact in both directions where the layout of
 * a column per depth and a row per traced population left most cells empty. Returns new node
 * objects with their row and col set; the input is left alone.
 */
export function tidyLayout(
  nodes: readonly MultiStrategyNode[],
  populations: Record<string, { parent_id: string | null; gate_refs: { gate_id: string }[] }>,
): MultiStrategyNode[] {
  const childPanels = childPanelsOf(nodes, populations);
  const isChild = new Set<MultiStrategyNode>();
  for (const node of nodes) for (const child of childPanels(node)) isChild.add(child);
  const placed = new Map<MultiStrategyNode, { row: number; col: number }>();
  const heights = new Map<MultiStrategyNode, number>();
  const height = (node: MultiStrategyNode, trail: Set<MultiStrategyNode>): number => {
    const known = heights.get(node);
    if (known !== undefined) return known;
    if (trail.has(node)) return 1;
    trail.add(node);
    let total = 0;
    for (const child of childPanels(node)) if (!placed.has(child)) total += height(child, trail);
    trail.delete(node);
    const h = Math.max(1, total);
    heights.set(node, h);
    return h;
  };
  const place = (node: MultiStrategyNode, row: number, col: number) => {
    if (placed.has(node)) return;
    placed.set(node, { row, col });
    let r = row;
    for (const child of childPanels(node)) {
      if (placed.has(child)) continue;
      place(child, r, col + 1);
      r += height(child, new Set());
    }
  };
  let cursor = 0;
  const roots = nodes.filter((node) => !isChild.has(node));
  for (const root of [...roots, ...nodes]) {
    if (placed.has(root)) continue;
    place(root, cursor, 0);
    cursor += height(root, new Set());
  }
  return nodes.map((node) => ({ ...node, ...placed.get(node)! }));
}

/**
 * The nodes laid out as a wrapped sequence: the tree walked depth first (a panel, then the panels
 * of the populations its gates make, in gate order), the walk filled into rows of `columns`
 * panels, left to right and top to bottom. Compact where the tree layout (a column per depth, a
 * row per traced population) leaves most of the grid empty; the arrows say what leads to what.
 * Returns new node objects with their row and col set; the input is left alone.
 */
export function flowLayout(
  nodes: readonly MultiStrategyNode[],
  columns: number,
  populations: Record<string, { parent_id: string | null; gate_refs: { gate_id: string }[] }>,
): MultiStrategyNode[] {
  const perRow = Math.max(1, Math.floor(columns) || 1);
  const childPanels = childPanelsOf(nodes, populations);
  const isChild = new Set<MultiStrategyNode>();
  for (const node of nodes) for (const child of childPanels(node)) isChild.add(child);
  const order: MultiStrategyNode[] = [];
  const seen = new Set<MultiStrategyNode>();
  const visit = (node: MultiStrategyNode) => {
    if (seen.has(node)) return;
    seen.add(node);
    order.push(node);
    for (const child of childPanels(node)) visit(child);
  };
  for (const node of nodes) if (!isChild.has(node)) visit(node);
  for (const node of nodes) visit(node); // anything left (a cycle, or a panel whose parent is not drawn)
  return order.map((node, index) => ({ ...node, row: Math.floor(index / perRow), col: index % perRow }));
}
