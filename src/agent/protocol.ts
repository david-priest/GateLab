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
  n: number;
  parentN: number;
  percentOfParent: number | null;
}

export interface AgentPopulation {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  gates: { gateId: string; include: boolean; quadrant?: number }[];
  counts: AgentPopulationCount[];
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
}

export interface AgentView {
  populationId: string | null;
  sampleId: string | null;
  x: string | null;
  y: string | null;
  tab: string;
  /** The ranges the plot shows on each axis, in display units; null until the plot has one. */
  ranges: { x: [number, number] | null; y: [number, number] | null };
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
}

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
    /** One packed mask per sample, least significant bit first, as colData export packs them. */
    sampleMasks: { sampleId: string; eventCount: number; membershipBitsBase64: string }[];
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
