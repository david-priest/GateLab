// protocol.ts — the messages between a GateLab tab and the relay an agent speaks through. The tab
// is the client of a WebSocket on this computer; it introduces itself with a hello, answers the
// relay's requests one by one, and tells it when the gating changed under it. Every number an
// agent reads is in the units the plot draws (display space) unless a field says otherwise, and
// every change it asks for goes through the app's own reducer. This file has no imports beyond
// types, so the relay can share it.

import type { GateProvenance, GateSpace, GateTransforms, RectangleBounds, TransformSpec, Vertex } from "../engine/models";
import type { AgentCommand } from "./commands";

export const AGENT_PROTOCOL_VERSION = 1 as const;

export interface AgentHostInfo {
  app: string;
  version: string;
  /** "browser": FCS files opened in the page. "sce": a SingleCellExperiment served by GateLabR. */
  host: "browser" | "sce";
  workspaceName: string | null;
}

/** The tab's first message after connecting. */
export interface AgentHello {
  kind: "hello";
  protocol: typeof AGENT_PROTOCOL_VERSION;
  info: AgentHostInfo;
}

/** The tab's word that the gating changed, by the user or by a command. */
export interface AgentChangedEvent {
  kind: "event";
  event: "changed";
  revision: number;
}

export type AgentMethod =
  | "describe"
  | "distribution"
  | "stats"
  | "preview"
  | "proposal"
  | "gatingTask"
  | "apply"
  | "view"
  | "render"
  | "memberships"
  | "workspace"
  | "reload";

export interface AgentRequest {
  kind: "request";
  id: string;
  method: AgentMethod;
  params?: unknown;
}

export interface AgentError {
  /** "refused": the command failed a check. "conflict": the revision moved. "failed": anything else. */
  code: "refused" | "conflict" | "failed" | "unknown-method";
  message: string;
  /** With "conflict": where the gating is now. */
  revision?: number;
}

export interface AgentResponse {
  kind: "response";
  id: string;
  result?: unknown;
  error?: AgentError;
}

export type AgentMessage = AgentHello | AgentChangedEvent | AgentRequest | AgentResponse;

// ── describe ────────────────────────────────────────────────────────────────────────────────────

export interface AgentChannel {
  key: string;
  label: string;
  pnn: string;
  marker: string | null;
  kind: "scatter" | "fluorescence" | "cytof" | "other";
  /** How the axis is drawn: the display space a gate in display space is straight in. */
  transform: TransformSpec;
}

export interface AgentSampleInfo {
  id: string;
  name: string;
  events: number;
  /** The file on the plot. */
  viewed: boolean;
  /** Ticked in the file list: pooled and taken by the other tabs. */
  checked: boolean;
  /** The Metadata tab's columns for this sample (an SCE's colData, constant within the sample). */
  metadata: Record<string, string>;
}

export interface AgentPopulationCount {
  sampleId: string;
  /** Null when the population is not evaluated for the sample. */
  n: number | null;
  /** Null when the parent population is not evaluated for the sample. */
  parentN: number | null;
  percentOfParent: number | null;
  /**
   * Present when the population is not evaluated for the sample: the tree the sample is gated
   * under (a copy whose structure was unlocked and changed) has no counterpart for it. Names the
   * file, the population and the file's tree.
   */
  notEvaluated?: string;
}

export interface AgentPopulation {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  gates: { gateId: string; include: boolean; quadrant?: number }[];
  counts: AgentPopulationCount[];
  /** Over the samples whose count and parent count are both evaluated. */
  pooled: { n: number; parentN: number; percentOfParent: number | null; percentOfTotal: number };
}

export interface AgentGate {
  id: string;
  name: string;
  type: "rectangle" | "polygon" | "quadrant" | "ellipse";
  x: string;
  y: string;
  space: GateSpace | null;
  transforms?: GateTransforms;
  /** Rectangles and polygons: the vertices in the gate's own space; a rectangle is two corners. */
  vertices?: Vertex[];
  bounds?: RectangleBounds;
  /** Quadrants: the crosshair. */
  center?: Vertex;
  /** Ellipses: centre, covariance and the distance-square the boundary sits at. */
  ellipse?: { mean: Vertex; covariance: [[number, number], [number, number]]; distanceSquare: number };
  color: string;
  provenance?: GateProvenance;
  /** The solid geometry on the viewed file and where its next geometry edit goes. */
  editing?: AgentGateEditing;
}

export interface AgentGateEditing {
  owner: { kind: "tree" | "file" | "group"; hierarchyId: string; gateId: string; name?: string };
  target: { kind: "tree" | "file" | "group"; hierarchyId: string; gateId: string; name?: string };
  pending: boolean;
}

export interface AgentView {
  populationId: string | null;
  sampleId: string | null;
  x: string | null;
  y: string | null;
  tab: string;
  /** The ranges the plot shows on each axis, in display units; null until the plot has one. */
  ranges: { x: [number, number] | null; y: [number, number] | null };
  /**
   * What the Strategy tab draws, as its controls hold it; null until the tab has been opened or a
   * workspace restored it. Absent on older cores.
   */
  strategy?: AgentStrategyView | null;
}

/** The Strategy tab's selection: the populations whose gating strategy it draws. */
export interface AgentStrategySelection {
  /** Populations of the active tree, not the root. "single" takes exactly one. */
  populationIds: string[];
  /**
   * "single": one population's path, a strip of plots. "multi": the populations together, one
   * grid laid out as the tree from the root. Absent: "single" for one id, "multi" for more.
   */
  mode?: "single" | "multi";
  /** Single mode: every gate from the root rather than the population's own. Unchanged when absent. */
  fullPath?: boolean;
}

export interface AgentStrategyView {
  mode: "single" | "multi";
  /** Single mode: the one population traced. Multi mode: the populations selected, in their order. */
  populationIds: string[];
  fullPath: boolean;
}

export interface AgentDescribe {
  revision: number;
  host: AgentHostInfo;
  channels: AgentChannel[];
  samples: AgentSampleInfo[];
  rootPopulationId: string | null;
  populations: AgentPopulation[];
  gates: AgentGate[];
  view: AgentView;
  /** Explicit plot selection; absent on older cores. Counts above still pool all loaded samples. */
  context?: AgentDataContext;
  gatingTask?: AgentGatingTask | null;
}

/** Search progress is transient UI state, never saved into the gating workspace or SCE. */
export interface AgentGatingTask {
  id: string;
  mode: "population" | "cluster";
  target: string;
  status: "searching" | "review" | "cancelled";
  candidates: number;
  budget: number;
  message: string;
}

/**
 * The relay's "proposal" method: an agent's strategy proposal (proposals/strategyProposal.ts), read
 * on a copy of the state. The same proposal from any other source is previewed for the user.
 */
export interface StrategyProposalParams {
  expectedRevision: number;
  /** Later commands may use @key.population or @key.gate in ID fields, and @root for the root. */
  steps: { key: string; command: AgentCommand }[];
  populationIds: string[];
  sampleIds: string[];
}

export interface AgentDataContext {
  assay: { id: string | null; space: "linear" | "display" | null };
  plot: { pooled: boolean; sampleIds: string[] };
  gateVisibility?: { branchOnly: boolean; showUnowned: boolean; selectedGateId: string | null; checkedGateIds: string[] };
  populationCountScope: "all-loaded-samples";
  gateCountScope: "geometry-within-active-population";
}

// ── distribution ────────────────────────────────────────────────────────────────────────────────

export interface AgentSeriesSelection {
  /** The population whose events are read; the root when absent. */
  populationId?: string;
  /** The samples read; the viewed one when absent and not pooled, the checked ones when pooled. */
  sampleIds?: string[];
  /** One series over all the chosen samples together, instead of one per sample. */
  pooled?: boolean;
}

export interface AgentDistributionParams extends AgentSeriesSelection {
  x: string;
  y?: string;
  /** Bins per axis, 2 to 256; 64 when absent. */
  bins?: number;
  /** Axis ranges in display units; the data's own extent when absent. */
  range?: { x?: [number, number]; y?: [number, number] };
}

export interface AgentAxisDistribution {
  channel: string;
  transform: TransformSpec;
  min: number;
  max: number;
  /** bins + 1 edges, from the range's low to its high. */
  edges: number[];
  counts: number[];
  /** By probability as a string key: "0.01", "0.5", "0.99" and the rest of QUANTILES. */
  quantiles: Record<string, number>;
  mean: number;
  /**
   * Where a threshold would go: the antimodes of the histogram (local minima after a three-bin
   * smoothing, with a mode on either side), deepest first, at most three. Empty for one mode.
   */
  valleys: number[];
}

export interface AgentDistributionSeries {
  /** A sample id, or "pooled". */
  series: string;
  /** Events read: the population's, finite on the axes asked for. */
  n: number;
  /** Events of the population that were not finite on an axis and so are not counted. */
  dropped: number;
  x: AgentAxisDistribution;
  y?: AgentAxisDistribution;
  /** With y: bins × bins counts, row-major by y bin then x bin (grid[yi * bins + xi]). */
  grid?: number[];
  /** One note per sample of the series the population is not evaluated for; none of its events are read. */
  notEvaluated?: string[];
}

export interface AgentDistribution {
  revision: number;
  populationId: string;
  bins: number;
  series: AgentDistributionSeries[];
}

// ── stats ───────────────────────────────────────────────────────────────────────────────────────

export interface AgentStatsParams extends AgentSeriesSelection {
  /** The populations summarised; every one when absent. */
  populationIds?: string[];
  /** The channels summarised; every one when absent. */
  channels?: string[];
  /** Per channel, a display-space threshold: the fraction of the population at or above it comes back. */
  thresholds?: Record<string, number>;
}

export interface AgentPopulationStats {
  populationId: string;
  series: string;
  n: number;
  /** Over at most STATS_SAMPLE events of the population, every k-th when it has more. */
  sampled: boolean;
  medians: Record<string, number | null>;
  /** With thresholds: per channel, the fraction (0 to 1) of the population at or above it. */
  positive?: Record<string, number | null>;
  /** One note per sample of the series the population is not evaluated for; `n` counts none of its events. */
  notEvaluated?: string[];
}

export interface AgentStats {
  revision: number;
  populations: AgentPopulationStats[];
}

// ── preview and apply ───────────────────────────────────────────────────────────────────────────

export interface AgentPreviewParams {
  command: AgentCommand;
}

export interface AgentPreview {
  revision: number;
  /** Every population after the command, with "new" on the ones the command would create. */
  populations: (AgentPopulation & { isNew: boolean })[];
  gates: (AgentGate & { isNew: boolean })[];
}

export interface AgentApplyParams {
  command: AgentCommand;
  /** Why; recorded on every gate the command creates and in the app's log. */
  rationale: string;
  /** Refused with "conflict" when the gating has moved since this revision. */
  expectedRevision?: number;
}

export interface AgentApplied {
  revision: number;
  populations: AgentPopulation[];
  gates: AgentGate[];
  created: { gateIds: string[]; populationIds: string[] };
}

// ── view, render, memberships, workspace ────────────────────────────────────────────────────────

export interface AgentViewParams {
  populationId?: string;
  sampleId?: string;
  x?: string;
  y?: string;
  /**
   * Fit the axes once the view is set: true as the Fit button does (the 0.1st to 99.9th
   * percentiles of the viewed file, widened to the gates); "data" to the whole extent of the data
   * over every loaded sample, 2% past the last event, widened to the gates, so nothing is cut off.
   */
  fit?: boolean | "data";
  /** Hold an axis at a range, in display units, as the Scales tab's Min/Max does; applied after any fit. */
  xRange?: [number, number];
  yRange?: [number, number];
  /**
   * The tab shown: "gating" (absent, without `strategy`) or "strategy" (absent, with it). The
   * axes, fit and ranges above set the Gating plot and are refused with "strategy".
   */
  tab?: AgentViewTab;
  /** What the Strategy tab draws. Sets the tab's controls only: no gating change, no selection in the tree. */
  strategy?: AgentStrategySelection;
}

export type AgentViewTab = "gating" | "strategy";

export interface AgentRenderParams {
  /** Pixels; the plot's own size when absent. */
  width?: number;
  height?: number;
}

export interface AgentRender {
  revision: number;
  view: AgentView;
  /** A PNG as a data URL. */
  png: string;
  width: number;
  height: number;
}

export interface AgentMembershipsParams {
  populationIds?: string[];
}

export interface AgentMemberships {
  revision: number;
  samples: AgentSampleInfo[];
  populations: {
    id: string;
    name: string;
    hierarchyId: string;
    /**
     * One packed mask per sample, least significant bit first, as colData export packs them. A
     * sample the population is not evaluated for has no bits and a `notEvaluated` note instead.
     */
    sampleMasks: { sampleId: string; eventCount: number; membershipBitsBase64: string; notEvaluated?: string }[];
  }[];
}

export interface AgentWorkspace {
  revision: number;
  /** The workspace as the app saves it, without the data files. */
  json: string | null;
}

export const QUANTILES = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99] as const;
/** Medians over more events than this are read on every k-th event. */
export const STATS_SAMPLE = 200_000;
