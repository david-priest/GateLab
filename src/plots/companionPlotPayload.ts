// companionPlotPayload.ts — what one of the Gating tab's other plots draws.
//
// The Gating tab can show up to four plots. One is selected: it is the plot App has always
// built, with its colouring, control underlay, tailoring references and editing. The others are
// looked at while the selected one is worked on, and this builds each of them: the events of the
// view's population on the view's channels, from the viewed file or the pooled files, and the
// gates defined on those channels with their counts in that population. Nothing here changes a
// gate, a mask or a count; every number comes from the engine function the selected plot uses.

import { branchScopedGateOrder } from "../engine/branchGates";
import { encodeFloat32Base64 } from "../engine/encode";
import type { Gate, PopulationMap } from "../engine/models";
import {
  aggregateGateCounts,
  buildCombinedSamplePointCloud,
  buildWorkspaceAxisRanges,
  type CombinedSamplePlotInput,
  type PooledGateCountInput,
} from "../engine/multiSamplePlot";
import { computeGateCounts } from "../engine/populations";
import type { DisplayMode, Sample } from "../engine/sample";
import { derivePopulationDisplaySelection, type CoreState, type GatingDerived } from "../store";
import { buildPlotGates, type GateCountScope, type PlotGate } from "./gatePayload";
import { GATE_INK, inkedForDisplay } from "./gateInk";

/** What a plot shows: a population, the channels it is drawn on, and whether it is the one-channel histogram of X. */
export interface CompanionPlotView {
  populationId: string | null;
  /** The populations shown together with it, as a multi-selection in the tree leaves them; usually none. */
  selectedPopulationIds: readonly string[];
  xKey: string;
  yKey: string;
  histogram: boolean;
  /** The plot's own selected gate, kept while another plot is selected; drawn selected. */
  selectedGateId?: string | null;
  /** The gates ticked with it in the gate list, as a multi-selection leaves them. */
  selectedGateIds?: readonly string[];
}

/** A file whose events the plot pools, with its gating when that has been computed. */
export interface CompanionPoolFile {
  id: string;
  name: string;
  sample: Sample;
  gating: GatingDerived | null;
}

export interface CompanionPlotLook {
  mode: DisplayMode;
  /** 0 or less draws every event. */
  maxEvents: number;
  contourThreshold: number;
  contourLevels: number;
  pointAlpha: number;
  pointSize: number;
  densityColorPower: number;
  gateEdgeMode: string;
  colouredGates: boolean;
  gateLineWidth: number;
  gateLabelBackground: number;
}

export interface CompanionPlotInput {
  view: CompanionPlotView;
  /** The viewed file: its channels, transforms and gates are the plot's. */
  file: { id: string; name: string; sample: Sample; gating: GatingDerived };
  /** The tree: only its gates, populations and their order are read. */
  state: Pick<CoreState, "gates" | "gate_order" | "populations" | "root_population_id">;
  /** The gates as the viewed file draws them (its own or its group's coordinates where it has them). */
  drawnGates: Record<string, Gate>;
  branchGatesOnly: boolean;
  showUnownedGates: boolean;
  /** The workspace's range per channel, where one is set. */
  globalScales: Readonly<Record<string, [number, number]>>;
  /**
   * The files the plot pools, when the Gating tab is pooling; null when it shows the viewed file
   * alone. Only files drawn in the same coordinates belong here (the caller applies the Gating
   * tab's own rule: same scale context, same panel).
   */
  pool: readonly CompanionPoolFile[] | null;
  /** The note a pooled count carries on a gate label, as the selected plot words it. */
  countScope: (kind: "pooled" | "viewed-file", fileCount: number) => GateCountScope;
  look: CompanionPlotLook;
}

export interface CompanionPlot {
  /** The object the gating plot's engine draws. */
  payload: Record<string, unknown>;
  /** The gates of a histogram view: the ranges on its channel. */
  gates: PlotGate[];
  /** Events in the view's population, over the files drawn. */
  populationEvents: number;
  /** The population's name, or the names joined when several are shown together. */
  title: string;
}

function countMask(mask: Uint8Array | null, length: number): number {
  if (!mask) return length;
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

/** The view's population in this tree: itself while it exists, else the root. */
function viewState(input: CompanionPlotInput): CoreState {
  const { state, view } = input;
  const populationId = view.populationId && state.populations[view.populationId]
    ? view.populationId
    : state.root_population_id;
  return {
    ...(state as CoreState),
    active_population_id: populationId,
    selected_pop_ids: view.selectedPopulationIds.filter((id) => state.populations[id]),
  };
}

/** Null when the viewed file does not carry the view's channels. */
export function buildCompanionPlot(input: CompanionPlotInput): CompanionPlot | null {
  const { view, file, state, look } = input;
  const sample = file.sample;
  const xKey = view.xKey;
  const yKey = view.histogram ? view.xKey : view.yKey;
  const xIdx = sample.index(xKey);
  const yIdx = sample.index(yKey);
  if (xIdx === undefined || yIdx === undefined || !state.root_population_id) return null;

  const scoped = viewState(input);
  const populationId = scoped.active_population_id!;
  const selection = derivePopulationDisplaySelection(sample, scoped, file.gating);
  const cap = look.maxEvents <= 0 ? Infinity : look.maxEvents;

  // The files drawn, each with its own events of the population.
  const pooled = (input.pool ?? []).flatMap((entry) => {
    const xIndex = entry.sample.index(xKey);
    const yIndex = entry.sample.index(yKey);
    if (xIndex === undefined || yIndex === undefined) return [];
    const gating = entry.id === file.id ? file.gating : entry.gating;
    return [{ entry, gating, xIndex, yIndex }];
  });
  const everyFileGated = pooled.every(({ gating }) => gating !== null);

  // Counts: pooled over the files drawn once each is gated, else the viewed file's own.
  let counts: ReturnType<typeof computeGateCounts>;
  let scope: GateCountScope | null = null;
  if (input.pool && everyFileGated) {
    const inputs: PooledGateCountInput[] = pooled.map(({ entry, gating }) => ({
      gateMasks: gating!.gateMasks,
      activeMask: derivePopulationDisplaySelection(entry.sample, scoped, gating!).activeMask,
      eventCount: entry.sample.fcs.nEvents,
    }));
    counts = aggregateGateCounts(state.gates, inputs);
    scope = input.countScope("pooled", pooled.length);
  } else {
    counts = computeGateCounts(state.gates, selection.activeMask, sample.gateAssayData(), file.gating.gateMasks);
    if (input.pool) scope = input.countScope("viewed-file", pooled.length);
  }

  // Ranges: the workspace's where it has one, else the frame the Gating tab fits to the file.
  let xRange = input.globalScales[xKey] ?? null;
  let yRange = input.globalScales[yKey] ?? null;
  if (!xRange || !yRange) {
    const automatic = buildWorkspaceAxisRanges([{ id: file.id, name: file.name, sample, xIndex: xIdx, yIndex: yIdx, mask: null }]);
    xRange = xRange ?? automatic?.xRange ?? null;
    yRange = yRange ?? automatic?.yRange ?? null;
  }

  // The plot's own selected and ticked gates, as the selected plot scopes and draws its own.
  const selectedGateId = view.selectedGateId && state.gates[view.selectedGateId] ? view.selectedGateId : null;
  const tickedGateIds = (view.selectedGateIds ?? []).filter((id) => state.gates[id]);
  const fullOrder = state.gate_order.length ? state.gate_order : Object.keys(state.gates);
  const scopedOrder = input.branchGatesOnly
    ? branchScopedGateOrder(state.populations as PopulationMap, state.gates, state.gate_order, populationId, state.root_population_id, selectedGateId, input.showUnownedGates)
    : fullOrder;
  const shown = new Set(scopedOrder);
  const order = tickedGateIds.length ? fullOrder.filter((id) => shown.has(id) || tickedGateIds.includes(id)) : scopedOrder;
  const gates = buildPlotGates(sample, input.drawnGates, order, counts, xKey, yKey, scope, [xRange, yRange])
    // As on the selected plot: no space badge under a label.
    .map((gate) => ((gate as { space_badge?: string }).space_badge ? { ...gate, space_badge: undefined } : gate));

  const base = sample.plotPayload(
    xIdx,
    yIdx,
    look.mode,
    gates,
    selection.displayMask ?? selection.activeMask,
    selectedGateId,
    xRange,
    yRange,
    cap,
    look.contourThreshold,
    null,
  );

  let events: { x_b64: string; y_b64: string; n_events: number } | null = null;
  let populationEvents = countMask(selection.displayMask ?? selection.activeMask, sample.fcs.nEvents);
  if (input.pool) {
    // A file not gated yet contributes nothing until it is, as on the selected plot.
    const drawn = pooled.filter(({ gating }) => gating !== null);
    const inputs: CombinedSamplePlotInput[] = drawn.map(({ entry, gating, xIndex, yIndex }) => {
      const own = derivePopulationDisplaySelection(entry.sample, scoped, gating!);
      return { id: entry.id, name: entry.name, sample: entry.sample, xIndex, yIndex, mask: own.displayMask ?? own.activeMask };
    });
    const cloud = buildCombinedSamplePointCloud(inputs, cap);
    events = { x_b64: encodeFloat32Base64(cloud.x), y_b64: encodeFloat32Base64(cloud.y), n_events: cloud.eventCount };
    populationEvents = inputs.reduce((total, entry) => total + countMask(entry.mask, entry.sample.fcs.nEvents), 0);
  }

  const label = (key: string) => sample.labelForKey(key);
  const names = [populationId, ...scoped.selected_pop_ids.filter((id) => id !== populationId)]
    .map((id) => state.populations[id]?.name ?? id);
  const drawnGates = inkedForDisplay(base.gates as PlotGate[], look.colouredGates, GATE_INK);
  return {
    gates: view.histogram ? gates.filter((gate) => gate.gate_type === "rectangle") : gates,
    populationEvents,
    title: names.join(" + "),
    payload: {
      gate_edge_mode: look.gateEdgeMode,
      snap_to_gates: false,
      ...base,
      ...(events ?? {}),
      point_alpha: look.pointAlpha,
      point_size: look.pointSize,
      contour_levels: look.contourLevels,
      density_color_power: look.densityColorPower,
      color_labels: undefined,
      x_label: label(base.x_label),
      y_label: label(base.y_label),
      channels: base.channels.map(label),
      gates: drawnGates.map((gate) => ({ ...gate, x_channel: label(gate.x_channel), y_channel: label(gate.y_channel) })),
      gate_references: [],
      gate_line_width: look.gateLineWidth,
      gate_style: { pub_style: !look.colouredGates, label_background: look.gateLabelBackground },
    },
  };
}
